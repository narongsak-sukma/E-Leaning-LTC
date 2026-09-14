/**
 * route.test — unit test ของ POST /api/v1/admin/assessments/{id}/rules (Wave G P3 · D87)
 *
 * mock client ตามแบบ assessments/route.test.ts (vi.mock supabase/ssr; auth.getUser +
 * mfa aal2 + profiles.is_active + rpc my_roles) — ผลของ rpc admin_add_assessment_rules
 * อ่านจากคิวต่อชื่อฟังก์ชัน · ทดสอบ: 201 + AssessmentRuleResource + พารามิเตอร์ snake_case
 * ของ RPC (รวม p_exam_review_mode), 403 pre-check instructor/aal1, strict body,
 * map error tokens → httpStatus ตามทะเบียน, แถว RPC drift → 503 fail-closed
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
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
import { errorDefinition } from "@/lib/errors";
import { AssessmentRuleResource } from "@/lib/schemas/v1/admin-exam";
import { POST } from "./route";

const USER_ID = "a0000000-0000-4000-8000-000000000001";
const ASSESSMENT_ID = "d0000000-0000-4000-8000-000000000001";
const NOW = "2026-09-01T00:00:00+00:00";

/** result ของ rpc admin_add_assessment_rules — data/error ตามรูป PostgrestError */
interface RpcStubResult {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
}

/** rpc call ที่ถูกจด — payload = พารามิเตอร์ที่ route ส่งเข้า RPC (snake_case) */
interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

/** แถว jsonb ที่ RPC คืน (returning * — คอลัมน์ assessment_rules ครบตาม 0005 + 0049) */
function rpcRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f0000000-0000-4000-8000-000000000001",
    assessment_id: ASSESSMENT_ID,
    version: 2,
    time_limit_minutes: 60,
    question_count: 30,
    pass_pct: 70,
    max_attempts: 2,
    attempt_cooldown_minutes: 1440,
    shuffle_questions: true,
    shuffle_options: true,
    selection: {},
    require_course_complete: true,
    proctoring_mode: "basic",
    exam_review_mode: "after_final_attempt",
    effective_from: NOW,
    created_at: NOW,
    ...overrides,
  };
}

/**
 * client stub — rpc(my_roles) ตอบ roles · rpc(admin_add_assessment_rules) ดึงจากคิว ·
 * from(profiles) ตอบ is_active เสมอ (requirePermission) — จด rpc call ทุกครั้ง
 */
function mockClient(options: {
  rpc?: Record<string, RpcStubResult[]>;
  roles?: readonly string[];
  aal?: string;
}): { calls: RecordedRpc[] } {
  const calls: RecordedRpc[] = [];
  const profilesBuilder = {
    select: () => profilesBuilder,
    eq: () => profilesBuilder,
    maybeSingle: async () => ({ data: { is_active: true, deleted_at: null }, error: null }),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER_ID } }, error: null })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: options.aal ?? "aal2" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string, args: Record<string, unknown> = {}) => {
      if (fn === "my_roles") {
        return { data: [...(options.roles ?? ["staff:exam"])], error: null };
      }
      calls.push({ fn, args });
      const queue = options.rpc?.[fn] ?? [];
      const next = queue.length > 0 ? (queue.shift() as RpcStubResult) : { data: null, error: null };
      return { data: next.data ?? null, error: next.error ?? null };
    }),
    from: (table: string) => {
      if (table !== "profiles") {
        throw new Error(`unexpected from(${table})`);
      }
      return profilesBuilder;
    },
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { calls };
}

