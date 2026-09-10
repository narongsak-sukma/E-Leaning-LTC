-- ═══ 0018 · gate cleanup r2 MINOR — v_enrollment_progress: ตัวนับ completed ผูกขอบเขตหลักสูตร ═══
-- ที่มา: codex gate r2 — subquery ของ lesson_completed (0016) นับ lesson_progress ทุกแถว
-- ของ enrollment นั้นโดยไม่ผูก `m.course_id = e.course_id` (ตัวนับ total มี) → บทเรียนที่
-- ถูกย้ายข้ามหลักสูตร (lessons_update 0010:355 อนุญาต staff:content ย้าย module ต่าง
-- หลักสูตรได้ — WITH CHECK ตรวจเฉพาะหลักสูตรปลายทาง) จะถูกนับเป็น "เสร็จ" ในหลักสูตร
-- เดิมทั้งที่ไม่อยู่ในตัวส่วนอีกแล้ว → lesson_completed > lesson_total → pct > 100
--
-- แก่น: เติม `and m.course_id = e.course_id` ใน subquery ของ completed ให้เป็นขอบเขต
-- เดียวกับ total — invariant completed ⊆ total กลับมาครบทุกกรณี (ไม่ใช่แค่กรณี
-- soft-delete ที่ 0016 ครอบแล้ว) · create or replace คอลัมน์ชุดเดิม · grant เดิมของ
-- 0009/0016 (select to authenticated) คงอยู่อัตโนมัติ

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
    end as progress_pct
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
         and m.course_id = e.course_id
         and l.deleted_at is null and m.deleted_at is null) as lesson_completed
    from public.enrollments e
    join public.courses c on c.id = e.course_id and c.deleted_at is null
  ) s
  where public.has_any_role(array['staff:viewer','super_admin']);
