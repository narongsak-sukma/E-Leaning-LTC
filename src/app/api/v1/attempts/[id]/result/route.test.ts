/**
 * unit tests — GET /api/v1/attempts/[id]/result (Wave D-1)
 *
 * จุดตรวจหลัก (DCR-6): BFF ส่งตาม learner_attempt_view เป๊ะ — เฉลยเปิด/ไม่เปิดตัดสินฝั่ง view
 * (after_final_attempt 0009_views.sql L23-77) ไม่ใช่ฝั่ง BFF; ยังไม่เปิด = คอลัมน์เฉลย null
 * ตาม view · ไม่พบ/ไม่ใช่เจ้าของตอบเหมือนกัน NF-001 (ไม่เปิดเผยความมีอยู่) · rate READ
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RATE_LIMIT_READ_PER_MIN = "2";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  const createSupabaseSsrClientBuffered = vi.fn(async () => ({
    client: await createSupabaseSsrClient(),
    commitAuthWrites: () => {},
    commit: () => {},
    clearAuthCookies: () => {},
    hasPendingAuthWrite: () => false,
  }));
  return { createSupabaseSsrClient, createSupabaseSsrClientBuffered };
});

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { GET } from "./route";
import { errorDefinition } from "@/lib/errors";
import { AttemptResultView } from "@/lib/schemas/v1/exam";

const ATTEMPT_ID = "b0000000-0000-4000-8000-000000000001";
const ASSESSMENT_ID = "a0000000-0000-4000-8000-000000000002";
const Q1 = "d0000000-0000-4000-8000-000000000101";
const Q2 = "d0000000-0000-4000-8000-000000000102";
const OPT1 = "e0000000-0000-4000-8000-000000000201";
const OPT2 = "e0000000-0000-4000-8000-000000000202";
const T = "2026-09-11T01:02:03+00:00";

const SNAPSHOT = {
  question_id: Q1,
  version: 2,
  text: "ข้อใดถูกต้อง",
  options: [
    { id: OPT1, text: "ตัวเลือก ก", is_correct: true, points: 5 },
    { id: OPT2, text: "ตัวเลือก ข", is_correct: false, points: 5 },
  ],
  points: 5,
};

function viewRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: ATTEMPT_ID,
    user_id: "u0000000-0000-4000-8000-000000000001",
    assessment_id: ASSESSMENT_ID,
    attempt_no: 1,
    status: "passed",
    started_at: T,
    expires_at: "2026-09-11T02:02:03+00:00",
    submitted_at: T,
    score_pct: 87,
    passed: true,
    question_id: Q1,
    seq: 1,
    option_order: null,
    selected_option_ids: [OPT1],
    answered_at: T,
    is_correct: true,
    points_earned: 5,
    question_snapshot: SNAPSHOT,
    explanation: "เพราะข้อ ก ถูกต้อง",
    ...overrides,
  };
}

interface Spec {
  userId: string | null;
  aal: "aal1" | "aal2";
  roles: readonly string[];
  rows: unknown[] | null;
  rowsError: { message: string } | null;
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: "u1",
    aal: "aal1",
    roles: ["citizen"],
    rows: null,
    rowsError: null,
    ...spec,
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const rec = { select: [] as string[], eq: [] as Array<[string, unknown]>, order: [] as Array<[string, unknown]>, executed: false };
  const viewBuilder = {
    select: vi.fn((columns: string) => {
      rec.select.push(columns);
      return viewBuilder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      rec.eq.push([column, value]);
      return viewBuilder;
    }),
    order: vi.fn((column: string, opts: unknown) => {
      rec.order.push([column, opts]);
      return viewBuilder;
    }),
    then(res: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) {
      rec.executed = true;
      return res({ data: full.rows, error: full.rowsError });
    },
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: full.userId === null ? null : { id: full.userId } },
        error: null,
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: full.aal, nextLevel: null, currentAuthenticationMethods: [] },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles" ? { data: full.roles, error: null } : { data: null, error: null },
    ),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : viewBuilder)),
  };
  return { client, rec };
}

async function get(id: string, spec: Partial<Spec> = {}) {
  const { client, rec } = makeClient(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  const res = await GET(
    new Request("http://localhost:3000/api/v1/attempts/" + id + "/result", {
      headers: { "x-forwarded-for": "10.0.0.7", "x-request-id": "req-d1-6" },
    }),
    { params: Promise.resolve({ id }) },
  );
  return { res, rec };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

interface OkBody { data: Record<string, unknown> }
interface ErrorBody { error: { code: string; message: string; details?: Record<string, unknown> } }

describe("GET /attempts/{id}/result — happy path (เฉลยเปิดตาม view)", () => {
  it("ผ่านครบครั้งสุดท้าย → 200 + เฉลยตาม view (ผ่าน zod) · query อ่านจาก view เท่านั้น", async () => {
    const { res, rec } = await get(ATTEMPT_ID, {
      rows: [
        viewRow(),
        viewRow({ question_id: Q2, seq: 2, is_correct: false, points_earned: 0,
          selected_option_ids: [OPT2], explanation: "ข้อ ข ไม่ถูก", question_snapshot: null }),
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    const parsed = AttemptResultView.parse(body.data);
    expect(parsed.attemptId).toBe(ATTEMPT_ID);
    expect(parsed.status).toBe("passed");
    expect(parsed.scorePct).toBe(87);
    expect(parsed.questionCount).toBe(2);
    expect(parsed.questions[0]?.content?.text).toBe("ข้อใดถูกต้อง");
    expect(parsed.questions[0]?.content?.options[0]?.isCorrect).toBe(true);
    expect(parsed.questions[1]?.isCorrect).toBe(false);
    expect(parsed.questions[1]?.content).toBeNull();
    // อ่านผ่าน learner_attempt_view — ไม่ query attempt_answers/questions ตรง
    expect(rec.eq).toContainEqual(["attempt_id", ATTEMPT_ID]);
    expect(rec.order).toContainEqual(["seq", { ascending: true }]);
    expect(rec.select).toHaveLength(1);
    const cols = String(rec.select[0]);
    expect(cols).not.toContain("*");
    expect(res.headers.get("x-request-id")).toBe("req-d1-6");
  });

  it("BFF ส่งตาม view เป๊ะ — ยังไม่เปิดเฉลย (คอลัมน์ null ตาม view) ก็ส่ง null ตาม ไม่ filter/เปิดเอง", async () => {
    const { res } = await get(ATTEMPT_ID, {
      rows: [
        viewRow({
          status: "failed",
          passed: false,
          score_pct: 40,
          is_correct: null,
          points_earned: null,
          explanation: null,
          question_snapshot: null,
        }),
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    const parsed = AttemptResultView.parse(body.data);
    expect(parsed.status).toBe("failed");
    expect(parsed.questions[0]?.isCorrect).toBeNull();
    expect(parsed.questions[0]?.pointsEarned).toBeNull();
    expect(parsed.questions[0]?.explanation).toBeNull();
    expect(parsed.questions[0]?.content).toBeNull();
    const raw = JSON.stringify(body.data);
    expect(raw).not.toContain("เพราะข้อ ก ถูกต้อง");
  });

  it("select ระบุคอลัมน์ตาม view (0009 L23-77) — รวมคอลัมน์เฉลยที่ view ควบคุมการเปิดเอง", async () => {
    const { rec } = await get(ATTEMPT_ID, { rows: [viewRow()] });
    const cols = String(rec.select[0]);
    for (const col of [
      "attempt_id", "user_id", "assessment_id", "attempt_no", "status", "started_at",
      "expires_at", "submitted_at", "score_pct", "passed", "question_id", "seq",
      "selected_option_ids", "answered_at", "is_correct", "points_earned",
      "question_snapshot", "explanation",
    ]) {
      expect(cols).toContain(col);
    }
    expect(cols).not.toContain("*");
  });
});

describe("GET /attempts/{id}/result — ไม่พบ/ไม่ใช่เจ้าของ", () => {
  it("แถวว่าง (ไม่มีจริง หรือ attempt ของคนอื่น — view กรอง) → 404 NF-001 เหมือนกัน", async () => {
    const { res } = await get(ATTEMPT_ID, { rows: [] });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-NF-001");
    expect(body.error.message).toBe(errorDefinition("ERR-NF-001").message);
    // ข้อความเดียวกันทั้งสองกรณี — ไม่เปิดเผยว่า attempt มีอยู่จริงหรือไม่
    const other = await get(ATTEMPT_ID, { rows: [] });
    expect((await other.res.json()) as ErrorBody).toEqual(body);
  });
});

describe("GET /attempts/{id}/result — map ข้อผิดพลาด", () => {
  it("query ล้มเหลว → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    const { res } = await get(ATTEMPT_ID, { rowsError: { message: "SQLSTATE 42501 permission denied" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("question_snapshot ผิด contract → 503 ERR-SYS-002 (fail-closed)", async () => {
    const { res } = await get(ATTEMPT_ID, {
      rows: [viewRow({ question_snapshot: { question_id: Q1, text: "ไม่ครบ field" } })],
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("สถานะแปลกปลอมในแถว → 503 ERR-SYS-002 (view zod ไม่ผ่าน ไม่ส่งข้อมูลดิบออก)", async () => {
    const { res } = await get(ATTEMPT_ID, { rows: [viewRow({ status: "weird" })] });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("weird");
  });
});

describe("GET /attempts/{id}/result — auth / rbac / validation", () => {
  it("ไม่ login → 401 ERR-AUTH-001 ก่อน query", async () => {
    const { res, rec } = await get(ATTEMPT_ID, { userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(rec.executed).toBe(false);
  });

  it("บทบาทไม่มี attempt:view → 403 ERR-RBAC-001", async () => {
    const { res } = await get(ATTEMPT_ID, { roles: ["guest-unknown"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("staff aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004", async () => {
    const { res } = await get(ATTEMPT_ID, { roles: ["staff:exam"], aal: "aal1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("staff:exam aal2 (มี attempt:view) → 200", async () => {
    const { res } = await get(ATTEMPT_ID, { roles: ["staff:exam"], aal: "aal2", rows: [viewRow()] });
    expect(res.status).toBe(200);
  });

  it("path id ไม่ใช่ uuid → 400 ERR-VAL-001 (fields: id) ก่อน query", async () => {
    const { res, rec } = await get("nope");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.["fields"]).toEqual(["id"]);
    expect(rec.executed).toBe(false);
  });

  it("rate READ = 2/min (env) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + Retry-After", async () => {
    const first = await get(ATTEMPT_ID, { rows: [viewRow()] });
    expect(first.res.status).toBe(200);
    const second = await get(ATTEMPT_ID, { rows: [viewRow()] });
    expect(second.res.status).toBe(200);
    const third = await get(ATTEMPT_ID, { rows: [viewRow()] });
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });
});