function rulesPost(body: unknown, id: string = ASSESSMENT_ID): Request {
  return new Request(`http://localhost:3000/api/v1/admin/assessments/${id}/rules`, {
    method: "POST",
    headers: {
      "x-forwarded-for": "10.5.0.1",
      "x-request-id": "req-wgp3-1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** body ขั้นต่ำที่ผ่าน zod — passPct เป็นฟิลด์บังคับเดียว ที่เหลือ default ครบตาม schema */
const VALID_BODY = { passPct: 70 };

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("POST .../rules — 201 + AssessmentRuleResource + พารามิเตอร์ RPC", () => {
  it("staff:exam → 201 · rpc ถูกเรียกพารามิเตอร์ snake_case ครบ + default จาก schema", async () => {
    const { calls } = mockClient({ rpc: { admin_add_assessment_rules: [{ data: rpcRow() }] } });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBe("req-wgp3-1");
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(() => AssessmentRuleResource.parse(body.data)).not.toThrow();
    expect(body.data["version"]).toBe(2);
    expect(body.data["assessmentId"]).toBe(ASSESSMENT_ID);
    expect(body.data["examReviewMode"]).toBe("after_final_attempt");
    expect(body.data["effectiveFrom"]).toBe(NOW);
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args ?? {};
    expect(args["p_assessment_id"]).toBe(ASSESSMENT_ID);
    expect(args["p_pass_pct"]).toBe(70);
    expect(args["p_time_limit_minutes"]).toBe(60); // default จาก schema (body ไม่ส่ง)
    expect(args["p_question_count"]).toBe(30);
    expect(args["p_max_attempts"]).toBe(3);
    expect(args["p_attempt_cooldown_minutes"]).toBe(1440);
    expect(args["p_shuffle_questions"]).toBe(true);
    expect(args["p_shuffle_options"]).toBe(true);
    expect(args["p_require_course_complete"]).toBe(true);
    expect(args["p_proctoring_mode"]).toBe("basic");
    expect(args["p_exam_review_mode"]).toBe("after_final_attempt"); // default จาก schema
    expect(args["p_selection"]).toBeNull(); // optional → null ตาม RPC (coalesce '{}')
    expect(args["p_effective_from"]).toBeNull(); // optional → null ตาม RPC (coalesce now())
    expect(errorDefinition("ERR-SYS-002").httpStatus).toBe(503);
  });

  it("ส่ง examReviewMode 'never' + selection + effectiveFrom → ส่งตรงเข้า RPC", async () => {
    const { calls } = mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { data: rpcRow({ exam_review_mode: "never", version: 3 }) },
        ],
      },
    });
    const res = await POST(
      rulesPost({
        passPct: 50,
        examReviewMode: "never",
        selection: { tag: "fin-2026" },
        effectiveFrom: NOW,
      }),
      { params: Promise.resolve({ id: ASSESSMENT_ID }) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data["examReviewMode"]).toBe("never");
    expect(body.data["version"]).toBe(3);
    const args = calls[0]?.args ?? {};
    expect(args["p_exam_review_mode"]).toBe("never");
    expect(args["p_selection"]).toEqual({ tag: "fin-2026" });
    expect(args["p_effective_from"]).toBe(NOW);
  });

  it("r8-N2: PostgREST wrap scalar เป็น array หลักเดียว → unwrap แล้ว 201 ปกติ", async () => {
    mockClient({ rpc: { admin_add_assessment_rules: [{ data: [rpcRow()] }] } });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { version: number } };
    expect(body.data.version).toBe(2);
  });
});

describe("POST .../rules — สิทธิ์ (pre-check + aal)", () => {
  it("instructor → 403 ERR-RBAC-001 ก่อนเรียก RPC (ไม่แตะ DB)", async () => {
    const { calls } = mockClient({ roles: ["instructor"] });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
    expect(errorDefinition("ERR-RBAC-001").httpStatus).toBe(403);
    expect(calls.some((call) => call.fn === "admin_add_assessment_rules")).toBe(false);
  });

  it("staff:exam แต่ session aal1 → 403 ERR-AUTH-004 ที่ชั้น RBAC (ไม่ถึง RPC)", async () => {
    const { calls } = mockClient({ aal: "aal1" });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
    expect(errorDefinition("ERR-AUTH-004").httpStatus).toBe(403);
    expect(calls.some((call) => call.fn === "admin_add_assessment_rules")).toBe(false);
  });
});

