-- 0027_cert_bulk_worker_redesign — แก้ codex gate r1 (Wave E Phase 2) M1+M2+M3
--
-- สิ่งที่ gate ตัดสิน (2026-09-12 · /tmp/codex-gate-e-p2-r1.txt):
--   M1 แถวที่ออกใบไม่ได้ปิดกั้นคิวทั้งหมด — 0026 หยิบ "200 แถวแรก" ซ้ำทุกรอบ
--      (anti-join ตัดเฉพาะใบที่ออกสำเร็จ) แถวที่ล้มอยู่หน้าคิวตลอดชีวิต เมื่อทั้ง
--      ชุดล้ม `exit when v_round_issued = 0` จบ job เป็น completed ทั้งที่แถวที่ 201+
--      ออกได้ · auto tick หยิบ 200 แถวเดิมทุก 2 นาที = แถวหลังก้อนล้มไม่มีวันได้ใบ
--      (ขัด SRS AC ≤5 นาที) → แก้ด้วย cursor ของ picker + เดินผ่านแถวที่ล้ม (ไม่มี
--      เงื่อนไขจบแบบ "ทั้งชุดล้ม" อีก — จบเมื่อ cursor หมดคิวเท่านั้น)
--   M2 ความคืบหน้าไม่ durable + ไม่ใช่ TX แยกจริงต่อใบ — runner เดิมเป็น FUNCTION
--      ทั้ง job จึงอยู่ใน TX เดียว: begin/exception ต่อใบเป็น subtransaction (savepoint)
--      ไม่ใช่ TX จริง · GET จาก connection อื่นไม่เห็น running/counts ระหว่างรัน ·
--      TX ถูกยกเลิก = ใบ+audit+counts ที่ "สำเร็จ" กลับเป็น pending ทั้งก้อน ขัดคำอ้าง
--      "ความคืบหน้าค้างจริงระหว่างทาง" → **function  COMMIT ไม่ได้ ต้องเป็น PROCEDURE**
--      แบบใหม่: ใบ + audit + ความคืบหน้าของ job commit พร้อมกันเป็น TX เดียว *ต่อใบ*
--      · job ล้ม/หยุดกลางทาง = แถว job เก็บ counts ณ จุดสุดท้าย (สถานะ running)
--      และรอบถัดไปเห็น "resume" จากคิวที่เหลือ (anti-join กันออกซ้ำ)
--   M3 integration test ของ auto เปิด flag กลางแล้ว sweep ทุกหลักสูตรใน DB ร่วม —
--      แถวนอก fixture ที่ผ่านเงื่อนไขถูกออกใบ+audit โดย test โดยไม่มี cleanup →
--      tick รับ p_course_id (null = ทุกหลักสูตร — cron ใช้ค่านี้) test ส่งหลักสูตร
--      ของ fixture เอง = แตะเฉพาะขอบเขตตัวเองโดยก่อสร้าง
--
-- การเปลี่ยนโมเดล (ตาม M2): BFF POST /admin/certificates/bulk เลิกเรียก runner ใน
-- request — insert job (status pending) ตอบ 202 แล้วจบ · worker `admin_cert_bulk_
-- issue_step` ถูก pg_cron ปลุกทุกนาทีหยิบ job ที่ยังไม่จบ (pending/running) มารัน
-- ต่อใบ-commit · tick กลายเป็น procedure เดินคิวแบบเดียวกัน
--
-- สิ่งที่ไฟล์นี้ทำ:
--   (1) admin_cert_bulk_pick v2 — เพิ่ม cursor (p_after_submitted_at, p_after_
--       attempt_id) ให้ caller เดินผ่านแถวที่ล้มได้ (M1) · signature เปลี่ยนจาก
--       (uuid, int) เป็น (uuid, int, timestamptz, uuid) จึง drop สร้างใหม่ + revoke/
--       grant ใหม่ · เลิก grant service_role (BFF ไม่เรียกเองแล้ว — 0023 ให้ตอนยัง
--       คิดว่า BFF จะลูปเอง เหลือผู้เรียกคือ runner ฝั่ง DB (app_owner เจ้าของ) เท่านั้น)
--   (2) ทิ้ง runner/tick แบบ function ของ0026 เปลี่ยนเป็น procedure:
--       admin_cert_bulk_issue_step(p_job_id, p_max_certs, inout p_result) และ
--       cert_auto_issue_tick(p_course_id, p_max_certs, inout p_result)
--   (3) cron: ตัวเดิม `ltc-cert-auto-issue` เปลี่ยน command เป็น call · เพิ่ม
--       `ltc-cert-bulk-step` ทุกนาที

