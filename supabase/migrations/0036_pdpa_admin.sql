-- ═══ 0036_pdpa_admin — Wave E Phase 5 (PDPA export/delete + ADM-001/AUD-003 · DCR-11) ═══
-- แผน .omc/plans/wave-e-p5-plan.md (D-p5-7/8/9/10) · doc-first: API-SPEC 1.2.0 ·
-- DD 1.3.0 · AUDIT-LOG-DESIGN 1.0.4 · RTM 1.1.0
--
-- หลักการเดียวกับ 0032/0035 (atomic RPC ฉบับ gate-approved):
--   1. mutation+audit atomic — my_request_data_export / complete_data_export_job /
--      confirm_account_deletion เขียน audit ผ่าน append_audit_event_internal ใน TX
--      เดียวกับ mutation (AUDIT §1.5 class ก)
--   2. single-path lockdown — ตารางใหม่ทั้งสอง REVOKE write ตรงจากทุกบทบาท JWT
--      (service_role รวม — worker ใช้ RPC claim/complete/fail เท่านั้น) · path เดียว = RPC
--   3. roles + aal2 ตรวจในตัวทุก RPC ฝั่ง admin (admin_dashboard_stats /
--      admin_list_audit_logs — แบบแผน 0032 B3)
--
-- token ลบบัญชี: CSPRNG 43 อักษร (base64url ของ gen_random_bytes(32)) — ระบบเก็บ
-- sha256 เท่านั้น ตัว token ออกจาก my_request_account_deletion ครั้งเดียวทาง return
-- ให้ BFF แต่งอีเมลเท่านั้น (ห้าม log — D24) · confirm ผ่าน route สาธารณะของ BFF
-- ซึ่งเรียก RPC นี้ด้วย service client (ไม่มี session — ตัวตนคือ token เอง)
--
-- event data_export.ready payload: user_id + source_id (= job_id → ref_id ของ tick)
-- + job_id + file_media_id (tick สาขา data_export.ready อ่าน job_id/file_media_id —
-- 0035 §11 · {{download_url}} ประกอบที่ email worker จาก storage)
--
-- idempotent ทั้งไฟล์ (create table if not exists · create or replace ·
-- drop-if-exists policy · create index if not exists)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── (1) data_export_jobs — PDPA data portability job (DD §3.1 · D-p5-7) ───
create table if not exists public.data_export_jobs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete restrict,
  status        text not null default 'pending'
                check (status in ('pending','processing','done','failed')),
  file_media_id uuid references public.media_assets(id) on delete restrict,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  error         text,
  constraint data_export_jobs_done_has_file
    check (status <> 'done' or file_media_id is not null)
);

create unique index if not exists uq_data_export_jobs_active
  on public.data_export_jobs(user_id)
  where status in ('pending','processing');            -- กันยื่นซ้ำขณะค้าง (BFF map 409)
create index if not exists idx_data_export_jobs_status_requested
  on public.data_export_jobs(status, requested_at);   -- worker scan

alter table public.data_export_jobs enable row level security;

-- single-path: เขียนผ่าน RPC เท่านั้น (ผู้ยื่น = my_request_data_export ·
-- worker = claim/complete/fail — ทั้งคู่ SECURITY DEFINER app_owner)
revoke insert, update, delete on public.data_export_jobs from anon, authenticated, service_role;
grant select on public.data_export_jobs to authenticated, service_role;
grant select, insert, update on public.data_export_jobs to app_owner;

drop policy if exists dej_select_owner on public.data_export_jobs;
create policy dej_select_owner on public.data_export_jobs
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists dej_select_service on public.data_export_jobs;
create policy dej_select_service on public.data_export_jobs
  for select to service_role
  using (true);

-- definer (app_owner) ต้องเห็นแถวด้วย — ไม่งั้น claim_data_export_job เห็นคิวว่าง
-- เงียบ ๆ (แบบแผน app_owner_select_* ของทุกตารางอื่น)
drop policy if exists app_owner_select_data_export_jobs on public.data_export_jobs;
create policy app_owner_select_data_export_jobs on public.data_export_jobs
  for select to app_owner
  using (true);

drop policy if exists app_owner_insert_data_export_jobs on public.data_export_jobs;
create policy app_owner_insert_data_export_jobs on public.data_export_jobs
  for insert to app_owner with check (true);

drop policy if exists app_owner_update_data_export_jobs on public.data_export_jobs;
create policy app_owner_update_data_export_jobs on public.data_export_jobs
  for update to app_owner using (true) with check (true);

