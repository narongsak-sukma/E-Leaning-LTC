-- 0039_gate_r2_forward_fixes.sql — gate p5-r2 BLOCKER-3/4 + MINOR-1 [#90]
--
-- WHY THIS FILE EXISTS (gate p5-r2 B3): migrate.sh ข้ามไฟล์ตาม "ชื่อ" ใน ledger
-- _dev.migrations โดยไม่ตรวจเนื้อหา — fix wave ของ gate p5-r1 แก้ definition ใน
-- 0034/0035/0036 "ซึ่ง dev DB บันทึก ledger ไว้แล้ว" (และ 0034 มีบน develop) การแก้
-- ในไฟล์เดิมจึงไม่มีวันถูกติดตั้งบน DB เหล่านั้นผ่าน runner — ไฟล์นี้เป็น forward
-- migration ทวนซ้ำ def "สุดท้าย" ของทุกฟังก์ชันที่แตะ + คอลัมน์ใหม่ + backfill
-- แบบ idempotent (create or replace / add column if not exists) — ปลอดภัยทุกสถานะ:
--   fresh replay (reset-db)  = 0034→0036 วางของเดิม 0039 ทวนชุดเดียวกัน = no-op
--   dev DB ปัจจุบัน           = 0039 ติดตั้ง def สุดท้ายที่ runner เคยข้าม
--   DB ที่ upgrade จาก develop = 0035+ เป็นไฟล์ใหม่อยู่แล้ว 0039 ทวนซ้ำ = no-op
--
-- สิ่งที่เป็น "ของใหม่" ในไฟล์นี้ (ไม่ใช่การทวนซ้ำ):
--   §1 claim_token (fencing — gate p5-r2 M1) + backfill lease งานค้าง (B4)
--   §2 claim เห็นงาน processing ที่ claimed_at IS NULL (B4) + complete/fail
--      ตรวจ p_claim_token — worker เก่าที่ lease ถูกยึดปิดงานไม่ได้ (M1)

-- ═══ §1 data_export_jobs: คอลัมน์ fencing + backfill งานค้าง (gate p5-r2 B4/M1) ═══

alter table public.data_export_jobs
  add column if not exists claim_token uuid;
comment on column public.data_export_jobs.claim_token is
  'gate p5-r2 M1: token ของ "รอบการถือครอง" ล่าสุด — complete/fail ต้องแนบค่าที่ตรงกัน (worker เก่าที่ lease ถูกยึดคืนใช้ปิดงานไม่ได้)';

-- B4: งาน processing ที่ไม่มี lease (claim สมัยก่อนมี claimed_at) ให้ถือว่า lease
-- หมดอายุแล้ว — claim รอบถัดไปยึดกลับได้ทันที ไม่ค้างอมตะ + ไม่บล็อก active-job
-- guard ของ my_request_data_export
update public.data_export_jobs
   set claimed_at = now() - interval '11 minutes'
 where status = 'processing'
   and claimed_at is null;


-- ═══ §2 worker RPC: claim (B4 NULL-lease) / complete / fail (M1 fencing) ═══
-- signature เปลี่ยน (เพิ่ม p_claim_token) — drop def เก่าก่อน ไม่ทิ้ง overload ลอย

drop function if exists public.complete_data_export_job(uuid, uuid, int, text);
drop function if exists public.fail_data_export_job(uuid, text);

-- claim: ทีละแถว FOR UPDATE SKIP LOCKED · คืน claimToken ของรอบถือครองนี้
create or replace function public.claim_data_export_job() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_job record;
  v_token uuid;
begin
  select id, user_id into v_job
  from public.data_export_jobs
  where status = 'pending'
     -- gate p5-r1 B7 + gate p5-r2 B4: reclaim — processing ที่ lease หมดอายุ
     -- "รวมถึง claimed_at IS NULL" (งานค้างจากรอบก่อนคอลัมน์นี้ถูกใช้จริง) หยิบกลับ
     -- มาทำต่อได้ ไม่ค้างเป็นอมตะ + ไม่บล็อก my_request_data_export ตลอดไป
     or (status = 'processing'
         and (claimed_at is null or claimed_at < now() - interval '10 minutes'))
  order by requested_at, id
  limit 1
  for update skip locked;
  if not found then
    return jsonb_build_object('jobId', null);
  end if;
  v_token := gen_random_uuid();
  update public.data_export_jobs
     set status = 'processing', claimed_at = now(), claim_token = v_token
   where id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'userId', v_job.user_id,
                            'claimToken', v_token);
