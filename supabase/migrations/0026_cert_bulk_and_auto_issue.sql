-- 0026_cert_bulk_and_auto_issue — Wave E Phase 2 ฐาน DB ของ E-4 (bulk issue) + E-6 (CRT-008)
-- lead-owned ตาม D36 · ออกแบบตาม D55-5 (bulk: batch 200 · TX-ต่อ-ใบ · audit actor ครบ) และ
-- D55-7 (CRT-008: async สแกน passed-no-valid-cert ≤5 นาที · idempotent · flag ปิด default ·
-- ห้าม sync ใน submit TX — ตัวนี้เป็น cron ล้วนไม่แตะ submit path)
--
-- ⚠️ ถูก 0027_cert_bulk_worker_redesign แทนบางส่วนแล้ว (codex gate r1 M1/M2/M3):
--   runner `admin_cert_bulk_issue_run` และ tick `cert_auto_issue_tick()` แบบ function
--   ถูก drop และแทนด้วย procedure commit-ต่อ-ใบของ 0027 (worker model — BFF POST
--   insert-only 202) · ส่วนที่ไฟล์นี้ยังเป็น canonical: โปรไฟล์ระบบ a170,
--   cert_issue_core v2 (p_mode), feature_flags + seed flag, policy D58 ของ
--   cert_bulk_jobs/feature_flags
--
-- สิ่งที่ไฟล์นี้ทำ:
--   (0) โปรไฟล์ระบบสำหรับ actor ของโหมด auto (profiles.id ไม่ผูก auth.users — seed ใส่ตรงได้)
--   (1) cert_issue_core เพิ่ม p_mode ('manual'|'bulk'|'auto' default 'manual') — audit CERT_ISSUE
--       บันทึก 'mode' ใน context ทุกใบ (D55-7) · เนื้อ core คัดลอก byte-verbatim จาก 0019:498-620
--       แล้วแต่เฉพาะ 3 จุด (พารามิเตอร์ + ตรวจค่า + context) · เปลี่ยน signature = ฟังก์ชันใหม่
--       จึง drop ตัวเก่าก่อน create และ revoke ใหม่ที่ตัวใหม่เสมอ (default ACL = PUBLIC)
--   (2) feature_flags + flag 'cert_auto_issue' default false (D55-7) — RLS fail-closed service_role
--   (3) admin_cert_bulk_issue_run(job_id, request_id) — รัน job จาก cert_bulk_jobs (0023): วน
--       admin_cert_bulk_pick ชุดละ 200 (ใบที่ออกสำเร็จหายจาก anti-join ทันที) ออกใบผ่าน
--       cert_issue_core(actor = ผู้สร้าง job, mode 'bulk') ต่อใบใต้ savepoint — ใบ+audit คู่เดียว
--       ต่อใบ ใบใดล้มยกเลิกเฉพาะใบนั้น (D55-5 "TX เดียวต่อใบ") · นับ issued/failed ลง job
--       ระหว่างทาง · จบเมื่อคิวหมด/ทั้งชุดล้ม/เพดาน 500 รอบ (status completed/failed)
--   (4) cert_auto_issue_tick() — CRT-008: อ่าน flag (ปิด = skip ไม่ audit) + advisory lock กันซ้อน +
--       pick สูงสุด 5 ชุด (≤1,000 ใบ/tick กัน TX ยาว) ออกใบ mode 'auto' actor = โปรไฟล์ระบบ
--   (5) pg_cron ทุก 2 นาที jobname 'ltc-cert-auto-issue' (upsert ตามแบบ 0020 — SRS AC ≤5 นาที)

-- ═══ (0) โปรไฟล์ระบบ (actor ของโหมด auto — ใบออกโดย job ไม่ใช่คน) ═══
insert into public.profiles (id, display_name, email, preferred_locale, is_active)
values ('00000000-0000-4000-8000-00000000a170',
        'ระบบออกใบอัตโนมัติ (CRT-008)', 'cert-auto@system.internal', 'th', true)
on conflict (id) do nothing;

-- ═══ (1) cert_issue_core v2 — p_mode + audit context 'mode' ═══
drop function if exists public.cert_issue_core(uuid, uuid, uuid, text);

