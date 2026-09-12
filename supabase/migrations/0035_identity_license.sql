-- ═══ 0035_identity_license — Wave E Phase 5 (IDENT/license + ADM-005 · DCR-11) ═══
-- แผน .omc/plans/wave-e-p5-plan.md (D-p5-2/3/5/6/11/12) · doc-first: API-SPEC 1.2.0 ·
-- DD 1.3.0 · AUDIT-LOG-DESIGN 1.0.4 · RTM 1.1.0
--
-- หลักการเดียวกับ 0032 (atomic RPC ฉบับ gate-approved):
--   1. **mutation+audit atomic** — ทุก RPC ใหม่เขียน audit ผ่าน append_audit_event_internal
--      ใน TX เดียวกับ mutation (AUDIT §1.5 class ก — audit ล้ม = rollback ทั้งรายการ)
--   2. **ตัด write ตรงจากบทบาทเดิม** — INSERT license_applications (authenticated) ·
--      UPDATE license_applications / INSERT lawyer_licenses / INSERT+UPDATE
--      role_assignments / UPDATE courses (service_role) ถูก REVOKE — path เดียว = RPC
--      ของไฟล์นี้ (RLS เดิมเหลือเป็น defense-in-depth ของอดีต ตามแบบแผน 0032 §5)
--   3. **roles + aal2 ตรวจในตัวทุก RPC ฝั่ง admin** (แบบแผน 0032 B3 — ปิดช่อง JWT aal1
--      เรียก PostgREST ตรงข้าม MFA gate ของ BFF)
--
-- allowlist ของ wrapper append_audit_event **ไม่แตะ** (ต่างจากที่แผนเดิมคาด): event ใหม่
-- ทั้งหมด (LICENSE_BIND/LICENSE_VERIFY/ROLE_GRANT/ROLE_REVOKE/COURSE_*) เป็น class ก
-- ที่เขียนเฉพาะใน TX ของ RPC ตัวเอง — ไม่มี path best-effort ให้ปิดอยู่แล้ว
--
-- notification (D-p5-12): templates 6 คีย์ + families ใหม่ 'license'/'account' +
-- dispatch_tick ขยาย topic (สำเนาเต็มของ 0034 ฉบับเดิม + เพิ่ม 3 topic additive —
-- โครง/เฟส/backoff/dedupe คงเดิมทุกบรรทัด) · account.delete.confirm/account.deleted
-- = อีเมลธุรกรรมบังคับ (NTF-005) ไม่ผ่าน tick — BFF แทรก email_outbox ตรง (จุด
-- consent-gate อยู่ที่ tick เท่านั้น แถวตรงจึงข้าม settings ได้โดยการออกแบบ)
--
-- idempotent ทั้งไฟล์ (create or replace · drop-if-exists policy · on conflict do nothing)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── (1) enum: course_status += 'returned' (ADM-005 — ส่งกลับให้แก้พร้อมความเห็น) ───
-- literal 'returned' ปรากฏเฉพาะใน body ของ RPC (สตริง — ไม่ถูก evaluate ตอนสร้าง)
-- จึงไม่ชนกฎ "unsafe use of new value" ใน TX เดียวกับ ADD VALUE
alter type public.course_status add value if not exists 'returned';

-- ─── (2) bucket license-evidence (ส่วนตัว) + media_read สาขาใหม่ + storage มิเรอร์ ───
-- หลักฐานใบอนุญาตอ่านได้: เจ้าของคำขอ (ผ่าน license_applications.evidence_media_id)
-- หรือ staff:registrar/super_admin (ผู้ตัดสิน — DD §3.1 license_applications SELECT)
-- สอดคล้อง media_read ของ certificates (0019): แหล่งความจริง = media_assets แถวเดียว
drop policy if exists media_read on public.media_assets;
create policy media_read on public.media_assets for select to authenticated
  using (
    -- 0019-r1 (B1): instructor/is_staff อ่านได้เฉพาะสื่อ bucket 'media' (วิดีโอ/เอกสารบทเรียน)
    -- — ห้ามแผ่ครอบ bucket 'certificates' (PDF ใบประกาศนียบัตรมีชื่อเจ้าของใบ = PII:
    -- เจ้าของใบเท่านั้นที่อ่านได้ผ่านสาขาด้านล่าง ไม่ใช่ instructor/staff ทุกคน)
    (media_assets.bucket = 'media'
     and (public.has_any_role(array['instructor']) or public.is_staff()))
    -- PB-14a: เจ้าของประกาศนียบัตรอ่าน media ของใบตัวเอง (D-2 pdf route step 5;
    -- certs_owner_read 0010:781 ให้เจ้าของเห็นแถวใบอยู่แล้ว)
    or exists (select 1 from public.certificates c
               where c.pdf_media_id = media_assets.id
                 and c.user_id = auth.uid())
    -- PB-14b: ผู้เรียนที่ลงทะเบียน (active/completed) อ่าน media ของบทเรียนใน
    -- หลักสูตรนั้น (D-0 resolveLessonMediaUrl — video บทเรียน)
    -- 0019-r2 (F1): จำกัด bucket 'media' — สาขานี้พิสูจน์ความสัมพันธ์ผ่าน
    -- lessons.media_id เท่านั้น ถ้าไม่กัก bucket ผู้แต่งหลักสูตรชี้ media_id
    -- ไปที่ PDF ใบประกาศ (bucket certificates) แล้วผู้เรียนรายอื่นอ่านได้
    or exists (select 1
               from public.lessons l
               join public.course_modules m on m.id = l.module_id
               join public.enrollments e on e.course_id = m.course_id
               where l.media_id = media_assets.id
                 and media_assets.bucket = 'media'
                 and l.deleted_at is null
                 and m.deleted_at is null
                 and e.deleted_at is null
                 and e.user_id = auth.uid()
                 and e.status in ('active','completed'))
    -- 0035 (D-p5-2): หลักฐานใบอนุญาต bucket 'license-evidence' — เจ้าของคำขอ
    -- (แถว license_applications อ้าง media นี้และเป็นของตน — ตารางนี้ไม่มี
    -- deleted_at ตาม DD §3.1 คำขอถูก soft-lock ด้วย status ไม่ใช่ soft-delete)
    -- หรือ staff:registrar/super_admin (ผู้ตรวจตัดสิน — DD §3.1)
    or (media_assets.bucket = 'license-evidence'
        and (
          exists (select 1 from public.license_applications la
                  where la.evidence_media_id = media_assets.id
                    and la.user_id = auth.uid())
          or public.has_any_role(array['staff:registrar', 'super_admin'])
        ))
  );

