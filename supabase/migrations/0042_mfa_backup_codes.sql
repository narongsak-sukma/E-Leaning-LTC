-- ═══ 0042 — MFA backup codes (Wave F · D-f-1/D11-12 · [#91]) ═══════════════════
-- GoTrue ไม่มี backup codes ในตัว — ตารางเก็บ **sha256 hash เท่านั้น** (โค้ด
-- แสดงครั้งเดียวจาก BFF ตอนสร้าง · regenerate = ชุดเก่า invalid ทันที · status
-- คืน metadata ล้วน ไม่มีโค้ดเด็ดขาด — D11-12)
-- สัญญา hash (single source): `encode(sha256(convert_to(lower(btrim(code)), 'UTF8')), 'hex')`
--   — BFF (Node crypto) และ RPC consume ต้องเจอค่าเดียวกัน · โค้ดเป็นรูป `xxxx-xxxx`
--   จาก CSPRNG ของ BFF (ฝั่ง DB ไม่สุ่มเอง — ไม่มีทางรู้โค้ดตัวจริง)
-- การเข้าถึง: ตารางเปิด RLS โดยมี policy เฉพาะ role `app_owner` (เจ้าของ RPC —
--   SECURITY DEFINER ไม่ bypass RLS) · ผู้ใช้ (authenticated/anon) ไม่มี policy
--   เลย = ตรง ๆ ไม่ได้แม้ผู้เจ้าของบัญชี — ทางเดียวคือ 4 RPC ของไฟล์นี้
-- RPC ทั้งชุด: owner app_owner · grant execute เฉพาะ authenticated · ทุกการ
--   เปลี่ยนแปลงเขียน audit ผ่าน append_audit_event_internal (hash-chain)
--   — AUTH_MFA_BACKUPS_REGENERATED / AUTH_MFA_BACKUP_CODE_USED /
--   AUTH_MFA_BACKUPS_INVALIDATED (context = จำนวนเท่านั้น ไม่มีโค้ด/hash)

-- ── ตาราง ────────────────────────────────────────────────────────────────────
create table if not exists public.mfa_backup_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  code_hash  text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  -- หนึ่ง hash ต่อผู้ใช้ (ทั้ง lookup ของ consume และกัน insert ซ้ำค่าเดียวกัน)
  constraint uq_mfa_backup_codes_user_hash unique (user_id, code_hash)
);

comment on table public.mfa_backup_codes is
  'MFA backup codes (GoTrue ไม่มีในตัว) — เก็บ sha256 เท่านั้น · เข้าถึงผ่าน RPC เท่านั้น (RLS ไม่มี policy)';

alter table public.mfa_backup_codes enable row level security;
-- แบบแผนบ้าน (data_export_jobs/consents/…): เจ้าของตาราง = supabase_admin แต่ RPC
-- เจ้าของ app_owner (SECURITY DEFINER ไม่ bypass RLS) ต้องมี policy ต่อ action —
-- role `authenticated`/`anon` ไม่มี policy เลย = ผู้ใช้เข้าถึงตารางตรง ๆ ไม่ได้เด็ดขาด
-- (ทางเดียวคือ 4 RPC ของไฟล์นี้)
do $do$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mfa_backup_codes' and policyname='app_owner_select_mfa_backup_codes') then
    execute 'create policy app_owner_select_mfa_backup_codes on public.mfa_backup_codes for select to app_owner using (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mfa_backup_codes' and policyname='app_owner_insert_mfa_backup_codes') then
    execute 'create policy app_owner_insert_mfa_backup_codes on public.mfa_backup_codes for insert to app_owner with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mfa_backup_codes' and policyname='app_owner_update_mfa_backup_codes') then
    execute 'create policy app_owner_update_mfa_backup_codes on public.mfa_backup_codes for update to app_owner using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='mfa_backup_codes' and policyname='app_owner_delete_mfa_backup_codes') then
    execute 'create policy app_owner_delete_mfa_backup_codes on public.mfa_backup_codes for delete to app_owner using (true)';
  end if;
