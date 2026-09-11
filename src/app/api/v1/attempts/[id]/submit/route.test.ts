/**
 * unit tests — POST /api/v1/attempts/[id]/submit (Wave D-1)
 *
 * จุดตรวจหลัก: Idempotency-Key บังคับ uuid (ขาด/รูปแปลก → VAL-002) · BFF ไม่ cache key
 * (idempotency ที่ RPC ตาม DCR-6 — replay คืนผลเดิม + alreadySubmitted 200) · D20-B5
 * session_id จาก claim JWT เท่านั้น · body §4 #8 strict (คีย์แปลกปลอมรวม session_id →
 * VAL-001 · ยอมรับ body ว่างเป็น {}) · grading synchronous → 200
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RATE_LIMIT_EXAM_PER_MIN = "2";
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
import { POST } from "./route";
import { errorDefinition, type ErrorCode } from "@/lib/errors";
import { AttemptSubmitView } from "@/lib/schemas/v1/exam";

const ATTEMPT_ID = "b0000000-0000-4000-8000-000000000001";
const SESSION_ID = "sess-d1-submit-1";
const KEY = "c0000000-0000-4000-8000-000000000009";

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return enc({ alg: "HS256", typ: "JWT" }) + "." + enc(payload) + "." + "c2ln";
}

interface Spec {
  userId: string | null;
  aal: "aal1" | "aal2";
  roles: readonly string[];
  token: string | null;
  claim: string | null;
  rpcData: unknown;
  rpcError: { message: string } | null;
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: "u1",
    aal: "aal1",
    roles: ["citizen"],
    token: makeJwt({ sub: "u1", session_id: SESSION_ID }),
    claim: SESSION_ID,
    rpcData: {
      attempt_id: ATTEMPT_ID,
      status: "passed",
      score_pct: 87,
      passed: true,
      correct_count: 26,
      question_count: 30,
      total_points: 40,
    },
    rpcError: null,
    ...spec,
  };
  const claimObj: Record<string, unknown> =
    full.token === null
      ? {}
      : (JSON.parse(
          Buffer.from(full.token.split(".")[1] as string, "base64url").toString("utf8"),
        ) as Record<string, unknown>);
  if (full.claim === null) {
    delete claimObj["session_id"];
  }
  const token = full.token === null ? null : makeJwt(claimObj);
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
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
      getSession: vi.fn(async () => ({
        data: { session: token === null ? null : { access_token: token } },
        error: null,
      })),
    },
    rpc: vi.fn(async (...a: [string, unknown?]) => {
      const [fn] = a;
      if (fn === "my_roles") {
        return { data: full.roles, error: null };
      }
      return { data: full.rpcData, error: full.rpcError };
    }),
    from: vi.fn(() => profilesBuilder),
    _rpcArgs: [] as Array<{ fn: string; args: unknown }>,
  };
  const rawRpc = client.rpc;
  client.rpc = vi.fn(async (fn: string, args?: unknown) => {
    client._rpcArgs.push({ fn, args });
    return rawRpc(fn, args as never) as never;
  }) as typeof client.rpc;
  return { client, full };
}

function mockClient(spec: Partial<Spec> = {}) {
  const { client } = makeClient(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

async function post(
  id: string,
  spec: Partial<Spec> = {},
  idempotencyKey?: string | null,
  rawBody?: string | null,
) {
  const client = mockClient(spec);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "10.0.0.6",
    "x-request-id": "req-d1-5",
  };
  if (idempotencyKey !== null) {
    headers["idempotency-key"] = idempotencyKey ?? KEY;
  }
  const body =
    rawBody === undefined
      ? JSON.stringify({ unansweredQuestionIds: [] }) // §4 #8 — body ปกติของ client
      : rawBody; // null = ไม่มี body เลย · string = raw body ตามที่ระบุ
  const res = await POST(
    new Request("http://localhost:3000/api/v1/attempts/" + id + "/submit", {
      method: "POST",
      headers,
      ...(body === null ? {} : { body }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { res, client };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

interface OkBody { data: Record<string, unknown> }
interface ErrorBody { error: { code: string; message: string; details?: Record<string, unknown> } }

describe("POST /attempts/{id}/submit — happy path (DCR-6)", () => {
  it("citizen ส่งข้อสอบ → 200 ผลตรวจทันที (ผ่าน zod) · RPC รับ p_session_id จาก claim", async () => {
    const { res, client } = await post(ATTEMPT_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    const parsed = AttemptSubmitView.parse(body.data);
    expect(parsed.status).toBe("passed");
    expect(parsed.scorePct).toBe(87);
    expect(parsed.passed).toBe(true);
    expect(parsed.correctCount).toBe(26);
    expect(parsed.questionCount).toBe(30);
    expect(parsed.totalPoints).toBe(40);
    expect(parsed.alreadySubmitted).toBeUndefined();
    const call = client._rpcArgs.find((c) => c.fn === "submit_attempt");
    expect(call?.args).toEqual({
      p_attempt_id: ATTEMPT_ID,
      p_session_id: SESSION_ID,
    });
    expect(res.headers.get("x-request-id")).toBe("req-d1-5");
  });

  it("ส่งซ้ำ (replay) → 200 ผลเดิม + alreadySubmitted:true ไม่ error (DCR-6 · 0019 early-return ครบ qc/tp)", async () => {
    const { res } = await post(ATTEMPT_ID, {
      rpcData: {
        attempt_id: ATTEMPT_ID,
        status: "failed",
        score_pct: 40,
        passed: false,
        question_count: 30,
        total_points: 40,
        already_submitted: true,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    const parsed = AttemptSubmitView.parse(body.data);
    expect(parsed.alreadySubmitted).toBe(true);
    expect(parsed.status).toBe("failed");
    expect(parsed.correctCount).toBeUndefined();
    expect(parsed.questionCount).toBe(30);
    expect(parsed.totalPoints).toBe(40);
    // replay ยังตอบ 200 เสมอ — ตรวจว่า body ไร้ field เฉลยแม้ตอน replay
    const raw = JSON.stringify(body.data);
    expect(raw).not.toContain("explanation");
    expect(raw).not.toContain("is_correct");
  });

  it("D20-B5: RPC รับ p_session_id จาก claim JWT เท่านั้น — ไม่มีค่าใดจาก body ผ่านถึง RPC", async () => {
    const { res, client } = await post(ATTEMPT_ID);
    expect(res.status).toBe(200);
    const call = client._rpcArgs.find((c) => c.fn === "submit_attempt");
    expect(call?.args).toEqual({
      p_attempt_id: ATTEMPT_ID,
      p_session_id: SESSION_ID,
    });
  });
});

describe("POST /attempts/{id}/submit — body §4 #8 strict (lead edit)", () => {
  it("body แอบแถม session_id → 400 ERR-VAL-001 (strict ปฏิเสธคีย์แปลกปลอม) ไม่ถึง RPC", async () => {
    const { res, client } = await post(ATTEMPT_ID, {}, undefined, JSON.stringify({ session_id: "attacker-session" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    // zod v4 unrecognized_key ส่ง path ว่าง → parseOrThrow ใช้ fallback "body"
    expect(body.error.details?.["fields"]).toEqual(["body"]);
    expect(client._rpcArgs.some((c) => c.fn === "submit_attempt")).toBe(false);
  });

  it("ไม่มี body เลย → ยอมรับเป็น {} (default []) → 200 ตามปกติ", async () => {
    const { res } = await post(ATTEMPT_ID, {}, undefined, null);
    expect(res.status).toBe(200);
  });

  it("body ว่างเปล่าทางเทคนิค (whitespace) → ยอมรับเป็น {} → 200", async () => {
    const { res } = await post(ATTEMPT_ID, {}, undefined, "   ");
    expect(res.status).toBe(200);
  });

  it("unansweredQuestionIds เกินกำหนด (uuid ไม่ใช่) → 400 ERR-VAL-001", async () => {
    const { res } = await post(ATTEMPT_ID, {}, undefined, JSON.stringify({ unansweredQuestionIds: ["nope"] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("JSON เสียรูป → 400 ERR-VAL-001 (fields: body)", async () => {
    const { res } = await post(ATTEMPT_ID, {}, undefined, "{oops");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.["fields"]).toEqual(["body"]);
  });
});

describe("POST /attempts/{id}/submit — Idempotency-Key", () => {
  it("ไม่มี header Idempotency-Key → 400 ERR-VAL-002 และไม่เรียก submit_attempt", async () => {
    const { res, client } = await post(ATTEMPT_ID, {}, null);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-002");
    expect(body.error.message).toBe(errorDefinition("ERR-VAL-002").message);
    expect(client._rpcArgs.some((c) => c.fn === "submit_attempt")).toBe(false);
  });

  it.each([
    ["รูปแปลก (ไม่ใช่ uuid)", "not-a-uuid"],
    ["uuid ติด prefix", "key-" + KEY],
    ["ตัวขึ้นบรรทัด/คำว่าง", ""],
  ])("%s → 400 ERR-VAL-002", async (_label, bad) => {
    const { res, client } = await post(ATTEMPT_ID, {}, bad);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-002");
    expect(client._rpcArgs.some((c) => c.fn === "submit_attempt")).toBe(false);
  });

  it("BFF ไม่ cache key — key เดิมยิงซ้ำยังเรียก RPC ทุกครั้ง (idempotency อยู่ฝั่ง RPC)", async () => {
    const first = await post(ATTEMPT_ID);
    expect(first.res.status).toBe(200);
    const second = await post(ATTEMPT_ID);
    expect(second.res.status).toBe(200);
    expect(first.client._rpcArgs.filter((c) => c.fn === "submit_attempt")).toHaveLength(1);
    expect(second.client._rpcArgs.filter((c) => c.fn === "submit_attempt")).toHaveLength(1);
  });
});

describe("POST /attempts/{id}/submit — map ผล RPC submit_attempt", () => {
  const cases: Array<{ label: string; message: string; code: ErrorCode; status: number }> = [
    {
      label: "ไม่พบ attempt",
      message: "ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)",
      code: "ERR-NF-001",
      status: 404,
    },
    {
      label: "session ไม่ตรงของ attempt",
      message: "คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001)",
      code: "ERR-RBAC-001",
      status: 403,
    },
    {
      label: "ส่งแล้วแต่ RPC ไม่ให้ replay (ผิดปกติ)",
      message: "บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว (ERR-ASM-005)",
      code: "ERR-ASM-005",
      status: 422,
    },
    {
      label: "เกิน deadline + grace 5 นาที",
      message: "หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม (ERR-ASM-004)",
      code: "ERR-ASM-004",
      status: 422,
    },
    {
      label: "ยังไม่บันทึกคำตอบใด (submit ระหว่าง in_progress ปกติ)",
      message: "ข้อมูลที่ส่งมาไม่ถูกต้อง (ERR-VAL-001)",
      code: "ERR-VAL-001",
      status: 400,
    },
  ];
  for (const c of cases) {
    it(c.label + " → " + String(c.status) + " " + c.code + " (ข้อความจากทะเบียน)", async () => {
      const { res } = await post(ATTEMPT_ID, { rpcError: { message: c.message } });
      expect(res.status).toBe(c.status);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe(c.code);
      expect(body.error.message).toBe(errorDefinition(c.code).message);
    });
  }

  it("RPC ล้มเหลวโดยไม่มี code → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    const { res } = await post(ATTEMPT_ID, { rpcError: { message: "SQLSTATE 42501 permission denied" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("RPC คืน jsonb ผิด contract → 503 ERR-SYS-002 (fail-closed) และไม่ leak ฟิลด์ดิบ", async () => {
    const { res } = await post(ATTEMPT_ID, { rpcData: { attempt_id: ATTEMPT_ID, status: "weird" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("weird");
  });
});

describe("POST /attempts/{id}/submit — auth / rbac / validation", () => {
  it("ไม่ login → 401 ERR-AUTH-001 (และไม่ถึงขั้นเรียก submit_attempt)", async () => {
    const { res, client } = await post(ATTEMPT_ID, { userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._rpcArgs.some((c) => c.fn === "submit_attempt")).toBe(false);
  });

  it("บทบาทไม่มี attempt:start → 403 ERR-RBAC-001", async () => {
    const { res } = await post(ATTEMPT_ID, { roles: ["guest-unknown"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("staff aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004", async () => {
    const { res } = await post(ATTEMPT_ID, { roles: ["staff:exam"], aal: "aal1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("token ไม่มี claim session_id → 401 ERR-AUTH-001 (fail-closed) ไม่เรียก RPC", async () => {
    const { res, client } = await post(ATTEMPT_ID, { claim: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client._rpcArgs.some((c) => c.fn === "submit_attempt")).toBe(false);
  });

  it("path id ไม่ใช่ uuid → 400 ERR-VAL-001 (fields: id)", async () => {
    const { res, client } = await post("nope");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.["fields"]).toEqual(["id"]);
    expect(client._rpcArgs.some((c) => c.fn === "submit_attempt")).toBe(false);
  });

  it("rate EXAM = 2/min (env) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + Retry-After", async () => {
    const first = await post(ATTEMPT_ID);
    expect(first.res.status).toBe(200);
    const second = await post(ATTEMPT_ID);
    expect(second.res.status).toBe(200);
    const third = await post(ATTEMPT_ID);
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as ErrorBody;
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });
});