-- ═══ (1) admin_cert_bulk_pick v2 — cursor ต่อคีย์ (submitted_at, attempt_id) ═══
drop function if exists public.admin_cert_bulk_pick(uuid, int);

create or replace function public.admin_cert_bulk_pick(
  p_course_id uuid default null,
  p_limit int default 200,
  p_after_submitted_at timestamptz default null,
  p_after_attempt_id uuid default null
) returns table (
  attempt_id uuid,
  enrollment_id uuid,
  user_id uuid,
  course_id uuid,
  holder_name text,
  score_pct smallint,
  submitted_at timestamptz
)
language sql stable security definer
set search_path = public
as $fn$
  select a.id,
         a.enrollment_id,
         a.user_id,
         e.course_id,
         coalesce(
           nullif(
             holder_name_trim(
               concat_ws(' ',
                 nullif(holder_name_trim(coalesce(p.first_name, '')), ''),
                 nullif(holder_name_trim(coalesce(p.last_name, '')), ''))),
             ''),
           nullif(holder_name_trim(p.display_name), ''),
           ''),
         a.score_pct,
         a.submitted_at
  from public.assessment_attempts a
  join public.enrollments e on e.id = a.enrollment_id
  join public.profiles p on p.id = a.user_id
  where a.passed
    and a.status = 'passed'
    and a.submitted_at is not null
    and e.status = 'completed'
    and e.deleted_at is null
    and e.completed_at is not null
    and not exists (select 1
                    from public.certificates c
                    where c.enrollment_id = a.enrollment_id
                      and c.status = 'valid')
    and (p_course_id is null or e.course_id = p_course_id)
    -- M1: cursor แถวคู่ (submitted_at, attempt_id) — ชุดถัดไปเริ่ม "หลัง" ตัวสุดท้าย
    -- ที่เห็นรอบก่อน *ไม่สนผลสำเร็จ* (แถวที่ล้มยังอยู่ใน anti-join แต่ cursor เดินผ่านแล้ว)
    and ((p_after_submitted_at is null and p_after_attempt_id is null)
         or (a.submitted_at, a.id) < (p_after_submitted_at, p_after_attempt_id))
  order by a.submitted_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$fn$;
alter function public.admin_cert_bulk_pick(uuid, int, timestamptz, uuid)
  owner to app_owner;
revoke execute on function public.admin_cert_bulk_pick(uuid, int, timestamptz, uuid)
  from public, anon, authenticated, service_role;

-- ═══ (2a) ทิ้ง runner/tick แบบ function ของ 0026 ═══
drop function if exists public.admin_cert_bulk_issue_run(uuid, text);
drop function if exists public.cert_auto_issue_tick();