end
$do$;
grant select, insert, update, delete on public.mfa_backup_codes to app_owner;

-- app_owner (เจ้าของ RPC) ต้องอ่าน factor ที่ verified ได้ก่อนออกโค้ดสำรอง
-- (บังคับ TOTP ก่อนมี backup codes — D12-10 ห้ามเหลือ 0 factor ที่ใช้ได้จริง)
-- auth.mfa_factors เปิด RLS (เจ้าของ supabase_auth_admin) — column grant อย่างเดียว
-- ไม่พอ: SECURITY DEFINER ของ app_owner ต้องมี policy ไม่งั้น exists() เห็น 0 แถว
grant select (user_id, factor_type, status) on auth.mfa_factors to app_owner;
do $do$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'auth' and tablename = 'mfa_factors'
                    and policyname = 'ltc_app_owner_read_mfa') then
    execute 'create policy ltc_app_owner_read_mfa on auth.mfa_factors for select to app_owner using (true)';
  end if;
end
$do$;

-- ── สร้าง/แทนที่ชุดโค้ด (atomic replace) ─────────────────────────────────────
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

-- ── ใช้โค้ดสำรอง (verify แบบ single-use) ──────────────────────────────────────
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
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  if p_code is null or length(btrim(p_code)) < 6 or length(btrim(p_code)) > 32 then
    return jsonb_build_object('valid', false, 'remaining', null); -- รูปร่างไม่ใช่ = ไม่ใช่โค้ด
  end if;
  v_hash := encode(sha256(convert_to(lower(btrim(p_code)), 'UTF8')), 'hex');

  update public.mfa_backup_codes
     set used_at = now()
   where user_id = v_user and code_hash = v_hash and used_at is null
  returning true into v_found; -- สองยิงพร้อมกัน = ผ่านรายการเดียว (used_at is null)

  if v_found is not true then
    return jsonb_build_object('valid', false, 'remaining', null);
  end if;

  select count(*) into v_left from public.mfa_backup_codes
   where user_id = v_user and used_at is null;

  perform public.append_audit_event_internal(
    'AUTH_MFA_BACKUP_CODE_USED', 'user', v_user::text, null, null,
    jsonb_build_object('remaining', v_left),
    null, null, gen_random_uuid()::text, v_user);
  return jsonb_build_object('valid', true, 'remaining', v_left);
end;
$fn$;

-- ── สถานะ (metadata ล้วน — ไม่มีโค้ด/hash ในผลลัพธ์เด็ดขาด) ──────────────────────
create or replace function public.mfa_backup_codes_status()
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'generated', exists (select 1 from public.mfa_backup_codes c where c.user_id = v_user),
    'unused', (select count(*) from public.mfa_backup_codes c
                where c.user_id = v_user and c.used_at is null),
    'total', (select count(*) from public.mfa_backup_codes c where c.user_id = v_user),
    'lastGeneratedAt', (select max(c.created_at) from public.mfa_backup_codes c
                         where c.user_id = v_user));
end;
$fn$;

-- ── ลบชุดโค้ดทั้งหมด (เรียกเมื่อปิด MFA หรือ unenroll factor สุดท้าย) ───────────
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

alter function public.mfa_backup_codes_replace(text[]) owner to app_owner;
alter function public.mfa_backup_codes_consume(text) owner to app_owner;
alter function public.mfa_backup_codes_status() owner to app_owner;
alter function public.mfa_backup_codes_invalidate() owner to app_owner;

revoke execute on function public.mfa_backup_codes_replace(text[]) from public, anon;
revoke execute on function public.mfa_backup_codes_consume(text) from public, anon;
revoke execute on function public.mfa_backup_codes_status() from public, anon;
revoke execute on function public.mfa_backup_codes_invalidate() from public, anon;
grant execute on function public.mfa_backup_codes_replace(text[]) to authenticated;
grant execute on function public.mfa_backup_codes_consume(text) to authenticated;
grant execute on function public.mfa_backup_codes_status() to authenticated;
grant execute on function public.mfa_backup_codes_invalidate() to authenticated;