create or replace function public.cert_issue_core(
  p_actor_user_id uuid,
  p_enrollment_id uuid,
  p_supersedes_cert_id uuid,
  p_request_id text,
  -- 0026 (D55-5/D55-7): โหมดออกใบ — manual (BFF ปลายทาง) · bulk (job ของ registrar)
  -- · auto (CRT-008) · default 'manual' ให้ผู้เรียกเดิมของ 0019 ใช้ได้ตามเดิม
  p_mode text default 'manual'
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $fn$
declare
  v_user uuid;
  v_course uuid;
  v_status text;
  v_deleted timestamptz;
  v_attempt uuid;
  v_holder text;
  v_title text;
  v_year text;
  v_digits text;
  v_cert_no text;
  v_verify text;
  v_bytes bytea;
  v_i int;
  v_j int;
  v_ok boolean := false;
  v_cert_id uuid;
  v_issued_at timestamptz;
begin
  -- 0026: โหมดนอกสามค่า = โปรแกรมเรียกผิด — ปฏิเสธก่อนแตะข้อมูลใด ๆ (fail-closed)
  if p_mode is null or p_mode not in ('manual', 'bulk', 'auto') then
    raise exception 'ข้อมูลไม่ถูกต้อง: โหมดการออกใบไม่ถูกต้อง (ERR-VAL-001|invalid_issue_mode)'
      using errcode = '22023';
  end if;
  -- ตรวจ enrollment: completed + ไม่ถูกลบล้าง (mirror issue.ts ของ D-4)
  select user_id, course_id, status, deleted_at
    into v_user, v_course, v_status, v_deleted
  from public.enrollments where id = p_enrollment_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|enrollment_not_found)';
  end if;
  if v_status <> 'completed' or v_deleted is not null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ผู้เรียนยังไม่จบหลักสูตรนี้ (ERR-VAL-001|enrollment_not_completed)';
  end if;
  -- มีใบ valid อยู่แล้ว (partial unique uq_certificates_enrollment_valid คุมเหมือนกัน)
  if exists (select 1 from public.certificates
             where enrollment_id = p_enrollment_id and status = 'valid') then
    raise exception 'ข้อมูลไม่ถูกต้อง: มีใบประกาศนียบัตรที่ยังไม่ถูกยกเลิกอยู่แล้ว (ERR-VAL-001|valid_certificate_exists)';
  end if;
  -- ต้องมี attempt ผ่านเกณฑ์ (ครั้งล่าสุดก่อน)
  select id into v_attempt from public.assessment_attempts
  where enrollment_id = p_enrollment_id
    and passed = true and submitted_at is not null
  order by attempt_no desc limit 1;
  if not found then
    raise exception 'ข้อมูลไม่ถูกต้อง: ไม่พบผลสอบที่ผ่านเกณฑ์ของหลักสูตรนี้ (ERR-VAL-001|no_passed_attempt)';
  end if;
  -- snapshot ชื่อผู้ถือใบ + ชื่อหลักสูตร (holderNameOf: ชื่อ-นามสกุล ไม่มีคือ display_name)
  -- r7-m3: holder_name_trim ทุกชั้น (แทน btrim) ให้ตรง .trim() ของ JS เป๊ะ —
  -- btrim ตัดช่องว่างเท่านั้น แท็บ/newline รอด ทำ holder_name ต่างจาก holderNameOf
  select coalesce(nullif(holder_name_trim(concat_ws(' ',
           nullif(holder_name_trim(pr.first_name), ''), nullif(holder_name_trim(pr.last_name), ''))), ''),
         nullif(holder_name_trim(pr.display_name), ''), '')
    into v_holder
  from public.profiles pr where pr.id = v_user;
  if not found then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cert_profile_lookup_failed)';
  end if;
  -- r7-M1: ชื่อผู้ถือใบว่าง (display_name='' และไม่มี first/last) = ข้อมูลไม่พร้อมออกใบ —
  -- ปฏิเสธก่อนสุ่มรหัส/INSERT/audit ให้ BFF ตอบ 400 (ERR-VAL-001) ตามสัญญา ไม่ใช่
  -- commit ใบแล้วให้ outbound .min(1) ตาย 503 กลางทาง (retry จะเจอ
  -- valid_certificate_exists — แก้ไม่ได้อีก) คิว eligible ยังเห็นแถวนี้อยู่ (holder_name='')
  if v_holder = '' then
    raise exception 'ข้อมูลไม่ถูกต้อง: ผู้ถือใบยังไม่มีชื่อสำหรับออกประกาศนียบัตร กรุณาให้ผู้เรียนกรอกชื่อก่อน (ERR-VAL-001|holder_name_missing)'
      using errcode = '22023';
  end if;
  select title_th into v_title from public.courses where id = v_course;
  if not found then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cert_course_lookup_failed)';
  end if;
  -- r7-M1: ชื่อหลักสูตรว่าง/ช่องว่างล้วน = สัญญาเดียวกัน — ปฏิเสธก่อน mutation
  v_title := nullif(holder_name_trim(v_title), '');
  if v_title is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: หลักสูตรนี้ยังไม่มีชื่อสำหรับออกประกาศนียบัตร (ERR-VAL-001|course_title_missing)'
      using errcode = '22023';
  end if;
  -- สุ่มรหัส CSPRNG (mirror shared.ts ของ D-4): cert_no = LTC-<ปี ค.ศ. Asia/Bangkok>-<6 หลัก>
  -- verify_code = 43 อักขระจาก alphabet เดียวกับ BFF (63 อักขระ — ตรวจนับจริงจาก literal
  -- ของ shared.ts L39 · get_byte % 63) · ชน UNIQUE (23505) → สุ่มใหม่ ไม่เกิน 5 ครั้ง
  v_year := to_char(now() at time zone 'Asia/Bangkok', 'YYYY');
  v_i := 0;
  loop
    v_i := v_i + 1;
    exit when v_i > 5;
    v_digits := lpad(abs(hashtextextended(gen_random_uuid()::text, 0) % 1000000)::text, 6, '0');
    v_cert_no := 'LTC-' || v_year || '-' || v_digits;
    v_bytes := gen_random_bytes(43);
    v_verify := '';
    for v_j in 0..42 loop
      v_verify := v_verify || substr('useandom-26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict',
                                     1 + (get_byte(v_bytes, v_j) % 63), 1);
    end loop;
    begin
      insert into public.certificates (
        cert_no, verify_code, enrollment_id, user_id, course_id,
        holder_name_snapshot, course_title_snapshot, issued_by, supersedes_cert_id)
      values (v_cert_no, v_verify, p_enrollment_id, v_user, v_course,
              v_holder, v_title, p_actor_user_id, p_supersedes_cert_id)
      returning id, issued_at into v_cert_id, v_issued_at;
      v_ok := true;
      exit;
    exception when unique_violation then
      v_ok := false; -- สุ่มชน → วนสุ่มใหม่
    end;
  end loop;
  if not v_ok then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-001|cert_code_retry_exhausted)';
  end if;
  perform public.append_audit_event_internal(
    'CERT_ISSUE', 'certificate', v_cert_id::text, null, null,
    jsonb_build_object('certificate_id', v_cert_id, 'code', v_cert_no,
                       'attempt_id', v_attempt, 'enrollment_id', p_enrollment_id, 'mode', p_mode),
    null, null, p_request_id, p_actor_user_id);
  return jsonb_build_object(
    'id', v_cert_id, 'cert_no', v_cert_no, 'verify_code', v_verify,
    'enrollment_id', p_enrollment_id, 'user_id', v_user, 'course_id', v_course,
    'holder_name', v_holder, 'course_title', v_title, 'issued_at', v_issued_at);