-- ═══ (2b) admin_cert_bulk_issue_step — worker รัน job ต่อใบ-commit (M2) ═══
-- **ห้าม SECURITY DEFINER และห้าม SET search_path กับ procedure ที่ COMMIT**
-- (ข้อจำกัดของ PG ≥15: commit/rollback ใน procedure ที่เป็น definer หรือมี proconfig
--  = 0B000 invalid transaction termination — พิสูจน์ด้วย probe แยกทีละตัวบน dev 15.8)
-- จึงเป็น INVOKER ธรรมดา + อ้างชื่อแบบ 2-part ครบทุกตาราง/ฟังก์ชัน (ไม่พึ่ง path) ·
-- ขอบเขตสิทธิ์คุมที่ EXECUTE: revoke ทุก JWT role + service_role เหลือ postgres
-- (cron รันในนาม supabase_admin ซึ่งเป็น superuser ของ cluster นี้) — BFF ไม่เรียก
-- procedure นี้ (สร้าง job อย่างเดียว) จึงไม่มีช่องให้ service_role ยิงเข้ามา
-- เรียกโดย pg_cron `ltc-cert-bulk-step` (p_job_id null = หยิบ job เก่าที่สุดที่ยังไม่จบ)
-- · ตรง (p_job_id, p_max_certs) เพื่อพิสูจน์/ดำเนินการเจาะจง (integration tests)
-- ผลลัพธ์ (inout p_result):
--   {job_id, status:'idle'}                    ไม่มี job ค้าง (worker จบเร็ว)
--   {job_id, status:'locked'}                  worker ตัวอื่นถือ job นี้อยู่ (advisory lock)
--   {job_id, status:'running', ...counts}      ชนเพดาน p_max_certs กลางคิว — รอบถัดไปเล่นต่อ
--   {job_id, status:'completed'|'failed', ...counts}  เดินคิวจบ / เพดาน 100k ของ job
-- error: ERR-NF-001|bulk_job_not_found (job ไม่มี) · ERR-VAL-001|bulk_job_already_finished
--   (เรียกตรง job ที่จบแล้ว — worker ไม่หยิบ job เหล่านี้อยู่แล้ว)
create or replace procedure public.admin_cert_bulk_issue_step(
  p_job_id uuid default null,
  p_max_certs int default 1000,
  inout p_result jsonb default null
)
language plpgsql
as $proc$
declare
  v_max int := least(greatest(coalesce(p_max_certs, 1000), 1), 10000);
  v_job uuid;
  v_course uuid;
  v_actor uuid;
  v_status text;
  v_issued int;
  v_failed int;
  v_last_error text;
  v_lock bigint;
  v_after_ts timestamptz := null;
  v_after_aid uuid := null;
  v_done int := 0;
  v_capped boolean := false;
  v_cert_failed boolean;
  r record;
