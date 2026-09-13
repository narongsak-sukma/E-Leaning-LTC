-- ═══ 0045 — แก้ findings ของ CTO gate r1 (Wave F Phase 0 · [#91]) ═════════════
-- gate r1 (codex · 2026-09-13) ตัดสิน FAIL — 10 findings; ชุดนี้แก้ครึ่งหนึ่งที่เป็น
-- ชั้น DB (อีกครึ่งเป็นชั้นแอป: cookie stash/nonce CSP — อยู่ในโค้ด Next รุ่นเดียวกัน):
--   F1 (CRITICAL) mfa_backup_codes_replace ตรวจแค่ auth.uid()+factor verified แต่
--       ไม่ตรวจ aal — ผู้ถือรหัสผ่าน (aal1) ยิง RPC ตรงผ่าน Kong REST ใส่ hash ที่
--       ตัวเองรู้โค้ดจริง แล้วเข้า login สองขั้นผ่านโค้ดสำรองนั้น = ข้าม MFA เต็มขั้น
--       → +guard aal2 ที่ตัว RPC (แบบแผน 0044 my_audit_email_change_request) ทั้ง
--       replace และ invalidate (consume ห้ามใส่ — เป็นเส้นทาง login ที่ยัง aal1)
--   F4 (MED) consume ไม่มีการจำกัดความพยายาม — ยิงตรง REST  brute-force ได้ไม่จำกัด
--       → ตาราง mfa_backup_attempts + นับผิด 5 ครั้ง/ล็อก 15 นาที (สำเร็จ = รีเซ็ต)
--   F6 (MED) replace ทำ DELETE→INSERT ไม่มี serialization — concurrent สองเรียกได้
--       ชุดคร่อมกัน → +pg_advisory_xact_lock ต่อผู้ใช้ (consume ล็อกด้วย — กันนับ
--       fail แข่งกับ used_at ที่ทำให้ lockout ตัดสินผิด)
--   F2/F5 (HIGH/MED) login สองขั้นเดิมแพ็ก token จริงลง cookie → ตาราง
--       mfa_pending_stash + RPC create/take: token หยุดอยู่ที่ server (เข้ารหัส
--       AES-256-GCM ฝั่งแอปด้วย LTC_MFA_PENDING_KEY — DB เห็น ciphertext เท่านั้น)
--       cookie เก็บ uuid อย่างเดียว · single-use (consumed_at) · อายุ 300 วิบังคับ
--       ที่ DB (expires_at) ไม่ใช่ browser maxAge → replay หลังหมดอายุ/ใช้แล้ว = null
--   F7 (MED) audit_email_change_confirmed กลืน exception ทุกตัว (RAISE WARNING) —
--       เหตุการณ์ identity เปลี่ยนแล้วหลักฐานหายเงียบ → fail-closed (ตัด handler)
--       trade-off: การ update อีเมลพังเมื่อ audit พัง — ยอมรับได้เพราะ flow นี้
--       หายากและ "แจ้งผู้ใช้ว่าล้มเหลว" ปลอดภัยกว่า "เปลี่ยนสำเร็จแต้ไม่มีหลักฐาน"
--   F10 (LOW) consents_from_signup dedupe เฉพาะกับแถวเดิม ไม่กันคีย์ซ้ำใน array
--       เดียว (metadata ปลอมจาก signup ตรง Kong) → distinct on คีย์ในชุด

-- ── 1) ตารางนับความพยายามของโค้ดสำรอง (F4) ───────────────────────────────────
create table if not exists public.mfa_backup_attempts (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  fail_count  int not null default 0 check (fail_count >= 0),
  last_fail_at timestamptz,
  locked_until timestamptz
);

comment on table public.mfa_backup_attempts is
  'ตัวนับ/ล็อกของการใช้โค้ดสำรองผิด (gate r1 F4) — เข้าถึงผ่าน mfa_backup_codes_consume เท่านั้น (RLS ไม่มี policy สำหรับผู้ใช้)';

alter table public.mfa_backup_attempts enable row level security;
-- แบบแผน 0042: เจ้าของ RPC = app_owner (SECURITY DEFINER ไม่ bypass RLS)
do $do$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mfa_backup_attempts' and policyname='app_owner_all_mfa_backup_attempts') then
    execute 'create policy app_owner_all_mfa_backup_attempts on public.mfa_backup_attempts for all to app_owner using (true) with check (true)';
  end if;
end
$do$;
grant select, insert, update, delete on public.mfa_backup_attempts to app_owner;

-- ── 2) replace/invalidate +guard aal2 · replace +advisory lock (F1 · F6) ──────
create or replace function public.mfa_backup_codes_replace(p_hashes text[])
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_n int;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  -- F1: การออกชุดโค้ดใหม่คือการเปลี่ยนข้อมูลรับรอง — บังคับ aal2 ที่ตัว RPC
  -- (BFF route เป็นชั้นแรก; ชั้นนี้ปิดช่องยิงตรงผ่าน Kong REST ด้วย session aal1)
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') <> 'aal2' then
    raise exception 'ต้องยืนยันตัวตนสองชั้นก่อนดำเนินการ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  v_n := coalesce(array_length(p_hashes, 1), 0);
  if v_n < 8 or v_n > 12 then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องส่ง hash 8-12 ค่า (ERR-VAL-001|hash_count)'
      using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_hashes) h where h is null or h !~ '^[0-9a-f]{64}$') then
    raise exception 'ข้อมูลไม่ถูกต้อง: hash ต้องเป็น hex 64 อักขระ (ERR-VAL-001|hash_format)'
      using errcode = '22023';
  end if;
  if (select count(distinct h) from unnest(p_hashes) h) <> v_n then
    raise exception 'ข้อมูลไม่ถูกต้อง: hash ซ้ำในชุด (ERR-VAL-001|hash_duplicate)'
      using errcode = '22023';
  end if;
  -- บังคับ: มี factor TOTP สถานะ verified อยู่จริง ก่อนมีโค้ดสำรอง (D12-10)
  if not exists (select 1 from auth.mfa_factors f
                  where f.user_id = v_user and f.factor_type = 'totp'
                    and f.status = 'verified') then
    raise exception 'ต้องผูกและยืนยัน TOTP ก่อนสร้างโค้ดสำรอง (ERR-VAL-001|totp_required)'
      using errcode = '22023';
  end if;

  -- F6: serialize ต่อผู้ใช้ — สองเรียกคร่อมกันจะต้องเห็น DELETE ของกันและกัน
  perform pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || v_user::text));

  delete from public.mfa_backup_codes where user_id = v_user; -- ชุดเก่า invalid ทันที
  insert into public.mfa_backup_codes (user_id, code_hash)
  select v_user, h from unnest(p_hashes) h;

  perform public.append_audit_event_internal(
    'AUTH_MFA_BACKUPS_REGENERATED', 'user', v_user::text, null, null,
    jsonb_build_object('count', v_n, 'replaced_previous', true),
    null, null, gen_random_uuid()::text, v_user);
  return v_n;
