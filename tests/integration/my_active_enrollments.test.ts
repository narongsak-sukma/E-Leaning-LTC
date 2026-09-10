/**
 * gate-cleanup r1 M2+M3 — RPC my_active_enrollments (migration 0017) ของ GET /api/v1/me/enrollments
 *
 * พิสูจน์บน DB จริงผ่าน Kong/PostgREST ทั้งหมด:
 * 1. ขอบเขตเจ้าของ — A เห็นแถวของตัวเอง B ไม่เห็นของ A (SECDEFINER รัดด้วย auth.uid())
 * 2. M3 — หลักสูตรถูก archive (status='archived') ประวัติการเรียนของ A ยังอยู่
 *    (embed courses!inner แบบเดิมจะหายเพราะ RLS courses_public_read = published-only)
 * 3. PB-7 เดิม — soft-delete (deleted_at) แถวหายจริงตามเจตนาของ PB-7
 * 4. รูปที่ route ใช้จริง — chain ?select= + order + limit บน RPC (PostgREST ยอมให้
 *    เพราะ STABLE) ตอบ 200
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignRole,
  courseIdByCode,
  createTestUser,
  deleteTestUser,
  psql,
  restCall,
  type TestUser,
} from "./helpers";

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("M2+M3 my_active_enrollments (migration 0017)", () => {
  let courseId = "";
  let learnerA: TestUser | null = null;
  let learnerB: TestUser | null = null;
  let staff: TestUser | null = null;

  /** เรียก RPC ผ่าน PostgREST แบบเดียวกับ route (select + order + limit chain ได้) */
  async function rpcRows(
    token: string,
    query = "select=id,user_id,course_id,status,enrolled_at,expires_at,completed_at&order=enrolled_at.desc&limit=50",
  ): Promise<Array<Record<string, unknown>>> {
    const res = await restCall("GET", `/rest/v1/rpc/my_active_enrollments?${query}`, { token });
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    return (res.json ?? []) as Array<Record<string, unknown>>;
  }

  /**
   * เปลี่ยนสถานะหลักสูตรผ่านเส้นทางจริง: role authenticated + claims ของ staff:content —
   * RLS courses_staff_update + trigger guard อ่าน claims (superuser อ้อมไม่ได้ และไม่ควร)
   */
  async function mutateCourse(setClause: string): Promise<void> {
    const claims = JSON.stringify({ sub: staff!.id, role: "authenticated" });
    await psql(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '${claims}', true);
      update public.courses set ${setClause} where id = '${courseId}';
    commit;`);
  }

  beforeAll(async () => {
    courseId = await courseIdByCode("LTC-102"); // published + is_public (เช่นเดียวกับ dcr3/PB-11)
    learnerA = await createTestUser("c17-a-learner", "citizen");
    learnerB = await createTestUser("c17-b-learner", "citizen");
    staff = await createTestUser("c17-staff", "staff:viewer");
    await assignRole(staff.id, "staff:content"); // สิทธิ์ update courses (RLS + guard)
    const enroll = await restCall(
      "POST",
      "/rest/v1/rpc/enroll",
      { token: learnerA.accessToken },
      { p_course_id: courseId },
    );
    expect(enroll.status, enroll.text.slice(0, 300)).toBeLessThan(400);
  });

  afterAll(async () => {
    // คืน state ของ seed เสมอ (mutation บนข้อมูล seed จริง)
    if (courseId !== "" && staff !== null) {
      await mutateCourse("status = 'published', deleted_at = null").catch(() => {});
    }
    if (learnerA !== null) {
      await deleteTestUser(learnerA.id);
    }
    if (learnerB !== null) {
      await deleteTestUser(learnerB.id);
    }
    if (staff !== null) {
      await deleteTestUser(staff.id);
    }
  });

  it("ขอบเขตเจ้าของ: A เห็น enrollment ของตัวเอง (ผ่าน select+order+limit chain 200) · B ไม่เห็นของ A", async () => {
    const rowsA = await rpcRows(learnerA!.accessToken);
    const mine = rowsA.filter((r) => r["course_id"] === courseId);
    expect(mine.length).toBe(1);
    expect(mine[0]?.["user_id"]).toBe(learnerA!.id);

    const rowsB = await rpcRows(learnerB!.accessToken);
    expect(rowsB.filter((r) => r["course_id"] === courseId)).toEqual([]);
  });

  it("M3: หลักสูตรถูก archive (status='archived') → ประวัติการเรียนของ A ยังอยู่ (embed courses!inner แบบ PB-7 เดิมจะหายเพราะ RLS published-only)", async () => {
    await mutateCourse("status = 'archived'");
    const rows = await rpcRows(learnerA!.accessToken);
    expect(rows.filter((r) => r["course_id"] === courseId).length).toBe(1);
    await mutateCourse("status = 'published'");
    const restored = await rpcRows(learnerA!.accessToken);
    expect(restored.filter((r) => r["course_id"] === courseId).length).toBe(1);
  });

  it("PB-7 เดิม: soft-delete (deleted_at) → แถวหายจริง · คืนค่า → กลับมา", async () => {
    await mutateCourse("deleted_at = now()");
    const gone = await rpcRows(learnerA!.accessToken);
    expect(gone.filter((r) => r["course_id"] === courseId)).toEqual([]);
    await mutateCourse("deleted_at = null");
    const back = await rpcRows(learnerA!.accessToken);
    expect(back.filter((r) => r["course_id"] === courseId).length).toBe(1);
  });
});