end;
$fn$;
alter function public.claim_data_export_job() owner to app_owner;
revoke execute on function public.claim_data_export_job() from public, anon, authenticated;
grant execute on function public.claim_data_export_job() to service_role, app_owner;

-- complete: →done + file_media_id + audit DATA_EXPORT_DONE + event data_export.ready
-- · gate p5-r2 M1: p_claim_token ต้องตรง claim_token ปัจจุบัน — ไม่ตรง = lease
--   ถูก worker อื่นยึดไปแล้ว ห้ามปิดงานแทน (stale_lease)
create or replace function public.complete_data_export_job(
  p_job_id uuid,
  p_file_media_id uuid,
  p_chunks int,
  p_request_id text,
  p_claim_token uuid
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid;
  v_token uuid;
begin
  if p_file_media_id is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุไฟล์ผลลัพธ์ (ERR-VAL-001|file_media_id_required)'
      using errcode = '22023';
  end if;
  select user_id, claim_token into v_user, v_token
  from public.data_export_jobs
  where id = p_job_id and status = 'processing'
  for update;
  if not found then
    raise exception 'ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)'
      using errcode = 'P0002';
  end if;
  if v_token is distinct from p_claim_token then
    raise exception 'สิทธิ์การถือครองงานนี้ถูกยึดคืนแล้ว ไม่สามารถปิดงานแทนผู้อื่นได้ (ERR-VAL-001|stale_lease)'
      using errcode = '22023';
  end if;

  update public.data_export_jobs
     set status = 'done',
         file_media_id = p_file_media_id,
         completed_at = now(),
         error = null
   where id = p_job_id;

  perform public.append_audit_event_internal(
    'DATA_EXPORT_DONE', 'data_export_job', (p_job_id)::text, null, null,
    jsonb_build_object(
      'job_id', p_job_id,
      'file_media_id', p_file_media_id,
      'chunks', p_chunks),
    null, null, p_request_id, null);

  insert into public.event_outbox (topic, payload)
  values ('data_export.ready',
    jsonb_build_object(
      'user_id', v_user,
      'source_id', p_job_id,
      'job_id', p_job_id,
      'file_media_id', p_file_media_id));

  return jsonb_build_object('jobId', p_job_id, 'status', 'done');
end;
$fn$;
alter function public.complete_data_export_job(uuid, uuid, int, text, uuid) owner to app_owner;
revoke execute on function public.complete_data_export_job(uuid, uuid, int, text, uuid) from public, anon, authenticated;
grant execute on function public.complete_data_export_job(uuid, uuid, int, text, uuid) to service_role, app_owner;

-- fail: →failed + error (static จาก worker) · gate p5-r2 M1: fencing เช่นเดียวกับ
-- complete — worker เก่า mark failed ทับงานที่ worker ใหม่กำลังทำไม่ได้
create or replace function public.fail_data_export_job(
  p_job_id uuid,
  p_error text,
  p_claim_token uuid
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_cnt int;
  v_status text;
  v_token uuid;
begin
  update public.data_export_jobs
     set status = 'failed',
         completed_at = now(),
         error = left(p_error, 500)     -- ตัดทอน · ห้าม PII (ความรับผิดชอบของ worker)
   where id = p_job_id
     and status = 'processing'
     and claim_token is not distinct from p_claim_token;
  get diagnostics v_cnt = row_count;
  if v_cnt > 0 then
    return jsonb_build_object('jobId', p_job_id, 'status', 'failed');
  end if;
  -- แยกสองสาเหตุให้ผู้เรียกเห็นจริง (ไม่กลืนเป็น job_not_processing เดียว)
  select status, claim_token into v_status, v_token
  from public.data_export_jobs where id = p_job_id;
  if v_status is null or v_status <> 'processing' then
    raise exception 'ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)'
      using errcode = 'P0002';
  end if;
  raise exception 'สิทธิ์การถือครองงานนี้ถูกยึดคืนแล้ว ไม่สามารถปิดงานแทนผู้อื่นได้ (ERR-VAL-001|stale_lease)'
    using errcode = '22023';
end;
$fn$;
alter function public.fail_data_export_job(uuid, text, uuid) owner to app_owner;
revoke execute on function public.fail_data_export_job(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fail_data_export_job(uuid, text, uuid) to service_role, app_owner;


-- ═══ §3 ทวนซ้ำ def สุดท้ายของฟังก์ชันที่ fix wave แก้ในไฟล์เดิม (B3) ═══
-- (ตัวไฟล์เดิมเก็บ def เดียวกันไว้เพื่อ fresh replay — สองที่นี้ต้องคงสอดคล้องเสมอ)

-- ─── my_request_account_deletion (สุดท้ายจาก 0036 — B1 คืน userId) ───
create or replace function public.my_request_account_deletion(
  p_request_id text
) returns jsonb
language plpgsql security definer
-- r3: gen_random_bytes อยู่ที่ schema extensions (pgcrypto — จัดการไว้แล้วใน 0019:
-- create extension + grant usage แก่ app_owner) ตัว DEFINER รันใต้ app_owner จึงต้อง
-- ใส่ extensions เข้า search_path เหมือน cert_issue_core ของ 0019 ไม่งั้น 42883 ก่อน insert
set search_path = public, extensions
as $fn$
declare
  v_uid uuid := auth.uid();
  v_token text;
  v_hash text;
  v_req record;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  -- SoD: บัญชีที่ถือบทบาทบริหารจัดการห้ามลบเอง — ติดต่อผู้ดูแลระบบ
  if public.has_any_role(array['instructor','staff:viewer','staff:content',
                               'staff:exam','staff:registrar','super_admin']) then
    raise exception
      'บัญชีที่มีบทบาทผู้สอนหรือเจ้าหน้าที่ไม่สามารถลบเองได้ กรุณาติดต่อผู้ดูแลระบบ (ERR-RBAC-001|account_delete_sod)'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = v_uid and deleted_at is not null) then
    raise exception 'บัญชีนี้ถูกลบไปแล้ว (ERR-VAL-001|already_deleted)'
      using errcode = '22023';
  end if;
  -- กัน spam อีเมล: มีคำขอค้างที่ยังใช้ได้อยู่แล้ว = ไม่ออก token ใหม่
  if exists (select 1 from public.account_deletion_requests r
             where r.user_id = v_uid
               and r.status = 'pending'
               and r.expires_at > now()) then
    raise exception 'ท่านมีคำขอลบบัญชีที่รอยืนยันอยู่แล้ว โปรดตรวจอีเมลของท่าน (ERR-VAL-001|delete_pending)'
      using errcode = '23505';
  end if;

  -- CSPRNG 43 อักษร: base64url (ไม่มี padding) ของไบต์สุ่ม 32 ตัว
  v_token := rtrim(translate(encode(gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  v_hash  := encode(sha256(convert_to(v_token, 'utf8')), 'hex');

  insert into public.account_deletion_requests (user_id, token_hash, expires_at)
  values (v_uid, v_hash, now() + interval '24 hours')
  returning id, expires_at into v_req;

  return jsonb_build_object(
    'requestId', v_req.id,
    'token', v_token,                -- ออกครั้งเดียว — BFF แต่งอีเมลเท่านั้น ห้าม log
    'expiresAt', v_req.expires_at,
    -- gate p5-r1 B1: userId คืนให้ BFF ด้วย — เดิม BFFเอา requestId ไปเรียก
    -- profiles/recipient_user_id ผิดทั้งสาย (503 หลังสร้างคำขอ + อีเมลตก)
    'userId', v_uid);
end;
$fn$;
alter function public.my_request_account_deletion(text) owner to app_owner;
revoke execute on function public.my_request_account_deletion(text) from public, anon;
grant execute on function public.my_request_account_deletion(text) to authenticated;


-- ─── confirm_account_deletion (สุดท้ายจาก 0036 — B2/B5/B6) ───
create or replace function public.confirm_account_deletion(
  p_token text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_hash text;
  v_req record;
begin
  if p_token is null or btrim(p_token) = '' then
    raise exception 'ข้อมูลไม่ถูกต้อง: ไม่พบรหัสยืนยัน (ERR-VAL-001|token_required)'
      using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(btrim(p_token), 'utf8')), 'hex');

  select id, user_id, status, expires_at into v_req
  from public.account_deletion_requests
  where token_hash = v_hash
  for update;
  if not found then
    -- gate p5-r1 B2 (DCR-12 เคส b): P0002 ผ่าน gateway ของ stack นี้ถูกตัดร่างกาย
    -- error ทิ้ง (BFF เห็น 500 "Something went wrong" — แท็กไปไม่ถึงหน้า UI) ·
    -- 22023 ผ่านร่างกายเต็ม (พิสูจน์แล้วด้วย token_used/token_expired ที่ใช้อยู่)
    -- errcode เปลี่ยนเพื่อการขนส่งเท่านั้น ข้อความ/แท็ก ERR-NF-001 คงเดิม
    raise exception 'รหัสยืนยันไม่ถูกต้อง (ERR-NF-001|token_not_found)'
      using errcode = '22023';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'รหัสยืนยันนี้ถูกใช้ไปแล้ว (ERR-VAL-001|token_used)'
      using errcode = '22023';
  end if;
  if v_req.expires_at <= now() then
    raise exception 'รหัสยืนยันหมดอายุแล้ว (24 ชั่วโมง) กรุณาขอใหม่ (ERR-VAL-001|token_expired)'
      using errcode = '22023';
  end if;

  -- gate p5-r1 B6: ตรวจ SoD ซ้ำใน TX ยืนยัน — ช่วงอายุ token 24 ชม. บัญชีอาจได้
  -- บทบาทเจ้าหน้าที่/ผู้สอนใหม่ (admin_grant_role) · เช็คสดใต้ per-account lock
  -- เดียวกับ grant/revoke (0035 §6) — raise ที่นี่ = TX ทั้งอัน rollback → คำขอ
  -- ยัง pending token ยังใช้ได้หลังปลดบทบาท (ไม่กลืน token เงียบ)
  perform pg_advisory_xact_lock(hashtext('ltc:account:roles:' || (v_req.user_id)::text)::bigint);
  if exists (select 1 from public.role_assignments ra
             where ra.user_id = v_req.user_id
               and ra.revoked_at is null
               and ra.role::text in ('instructor','staff:viewer','staff:content',
                                     'staff:exam','staff:registrar','super_admin')) then
    raise exception
      'บัญชีนี้มีบทบาทผู้สอนหรือเจ้าหน้าที่อยู่ จึงยืนยันการลบไม่ได้ กรุณาติดต่อผู้ดูแลระบบ (ERR-RBAC-001|sod_role_changed)'
      using errcode = '42501';
  end if;

  -- single-use: UPDATE ด้วย WHERE status='pending' AND expires_at > now() เป็นชั้น
  -- backstop ของ race (ยืนยันสองครั้งพร้อมกัน — ฝ่ายชนะ lock ก่อนผ่าน ฝ่ายหลัง
  -- เห็น status='confirmed' จาก FOR UPDATE re-read แล้วตก token_used ด้านบน)
  update public.account_deletion_requests
     set status = 'confirmed', confirmed_at = now()
   where id = v_req.id
     and status = 'pending'
     and expires_at > now();
  if not found then
    raise exception 'รหัสยืนยันนี้ถูกใช้ไปแล้ว (ERR-VAL-001|token_used)'
      using errcode = '22023';
  end if;

  -- soft-delete ที่เดียว: deleted_at + ซ่อนชื่อแสดง (anonymize ส่วนแสดงผล)
  update public.profiles
     set deleted_at = now(),
         display_name = 'บัญชีที่ขอลบแล้ว'
   where id = v_req.user_id;

  -- actor = เจ้าขอบบัญชีผู้ยื่น (ยืนยันตัวตนด้วย token อีเมล) · retention_note
  -- ตาม registry §2.2: ผลสอบ/audit เก็บต่อตามกฎหมาย (SEC-012)
  perform public.append_audit_event_internal(
    'PROFILE_DELETE', 'profile', (v_req.user_id)::text, null, null,
    jsonb_build_object(
      'target_user_id', v_req.user_id,
      'retention_note', 'เก็บผลการสอบและประวัติการตรวจสอบต่อตามที่กฎหมายกำหนด'),
    null, null, p_request_id, v_req.user_id);

  return jsonb_build_object('userId', v_req.user_id, 'confirmed', true);
end;
$fn$;
alter function public.confirm_account_deletion(text, text) owner to app_owner;
revoke execute on function public.confirm_account_deletion(text, text) from public, anon, authenticated;
grant execute on function public.confirm_account_deletion(text, text) to service_role, app_owner;


-- ─── admin_grant_role / admin_revoke_role (สุดท้ายจาก 0035 — B5 advisory lock) ───
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
  -- gate p5-r1 B5: per-account lock ก่อนแตะ role_assignments — สอง TX ถอนคนละ
  -- role พร้อมกันต้องไม่ผ่านด่าน last_role ทั้งคู่ (บัญชีไร้ role) · คู่กันกับ
  -- confirm_account_deletion (0036 §6 — SoD recheck ใต้ lock เดียวกัน)
  perform pg_advisory_xact_lock(hashtext('ltc:account:roles:' || p_user_id::text)::bigint);
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
  -- r2: role_assignments.role เป็น enum role_key — p_role (text) ต้อง cast ก่อนเทียบ/แทรก
  --     (ผ่าน whitelist ด้านบนมาแล้ว cast จึง fail ไม่ได้) ไม่งั้นพัง 42883
  --     "operator does not exist: role_key = text" ทุกคำขอ
  if exists (select 1 from public.role_assignments ra
             where ra.user_id = p_user_id
               and ra.role = p_role::public.role_key
               and ra.revoked_at is null) then
    return jsonb_build_object('userId', p_user_id, 'role', p_role, 'granted', false);
  end if;

  insert into public.role_assignments (user_id, role, granted_by, reason)
  values (p_user_id, p_role::public.role_key, v_actor, btrim(p_reason));

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
  -- gate p5-r1 B5: per-account lock ก่อนแตะ role_assignments — สอง TX ถอนคนละ
  -- role พร้อมกันต้องไม่ผ่านด่าน last_role ทั้งคู่ (บัญชีไร้ role) · คู่กันกับ
  -- confirm_account_deletion (0036 §6 — SoD recheck ใต้ lock เดียวกัน)
  perform pg_advisory_xact_lock(hashtext('ltc:account:roles:' || p_user_id::text)::bigint);
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if p_role = 'super_admin' then
    raise exception 'ข้อมูลไม่ถูกต้อง: บทบาทนี้จัดการที่ bootstrap เท่านั้น (ERR-VAL-001|role_not_manageable)'
      using errcode = '22023';
  end if;
  -- r2: ค่าต้องเป็น label จริงของ enum role_key ก่อนถึงชั้น cast ด้านล่าง —
  --     ค่าขยะ ('banana') cast แล้วเป็น 22P02 ไร้แท็ก · citizen ยังถอนได้ตามดีไซน์
  --     (ชั้น last_role ด้านล่างคือเงื่อนไขเดียวที่กันบัญชีไร้บทบาท)
  if p_role not in ('citizen','lawyer','instructor',
                    'staff:viewer','staff:content','staff:exam','staff:registrar') then
    raise exception 'ข้อมูลไม่ถูกต้อง: ไม่มีบทบาทนี้ในระบบ (ERR-VAL-001|role_not_manageable)'
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

  -- r2: cast ตามแบบแผนของ grant (whitelist enum ผ่านมาแล้ว — cast ปลอดภัย)
  update public.role_assignments
     set revoked_at = now(), reason = btrim(p_reason)
   where user_id = p_user_id
     and role = p_role::public.role_key
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


-- ─── notification_dispatch_tick (สุดท้ายจาก 0036 — B3 vars ตัวระบุเท่านั้น) ───
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
        -- 0036 §12 (r2 · NTF-005 "ที่ส่งเสมอ"): ธุรกรรมบังคับข้ามประตูทั้งสองช่องทาง
        -- — ไม่งั้นผู้ใช้ที่ยังไม่เคย grant email_notify จะไม่ได้รับผลตัดสินใบ
        -- อนุญาต/ลิงก์ข้อมูลส่งออกเลย
        if public.notification_email_mandatory(v_tpl_key) then
          v_in_app := true;
          v_email_ok := true;
        else
          v_in_app := public.notification_in_app_allowed(v_user, v_family);
          v_email_ok := public.notification_email_allowed(v_user, v_family);
        end if;
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


-- ─── email_complete (สุดท้ายจาก 0034 — M1 redaction + coalesce NULL) ───
create or replace function public.email_complete(p_results jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_item jsonb;
  v_id uuid;
  v_ok boolean;
  v_err text;
  v_sent int := 0;
  v_retried int := 0;
  v_invalid int := 0;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'ข้อมูลไม่ถูกต้อง: results ต้องเป็น array (ERR-VAL-001|results_must_be_array)'
      using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_results) loop
    begin
      v_id := nullif(v_item ->> 'id', '')::uuid;
      if v_id is null then
        v_invalid := v_invalid + 1;
        continue;
      end if;
      v_ok := coalesce((v_item ->> 'ok')::boolean, false);
      v_err := nullif(btrim(coalesce(v_item ->> 'error', '')), '');
      if v_ok then
        update public.email_outbox
        set status = 'sent', sent_at = now(), last_error = null,
            -- gate p5-r1 M1: ลิงก์ bearer (token ลบบัญชี / signed URL 7 วัน) จำเป็น
            -- เฉพาะตอนส่งอีเมลจริง — ถึงจุด sent แล้วถอดออกจาก payload ที่เก็บใน DB
            -- อะตอมกับเปลี่ยนสถานะ (แถวส่งไม่สำเร็จคงลิงก์ไว้ให้ retry ใช้ต่อ)
            payload = case
              when payload ? 'vars' and jsonb_typeof(payload -> 'vars') = 'object'
              then jsonb_set(payload, '{vars}',
                     (payload -> 'vars')
                     -- coalesce: CASE ไร้ ELSE คืน NULL เมื่อไม่มีลิงก์นั้น แล้ว
                     -- jsonb || NULL = NULL → payload ทั้งแถว NULL (dcr10 เคส 1 จับ)
                     || coalesce(case when payload -> 'vars' ? 'confirm_url'
                              then jsonb_build_object(
                                     'confirm_url', '[redacted-after-send]') end, '{}'::jsonb)
                     || coalesce(case when payload -> 'vars' ? 'download_url'
                              then jsonb_build_object(
                                     'download_url', '[redacted-after-send]') end, '{}'::jsonb))
              else payload end
        where id = v_id and status = 'sending';
        if found then
          v_sent := v_sent + 1;
          update public.notification_recipients nr
          set sent_at = coalesce(nr.sent_at, now())
          from public.email_outbox e
          where e.id = v_id
            and nr.channel = 'email'
            and nr.notification_id = (e.payload ->> 'notification_id')::uuid
            and nr.user_id = e.recipient_user_id;
        end if;
      else
        update public.email_outbox
        set attempts = attempts + 1,
            last_error = left(v_err, 500),
            status = case when attempts + 1 >= 5 then 'failed' else 'queued' end::public.email_status,
            scheduled_at = now() + make_interval(secs => least(60 * power(2, attempts + 1), 3600))
        where id = v_id and status = 'sending';
        if found then
          v_retried := v_retried + 1;
        end if;
      end if;
    exception when others then
      v_invalid := v_invalid + 1;
    end;
  end loop;
  return jsonb_build_object('sent', v_sent, 'retried', v_retried, 'invalid', v_invalid);
end;
$fn$;
