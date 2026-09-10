/**
 * DCR-3 — enroll ซ้ำผ่าน rpc/enroll → ได้ enrollment เดิม (idempotent semantics)
 *
 * เรียก RPC ตรงตามที่ BFF (src/app/api/v1/courses/[id]/enroll/route.ts) เรียก:
 *   supabase.rpc("enroll", { p_course_id })  ≡  POST /rest/v1/rpc/enroll {"p_course_id": ...}
 * ลำดับของ DCR-3 ที่ BFF ทำ (route.ts L70-L78): RPC ครั้งที่สองโยน ERR-ENR-001
 * → BFF SELECT แถวเดิมด้วย (user_id, course_id) → 200 คืน enrollment เดิม
 * ที่นี่พิสูจน์ที่ DB/REST layer: ซ้ำ → error ERR-ENR-001 และแถวเดิมยังแถวเดียว id เดิม
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANON_KEY,
  courseIdByCode,
  createTestUser,
  deleteTestUser,
  psqlRows,
  restCall,
  type TestUser,
} from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

interface EnrollmentRow {
  readonly id: string;
  readonly user_id: string;
  readonly course_id: string;
  readonly status: string;
}

describe.skipIf(!DB_URL)("DCR-3 enroll ซ้ำ (rpc/enroll — ERR-ENR-001 → แถวเดิม)", () => {
  let courseId: string;
  let user: TestUser;

  beforeAll(async () => {
    courseId = await courseIdByCode("LTC-102"); // published + is_public — citizen enroll ได้
    user = await createTestUser("c9-dcr3", "citizen");
  }, 60_000);

  afterAll(async () => {
    if (user !== undefined) await deleteTestUser(user.id);
  });

  it("ครั้งแรก: rpc/enroll สร้าง enrollment ใหม่ คืน uuid", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/enroll",
      { apiKey: ANON_KEY, token: user.accessToken },
      { p_course_id: courseId },
    );
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    const created = result.json as string;
    expect(created).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ครั้งที่สอง: rpc/enroll โยน ERR-ENR-001 (ข้อความที่ BFF parseRpcErrorCode จับ)", async () => {
    const result = await restCall(
      "POST",
      "/rest/v1/rpc/enroll",
      { apiKey: ANON_KEY, token: user.accessToken },
      { p_course_id: courseId },
    );
    expect(result.status).toBeGreaterThanOrEqual(400); // PostgREST แปลง raise exception → 4xx
    const body = (result.json ?? {}) as { message?: string };
    expect(body.message ?? "").toContain("ERR-ENR-001");
  });

  it("หลังเรียกซ้ำ: (user, course) ยังมี enrollment แถวเดียว = id ที่ครั้งแรกสร้าง", async () => {
    const rows = await psqlRows<EnrollmentRow>(`
      select id::text, user_id::text, course_id::text, status::text
      from public.enrollments
      where user_id = '${user.id}' and course_id = '${courseId}';
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
  });

  it("ผู้เรียนอ่าน enrollment ของตัวเองผ่าน REST ได้แถวเดียว (RLS เจ้าของ — BFF ใช้ทางนี้ตอบ 200)", async () => {
    const result = await restCall(
      "GET",
      `/rest/v1/enrollments?select=id,status,user_id,course_id&user_id=eq.${user.id}&course_id=eq.${courseId}`,
      { apiKey: ANON_KEY, token: user.accessToken },
    );
    expect(result.status).toBe(200);
    const rows = result.json as EnrollmentRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
  });
});
