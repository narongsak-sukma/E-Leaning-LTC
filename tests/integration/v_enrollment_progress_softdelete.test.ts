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
  psqlRows,
  psqlScalar,
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
    // ผู้ใช้ staff เพราะการคืนค่าต้องใช้ claims ของ staff เอง · gate r2: คืนค่าแบบ
    // "ตรวจแล้ว" (re-select แล้ว throw ถ้าไม่ตรง) — .catch(()=>{}) เงียบทำให้ seed
    // ค้าง archived ได้โดย suite ถัดไปไม่รู้ · ลบผู้ใช้ทดสอบใน finally เสมอ
    try {
      if (courseId !== "" && staff !== null) {
        await setCourseDeleted(false);
        const state = (
          await psql(
            `select status || '/' || coalesce(deleted_at::text, 'null') from public.courses where id = '${courseId}';`,
          )
        ).trim();
        if (state !== "published/null") {
          throw new Error(`seed course LTC-102 not restored: got "${state}"`);
        }
      }
    } finally {
      if (learner !== null) {
        await deleteTestUser(learner.id);
      }
      if (staff !== null) {
        await deleteTestUser(staff.id);
      }
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

  it("gate r2 MINOR: บทเรียนถูกย้ายข้ามหลักสูตร (lessons_update อนุญาต staff:content) → completed ต้องไม่นับบทเรียนที่ย้ายออก — completed ≤ total · pct ≤ 100 เสมอ (0018)", async () => {
    // enrollment จริงของ learner บน LTC-102 + บทเรียนทั้งหมดของหลักสูตร (seed = 2)
    const enrollments = await psqlRows<{ id: string }>(
      `select e.id from public.enrollments e
       where e.user_id = '${learner!.id}' and e.course_id = '${courseId}'`,
    );
    expect(enrollments.length).toBe(1);
    const enrollmentId = enrollments[0]!.id;

    const lessons = await psqlRows<{ id: string; module_id: string; sort_order: number }>(
      `select l.id::text, l.module_id::text, l.sort_order from public.lessons l
       join public.course_modules m on m.id = l.module_id
       where m.course_id = '${courseId}' and m.deleted_at is null and l.deleted_at is null
       order by l.id`,
    );
    expect(lessons.length).toBeGreaterThanOrEqual(2);

    // module ปลายทางต่างหลักสูตร (LTC-101 — seed คนละ course_id)
    const otherModule = await psqlScalar(
      `select m.id::text from public.course_modules m
       join public.courses c on c.id = m.course_id
       where c.code = 'LTC-101' and m.deleted_at is null
       order by m.id limit 1`,
    );
    expect(otherModule).not.toBe(lessons[0]!.module_id);

    // seed ผลการเรียน "เสร็จครบทุกบทเรียน" ผ่าน app_owner (เจ้าของตาราง 0010:402 —
    // เส้นทางเดียวกับที่ SECDEFINER record_lesson_progress เขียนจริง)
    const values = lessons
      .map(
        (l) =>
          `('${enrollmentId}', '${l.id}', 'completed', now())`,
      )
      .join(", ");
    await psql(`begin;
      set local role app_owner;
      insert into public.lesson_progress (enrollment_id, lesson_id, status, completed_at)
      values ${values}
      on conflict (enrollment_id, lesson_id)
      do update set status = 'completed', completed_at = now();
    commit;`);

    // ย้ายบทเรียนแรกข้ามหลักสูตรผ่าน claims path จริงของ staff:content —
    // lessons_update (0010:355) อนุญาต: WITH CHECK ตรวจเฉพาะหลักสูตรปลายทาง ·
    // sort_order ต้องย้ายพ้นช่องของ module ปลายทางด้วย (uq_lessons_sort:
    // unique (module_id, sort_order) where deleted_at is null)
    const moved = lessons[0]!;
    const claims = JSON.stringify({ sub: staff!.id, role: "authenticated" });
    let restoreError: unknown = null;
    try {
      // ก่อนย้าย: เสร็จครบ — completed = total · pct = 100
      const before = (await progressRows(staff!.accessToken)).find(
        (r) => r["user_id"] === learner!.id,
      );
      expect(Number(before?.["lesson_total"])).toBe(lessons.length);
      expect(Number(before?.["lesson_completed"])).toBe(lessons.length);
      expect(Number(before?.["progress_pct"])).toBe(100);

      await psql(`begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '${claims}', true);
        update public.lessons set module_id = '${otherModule}',
          sort_order = (select coalesce(max(l.sort_order), 0) + 100
                        from public.lessons l
                        where l.module_id = '${otherModule}' and l.deleted_at is null)
        where id = '${moved.id}';
      commit;`);

      // หลังย้าย + 0018: completed นับเฉพาะบทเรียนที่ยังอยู่ในหลักสูตรของ enrollment —
      // ตัวนับ 0016 เดิมจะได้ completed=2 > total=1 → pct=200 (จุดที่ codex จับ)
      const after = (await progressRows(staff!.accessToken)).find(
        (r) => r["user_id"] === learner!.id,
      );
      expect(Number(after?.["lesson_total"])).toBe(lessons.length - 1);
      expect(Number(after?.["lesson_completed"])).toBe(lessons.length - 1);
      expect(Number(after?.["progress_pct"])).toBe(100);
      expect(Number(after?.["lesson_completed"])).toBeLessThanOrEqual(
        Number(after?.["lesson_total"]),
      );
      // คืนที่เดิม (seed) — ผ่าน claims path เดียวกัน (sort_order ช่องเดิมว่างอยู่
      // เพราะเจ้าของช่องคือบทเรียนนี้เองที่เพิ่งย้ายออก)
      await psql(`begin;
        set local role authenticated;
        select set_config('request.jwt.claims', '${claims}', true);
        update public.lessons set module_id = '${moved.module_id}',
          sort_order = ${moved.sort_order}
        where id = '${moved.id}';
      commit;`);
      // หลังคืนค่า: ตัวนับกลับมาเต็ม — progress ยังอยู่ (ลบใน finally ท้ายสุด)
      const restored = (await progressRows(staff!.accessToken)).find(
        (r) => r["user_id"] === learner!.id,
      );
      expect(Number(restored?.["lesson_total"])).toBe(lessons.length);
      expect(Number(restored?.["lesson_completed"])).toBe(lessons.length);
    } catch (err) {
      restoreError = err;
    } finally {
      // gate r3 MINOR: คืนบทเรียนที่ seed "เสมอ" — แม้ assertion กลางทางพัง ไม่งั้น
      // บทเรียนค้างอยู่ LTC-101 โดย afterAll (ตรวจแค่ course status) ไม่เห็น ·
      // UPDATE นี้ idempotent: ถ้า try คืนค่าสำเร็จแล้ว = เขียนค่าเดิมซ้ำ (no-op) ·
      // ถ้า psql ย้ายต้นทางล้ม = TX กลิ้งกลับ = ก็เป็น no-op เช่นกัน
      try {
        await psql(`begin;
          set local role authenticated;
          select set_config('request.jwt.claims', '${claims}', true);
          update public.lessons set module_id = '${moved.module_id}',
            sort_order = ${moved.sort_order}
          where id = '${moved.id}';
        commit;`);
        // คืนค่าแบบ "ตรวจแล้ว" ตามแบบแผน afterAll — ไม่ตรง = seed รั่ว ต้อง fail ดัง
        const back = await psqlRows<{ module_id: string; sort_order: number }>(
          `select module_id::text, sort_order from public.lessons where id = '${moved.id}';`,
        );
        if (
          back.length !== 1 ||
          back[0]!.module_id !== moved.module_id ||
          Number(back[0]!.sort_order) !== moved.sort_order
        ) {
          throw new Error(
            `seed lesson ${moved.id} not restored: got ${JSON.stringify(back)}`,
          );
        }
      } catch (err) {
        restoreError = err;
      }
      // เก็บกวาดผลการเรียนที่ seed เอง — ต้องรันแม้การคืนบทเรียนล้ม (deleteTestUser
      // จะเก็บตาม enrollment อยู่แล้ว แต่ทำที่นี่เพื่อให้ state สะอาดแม้ beforeAll
      // ของ suite ถัดไปชนจังหวะเดียวกัน)
      await psql(
        `delete from public.lesson_progress where enrollment_id = '${enrollmentId}';`,
      );
      // assertion ที่พังไว้ก่อนหน้า (หรือ error การคืนค่า) ต้องไม่หายไปเงียบ ๆ
      if (restoreError !== null) {
        throw restoreError;
      }
    }
  });
});