end;
$fn$;

-- ── 3) consume +lockout 5 ผิด/15 นาที +ล็อกแถว (F4 · F6) ─────────────────────
create or replace function public.mfa_backup_codes_consume(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user  uuid := auth.uid();
  v_hash  text;
  v_found boolean;
  v_left  int;
  v_locked boolean := false;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;

  -- F4: serialize ต่อผู้ใช้ก่อนอ่านสถานะล็อก (กัน นับ-fail แข่งกับ consume จริง)
  perform pg_advisory_xact_lock(hashtext('mfa_backup_consume:' || v_user::text));

  select coalesce(a.locked_until is not null and a.locked_until > now(), false)
    into v_locked
    from public.mfa_backup_attempts a
   where a.user_id = v_user;
  if v_locked then
    return jsonb_build_object('valid', false, 'remaining', null, 'locked', true);
  end if;

  if p_code is null or length(btrim(p_code)) < 6 or length(btrim(p_code)) > 32 then
    return jsonb_build_object('valid', false, 'remaining', null, 'locked', false); -- รูปร่างไม่ใช่ = ไม่ใช่โค้ด (ไม่นับ fail)
  end if;
  v_hash := encode(sha256(convert_to(lower(btrim(p_code)), 'UTF8')), 'hex');

  update public.mfa_backup_codes
     set used_at = now()
   where user_id = v_user and code_hash = v_hash and used_at is null
  returning true into v_found; -- สองยิงพร้อมกัน = ผ่านรายการเดียว (used_at is null)

  if v_found is not true then
    -- F4: ผิด = นับ; ครบ 5 = ล็อก 15 นาที (เริ่มนับใหม่หลังหมดเวลาล็อกเพราะ fail_count
    -- รีเซ็ตเมื่อพ้น locked_until แล้ว)
    insert into public.mfa_backup_attempts as a (user_id, fail_count, last_fail_at)
    values (v_user, 1, now())
    on conflict (user_id) do update
      set fail_count = case when a.locked_until is not null and a.locked_until <= now()
                            then 1 else a.fail_count + 1 end,
          last_fail_at = now(),
          locked_until = case when (case when a.locked_until is not null and a.locked_until <= now()
                                         then 1 else a.fail_count + 1 end) >= 5
                              then now() + interval '15 minutes'
                              else a.locked_until end;
    select coalesce(a.locked_until is not null and a.locked_until > now(), false)
      into v_locked
      from public.mfa_backup_attempts a
     where a.user_id = v_user;
    return jsonb_build_object('valid', false, 'remaining', null, 'locked', v_locked);
  end if;

  -- สำเร็จ = ล้างตัวนับ (ผู้ใช้จริงพิมพ์ผิดไล่ตามก่อนหน้าไม่ลากมาล็อก)
  delete from public.mfa_backup_attempts where user_id = v_user;

  select count(*) into v_left from public.mfa_backup_codes
   where user_id = v_user and used_at is null;

  perform public.append_audit_event_internal(
    'AUTH_MFA_BACKUP_CODE_USED', 'user', v_user::text, null, null,
    jsonb_build_object('remaining', v_left),
    null, null, gen_random_uuid()::text, v_user);
  return jsonb_build_object('valid', true, 'remaining', v_left, 'locked', false);
end;
$fn$;

-- ── 4) invalidate +guard aal2 (F1) ───────────────────────────────────────────
create or replace function public.mfa_backup_codes_invalidate()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_n int;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  -- F1: ทำลายชุดโค้ดสำรองก็เป็นการเปลี่ยนข้อมูลรับรอง — บังคับ aal2 เช่น replace
  -- (เส้นทางปิด MFA ของ BFF บังคับ recent-MFA อยู่แล้ว = session aal2 เสมอ)
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') <> 'aal2' then
    raise exception 'ต้องยืนยันตัวตนสองชั้นก่อนดำเนินการ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  delete from public.mfa_backup_codes where user_id = v_user;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.append_audit_event_internal(
      'AUTH_MFA_BACKUPS_INVALIDATED', 'user', v_user::text, null, null,
      jsonb_build_object('removed', v_n),
      null, null, gen_random_uuid()::text, v_user);
  end if;
  return v_n;
