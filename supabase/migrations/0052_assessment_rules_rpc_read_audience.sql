-- 0052 — gate GP3 r3 R3-M2: ปรับ audience ของ RPC admin_latest_assessment_rules
-- (0051) ให้ mirror สายตา RLS ar_read (0010 L692-L702) จริง
--
-- ปัญหา: guard ของ 0051 รับเฉพาะ staff:exam/staff:viewer/super_admin แคบกว่า
-- audience จริงของ GET/POST /admin/assessments (permission assessment:view =
-- instructor/staff:viewer/staff:exam/staff:registrar/super_admin + RLS asm_read)
-- ผลคือ (1) instructor POST สร้าง draft ของหลักสูตรตัวเอง → INSERT สำเร็จ → reload
-- ยิง RPC → guard ปฏิเสธ instructor = 503 หลัง commit สำเร็จ (เดิมตอบ 201) และ
-- (2) GET ที่ instructor/staff:registrar เห็นแถว (asm_read) → RPC ปฏิเสธทั้งหน้า = 503
--
-- แก้ที่ migration ใหม่ (ไม่แก้ 0051 ที่ apply ไปแล้ว — แบบแผน forward-migration
-- ตาม Wave E 1.3.4 BLOCKER-3): create or replace ได้เพราะ signature + return type
-- เดิมเป๊ะ (pass_pct smallint ตาม 0051 ฉบับสุดท้าย)
--
-- audience ใหม่ = 2 สายแรกของ ar_read เท่านั้น (สาย admin-read):
-- - has_any_role('staff:viewer','staff:exam','staff:registrar','super_admin') = เห็นเต็ม
-- - instructor = เห็นเฉพาะ assessment ของหลักสูตรที่ตนเป็นเจ้าของ (c.created_by =
--   auth.uid()) — เป็น "row filter" ไม่ใช่ guard เพราะ BFF GET ส่ง id ทุกแถวที่
--   asm_read ให้เห็นมารวมกัน (instructor ที่ลงทะเรียนหลักสูตร published ของคนอื่น
--   เห็นแถว assessment นั้นด้วยสายผู้เรียน) — ถ้า guard raise เมื่อเจอ id นอก
--   ความเป็นเจ้าของ หน้ารายการทั้งหน้าจะ 503 เหมือนบั๊กเดิม จึงกรองเป็นแถวแทน:
--   id ตัวนั้นไม่คืนกติกา (BFF rules:null) ตามสิทธิ์จริง
-- - สายที่สามของ ar_read (ผู้เรียน enrolled-active ของหลักสูตร published) ถูกตัด
--   ออกโดยเจตนา: RPC นี้คือเส้นทางอ่านของหลังบ้าน (คืน selection ที่ 0051 revoke
--   จาก authenticated) — ผู้เรียนอ่านกติกาผ่าน GET /assessments/{id} ที่คอลัมน์
--   จำกัดตาม DD เท่านั้น ไม่ผ่าน RPC นี้
-- - ผู้ไม่มีบทบาทสาย admin-read เลย (citizen/lawyer/staff:content) → RBAC-001
--   errcode 42501 ที่ guard (เหมือนเดิม — ไม่มีเส้นทาง BFF ที่ถึง RPC นี้อยู่แล้ว)
--
-- เกณฑ์ "ล่าสุด" คงเดิม: distinct on (assessment_id) order by version desc
-- (เกณฑ์เดียวกับ max+1 ของ RPC 0049 — 0051)
create or replace function public.admin_latest_assessment_rules(
  p_assessment_ids uuid[]
) returns table (
  assessment_id uuid,
  version int,
  -- pass_pct = smallint ตามคอลัมน์จริง (0005) — return query บังคับชนิดตรงเป๊ะ (0051)
  pass_pct smallint,
  time_limit_minutes int,
  question_count int,
  max_attempts int,
  attempt_cooldown_minutes int,
  shuffle_questions boolean,
  shuffle_options boolean,
  require_course_complete boolean,
  selection jsonb,
  proctoring_mode public.proctoring_mode,
  exam_review_mode public.exam_review_mode,
  effective_from timestamptz
)
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_staff_full boolean;
  v_instructor boolean;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|auth_required)'
      using errcode = '42501';
  end if;
  -- aal2 ตามแบบแผน staff RPC 0047/0049/0051 — BFF (requirePermission) บังคับอยู่แล้ว
  -- ชั้นนี้คือ defense in depth ปิดทางยิง PostgREST ตรงด้วย JWT aal1
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- audience สาย admin-read = 2 สายแรกของ ar_read (0010): staff เต็ม + instructor
  -- (ส่วนกรองระดับแถวของ instructor อยู่ที่ return query ด้านล่าง — ดูหัวไฟล์)
  v_staff_full := public.has_any_role(
    array['staff:viewer','staff:exam','staff:registrar','super_admin']
  );
  v_instructor := public.has_any_role(array['instructor']);
  if not v_staff_full and not v_instructor then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|rules_read_forbidden)'
      using errcode = '42501';
  end if;
  return query
    select distinct on (ar.assessment_id)
      ar.assessment_id, ar.version, ar.pass_pct, ar.time_limit_minutes,
      ar.question_count, ar.max_attempts, ar.attempt_cooldown_minutes,
      ar.shuffle_questions, ar.shuffle_options, ar.require_course_complete,
      ar.selection, ar.proctoring_mode, ar.exam_review_mode, ar.effective_from
    from public.assessment_rules ar
    where ar.assessment_id = any (coalesce(p_assessment_ids, '{}'::uuid[]))
      and (
        v_staff_full
        or exists (select 1 from public.assessments a
                   join public.courses c on c.id = a.course_id
                   where a.id = ar.assessment_id
                     and c.created_by = v_actor)
      )
    order by ar.assessment_id, ar.version desc;
end;
$fn$;

-- create or replace ไม่แตะ ownership/ACL ของฟังก์ชันเดิม แต่ยืนยันซ้ำให้ migration
-- ยืนเองได้ (pattern 0051): owner app_owner + ปิด public/anon + เปิด authenticated
alter function public.admin_latest_assessment_rules(uuid[]) owner to app_owner;
revoke execute on function public.admin_latest_assessment_rules(uuid[]) from public, anon;
grant execute on function public.admin_latest_assessment_rules(uuid[]) to authenticated;
