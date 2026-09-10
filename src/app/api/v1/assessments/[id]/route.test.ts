/**
 * unit tests — GET /api/v1/assessments/[id] (Wave D-1)
 *
 * mock client ตามแบบ enroll/route.test.ts — RLS asm_read/ar_read + column grant
 * (pass_pct ได้ GRANT เพิ่มใน 0019 · selection ยังซ่อนตาม 0010 L709-713) อยู่ฝั่ง DB;
 * จุดตรวจของ unit test คือลำดับ handler, รูป query (table/columns/filter), mapping ผล
 * ตามทะเบียน error
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  // READ=2 เพื่อทดสอบ 429 (config cache ตอน first getConfig — ต้องตั้งก่อน import)
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
import { AssessmentDetailView } from "@/lib/schemas/v1/exam";

const ASSESSMENT_ID = "a0000000-0000-4000-8000-000000000002";
const T = "2026-09-10T01:02:03+00:00";

const ASSESSMENT_ROW = {
  id: ASSESSMENT_ID,
  course_id: "c0000000-0000-4000-8000-000000000003",
  code: "FINAL-01",
  title: "สอบปลายทาง",
  description: null,
  is_final: true,
  status: "published",
  published_at: T,
};

const RULES_ROW = {
  id: "r0000000-0000-4000-8000-000000000004",
  assessment_id: ASSESSMENT_ID,
  version: 2,
  pass_pct: 70,
  time_limit_minutes: 60,
  question_count: 30,
  max_attempts: 3,
  attempt_cooldown_minutes: 1440,
  shuffle_questions: true,
  shuffle_options: true,
  require_course_complete: true,
  proctoring_mode: "basic",
  effective_from: T,
};

interface Spec {
  userId: string | null;
  aal: "aal1" | "aal2";
  roles: readonly string[];
  assessment: { data: unknown; error: { message: string } | null };
  rules: { data: unknown; error: { message: string } | null };
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: "u1",
    aal: "aal1",
    roles: ["citizen"],
    assessment: { data: ASSESSMENT_ROW, error: null },
    rules: { data: RULES_ROW, error: null },
    ...spec,
  };
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
  };
  const assessmentCalls: string[] = [];
  const assessmentBuilder = {
    select: vi.fn((columns: string) => {
      assessmentCalls.push(columns);
      return assessmentBuilder;
    }),
    eq: vi.fn(() => assessmentBuilder),
    is: vi.fn(() => assessmentBuilder),
    maybeSingle: vi.fn(async () => full.assessment),
  };
  const rulesCalls: string[] = [];
  const rulesBuilder = {
    select: vi.fn((columns: string) => {
      rulesCalls.push(columns);
      return rulesBuilder;
    }),
    eq: vi.fn(() => rulesBuilder),
    lte: vi.fn(() => rulesBuilder),
    order: vi.fn(() => rulesBuilder),
    limit: vi.fn(() => rulesBuilder),
    maybeSingle: vi.fn(async () => full.rules),
  };
  return {
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
    rpc: vi.fn(async (fn: string) => {
      if (fn === "my_roles") {
        return { data: full.roles, error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((table: string) =>
      table === "profiles" ? profilesBuilder : table === "assessments" ? assessmentBuilder : rulesBuilder,
    ),
    _calls: { assessmentCalls, rulesCalls },
  };
}

async function get(id: string, spec: Partial<Spec> = {}) {
  const client = makeClient(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  const res = await GET(
    new Request("http://localhost:3000/api/v1/assessments/" + id, {
      headers: { "x-forwarded-for": "10.0.0.1", "x-request-id": "req-d1-1" },
    }),
    { params: Promise.resolve({ id }) },
  );
  return { res, client };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /assessments/{id} — happy path", () => {
  it("citizen ที่ลงทะเบียน → 200 + AssessmentDetail (ผ่าน zod) · query ตรง RLS/column grant", async () => {
    const { res, client } = await get(ASSESSMENT_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    const parsed = AssessmentDetailView.parse(body.data);
    expect(parsed.id).toBe(ASSESSMENT_ID);
    expect(parsed.rules.version).toBe(2);
    expect(parsed.rules.passPct).toBe(70);
    expect(res.headers.get("x-request-id")).toBe("req-d1-1");
    // เลือกเฉพาะคอลัมน์ที่ได้ GRANT SELECT (pass_pct เปิดตั้งแต่ 0019 · selection ยังซ่อน)
    const [assessmentCols] = client._calls.assessmentCalls;
    expect(assessmentCols).not.toContain("pass_pct");
    const [rulesCols] = client._calls.rulesCalls;
    expect(rulesCols).toContain("time_limit_minutes");
    expect(rulesCols).toContain("pass_pct");
    expect(rulesCols).not.toContain("selection");
  });

  it("staff:exam (มี assessment:view แต่เห็นทุกแถว) → 200 เหมือนกัน (MFA ผ่าน aal2)", async () => {
    const { res } = await get(ASSESSMENT_ID, { roles: ["staff:exam"], aal: "aal2" });
    expect(res.status).toBe(200);
  });
});

describe("GET /assessments/{id} — denial ทุก error code ของเส้นนี้", () => {
  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const { res } = await get(ASSESSMENT_ID, { userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-001");
  });

  it("staff:viewer ไม่มี assessment:view? — มี! → 200 · บทบาทไม่มี perm จริง = citizen แก้ role → 403 RBAC-001", async () => {
    // บทบาทที่ไม่มี assessment:view ใน matrix (เช่น บทบาทแปลกปลอม) → RBAC-001
    const { res } = await get(ASSESSMENT_ID, { roles: ["lawyer"], aal: "aal1" });
    expect(res.status).toBe(200); // lawyer มี assessment:view
    const stranger = makeClient({ roles: ["guest-unknown"] });
    vi.mocked(createSupabaseSsrClient).mockResolvedValue(stranger as never);
    const res2 = await GET(
      new Request("http://localhost:3000/api/v1/assessments/" + ASSESSMENT_ID, {
        headers: { "x-forwarded-for": "10.0.0.1" },
      }),
      { params: Promise.resolve({ id: ASSESSMENT_ID }) },
    );
    expect(res2.status).toBe(403);
    const body2 = (await res2.json()) as { error: { code: string } };
    expect(body2.error.code).toBe("ERR-RBAC-001");
  });

  it("staff:exam aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004 ก่อนพิจารณาสิทธิ์", async () => {
    const { res } = await get(ASSESSMENT_ID, { roles: ["staff:exam"], aal: "aal1" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("id ไม่ใช่ uuid → 400 ERR-VAL-001 (fields: id)", async () => {
    const { res, client } = await get("not-a-uuid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields).toEqual(["id"]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("RLS ไม่เห็น assessment (ไม่ published/ไม่ลงทะเบียน/ไม่มีจริง) → 404 ERR-ASM-003", async () => {
    const { res } = await get(ASSESSMENT_ID, { assessment: { data: null, error: null } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-ASM-003");
    expect(body.error.message).toBe(errorDefinition("ERR-ASM-003").message);
  });

  it("เห็น assessment แต่ไม่มีกติกา effective → 404 ERR-NF-001", async () => {
    const { res } = await get(ASSESSMENT_ID, { rules: { data: null, error: null } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-NF-001");
  });

  it("query ล้มเหลว → 503 ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    const { res } = await get(ASSESSMENT_ID, {
      assessment: { data: null, error: { message: "SQLSTATE 42501 permission denied" } },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("rate READ = 2/min (env) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + retry-after", async () => {
    const first = await get(ASSESSMENT_ID);
    expect(first.res.status).toBe(200);
    const second = await get(ASSESSMENT_ID);
    expect(second.res.status).toBe(200);
    const third = await get(ASSESSMENT_ID);
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as { error: { code: string; details: { group: string } } };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("READ");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });

  it("B4: กติกา drift (pass_pct null จาก DB) → 503 ERR-SYS-002 fail-closed ไม่รั่ง 200 เพี้ยน", async () => {
    const { res } = await get(ASSESSMENT_ID, {
      rules: { data: { ...RULES_ROW, pass_pct: null }, error: null },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.details?.reason).toBe("assessment_detail_contract_drift");
  });
});