end;
$fn$;

-- ── 5) ตาราง stash ของ login สองขั้น (F2 · F5) ───────────────────────────────
-- เดิม: cookie ltc_mfa_pending แพ็ก {accessToken, refreshToken} จริง — ใครอ่านได้
-- (Set-Cookie ผ่าน client ที่ไม่ใช่ browser / log proxy) ได้ session aal1 เต็มตัว
-- โดยไม่ต้องผ่านขั้นสอง · ใหม่: token อยู่ในตารางนี้เป็น **ciphertext** (แอป
-- เข้ารหัส AES-256-GCM ด้วย LTC_MFA_PENDING_KEY ก่อนส่งเข้า RPC — DB dump เพียว
-- ๆ ถอดไม่ได้) · cookie เก็บ uuid เท่านั้น · uuid คือความลับแบบ bearer (122 บิต
-- ของ uuid v4) — take ไม่ผูก auth.uid() เพราะขั้นสองยังไม่มี session ใด ๆ
create table if not exists public.mfa_pending_stash (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  payload     text not null,             -- v1.<iv>.<tag>.<ct> (base64url) — AES-256-GCM
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.mfa_pending_stash is
  'stash ชั่วคราวของ login สองขั้น (gate r1 F2/F5) — token เข้ารหัสฝั่งแอป เก็บ server-side · cookie ถือ uuid อย่างเดียว · เข้าถึงผ่าน RPC เท่านั้น (RLS ไม่มี policy สำหรับผู้ใช้)';

alter table public.mfa_pending_stash enable row level security;
do $do$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mfa_pending_stash' and policyname='app_owner_all_mfa_pending_stash') then
    execute 'create policy app_owner_all_mfa_pending_stash on public.mfa_pending_stash for all to app_owner using (true) with check (true)';
  end if;
end
$do$;
grant select, insert, update, delete on public.mfa_pending_stash to app_owner;
create index if not exists idx_mfa_pending_stash_expiry on public.mfa_pending_stash (expires_at);

-- สร้าง stash ใหม่ (ขั้น password ผ่านแล้ว — session aal1 ถือโดย standalone client
-- ของ server action เท่านั้น) · หนึ่ง pending ต่อผู้ใช้: แถวเดิมถูกแทน (cookie เก่าตาย)
create or replace function public.mfa_pending_stash_create(p_payload text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  if p_payload is null or length(p_payload) > 8192 then
    raise exception 'ข้อมูลไม่ถูกต้อง (ERR-VAL-001|payload)'
      using errcode = '22023';
  end if;
  -- เก็บกวาดสิ้นเปลือง: หมดอายุเกิน 1 ชั่วโมง/ใช้แล้วเกิน 1 ชั่วโมง (สอง RPC ทำ
  -- ตรงนี้เท่ากัน — ไม่ต้องมี cron ของตารางนี้)
  delete from public.mfa_pending_stash
   where expires_at < now() - interval '1 hour'
      or (consumed_at is not null and consumed_at < now() - interval '1 hour');
  delete from public.mfa_pending_stash where user_id = v_user;
  insert into public.mfa_pending_stash (user_id, payload, expires_at)
  values (v_user, p_payload, now() + interval '300 seconds')
  returning id into v_id;
  return v_id;
end;
$fn$;

-- ขอคืน token (ขั้นสอง — ยังไม่มี session เลย · เรียกด้วย anon key ของ standalone
-- client) · **peek ไม่ใช่ consume**: รหัสผิดพยายามซ้ำได้เท่าที่อายุเหลือ (เดิมที
-- single-use ที่ take ทำให้พิมพ์ผิดครั้งเดียว pending ตายทั้งหน้าต่าง) — การ
-- "ใช้แล้ว" ตัดสินที่ consume หลัง verify สำเร็จเท่านั้น (ออก session aal2 จริง)
create or replace function public.mfa_pending_stash_take(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_payload text;
begin
  select payload into v_payload
    from public.mfa_pending_stash
   where id = p_id
     and consumed_at is null
     and expires_at > now();
  if v_payload is null then
    delete from public.mfa_pending_stash
     where expires_at < now() - interval '1 hour'
        or (consumed_at is not null and consumed_at < now() - interval '1 hour');
  end if;
  return v_payload; -- null = ไม่มี/ใช้แล้ว/หมดอายุ → caller ตอบ state=expired
end;
$fn$;

-- ปิด stash หลัง verify สำเร็จ (single-use จริง: ออก session แล้ว uuid ตายทันที —
-- replay คุกกี้เดิมหลังจากนี้ = take ได้ null) · idempotent (แถวที่ consumed แล้ว
-- อัปเดต 0 แถว = false ไม่ error)
create or replace function public.mfa_pending_stash_consume(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.mfa_pending_stash
     set consumed_at = now()
   where id = p_id
     and consumed_at is null;
  return found;
end;
$fn$;

-- ── 6) audit_email_change_confirmed → fail-closed (F7) ───────────────────────
create or replace function public.audit_email_change_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' and new.email is distinct from old.email then
    -- F7: เหตุการณ์เปลี่ยน identity เป็นเหตุการณ์ความปลอดภัย — ห้ามกลืน exception
    -- (เดิม RAISE WARNING = เปลี่ยนสำเร็จแต่หลักฐานหายเงียบ) · fail-closed: audit
    -- ไม่ได้เขียน = การ update อีเมลล้มเหลว ผู้ใช้ได้รับแจ้งและยื่นใหม่ได้ —
    -- trade-off ตัดสินโดย gate r1: availability ของ flow หายาก < ความสมบูรณ์ของ audit
    perform public.append_audit_event_internal(
      'USER_EMAIL_CHANGE_CONFIRMED', 'user', new.id::text, null, null,
      jsonb_build_object('old_email_sha256', encode(sha256(convert_to(lower(old.email), 'UTF8')), 'hex'),
                         'new_email_sha256', encode(sha256(convert_to(lower(new.email), 'UTF8')), 'hex')),
      null, null, gen_random_uuid()::text, new.id);
  end if;
  return null; -- AFTER trigger
end;
$fn$;

-- ── 7) consents_from_signup dedupe คีย์ซ้ำใน array เดียว (F10) ────────────────
create or replace function public.consents_from_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE'
     and new.email_confirmed_at is not null
     and old.email_confirmed_at is null then
    begin
      -- F10: not-exists เดิมกันซ้ำกับ "แถวที่ commit แล้ว" เท่านั้น — คีย์ซ้ำสองตัว
      -- ใน consents_granted ชุดเดียวผ่านไปได้ทั้งคู่ (signup ตรง Kong ใส่ metadata
      -- ปลอมได้) → distinct on เลือกตัวแรกต่อคีย์ก่อนตรวจซ้ำกับแถวเดิม
      insert into public.consents (user_id, consent_type, action, policy_version, source)
      select new.id, s.consent_type, 'grant', s.policy_version, 'register'
        from (
          select distinct on (item ->> 'key') item ->> 'key' as consent_type,
                 item ->> 'version' as policy_version
            from jsonb_array_elements(
                   coalesce(new.raw_user_meta_data -> 'consents_granted', '[]'::jsonb)
                 ) item
           where (item ->> 'key') in ('marketing', 'email_notify')
             and coalesce(item ->> 'version', '') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'
           order by (item ->> 'key')
        ) s
       where exists (select 1 from public.profiles pp where pp.id = new.id)
         and not exists (select 1 from public.consents c
                          where c.user_id = new.id
                            and c.consent_type = s.consent_type
                            and c.action = 'grant');
    exception when others then
      -- ของเสริมห้ามบังคับ flow หลัก (การยืนยันอีเมล) — gate r1 ยืนยัน fail-open
      -- ยอมรับได้สำหรับ optional consent (ต่างจาก F7 ที่เป็นเหตุการณ์ความปลอดภัย)
      raise warning 'consents_from_signup: ข้ามการบันทึก consent ของ % (%)', new.id, sqlerrm;
    end;
  end if;
  return null; -- AFTER trigger
end;
$fn$;

-- ── เจ้าของ/สิทธิ์ ของฟังก์ชันใหม่ (สอดคล้อง 0042) ────────────────────────────
alter function public.mfa_pending_stash_create(text) owner to app_owner;
alter function public.mfa_pending_stash_take(uuid) owner to app_owner;
alter function public.mfa_pending_stash_consume(uuid) owner to app_owner;

revoke execute on function public.mfa_pending_stash_create(text) from public, anon;
grant  execute on function public.mfa_pending_stash_create(text) to authenticated;
-- take/consume ต้องให้ anon ด้วย: ขั้นสองของ login ยังไม่มี session — uuid คือ
-- bearer secret (122 บิต) · อายุ 300 วิที่ DB เท่านั้น · consume = single-use
-- จริงหลังออก session
revoke execute on function public.mfa_pending_stash_take(uuid) from public;
grant  execute on function public.mfa_pending_stash_take(uuid) to anon, authenticated;
revoke execute on function public.mfa_pending_stash_consume(uuid) from public;
grant  execute on function public.mfa_pending_stash_consume(uuid) to anon, authenticated;
