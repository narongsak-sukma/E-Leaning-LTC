/**
 * unit tests — POST /api/v1/courses/[id]/enroll (Wave C-3)
 *
 * mock client ตามแบบ rbac.test.ts (vi.mock supabase/ssr) — พฤติกรรม RPC ยึดข้อความ
 * exception จริงจาก supabase/migrations/0011_functions.sql L16-L63:
 *   ซ้ำ        → 'คุณลงทะเบียนหลักสูตรนี้แล้ว (ERR-ENR-001)'
 *   ไม่ published → 'ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ (ERR-CRS-001)'
 *   audience   → 'หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว (ERR-ENR-002)'
 *   ไม่มีบทบาท  → 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001)'
 * และเคส DCR-3/D25: ซ้ำ → 200 idempotent + enrollment เดิม (ไม่ใช่ 409)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// config อ่าน env ตอน first getConfig() — ตั้งก่อน import (LEARN_WRITE = 2 เพื่อทดสอบ 429)
vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
  process.env.RATE_LIMIT_LEARN_WRITE_PER_MIN = "2";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => {
  const createSupabaseSsrClient = vi.fn();
  // gate r12: getUser ของ session.ts ใช้ buffered client — wrapper อ่าน stub จาก
  // createSupabaseSsrClient ณ เวลาถูกเรียก (mockResolvedValue ตั้งทีหลังได้)
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
import { errorDefinition } from "@/lib/errors";
import {
  EnrollmentResource,
  type EnrollmentRow,
} from "@/lib/schemas/v1/enrollment";

const COURSE_ID = "c0000000-0000-4000-8000-000000000001";
const NEW_ID = "e0000000-0000-4000-8000-000000000001";
const T = "2026-09-10T01:02:03+00:00";
const ROW: EnrollmentRow = {
  id: NEW_ID,
  course_id: COURSE_ID,
  status: "active",
  enrolled_at: T,
  expires_at: null,
  completed_at: null,
};
const EXISTING: EnrollmentRow = { ...ROW, id: "e0000000-0000-4000-8000-000000000002" };

type RpcResult = { data: unknown; error: { message: string } | null };

interface Spec {
  userId: string | null;
  /** ระดับ assurance ของ session — staff:* ทุก role ถูกบังคับ aal2 (D25-O4) */
  aal: "aal1" | "aal2";
  roles: readonly string[];
  enroll: RpcResult;
  row: EnrollmentRow | null;
}

function makeClient(spec: Partial<Spec> = {}) {
  const full: Spec = {
    userId: "u1",
    aal: "aal1",
    roles: ["citizen"],
    enroll: { data: NEW_ID, error: null },
    row: ROW,
    ...spec,
  };
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: full.row, error: null })),
  };
  // profiles ของ session.getUser (SDS §5.5) — builder แยกจาก enrollment: บัญชี active ค่าตั้งต้น
  const profilesBuilder = {
    select: vi.fn(() => profilesBuilder),
    eq: vi.fn(() => profilesBuilder),
    maybeSingle: vi.fn(async () => ({ data: { is_active: true, deleted_at: null }, error: null })),
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
      return full.enroll;
    }),
    from: vi.fn((table: string) => (table === "profiles" ? profilesBuilder : builder)),
    _spec: full,
    _builder: builder,
  };
}

function mockClient(spec: Partial<Spec> = {}) {
  const client = makeClient(spec);
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return client;
}

/** request สำหรับ POST — ใส่ x-request-id + ip ให้ตรวจ envelope ได้ */
function enrollRequest(courseId: string): Request {
  return new Request("http://localhost:3000/api/v1/courses/" + courseId + "/enroll", {
    method: "POST",
    headers: { "x-forwarded-for": "10.0.0.1", "x-request-id": "req-c3-1" },
  });
}

async function post(courseId: string, spec: Partial<Spec> = {}) {
  const client = mockClient(spec);
  const res = await POST(enrollRequest(courseId), { params: Promise.resolve({ id: courseId }) });
  return { res, client };
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("POST /courses/{id}/enroll — happy path (API-SPEC §3.3)", () => {
  it("citizen ลงทะเบียนใหม่ → 201 + resource ตาม shape §3.3 (ผ่าน zod contract)", async () => {
    const { res, client } = await post(COURSE_ID);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: unknown };
    const parsed = EnrollmentResource.parse(body.data);
    expect(parsed.courseId).toBe(COURSE_ID);
    expect(parsed.status).toBe("active");
    expect(res.headers.get("x-request-id")).toBe("req-c3-1");
    expect(client.rpc).toHaveBeenCalledWith("enroll", { p_course_id: COURSE_ID });
  });
});

