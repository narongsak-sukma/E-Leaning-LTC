/**
 * gate r3 MAJOR-1 — lessons_read ต้องไม่ให้อ่าน lesson ของ parent ที่ถูก soft-delete
 *
 * ช่องรั่วเดิม: policy 0010 กรองเฉพาะสถานะ course/status และ enrollment แต่ไม่ดู
 * course_modules.deleted_at / courses.deleted_at → ผู้เรียน enrollment active เรียก lesson
 * เดิมผ่าน learner path ต่อได้แม้โมดูล/หลักสูตรถูกลบไปแล้ว (migration 0013 เติม guard นี้)
 * ตรวจผ่าน PostgREST จริงในฐานะผู้ใช้ authenticated (ช่องทางเดียวกับที่ BFF route ใช้)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANON_KEY, createTestUser, deleteTestUser, psql, psqlRows, restCall, type TestUser } from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL;

interface ChainRow {
  readonly lesson_id: string;
  readonly module_id: string;
  readonly course_id: string;
}

describe.skipIf(!DB_URL)("lessons_read — parent soft-delete guard (0013, gate r3)", () => {
  let learner: TestUser;
  let chain: ChainRow;

  /** อ่าน lesson ผ่าน PostgREST ในฐานะผู้เรียนที่ลงทะเบียน — จำนวนแถวที่ RLS ยอมให้เห็น */
  async function visibleLessonCount(): Promise<number> {
    const res = await restCall(
      "GET",
      `/rest/v1/lessons?select=id&id=eq.${chain.lesson_id}`,
      { apiKey: ANON_KEY, token: learner.accessToken },
    );
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    return (res.json as unknown[]).length;
  }

  beforeAll(async () => {
    learner = await createTestUser("c13-parentsd", "citizen");
    const rows = await psqlRows<ChainRow>(`
      select l.id::text as lesson_id, m.id::text as module_id, c.id::text as course_id
      from public.lessons l
      join public.course_modules m on m.id = l.module_id
      join public.courses c on c.id = m.course_id
      where c.code = 'LTC-102' and l.deleted_at is null and m.deleted_at is null
      order by l.sort_order
      limit 1;
    `);
    expect(rows, "seed ต้องมีหลักสูตร LTC-102 พร้อมโมดูล/บทเรียน").toHaveLength(1);
    chain = rows[0]!;
    // ผู้เรียนลงทะเบียน active (แทรกตรง DB ฝั่ง admin — RLS insert ไม่เกี่ยวกับสิ่งที่กำลังจะตรวจ)
    await psql(`
      insert into public.enrollments (user_id, course_id, status)
      values ('${learner.id}', '${chain.course_id}', 'active')
      on conflict do nothing;
    `);
    // course soft-delete ถูก guard_course_soft_delete (D19-B6) ยึดไว้ — มอบ staff:content
    // ให้ profile demo ชั่วคราว เพื่อทดสอบผ่าน path จริงของ trigger (ไม่ disable อะไรทั้งสิ้น)
    await psql(`
      insert into public.role_assignments (user_id, role)
      values ('11111111-1111-4111-8111-000000000002', 'staff:content')
      on conflict do nothing;
    `);
  }, 60_000);

  /** soft-delete/คืนสถานะ courses ผ่าน guard จริง — อ้าง identity ของ staff:content (D19-B6) */
  const staffContentGuc = `"request.jwt.claims" = '{"sub":"11111111-1111-4111-8111-000000000002","role":"authenticated"}'`;

  async function setCourseDeleted(deleted: boolean): Promise<void> {
    await psql(`
      begin;
      set local ${staffContentGuc};
      update public.courses set deleted_at = ${deleted ? "now()" : "null"} where id = '${chain.course_id}';
      commit;
    `);
  }

  afterAll(async () => {
    if (typeof chain !== "undefined") {
      await psql(`
        delete from public.enrollments where user_id = '${learner.id}' and course_id = '${chain.course_id}';
        update public.course_modules set deleted_at = null where id = '${chain.module_id}';
      `);
      await setCourseDeleted(false);
      await psql(`
        delete from public.role_assignments
        where user_id = '11111111-1111-4111-8111-000000000002' and role = 'staff:content';
      `);
    }
    if (typeof learner !== "undefined") await deleteTestUser(learner.id);
  });

  it("control: โซ่ปกติ (course+module+lesson มีชีวิต) → ผู้เรียนเห็นบทเรียน", async () => {
    expect(await visibleLessonCount()).toBe(1);
  });

  it("โมดูลถูก soft-delete → บทเรียนหายจากผู้เรียนทันที (แม้ enrollment ยัง active)", async () => {
    await psql(`update public.course_modules set deleted_at = now() where id = '${chain.module_id}';`);
    try {
      expect(await visibleLessonCount()).toBe(0);
    } finally {
      await psql(`update public.course_modules set deleted_at = null where id = '${chain.module_id}';`);
    }
  });

  it("หลักสูตรถูก soft-delete → บทเรียนหายจากผู้เรียนทันที (แม้ enrollment ยัง active)", async () => {
    await setCourseDeleted(true);
    try {
      expect(await visibleLessonCount()).toBe(0);
    } finally {
      await setCourseDeleted(false);
    }
  });

  it("ตัวบทเรียนถูก soft-delete → หายจากผู้เรียนทันทีแม้ parent ยังมีชีวิต (0014, gate r5)", async () => {
    await psql(`update public.lessons set deleted_at = now() where id = '${chain.lesson_id}';`);
    try {
      expect(await visibleLessonCount()).toBe(0);
    } finally {
      await psql(`update public.lessons set deleted_at = null where id = '${chain.lesson_id}';`);
    }
  });
});
