-- 0028_cert_cursor_durable — แก้ codex gate r2 (Wave E Phase 2) MAJOR-1/MAJOR-2 + MINOR-3
--
-- สิ่งที่ gate ตัดสิน (2026-09-12 · /tmp/codex-gate-e-p2-r2.txt):
--   MAJOR-1 cursor ของ 0027 อยู่ในหน่วยความจำของ procedure อย่างเดียว — ทุก CALL
--      เริ่ม v_after_* = null ใหม่: job/tick ที่ชนเพดานกลางคิวแล้วถูกเรียกรอบถัดไป
--      หยิบแถวล้มชุดเดิมซ้ำจากหัวคิว (M1 กลับมาเมื่อข้าม CALL — คนท้ายคิวไม่มีวัน
--      ได้ใบ · failed_count นับซ้ำจนชนเพดาน 100k) → แก้: **cursor durable**
--      · bulk: คอลัมน์ cursor_submitted_at/cursor_attempt_id ของ cert_bulk_jobs
--        commit พร้อม counts ใน TX เดียวต่อใบ (at-least-once — ไม่มีแถวถูกข้าม)
--      · auto: ตาราง cert_auto_cursor เก็บ cursor ต่อ scope (uuid ของหลักสูตร ·
--        '*' = ทุกหลักสูตรของ cron — test กับ cron ไม่รบกวนกัน) · เมื่อ sweep จบ
--        (คิวหมด) reset เป็น null = รอบ retry ใหม่ — แถวที่เคยล้มถูกลองใหม่รอบ
--        ถัดไป แต่งานต่อ tick ยังถูก cap คุมอยู่เสมอ (bounded)
--   MAJOR-2 เพดาน 100,000 แถวของ job ถูกข้ามได้ — 0027 ออกจากลูปเมื่อชน v_max
--      *ก่อน* ตรวจเพดาน (p_max_certs=1 จะไม่ตรวจเลย · ครบ 100,000 พอดียังคืน
--      running) → แก้: ตรวจยอดสะสม (1) ก่อนเริ่มลูป — job ที่ถึงเพดานอยู่แล้วปิด
--      failed ทันที (2) หลัง update counts ทุกแถว *ก่อน* branch ชน v_max
--   MINOR-3 builtin ที่ไม่ qualify ยังพึ่ง search_path ของ caller (hashtext ·
--      pg_try_advisory_lock · left · now · ฯลฯ) → ทุกฟังก์ชันจริงใน body ใหม่ระบุ
--      pg_catalog. ครบ · (ยกเว้น coalesce/nullif ซึ่งเป็น special syntax ของ
--      parser ไม่ผ่าน search_path อยู่แล้ว — ใส่ prefix ไม่ได้)
--
-- ข้อจำกัด PG ≥15 (D60) ยังบังคับ: procedure ที่ COMMIT ต้อง INVOKER เปล่า —
--   ไม่มี security definer ไม่มี set search_path (0B000) · อ้างชื่อ 2-part ครบ

-- ⚠️ SUPERSEDED (ส่วน tick) โดย 0029_cert_auto_arrival_first.sql — codex gate r3
--    (2026-09-12 · /tmp/codex-gate-e-p2-r3.txt) พบ MAJOR-1 ฝั่ง auto: แถวที่ส่ง
--    ใหม่กว่า cursor มองไม่เห็นจนกว่า sweep เก่าจะหมดคิวและ reset — ผู้ผ่านเงื่อนไข
--    ที่มากลาง sweep รอเกิน 5 นาทีได้ (ขัด SRS AC ≤5 นาที) → 0029 แทนที่
--    cert_auto_issue_tick ด้วย tick สองเฟส (fresh lane ก่อน backlog + คู่ขอบบน
--    sweep_top ใน cert_auto_cursor · picker ใหม่ admin_cert_auto_fresh_pick) ·
--    สิ่งที่ยัง canonical จากไฟล์นี้: step ของ bulk (admin_cert_bulk_issue_step) +
--    คอลัมน์ cursor ของ cert_bulk_jobs + ตาราง cert_auto_cursor (0029 เติมคอลัมน์)