end;
$fn$;

alter function public.cert_issue_core(uuid, uuid, uuid, text, text) owner to app_owner;
revoke execute on function public.cert_issue_core(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
-- ไม่ grant ให้ผู้ใดโดยตรง — เรียกได้เฉพาะจาก wrapper ที่ควบคุม actor/mode เท่านั้น (เหมือน 0019)

-- ═══ (2) feature_flags — ที่เก็บ flag ของ job ระบบ (source of truth ฝั่ง DB · BFF อ่านอย่างเดียว) ═══
create table public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  enabled boolean not null default false,
  note text null,
  updated_at timestamptz not null default now(),
  updated_by uuid null references public.profiles (id)
);
alter table public.feature_flags enable row level security;
-- fail-closed ต่อ anon/authenticated (ไม่มี policy ของกลุ่มนั้น) — service_role ผ่าน BFF
-- อย่างเดียว · tick เป็น SECURITY DEFINER owner app_owner แต่ app_owner ไม่มี BYPASSRLS
-- และไม่ใช่เจ้าของตาราง → RLS ยังกรองแถว ต้องมี policy ของ app_owner เอง (แบบแผนเดียวกับ
-- app_owner_select_certificates ใน 0019) ไม่งั้น select-into เงียบ ๆ ได้ null = flag ปิดตลอด
revoke all on public.feature_flags from public, anon, authenticated;
grant select, update on public.feature_flags to service_role;
grant select on public.feature_flags to app_owner;
drop policy if exists app_owner_select_feature_flags on public.feature_flags;
create policy app_owner_select_feature_flags
  on public.feature_flags for select to app_owner
  using (true);
