-- ═══ 0016 · PB-11 — v_enrollment_progress กรอง course/lesson ที่ถูก soft-delete ═══
-- ที่มา: worker PB-7 flag — view (0009_views.sql L169-193) เลือกจาก enrollments ตรง ๆ
-- ไม่ join courses เลย → enrollment ของหลักสูตรที่ถูกลบล้าง (deleted_at ไม่ null) ยังโผล่
-- ในรายงานความคืบหน้าของ staff:viewer/super_admin — ขัดหลักเดียวกับที่ PB-7 แก้ฝั่ง
-- me/enrollments ของผู้เรียน · พร้อมกันนั้น align ตัวนับ lesson_completed กับ lesson_total:
-- เดิม total กรอง module/lesson ที่ถูกลบ แต่ completed นับทุก lesson_progress →
-- ลบ lesson หลังมีผู้ทำเสร็จแล้วทำ pct เกิน 100 ได้ (ตัวส่วนลด ตัวตั้งไม่ลด)
--
-- create or replace (คอลัมน์ชุดเดิมทุกตัว — เปลี่ยนเฉพาะการกรองแถว) · grant เดิมของ
-- 0009 (select to authenticated) คงอยู่อัตโนมัติ · security_invoker=false (definer) ตาม
-- convention ของ 0009 — การ join courses เพิ่มไม่เปิดช่องรั่วเพราะ view คืนแถวเฉพาะ
-- เมื่อ has_any_role(staff:viewer|super_admin) อยู่แล้ว

create or replace view public.v_enrollment_progress
  with (security_invoker = false) as
  select
    s.enrollment_id,
    s.user_id,
    s.course_id,
    s.lesson_total,
    s.lesson_completed,
    case when s.lesson_total = 0 then 0
         else round(100.0 * s.lesson_completed / s.lesson_total)::int
    end as progress_pct -- pct ความคืบหน้า 0-100 (สูตรเดิม — completed ⊆ total เสมอหลัง align)
  from (
    select
      e.id as enrollment_id,
      e.user_id,
      e.course_id,
      (select count(*)
       from public.course_modules m
       join public.lessons l on l.module_id = m.id
       where m.course_id = e.course_id
         and m.deleted_at is null and l.deleted_at is null) as lesson_total,
      (select count(*)
       from public.lesson_progress lp
       join public.lessons l on l.id = lp.lesson_id
       join public.course_modules m on m.id = l.module_id
       where lp.enrollment_id = e.id
         and lp.status = 'completed'
         and l.deleted_at is null and m.deleted_at is null) as lesson_completed
    from public.enrollments e
    -- PB-11: หลักสูตรที่ถูกลบล้างไม่นับในรายงานความคืบหน้าปัจจุบัน (inner join —
    -- ข้อมูลอดีตถ้าต้องการให้ query ตารางฐานโดยตรง)
    join public.courses c on c.id = e.course_id and c.deleted_at is null
  ) s
  where public.has_any_role(array['staff:viewer','super_admin']);
