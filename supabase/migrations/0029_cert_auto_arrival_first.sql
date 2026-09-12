-- 0029_cert_auto_arrival_first — แก้ codex gate r3 (Wave E Phase 2) MAJOR-1 ฝั่ง auto tick
-- ⚠️ SUPERSEDED (ส่วน tick + fresh picker) โดย 0030_cert_auto_walked_markers.sql —
--    codex gate r4 (2026-09-12 · /tmp/codex-gate-e-p2-r4.txt) พบ MAJOR-1: แถวที่ commit ช้า
--    (submitted_at = now() ตอน*เริ่ม* TX ของ 0020 — visibility สลับลำดับกับเวลาได้) ตกช่วง
--    (cursor, sweep_top) = ล่องหนจน sweep จบ และ MAJOR-2: สถานะ 0028 ค้าง (คู่เดียว null)
--    ไม่ถูก 0029 normalize → 0030 แทนที่ cert_auto_issue_tick (marker ต่อแถวใน cert_auto_walked ·
--    picker admin_cert_auto_unmarked_pick) และ drop admin_cert_auto_fresh_pick ·
--    สิ่งที่ยัง canonical จากไฟล์นี้: คอลัมน์ sweep_top_* ของ cert_auto_cursor (0030 เหลือเป็น
--    ข้อมูลชี้แจง — หัวของ sweep) · คู่ cursor ยังเป็นของ 0028
--
--
-- สิ่งที่ gate ตัดสิน (2026-09-12 · /tmp/codex-gate-e-p2-r3.txt):
--   MAJOR-1 cursor ของ auto tick (0028) ทำให้ "แถวใหม่" (submitted_at ใหม่กว่า cursor)
--      มองไม่เห็นจนกว่า sweep เก่าจะหมดคิวและ reset — ผู้ผ่านเงื่อนไขใหม่ที่เข้ามา
--      กลาง sweep รอเกิน 5 นาทีได้ (ขัด SRS AC ≤5 นาที): ตัวอย่างของ gate — คิวชื่อว่าง
--      4,000 แถว เดิน 1,000/tick ทุก 2 นาที ผู้ผ่านใหม่ที่มาหลัง tick แรกได้ใบตอนนาที 8
--      ทั้งที่ตัวเองออกได้ทันที
--      → แก้: **tick สองเฟส** (งบประมวลผลเดียวกัน — รับแถวใหม่ก่อน เสมอ):
--      (a) fresh lane — แถวที่ (submitted_at, attempt_id) ใหม่กว่า "ขอบบนของ sweep"
--          (sweep_top = แถวใหม่ที่สุดที่ถูกเดินแล้วในรอบนี้) ถูกรับ*ก่อน* backlog
--          เรียง asc (ผู้รอนานสุดก่อนในกลุ่มผู้มาใหม่) ผ่าน picker ใหม่
--          admin_cert_auto_fresh_pick · watermark เดินผ่านแถวใหม่ที่ล้มเหมือนกัน
--          = แถวใหม่ที่ล้มไม่กินงบ fresh ซ้ำทุก tick (บล็อกผู้มาใหม่รอบหลังไม่ได้)
--      (b) backlog lane — เดิน desc ใต้ cursor เหมือน 0028 (retry แถวที่เคยล้ม ·
--          คิวเดิมที่ยังไม่ถึง) · แถวแรกที่เดินของ sweep ใหม่ = ขอบบน (sweep_top)
--      (c) sweep จบ (คิวหมดตามธรรมชาติ หรือชนเพดานงบแล้ว probe backlog ยืนยันว่า
--          หมด) → reset cursor + sweep_top เป็น null = รอบ retry ใหม่ (เหมือน 0028)
--      ไม่มีแถวถูกข้าม: ชุดที่เดินแล้วของ sweep = ช่วงต่อเนื่อง [cursor, sweep_top]
--      โดยก่อสร้าง — ระหว่างสอง watermark ไม่มีแถวที่ยังไม่ถูกเดิน
--
-- สัญญา inout p_result เท่าเดิมทุกประการกับ 0027/0028 ({skipped,reason} /
--   {skipped,issued_count,failed_count}) — cron/BFF/เทสเดิมไม่พัง ·
--   (MAJOR-2 ของ r3 เป็นเรื่อง isolation ของ integration test — แก้ที่ไฟล์เทส
--   ด้วย DB แยก ไม่ใช่ที่นี่)
--
-- ข้อจำกัด PG ≥15 (D60) ยังบังคับ: procedure ที่ COMMIT ต้อง INVOKER เปล่า —
--   ไม่มี security definer ไม่มี set search_path (0B000) · อ้างชื่อ 2-part ครบ ·
--   builtin ใน body ของ procedure qualify pg_catalog (ยกเว้น coalesce/nullif —
--   special syntax ของ parser) · picker ใหม่เป็น FUNCTION (ไม่ COMMIT) จึงใช้
--   security definer + set search_path ได้ตามแบบ admin_cert_bulk_pick ของ 0027

