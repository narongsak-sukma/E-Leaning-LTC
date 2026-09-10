/**
 * unit tests — schemas/v1/exam (contract + mapper + session binding D20-B5)
 *
 * จุดหลักที่ต้องเป็น evidence ได้:
 * - toExamQuestion สร้าง object แบบ whitelist — คีย์เฉลยหลุดเข้ามาไม่ได้แม้แถวมีครบ
 * - readJwtSessionClaim อ่าน claim `session_id` จาก access token ของ session store เท่านั้น
 */
import { describe, expect, it } from "vitest";
import { AppError, errorDefinition } from "@/lib/errors";
import {
  AttemptQuestionSnapshot,
  AttemptResultView,
  AttemptStartView,
  AttemptSubmitView,
  MyAttemptView,
  parseAnswerSaveBody,
  parseAssessmentIdParams,
  parseAttemptIdParams,
  readJwtSessionClaim,
  toAssessmentDetail,
  toAttemptResultView,
  toExamQuestion,
  toMyAttemptResource,
  toSubmitView,
  type AssessmentRow,
  type AttemptHistoryRow,
  type LearnerAttemptViewRow,
} from "./exam";

const UUID = (n: number): string =>
  "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const T = "2026-09-10T01:02:03+00:00";

function viewRow(overrides: Partial<LearnerAttemptViewRow> = {}): LearnerAttemptViewRow {
  return {
    attempt_id: UUID(1),
    user_id: UUID(9),
    assessment_id: UUID(2),
    attempt_no: 1,
    status: "in_progress",
    started_at: T,
    expires_at: "2026-09-10T02:02:03+00:00",
    submitted_at: null,
    score_pct: null,
    passed: null,
    question_id: UUID(100),
    seq: 1,
    option_order: [2, 1],
    selected_option_ids: [UUID(200)],
    answered_at: T,
    is_correct: true,
    points_earned: 5,
    question_snapshot: {
      question_id: UUID(100),
      version: 3,
      text: "ข้อสอบ",
      options: [
        { id: UUID(200), text: "ตัวเลือก ก", is_correct: true, points: 5 },
        { id: UUID(201), text: "ตัวเลือก ข", is_correct: false, points: 5 },
      ],
      points: 5,
    },
    explanation: "เพราะข้อ ก ถูกต้อง",
    ...overrides,
  };
}

function makeJwt(sessionId: string | null): string {
  const enc = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const payload: Record<string, unknown> = { sub: "u1" };
  if (sessionId !== null) {
    payload["session_id"] = sessionId;
  }
  return enc({ alg: "HS256", typ: "JWT" }) + "." + enc(payload) + ".signature";
}