-- storage: bucket ใหม่ (private) + นโยบายเดิมสร้างใหม่พร้อมสาขา license-evidence
-- (มิเรอร์เงื่อนไข media_read แบบ inline — defense in depth ตามแบบแผน 0019)
-- vanilla postgres image ไม่มี storage schema → guard กัน migration พัง
do $storage$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice '0035: storage schema ไม่มี (vanilla image) — ข้าม bucket/นโยบาย storage';
    return;
  end if;
  insert into storage.buckets (id, name, public)
  values ('license-evidence','license-evidence',false)
  on conflict (id) do nothing;
  execute 'drop policy if exists objects_via_media_assets on storage.objects';
  execute $p$create policy objects_via_media_assets on storage.objects
    for select to authenticated
    using (exists (
      select 1 from public.media_assets ma
      where ma.bucket = storage.objects.bucket_id
        and ma.storage_path = storage.objects.name
        and (
          (ma.bucket = 'media'
           and (public.has_any_role(array['instructor']) or public.is_staff()))
          or exists (select 1 from public.certificates c
                     where c.pdf_media_id = ma.id
                       and c.user_id = auth.uid())
          or exists (select 1
                     from public.lessons l
                     join public.course_modules m on m.id = l.module_id
                     join public.enrollments e on e.course_id = m.course_id
                     where l.media_id = ma.id
                       and ma.bucket = 'media'
                       and l.deleted_at is null
                       and m.deleted_at is null
                       and e.deleted_at is null
                       and e.user_id = auth.uid()
                       and e.status in ('active','completed'))
          or (ma.bucket = 'license-evidence'
              and (
                exists (select 1 from public.license_applications la
                        where la.evidence_media_id = ma.id
                          and la.user_id = auth.uid())
                or public.has_any_role(array['staff:registrar', 'super_admin'])
              ))
        )
    ))$p$;
end;
$storage$;

