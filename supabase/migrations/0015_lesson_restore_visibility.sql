-- 0015_lesson_restore_visibility.sql — gate r6 MINOR-1 (แก้ความเข้าใจผิดใน header ของ 0014)
-- 0014 เขียนไว้ว่า "staff:content/super_admin กู้คืน lesson ที่ soft-delete ผ่าน
-- lessons_update ได้โดยไม่ต้องเห็นแถวใน SELECT" — **พิสูจน์แล้วเป็นเท็จ** (การทดลอง
-- บน cluster จริง + EXPLAIN): PostgreSQL นำ USING ของ policy SELECT (lessons_read)
-- มาใช้กับ UPDATE ด้วย ทั้ง (1) เป็น filter ตอนสแกนแถวเป้าหมาย และ (2) เป็น
-- with-check ของแถวใหม่ — ทำให้หลัง 0014:
--   · แถวที่ deleted_at ไม่ null → UPDATE ไม่เห็นแถวเลย (UPDATE 0 / PostgREST ตอบ
--     204 เงียบ ๆ ทั้งที่ไม่ได้แก้อะไร = จุดรั่วแบบ "คิดว่าสำเร็จ")
--   · แถวปกติ → SET deleted_at = now() โดน with-check 42501 (new row violates)
--   · เจ้าหน้าที่/เจ้าของคอร์สจึง soft-delete หรือกู้คืน lesson ผ่าน API ไม่ได้เลย
--
-- หลักที่แก้: **ความมองเห็น (SELECT) ต้องครอบคลุมสิทธิ์แก้ไข (UPDATE)** — ใคร
-- update ได้ตาม lessons_update (0010) ต้องมองเห็นแถว (รวมแถวที่ soft-delete แล้ว)
-- เพื่อส่งผ่านสถานะ deleted_at ทั้งสองทิศได้:
--   · staff:content / super_admin — บริหารเนื้อหาเต็มรูปแบบ
--   · instructor เจ้าของคอร์ส (courses.created_by = auth.uid()) — ยังคงแก้ไข/
--     กู้คืนบทเรียนของตนได้ตามเจตนาของ 0010
-- ผู้เรียนไม่ได้รับสิทธิ์เพิ่ม: สาขาของผู้เรียนยังอยู่ในเงื่อนไข deleted_at is null
-- เดิมทุกประการ (แถวที่ลบแล้วมองไม่เห็นเสมอ)

drop policy lessons_read on public.lessons;

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
                            and e.status = 'active')
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
