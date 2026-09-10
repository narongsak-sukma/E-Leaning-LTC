-- 0013_lesson_parent_softdelete_guard.sql — gate r3 MAJOR-1
-- lessons_read (0010) เดิมไม่กรอง soft-delete ของ parent: ผู้เรียนที่ enrollment ยัง active
-- อ่าน lesson ของโมดูล/หลักสูตรที่ถูก soft-delete ต่อได้ (แล้ว route เข้า service path อ่านโจทย์แทน)
-- แก้ที่ชั้น policy ให้ครบทุกผู้อ่าน (route-level .is(deleted_at) ของ lessons เป็น defense-in-depth ซ้ำ)
-- หมายเหตุ: โมดูล/หลักสูตรที่ soft-delete = มองไม่เห็นใน learner path ทั้งหมด รวม created_by/staff
-- (การกู้คืนทำผ่าน UPDATE คืน deleted_at = null เท่านั้น — สอดคล้อง "soft-delete แล้วหายจากผู้ใช้")

drop policy lessons_read on public.lessons;

create policy lessons_read on public.lessons for select to authenticated
  using (
    exists (
      select 1 from public.course_modules m
      join public.courses c on c.id = m.course_id
      where m.id = lessons.module_id
        and m.deleted_at is null
        and c.deleted_at is null
        and ((c.status = 'published'
              and (c.is_public or public.has_any_role(array['lawyer'])))
             or c.created_by = auth.uid()
             or public.has_any_role(array['staff:viewer','staff:content','super_admin']))
        and (lessons.is_preview
             or exists (select 1 from public.enrollments e
                        where e.course_id = c.id and e.user_id = auth.uid()
                          and e.status = 'active')
             or c.created_by = auth.uid()
             or public.is_staff())
    )
  );