insert into public.feature_flags (key, enabled, note)
values ('cert_auto_issue', false,
        'CRT-008 (D55-7): เปิดแล้ว cron ออกใบให้ผู้ผ่านสอบที่ยังไม่มีใบ valid ทุก 2 นาที — default ปิด')
on conflict (key) do nothing;

-- ═══ (3) admin_cert_bulk_issue_run — รัน bulk job ของ E-4 (BFF เรียกหลังสร้าง job) ═══
create or replace function public.admin_cert_bulk_issue_run(
  p_job_id uuid,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $fn$
declare
  v_course uuid;
  v_actor uuid;
  v_status text;
  v_rounds int := 0;
  v_batch int;
  v_round_issued int;
  v_issued int := 0;
  v_failed int := 0;
  v_last_error text;
  r record;
begin
  if p_job_id is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุ job (ERR-VAL-001|job_id_required)'
      using errcode = '22023';
  end if;
  -- FOR UPDATE กันสอง runner รัน job เดียวกันซ้อน (job คนละใบทำงานขนานกันได้ —
  -- anti-join + unique กันออกใบซ้ำอยู่แล้ว)
  select course_id, created_by, status into v_course, v_actor, v_status
  from public.cert_bulk_jobs where id = p_job_id for update;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|bulk_job_not_found)';
  end if;
  if v_status in ('completed', 'failed') then
    raise exception 'ข้อมูลไม่ถูกต้อง: job นี้จบไปแล้ว สร้าง job ใหม่เพื่อออกส่วนที่เหลือ (ERR-VAL-001|bulk_job_already_finished)'
      using errcode = '22023';
  end if;
  update public.cert_bulk_jobs set status = 'running' where id = p_job_id;
  <<batches>>
  loop
    v_rounds := v_rounds + 1;
    v_batch := 0;
    v_round_issued := 0;
    for r in select * from public.admin_cert_bulk_pick(v_course, 200) loop
      v_batch := v_batch + 1;
      begin
        perform public.cert_issue_core(v_actor, r.enrollment_id, null, p_request_id, 'bulk');
        v_issued := v_issued + 1;
        v_round_issued := v_round_issued + 1;
      exception when others then
        v_failed := v_failed + 1;
        -- SQLERRM เป็นตัวแปรพิเศษของบล็อก exception ไม่ใช่ฟังก์ชัน —
        -- sqlerrm() พร้อมวงเล็บ = 42883 ทำ handler พังเอง กลายเป็น rollback ทั้ง TX
        -- (E-9 จับได้จาก integration: เส้นทางใบล้มเฉพาะใบตายทั้งชุด)
        v_last_error := left(sqlerrm, 500);
      end;
    end loop;
    -- ความคืบหน้าค้างจริงระหว่างทาง (job ล้มกลางคัน = เริ่มใหม่จากสิ่งที่เหลือ ไม่เสความนับ)
    update public.cert_bulk_jobs
    set total_attempts = v_issued + v_failed,
        issued_count = v_issued,
        failed_count = v_failed,
        last_error = v_last_error
    where id = p_job_id;
    exit when v_batch = 0;          -- คิวหมด
    exit when v_batch < 200;        -- ชุดไม่เต็ม = เศษท้ายคิว
    exit when v_round_issued = 0;   -- ทั้งชุดล้ม = ที่เหลือออกไม่ได้แล้ว จบนับ failed
    if v_rounds >= 500 then
      -- เพดานคุ้มครอง 500 รอบ × 200 = 100,000 ใบ/job — เกินถือว่าผิดปกติ ปิดเป็น failed
      -- (ไม่ raise เพราะ raise = rollback ทั้ง TX รวมความคืบหน้า)
      update public.cert_bulk_jobs
      set status = 'failed', finished_at = now(),
          total_attempts = v_issued + v_failed,
          issued_count = v_issued,
          failed_count = v_failed,
          last_error = coalesce(v_last_error, 'ถึงเพดานรอบของ job (ERR-SYS-002|bulk_round_limit)')
      where id = p_job_id;
      return jsonb_build_object('job_id', p_job_id, 'status', 'failed',
                                'total_attempts', v_issued + v_failed,
                                'issued_count', v_issued, 'failed_count', v_failed);
    end if;
  end loop batches;
  update public.cert_bulk_jobs
  set status = 'completed', finished_at = now(),
      total_attempts = v_issued + v_failed,
      issued_count = v_issued,
      failed_count = v_failed,
      last_error = v_last_error
  where id = p_job_id;
  return jsonb_build_object('job_id', p_job_id, 'status', 'completed',
                            'total_attempts', v_issued + v_failed,
                            'issued_count', v_issued, 'failed_count', v_failed);
