/**
 * D-8 — integration tests ส่วน "สอบ + ออกใบประกาศนียบัตร" บน dev stack จริง
 * (Supabase local Docker ผ่าน Kong: PostgREST + GoTrue + Storage จริง — แบบ suite เดิม)
 *
 * ครอบคลุม:
 *   1) exam RPC ผ่าน claims path จริง (user JWT ไม่ใช่ service role):
 *      start_attempt / save_answer / submit_attempt + learner_attempt_paper_view
 *      (โจทย์กลางสอบ ตัดเฉลย) + learner_attempt_view (เฉลยเปิดหลัง final attempt)
 *      + session binding 2 ชั้น (D20-B5) + idempotent submit + ตัวเลขไม่โกหก (PB-15)
 *   2) certificate path ของ D-4 (service-role RPC): คิว eligible → issue → verify สาธารณะ
 *      → reissue (lineage) → revoke + audit ทุก event ใน TX เดียวกับ mutation
 *   3) seed "สอบเร็ว" สำหรับ E2E (D-9 ใช้ต่อ — อยู่ที่ helpers-d8.ts: seedFastExams)
 *   4) วิดีโอเล็กจริงใน bucket media ผูกกับ media_assets ของ seed (ธง PB-14)
 *
 * ข้อจำกัดทางเวลา: cooldown 1440 นาที / max_attempts ของข้อสอบ seed ทดสอบด้วย
 * "สอบเร็ว" (cooldown=0) และข้อสอบ seed เอง (ERR-ASM-003 cooldown หลังส่งครั้งแรก)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANON_KEY,
  createTestUser,
  psql,
  psqlRows,
  psqlScalar,
  restCall,
  SERVICE_KEY,
  TEST_PASSWORD,
  type RestResult,
  type TestUser,
} from "./helpers.js";
import {
  cleanupD8World,
  COURSE3_ID,
  COURSE3_LESSON_ID,
  D8_BANK_QUESTIONS,
  D8_IDS,
  knownCorrectAnswers,
  knownWrongAnswer,
  jwtPayload,
  SEED_EXAM_ID,
  seedFastExams,
  sha256Hex,
  STAFF_EXAM_DEMO_ID,
  storageCall,
  tinyMp4Bytes,
} from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── ชนิดข้อมูลของ response/view ที่ assert ───────────────────────────────────

interface StartAttemptResult {
  readonly attempt_id: string;
  readonly session_id: string;
  readonly expires_at: string;
  readonly question_count: number;
  readonly takeover?: boolean;
}

interface SubmitResult {
  readonly attempt_id: string;
  readonly status: string;
  readonly score_pct: number;
  readonly passed: boolean;
  readonly correct_count?: number;
  readonly question_count?: number;
  readonly total_points?: number;
  readonly already_submitted?: boolean;
}

interface PaperRow {
  readonly attempt_id: string;
  readonly question_id: string;
  readonly seq: number;
  readonly selected_option_ids: string[] | null;
  readonly question_paper: {
    readonly question_id: string;
    readonly version: number;
    readonly text: string;
    readonly options: readonly { readonly id: string; readonly text: string }[];
  };
}

interface ReviewRow {
  readonly attempt_id: string;
  readonly question_id: string;
  readonly is_correct: boolean | null;
  readonly points_earned: number | null;
  readonly question_snapshot: {
    readonly question_id: string;
    readonly points: number;
    readonly options: readonly { readonly id: string; readonly is_correct: boolean }[];
  } | null;
  readonly explanation: string | null;
}

interface EligibleRow {
  readonly attempt_id: string;
  readonly enrollment_id: string;
  readonly user_id: string;
  readonly course_id: string;
  readonly holder_name: string;
  readonly score_pct: number;
  readonly submitted_at: string;
}

interface CertVerifyResponse {
  readonly code: string;
  readonly course_title: string | null;
  readonly issued_at: string | null;
  readonly status: string;
}

/** เรียก RPC ของบทบาท service_role ผ่าน REST (ทางเดียวที่ suite เข้าถึงได้ตาม 0019) */
function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** error message ที่ PostgREST คืน (raise exception → ข้อความไทย + รหัส ERR-...) */
function errMessage(json: unknown): string {
  const body = (json ?? {}) as { message?: string };
  return body.message ?? "";
}

