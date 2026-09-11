-- 0030_cert_auto_walked_markers — แก้ codex gate r4 (Wave E Phase 2) MAJOR-1/MAJOR-2
--
-- สิ่งที่ gate ตัดสิน (2026-09-12 · /tmp/codex-gate-e-p2-r4.txt · adjudicated real ทุกข้อ):
--   MAJOR-1 แถวที่ commit ช้าตกช่องระหว่าง watermark สองคู่: submitted_at ถูกตั้งด้วย
--      now() = เวลา*เริ่ม* transaction (0020:90) ไม่ใช่เวลา commit — TX A เริ่มก่อน B
--      แต่ commit ทีหลัง: sweep เดิน B (ตั้งขอบบน) แล้ว cursor ไต่ลงผ่านตำแหน่ง
--      เวลาของ A ไปแล้ว ก่อน A กลายเป็น visible → A อยู่ใน (cursor, sweep_top) =
--      ไม่ตอบเงื่อนไข fresh (> sweep_top) และไม่ตอบ backlog (< cursor) → ล่องหน
--      จน sweep จบ+reset (ตัวอย่าง gate: backlog 3,999 + 1,000/2 นาที = ได้ใบนาที 8
--      ทั้งที่ eligible — ขัด SRS AC ≤5 นาที) · ข้อความ "ชุดที่เดินแล้ว = ช่วงต่อเนื่อง
--      [cursor, sweep_top] โดยก่อสร้าง" ของ 0029/DD เป็นเท็จเมื่อ visibility กับ
--      ลำดับ submitted_at ไม่ตรงกัน (อ่าน READ COMMITTED ปกติ)
--      → แก้ตามแนะของ gate: **แยกสถานะ "เดินแล้วของรอบนี้" ออกจาก watermark เป็น
--      marker ต่อแถว** — ตาราง cert_auto_walked(scope_key, sweep_epoch, attempt_id):
--      picker หยิบแถว eligible ที่*ยังไม่ถูก mark* เรียง desc (ใหม่สุดก่อน =
--      arrival-first โดยลำดับ — แถวที่ commit ช้าไม่ตกหล่นเพราะไม่มี marker ไม่ว่า
--      submitted_at จะตรงไหน) · watermark สองคู่เหลือเป็นข้อมูลชี้แจง/สังเกตการณ์
--      (sweep_top = หัวของ sweep · cursor = แถวสุดท้ายที่เดิน) ไม่ใช่เงื่อนไขความ
--      ถูกต้องอีกต่อไป
--   MAJOR-2 สถานะ cursor ค้างจาก 0028 ไม่ถูก normalize ตอน upgrade เป็น 0029:
--      0029 เพิ่ม sweep_top_* เป็น NULL ล้วน (ไม่ backfill/normalize) — scope ที่
--      0028 เดินค้างไว้ (cursor ตั้ง แต่ sweep_top ยัง null) ทำให้ fresh lane
--      ปิดตั้งแต่ CALL แรก (null-guard) และแถวแรกที่ backlog เดิน = แถวถัดจาก
--      cursor เก่า ไม่ใช่หัว sweep จริง → แถวที่ 0028 เดินแล้วถูกนับเป็น "ผู้มาใหม่"
--      กินงบก่อนผู้มาใหม่จริง
--      → แก้: tick ตรวจสถานะขัด (คู่ใดคู่หนึ่ง null คู่เดียว) ตอนโหลด = เริ่ม sweep
--      ใหม่ทั้งหมด (epoch+1 · null ทั้งสี่คู่ · ลบ marker เก่า) ภายใต้ advisory lock
--      ของ scope — การเดินซ้ำแถวที่ 0028 เดินแล้วเป็น at-least-once (anti-join ใบ
--      valid กันใบซ้ำ · แถวที่ล้มได้ retry พิเศษหนึ่งครั้ง — bounded)
--
-- ผลข้างเคียงที่ยอมรับ (เอกสารไว้ใน DD): ไม่มีการ backfill marker จาก cursor ของ
--   0028/0029 — scope ที่กำลังเดินค้างตอนใช้ 0030 ครั้งแรก แถวที่เดินไปแล้วของรอบ
--   นั้นถูกลองซ้ำรอบเดียว (anti-join ใบ valid ทำให้ idempotent · failed ได้ retry
--   เพิ่มหนึ่งครั้งต่อ scope) จบใน tick เดียวเพราะงบต่อ tick ยัง cap อยู่
--
-- สัญญา inout p_result เท่าเดิมทุกประการกับ 0027/0028/0029 ({skipped,reason} /
--   {skipped,issued_count,failed_count}) — cron/BFF/เทสเดิมไม่พัง
--
-- ข้อจำกัด PG ≥15 (D60) ยังบังคับ: procedure ที่ COMMIT ต้อง INVOKER เปล่า —
--   ไม่มี security definer ไม่มี set search_path (0B000) · อ้างชื่อ 2-part ครบ ·
--   builtin ใน body ของ procedure qualify pg_catalog (ยกเว้น coalesce/nullif —
--   special syntax ของ parser) · picker ใหม่เป็น FUNCTION (ไม่ COMMIT) จึงใช้
--   security definer + set search_path ได้ตามแบบ admin_cert_bulk_pick ของ 0027