end;
$fn$;
alter function public.admin_cert_bulk_issue_run(uuid, text) owner to app_owner;
revoke execute on function public.admin_cert_bulk_issue_run(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_cert_bulk_issue_run(uuid, text)
  to service_role;
-- runner เป็น DEFINER app_owner — 0023 ให้ cert_bulk_jobs แก่ service_role อย่างเดียว ต้องเพิ่ม
-- ให้ app_owner ด้วยจึง select-for-update + update ความคืบหน้าได้ · grant อย่างเดียวไม่พอ:
-- app_owner ไม่มี BYPASSRLS → ต้องมี policy SELECT (select for update ต้องมีทั้ง SELECT+UPDATE)
-- แบบแผนเดียวกับ app_owner_update_certificates ใน 0019
grant select, update on public.cert_bulk_jobs to app_owner;
drop policy if exists app_owner_select_cert_bulk_jobs on public.cert_bulk_jobs;
create policy app_owner_select_cert_bulk_jobs
  on public.cert_bulk_jobs for select to app_owner
  using (true);
drop policy if exists app_owner_update_cert_bulk_jobs on public.cert_bulk_jobs;
create policy app_owner_update_cert_bulk_jobs
  on public.cert_bulk_jobs for update to app_owner
  using (true) with check (true);

-- ═══ (4) cert_auto_issue_tick — CRT-008 (cron เรียก · BFF/tests เรียกได้เพื่อพิสูจน์) ═══
create or replace function public.cert_auto_issue_tick() returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $fn$
declare
  v_enabled boolean;
  v_rounds int := 0;
  v_batch int;
  v_round_issued int;
  v_issued int := 0;
  v_failed int := 0;
  r record;
begin
  select enabled into v_enabled from public.feature_flags where key = 'cert_auto_issue';
  if coalesce(v_enabled, false) = false then
    return jsonb_build_object('skipped', true, 'reason', 'flag_off');
  end if;
  if not pg_try_advisory_xact_lock(hashtext('ltc:cert_auto_issue')::bigint) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;
  <<batches>>
  loop
    v_rounds := v_rounds + 1;
    if v_rounds > 5 then exit; end if; -- ≤1,000 ใบ/tick กัน TX ยาว (รอบถัดไปมาใน 2 นาที)
    v_batch := 0;
    v_round_issued := 0;
    for r in select * from public.admin_cert_bulk_pick(null, 200) loop
      v_batch := v_batch + 1;
      begin
        perform public.cert_issue_core('00000000-0000-4000-8000-00000000a170'::uuid,
                                       r.enrollment_id, null, null, 'auto');
        v_issued := v_issued + 1;
        v_round_issued := v_round_issued + 1;
      exception when others then
        v_failed := v_failed + 1;
      end;
    end loop;
    exit when v_batch = 0;
    exit when v_batch < 200;
    exit when v_round_issued = 0;
  end loop batches;
  return jsonb_build_object('skipped', false, 'issued_count', v_issued, 'failed_count', v_failed);
end;
$fn$;
alter function public.cert_auto_issue_tick() owner to app_owner;
revoke execute on function public.cert_auto_issue_tick() from public, anon, authenticated;
grant execute on function public.cert_auto_issue_tick() to app_owner, service_role, postgres;

-- ═══ (5) cron ทุก 2 นาที (upsert ตาม jobname — รัน migration ซ้ำปลอดภัย เหมือน 0020) ═══
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'ltc-cert-auto-issue') then
    perform cron.unschedule('ltc-cert-auto-issue');
  end if;
  perform cron.schedule(
    'ltc-cert-auto-issue', '*/2 * * * *',
    'select public.cert_auto_issue_tick()');
end
$do$;
