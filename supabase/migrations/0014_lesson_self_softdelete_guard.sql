-- 0014_lesson_self_softdelete_guard.sql — gate r5 MAJOR-2
-- lessons_read (0013) กรอง soft-delete ของ parent (course_modules/courses) แต่ยังไม่กรอง
-- lessons.deleted_at ของตัวแถวเอง — ผู้เรียนที่ enrollment active ยัง SELECT บทเรียน
-- ที่ถูก soft-delete ผ่าน PostgREST ตรง ๆ ได้เมื่อ parent ยังมีชีวิต
-- (route-level .is("deleted_at", null) ของ r2 ครอเฉพาะ service path — ไม่ใช่ชั้น RLS)
--
-- สิทธิ์กู้คืนของเจ้าหน้าที่: คงเดิมตาม 0010 — staff:content/super_admin แก้ไขแถวผ่าน
-- lessons_update ได้โดยไม่ต้องเห็นแถวใน SELECT (restore = UPDATE คืน deleted_at = null
-- ตาม id) หาก UI หลังบ้านของ Wave D (authoring) ต้อง "มองเห็นแถวที่ลบแล้ว" จะสร้าง
-- policy แยกของ staff ตอนนั้น — ไม่ผ่อน policy นี้ให้ผู้เรียนเห็นแถวที่ลบแล้ว

drop policy lessons_read on public.lessons;

create policy lessons_read on public.lessons for select to authenticated
  using (
    lessons.deleted_at is null
    and exists (
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