-- ═══ (1) คอลัมน์รอบของ sweep (r4) ═══
alter table public.cert_auto_cursor
  add column if not exists sweep_epoch bigint not null default 0;
comment on column public.cert_auto_cursor.sweep_epoch is
  '0030 r4 MAJOR-1/2: รอบ sweep ปัจจุบันของ scope — marker ของ cert_auto_walked ผูกกับค่านี้ · sweep จบ (คิวหมด/probe ยืนยัน) = +1 พร้อมลบ marker รอบเก่า = รอบ retry ใหม่';

-- ═══ (2) ตาราง marker "เดินแล้วของรอบนี้" ต่อแถว (r4 MAJOR-1) ═══
-- แทนสมมติฐาน "ช่วงต่อเนื่องระหว่าง watermark" ที่พังเมื่อ submitted_at (now() ตอน
-- เริ่ม TX) กับเวลา commit สลับลำดับ — แถวที่ commit ช้าไม่มี marker = picker เห็น
-- เสมอ (ไม่ผูกกับช่วงเวลาอีกต่อไป) · insert ใน TX เดียวกับใบ+audit+watermark ต่อแถว
create table if not exists public.cert_auto_walked (
  scope_key text not null,
  sweep_epoch bigint not null,
  attempt_id uuid not null,
  created_at timestamptz not null default now(),
  constraint cert_auto_walked_pk primary key (scope_key, sweep_epoch, attempt_id),
  constraint cert_auto_walked_scope_fk
    foreign key (scope_key) references public.cert_auto_cursor (scope_key)
    on delete cascade
);
comment on table public.cert_auto_walked is
  '0030 r4 MAJOR-1: แถวที่ tick เดินแล้วของรอบ (scope_key, sweep_epoch) — picker หยิบเฉพาะแถวที่ยังไม่ถูก mark · insert พร้อมใบ+audit+watermark TX เดียวต่อแถว · sweep จบ = ลบทิ้งทั้งรอบ (retry รอบใหม่) · ลบ cursor ของ scope = cascade ลบ marker ด้วย';
comment on column public.cert_auto_walked.scope_key is 'scope ของ tick — uuid หลักสูตร หรือ ''*'' = ทุกหลักสูตร (cron) · FK → cert_auto_cursor (cascade)';
comment on column public.cert_auto_walked.sweep_epoch is 'รอบ sweep ที่เดินแถวนี้ — ตรง sweep_epoch ของ cert_auto_cursor ตอนนั้น';
comment on column public.cert_auto_walked.attempt_id is 'แถว assessment_attempts ที่ถูกเดิน (สำเร็จหรือล้ม — ล้มก็ mark เพื่อไม่กินงบซ้ำในรอบเดียวกัน)';
alter table public.cert_auto_walked enable row level security;
-- fail-closed ต่อ anon/authenticated (ไม่มี policy ของกลุ่มนั้น) · service_role ไม่ต้องใช้
-- (BFF ไม่แตะ — ตารางภายในของ worker เท่านั้น)
revoke all on public.cert_auto_walked from public, anon, authenticated, service_role;
-- D58: app_owner (invoker ที่ได้ EXECUTE ของ tick) ไม่มี BYPASSRLS และไม่ใช่เจ้าของ
-- ตาราง → ต้องมี policy เป็นของตัวเอง (select สำหรับ anti-join ของ picker · insert
-- ต่อแถว · delete ตอน sweep จบ — ไม่ต้องมี update)
grant select, insert, delete on public.cert_auto_walked to app_owner;
drop policy if exists app_owner_select_cert_auto_walked on public.cert_auto_walked;
create policy app_owner_select_cert_auto_walked
  on public.cert_auto_walked for select to app_owner using (true);
drop policy if exists app_owner_insert_cert_auto_walked on public.cert_auto_walked;
create policy app_owner_insert_cert_auto_walked
  on public.cert_auto_walked for insert to app_owner with check (true);