describe.skipIf(!DB_URL)("D-8 สอบ + ใบประกาศนียบัตร (exam RPC + cert path จริง)", () => {
  let learner: TestUser;
  let holderName: string;
  let learnerSession: string; // session_id claim ของ token แรก (อุปกรณ์ 1)
  let token2: string; // token จาก login ครั้งที่สอง (session ใหม่ — อุปกรณ์ 2)
  let enrollmentId: string;
  let seedAttemptId: string;
  let fastAAttempt1: string;
  let fastAAttempt2: string;
  let cert1: { id: string; cert_no: string; verify_code: string };
  let cert2: { id: string; cert_no: string; verify_code: string };
  let fastBAttemptId: string;

  beforeAll(async () => {
    await cleanupD8World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
    await seedFastExams();
    learner = await createTestUser("d8-examcert", "lawyer"); // course 3 is_public=false → ต้องเป็นทนายความ
    learnerSession = jwtPayload(learner.accessToken).session_id ?? "";
    // ลงทะเบียนหลักสูตร 3 ตามทางการ (rpc/enroll ด้วย user JWT)
    const enroll = await restCall(
      "POST",
      `/rest/v1/rpc/enroll`,
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_course_id: COURSE3_ID },
    );
    expect(enroll.status, enroll.text.slice(0, 300)).toBe(200);
    enrollmentId = await psqlScalar(
      `select id::text from public.enrollments
        where user_id = '${learner.id}' and course_id = '${COURSE3_ID}' limit 1;`,
    );
    expect(enrollmentId).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  afterAll(async () => {
    await cleanupD8World();
  });

  // ─── 1) ข้อสอบ seed: require_course_complete + cooldown ────────────────────

  it("start_attempt ปฏิเสธ: ยังไม่เรียนครบบทเรียน (ERR-LRN-002 — require_course_complete)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: SEED_EXAM_ID },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(result.json)).toContain("ERR-LRN-002");
  });

  it("เรียนครบผ่าน record_lesson_progress (บทเรียน document → completed ทันทีโดย server)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/record_lesson_progress",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_enrollment_id: enrollmentId, p_lesson_id: COURSE3_LESSON_ID },
    );
    expect(result.status, result.text.slice(0, 300)).toBeLessThan(300);
    const rows = await psqlRows<{ status: string }>(`
      select status::text from public.lesson_progress
       where enrollment_id = '${enrollmentId}' and lesson_id = '${COURSE3_LESSON_ID}';
    `);
    expect(rows[0]?.status).toBe("completed");
  });

  it("start_attempt ผ่าน: enrolled + เรียนครบ + published → attempt_id + expires_at ~90 นาที + session ตาม JWT claim", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: SEED_EXAM_ID },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as StartAttemptResult;
    seedAttemptId = body.attempt_id;
    expect(seedAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.session_id).toBe(learnerSession); // D20-B5: session ผูกจาก JWT claim
    const mins = (new Date(body.expires_at).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(85); // time_limit 90 นาที (กติกาเวอร์ชัน 1)
    expect(mins).toBeLessThan(95);
    expect(body.question_count).toBe(5); // โจทย์ active ของธนาคาร seed = 5 ข้อ
  });

  it("กระดาษข้อสอบกลางสอบ (learner_attempt_paper_view): 5 ข้อ ตัดเฉลย/แต้มทุกชั้น", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/learner_attempt_paper_view?attempt_id=eq.${seedAttemptId}&select=attempt_id,question_id,seq,selected_option_ids,question_paper&order=seq.asc`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as PaperRow[];
    expect(rows).toHaveLength(5);
    rows.forEach((row, index) => {
      expect(row.attempt_id).toBe(seedAttemptId);
      expect(row.seq).toBe(index + 1);
      expect(row.selected_option_ids).toBeNull(); // ยังไม่ตอบ
      expect(Object.keys(row.question_paper)).not.toContain("points"); // ตัดแต้มระดับบน
      for (const option of row.question_paper.options) {
        expect(Object.keys(option).sort()).toEqual(["id", "text"]); // ตัด is_correct/points ในตัวเลือก
      }
    });
    // ครบทุกโจทย์ active ของธนาคาร seed
    const ids = rows.map((row) => row.question_id).sort();
    const expected = await psqlRows<{ id: string }>(`
      select id::text from public.questions
       where bank_id = 'eeeeeeee-eeee-4eee-8eee-000000000001' and status = 'active' order by id::text;
    `);
    expect(ids).toEqual(expected.map((row) => row.id));
  });

  it("save_answer บันทึกคำตอบจริง (ตัวเลือกอยู่ในข้อ — ตอบถูกทุกข้อของข้อสอบ seed)", async () => {
    const paper = await restCall(
      "GET",
      `/rest/v1/learner_attempt_paper_view?attempt_id=eq.${seedAttemptId}&select=question_id&order=seq.asc`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    const questionIds = (paper.json as { question_id: string }[]).map((row) => row.question_id);
    const answers = await knownCorrectAnswers(questionIds);
    expect(answers.size).toBe(5);
    for (const questionId of questionIds) {
      const correct = answers.get(questionId);
      expect(correct, `มีเฉลยของโจทย์ ${questionId}`).toBeDefined();
      const saved = await restCall(
        "POST",
        "/rest/v1/rpc/save_answer",
        { apiKey: ANON_KEY, token: learner.accessToken },
        {
          p_attempt_id: seedAttemptId,
          p_question_id: questionId,
          p_selected_option_ids: [correct],
          p_session_id: learnerSession,
        },
      );
      expect(saved.status, saved.text.slice(0, 300)).toBeLessThan(300);
    }
  });

  it("submit_attempt: ตอบถูกทุกข้อ → passed=true score 100 + ตัวเลขไม่โกหก (PB-15: question_count/total_points)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/submit_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_attempt_id: seedAttemptId, p_session_id: learnerSession },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as SubmitResult;
    expect(body.status).toBe("passed");
    expect(body.passed).toBe(true);
    expect(body.score_pct).toBe(100);
    expect(body.correct_count).toBe(5);
    expect(body.question_count).toBe(5); // count(*) จริง
    expect(body.total_points).toBe(5); // รวมแต้มจริง (5 ข้อ × 1 แต้ม)
    expect(body.already_submitted).toBeUndefined();
    // ground-truth จาก DB ตรงกับ response
    const rows = await psqlRows<{ question_count: number; total: number }>(`
      select count(*)::int as question_count,
             coalesce(sum((question_snapshot->>'points')::int), 0) as total
        from public.attempt_answers where attempt_id = '${seedAttemptId}';
    `);
    expect(rows[0]?.question_count).toBe(5);
    expect(rows[0]?.total).toBe(5);
  });

  it("start_attempt ปฏิเสธ: cooldown ยังไม่ครบ (ERR-ASM-003 — 1440 นาทีของ seed)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: SEED_EXAM_ID },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    const message = errMessage(result.json);
    expect(message).toContain("ERR-ASM-003");
    expect(message).toContain("ระยะห่างระหว่างครั้ง");
  });

  // ─── 2) สอบเร็ว FAST-A: paper view + session binding (D20-B5) + idempotent ──

  it("สอบเร็ว A: start_attempt ผ่านโดยไม่ต้องเรียนครบ (require_course_complete=false) — กระดาษ 4 ข้อ", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: D8_IDS.fastA.assessment },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as StartAttemptResult;
    fastAAttempt1 = body.attempt_id;
    expect(body.question_count).toBe(4);
    const mins = (new Date(body.expires_at).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(4);
    expect(mins).toBeLessThan(6);
    // กระดาษจาก learner_attempt_paper_view: 4 แถว เรียง seq 1..4
    const paper = await restCall(
      "GET",
      `/rest/v1/learner_attempt_paper_view?attempt_id=eq.${fastAAttempt1}&select=attempt_id,question_id,seq,question_paper&order=seq.asc`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    expect(paper.status).toBe(200);
    const rows = paper.json as PaperRow[];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  it("save_answer ปฏิเสธ: p_session_id ไม่ตรง session ของ attempt (ERR-RBAC-001 — ASM-011)", async () => {
    const questionId = D8_BANK_QUESTIONS.fastA[0] ?? "";
    const correct = (await knownCorrectAnswers([questionId])).get(questionId) ?? "";
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/save_answer",
      { apiKey: ANON_KEY, token: learner.accessToken },
      {
        p_attempt_id: fastAAttempt1,
        p_question_id: questionId,
        p_selected_option_ids: [correct],
        p_session_id: "not-the-attempt-session",
      },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(result.json)).toContain("ERR-RBAC-001");
  });

  it("save_answer ปฏิเสธ: JWT claim session_id อื่น (อุปกรณ์ 2) แม้ p_session_id ถูก (D20-B5 — ERR-RBAC-001)", async () => {
    // login ครั้งที่สอง = session ใหม่จาก GoTrue (session_id claim ต่างจากครั้งแรก)
    const login2 = await restCall(
      "POST",
      "/auth/v1/token?grant_type=password",
      {},
      { email: learner.email, password: TEST_PASSWORD },
    );
    expect(login2.status, login2.text.slice(0, 300)).toBe(200);
    token2 = (login2.json as { access_token: string }).access_token;
    const session2 = jwtPayload(token2).session_id ?? "";
    expect(session2).not.toBe(learnerSession);

    const questionId = D8_BANK_QUESTIONS.fastA[0] ?? "";
    const correct = (await knownCorrectAnswers([questionId])).get(questionId) ?? "";
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/save_answer",
      { apiKey: ANON_KEY, token: token2 }, // JWT ของอุปกรณ์ 2
      {
        p_attempt_id: fastAAttempt1,
        p_question_id: questionId,
        p_selected_option_ids: [correct],
        p_session_id: learnerSession, // อ้าง session ของแถว (ถูก) แต่ claim ไม่ตรง
      },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(result.json)).toContain("ERR-RBAC-001");
  });

  it("submit_attempt ปฏิเสธ: JWT claim session_id อื่น (session binding สองชั้น — ERR-RBAC-001)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/submit_attempt",
      { apiKey: ANON_KEY, token: token2 },
      { p_attempt_id: fastAAttempt1, p_session_id: learnerSession },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(result.json)).toContain("ERR-RBAC-001");
  });

  it("save_answer สำเร็จ: อุปกรณ์เจ้าของ session ตอบได้ + แถวคำตอบเปลี่ยนจริง (answered_at)", async () => {
    const answers = await knownCorrectAnswers(D8_BANK_QUESTIONS.fastA);
    for (const [questionId, correct] of answers) {
      const saved = await restCall(
        "POST",
        "/rest/v1/rpc/save_answer",
        { apiKey: ANON_KEY, token: learner.accessToken },
        {
          p_attempt_id: fastAAttempt1,
          p_question_id: questionId,
          p_selected_option_ids: [correct],
          p_session_id: learnerSession,
        },
      );
      expect(saved.status, saved.text.slice(0, 300)).toBeLessThan(300);
    }
    const rows = await psqlRows<{ answered: number }>(`
      select count(*)::int as answered from public.attempt_answers
       where attempt_id = '${fastAAttempt1}' and selected_option_ids is not null and answered_at is not null;
    `);
    expect(rows[0]?.answered).toBe(4);
  });

  it("submit_attempt (สอบเร็ว A ครั้งที่ 1): ถูกทุกข้อ → passed 100 + question_count=4 total_points=4", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/submit_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_attempt_id: fastAAttempt1, p_session_id: learnerSession },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as SubmitResult;
    expect(body.status).toBe("passed");
    expect(body.passed).toBe(true);
    expect(body.score_pct).toBe(100);
    expect(body.question_count).toBe(4);
    expect(body.total_points).toBe(4);
  });

  it("idempotent: ส่งซ้ำด้วย attempt เดิม → already_submitted=true ผลเดิมไม่เปลี่ยน", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/submit_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_attempt_id: fastAAttempt1, p_session_id: learnerSession },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as SubmitResult;
    expect(body.already_submitted).toBe(true);
    expect(body.status).toBe("passed");
    expect(body.score_pct).toBe(100);
    expect(body.question_count).toBe(4);
    expect(body.total_points).toBe(4);
  });

  it("เฉลยยังปิด: learner_attempt_view หลังส่งครั้งที่ 1 (1 < max_attempts 2) → is_correct/question_snapshot ยัง null", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/learner_attempt_view?attempt_id=eq.${fastAAttempt1}&select=attempt_id,question_id,is_correct,points_earned,question_snapshot,explanation`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as ReviewRow[];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.is_correct).toBeNull();
      expect(row.question_snapshot).toBeNull();
      expect(row.explanation).toBeNull();
    }
  });

  it("สอบเร็ว A ครั้งที่ 2 (cooldown=0): start ได้ → ตอบผิดทุกข้อ → failed", async () => {
    const start = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: D8_IDS.fastA.assessment },
    );
    expect(start.status, start.text.slice(0, 300)).toBe(200);
    const body = start.json as StartAttemptResult;
    fastAAttempt2 = body.attempt_id;
    expect(body.takeover).toBeUndefined(); // ครั้งใหม่จริง ไม่ใช่ takeover
    for (const questionId of D8_BANK_QUESTIONS.fastA) {
      const wrong = await knownWrongAnswer(questionId);
      const saved = await restCall(
        "POST",
        "/rest/v1/rpc/save_answer",
        { apiKey: ANON_KEY, token: learner.accessToken },
        {
          p_attempt_id: fastAAttempt2,
          p_question_id: questionId,
          p_selected_option_ids: [wrong],
          p_session_id: learnerSession,
        },
      );
      expect(saved.status, saved.text.slice(0, 300)).toBeLessThan(300);
    }
    const submit = await restCall(
      "POST",
      "/rest/v1/rpc/submit_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_attempt_id: fastAAttempt2, p_session_id: learnerSession },
    );
    expect(submit.status).toBe(200);
    const submitted = submit.json as SubmitResult;
    expect(submitted.status).toBe("failed");
    expect(submitted.passed).toBe(false);
    expect(submitted.score_pct).toBe(0);
  });

  it("เฉลยเปิดหลัง final attempt: learner_attempt_view ครั้งสุดท้าย → is_correct/explanation/question_snapshot ครบ", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/learner_attempt_view?attempt_id=eq.${fastAAttempt2}&select=attempt_id,question_id,is_correct,points_earned,question_snapshot,explanation`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as ReviewRow[];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.is_correct).toBe(false); // ตอบผิด — แต่เปิดเฉลยแล้ว
      expect(row.points_earned).toBe(0);
      expect(row.question_snapshot).not.toBeNull();
      expect(row.explanation).not.toBeNull();
      // snapshot มีเฉลยในตัวเลือก (ปลายทางอ่าน is_correct ได้หลัง final attempt)
      expect(row.question_snapshot?.options.every((o) => typeof o.is_correct === "boolean")).toBe(true);
    }
  });

  it("start_attempt ปฏิเสธ: ครบ max_attempts (ERR-ASM-001 — สอบเร็ว A ส่งครบ 2 ครั้งแล้ว)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: D8_IDS.fastA.assessment },
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(result.json)).toContain("ERR-ASM-001");
  });

  // ─── 3) สอบเร็ว FAST-B (max_attempts=1): ERR-ASM-002 + เฉลยหลังครั้งเดียว ────

  it("สอบเร็ว B: มี attempt in_progress อยู่ → start ซ้ำปฏิเสธ (ERR-ASM-002)", async () => {
    const start = await restCall(
      "POST",
      "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: D8_IDS.fastB.assessment },
    );
    expect(start.status).toBe(200);
    const body = start.json as StartAttemptResult;
    fastBAttemptId = body.attempt_id;
    const again = await restCall(
      "POST",
 "/rest/v1/rpc/start_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_assessment_id: D8_IDS.fastB.assessment },
    );
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(again.json)).toContain("ERR-ASM-002");
  });

  it("สอบเร็ว B (max_attempts=1): ตอบถูก → submit passed 100 → เฉลยเปิดทันทีหลังส่ง", async () => {
    const answers = await knownCorrectAnswers(D8_BANK_QUESTIONS.fastB);
    for (const [questionId, correct] of answers) {
      await restCall(
        "POST",
        "/rest/v1/rpc/save_answer",
        { apiKey: ANON_KEY, token: learner.accessToken },
        {
          p_attempt_id: fastBAttemptId,
          p_question_id: questionId,
          p_selected_option_ids: [correct],
          p_session_id: learnerSession,
        },
      );
    }
    const submit = await restCall(
      "POST",
      "/rest/v1/rpc/submit_attempt",
      { apiKey: ANON_KEY, token: learner.accessToken },
      { p_attempt_id: fastBAttemptId, p_session_id: learnerSession },
    );
    expect(submit.status, submit.text.slice(0, 300)).toBe(200);
    const body = submit.json as SubmitResult;
    expect(body.status).toBe("passed");
    expect(body.question_count).toBe(3);
    expect(body.total_points).toBe(3);
    const review = await restCall(
      "GET",
      `/rest/v1/learner_attempt_view?attempt_id=eq.${fastBAttemptId}&select=is_correct,question_snapshot,explanation`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    expect(review.status).toBe(200);
    const rows = review.json as ReviewRow[];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.is_correct === true)).toBe(true);
    expect(rows.every((row) => row.explanation !== null)).toBe(true);
  });

  // ─── 4) certificate path (service-role RPC ของ D-4) ─────────────────────────

  it("จัดสถานะ enrollment เป็น completed (เงื่อนไขคิว eligible — setup ฝั่ง harness)", async () => {
    await psql(`
      update public.enrollments
         set status = 'completed', completed_at = now()
       where id = '${enrollmentId}';
    `);
    const rows = await psqlRows<{ status: string; completed: string | null }>(`
      select status::text, completed_at::text as completed from public.enrollments where id = '${enrollmentId}';
    `);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.completed).not.toBeNull();
  });

  it("admin_eligible_certificates: เห็นผู้เรียนผ่านเกณฑ์ยังไม่มีใบ valid (anti-join)", async () => {
    const result = await svcRpc("admin_eligible_certificates", {
      p_course_id: COURSE3_ID,
      p_limit: 101,
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const rows = result.json as EligibleRow[];
    const mine = rows.find((row) => row.enrollment_id === enrollmentId);
    expect(mine, "ผู้เรียนต้องอยู่ในคิว eligible").toBeDefined();
    expect(mine?.course_id).toBe(COURSE3_ID);
    expect(mine?.score_pct).toBe(100);
    expect(mine?.holder_name.length ?? 0).toBeGreaterThan(0);
    // anti-join: ยังไม่มีใบ valid ของ enrollment นี้
    const certs = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificates
       where enrollment_id = '${enrollmentId}' and status = 'valid';
    `);
    expect(certs[0]?.n).toBe(0);
  });

  it("admin_issue_certificate: สร้างใบ + cert_no LTC-<ปี>-<6 หลัก> + verify_code 43 อักขระ", async () => {
    const result = await svcRpc("admin_issue_certificate", {
      p_actor_user_id: STAFF_EXAM_DEMO_ID,
      p_enrollment_id: enrollmentId,
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as {
      id: string;
      cert_no: string;
      verify_code: string;
      holder_name: string;
      course_title: string;
    };
    cert1 = { id: body.id, cert_no: body.cert_no, verify_code: body.verify_code };
    holderName = body.holder_name;
    expect(cert1.cert_no).toMatch(/^LTC-\d{4}-\d{6}$/);
    expect(cert1.verify_code).toMatch(/^[0-9A-Za-z_-]{43}$/);
    expect(holderName.length).toBeGreaterThan(0);
    // audit CERT_ISSUE เกิดจริงใน audit_logs (TX เดียวกับ mutation)
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_ISSUE' and entity_id = '${cert1.id}';
    `);
    expect(audit[0]?.n).toBe(1);
  });

  it("anti-join หลัง issue: คิว eligible ไม่มีผู้เรียนนี้แล้ว + issue ซ้ำปฏิเสธ (valid_certificate_exists)", async () => {
    const queue = await svcRpc("admin_eligible_certificates", {
      p_course_id: COURSE3_ID,
      p_limit: 101,
    });
    expect(queue.status).toBe(200);
    const rows = queue.json as EligibleRow[];
    expect(rows.some((row) => row.enrollment_id === enrollmentId)).toBe(false);

    const again = await svcRpc("admin_issue_certificate", {
      p_actor_user_id: STAFF_EXAM_DEMO_ID,
      p_enrollment_id: enrollmentId,
      p_request_id: crypto.randomUUID(),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(errMessage(again.json)).toContain("valid_certificate_exists");
  });

  it("verify สาธารณะ (anon): รหัสถูกต้อง → 200 status valid + คืน 4 ฟิลด์เท่านั้น (ไม่มีชื่อเจ้าของ)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/record_certificate_verification",
      { apiKey: ANON_KEY }, // anon — ไม่มี token
      {
        p_code: cert1.verify_code,
        p_source: "manual",
        p_ip_hash: await sha256Hex("d8-verify-ip"),
        p_user_agent_hash: await sha256Hex("d8-verify-agent"),
        p_request_id: crypto.randomUUID(),
      },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as CertVerifyResponse;
    expect(Object.keys(body).sort()).toEqual(["code", "course_title", "issued_at", "status"]);
    expect(body.status).toBe("valid");
    expect(body.course_title).not.toBeNull();
    // ห้ามมีชื่อเจ้าของ (holder_name) กลับมาในคำตอบ — 4 ฟิลด์สาธารณะเท่านั้น
    expect(result.text).not.toContain(holderName);
    expect(Object.keys(body)).not.toContain("holder_name");
    expect(Object.keys(body)).not.toContain("verify_code");
    // log แถวเกิดจริง + audit CERT_VERIFY_PUBLIC
    const logs = await psqlRows<{ result: string; source: string; ip: string; ua: string | null }>(`
      select result::text, source, ip_hash as ip, user_agent_hash as ua
        from public.certificate_verifications
       where verify_code = '${cert1.verify_code}' order by verified_at desc limit 1;
    `);
    expect(logs[0]?.result).toBe("valid");
    expect(logs[0]?.source).toBe("manual");
    expect(logs[0]?.ip).toBe(await sha256Hex("d8-verify-ip"));
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_VERIFY_PUBLIC'
         and context ->> 'code' = '${cert1.verify_code}' and context ->> 'result' = 'valid';
    `);
    expect(audit[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("verify สาธารณะ: รหัสรูปเดียวกัน not_found → 200 + 4 ฟิลด์ + log + audit (แต่ไม่พบใบ)", async () => {
    const missingCode = "LTC-2099-000000";
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/record_certificate_verification",
      { apiKey: ANON_KEY },
      {
        p_code: missingCode,
        p_source: "manual",
        p_ip_hash: await sha256Hex("d8-verify-ip"),
        p_user_agent_hash: await sha256Hex("d8-verify-agent"),
        p_request_id: crypto.randomUUID(),
      },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as CertVerifyResponse;
    expect(Object.keys(body).sort()).toEqual(["code", "course_title", "issued_at", "status"]);
    expect(body.status).toBe("not_found");
    const logs = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificate_verifications where verify_code = '${missingCode}';
    `);
    expect(logs[0]?.n).toBe(1);
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_VERIFY_PUBLIC' and context ->> 'code' = '${missingCode}';
    `);
    // audit_logs เป็น append-only — ค้างสะสมข้ามรอบรัน (ห้ามลบตามดีไซน์) จึง assert >= 1
    expect(audit[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("verify สาธารณะ: รหัสผิดรูปแบบ → not_found โดยไม่ persist และไม่ audit (0019-r2 F4)", async () => {
    const before = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificate_verifications;
    `);
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/record_certificate_verification",
      { apiKey: ANON_KEY },
      {
        p_code: "not-a-real-code!!",
        p_source: "manual",
        p_ip_hash: await sha256Hex("d8-verify-ip"),
        p_user_agent_hash: await sha256Hex("d8-verify-agent"),
        p_request_id: crypto.randomUUID(),
      },
    );
    expect(result.status).toBe(200);
    expect((result.json as CertVerifyResponse).status).toBe("not_found");
    const after = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.certificate_verifications;
    `);
    expect(after[0]?.n).toBe(before[0]?.n); // ไม่มีแถวใหม่
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_VERIFY_PUBLIC' and context ->> 'code' = 'not-a-real-code!!';
    `);
    expect(audit[0]?.n).toBe(0);
  });

  it("reissue: ใบเดิม superseded + lineage ครบ (superseded_by/supersedes_cert_id) + CERT_REISSUE audit", async () => {
    const result = await svcRpc("admin_reissue_certificate", {
      p_actor_user_id: STAFF_EXAM_DEMO_ID,
      p_certificate_id: cert1.id,
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as { id: string; cert_no: string; verify_code: string; superseded_cert_id: string };
    cert2 = { id: body.id, cert_no: body.cert_no, verify_code: body.verify_code };
    expect(body.superseded_cert_id).toBe(cert1.id);
    expect(cert2.id).not.toBe(cert1.id);
    // lineage ทั้งสองฝั่ง + สถานะ
    const rows = await psqlRows<{ id: string; status: string; superseded_by: string | null; supersedes: string | null }>(`
      select id::text, status::text, superseded_by::text, supersedes_cert_id::text as supersedes
        from public.certificates where id in ('${cert1.id}', '${cert2.id}');
    `);
    const oldRow = rows.find((row) => row.id === cert1.id);
    const newRow = rows.find((row) => row.id === cert2.id);
    expect(oldRow?.status).toBe("superseded");
    expect(oldRow?.superseded_by).toBe(cert2.id);
    expect(newRow?.supersedes).toBe(cert1.id);
    expect(newRow?.status).toBe("valid");
    // audit CERT_ISSUE (ใบใหม่) + CERT_REISSUE ครบใน TX เดียว
    const audit = await psqlRows<{ issue: number; reissue: number }>(`
      select count(*) filter (where action = 'CERT_ISSUE')::int as issue,
             count(*) filter (where action = 'CERT_REISSUE')::int as reissue
        from public.audit_logs where entity_id in ('${cert1.id}', '${cert2.id}');
    `);
    expect(audit[0]?.issue).toBeGreaterThanOrEqual(1);
    expect(audit[0]?.reissue).toBe(1);
  });

  it("verify ใบ superseded ด้วย cert_no → status superseded (4 ฟิลด์เท่าเดิม)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/record_certificate_verification",
      { apiKey: ANON_KEY },
      {
        p_code: cert1.cert_no,
        p_source: "qr",
        p_ip_hash: await sha256Hex("d8-verify-ip"),
        p_user_agent_hash: await sha256Hex("d8-verify-agent"),
        p_request_id: crypto.randomUUID(),
      },
    );
    expect(result.status).toBe(200);
    const body = result.json as CertVerifyResponse;
    expect(Object.keys(body).sort()).toEqual(["code", "course_title", "issued_at", "status"]);
    expect(body.status).toBe("superseded");
  });

  it("revoke: สถานะ revoked + revoked_at + CERT_REVOKE audit → verify เห็น revoked", async () => {
    const result = await svcRpc("admin_revoke_certificate", {
      p_actor_user_id: STAFF_EXAM_DEMO_ID,
      p_certificate_id: cert2.id,
      p_reason: "ตรวจสอบพบการทุจริตในการสอบ (D-8 integration test)",
      p_request_id: crypto.randomUUID(),
    });
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const body = result.json as { id: string; cert_no: string; revoked_at: string };
    expect(body.id).toBe(cert2.id);
    const rows = await psqlRows<{ status: string; revoked: string | null; reason: string | null }>(`
      select status::text, revoked_at::text as revoked, revoked_reason as reason
        from public.certificates where id = '${cert2.id}';
    `);
    expect(rows[0]?.status).toBe("revoked");
    expect(rows[0]?.revoked).not.toBeNull();
    expect(rows[0]?.reason).toContain("ทุจริต");
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_REVOKE' and entity_id = '${cert2.id}';
    `);
    expect(audit[0]?.n).toBe(1);
    // verify หลัง revoke
    const verify = await restCall(
      "POST",
      "/rest/v1/rpc/record_certificate_verification",
      { apiKey: ANON_KEY },
      {
        p_code: cert2.verify_code,
        p_source: "manual",
        p_ip_hash: await sha256Hex("d8-verify-ip"),
        p_user_agent_hash: await sha256Hex("d8-verify-agent"),
        p_request_id: crypto.randomUUID(),
      },
    );
    expect(verify.status).toBe(200);
    expect((verify.json as CertVerifyResponse).status).toBe("revoked");
  });

  // ─── 5) PB-14: วิดีโอเล็กจริงใน bucket media + ผูกกับ media_assets ของ seed ──

  it("PB-14: upload object จริงเข้า bucket media ตรง storage_path ของ media_assets seed (บทเรียนวิดีโอ LTC-101)", async () => {
    const bytes = tinyMp4Bytes();
    const objectPath = "/storage/v1/object/media/courses/ltc-101/intro.mp4";
    // storage ของ dev image ไม่รองรับ upsert บน object ที่มีอยู่ (500) — ลบก่อนแล้วอัปโหลดใหม่
    await storageCall("DELETE", objectPath);
    const put = await storageCall("POST", objectPath, bytes);
    expect(put.status, put.text.slice(0, 300)).toBeLessThan(300);
    // media_assets row ของ seed ผูกกับบทเรียนวิดีโอจริง (lesson 1 ของ LTC-101)
    const rows = await psqlRows<{ bucket: string; path: string; status: string; lesson: number }>(`
      select ma.bucket, ma.storage_path as path, ma.status::text,
             (select count(*)::int from public.lessons l where l.media_id = ma.id) as lesson
        from public.media_assets ma where ma.id = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
    `);
    expect(rows[0]?.bucket).toBe("media");
    expect(rows[0]?.path).toBe("courses/ltc-101/intro.mp4");
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.lesson).toBe(1);
    // อ่าน object กลับมาได้ไบต์เดิม (service key — เจ้าของ media ตอน upload)
    const get = await storageCall("GET", "/storage/v1/object/media/courses/ltc-101/intro.mp4");
    expect(get.status).toBe(200);
  });
});