-- ═══ (1) คอลัมน์ cursor ของ bulk job (MAJOR-1) ═══
alter table public.cert_bulk_jobs
  add column if not exists cursor_submitted_at timestamptz,
  add column if not exists cursor_attempt_id uuid;
comment on column public.cert_bulk_jobs.cursor_submitted_at is
  '0028 MAJOR-1: ตำแหน่งเดินคิวล่าสุดของ worker (คู่กับ cursor_attempt_id) — commit พร้อม counts ทีละใบ · null = ยังไม่เริ่ม/จบ sweep';
comment on column public.cert_bulk_jobs.cursor_attempt_id is
  '0028 MAJOR-1: attempt ล่าสุดที่เดินผ่าน (tie-break เมื่อ submitted_at ซ้ำ)';

-- ═══ (2) ตาราง cursor ของ auto tick ต่อ scope (MAJOR-1) ═══
create table if not exists public.cert_auto_cursor (
  scope_key text primary key check (scope_key <> ''),
  cursor_submitted_at timestamptz,
  cursor_attempt_id uuid,
  updated_at timestamptz not null default now()
);
comment on table public.cert_auto_cursor is
  '0028 MAJOR-1: cursor ของ cert_auto_issue_tick ต่อ scope — scope_key = uuid หลักสูตร หรือ ''*'' = ทุกหลักสูตร (cron) · cursor null = เริ่ม sweep ใหม่ (retry แถวที่เคยล้ม)';
alter table public.cert_auto_cursor enable row level security;
-- fail-closed ต่อ anon/authenticated (ไม่มี policy ของกลุ่มนั้น) · service_role ไม่ต้องใช้
-- (BFF ไม่แตะ — ตารางภายในของ worker เท่านั้น)
revoke all on public.cert_auto_cursor from public, anon, authenticated, service_role;
-- D58: app_owner (invoker ที่ได้ EXECUTE ของ tick) ไม่มี BYPASSRLS และไม่ใช่เจ้าของ
-- ตาราง → ต้องมี policy เป็นของตัวเอง (upsert ต้องมีทั้ง insert+update · on conflict
-- ตรวจแถวด้วย select จึงต้องมี select ด้วย)
grant select, insert, update on public.cert_auto_cursor to app_owner;
drop policy if exists app_owner_select_cert_auto_cursor on public.cert_auto_cursor;
create policy app_owner_select_cert_auto_cursor
  on public.cert_auto_cursor for select to app_owner using (true);
drop policy if exists app_owner_insert_cert_auto_cursor on public.cert_auto_cursor;
create policy app_owner_insert_cert_auto_cursor
  on public.cert_auto_cursor for insert to app_owner with check (true);
drop policy if exists app_owner_update_cert_auto_cursor on public.cert_auto_cursor;
create policy app_owner_update_cert_auto_cursor
  on public.cert_auto_cursor for update to app_owner using (true) with check (true);