-- ─── (2) account_deletion_requests — SEC-012 soft-delete (DD §3.1 · D-p5-8) ───
create table if not exists public.account_deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete restrict,
  token_hash   text not null,                          -- sha256 hex — ตัว token ไม่เก็บที่ไหน
  expires_at   timestamptz not null,                   -- requested + 24 ชม.
  status       text not null default 'pending'
               check (status in ('pending','confirmed','expired')),
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint account_deletion_requests_confirmed_has_time
    check (status <> 'confirmed' or confirmed_at is not null)
);

create unique index if not exists uq_account_deletion_requests_token
  on public.account_deletion_requests(token_hash);
create index if not exists idx_account_deletion_requests_user
  on public.account_deletion_requests(user_id, requested_at desc);

alter table public.account_deletion_requests enable row level security;

-- token เป็น secret — ผู้ใช้ไม่อ่านตารางนี้ผ่าน client ได้เลย (ไม่มี policy authenticated)
revoke insert, update, delete on public.account_deletion_requests from anon, authenticated, service_role;
revoke select on public.account_deletion_requests from anon, authenticated;
grant select on public.account_deletion_requests to service_role;
grant select, insert, update on public.account_deletion_requests to app_owner;

drop policy if exists adr_select_service on public.account_deletion_requests;
create policy adr_select_service on public.account_deletion_requests
  for select to service_role
  using (true);

-- แบบเดียวกัน: confirm_account_deletion (definer app_owner) ต้อง lookup token_hash ได้
drop policy if exists app_owner_select_account_deletion_requests on public.account_deletion_requests;
create policy app_owner_select_account_deletion_requests on public.account_deletion_requests
  for select to app_owner
  using (true);

drop policy if exists app_owner_insert_account_deletion_requests on public.account_deletion_requests;
create policy app_owner_insert_account_deletion_requests on public.account_deletion_requests
  for insert to app_owner with check (true);

drop policy if exists app_owner_update_account_deletion_requests on public.account_deletion_requests;
create policy app_owner_update_account_deletion_requests on public.account_deletion_requests
  for update to app_owner using (true) with check (true);

-- ─── (3) my_request_data_export — ผู้ใช้ขอส่งออกข้อมูลตน (D-p5-7) ───
-- BFF GET /profile/export เรียกด้วย user JWT → ตอบ 202 {jobId,status}
create or replace function public.my_request_data_export(
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_job record;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  -- กันยื่นซ้ำขณะค้าง (uq_data_export_jobs_active เป็นชั้นที่สอง)
  if exists (select 1 from public.data_export_jobs j
             where j.user_id = v_uid
               and j.status in ('pending','processing')) then
    raise exception 'ท่านมีคำขอส่งออกข้อมูลที่กำลังดำเนินการอยู่ กรุณารอเสร็จก่อน (ERR-VAL-001|export_pending)'
      using errcode = '23505';
  end if;
  -- cooldown 24 ชม. จาก done ล่าสุด (งานหนัก — คุ้มค่าต่อการกัน spam)
  if exists (select 1 from public.data_export_jobs j
             where j.user_id = v_uid
               and j.status = 'done'
               and j.completed_at > now() - interval '24 hours') then
    raise exception 'ท่านส่งออกข้อมูลล่าสุดไปแล้วในช่วง 24 ชั่วโมง กรุณารอก่อนขอใหม่ (ERR-VAL-001|export_cooldown)'
      using errcode = '22023';
  end if;

  insert into public.data_export_jobs (user_id, status)
  values (v_uid, 'pending')
  returning id, user_id, status, requested_at into v_job;

  perform public.append_audit_event_internal(
    'DATA_EXPORT_REQUEST', 'data_export_job', (v_job.id)::text, null, null,
    jsonb_build_object('job_id', v_job.id),
    null, null, p_request_id, v_uid);

  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status);
end;
$fn$;
alter function public.my_request_data_export(text) owner to app_owner;
revoke execute on function public.my_request_data_export(text) from public, anon;
grant execute on function public.my_request_data_export(text) to authenticated;

-- ─── (4) worker RPC: claim / complete / fail (D-p5-7 — service_role เท่านั้น) ───
-- worker = internal job route /api/internal/jobs/pdpa-export (แบบแผน email-dispatch)
-- claim ทีละแถวด้วย FOR UPDATE SKIP LOCKED — worker หลายตัวไม่แย่งแถวเดียวกัน
create or replace function public.claim_data_export_job() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_job record;
begin
  select id, user_id into v_job
  from public.data_export_jobs
  where status = 'pending'
  order by requested_at, id
  limit 1
  for update skip locked;
  if not found then
    return jsonb_build_object('jobId', null);
  end if;
  update public.data_export_jobs
     set status = 'processing'
   where id = v_job.id;
  return jsonb_build_object('jobId', v_job.id, 'userId', v_job.user_id);