-- ═══ (1) คอลัมน์ขอบบนของ sweep (r3 MAJOR-1) ═══
alter table public.cert_auto_cursor
  add column if not exists sweep_top_submitted_at timestamptz,
  add column if not exists sweep_top_attempt_id uuid;
comment on column public.cert_auto_cursor.sweep_top_submitted_at is
  '0029 r3 MAJOR-1: ขอบบนของ sweep = แถวใหม่ที่สุดที่ถูกเดินแล้วในรอบนี้ — แถวที่ใหม่กว่านี้คือ "ผู้มาใหม่" ที่ fresh lane รับก่อน backlog (AC ≤5 นาที) · null = sweep ยังไม่เริ่ม/จบแล้ว';
comment on column public.cert_auto_cursor.sweep_top_attempt_id is
  '0029 r3 MAJOR-1: tie-break ของขอบบนเมื่อ submitted_at ซ้ำ';

-- ═══ (2) admin_cert_auto_fresh_pick — แถว "ผู้มาใหม่" เหนือขอบบนของ sweep เรียง asc ═══
-- โคลนเงื่อนไข eligibility ของ admin_cert_bulk_pick (0027) แต่กลับทิศ:
--   แถวที่ (submitted_at, attempt_id) *ใหม่กว่า* p_top_* เรียง asc (รอนานสุดก่อนใน
--   กลุ่มผู้มาใหม่) · p_top คู่ใดเป็น null (sweep ยังไม่เริ่ม) = ไม่คืนแถว —
--   sweep ใหม่เริ่มที่ backlog lane ซึ่งเดิน desc จากหัวคิวอยู่แล้ว
create or replace function public.admin_cert_auto_fresh_pick(
  p_course_id uuid default null,
  p_limit int default 200,
  p_top_submitted_at timestamptz default null,
  p_top_attempt_id uuid default null
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
    -- r3 MAJOR-1: เฉพาะ "ผู้มาใหม่" — แถวที่ใหม่กว่าขอบบนของ sweep · ขอบบนยังไม่
    -- มี (sweep ใหม่) = คิวทั้งหมดเป็นของ backlog lane อยู่แล้ว ไม่คืนแถวที่นี่
    and p_top_submitted_at is not null
    and p_top_attempt_id is not null
    and (a.submitted_at, a.id) > (p_top_submitted_at, p_top_attempt_id)
  order by a.submitted_at asc, a.id asc
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$fn$;
alter function public.admin_cert_auto_fresh_pick(uuid, int, timestamptz, uuid)
  owner to app_owner;
revoke execute on function public.admin_cert_auto_fresh_pick(uuid, int, timestamptz, uuid)
  from public, anon, authenticated, service_role;

-- ═══ (3) cert_auto_issue_tick — สองเฟส: fresh (ผู้มาใหม่) ก่อน backlog (r3 MAJOR-1) ═══
-- แทนที่ procedure ของ 0028 ทั้งตัว (create or replace) · งบประมวลผลร่วมกัน v_max
-- เดียว: fresh กินก่อนจนหมดคิวหรือหมดงบ แล้ว backlog เดินต่อด้วยงบที่เหลือ —
-- ผู้มาใหม่ไม่ต้องรอ sweep เก่าจบ (AC ≤5 นาที) ขณะที่ backlog ยังคืบหน้าทุก tick
-- ที่มีงบเหลือ
create or replace procedure public.cert_auto_issue_tick(
  p_course_id uuid default null,
  p_max_certs int default 1000,
  inout p_result jsonb default null
)
language plpgsql
as $proc$
declare
  -- clamp p_max_certs ลง [1, 10000] ด้วย CASE ล้วน (parser syntax — ไม่พึ่ง search_path)
  v_max int := case when coalesce(p_max_certs, 1000) < 1 then 1
                    when coalesce(p_max_certs, 1000) > 10000 then 10000
                    else coalesce(p_max_certs, 1000) end;
  v_enabled boolean;
  v_lock bigint;
  v_scope text := coalesce(p_course_id::text, '*');
  v_after_ts timestamptz := null;
  v_after_aid uuid := null;
  v_top_ts timestamptz := null;
  v_top_aid uuid := null;
  v_issued int := 0;
  v_failed int := 0;
  v_done int := 0;
  v_capped boolean;
  v_cert_failed boolean;
  r record;
begin
  select enabled into v_enabled from public.feature_flags where key = 'cert_auto_issue';
  if coalesce(v_enabled, false) = false then
    p_result := pg_catalog.jsonb_build_object('skipped', true, 'reason', 'flag_off');
    return;
  end if;
  -- session-level (ไม่ใช่ xact) เพราะ commit ต่อใบ — กัน tick ซ้อน tick ข้าม commit
  -- · ต่อ scope: tick ของ test (ระบุหลักสูตร) กับ tick ของ cron ('*') ไม่ตีกัน
  v_lock := pg_catalog.hashtext('ltc:cert-auto-issue:' || v_scope)::bigint;
  if not pg_catalog.pg_try_advisory_lock(v_lock) then
    p_result := pg_catalog.jsonb_build_object('skipped', true, 'reason', 'already_running');
    return;
  end if;

  -- MAJOR-1 (r2+r3): โหลด cursor คู่ที่ commit ไว้ — backlog (v_after) + ขอบบนของ
  -- sweep (v_top) · ไม่มีแถว = sweep ใหม่ (ทั้งคู่ null)
  select cursor_submitted_at, cursor_attempt_id, sweep_top_submitted_at, sweep_top_attempt_id
    into v_after_ts, v_after_aid, v_top_ts, v_top_aid
    from public.cert_auto_cursor where scope_key = v_scope;

  -- ── fresh lane (r3 MAJOR-1): ผู้มาใหม่เหนือขอบบนของ sweep ถูกรับ*ก่อน* backlog ──
  -- เรียง asc = ผู้รอนานสุดก่อนในกลุ่มผู้มาใหม่ · watermark (v_top) เดินผ่านแถวที่ล้ม
  -- เหมือนกัน = แถวใหม่ที่ล้มไม่กินงบ fresh ซ้ำทุก tick
  <<fresh>>
  loop
    exit fresh when v_done >= v_max;
    select * into r from public.admin_cert_auto_fresh_pick(p_course_id, 1, v_top_ts, v_top_aid);
    exit fresh when not found;
    v_top_ts := r.submitted_at;
    v_top_aid := r.attempt_id;
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
    -- ใบ + audit + watermark ทั้งคู่ = TX เดียวต่อใบ (cursor backlog คงค่าเดิม)
    insert into public.cert_auto_cursor
      (scope_key, cursor_submitted_at, cursor_attempt_id,
       sweep_top_submitted_at, sweep_top_attempt_id, updated_at)
    values (v_scope, v_after_ts, v_after_aid, v_top_ts, v_top_aid, pg_catalog.now())
    on conflict (scope_key) do update
      set cursor_submitted_at = excluded.cursor_submitted_at,
          cursor_attempt_id = excluded.cursor_attempt_id,
          sweep_top_submitted_at = excluded.sweep_top_submitted_at,
          sweep_top_attempt_id = excluded.sweep_top_attempt_id,
          updated_at = excluded.updated_at;
    commit;
    v_done := v_done + 1;
  end loop fresh;

  -- ── backlog lane: เดิน desc ใต้ cursor (retry/คิวเดิม — semantics ของ 0028) ──
  <<queue>>
  loop
    exit queue when v_done >= v_max;
    select * into r from public.admin_cert_bulk_pick(p_course_id, 1, v_after_ts, v_after_aid);
    exit queue when not found;
    -- M1 (0027): cursor บันทึกตำแหน่งแถวนี้ *ก่อน* ออกใบ — ไม่ว่าใบจะสำเร็จหรือล้ม
    v_after_ts := r.submitted_at;
    v_after_aid := r.attempt_id;
    -- r3 MAJOR-1: sweep ใหม่ (ขอบบนยัง null) — แถวแรกที่เดินคือแถวใหม่ที่สุดของ
    -- sweep นี้ = ขอบบน (ผู้มาใหม่หลังจากนี้เข้าเฟส fresh ของ tick ถัดไป)
    if v_top_ts is null then
      v_top_ts := r.submitted_at;
      v_top_aid := r.attempt_id;
    end if;
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
    -- MAJOR-1 (r2): ใบ + audit + cursor คู่ = TX เดียวต่อใบ (upsert แถวของ scope นี้)
    insert into public.cert_auto_cursor
      (scope_key, cursor_submitted_at, cursor_attempt_id,
       sweep_top_submitted_at, sweep_top_attempt_id, updated_at)
    values (v_scope, v_after_ts, v_after_aid, v_top_ts, v_top_aid, pg_catalog.now())
    on conflict (scope_key) do update
      set cursor_submitted_at = excluded.cursor_submitted_at,
          cursor_attempt_id = excluded.cursor_attempt_id,
          sweep_top_submitted_at = excluded.sweep_top_submitted_at,
          sweep_top_attempt_id = excluded.sweep_top_attempt_id,
          updated_at = excluded.updated_at;
    commit;
    v_done := v_done + 1;
  end loop queue;

  -- sweep จดจบ: ออกจากทั้งสองเฟสเพราะคิวหมด (ไม่ capped) หรือชนเพดานงบแล้ว probe
  -- backlog ยืนยันว่าคิวหมดจริง → reset cursor คู่ = รอบถัดไปเริ่ม sweep ใหม่ (retry
  -- แถวที่เคยล้ม) · ผู้มาใหม่ไม่เคยต้องรอ reset เพราะถูก fresh lane รับไปแล้ว (r3)
  v_capped := v_done >= v_max;
  if v_capped then
    select * into r from public.admin_cert_bulk_pick(p_course_id, 1, v_after_ts, v_after_aid);
  end if;
  if not v_capped or not found then
    update public.cert_auto_cursor
       set cursor_submitted_at = null, cursor_attempt_id = null,
           sweep_top_submitted_at = null, sweep_top_attempt_id = null,
           updated_at = pg_catalog.now()
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