-- ═══ (3) admin_cert_bulk_issue_step — cursor durable + เพดานตรวจก่อน branch (MAJOR-1/2) ═══
-- แทนที่ procedure ของ 0027 ทั้งตัว (create or replace) · สัญญา inout p_result
-- เท่าเดิมทุกประการ — 5 คีย์ (completed/running) · 2 คีย์ (idle/locked) · raise
-- ERR-NF-001|bulk_job_not_found / ERR-VAL-001|bulk_job_already_finished
create or replace procedure public.admin_cert_bulk_issue_step(
  p_job_id uuid default null,
  p_max_certs int default 1000,
  inout p_result jsonb default null
)
language plpgsql
as $proc$
declare
  -- clamp p_max_certs ลง [1, 10000] ด้วย CASE ล้วน (parser syntax — ไม่พึ่ง
  -- search_path และไม่ต้องตอบว่า least/greatest เป็นฟังก์ชันหรือ special form)
  v_max int := case when coalesce(p_max_certs, 1000) < 1 then 1
                    when coalesce(p_max_certs, 1000) > 10000 then 10000
                    else coalesce(p_max_certs, 1000) end;
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
  -- running = job ที่ worker รอบก่อนหยุดกลางคัน (M2: resume จาก counts + cursor
  -- ที่ commit ไว้ — MAJOR-1: ไม่เริ่มหัวคิวใหม่อีก)
  if p_job_id is not null then
    v_job := p_job_id;
  else
    select id into v_job from public.cert_bulk_jobs
     where status in ('pending', 'running')
     order by created_at
     limit 1;
    if v_job is null then
      p_result := pg_catalog.jsonb_build_object('job_id', null, 'status', 'idle');
      return;
    end if;
  end if;

  -- session advisory lock ต่อ job — ระดับ session เพราะ row lock ของ FOR UPDATE
  -- หลุดที่ COMMIT แรก (commit ต่อใบ) · session ของ pg_cron/psql ปิด = คืนเอง
  v_lock := pg_catalog.hashtext('ltc:cert-bulk-job:' || v_job::text)::bigint;
  if not pg_catalog.pg_try_advisory_lock(v_lock) then
    p_result := pg_catalog.jsonb_build_object('job_id', v_job, 'status', 'locked');
    return;
  end if;

  -- MAJOR-1: รับ cursor ที่ commit ไว้รอบก่อน มาเป็นจุดเริ่มของรอบนี้
  select course_id, created_by, status, issued_count, failed_count, last_error,
         cursor_submitted_at, cursor_attempt_id
    into v_course, v_actor, v_status, v_issued, v_failed, v_last_error, v_after_ts, v_after_aid
  from public.cert_bulk_jobs where id = v_job;
  if not found then
    perform pg_catalog.pg_advisory_unlock(v_lock);
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|bulk_job_not_found)';
  end if;
  if v_status in ('completed', 'failed') then
    perform pg_catalog.pg_advisory_unlock(v_lock);
    raise exception 'ข้อมูลไม่ถูกต้อง: job นี้จบไปแล้ว สร้าง job ใหม่เพื่อออกส่วนที่เหลือ (ERR-VAL-001|bulk_job_already_finished)';
  end if;

  -- MAJOR-2 (1): ตรวจเพดานสะสม *ก่อนเริ่ม* — job ที่ถึง 100,000 ไว้แล้ว (จากรอบ
  -- ก่อน) ปิด failed ทันที ไม่ประมวลผลแถวใดอีก
  if v_issued + v_failed >= 100000 then
    update public.cert_bulk_jobs
      set status = 'failed', finished_at = pg_catalog.now(),
          last_error = coalesce(v_last_error, 'ถึงเพดานจำนวนแถวของ job (ERR-SYS-002|bulk_row_limit)')
      where id = v_job;
    commit;
    p_result := pg_catalog.jsonb_build_object('job_id', v_job, 'status', 'failed',
      'total_attempts', v_issued + v_failed,
      'issued_count', v_issued, 'failed_count', v_failed);
    perform pg_catalog.pg_advisory_unlock(v_lock);
    return;
  end if;

  if v_status = 'pending' then
    update public.cert_bulk_jobs set status = 'running' where id = v_job;
    commit;
  end if;

  <<queue>>
  loop
    -- หยิบทีละแถวผ่าน cursor (แถวถัดไปที่ (submitted_at, attempt_id) น้อยกว่าตัว
    -- ที่เห็นล่าสุด) — เดินหน้าทีละใบเพราะ commit ต่อใบ ถือ portal/array ค้างข้าม
    -- commit ไม่ได้ · LIMIT 1 จาก SRF ได้ตามปกติ
    select * into r from public.admin_cert_bulk_pick(v_course, 1, v_after_ts, v_after_aid);
    exit when not found;
    -- M1: cursor บันทึกตำแหน่งแถวนี้ *ก่อน* ออกใบ — ไม่ว่าใบนี้จะสำเร็จหรือล้ม
    v_after_ts := r.submitted_at;
    v_after_aid := r.attempt_id;
    v_cert_failed := false;
    begin
      perform public.cert_issue_core(v_actor, r.enrollment_id, null, null, 'bulk');
    exception when others then
      -- ใบนี้ตายเฉพาะใบ (subtransaction ย้อน insert+audit ของใบนี้) · SQLERRM เป็น
      -- ตัวแปรของบล็อก exception ไม่ใช่ฟังก์ชัน (D59)
      v_failed := v_failed + 1;
      v_last_error := pg_catalog.left(sqlerrm, 500);
      v_cert_failed := true;
    end;
    if not v_cert_failed then
      v_issued := v_issued + 1;
    end if;
    -- M2 + MAJOR-1: ใบ + audit (เกิดใน cert_issue_core) + counts + **cursor** ของ
    -- job = TX เดียวต่อใบ — หยุดกลางคันแล้วรอบถัดไปเดินต่อจากตำแหน่งนี้เป๊ะ ๆ
    update public.cert_bulk_jobs
       set total_attempts = v_issued + v_failed,
           issued_count = v_issued,
           failed_count = v_failed,
           last_error = v_last_error,
           cursor_submitted_at = v_after_ts,
           cursor_attempt_id = v_after_aid
     where id = v_job;
    commit;
    v_done := v_done + 1;
    -- MAJOR-2 (2): ตรวจเพดานสะสม *ก่อน* branch ชน v_max — ทุกแถวที่ประมวลผลจริง
    -- ถูกตรวจเสมอ (รวม p_max_certs=1 และกรณีครบ 100,000 พอดี → ปิด failed รอบเดียวกัน)
    if v_issued + v_failed >= 100000 then
      update public.cert_bulk_jobs
        set status = 'failed', finished_at = pg_catalog.now(),
            total_attempts = v_issued + v_failed,
            issued_count = v_issued,
            failed_count = v_failed,
            last_error = coalesce(v_last_error, 'ถึงเพดานจำนวนแถวของ job (ERR-SYS-002|bulk_row_limit)')
      where id = v_job;
      commit;
      p_result := pg_catalog.jsonb_build_object('job_id', v_job, 'status', 'failed',
        'total_attempts', v_issued + v_failed,
        'issued_count', v_issued, 'failed_count', v_failed);
      perform pg_catalog.pg_advisory_unlock(v_lock);
      return;
    end if;
    if v_done >= v_max then
      v_capped := true;
      exit queue;
    end if;
  end loop queue;

  if v_capped then
    -- ยังไม่รู้ว่าคิวหมดหรือยัง (ชนเพดานกลางทาง) — คงสถานะ running รอ worker รอบ
    -- ถัดไป: รอบนั้น *เดินต่อจาก cursor* (MAJOR-1) และเมื่อ pick ได้ 0 แถว =
    -- ปิด completed เอง (self-healing · M2 resume)
    p_result := pg_catalog.jsonb_build_object('job_id', v_job, 'status', 'running',
      'total_attempts', v_issued + v_failed,
      'issued_count', v_issued, 'failed_count', v_failed);
  else
    update public.cert_bulk_jobs
      set status = 'completed', finished_at = pg_catalog.now(),
          total_attempts = v_issued + v_failed,
          issued_count = v_issued,
          failed_count = v_failed,
          last_error = v_last_error
    where id = v_job;
    commit;
    p_result := pg_catalog.jsonb_build_object('job_id', v_job, 'status', 'completed',
      'total_attempts', v_issued + v_failed,
      'issued_count', v_issued, 'failed_count', v_failed);
  end if;
  perform pg_catalog.pg_advisory_unlock(v_lock);