begin
  -- เลือก job: ระบุตรง หรือหยิบเก่าที่สุดที่ยังไม่จบ (worker) — pending = งานใหม่,
  -- running = job ที่ worker รอบก่อนหยุดกลางคัน (M2: resume จาก counts ที่ commit ไว้)
  if p_job_id is not null then
    v_job := p_job_id;
  else
    select id into v_job from public.cert_bulk_jobs
     where status in ('pending', 'running')
     order by created_at
     limit 1;
    if v_job is null then
      p_result := jsonb_build_object('job_id', null, 'status', 'idle');
      return;
    end if;
  end if;

  -- session advisory lock ต่อ job — ต้องเป็นระดับ session เพราะ row lock ของ
  -- FOR UPDATE หลุดที่ COMMIT แรก (M2 ทำ commit ต่อใบ) · เมื่อ procedure จบ/ล้ม
  -- เซสชัน pg_cron กับ psql ครั้งเดียวของ test ปิดทันที = lock คืนโดยอัตโนมัติ
  v_lock := hashtext('ltc:cert-bulk-job:' || v_job::text)::bigint;
  if not pg_try_advisory_lock(v_lock) then
    p_result := jsonb_build_object('job_id', v_job, 'status', 'locked');
    return;
  end if;

  select course_id, created_by, status, issued_count, failed_count, last_error
    into v_course, v_actor, v_status, v_issued, v_failed, v_last_error
  from public.cert_bulk_jobs where id = v_job;
  if not found then
    perform pg_advisory_unlock(v_lock);
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|bulk_job_not_found)';
  end if;
  if v_status in ('completed', 'failed') then
    perform pg_advisory_unlock(v_lock);
    raise exception 'ข้อมูลไม่ถูกต้อง: job นี้จบไปแล้ว สร้าง job ใหม่เพื่อออกส่วนที่เหลือ (ERR-VAL-001|bulk_job_already_finished)';
  end if;

  if v_status = 'pending' then
    update public.cert_bulk_jobs set status = 'running' where id = v_job;
    commit;
  end if;

  <<queue>>
  loop
    -- หยิบทีละแถวผ่าน cursor (แถวถัดไปที่ (submitted_at, attempt_id) น้อยกว่าตัวที่
    -- เห็นล่าสุด) — เดินหน้าทีละใบเพราะ commit ต่อใบ ทำให้ถือ portal/array ค้างข้าม
    -- commit ไม่ได้ · LIMIT 1 จาก SRF ได้ตามปกติ
    select * into r from public.admin_cert_bulk_pick(v_course, 1, v_after_ts, v_after_aid);
    exit when not found;
    -- M1: cursor บันทึกตำแหน่งแถวนี้ *ก่อน* ออกใบ — ไม่ว่าใบนี้จะสำเร็จหรือล้ม รอบ
    -- ถัดไปเดินผ่านไปแถวหลังจากนี้เสมอ (แถวที่ล้มไม่ block คิวอีกต่อไป)
    v_after_ts := r.submitted_at;
    v_after_aid := r.attempt_id;
    v_cert_failed := false;
    begin
      perform public.cert_issue_core(v_actor, r.enrollment_id, null, null, 'bulk');
    exception when others then
      -- ใบนี้ตายเฉพาะใบ (subtransaction ย้อน insert+audit ของใบนี้) · SQLERRM เป็น
      -- ตัวแปรของบล็อก exception ไม่ใช่ฟังก์ชัน (D59)
      v_failed := v_failed + 1;
      v_last_error := left(sqlerrm, 500);
      v_cert_failed := true;
    end;
    if not v_cert_failed then
      v_issued := v_issued + 1;
    end if;
    -- M2: ใบ + audit (เกิดใน cert_issue_core) + ความคืบหน้าของ job = TX เดียวต่อใบ
    -- (commit อยู่นอกบล็อก exception — ใน PL/pgSQL ห้าม commit ในบล็อกที่มี handler)
    update public.cert_bulk_jobs
      set total_attempts = v_issued + v_failed,
          issued_count = v_issued,
          failed_count = v_failed,
          last_error = v_last_error
    where id = v_job;
    commit;
    v_done := v_done + 1;
    if v_done >= v_max then
      v_capped := true;
      exit queue;
    end if;
    -- เพดานคุ้มครองของ job ทั้ง job (สะสมข้ามรอบ worker): 100k แถว — เกินถือว่าผิดปกติ
    if v_issued + v_failed >= 100000 then
      update public.cert_bulk_jobs
        set status = 'failed', finished_at = now(),
            total_attempts = v_issued + v_failed,
            issued_count = v_issued,
            failed_count = v_failed,
            last_error = coalesce(v_last_error, 'ถึงเพดานจำนวนแถวของ job (ERR-SYS-002|bulk_row_limit)')
      where id = v_job;
      commit;
      p_result := jsonb_build_object('job_id', v_job, 'status', 'failed',
        'total_attempts', v_issued + v_failed,
        'issued_count', v_issued, 'failed_count', v_failed);
      perform pg_advisory_unlock(v_lock);
      return;
    end if;
  end loop queue;

  if v_capped then
    -- ยังไม่รู้ว่าคิวหมดหรือยัง (ชนเพดานกลางทาง) — คงสถานะ running รอ worker รอบถัดไป:
    -- รอบนั้น pick ได้ 0 แถว = ปิด completed เอง (self-healing · M2 resume)
    p_result := jsonb_build_object('job_id', v_job, 'status', 'running',
      'total_attempts', v_issued + v_failed,
      'issued_count', v_issued, 'failed_count', v_failed);
  else
    update public.cert_bulk_jobs
      set status = 'completed', finished_at = now(),
          total_attempts = v_issued + v_failed,
          issued_count = v_issued,
          failed_count = v_failed,
          last_error = v_last_error
    where id = v_job;
    commit;
    p_result := jsonb_build_object('job_id', v_job, 'status', 'completed',
      'total_attempts', v_issued + v_failed,
      'issued_count', v_issued, 'failed_count', v_failed);
  end if;
  perform pg_advisory_unlock(v_lock);
end;
$proc$;
alter procedure public.admin_cert_bulk_issue_step(uuid, int, jsonb) owner to app_owner;
revoke execute on procedure public.admin_cert_bulk_issue_step(uuid, int, jsonb)
  from public, anon, authenticated, service_role;
