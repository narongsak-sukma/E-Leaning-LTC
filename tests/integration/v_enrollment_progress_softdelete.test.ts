/**
 * PB-11 — v_enrollment_progress ต้องไม่นับ enrollment ของหลักสูตรที่ถูก soft-delete
 * (migration 0016) และตัวนับ completed ต้อง align กับ total (ไม่ pct เกิน 100 เมื่อ
 * lesson ถูกลบหลังมีผู้ทำเสร็จ)
 *
 * ผ่าน Kong จริงทั้งหมดตาม pattern ของ dcr3/dcr4: rpc/enroll ด้วย JWT ผู้เรียน →
 * อ่าน view ด้วย JWT staff:viewer · กลับกัน citizen อ่าน view ต้องว่าง (has_any_role
 * กรองฝั่ง view — ไม่ใช่ RLS)
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

describe.skipIf(!DB_URL)("PB-11 v_enrollment_progress + soft-delete (migration 0016)", () => {
  let courseId = "";
  let learner: TestUser | null = null;
  let staff: TestUser | null = null;

  /** อ่าน view ผ่าน REST ด้วย JWT ของใครสักคน */
  async function progressRows(token: string): Promise<Array<Record<string, unknown>>> {
    const res = await restCall(
      "GET",
      `/rest/v1/v_enrollment_progress?course_id=eq.${courseId}&select=enrollment_id,user_id,course_id,lesson_total,lesson_completed,progress_pct`,
      { token },
    );
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    return (res.json ?? []) as Array<Record<string, unknown>>;
  }

  /**
   * ตั้ง/ยกเลิก soft-delete ผ่านเส้นทางจริง เหมือนที่ PostgREST ทำ: role authenticated +
   * request.jwt.claims ของ staff (บทบาท staff:content) — trigger guard_course_soft_delete
   * (0010) + RLS ตรวจ claims ไม่ใช่ superuser จึงอ้อมไม่ได้ (และไม่ควรอ้อม)
   */
  async function setCourseDeleted(deleted: boolean): Promise<void> {
    const claims = JSON.stringify({ sub: staff!.id, role: "authenticated" });
    await psql(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '${claims}', true);
      update public.courses set deleted_at = ${deleted ? "now()" : "null"} where id = '${courseId}';
    commit;`);
  }

  beforeAll(async () => {
    courseId = await courseIdByCode("LTC-102"); // published + is_public — citizen enroll ได้ (เช่นเดียวกับ dcr3)
    learner = await createTestUser("c16-learner", "citizen");
    staff = await createTestUser("c16-staff", "staff:viewer");
    // staff:content เพิ่มสำหรับ soft-delete (guard 0010 ยอมเฉพาะ staff:content/super_admin)
    await assignRole(staff.id, "staff:content");
    // enroll ผู้เรียนเข้าหลักสูตรจริงผ่าน RPC เดียวกับที่ BFF เรียก (dcr3)
    const enroll = await restCall(
      "POST",
      "/rest/v1/rpc/enroll",
      { token: learner.accessToken },
      { p_course_id: courseId },
    );
    expect(enroll.status, enroll.text.slice(0, 300)).toBeLessThan(400);
  });

  afterAll(async () => {
    // คืน state ของ seed เสมอ (soft-delete เป็น mutation บนข้อมูล seed) — คืนค่าก่อนลบ
    // ผู้ใช้ staff เพราะการคืนค่าต้องใช้ claims ของ staff เอง
    if (courseId !== "" && staff !== null) {
      await setCourseDeleted(false).catch(() => {});
    }
    if (learner !== null) {
      await deleteTestUser(learner.id);
    }
    if (staff !== null) {
      await deleteTestUser(staff.id);
    }
  });

  it("staff:viewer เห็น enrollment ของหลักสูตรมีชีวิต (lesson_total > 0 ตาม seed) · citizen อ่าน view ได้แต่ว่างเปล่า (has_any_role กรองฝั่ง view)", async () => {
    const rows = await progressRows(staff!.accessToken);
    const mine = rows.filter((r) => r["user_id"] === learner!.id);
    expect(mine.length).toBe(1);
    expect(Number(mine[0]?.["lesson_total"])).toBeGreaterThan(0);

    const citizenRows = await progressRows(learner!.accessToken);
    expect(citizenRows).toEqual([]); // ไม่มีบทบาท staff → view คืนชุดว่าง
  });

  it("soft-delete หลักสูตร → enrollment หายจาก view ทันที (PB-11) · คืนค่า (deleted_at=null) → กลับมา", async () => {
    await setCourseDeleted(true);
    expect(await progressRows(staff!.accessToken)).toEqual([]);

    await setCourseDeleted(false);
    const rows = await progressRows(staff!.accessToken);
    expect(rows.filter((r) => r["user_id"] === learner!.id).length).toBe(1);
  });
});