end;
$proc$;
alter procedure public.admin_cert_bulk_issue_step(uuid, int, jsonb) owner to app_owner;
revoke execute on procedure public.admin_cert_bulk_issue_step(uuid, int, jsonb)
  from public, anon, authenticated, service_role;
grant execute on procedure public.admin_cert_bulk_issue_step(uuid, int, jsonb)
  to app_owner, postgres;

-- ═══ (4) cert_auto_issue_tick — cursor durable ต่อ scope + sweep จบ = retry รอบใหม่ (MAJOR-1) ═══
-- แทนที่ procedure ของ 0027 · สัญญา inout p_result เท่าเดิม: {skipped,reason} /
-- {skipped,issued_count,failed_count} · advisory lock แยกตาม scope (tick ของ cron
-- กับ tick ของ test คนละ scope ไม่ตีกัน — แถวที่ทับกันยังกันซ้ำด้วย
-- uq_certificates_enrollment_valid ของ cert_issue_core อยู่แล้ว)
create or replace procedure public.cert_auto_issue_tick(
  p_course_id uuid default null,
  p_max_certs int default 1000,
  inout p_result jsonb default null
)
language plpgsql
as $proc$
declare
  -- clamp เหมือน bulk step (CASE ล้วน — ไม่พึ่ง search_path)
  v_max int := case when coalesce(p_max_certs, 1000) < 1 then 1
                    when coalesce(p_max_certs, 1000) > 10000 then 10000
                    else coalesce(p_max_certs, 1000) end;
  v_enabled boolean;
  v_lock bigint;
  v_scope text := coalesce(p_course_id::text, '*');
  v_after_ts timestamptz := null;
  v_after_aid uuid := null;
  v_issued int := 0;
  v_failed int := 0;
  v_done int := 0;
  v_capped boolean := false;
  v_cert_failed boolean;
  r record;