drop policy if exists app_owner_delete_cert_auto_walked on public.cert_auto_walked;
create policy app_owner_delete_cert_auto_walked
  on public.cert_auto_walked for delete to app_owner using (true);

-- ═══ (3) admin_cert_auto_unmarked_pick — แถวที่ยังไม่ถูก mark ของรอบ เรียง desc ═══
-- แทน admin_cert_auto_fresh_pick ของ 0029 (drop ท้าย §นี้): eligibility เหมือน
-- admin_cert_bulk_pick (0027) เป๊ะ · เงื่อนไขใหม่อย่างเดียว = anti-join marker ของ
-- (scope, p_epoch) · เรียง desc = ใหม่สุดก่อน (arrival-first โดยลำดับ — ผู้มาใหม่
-- อยู่หัวคิวเสมอแม้ submitted_at จะตกในช่วงที่เดินไปแล้วของรอบก่อน)
create or replace function public.admin_cert_auto_unmarked_pick(
  p_course_id uuid default null,
  p_limit int default 200,
  p_epoch bigint default null
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
    -- r4 MAJOR-1: เฉพาะแถวที่*ยังไม่ถูก mark*ของรอบนี้ — ไม่ผูกกับช่วง submitted_at
    -- อีกต่อไป (แถวที่ commit ช้าไม่มี marker = มองเห็นเสมอ) · p_epoch null = ไม่คืนแถว
    -- (tick ส่ง epoch จริงเสมอ — guard กันเรียกลำพัง)
    and p_epoch is not null
    and not exists (select 1
                    from public.cert_auto_walked w
                    where w.scope_key = coalesce(p_course_id::text, '*')
                      and w.sweep_epoch = p_epoch
                      and w.attempt_id = a.id)
  order by a.submitted_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$fn$;
alter function public.admin_cert_auto_unmarked_pick(uuid, int, bigint)
  owner to app_owner;
revoke execute on function public.admin_cert_auto_unmarked_pick(uuid, int, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_cert_auto_unmarked_pick(uuid, int, bigint)
  to app_owner, postgres;
-- 0029 superseded: fresh lane picker ถูกแทนด้วย unmarked picker (ไม่มีโค้ดตาย)
drop function if exists public.admin_cert_auto_fresh_pick(uuid, int, timestamptz, uuid);

-- ═══ (4) cert_auto_issue_tick — marker-based single lane (แทนที่ของ 0029 ทั้งตัว) ═══
-- โครงเดิมของ 0027/0028/0029 (flag → advisory lock ต่อ scope → commit ต่อแถว →
-- probe ตอน capped → reset ตอนคิวหมด) หกเปลี่ยนเฉพาะแกน "เดินอะไรแล้ว":
--   (a) โหลด epoch + watermark สองคู่ · สถานะขัด (คู่ใดคู่หนึ่ง null คู่เดียว = 0028
--       ค้างมา — r4 MAJOR-2) → normalize เป็น sweep ใหม่ (epoch+1 · null ทั้งสี่ ·
--       ลบ marker รอบเก่า) ภายใต้ lock ของ scope
--   (b) เดินแถว eligible ที่ยังไม่ mark เรียง desc ทีละแถว (ใหม่สุดก่อน =
--       ผู้มาใหม่ได้ใบก่อนโดยก่อสร้าง — AC ≤5 นาที ไม่ขึ้นกับความยาวคิวเก่า):
--       cert_issue_core (ใบล้มยกเลือกเฉพาะใบ) → upsert watermark (sweep_top =
--       หัวของ sweep ตั้งครั้งเดียวต่อรอบ · cursor = แถวสุดท้ายที่เดิน — ทั้งคู่เป็น
--       ข้อมูลชี้แจงอ่านง่าย ไม่ใช่เงื่อนไข picker) → insert marker → COMMIT
--   (c) คิวหมด (ไม่ capped หรือ capped แล้ว probe ด้วย picker ตัวเองยืนยันว่าไม่มี
--       แถว unmarked เหลือ) → ลบ marker รอบนี้ + epoch+1 + null ทั้งสี่ = รอบ retry
--       ใหม่ (แถวที่เคยล้มถูกลองใหม่รอบหน้า — bounded ด้วย p_max_certs เหมือนเดิม)
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
  v_epoch bigint := 0;
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

  -- MAJOR-1 (r2+r3): โหลดรอบ + watermark คู่ที่ commit ไว้ · ไม่มีแถว = sweep ใหม่
  select cursor_submitted_at, cursor_attempt_id, sweep_top_submitted_at, sweep_top_attempt_id,
         sweep_epoch
    into v_after_ts, v_after_aid, v_top_ts, v_top_aid, v_epoch
    from public.cert_auto_cursor where scope_key = v_scope;
  if not found then
    v_epoch := 0;
    v_after_ts := null; v_after_aid := null; v_top_ts := null; v_top_aid := null;
  end if;

  -- MAJOR-2 (r4): สถานะค้างจาก 0028 (cursor ตั้ง แต่ sweep_top ยัง null — 0029 เพิ่ม
  -- คอลัมน์แบบ NULL โดยไม่ normalize) หรือขัดกันกลับด้าน → เริ่ม sweep ใหม่ทั้งหมด:
  -- รอบเก่าของ 0028 ไม่มี marker ให้ลบ แต่ลบเชิงป้องกันไว้ (scope นี้อยู่ใต้ lock)
  if (v_after_ts is null) <> (v_top_ts is null) then
    delete from public.cert_auto_walked
     where scope_key = v_scope and sweep_epoch <= v_epoch;
    update public.cert_auto_cursor
       set cursor_submitted_at = null, cursor_attempt_id = null,
           sweep_top_submitted_at = null, sweep_top_attempt_id = null,
           sweep_epoch = v_epoch + 1,
           updated_at = pg_catalog.now()
     where scope_key = v_scope;
    commit;
    v_epoch := v_epoch + 1;
    v_after_ts := null; v_after_aid := null; v_top_ts := null; v_top_aid := null;
  end if;

  -- ── เดินแถว unmarked เรียง desc (r4 MAJOR-1: ใหม่สุดก่อน — ผู้มาใหม่หัวคิวเสมอ) ──
  <<walk>>
  loop
    exit walk when v_done >= v_max;
    select * into r from public.admin_cert_auto_unmarked_pick(p_course_id, 1, v_epoch);
    exit walk when not found;
    -- watermark ทั้งสองคู่ = ข้อมูลชี้แจง (r4): cursor = แถวสุดท้ายที่เดิน ·
    -- sweep_top = หัวของ sweep (แถวแรกที่เดินของรอบ — desc คือแถวใหม่ที่สุด)
    v_after_ts := r.submitted_at;
    v_after_aid := r.attempt_id;
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
    -- ใบ + audit + watermark + marker = TX เดียวต่อแถว (upsert ก่อน insert marker —
    -- FK cert_auto_walked → cert_auto_cursor ต้องเห็นแถว scope ก่อนใน TX เดียวกัน)
    insert into public.cert_auto_cursor
      (scope_key, cursor_submitted_at, cursor_attempt_id,
       sweep_top_submitted_at, sweep_top_attempt_id, sweep_epoch, updated_at)
    values (v_scope, v_after_ts, v_after_aid, v_top_ts, v_top_aid, v_epoch, pg_catalog.now())
    on conflict (scope_key) do update
      set cursor_submitted_at = excluded.cursor_submitted_at,
          cursor_attempt_id = excluded.cursor_attempt_id,
          sweep_top_submitted_at = excluded.sweep_top_submitted_at,
          sweep_top_attempt_id = excluded.sweep_top_attempt_id,
          sweep_epoch = excluded.sweep_epoch,
          updated_at = excluded.updated_at;
    insert into public.cert_auto_walked (scope_key, sweep_epoch, attempt_id)
    values (v_scope, v_epoch, r.attempt_id);
    commit;
    v_done := v_done + 1;
  end loop walk;

  -- sweep จดจบ: ออกจากลูปเพราะคิว unmarked หมด (ไม่ capped) หรือชนเพดานงบแล้ว probe
  -- ด้วย picker ตัวเอง (ความจริงของ marker — ไม่ใช่การเดาจากช่วงเวลา) ยืนยันคิวหมดจริง
  -- → ลบ marker รอบนี้ + epoch+1 + reset watermark = รอบถัดไปเริ่ม sweep ใหม่ (retry
  -- แถวที่เคยล้ม) · ผู้มาใหม่ไม่เคยต้องรอ reset เพราะถูกหยิบที่หัวคิวมาตลอด
  v_capped := v_done >= v_max;
  if v_capped then
    select * into r from public.admin_cert_auto_unmarked_pick(p_course_id, 1, v_epoch);
  end if;
  if not v_capped or not found then
    delete from public.cert_auto_walked
     where scope_key = v_scope and sweep_epoch <= v_epoch;
    update public.cert_auto_cursor
       set cursor_submitted_at = null, cursor_attempt_id = null,
           sweep_top_submitted_at = null, sweep_top_attempt_id = null,
           sweep_epoch = v_epoch + 1,
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