describe("POST .../rules — body strict + path", () => {
  it("body ส่ง version มา → 400 ERR-VAL-001 (schema strict — version = max+1 server-side)", async () => {
    const { calls } = mockClient({});
    const res = await POST(rulesPost({ ...VALID_BODY, version: 5 }), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.fn === "admin_add_assessment_rules")).toBe(false);
  });

  it("body ส่ง effective_to มา → 400 ERR-VAL-001 (schema strict — ไม่มีคีย์นี้)", async () => {
    const { calls } = mockClient({});
    const res = await POST(rulesPost({ ...VALID_BODY, effective_to: NOW }), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.fn === "admin_add_assessment_rules")).toBe(false);
  });

  it("passPct 0 → 400 ERR-VAL-001 ก่อนถึง RPC (zod min(1) — ขอบเขต zod ⊆ ขอบเขต RPC)", async () => {
    const { calls } = mockClient({});
    const res = await POST(rulesPost({ ...VALID_BODY, passPct: 0 }), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.fn === "admin_add_assessment_rules")).toBe(false);
  });

  it("path id ไม่ใช่ uuid → 400 ERR-VAL-001 ก่อนแตะ DB", async () => {
    const { calls } = mockClient({});
    const res = await POST(rulesPost(VALID_BODY, "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(calls.some((call) => call.fn === "admin_add_assessment_rules")).toBe(false);
  });

  it("body JSON พัง → 400 ERR-VAL-001 fields ['body'] (แบบ status route)", async () => {
    mockClient({});
    const request = new Request(
      `http://localhost:3000/api/v1/admin/assessments/${ASSESSMENT_ID}/rules`,
      {
        method: "POST",
        headers: { "x-forwarded-for": "10.5.0.1", "content-type": "application/json" },
        body: "{not-json",
      },
    );
    const res = await POST(request, { params: Promise.resolve({ id: ASSESSMENT_ID }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { fields?: string[] } };
    };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details?.fields).toEqual(["body"]);
  });
});

describe("POST .../rules — map error tokens ของ RPC → httpStatus ตามทะเบียน", () => {
  it("(ERR-NF-001|assessment_not_found) → 404", async () => {
    mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { error: { code: "P0001", message: "x (ERR-NF-001|assessment_not_found)" } },
        ],
      },
    });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
    expect(errorDefinition("ERR-NF-001").httpStatus).toBe(404);
  });

  it("(ERR-RBAC-001|rules_write_forbidden) จากชั้น DB → 403", async () => {
    mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { error: { code: "42501", message: "x (ERR-RBAC-001|rules_write_forbidden)" } },
        ],
      },
    });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("(ERR-AUTH-004|mfa_required) จากชั้น DB → 403", async () => {
    mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { error: { code: "42501", message: "x (ERR-AUTH-004|mfa_required)" } },
        ],
      },
    });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("กติกาไม่ผ่านเกณฑ์ของ RPC (ERR-VAL-001|rules_values) → 400 ตามทะเบียน (§2 แถว 72)", async () => {
    mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { error: { code: "22023", message: "x (ERR-VAL-001|rules_values)" } },
        ],
      },
    });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    // ทะเบียน error (spec §2 แถว 72) กำหนด ERR-VAL-001 = 400 — §3.8 แถว 226 เดิมเขียน 422
    // (ไม่ implementable เพราะ AppError.httpStatus ผูกทะเบียนเดียว) → แก้เป็น 400 แล้วใน API-SPEC 1.4.0
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-VAL-001");
  });

  it("(ERR-SYS-002|rules_version_conflict) ชน unique 3 ครั้ง → 503", async () => {
    mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { error: { code: "P0001", message: "x (ERR-SYS-002|rules_version_conflict)" } },
        ],
      },
    });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("error ไม่มีป้าย token → 503 ERR-SYS-002 opaque (reason assessment_rules_add_failed)", async () => {
    mockClient({
      rpc: {
        admin_add_assessment_rules: [
          { error: { code: "XX999", message: "connection reset by peer" } },
        ],
      },
    });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("assessment_rules_add_failed");
  });

  it("แถวที่ RPC คืน drift (exam_review_mode หาย) → 503 ERR-SYS-002 fail-closed", async () => {
    const row = rpcRow({ exam_review_mode: undefined });
    mockClient({ rpc: { admin_add_assessment_rules: [{ data: row }] } });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("assessment_rule_rpc_row_drift");
  });

  it("rpc.data ไม่ใช่ object (null) → 503 ERR-SYS-002 reason assessment_rule_rpc_drift", async () => {
    mockClient({ rpc: { admin_add_assessment_rules: [{ data: null }] } });
    const res = await POST(rulesPost(VALID_BODY), {
      params: Promise.resolve({ id: ASSESSMENT_ID }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("assessment_rule_rpc_drift");
  });
});
