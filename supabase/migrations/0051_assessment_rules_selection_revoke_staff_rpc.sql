-- 0051 — ปิดช่องผู้เรียนอ่าน selection ทางตรง PostgREST + เปิดทางอ่านฝั่งเจ้าหน้าที่ผ่าน RPC (gate GP3 r2 R2-M3)
-- ═══════════════════════════════════════════════════════════════════════════════
-- เหตุผล: 0050 ให้ grant select(selection) แก่ role authenticated เพื่อให้ embed ของ
-- GET /api/v1/admin/assessments อ่านคอลัมน์นี้ได้ — แต่ role authenticated คือ role เดียว
-- ของทุก JWT ที่ login แล้ว (เจ้าหน้าที่และผู้เรียนเหมือนกัน) และนโยบายแถว ar_read
-- (0010 L694-L702) ยอมให้ "ผู้เรียนที่ลงทะเรียน active ของหลักสูตรที่ assessment published"
-- เห็นแถว assessment_rules ด้วย → ผู้เรียนยิงตรง /rest/v1/assessment_rules?select=selection
-- ด้วย JWT ของตัวเองอ่านขอบเขตคลังข้อสอบได้เงียบ ๆ (gate r2 ข้อ 5) — column grant แยก
-- เจ้าหน้าที่/ผู้เรียนไม่ได้เพราะทั้งคู่คือ role เดียวกัน
--
-- ทางแก้: ถอน column grant ของ 0050 คืนของเดิม (selection กลับเป็นคอลัมน์ที่ซ่อนตามเจตนา
-- ของ 0005) แล้วย้ายเส้นทางอ่านของเจ้าหน้าที่ไปที่ RPC นี้ที่คุมบทบาทในตัว
-- (security definer + has_any_role ก่อนคืนแถว) — BFF embed เรียกด้วย JWT เจ้าหน้าที่เหมือนเดิม
--
-- ขอบเขตบทบาท = ชุดเดียวกับ GET /admin/assessments (API-SPEC §3.8 แถว 224):
-- staff:exam · staff:viewer · super_admin (instructor ไม่อยู่ในหน้านี้ — RLS เดิมพอ)
--
-- สัญญา "ล่าสุด" = version สูงสุดต่อ assessment (distinct on ... order by version desc)
-- เกณฑ์เดียวกับ embed เดิม (M4) และฐาน max+1 ของ admin_add_assessment_rules (0049)
-- ห้ามกรอง effective_from เพิ่ม — แถวย้อนหลัง/effective_from เท่ากันต้องไม่หมุนแถวที่ตอบ

revoke select (selection) on public.assessment_rules from authenticated;

-- ─── RPC อ่านกติกา version ล่าสุด (พร้อม selection) ให้เจ้าหน้าที่ ───
-- ลอกโครง guard ของ 0049 admin_add_assessment_rules: AUTH-001 → AUTH-004 (aal2) →
-- RBAC-001 (errcode 42501 ตามแบบแผน) · คืนแถวยอดต่อ assessment เรียงไม่จำเป็น —
-- BFF merge ด้วย assessment_id · p_assessment_ids ว่าง = ไม่คืนแถว (BFF ไม่เรียกเมื่อหน้าว่าง)
--
-- drop ก่อน create เพราะฉบับแรกของ migration นี้ (ยังไม่ merge ไปไหน — dev DB ของ
-- ทีมเท่านั้น) ประกาศ pass_pct เป็น int จน return query ชน "Returned type smallint
-- does not match" — คอลัมน์จริงคือ smallint (0005) · create or replace เปลี่ยน
-- return type ไม่ได้จึงต้อง drop ทิ้งแล้วสร้างใหม่ให้ migration runnable ซ้ำได้
drop function if exists public.admin_latest_assessment_rules(uuid[]);
create or replace function public.admin_latest_assessment_rules(
  p_assessment_ids uuid[]
) returns table (
  assessment_id uuid,
  version int,
  -- pass_pct = smallint ตามคอลัมน์จริง (0005) — return query บังคับชนิดตรงเป๊ะ
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
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|auth_required)'
      using errcode = '42501';
  end if;
  -- aal2 ตามแบบแผน staff RPC 0047/0049 — BFF (requirePermission) บังคับอยู่แล้ว ชั้นนี้คือ
  -- defense in depth ปิดทางยิง PostgREST ตรงด้วย JWT aal1
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- ชุดบทบาทของ GET /admin/assessments — ผู้เรียน/instructor ไม่ผ่านชั้นนี้
  if not public.has_any_role(array['staff:exam','staff:viewer','super_admin']) then
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
    order by ar.assessment_id, ar.version desc;
end;
$fn$;

alter function public.admin_latest_assessment_rules(uuid[]) owner to app_owner;
revoke execute on function public.admin_latest_assessment_rules(uuid[]) from public, anon;
grant execute on function public.admin_latest_assessment_rules(uuid[]) to authenticated;