begin
  select enabled into v_enabled from public.feature_flags where key = 'cert_auto_issue';
  if coalesce(v_enabled, false) = false then
    p_result := pg_catalog.jsonb_build_object('skipped', true, 'reason', 'flag_off');
    return;
  end if;
  -- session-level (ไม่ใช่ xact) เพราะ commit ต่อใบ — กัน tick ซ้อน tick ข้าม commit
  v_lock := pg_catalog.hashtext('ltc:cert-auto-issue:' || v_scope)::bigint;
  if not pg_catalog.pg_try_advisory_lock(v_lock) then
    p_result := pg_catalog.jsonb_build_object('skipped', true, 'reason', 'already_running');
    return;
  end if;

  -- MAJOR-1: รับ cursor ของ scope นี้จากรอบก่อน (ไม่มีแถว = sweep ใหม่ cursor null)
  select cursor_submitted_at, cursor_attempt_id into v_after_ts, v_after_aid
    from public.cert_auto_cursor where scope_key = v_scope;

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
    -- MAJOR-1: cursor + ใบ + audit = TX เดียวต่อใบ (upsert แถวของ scope นี้)
    insert into public.cert_auto_cursor (scope_key, cursor_submitted_at, cursor_attempt_id, updated_at)
    values (v_scope, v_after_ts, v_after_aid, pg_catalog.now())
    on conflict (scope_key) do update
      set cursor_submitted_at = excluded.cursor_submitted_at,
          cursor_attempt_id = excluded.cursor_attempt_id,
          updated_at = excluded.updated_at;
    commit;
    v_done := v_done + 1;
    if v_done >= v_max then
      v_capped := true;
      exit queue;
    end if;
  end loop queue;

  -- sweep จดจบ: ออกจากลูปเพราะคิวหมด (ไม่ใช่ชนเพดาน) หรือชนเพดานแล้ว probe ยืนยัน
  -- ว่าคิวหมดจริง → reset cursor ของ scope = รอบถัดไปเริ่มหัวคิว (retry แถวที่เคย
  -- ล้ม · แถวใหม่ submitted_at ใหม่กว่าอยู่หัวคิวอยู่แล้วตาม AC ≤5 นาที)
  if v_capped then
    select * into r from public.admin_cert_bulk_pick(p_course_id, 1, v_after_ts, v_after_aid);
  end if;
  if not v_capped or not found then
    update public.cert_auto_cursor
       set cursor_submitted_at = null, cursor_attempt_id = null, updated_at = pg_catalog.now()
     where scope_key = v_scope;
    commit;
  end if;

  p_result := pg_catalog.jsonb_build_object('skipped', false,
    'issued_count', v_issued, 'failed_count', v_failed);
  perform pg_catalog.pg_advisory_unlock(v_lock);
end;
$proc$;
alter procedure public.cert_auto_issue_tick(uuid, int, jsonb) owner to app_owner;
revoke execute on procedure public.cert_auto_issue_tick(uuid, int, jsonb)
  from public, anon, authenticated, service_role;
grant execute on procedure public.cert_auto_issue_tick(uuid, int, jsonb)
  to app_owner, postgres;