-- ผู้เรียก: pg_cron (supabase_admin — superuser), test/ops ผ่าน psql, app_owner (เจ้าของ)
grant execute on procedure public.admin_cert_bulk_issue_step(uuid, int, jsonb)
  to app_owner, postgres;

-- ═══ (2c) cert_auto_issue_tick — procedure เดินผ่านแถวล้ม + scope ได้ (M1+M3) ═══
-- CRT-008 (D55-7): cron เรียกทุก 2 นาทีแบบ p_course_id=null (ทุกหลักสูตร) ·
-- integration test ส่งหลักสูตรของ fixture เอง — sweep แตะเฉพาะขอบเขตที่ระบุ
-- (M3: DB ร่วมไม่โดนแถวนอก fixture) · per-cert commit แบบเดียวกับ bulk worker
create or replace procedure public.cert_auto_issue_tick(
  p_course_id uuid default null,
  p_max_certs int default 1000,
  inout p_result jsonb default null
)
language plpgsql
as $proc$
declare
  v_max int := least(greatest(coalesce(p_max_certs, 1000), 1), 10000);
  v_enabled boolean;
  v_lock bigint;
  v_after_ts timestamptz := null;
  v_after_aid uuid := null;
  v_issued int := 0;
  v_failed int := 0;
  v_done int := 0;
  v_cert_failed boolean;
  r record;
begin
  select enabled into v_enabled from public.feature_flags where key = 'cert_auto_issue';
  if coalesce(v_enabled, false) = false then
    p_result := jsonb_build_object('skipped', true, 'reason', 'flag_off');
    return;
  end if;
  -- session-level (ไม่ใช่ xact) เพราะ commit ต่อใบ — กัน tick ซ้อน tick ข้าม commit
  v_lock := hashtext('ltc:cert-auto-issue')::bigint;
  if not pg_try_advisory_lock(v_lock) then
    p_result := jsonb_build_object('skipped', true, 'reason', 'already_running');
    return;
  end if;

  <<queue>>
  loop
    select * into r from public.admin_cert_bulk_pick(p_course_id, 1, v_after_ts, v_after_aid);
    exit when not found;
    -- M1: เดินผ่านแถวที่ล้ม (cursor บันทึกก่อนออกใบ เหมือน bulk worker)
    v_after_ts := r.submitted_at;
    v_after_aid := r.attempt_id;
    v_cert_failed := false;
    begin
      perform public.cert_issue_core('00000000-0000-4000-8000-00000000a170'::uuid,
                                     r.enrollment_id, null, null, 'auto');
    exception when others then
      v_failed := v_failed + 1;
      v_cert_failed := true;
    end;
    if not v_cert_failed then
      v_issued := v_issued + 1;
    end if;
    commit; -- ใบ + audit ต่อใบ (M2) — ไม่มีแถว job ให้ update ในโหมด auto
    v_done := v_done + 1;
    if v_done >= v_max then
      exit queue;
    end if;
  end loop queue;

  p_result := jsonb_build_object('skipped', false,
    'issued_count', v_issued, 'failed_count', v_failed);
  perform pg_advisory_unlock(v_lock);
end;
$proc$;
alter procedure public.cert_auto_issue_tick(uuid, int, jsonb) owner to app_owner;
revoke execute on procedure public.cert_auto_issue_tick(uuid, int, jsonb)
  from public, anon, authenticated, service_role;
grant execute on procedure public.cert_auto_issue_tick(uuid, int, jsonb)
  to app_owner, postgres;

-- ═══ (3) cron — command เดิมเป็น select ของ function ที่ถูก drop แล้ว: ตั้งใหม่ ═══
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'ltc-cert-auto-issue') then
    perform cron.unschedule('ltc-cert-auto-issue');
  end if;
  perform cron.schedule(
    'ltc-cert-auto-issue', '*/2 * * * *',
    'call public.cert_auto_issue_tick(null, 1000, null)');
  if exists (select 1 from cron.job where jobname = 'ltc-cert-bulk-step') then
    perform cron.unschedule('ltc-cert-bulk-step');
  end if;
  perform cron.schedule(
    'ltc-cert-bulk-step', '* * * * *',
    'call public.admin_cert_bulk_issue_step(null, 1000, null)');
end
$do$;
