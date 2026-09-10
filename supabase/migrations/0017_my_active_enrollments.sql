-- ═══ 0017 · gate-cleanup r1 M2+M3 — my_active_enrollments() สำหรับ GET /api/v1/me/enrollments ═══
-- ที่มา: PB-7 เดิมกรองหลักสูตรที่ถูกลบล้างด้วย `courses!inner` embed + `.eq("courses.deleted_at",
-- null)` ซึ่งผิด 2 ชั้น (codex gate cleanup r1):
--   M2: supabase-js `.eq(col, null)` ทำเป็น `courses.deleted_at=eq.null` ซึ่ง PostgREST ตีความ
--       เป็น string "null" ไม่ใช่ SQL NULL — ต้องใช้ `.is()` ต่างหาก
--   M3: แม้ใช้ `.is()` ก็ยังผิดแนวคิด — embedded `courses!inner` ทำให้แถว enrollments ตก
--       ไปอยู่ใต้ RLS ของตาราง courses (courses_public_read = เห็นเฉพาะ published) → หลักสูตร
--       ที่ถูก archive/pending หลังผู้เรียนลงทะเบียนแล้ว จะลบประวัติการเรียนของผู้เรียนทิ้ง
--       เกินขอบเขต soft-delete ที่ PB-7 ตั้งใจ
-- ทางออก: SECURITY DEFINER RPC ตรวจเงื่อนไขเดียวที่ตั้งใจจริง = "หลักสูตรยังไม่ถูกลบล้าง"
-- (c.deleted_at is null) โดยไม่แตะ visibility ของ courses เลย — เจ้าของแถวคือผู้เรียน
-- เอง (e.user_id = auth.uid()) จึงไม่เปิดทางอ่านข้อมูลผู้อื่น (SECDEFINER อ่านในนาม
-- app_owner แต่ where รัดด้วย auth.uid() เสมอ)
--
-- รูปแบบตาม convention ของ 0011: search_path ตายตัว + revoke PUBLIC/anon ก่อน grant +
-- owner app_owner · PostgREST เรียกได้พร้อม ?select= / order / limit (STABLE read-only)

create or replace function public.my_active_enrollments()
returns setof public.enrollments
language sql
security definer
set search_path = public
stable
as $fn$
  select e.*
  from public.enrollments e
  join public.courses c on c.id = e.course_id and c.deleted_at is null
  where e.user_id = auth.uid()
$fn$;

-- EXECUTE contract (PG15 default ให้ PUBLIC — revoke ก่อน grant ตาม D16-N1)
revoke execute on function public.my_active_enrollments() from public, anon;
grant execute on function public.my_active_enrollments() to authenticated;
alter function public.my_active_enrollments() owner to app_owner;
