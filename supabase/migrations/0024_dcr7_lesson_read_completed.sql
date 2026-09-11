-- ═══ 0024 — DCR-7 / D39 (Wave E): ผู้เรียน completed ยังอ่านบทเรียนได้ ═══
-- ทำไม: cm_read/lessons_read (0010) ผูก enrollment ที่ e.status='active' เท่านั้น —
-- ผู้เรียนจบหลักสูตร (completed) เสียสิทธิ์อ่านบทเรียนทบทวนทันที · D55-4: ยอม
-- in ('active','completed') + **uq_enrollments คงเดิม** (lifecycle เส้นเดียว
-- active→completed · ไม่มี FR re-enroll · cert partial-unique WHERE status='valid'
-- สอดคล้องอยู่แล้ว — ไม่แตะ 0004:179)
-- ฐานตั้งต้น: cm_read = รุ่น 0010 (ไม่เคยถูกแทนที่) · lessons_read = รุ่น 0015
-- (สุดท้าย — สาขาผู้เรียนเห็นเฉพาะแถวมีชีวิตในโซ่มีชีวิต 0013/0014 + สาขาผู้บริหาร
-- เนื้อหาเห็นทุกสถานะเพื่อกู้คืนได้ — ห้ามทับกลับไปรุ่น 0010)
-- policy เป็น object ต่อตาราง — แก้ USING ต้อง drop+create ใน TX เดียวกัน
-- (atomic: ช่วงที่ policy ไม่มีไม่หลุดออกนอก TX ของ migration)

-- ─── cm_read: enrollment active หรือ completed (ส่วนอื่นคงเดิมทุกไบต์) ───
drop policy if exists cm_read on public.course_modules;
create policy cm_read on public.course_modules for select to authenticated
  using (
    exists (select 1 from public.courses c where c.id = course_modules.course_id
            and (c.status = 'published'
                 and (c.is_public or public.has_any_role(array['lawyer']))
                 or c.created_by = auth.uid()
                 or public.has_any_role(array['staff:viewer','staff:content','super_admin'])))
    and (course_modules.is_preview
         or exists (select 1 from public.enrollments e
                    where e.course_id = course_modules.course_id
                      and e.user_id = auth.uid()
                      and e.status in ('active','completed')) -- DCR-7/D39
         or exists (select 1 from public.courses c2
                    where c2.id = course_modules.course_id and c2.created_by = auth.uid())
         or public.is_staff())
  );

-- ─── lessons_read: ฐาน 0015 + เงื่อนไข enrollment เดียวกัน (จุดเดียวที่แก้) ───
drop policy if exists lessons_read on public.lessons;
create policy lessons_read on public.lessons for select to authenticated
  using (
    -- สาขาผู้เรียน/ผู้ชม: เห็นเฉพาะแถวที่ยังมีชีวิต (0014) ในโซ่ที่ยังมีชีวิต (0013)
    (
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
                            and e.status in ('active','completed')) -- DCR-7/D39
               or c.created_by = auth.uid()
               or public.is_staff())
      )
    )
    -- สาขาผู้บริหารเนื้อหา: มองเห็นทุกสถานะ (รวม soft-delete) เพื่อกู้คืนได้จริง —
    -- กระจกสิทธิ์ UPDATE ของ lessons_update (0010)
    or (
      public.has_any_role(array['staff:content','super_admin'])
      or exists (
        select 1 from public.course_modules m2
        join public.courses c2 on c2.id = m2.course_id
        where m2.id = lessons.module_id
          and c2.created_by = auth.uid()
          and public.has_any_role(array['instructor'])
      )
    )
  );