end;
$fn$;
alter function public.claim_data_export_job() owner to app_owner;
revoke execute on function public.claim_data_export_job() from public, anon, authenticated;
grant execute on function public.claim_data_export_job() to service_role, app_owner;

-- complete: →done + file_media_id + audit DATA_EXPORT_DONE + event data_export.ready
-- (BFF worker อัปโหลดไฟล์ JSON ไป bucket pdpa-exports และ insert media_assets
--  ด้วย service client ก่อนเรียกตัวนี้ — ไฟล์อยู่นอก DB TX โดยธรรมชาติ)
create or replace function public.complete_data_export_job(
  p_job_id uuid,
  p_file_media_id uuid,
  p_chunks int,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid;
begin
  if p_file_media_id is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุไฟล์ผลลัพธ์ (ERR-VAL-001|file_media_id_required)'
      using errcode = '22023';
  end if;
  select user_id into v_user
  from public.data_export_jobs
  where id = p_job_id and status = 'processing'
  for update;
  if not found then
    raise exception 'ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)'
      using errcode = 'P0002';
  end if;

  update public.data_export_jobs
     set status = 'done',
         file_media_id = p_file_media_id,
         completed_at = now(),
         error = null
   where id = p_job_id;

  -- actor ระบบ (worker) = null ตาม audit_logs.actor_user_id NULL = ระบบ
  perform public.append_audit_event_internal(
    'DATA_EXPORT_DONE', 'data_export_job', (p_job_id)::text, null, null,
    jsonb_build_object(
      'job_id', p_job_id,
      'file_media_id', p_file_media_id,
      'chunks', p_chunks),
    null, null, p_request_id, null);

  -- payload: source_id = job_id (→ ref_id ของ tick) · job_id/file_media_id สำหรับ
  -- สาขา vars ของ tick (0035 §11) — download_url ประกอบที่ email worker จาก storage
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
alter function public.complete_data_export_job(uuid, uuid, int, text) owner to app_owner;
revoke execute on function public.complete_data_export_job(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function public.complete_data_export_job(uuid, uuid, int, text) to service_role, app_owner;

create or replace function public.fail_data_export_job(
  p_job_id uuid,
  p_error text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_cnt int;
begin
  update public.data_export_jobs
     set status = 'failed',
         completed_at = now(),
         error = left(p_error, 500)     -- ตัดทอน · ห้าม PII (ความรับผิดชอบของ worker)
   where id = p_job_id and status = 'processing';
  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    raise exception 'ไม่พบงานส่งออกที่กำลังดำเนินการตามรหัสนี้ (ERR-NF-001|job_not_processing)'
      using errcode = 'P0002';
  end if;
  return jsonb_build_object('jobId', p_job_id, 'status', 'failed');
end;
$fn$;
alter function public.fail_data_export_job(uuid, text) owner to app_owner;
revoke execute on function public.fail_data_export_job(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_data_export_job(uuid, text) to service_role, app_owner;

-- ─── (5) my_request_account_deletion — ขอลบบัญชี + สร้าง token (D-p5-8) ───
-- คืน token ตัวจริงครั้งเดียวทาง return → BFF แต่งอีเมล account.delete.confirm
-- เท่านั้น (ห้าม log — D24) · ไม่มี audit แยก: การยืนยันจริงคือ event PROFILE_DELETE
create or replace function public.my_request_account_deletion(
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
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
    'expiresAt', v_req.expires_at);
end;
$fn$;
alter function public.my_request_account_deletion(text) owner to app_owner;
revoke execute on function public.my_request_account_deletion(text) from public, anon;
grant execute on function public.my_request_account_deletion(text) to authenticated;

-- ─── (6) confirm_account_deletion — single-use token → soft-delete (D-p5-8) ───
-- เรียกโดย BFF route สาธารณะ GET /profile/delete/confirm ผ่าน service client —
-- ไม่มี session ตัวตนคือ token เอง · GoTrue ban ทำที่ BFF หลัง RPC สำเร็จ
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
    raise exception 'รหัสยืนยันไม่ถูกต้อง (ERR-NF-001|token_not_found)'
      using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'รหัสยืนยันนี้ถูกใช้ไปแล้ว (ERR-VAL-001|token_used)'
      using errcode = '22023';
  end if;
  if v_req.expires_at <= now() then
    raise exception 'รหัสยืนยันหมดอายุแล้ว (24 ชั่วโมง) กรุณาขอใหม่ (ERR-VAL-001|token_expired)'
      using errcode = '22023';
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

-- ─── (7) admin_dashboard_stats — KPI สด + กรองวันที่ (D-p5-9 · ADM-001) ───
-- report:view ตาม permission matrix (RBAC §2): sv/se/sr/sa — aggregate สดไม่มี
-- PII รายบุคคล จึงไม่ต้องแยกขอบเขตรายบทบาท · lag ≤15 นาที = ไม่ใช้ MV
create or replace function public.admin_dashboard_stats(
  p_from date,
  p_to date
) returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_from date;
  v_to date;
  v_users_total bigint;
  v_users_new bigint;
  v_enroll_new bigint;
  v_attempts bigint;
  v_passed bigint;
  v_certs bigint;
  v_credits numeric;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  if not public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|report_view_forbidden)'
      using errcode = '42501';
  end if;
  v_to   := coalesce(p_to, current_date);
  v_from := coalesce(p_from, v_to - 29);
  if v_from > v_to then
    raise exception 'ข้อมูลไม่ถูกต้อง: วันเริ่มต้นต้องไม่หลังวันสิ้นสุด (ERR-VAL-001|date_range)'
      using errcode = '22023';
  end if;

  select count(*) into v_users_total
  from public.profiles where deleted_at is null;

  select count(*) into v_users_new
  from public.profiles
  where created_at::date >= v_from and created_at::date <= v_to;

  select count(*) into v_enroll_new
  from public.enrollments
  where enrolled_at::date >= v_from and enrolled_at::date <= v_to
    and deleted_at is null;

  select count(*), count(*) filter (where passed)
    into v_attempts, v_passed
  from public.assessment_attempts
  where submitted_at is not null
    and submitted_at::date >= v_from and submitted_at::date <= v_to;

  select count(*) into v_certs
  from public.certificates
  where issued_at::date >= v_from and issued_at::date <= v_to;

  select coalesce(sum(amount), 0) into v_credits
  from public.credit_ledger_entries
  where entry_type = 'accrual'
    and created_at::date >= v_from and created_at::date <= v_to;

  return jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to),
    'users', jsonb_build_object('new', v_users_new, 'total', v_users_total),
    'enrollments', jsonb_build_object('new', v_enroll_new),
    'exams', jsonb_build_object(
      'attempts', v_attempts,
      'passed', v_passed,
      'passRatePct', case when v_attempts > 0
                          then round(v_passed * 100.0 / v_attempts, 1)
                          else null end),
    'certificates', jsonb_build_object('issued', v_certs),
    'credits', jsonb_build_object('issued', v_credits));
end;
$fn$;
alter function public.admin_dashboard_stats(date, date) owner to app_owner;
revoke execute on function public.admin_dashboard_stats(date, date) from public, anon;
grant execute on function public.admin_dashboard_stats(date, date) to authenticated;

-- ─── (8) admin_list_audit_logs — filter + keyset (D-p5-10 · AUD-003) ───
-- audit_log:view ตาม RBAC §2.4: staff:viewer + super_admin · คืนเฉพาะคอลัมน์
-- แสดงผล (context/request_id) — ไม่เปิด before/after/hash ผ่าน endpoint นี้
create or replace function public.admin_list_audit_logs(
  p_action text,                 -- prefix match เช่น 'LICENSE' / 'ROLE_'
  p_actor uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_cursor_occurred_at timestamptz,
  p_cursor_id uuid,
  p_limit int
) returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_action text;
  v_rows jsonb;
  v_has_more boolean;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  if not public.has_any_role(array['staff:viewer', 'super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|audit_view_forbidden)'
      using errcode = '42501';
  end if;
  v_action := nullif(btrim(coalesce(p_action, '')), '');
  if v_action is not null and length(v_action) > 100 then
    raise exception 'ข้อมูลไม่ถูกต้อง: คำค้นยาวเกิน 100 อักขระ (ERR-VAL-001|action_length)'
      using errcode = '22023';
  end if;
  if p_entity_type is not null and length(p_entity_type) > 100 then
    raise exception 'ข้อมูลไม่ถูกต้อง: entity_type ยาวเกิน 100 อักขระ (ERR-VAL-001|entity_type_length)'
      using errcode = '22023';
  end if;

  -- has_more จากแถวเกิน (limit+1) — ห้าม count(*) over () คู่ jsonb_agg (บทเรียน 0032)
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    into v_rows
  from (
    select id, occurred_at, actor_user_id, actor_roles, action,
           entity_type, entity_id, context, request_id
      from public.audit_logs a
     where (v_action is null or a.action like v_action || '%')
       and (p_actor is null or a.actor_user_id = p_actor)
       and (p_entity_type is null or a.entity_type = p_entity_type)
       and (p_entity_id is null or a.entity_id = p_entity_id)
       and (p_from is null or a.occurred_at >= p_from)
       and (p_to is null or a.occurred_at <= p_to)
       and (p_cursor_occurred_at is null
            or (a.occurred_at, a.id) < (p_cursor_occurred_at, p_cursor_id))
     order by a.occurred_at desc, a.id desc
     limit v_limit + 1
  ) t;

  v_has_more := jsonb_array_length(v_rows) > v_limit;
  if v_has_more then
    v_rows := v_rows - (jsonb_array_length(v_rows) - 1); -- ตัดแถวสุดท้าย (เกินโควตา — desc)
  end if;

  return jsonb_build_object(
    'data', v_rows,
    'nextCursor', case when coalesce(v_has_more, false) and jsonb_array_length(v_rows) > 0
                       then jsonb_build_object(
                              'occurredAt', (v_rows -> jsonb_array_length(v_rows) - 1) ->> 'occurred_at',
                              'id', (v_rows -> jsonb_array_length(v_rows) - 1) ->> 'id')
                       else null end);
end;
$fn$;
alter function public.admin_list_audit_logs(text, uuid, text, uuid, timestamptz, timestamptz, timestamptz, uuid, int) owner to app_owner;
revoke execute on function public.admin_list_audit_logs(text, uuid, text, uuid, timestamptz, timestamptz, timestamptz, uuid, int) from public, anon;
grant execute on function public.admin_list_audit_logs(text, uuid, text, uuid, timestamptz, timestamptz, timestamptz, uuid, int) to authenticated;

-- ─── (9) profiles: UPDATE สำหรับ app_owner (confirm_account_deletion เท่านั้น) ───
-- 0010 ให้ app_owner แค่ SELECT+INSERT · policy เจ้าของ (authenticated) มี trigger
-- guard จำกัดคอลัมน์ self-edit — app_owner เป็น path ระบบ (definer ของ RPC เรา)
-- จึงเปิด UPDATE แบบเดียวกับแบบแผน app_owner_update_* ของ 0035 §12
grant update on public.profiles to app_owner;
drop policy if exists app_owner_update_profiles on public.profiles;
create policy app_owner_update_profiles on public.profiles
  for update to app_owner using (true) with check (true);

-- ─── (10) guard_profiles_update_columns: ยอมรับ definer path ของ app_owner ───
-- สำเนา 0010 เต็ม + แก้จุดเดียว: เงื่อนไข exemption แรกเดิมอ่าน
-- current_setting('role') (SET ROLE) ซึ่งไม่ถูกตั้งใน SECURITY DEFINER function
-- เด็ดขาด (SET ROLE ห้ามใช้ใน definer context) → confirm_account_deletion
-- (definer app_owner) ถูก guard บล็อกที่ deleted_at ทั้งที่ DD §3.1 กำหนดให้
-- RPC นี้เป็นผู้เขียนจริง · เพิ่ม current_user = 'app_owner' (จริงเฉพาะใน
-- definer ของ RPC ระบบของเรา / session app_owner — path เดียวกับเจตนาเดิมของ 0010)
-- พฤติกรรมอื่นทุกทางคงเดิมเป๊ะ (create or replace ไม่เปลี่ยนเจ้าของฟังก์ชัน)
create or replace function public.guard_profiles_update_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  k text;
  r jsonb := to_jsonb(new);
  o jsonb := to_jsonb(old);
begin
  if coalesce(current_setting('role', true), '') in ('service_role','app_owner')
     or current_user = 'app_owner' then   -- 0036: definer path (SET ROLE ใช้ใน definer ไม่ได้)
    return new;
  end if;
  for k in select jsonb_object_keys(r) loop
    -- NB: not (k = any(...)) — "ไม่อยู่ในชุด" (k <> any(...) คือ "ต่างจากสักตัว" = จริงเกือบทุกคีย์)
    if not (k = any (array['display_name','phone','preferred_locale','pdpa_consented_at']))
       and (r -> k) is distinct from (o -> k)
       and not public.has_any_role(array['super_admin']) then
      raise exception 'profiles: เจ้าของแถวแก้ได้เฉพาะ display_name/phone/preferred_locale/pdpa_consented_at — คอลัมน์อื่นเป็นของ super_admin (DD §3.1 — D20-M2): %', k;
    end if;
  end loop;
  return new;
end;
$fn$;