describe("parse helpers", () => {
  it("path param ถูกรูป → parsed · ไม่ใช่ uuid → ERR-VAL-001 ระบุ field id", () => {
    expect(parseAssessmentIdParams({ id: UUID(2) }).id).toBe(UUID(2));
    expect(parseAttemptIdParams({ id: UUID(1) }).id).toBe(UUID(1));
    try {
      parseAttemptIdParams({ id: "not-a-uuid" });
      throw new Error("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("ERR-VAL-001");
      expect((err as AppError).details?.["fields"]).toEqual(["id"]);
    }
  });

  it("AnswerSaveRequest §4 #7 ถูกรูป → parsed (unknown key ถูก strip)", () => {
    const parsed = parseAnswerSaveBody({
      questionId: UUID(100),
      choiceIds: [UUID(200)],
      clientSavedAt: T,
      session_id: "attacker-session", // ไม่ใช่ field ของ contract — ถูกทิ้ง
    });
    expect(parsed.questionId).toBe(UUID(100));
    expect(parsed.choiceIds).toEqual([UUID(200)]);
    expect(Object.hasOwn(parsed, "session_id")).toBe(false);
  });

  it("AnswerSaveRequest ผิดรูป (choiceIds เกิน 10 / clientSavedAt ไม่ใช่ ISO) → ERR-VAL-001", () => {
    for (const bad of [
      { questionId: UUID(100), choiceIds: [], clientSavedAt: T },
      {
        questionId: UUID(100),
        choiceIds: Array.from({ length: 11 }, (_, i) => UUID(300 + i)),
        clientSavedAt: T,
      },
      { questionId: UUID(100), choiceIds: [UUID(200)], clientSavedAt: "10 ก.ย." },
      { questionId: "nope", choiceIds: [UUID(200)], clientSavedAt: T },
    ]) {
      try {
        parseAnswerSaveBody(bad);
        throw new Error("must throw: " + JSON.stringify(bad));
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe("ERR-VAL-001");
      }
    }
  });
});

describe("toExamQuestion — whitelist 4 ฟิลด์ ไม่มีทางรั่วเฉลย", () => {
  it("แถวที่มีคอลัมน์เฉลยครบ (ถ้า view เปิด) → ผลลัพธ์ยังมีแค่ questionId/seq/selectedOptionIds/answeredAt", () => {
    const q = toExamQuestion(viewRow());
    expect(Object.keys(q).sort()).toEqual([
      "answeredAt",
      "questionId",
      "selectedOptionIds",
      "seq",
    ]);
    expect(q.questionId).toBe(UUID(100));
    expect(q.seq).toBe(1);
    expect(q.selectedOptionIds).toEqual([UUID(200)]);
    expect(q.answeredAt).toBe(T);
    const keys = Object.keys(q).join(" ");
    for (const leak of ["is_correct", "isCorrect", "explanation", "points_earned", "pointsEarned", "snapshot", "content"]) {
      expect(keys).not.toContain(leak);
    }
  });
});

describe("mappers อื่น ๆ", () => {
  it("toMyAttemptResource → camelCase ตรง MyAttemptView", () => {
    const row: AttemptHistoryRow = {
      id: UUID(1),
      assessment_id: UUID(2),
      attempt_no: 2,
      status: "passed",
      started_at: T,
      expires_at: "2026-09-10T02:02:03+00:00",
      submitted_at: T,
      score_pct: 80,
      passed: true,
      question_count: 30,
      correct_count: 24,
    };
    expect(MyAttemptView.parse(toMyAttemptResource(row))).toMatchObject({
      id: UUID(1),
      assessmentId: UUID(2),
      attemptNo: 2,
      status: "passed",
      scorePct: 80,
      passed: true,
      correctCount: 24,
    });
  });

  it("toAssessmentDetail → ไม่มี passPct (pass_pct ไม่ได้ GRANT ให้ authenticated)", () => {
    const assessment: AssessmentRow = {
      id: UUID(2),
      course_id: UUID(3),
      code: "FINAL-01",
      title: "สอบปลายทาง",
      description: null,
      is_final: true,
      status: "published",
      published_at: T,
    };
    const detail = toAssessmentDetail(assessment, {
      id: UUID(4),
      assessment_id: UUID(2),
      version: 2,
      time_limit_minutes: 60,
      question_count: 30,
      max_attempts: 3,
      attempt_cooldown_minutes: 1440,
      shuffle_questions: true,
      shuffle_options: true,
      require_course_complete: true,
      proctoring_mode: "basic",
      effective_from: T,
    });
    expect(detail.rules.timeLimitMinutes).toBe(60);
    expect(JSON.stringify(detail)).not.toContain("passPct");
    expect(JSON.stringify(detail)).not.toContain("pass_pct");
  });
});

describe("toAttemptResultView — ส่งตาม view เป๊ะ", () => {
  it("view เปิดเฉลย (snapshot + explanation) → content/isCorrect/pointsEarned/explanation ตาม view", () => {
    const parsed = AttemptResultView.parse(
      toAttemptResultView([
        viewRow({ seq: 1 }),
        viewRow({ question_id: UUID(101), seq: 2, is_correct: false, points_earned: 0 }),
      ]),
    );
    expect(parsed.questionCount).toBe(2);
    expect(parsed.questions[1]?.content?.text).toBe("ข้อสอบ");
    expect(parsed.questions[1]?.content?.options[0]?.isCorrect).toBe(true);
    expect(parsed.questions[1]?.isCorrect).toBe(false);
    expect(parsed.questions[1]?.explanation).toBe("เพราะข้อ ก ถูกต้อง");
  });

  it("view ยังไม่เปิดเฉลย → คอลัมน์เฉลย null ตาม view (content เป็น null)", () => {
    const parsed = AttemptResultView.parse(
      toAttemptResultView([
        viewRow({
          status: "in_progress",
          is_correct: null,
          points_earned: null,
          question_snapshot: null,
          explanation: null,
        }),
      ]),
    );
    expect(parsed.questions[0]?.isCorrect).toBeNull();
    expect(parsed.questions[0]?.pointsEarned).toBeNull();
    expect(parsed.questions[0]?.explanation).toBeNull();
    expect(parsed.questions[0]?.content).toBeNull();
  });

  it("แถวว่าง → ERR-NF-001 · snapshot ผิด contract → ERR-SYS-002 (fail-closed)", () => {
    expect(() => toAttemptResultView([])).toThrow(AppError);
    try {
      toAttemptResultView([viewRow({ question_snapshot: { broken: true } })]);
      throw new Error("must throw");
    } catch (err) {
      expect((err as AppError).code).toBe("ERR-SYS-002");
    }
  });
});

describe("toSubmitView — DCR-6 ผลตรวจทันที", () => {
  it("ส่งครั้งแรก → ครบ correctCount/questionCount ไม่มี alreadySubmitted", () => {
    const view = toSubmitView({
      attempt_id: UUID(1),
      status: "passed",
      score_pct: 90,
      passed: true,
      correct_count: 27,
      question_count: 30,
    });
    expect(AttemptSubmitView.parse(view)).toMatchObject({
      attemptId: UUID(1),
      status: "passed",
      scorePct: 90,
      passed: true,
      correctCount: 27,
      questionCount: 30,
    });
    expect(Object.hasOwn(view, "alreadySubmitted")).toBe(false);
  });

  it("ส่งซ้ำ (replay) → ผลเดิม + alreadySubmitted:true ไม่มี correctCount/questionCount", () => {
    const view = toSubmitView({
      attempt_id: UUID(1),
      status: "failed",
      score_pct: 40,
      passed: false,
      already_submitted: true,
    });
    const parsed = AttemptSubmitView.parse(view);
    expect(parsed.alreadySubmitted).toBe(true);
    expect(Object.hasOwn(parsed, "correctCount")).toBe(false);
    expect(Object.hasOwn(parsed, "questionCount")).toBe(false);
  });
});

describe("readJwtSessionClaim — D20-B5", () => {
  const client = (token: string | null, error: unknown = null) => ({
    auth: { getSession: async () => ({ data: token === null ? { session: null } : { session: { access_token: token } }, error }) },
  });

  it("อ่าน claim session_id จาก access token ได้", async () => {
    await expect(readJwtSessionClaim(client(makeJwt("sess-abc")))).resolves.toBe("sess-abc");
  });

  it("ไม่มี session → ERR-AUTH-001 · error จาก store → ERR-AUTH-001", async () => {
    await expect(readJwtSessionClaim(client(null))).rejects.toMatchObject({ code: "ERR-AUTH-001" });
    await expect(readJwtSessionClaim(client(null, new Error("boom")))).rejects.toMatchObject({
      code: "ERR-AUTH-001",
    });
  });

  it("token ไม่มี claim session_id → ERR-AUTH-001 (fail-closed) · token ผิดรูป → ERR-SYS-001", async () => {
    await expect(readJwtSessionClaim(client(makeJwt(null)))).rejects.toMatchObject({
      code: "ERR-AUTH-001",
    });
    await expect(readJwtSessionClaim(client("not-a-jwt"))).rejects.toMatchObject({
      code: "ERR-SYS-001",
    });
    expect(errorDefinition("ERR-AUTH-001").httpStatus).toBe(401);
  });
});

describe("AttemptQuestionSnapshot — contract jsonb ของ start_attempt", () => {
  it("ตรวจรูป snapshot (options ต้องมี is_correct ต่อข้อ)", () => {
    const snap = viewRow().question_snapshot;
    expect(AttemptQuestionSnapshot.parse(snap).options).toHaveLength(2);
    expect(AttemptQuestionSnapshot.safeParse({ broken: true }).success).toBe(false);
  });

  it("AttemptStartView รับ takeover เป็น optional", () => {
    const base = {
      attemptId: UUID(1),
      status: "in_progress" as const,
      deadlineAt: "2026-09-10T02:02:03+00:00",
      serverTime: T,
      questionCount: 1,
      questions: [{ questionId: UUID(100), seq: 1, selectedOptionIds: null, answeredAt: null }],
    };
    expect(AttemptStartView.safeParse(base).success).toBe(true);
    expect(AttemptStartView.safeParse({ ...base, takeover: true }).success).toBe(true);
    expect(AttemptStartView.safeParse({ ...base, questions: [] }).success).toBe(false);
  });
});