describe("POST /courses/{id}/enroll — DCR-3/D25 enroll ซ้ำ = 200 idempotent", () => {
  it("RPC โยน '(ERR-ENR-001)' → SELECT แถวเดิม → 200 + enrollment เดิม (ไม่ใช่ 409)", async () => {
    const { res, client } = await post(COURSE_ID, {
      enroll: {
        data: null,
        error: { message: "คุณลงทะเบียนหลักสูตรนี้แล้ว (ERR-ENR-001)" },
      },
      row: EXISTING,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("e0000000-0000-4000-8000-000000000002");
    expect(EnrollmentResource.parse(body.data).courseId).toBe(COURSE_ID);
    expect(client.rpc).toHaveBeenCalledWith("enroll", { p_course_id: COURSE_ID });
  });

  it("จับ ERR-ENR-001 แต่ SELECT ไม่เจอแถวเดิม (ผิดปกติ) → 409 ตามทะเบียน", async () => {
    const { res } = await post(COURSE_ID, {
      enroll: { data: null, error: { message: "คุณลงทะเบียนหลักสูตรนี้แล้ว (ERR-ENR-001)" } },
      row: null,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-ENR-001");
  });
});

describe("POST /courses/{id}/enroll — map ผล RPC ตาม 0011_functions.sql L16-L63", () => {
  it("draft/ไม่ published → RPC '(ERR-CRS-001)' → 404", async () => {
    const { res } = await post(COURSE_ID, {
      enroll: {
        data: null,
        error: { message: "ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ (ERR-CRS-001)" },
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-CRS-001");
    expect(body.error.message).toBe(errorDefinition("ERR-CRS-001").message);
  });

  it("PB-7: คอร์สถูก soft-delete → RPC กรอง deleted_at is null แล้วโยน '(ERR-CRS-001)' → 404 (ลงทะเบียนไม่ได้)", async () => {
    // eligibility อยู่ฝั่ง RPC enroll() — 0011_functions.sql L33-37: select ... where
    // id = p_course_id and deleted_at is null → not found โยน '(ERR-CRS-001)' ก่อน
    // ถึง INSERT (L48-52) → คอร์สที่ลบแล้วลงทะเบียนซ้ำ/ใหม่ไม่ได้ทุกกรณี (route ไม่แตะ SQL)
    const { res, client } = await post(COURSE_ID, {
      enroll: {
        data: null,
        error: { message: "ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ (ERR-CRS-001)" },
      },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-CRS-001");
    expect(client.rpc).toHaveBeenCalledWith("enroll", { p_course_id: COURSE_ID });
  });

  it("audience lawyer-only แต่ผู้ขอเป็น citizen → '(ERR-ENR-002)' → 422", async () => {
    const { res } = await post(COURSE_ID, {
      roles: ["citizen"],
      enroll: {
        data: null,
        error: { message: "หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว (ERR-ENR-002)" },
      },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-ENR-002");
  });

  it("ข้อความ RPC ไม่มีรหัสทะเบียน → 503 ERR-SYS-002 opaque (ไม่ leak ข้อความ SQL)", async () => {
    const { res } = await post(COURSE_ID, {
      enroll: { data: null, error: { message: "SQLSTATE 42P01 relation does not exist" } },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
    expect(body.error.message).not.toContain("SQLSTATE");
  });

  it("RPC สำเร็จแต่คืนค่าที่ไม่ใช่ uuid → 500 ERR-SYS-001 (contract ผิด — fail-closed)", async () => {
    const { res } = await post(COURSE_ID, { enroll: { data: 42, error: null } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-001");
  });
});

describe("POST /courses/{id}/enroll — auth / rbac / validation / rate", () => {
  it("ไม่ login → 401 ERR-AUTH-001", async () => {
    const { res, client } = await post(COURSE_ID, { userId: null });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-001");
    expect(client.rpc).not.toHaveBeenCalledWith("enroll", expect.anything());
  });

  it("staff:viewer (ไม่มี enroll:create) → 403 ERR-RBAC-001 (aal2 — ผ่าน MFA gate แล้ว)", async () => {
    const { res } = await post(COURSE_ID, { roles: ["staff:viewer"], aal: "aal2" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-RBAC-001");
  });

  it("staff:viewer aal1 (ยังไม่ MFA) → 403 ERR-AUTH-004 ก่อนพิจารณาสิทธิ์ (D25-O4)", async () => {
    const { res } = await post(COURSE_ID, { roles: ["staff:viewer"] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-004");
  });

  it("path param ไม่ใช่ uuid → 400 ERR-VAL-001 (fields: courseId)", async () => {
    const { res, client } = await post("not-a-uuid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
    expect(body.error.code).toBe("ERR-VAL-001");
    expect(body.error.details.fields).toEqual(["courseId"]);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("ครบ 2 ครั้ง (LEARN_WRITE=2) → ครั้งที่ 3 เป็น 429 ERR-RATE-001 + details.group", async () => {
    const first = await post(COURSE_ID, { row: EXISTING });
    expect(first.res.status).toBe(201);
    const second = await post(COURSE_ID, { row: EXISTING });
    expect(second.res.status).toBe(201);
    const third = await post(COURSE_ID, { row: EXISTING });
    expect(third.res.status).toBe(429);
    const body = (await third.res.json()) as {
      error: { code: string; details: { group: string } };
    };
    expect(body.error.code).toBe("ERR-RATE-001");
    expect(body.error.details.group).toBe("LEARN_WRITE");
    expect(third.res.headers.get("retry-after")).not.toBeNull();
  });
});