-- ─── (3) guard กลาง: roles + aal2 (แบบ admin_credit_rule_staff_guard ของ 0032) ───
create or replace function public.admin_license_staff_guard()
returns uuid
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  if not public.has_any_role(array['staff:registrar', 'super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|license_forbidden)'
      using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;
alter function public.admin_license_staff_guard() owner to app_owner;
revoke execute on function public.admin_license_staff_guard() from public, anon, authenticated, service_role;

create or replace function public.admin_users_staff_guard()
returns uuid
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- user:view ตาม permission matrix (RBAC §2): sv/sr/sa เท่านั้น — ไม่ใช่ staff ทุกระดับ
  if not public.has_any_role(array['staff:viewer', 'staff:registrar', 'super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|user_view_forbidden)'
      using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;
alter function public.admin_users_staff_guard() owner to app_owner;
revoke execute on function public.admin_users_staff_guard() from public, anon, authenticated, service_role;

create or replace function public.admin_course_staff_guard()
returns uuid
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  if not public.has_any_role(array['staff:content', 'super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|course_publish_forbidden)'
      using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;
alter function public.admin_course_staff_guard() owner to app_owner;
revoke execute on function public.admin_course_staff_guard() from public, anon, authenticated, service_role;

-- ─── (4) my_submit_license_application — ยื่นคำขอ + audit atomic (D-p5-2) ───
-- BFF PUT /me/license: validate zod + upload ไฟล์ → media_assets (service) แล้วเรียก
-- ตัวนี้ด้วย user JWT — แถวคำขอ + audit LICENSE_BIND ใน TX เดียว (§1.5)
create or replace function public.my_submit_license_application(
  p_license_no text,
  p_evidence_media_id uuid,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  r record;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if p_license_no is null or p_license_no !~ '^[0-9]{6,9}$' then
    raise exception 'ข้อมูลไม่ถูกต้อง: เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก (ERR-VAL-001|license_no_format)'
      using errcode = '22023';
  end if;
  -- หลักฐานต้องเป็นแถว media ที่เจ้าของเพิ่งอัปโหลดเองใน bucket ของงานนี้และพร้อมใช้
  if not exists (
    select 1 from public.media_assets m
    where m.id = p_evidence_media_id
      and m.uploaded_by = v_uid
      and m.bucket = 'license-evidence'
      and m.status = 'ready'
      and m.deleted_at is null
  ) then
    raise exception 'ข้อมูลไม่ถูกต้อง: ไฟล์หลักฐานไม่พบหรือไม่ใช่ของท่าน (ERR-VAL-001|evidence_invalid)'
      using errcode = '22023';
  end if;
  -- กันยื่นซ้อน (uq เฉพาะ pending ของ 0003 เป็นชั้นที่สอง — เช็กก่อนเพื่อข้อความชัดเจน)
  if exists (select 1 from public.license_applications la
             where la.user_id = v_uid and la.status = 'pending') then
    raise exception 'ท่านมีคำขอที่รอตรวจอยู่แล้ว กรุณารอการตัดสินก่อน (ERR-VAL-001|pending_exists)'
      using errcode = '23505';
  end if;

  insert into public.license_applications (user_id, license_no, evidence_media_id)
  values (v_uid, p_license_no, p_evidence_media_id)
  returning id, user_id, license_no, status, evidence_media_id, submitted_at
  into r;

  -- audit atomic — license_hash เท่านั้น ห้ามเลขจริง (AUDIT §2.2 + BRIEF §8)
  perform public.append_audit_event_internal(
    'LICENSE_BIND', 'license_application', (r.id)::text, null, null,
    jsonb_build_object(
      'target_user_id', r.user_id,
      'license_hash', 'sha256:' || left(encode(sha256(convert_to(r.license_no, 'utf8')), 'hex'), 16),
      'status', 'pending'),
    null, null, p_request_id, v_uid);

  return to_jsonb(r);
end;
$fn$;
alter function public.my_submit_license_application(text, uuid, text) owner to app_owner;
revoke execute on function public.my_submit_license_application(text, uuid, text) from public, anon;
grant execute on function public.my_submit_license_application(text, uuid, text) to authenticated;

-- ─── (5) admin_decide_license_application — ตัดสิน+ใบ+บทบาท+audit+event ใน TX เดียว ───
create or replace function public.admin_decide_license_application(
  p_app_id uuid,
  p_action text,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid;
  v_app record;
  v_license_id uuid;
  v_role_inserted boolean := false;
begin
  v_actor := public.admin_license_staff_guard();
  if p_action not in ('approve', 'reject') then
    raise exception 'ข้อมูลไม่ถูกต้อง: action ต้องเป็น approve หรือ reject (ERR-VAL-001|action_value)'
      using errcode = '22023';
  end if;
  if p_action = 'reject'
     and (p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500) then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลปฏิเสธต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลยาวเกิน 500 อักขระ (ERR-VAL-001|reason_length)'
      using errcode = '22023';
  end if;

  -- lock แถว pending (แบบ FOR UPDATE ของ 0032 gate r2 MINOR-1 — ตัดสินสองคำขอพร้อมกัน
  -- ต้องเห็นค่าหลังคนแรก commit; แถวที่ตัดสินไปแล้ว = ไม่พบ)
  select * into v_app
  from public.license_applications
  where id = p_app_id and status = 'pending'
  for update;
  if not found then
    raise exception 'ไม่พบคำขอที่รอตรวจ (ERR-NF-001|application_not_found)'
      using errcode = 'P0002';
  end if;

  if p_action = 'reject' then
    update public.license_applications
       set status = 'rejected',
           rejected_reason = btrim(p_reason),
           decided_by = v_actor,
           decided_at = now()
     where id = p_app_id;

    perform public.append_audit_event_internal(
      'LICENSE_VERIFY', 'license_application', (p_app_id)::text, null, null,
      jsonb_build_object(
        'target_user_id', v_app.user_id,
        'result', 'rejected',
        'application_id', p_app_id),
      null, null, p_request_id, v_actor);

    insert into public.event_outbox (topic, payload)
    values ('license.application.rejected',
      jsonb_build_object(
        'user_id', v_app.user_id,
        'source_id', p_app_id,
        'application_id', p_app_id,
        'license_no', v_app.license_no,
        'reason', btrim(p_reason)));

    return jsonb_build_object('applicationId', p_app_id, 'result', 'rejected');
  end if;

  -- approve: ตรวจเลขใบซ้ำคนอื่นก่อน (uq_lawyer_licenses_license_no_active_license —
  -- เลขหนึ่งเลขผูกบัญชี active ได้เดียว · เจอ = ตั้งชื่อ constraint ให้ registrar ตัดสินเอง)
  if exists (
    select 1 from public.lawyer_licenses ll
    where ll.license_no = v_app.license_no
      and ll.revoked_at is null
      and ll.deleted_at is null
      and ll.user_id <> v_app.user_id
  ) then
    raise exception
      'เลขที่ใบอนุญาตนี้ถูกผูกกับบัญชีอื่นอยู่ (ข้อจำกัด uq_lawyer_licenses_license_no_active_license) — กรุณาตรวจสอบข้อมูลจริงก่อนตัดสิน (ERR-VAL-001|license_no_conflict)'
      using errcode = '23505';
  end if;

  insert into public.lawyer_licenses
    (user_id, license_no, status, evidence_media_id, verified_by, verified_at)
  values
    (v_app.user_id, v_app.license_no, 'verified', v_app.evidence_media_id, v_actor, now())
  returning id into v_license_id;

  update public.license_applications
     set status = 'approved',
         decided_by = v_actor,
         decided_at = now(),
         resulting_license_id = v_license_id
   where id = p_app_id;

  -- มอบบทบาท lawyer idempotent (NOT EXISTS — ซ้ำเพราะถืออยู่แล้ว = ไม่ insert ไม่ audit)
  if not exists (
    select 1 from public.role_assignments ra
    where ra.user_id = v_app.user_id and ra.role = 'lawyer' and ra.revoked_at is null
  ) then
    insert into public.role_assignments (user_id, role, granted_by, reason)
    values (v_app.user_id, 'lawyer', v_actor,
            'อนุมัติคำขอผูกเลขที่ใบอนุญาตอัตโนมัติ (IDENT-004)');
    v_role_inserted := true;
  end if;

  perform public.append_audit_event_internal(
    'LICENSE_VERIFY', 'license_application', (p_app_id)::text, null, null,
    jsonb_build_object(
      'target_user_id', v_app.user_id,
      'result', 'approved',
      'application_id', p_app_id,
      'resulting_license_id', v_license_id),
    null, null, p_request_id, v_actor);

  if v_role_inserted then
    perform public.append_audit_event_internal(
      'ROLE_GRANT', 'user', (v_app.user_id)::text, null, null,
      jsonb_build_object(
        'target_user_id', v_app.user_id,
        'role', 'lawyer',
        'reason', 'อนุมัติคำขอผูกเลขที่ใบอนุญาต (IDENT-004)',
        'sod_exception', false),
      null, null, p_request_id, v_actor);
  end if;

  insert into public.event_outbox (topic, payload)
  values ('license.application.approved',
    jsonb_build_object(
      'user_id', v_app.user_id,
      'source_id', p_app_id,
      'application_id', p_app_id,
      'license_no', v_app.license_no));

  return jsonb_build_object(
    'applicationId', p_app_id,
    'result', 'approved',
    'resultingLicenseId', v_license_id,
    'roleGranted', v_role_inserted);
end;
$fn$;
alter function public.admin_decide_license_application(uuid, text, text, text) owner to app_owner;
revoke execute on function public.admin_decide_license_application(uuid, text, text, text) from public, anon;
grant execute on function public.admin_decide_license_application(uuid, text, text, text) to authenticated;

-- ─── (6) admin_grant_role / admin_revoke_role (D-p5-5) ───
-- ชุดที่ยอม: lawyer/instructor/staff:viewer/staff:content/staff:exam/staff:registrar
--   · super_admin = super_admin เท่านั้น และ **ห้ามผ่าน endpoint** (bootstrap เท่านั้น)
--   · registrar = เฉพาะ lawyer และเป้าหมายต้องมีใบ verified อยู่จริง (BFF scope ซ้ำอีกชั้น)
--   · revoke ตัวเอง = ปฏิเสธ · ถอนจนเหลือ 0 บทบาท = ปฏิเสธ (บัญชีต้องมี role ≥1)
create or replace function public.admin_grant_role(
  p_user_id uuid,
  p_role text,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid;
begin
  v_actor := public.admin_license_staff_guard();
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if p_role not in ('lawyer','instructor','staff:viewer','staff:content','staff:exam','staff:registrar') then
    raise exception 'ข้อมูลไม่ถูกต้อง: มอบบทบาทนี้ผ่านระบบไม่ได้ (super_admin จัดที่ bootstrap เท่านั้น) (ERR-VAL-001|role_not_grantable)'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'ไม่พบผู้ใช้ (ERR-NF-001|user_not_found)' using errcode = 'P0002';
  end if;
  -- resource-scope ในตัว (BFF ตรวจอีกชั้น): registrar มอบได้เฉพาะ lawyer หลังยืนยันใบอนุญาต
  if not public.has_any_role(array['super_admin']) then
    if p_role <> 'lawyer' then
      raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: ผู้ตรวจทะเบียนมอบบทบาท lawyer ได้เท่านั้น (ERR-RBAC-001|role_scope)'
        using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.lawyer_licenses ll
      where ll.user_id = p_user_id
        and ll.status = 'verified'
        and ll.revoked_at is null
        and ll.deleted_at is null
    ) then
      raise exception 'ข้อมูลไม่ถูกต้อง: ผู้รับยังไม่มีใบอนุญาตที่ผ่านการยืนยัน (ERR-VAL-001|no_verified_license)'
        using errcode = '22023';
    end if;
  end if;
  -- idempotent: ถืออยู่แล้ว = จบเงียบ (ไม่มี mutation จึงไม่มี audit)
  if exists (select 1 from public.role_assignments ra
             where ra.user_id = p_user_id and ra.role = p_role and ra.revoked_at is null) then
    return jsonb_build_object('userId', p_user_id, 'role', p_role, 'granted', false);
  end if;

  insert into public.role_assignments (user_id, role, granted_by, reason)
  values (p_user_id, p_role, v_actor, btrim(p_reason));

  perform public.append_audit_event_internal(
    'ROLE_GRANT', 'user', (p_user_id)::text, null, null,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'role', p_role,
      'reason', btrim(p_reason),
      'sod_exception', false),
    null, null, p_request_id, v_actor);

  return jsonb_build_object('userId', p_user_id, 'role', p_role, 'granted', true);
end;
$fn$;
alter function public.admin_grant_role(uuid, text, text, text) owner to app_owner;
revoke execute on function public.admin_grant_role(uuid, text, text, text) from public, anon;
grant execute on function public.admin_grant_role(uuid, text, text, text) to authenticated;

create or replace function public.admin_revoke_role(
  p_user_id uuid,
  p_role text,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid;
begin
  v_actor := public.admin_license_staff_guard();
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if p_role = 'super_admin' then
    raise exception 'ข้อมูลไม่ถูกต้อง: บทบาทนี้จัดการที่ bootstrap เท่านั้น (ERR-VAL-001|role_not_manageable)'
      using errcode = '22023';
  end if;
  if p_user_id = v_actor then
    raise exception 'ข้อมูลไม่ถูกต้อง: ถอนบทบาทของตัวเองไม่ได้ (ERR-VAL-001|self_revoke)'
      using errcode = '22023';
  end if;
  -- resource-scope เดียวกับการมอบ: registrar ถอนได้เฉพาะ lawyer
  if not public.has_any_role(array['super_admin']) and p_role <> 'lawyer' then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: ผู้ตรวจทะเบียนถอนบทบาท lawyer ได้เท่านั้น (ERR-RBAC-001|role_scope)'
      using errcode = '42501';
  end if;

  update public.role_assignments
     set revoked_at = now(), reason = btrim(p_reason)
   where user_id = p_user_id
     and role = p_role
     and revoked_at is null;
  if not found then
    raise exception 'ไม่พบบทบาทที่ยังใช้งานอยู่ของผู้ใช้นี้ (ERR-NF-001|role_not_found)'
      using errcode = 'P0002';
  end if;
  -- บัญชีต้องมี role ที่ยังใช้งาน ≥1 เสมอ (DD §3.1 — บัญชีไร้บทบาท = ไม่มีสิทธิ์ใด ตายทาง)
  if not exists (select 1 from public.role_assignments ra
                 where ra.user_id = p_user_id and ra.revoked_at is null) then
    raise exception
      'ถอนไม่ได้: บัญชีนี้จะไม่เหลือบทบาทที่ใช้งานอยู่ (ต้องมีอย่างน้อย 1 บทบาท) (ERR-VAL-001|last_role)'
      using errcode = '22023';
  end if;

  perform public.append_audit_event_internal(
    'ROLE_REVOKE', 'user', (p_user_id)::text, null, null,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'role', p_role,
      'reason', btrim(p_reason)),
    null, null, p_request_id, v_actor);

  return jsonb_build_object('userId', p_user_id, 'role', p_role, 'revoked', true);
end;
$fn$;
alter function public.admin_revoke_role(uuid, text, text, text) owner to app_owner;
revoke execute on function public.admin_revoke_role(uuid, text, text, text) from public, anon;
grant execute on function public.admin_revoke_role(uuid, text, text, text) to authenticated;

-- ─── (7) admin_list_users — ค้นหา + keyset (D-p5-6 · PII_ACCESS audit ผูกที่ BFF) ───
create or replace function public.admin_list_users(
  p_query text,
  p_status text,               -- 'active' | 'deleted' | null (ทุกสถานะ)
  p_cursor_created_at timestamptz,
  p_cursor_id uuid,
  p_limit int
) returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := public.admin_users_staff_guard();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_q text;
  v_rows jsonb;
  v_has_more boolean;
begin
  v_q := nullif(btrim(coalesce(p_query, '')), '');
  if v_q is not null and length(v_q) > 100 then
    raise exception 'ข้อมูลไม่ถูกต้อง: คำค้นยาวเกิน 100 อักขระ (ERR-VAL-001|query_length)'
      using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('active', 'deleted') then
    raise exception 'ข้อมูลไม่ถูกต้อง: status ต้องเป็น active/deleted (ERR-VAL-001|status_value)'
      using errcode = '22023';
  end if;

  -- has_more จากแถวเกิน (limit+1) หลัง aggregation — ห้าม count(*) over () ร่วมกับ
  -- jsonb_agg ใน SELECT เดียว (window คำนวณหลัง aggregate = ได้ 1 เสมอ — บทเรียน 0032)
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    into v_rows
  from (
    select p.id,
           p.display_name,
           p.email,
           p.deleted_at,
           p.created_at,
           coalesce(array_agg(ra.role order by ra.role)
                    filter (where ra.role is not null and ra.revoked_at is null),
                    array[]::text[]) as roles,
           exists (select 1 from public.lawyer_licenses ll
                   where ll.user_id = p.id and ll.status = 'verified'
                     and ll.revoked_at is null and ll.deleted_at is null) as has_verified_license
      from public.profiles p
      left join public.role_assignments ra on ra.user_id = p.id
     where (v_q is null
            or p.display_name ilike v_q || '%'
            or p.email ilike v_q || '%')
       and (p_status is null
            or (p_status = 'active' and p.deleted_at is null)
            or (p_status = 'deleted' and p.deleted_at is not null))
       and (p_cursor_created_at is null
            or (p.created_at, p.id) < (p_cursor_created_at, p_cursor_id))
     group by p.id
     order by p.created_at desc, p.id desc
     limit v_limit + 1
  ) t;

  v_has_more := jsonb_array_length(v_rows) > v_limit;
  if v_has_more then
    v_rows := v_rows - (jsonb_array_length(v_rows) - 1); -- ตัดแถวสุดท้าย (แถวเกินโควตา — เรียง desc)
  end if;

  return jsonb_build_object(
    'data', v_rows,
    'nextCursor', case when coalesce(v_has_more, false) and jsonb_array_length(v_rows) > 0
                       then jsonb_build_object(
                              'createdAt', (v_rows -> jsonb_array_length(v_rows) - 1) ->> 'created_at',
                              'id', (v_rows -> jsonb_array_length(v_rows) - 1) ->> 'id')
                       else null end);
end;
$fn$;
alter function public.admin_list_users(text, text, timestamptz, uuid, int) owner to app_owner;
revoke execute on function public.admin_list_users(text, text, timestamptz, uuid, int) from public, anon;
grant execute on function public.admin_list_users(text, text, timestamptz, uuid, int) to authenticated;

-- ─── (8) admin_decide_course — publish/unpublish/return + audit atomic (D-p5-11) ───
-- transition: publish pending_review→published · unpublish published→draft ·
-- return pending_review→returned (comment ≥10 บังคับ — แบบแผน revoke)
create or replace function public.admin_decide_course(
  p_course_id uuid,
  p_action text,
  p_comment text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid;
  v_from public.course_status;
  v_to public.course_status;
  v_created_by uuid;
  v_action_name text;
  v_sod_ok boolean;
begin
  v_actor := public.admin_course_staff_guard();
  if p_action not in ('publish', 'unpublish', 'return') then
    raise exception 'ข้อมูลไม่ถูกต้อง: action ต้องเป็น publish/unpublish/return (ERR-VAL-001|action_value)'
      using errcode = '22023';
  end if;
  if p_action = 'return'
     and (p_comment is null or length(btrim(p_comment)) < 10 or length(p_comment) > 500) then
    raise exception 'ข้อมูลไม่ถูกต้อง: ความเห็นส่งกลับต้องยาว 10-500 อักขระ (ERR-VAL-001|comment_required)'
      using errcode = '22023';
  end if;
  if p_comment is not null and length(p_comment) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: ความเห็นยาวเกิน 500 อักขระ (ERR-VAL-001|comment_length)'
      using errcode = '22023';
  end if;

  select status, created_by into v_from, v_created_by
  from public.courses where id = p_course_id for update;
  if not found then
    raise exception 'ไม่พบหลักสูตร (ERR-NF-001|course_not_found)' using errcode = 'P0002';
  end if;

  v_to := case p_action
            when 'publish' then 'published'
            when 'unpublish' then 'draft'
            when 'return' then 'returned'
          end;
  v_action_name := case p_action
                     when 'publish' then 'COURSE_PUBLISH'
                     when 'unpublish' then 'COURSE_UNPUBLISH'
                     when 'return' then 'COURSE_RETURN'
                   end;
  if not (
    (p_action = 'publish' and v_from = 'pending_review')
    or (p_action = 'unpublish' and v_from = 'published')
    or (p_action = 'return' and v_from = 'pending_review')
  ) then
    raise exception
      'เปลี่ยนสถานะหลักสูตรไม่ได้: % จากสถานะปัจจุบัน (%) — เผยแพร่/ส่งกลับได้จาก "รอตรวจ" เท่านั้น และเลิกเผยแพร่ได้จาก "เผยแพร่แล้ว" (ERR-VAL-001|invalid_transition)',
      p_action, v_from
      using errcode = '22023';
  end if;
  -- SoD ของ AUDIT §2.3: ผู้อนุมัติ ≠ ผู้สร้าง (สร้างเองขึ้นมาตรวจเอง = false — บันทึกตามจริง)
  v_sod_ok := (v_actor <> v_created_by);

  update public.courses set status = v_to where id = p_course_id;

  perform public.append_audit_event_internal(
    v_action_name, 'course', (p_course_id)::text, null, null,
    jsonb_build_object(
      'course_id', p_course_id,
      'sod_ok', v_sod_ok)
      || case when p_comment is not null
              then jsonb_build_object('comment', btrim(p_comment))
              else '{}'::jsonb end,
    null, null, p_request_id, v_actor);

  return jsonb_build_object('courseId', p_course_id, 'status', v_to);
end;
$fn$;
alter function public.admin_decide_course(uuid, text, text, text) owner to app_owner;
revoke execute on function public.admin_decide_course(uuid, text, text, text) from public, anon;
grant execute on function public.admin_decide_course(uuid, text, text, text) to authenticated;

-- ─── (9) notification templates 6 คีย์ (D-p5-12) ───
-- license.application.* = ครอบครัว 'license' (ผู้ใช้ปิดได้) · data_export.ready =
-- ครอบครัว 'account' · account.delete.confirm/account.deleted = อีเมลธุรกรรมบังคับ
-- (email เท่านั้น — แทรก email_outbox ตรงโดย BFF ไม่ผ่าน tick จึงไม่มีแถว in_app)
insert into public.notification_templates
  (template_key, locale, channel, subject_tpl, body_tpl)
values
  ('license.application.approved', 'th', 'in_app',
   'ยืนยันเลขที่ใบอนุญาตสำเร็จ',
   'คำขอผูกเลขที่ใบอนุญาตของคุณได้รับการอนุมัติแล้ว บัญชีของคุณมีสถานะทนายความเรียบร้อย'),
  ('license.application.approved', 'th', 'email',
   'ยืนยันเลขที่ใบอนุญาตสำเร็จ: {{license_no}}',
   'เรียน คุณ{{full_name}}

คำขอผูกเลขที่ใบอนุญาตว่าความ "{{license_no}}" ของคุณได้รับการอนุมัติแล้ว
บัญชีของคุณได้รับสถานะทนายความ (lawyer) เรียบร้อย — สามารถลงทะเบียนเรียนหลักสูตร
สำหรับทนายความและสอบเพื่อรับคะแนนวิชาชีพต่ออายุใบอนุญาตได้ทันที'),
  ('license.application.rejected', 'th', 'in_app',
   'คำขอผูกเลขที่ใบอนุญาตถูกปฏิเสธ',
   'คำขอผูกเลขที่ใบอนุญาตของคุณถูกปฏิเสธ เหตุผล: {{reason}} — แก้ไขและยื่นใหม่ได้'),
  ('license.application.rejected', 'th', 'email',
   'คำขอผูกเลขที่ใบอนุญาตถูกปฏิเสธ: {{license_no}}',
   'เรียน คุณ{{full_name}}

คำขอผูกเลขที่ใบอนุญาตว่าความ "{{license_no}}" ของคุณถูกปฏิเสธ
เหตุผล: {{reason}}

ท่านสามารถแก้ไขข้อมูลและยื่นคำขอใหม่ได้ที่หน้า "ใบอนุญาตว่าความของฉัน"'),
  ('data_export.ready', 'th', 'in_app',
   'ไฟล์ส่งออกข้อมูลของคุณพร้อมแล้ว',
   'ข้อมูลส่วนบุคคลของคุณถูกรวบรวมเป็นไฟล์เรียบร้อย — ลิงก์ดาวน์โหลด (ใช้ได้ 7 วัน) อยู่ในอีเมลและหน้าความเป็นส่วนตัว'),
  ('data_export.ready', 'th', 'email',
   'ไฟล์ส่งออกข้อมูลของคุณพร้อมดาวน์โหลด',
   'เรียน คุณ{{full_name}}

ไฟล์ส่งออกข้อมูลส่วนบุคคลของคุณ (ตามสิทธิเข้าถึงข้อมูล PDPA) พร้อมดาวน์โหลดแล้ว
ลิงก์ (ใช้ได้ 7 วันนับจากข้อความนี้): {{download_url}}'),
  ('account.delete.confirm', 'th', 'email',
   'ยืนยันการลบบัญชี — LTC E-Learning',
   'เรียน คุณ{{full_name}}

ท่านขอลบบัญชีกับระบบฝึกอบรมของสภาทนายความแห่งประเทศไทย
หากแน่ใจ กรุณาเปิดลิงก์นี้เพื่อยืนยัน (ใช้ได้ 1 ครั้ง ภายใน 24 ชั่วโมง): {{confirm_url}}

หากไม่ได้ขอลบเอง โปรดเพิกเฉยต่ออีเมลนี้ — บัญชีของท่านจะไม่ถูกลบ
หมายเหตุ: ผลการสอบและประวัติการตรวจสอบจะถูกเก็บไว้ตามที่กฎหมายกำหนด'),
  ('account.deleted', 'th', 'email',
   'บัญชีของท่านถูกลบเรียบร้อยแล้ว — LTC E-Learning',
   'เรียน คุณ{{full_name}}

บัญชีของท่านถูกลบเรียบร้อยแล้วตามคำขอ ขอบคุณที่ใช้บริการ
(ผลการสอบและประวัติการตรวจสอบถูกเก็บรักษาตามที่กฎหมายกำหนด)')
on conflict (template_key, locale, channel) where is_active do nothing;

-- ─── (10) settings families += 'license','account' (คัดลอก my_notification_settings
--          + my_notification_settings_update ของ 0034 §6.3/§6.4 — เปลี่ยนเฉพาะ
--          v_families/v_allowed · ต้องแก้คู่กัน ไม่งั้นตั้งค่าใหม่ได้แต่อ่านคืนไม่เห็น) ───
create or replace function public.my_notification_settings() returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_families text[] := array['exam.result','certificate','credit','renewal','license','account'];
  v_stored jsonb := '{}'::jsonb;
  v_fam text;
  v_out jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  select settings into v_stored
  from public.notification_settings where user_id = v_uid;
  if not found then
    v_stored := '{}'::jsonb;
  end if;
  foreach v_fam in array v_families loop
    v_out := jsonb_set(v_out, array[v_fam],
      jsonb_build_object(
        'in_app', coalesce((v_stored -> v_fam ->> 'in_app')::boolean, true),
        'email', coalesce((v_stored -> v_fam ->> 'email')::boolean, true)));
  end loop;
  return jsonb_build_object('settings', v_out);
end;
$fn$;

create or replace function public.my_notification_settings_update(p_settings jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_allowed text[] := array['exam.result','certificate','credit','renewal','license','account'];
  v_key text;
  v_val jsonb;
  v_clean jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'ข้อมูลไม่ถูกต้อง: settings ต้องเป็น object (ERR-VAL-001|settings_must_be_object)'
      using errcode = '22023';
  end if;
  for v_key, v_val in select key, value from jsonb_each(p_settings) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'ข้อมูลไม่ถูกต้อง: family ไม่รู้จัก (ERR-VAL-001|unknown_family)'
        using errcode = '22023';
    end if;
    if v_val is null or jsonb_typeof(v_val) <> 'object'
       or not (v_val ?& array['in_app','email'])
       or jsonb_typeof(v_val -> 'in_app') <> 'boolean'
       or jsonb_typeof(v_val -> 'email') <> 'boolean' then
      raise exception 'ข้อมูลไม่ถูกต้อง: แต่ละ family ต้องมี in_app และ email แบบ boolean เท่านั้น (ERR-VAL-001|family_shape)'
        using errcode = '22023';
    end if;
    v_clean := jsonb_set(v_clean, array[v_key], v_val);
  end loop;
  if v_clean = '{}'::jsonb then
    raise exception 'ข้อมูลไม่ถูกต้อง: settings ว่างเปล่า (ERR-VAL-001|settings_empty)'
      using errcode = '22023';
  end if;
  insert into public.notification_settings (user_id, settings)
  values (v_uid, v_clean)
  on conflict (user_id) do update
    set settings = public.notification_settings.settings || excluded.settings;
  return public.my_notification_settings();
end;
$fn$;

-- ─── (11) notification_dispatch_tick — สำเนา 0034 เต็ม + 3 topic additive ───
-- เปลี่ยนจากฉบับ 0034 เฉพาะ: ชุด topic ใน IN-list · case ของ family/ref_type/tpl_key/
-- severity · สาขาสร้าง vars ของ topic ใหม่ — โครง 2 เฟส + dedupe + ประตูรายช่องทาง +
-- backoff คงเดิมทุกบรรทัด (gate ผ่านมาแล้ว 4 รอบ — ห้ามเขียนใหม่ตามใจ)
create or replace function public.notification_dispatch_tick() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_rounds int := 0;
  v_batch int;
  v_processed int := 0;
  v_already int := 0;
  v_email int := 0;
  v_failed int := 0;
  v_skipped int := 0;
  v_event uuid;
  v_user uuid;
  v_ref_id uuid;
  v_family text;
  v_ref_type text;
  v_tpl_key text;
  v_severity text;
  v_full_name text;
  v_amount numeric;
  v_vars jsonb;
  v_render jsonb;
  v_notif uuid;
  v_in_app boolean;
  v_email_ok boolean;
  r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('ltc:notification_dispatch')::bigint) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;

  -- ── เฟส 1: เก็บ event ทั้งหมด (≤5 รอบ × 200) — ไม่มี cast ใด ๆ ในเฟสนี้ ═══
  -- drop if exists กันซ้ำใน pooled session ที่ TX ก่อน abort ค้างไว้ (แบบ 0031)
  drop table if exists _notif_events;
  create temp table _notif_events (
    seq bigint generated always as identity primary key,
    event_id uuid not null unique,
    topic text not null,
    payload jsonb not null
  ) on commit drop;

  <<collect>>
  loop
    v_rounds := v_rounds + 1;
    if v_rounds > 5 then exit; end if; -- ≤1,000 event/tick (รอบถัดไป 1 นาที)
    insert into _notif_events (event_id, topic, payload)
    select e.id, e.topic, e.payload
      from public.event_outbox e
     where e.topic in ('exam.result','certificate.issued','certificate.revoked','credit.adjusted',
                       'license.application.approved','license.application.rejected','data_export.ready')
       and e.status = 'pending'
       and e.available_at <= now()
       and not exists (select 1 from _notif_events t where t.event_id = e.id)
     order by e.available_at, e.id
     limit 200;
    get diagnostics v_batch = row_count;
    exit when v_batch = 0;        -- คิวหมด
    exit when v_batch < 200;      -- เศษท้ายคิว
  end loop collect;

  -- ── เฟส 2: ต่อ event 1 subtransaction — ทุก payload cast ใน begin/exception นี้ ──
  for r in select event_id, topic, payload from _notif_events order by seq loop
    v_event := r.event_id;
    begin
      -- cast ราย event — poison (user_id/source_id เสีย) ล้มเฉพาะ event ตัวเอง (r4 B1)
      v_user := (r.payload ->> 'user_id')::uuid;
      v_ref_id := coalesce(
        nullif(r.payload ->> 'source_id', '')::uuid,
        nullif(r.payload ->> 'certificate_id', '')::uuid,
        nullif(r.payload ->> 'ledger_id', '')::uuid);

      -- D-p4-5: topic → settings family
      v_family := case r.topic
        when 'exam.result' then 'exam.result'
        when 'certificate.issued' then 'certificate'
        when 'certificate.revoked' then 'certificate'
        when 'credit.adjusted' then 'credit'
        when 'license.application.approved' then 'license'
        when 'license.application.rejected' then 'license'
        when 'data_export.ready' then 'account'
        else null end;
      -- ref_type ตาม topic (dedupe + แถว notification ใช้ค่าเดียวกัน)
      -- certificate.issued = 'certificate' เหมือน revoked (สมมาตร — id/ประเภทอ้างอิง
      -- เดียวกันตลอดตระกูล ไม่มีเหตุผลให้ฝั่งออกใบเป็น null)
      v_ref_type := case r.topic
        when 'exam.result' then coalesce(r.payload ->> 'source_type', 'assessment_attempt')
        when 'certificate.issued' then 'certificate'
        when 'certificate.revoked' then 'certificate'
        when 'credit.adjusted' then 'credit_ledger'
        when 'license.application.approved' then 'license_application'
        when 'license.application.rejected' then 'license_application'
        when 'data_export.ready' then 'data_export_job'
        else null end;
      -- template key + severity — exam แตก variant ตามผล (NTF-002 คนละ template ผ่าน/ไม่ผ่าน)
      v_tpl_key := case r.topic
        when 'exam.result' then case when coalesce((r.payload ->> 'passed')::boolean, false)
                                     then 'exam.result.passed' else 'exam.result.failed' end
        when 'certificate.issued' then 'certificate.issued'
        when 'certificate.revoked' then 'certificate.revoked'
        when 'credit.adjusted' then 'credit.adjusted'
        when 'license.application.approved' then 'license.application.approved'
        when 'license.application.rejected' then 'license.application.rejected'
        when 'data_export.ready' then 'data_export.ready'
        else null end;
      v_severity := case r.topic
        when 'exam.result' then case when coalesce((r.payload ->> 'passed')::boolean, false)
                                     then 'success' else 'warning' end
        when 'certificate.issued' then 'success'
        when 'certificate.revoked' then 'warning'
        when 'credit.adjusted' then 'info'
        when 'license.application.approved' then 'success'
        when 'license.application.rejected' then 'warning'
        when 'data_export.ready' then 'info'
        else 'info' end;
      if v_user is null or v_ref_id is null or v_family is null or v_tpl_key is null then
        raise exception 'ข้อมูลไม่ถูกต้อง: payload ขาด user_id/ref_id (ERR-VAL-001|dispatch_payload)';
      end if;

      -- D-p4-3 dedupe (at-least-once → exactly-once) ก่อน INSERT เสมอ:
      -- แถวเดิม (topic, ref_id, user) ช่องทางใดก็ได้ มีอยู่ = ปิด event processed +
      -- นับ already_notified — ไม่กรองช่องทาง (gate r1 B3: ผู้ใช้ปิด in_app แล้ว event
      -- ถูกจัดการด้วยแถว email เดียว ก็ต้อง dedupe ได้เหมือนกัน)
      if exists (
        select 1
          from public.notifications n
          join public.notification_recipients nr
            on nr.notification_id = n.id
        where n.topic = r.topic
          and n.ref_id = v_ref_id
          and nr.user_id = v_user
      ) then
        update public.event_outbox
        set status = 'processed', processed_at = now(), last_error = null
        where id = v_event;
        v_already := v_already + 1;
      else
        -- ประตูรายช่องทาง (gate r1 B3 / NTF-005): in_app และ email ตัดสินแยกจากกัน —
        -- in_app ดู settings ของ family เท่านั้น (ไม่ผูก consent · D-p4-4) · email ยัง
        -- fail-closed สองชั้นเหมือนเดิม · ปิดครบทั้งสองช่องทาง = ไม่สร้างแถวเลย
        -- (ผู้ใช้ไม่ต้องการรับ — event ปิดเป็น processed ไม่ retry ไปเรื่อย ๆ)
        v_in_app := public.notification_in_app_allowed(v_user, v_family);
        v_email_ok := public.notification_email_allowed(v_user, v_family);
        if not v_in_app and not v_email_ok then
          update public.event_outbox
          set status = 'processed', processed_at = now(), last_error = null
          where id = v_event;
          v_skipped := v_skipped + 1;
        else
          -- ชื่อเต็ม (แบบ holderNameOf — ชื่อ+นามสกุล, fallback display_name)
          select coalesce(nullif(concat_ws(' ', nullif(pr.first_name, ''), nullif(pr.last_name, '')), ''),
                          nullif(pr.display_name, ''), 'สมาชิก') into v_full_name
          from public.profiles pr where pr.id = v_user;

          -- ตัวแปร render ต่อ topic — ครบตามที่ template อ้าง (render จะ raise ถ้าขาด) ·
          -- email ใบประกาศฯ ส่งตัวระบุสองตัวให้ worker ประกอบลิงก์ (gate r2 B5 ·
          -- adjudication-2: SQL ผู้ผลิตไม่รู้ env — ส่ง verify_code + certificate_id
          -- เท่านั้น): verify_url = base/verify/<verify_code> (หน้า verify สาธารณะ ·
          -- route ยอมรับ verify_code/cert_no) แต่ pdf_url = base/api/v1/certificates/
          -- <certificate_id>/pdf เพราะ route PDF บังคับ {code} = UUID ของ certificates.id
          -- (API-SPEC §3.6) — ใช้ verify_code (nanoid-43) จะได้ 400 เสมอ
          -- 0035: data_export.ready ส่ง job_id + file_media_id เท่านั้น — {{download_url}}
          -- (signed URL 7 วัน) ประกอบที่ email worker จาก config + storage (SQL ลงนาม
          -- ไม่ได้ — แบบแผนเดียวกับ verify_url/pdf_url)
          v_vars := jsonb_build_object('full_name', v_full_name);
          if r.topic = 'exam.result' then
            v_vars := v_vars || jsonb_build_object(
              'course_title', r.payload ->> 'course_title_th',
              'score_pct', r.payload ->> 'score_pct',
              'pass_pct', r.payload ->> 'pass_pct',
              'attempt_no', r.payload ->> 'attempt_no');
          elsif r.topic = 'certificate.issued' then
            v_vars := v_vars || jsonb_build_object(
              'course_title', r.payload ->> 'course_title_th',
              'cert_no', r.payload ->> 'cert_no',
              'verify_code', r.payload ->> 'verify_code',
              'certificate_id', r.payload ->> 'certificate_id');
          elsif r.topic = 'certificate.revoked' then
            v_vars := v_vars || jsonb_build_object(
              'cert_no', r.payload ->> 'cert_no',
              'verify_code', r.payload ->> 'verify_code',
              'certificate_id', r.payload ->> 'certificate_id');
          elsif r.topic = 'credit.adjusted' then
            v_amount := (r.payload ->> 'amount')::numeric;
            v_vars := v_vars || jsonb_build_object('amount',
              case when v_amount >= 0 then '+' else '' end
              || to_char(v_amount, 'FM999999990.00'));
          elsif r.topic in ('license.application.approved','license.application.rejected') then
            v_vars := v_vars || jsonb_build_object(
              'license_no', r.payload ->> 'license_no')
              || case when r.payload ? 'reason'
                      then jsonb_build_object('reason', r.payload ->> 'reason')
                      else '{}'::jsonb end;
          elsif r.topic = 'data_export.ready' then
            v_vars := v_vars || jsonb_build_object(
              'job_id', r.payload ->> 'job_id',
              'file_media_id', r.payload ->> 'file_media_id');
          end if;

          -- render in_app — template หาย/ตัวแปรขาด = raise → backoff (fail-loud) ·
          -- เนื้อหาแถว notification มาจาก template in_app เสมอ (แม้ผู้ใช้ปิด in_app
          -- แต่ยังเปิด email — แถวเป็นที่เก็บเนื้อหาอ้างอิงของอีเมล)
          v_render := public.render_notification(v_tpl_key, 'th', 'in_app', v_vars);
          insert into public.notifications (topic, title, body, severity, ref_type, ref_id)
          values (r.topic, v_render ->> 'subject', v_render ->> 'body', v_severity, v_ref_type, v_ref_id)
          returning id into v_notif;

          -- ปิด in_app แล้ว = ไม่สร้างแถว recipient in_app เลย (gate r1 B3 — badge/
          -- inbox ไม่เห็น ไม่ใช่สร้างแล้วซ่อน)
          if v_in_app then
            insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
            values (v_notif, v_user, 'in_app', now());
          end if;

          -- email? (D-p4-4 fail-closed สองชั้น) — tick เข้าคิวเท่านั้น · render+ส่งจริงที่
          -- worker (D-p4-8) · payload ใส่ notification_id เสมอ (D-p4-8) + user_id + vars
          if v_email_ok then
            insert into public.email_outbox (recipient_user_id, to_email, template_key, payload, locale)
            select v_user, pr.email, v_tpl_key,
                   jsonb_build_object('notification_id', v_notif, 'user_id', v_user, 'vars', v_vars),
                   'th'
            from public.profiles pr where pr.id = v_user;
            -- แถวผู้รับช่องทาง email (sent_at = null รอ worker ยืนยัน — D-p4-7)
            insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
            values (v_notif, v_user, 'email', null)
            on conflict (notification_id, user_id, channel) do nothing;
            v_email := v_email + 1;
          end if;

          update public.event_outbox
          set status = 'processed', processed_at = now(), last_error = null
          where id = v_event;
          v_processed := v_processed + 1;
        end if;
      end if;
    exception when others then
      -- ต่อ event: attempts+1 + backoff 60s×2^n cap 900s · ≥5 → failed (เหมือน 0031 เป๊ะ)
      update public.event_outbox
      set attempts = attempts + 1,
          last_error = left(sqlerrm, 500),
          status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
          available_at = now() + make_interval(
            secs => least(60 * power(2, attempts + 1), 900))
      where id = v_event;
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('skipped', false,
                            'processed', v_processed,
                            'already_notified', v_already,
                            'email_queued', v_email,
                            'skipped_no_channel', v_skipped,
                            'failed', v_failed);
end;
$fn$;
alter function public.notification_dispatch_tick() owner to app_owner;
revoke execute on function public.notification_dispatch_tick() from public, anon, authenticated;
grant execute on function public.notification_dispatch_tick() to app_owner, service_role, postgres;

-- ─── (12) single-path lockdown (แบบแผน 0032 §5) + app_owner grants/policies ───
--  (SELECT คงเดิมทุกตาราง · migration รันในนาม superuser ไม่กระทบ)
revoke insert on public.license_applications from authenticated, service_role;
revoke update on public.license_applications from service_role;
grant insert, update on public.license_applications to app_owner;

revoke insert on public.lawyer_licenses from service_role;
grant insert on public.lawyer_licenses to app_owner;

revoke insert, update on public.role_assignments from service_role;
grant insert, update on public.role_assignments to app_owner;

revoke update on public.courses from service_role;
grant update on public.courses to app_owner;

-- RLS บังคับแม้ต่อ app_owner (definer ไม่มี BYPASSRLS — เจอจริงใน 0032: policy ขาด
-- UPDATE เงียบไป 0 แถวแล้วตอบสำเร็จปลอม) · **policy app_owner_insert_* เดิมของ 0010
-- ไม่แตะ** (ตามแบบแผน 0032 §5 เป๊ะ — ตรวจจริงบน dev แล้ว: with check (true) ทั้งสาม):
-- trigger on_auth_user_created (owner = app_owner) แทรก role_assignments citizen
-- ด้วย granted_by null ตอนสมัคร — ห้ามตึงเงื่อนไข มิฉะนั้นสมัครสมาชิกพังทันที ·
-- RPC ตรวจทุกเงื่อนไขธุรกิจในตัวอยู่แล้ว (INSERT policy เหลือเป็น defense-in-depth)
-- — 0035 เติมเฉพาะ UPDATE policy ที่ยังขาด (สามตาราง)
drop policy if exists app_owner_update_license_applications on public.license_applications;
create policy app_owner_update_license_applications
  on public.license_applications for update to app_owner
  using (true) with check (true);

drop policy if exists app_owner_update_role_assignments on public.role_assignments;
create policy app_owner_update_role_assignments
  on public.role_assignments for update to app_owner
  using (true) with check (true);

drop policy if exists app_owner_update_courses_status on public.courses;
create policy app_owner_update_courses_status
  on public.courses for update to app_owner
  using (true) with check (true);
