/**
 * unit tests — GET /api/v1/me (Wave C Phase 1 · API-SPEC 1.0.2 §3.2)
 *
 * mock client ตามแบบ me/enrollments/route.test.ts (vi.mock supabase/ssr) —
 * จุดตรวจสำคัญ: (1) ไม่ login → 401 (2) **staff ที่ยัง aal1 ต้องได้ 200**
 * (allowlist AUTH-007 — D27: GET /me read-only ไม่ผ่าน MFA gate) (3) ขอบเขต
 * "ของตัวเอง" .eq(id, userId) (4) แถว profile หายกลางคัน = fail-closed 500
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/ssr", () => ({ createSupabaseSsrClient: vi.fn() }));

import { createSupabaseSsrClient } from "@/lib/supabase/ssr";
import { resetRateLimitStore } from "@/lib/rate-limit";
import { GET } from "./route";

const USER_ID = "10000000-0000-4000-8000-000000000001";

/** แถว profiles เต็ม — getUser() อ่าน is_active/deleted_at / route อ่าน id/email/display_name */
type ProfileRow = {
  id: string;
  email: string;
  display_name: string;
  is_active: boolean;
  deleted_at: string | null;
};

/** ผลลัพธ์ของ maybeSingle — data null (แถวหาย) กับ error (db down) คนละเคส */
type ProfileResult = {
  data: ProfileRow | null;
  error: { message: string } | null;
};

/**
 * thenable builder ของ profiles — `.eq(id).maybeSingle()` ตอบตามลำดับ calls
 * (call ที่ 1 = getUser ของ session · call ถัดไป = route; ลำดับหมด = ตอบค่าสุดท้ายซ้ำ)
 */
function profilesBuilder(sequence: ProfileResult[]) {
  const eqCalls: Array<{ column: string; value: unknown }> = [];
  let call = 0;
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqCalls.push({ column, value });
      return builder;
    }),
    maybeSingle: vi.fn(async (): Promise<ProfileResult> => {
      const index = Math.min(call, sequence.length - 1);
      call += 1;
      const result = sequence[index];
      return result === undefined ? { data: null, error: null } : result;
    }),
  };
  return { builder, eqCalls };
}

function mockClient(input: {
  profile?: ProfileRow | null;
  /** ลำดับคำตอบ maybeSingle หลัง call ของ getUser (call ที่ 1) — [call ของ route, ...] */
  routeProfile?: ProfileResult[];
  roles?: readonly string[];
  aal?: "aal1" | "aal2";
  noSession?: boolean;
}) {
  const profile: ProfileRow = input.profile ?? {
    id: USER_ID,
    email: "somsri@example.com",
    display_name: "สมศรี ใจดี",
    is_active: true,
    deleted_at: null,
  };
  const ok: ProfileResult = { data: profile, error: null };
  const { builder: pBuilder, eqCalls } = profilesBuilder(
    input.routeProfile === undefined ? [ok] : [ok, ...input.routeProfile],
  );
  const client = {
    auth: {
      getUser: vi.fn(async () =>
        input.noSession
          ? { data: { user: null }, error: { message: "no session" } }
          : { data: { user: { id: USER_ID } }, error: null },
      ),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: input.aal ?? "aal1" },
          error: null,
        })),
      },
    },
    rpc: vi.fn(async (fn: string) =>
      fn === "my_roles"
        ? { data: input.roles ?? ["citizen"], error: null }
        : { data: null, error: { message: "unknown rpc" } },
    ),
    from: vi.fn((table: string) => {
      if (table !== "profiles") {
        throw new Error("unexpected table: " + table);
      }
      return pBuilder;
    }),
  };
  vi.mocked(createSupabaseSsrClient).mockResolvedValue(client as never);
  return { eqCalls };
}

function meUrl(): Request {
  return new Request("http://localhost:3000/api/v1/me", {
    headers: { "x-forwarded-for": "10.0.0.9", "x-request-id": "req-me-1" },
  });
}

beforeEach(() => {
  vi.mocked(createSupabaseSsrClient).mockReset();
  resetRateLimitStore();
});

describe("GET /me — โปรไฟล์ + บทบาทของตัวเอง (§3.2)", () => {
  it("200 { data } ครบ 5 ฟิลด์ + x-request-id สะท้อนกลับ", async () => {
    mockClient({ roles: ["citizen"], aal: "aal1" });
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      id: USER_ID,
      email: "somsri@example.com",
      displayName: "สมศรี ใจดี",
      roles: ["citizen"],
      mfaVerified: false,
    });
    expect(res.headers.get("x-request-id")).toBe("req-me-1");
  });

  it("ผูกเจ้าของเสมอ: .eq(id, userId) บน profiles", async () => {
    const { eqCalls } = mockClient({});
    await GET(meUrl());
    expect(eqCalls).toContainEqual({ column: "id", value: USER_ID });
  });

  it("roles สะท้อน my_roles() ทั้งหลายบทบาท + mfaVerified=true เมื่อ aal2", async () => {
    mockClient({ roles: ["lawyer", "instructor"], aal: "aal2" });
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { roles: string[]; mfaVerified: boolean } };
    expect(body.data.roles).toEqual(["lawyer", "instructor"]);
    expect(body.data.mfaVerified).toBe(true);
  });

  it("**AUTH-007 (D27): staff:content ที่ยัง aal1 ได้ 200 — GET /me ไม่ผ่าน MFA gate**", async () => {
    mockClient({ roles: ["staff:content"], aal: "aal1" });
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { roles: string[]; mfaVerified: boolean } };
    expect(body.data.roles).toEqual(["staff:content"]);
    expect(body.data.mfaVerified).toBe(false);
  });

  it("ไม่มี session → 401 ERR-AUTH-001", async () => {
    mockClient({ noSession: true });
    const res = await GET(meUrl());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-AUTH-001");
  });

  it("profiles อ่านไม่ได้หลังผ่าน session (db down กลางคัน) → 503 ERR-SYS-002 (opaque)", async () => {
    mockClient({ routeProfile: [{ data: null, error: { message: "db down" } }] });
    const res = await GET(meUrl());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-002");
  });

  it("แถว profile หายกลางคัน (requireUser ผ่านแล้ว) → 500 ERR-SYS-001 fail-closed", async () => {
    mockClient({ routeProfile: [{ data: null, error: null }] });
    const res = await GET(meUrl());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ERR-SYS-001");
  });

  it("rate = READ + secondaryKey = userId (§5 /me*)", async () => {
    mockClient({});
    const res = await GET(meUrl());
    expect(res.status).toBe(200);
    // ทดสอบตัวจริงของ rate-limit: ยิงเกินโควตา READ (120/min) ด้วย key เดิมต้องเริ่มเจอ 429
    let last = 200;
    for (let i = 0; i < 125; i += 1) {
      const r = await GET(meUrl());
      last = r.status;
      if (last === 429) {
        break;
      }
    }
    expect(last).toBe(429);
  });
});
