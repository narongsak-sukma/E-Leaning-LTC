-- 0001_extensions.sql — LTC E-Learning
-- ที่มา: DATA-DICTIONARY.md v1.0.0 §1 (extensions, D13-F13) + §2 (ENUM types)
-- ห้ามแก้นอก DD — เพิ่ม/แก้ต้องผ่าน DCR

-- ─── Extensions (DD §1 — D13-F13) ───────────────────────────────────────────
-- btree_gist: EXCLUDE ของ renewal_cycles ใช้ user_id WITH = (uuid) ใน GiST
-- PG15 ไม่มี built-in opclass สำหรับ uuid → ต้อง enable ก่อนสร้าง constraint
create extension if not exists btree_gist;

-- gen_random_uuid() = built-in PG13+ (UUID v4) — ไม่ต้อง pgcrypto (DD §1)
-- sha256(bytea) = built-in PG11+ — ใช้คำนวณ row_hash ของ audit chain ได้โดยไม่ต้อง pgcrypto

create schema if not exists public;

-- ─── DB roles เฉพาะของระบบ ──────────────────────────────────────────────────
-- app_owner   : owner ของ SECURITY DEFINER functions (AUDIT-LOG-DESIGN §1.4, DD §4.7)
-- purge_role  : บทบาท purge ตาม retention (DD §4.3 — F19/D12: ไม่ใช่ service_role ของแอป)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_owner') then
    create role app_owner nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'purge_role') then
    create role purge_role nologin noinherit;
  end if;
end $$;

-- ─── Supabase baseline shim (portability — no-op บน Supabase จริง) ─────────
-- image supabase/postgres bake baseline มาแล้ว: schema auth + auth.uid() +
-- roles anon/authenticated/service_role + auth.users · vanilla PostgreSQL
-- (CI / ทดสอบ RLS แบบแยก) ไม่มี baseline นี้ → สร้างแบบ idempotent ทุกคำสั่ง
-- บน Supabase จริงทุก statement เป็น no-op (if not exists / DO-guard)
create schema if not exists auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  -- bypassrls สะท้อนพฤติกรรมจริงของ Supabase (SDS §5.2: service_role ไม่ถูกคุมด้วย RLS)
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- auth.users stub ขั้นต่ำที่ on_auth_user_created (0003) ต้องใช้:
-- id/email/raw_user_meta_data — บน Supabase จริงเป็นตารางเต็มของ GoTrue
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant usage on schema auth to anon, authenticated, service_role;

-- auth.uid() — PG15 ไม่มี CREATE FUNCTION IF NOT EXISTS → กันด้วย pg_proc
-- stub อ่าน request.jwt.claims (contract เดียวกับ Supabase จริง) เพื่อให้
-- ทดสอบ RLS บน vanilla PG จำลองผู้ใช้ด้วย set_config('request.jwt.claims', ...)
-- ได้ตั้งแต่ Wave C — บน Supabase จริงข้าม (ใช้ของแท้ที่ GoTrue จัดการ)
-- ไร้ claims / claims ว่าง / json พัง = actor เป็น null ไม่ใช่ crash
-- (เกิดจริงกับ SECURITY DEFINER path ไร้ JWT เช่น job/service + superuser maintenance)
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
      language plpgsql stable
      set search_path = public
      as $body$
      begin
        return nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
      exception
        when others then return null;
      end;
      $body$
    $fn$;
  end if;
end $$;

-- ─── ENUM types (DD §2 — ครบ 25 ตัว ตามลำดับและชุดค่าเป๊ะ) ──────────────────
create type public.role_key as enum (
  'citizen','lawyer','instructor',
  'staff:viewer','staff:content','staff:exam','staff:registrar',
  'super_admin'
); -- colon ตาม brief §4 (DD §2 — Postgres enum label ใส่ ':' ได้)

create type public.license_status as enum ('pending','verified','rejected','expired');

create type public.course_status as enum ('draft','pending_review','published','archived');

create type public.lesson_type as enum ('video','document','quiz');

create type public.enrollment_status as enum ('active','completed','expired','cancelled');

create type public.media_provider as enum ('supabase_storage','r2','stream');

create type public.media_type as enum ('video','document','image','other');

create type public.media_status as enum ('uploading','processing','ready','failed');

create type public.progress_status as enum ('not_started','in_progress','completed');

create type public.question_type as enum ('single_choice','multiple_choice','true_false');

create type public.question_status as enum ('draft','active','retired');

create type public.question_difficulty as enum ('easy','medium','hard');

create type public.assessment_status as enum ('draft','published','closed','archived');

create type public.attempt_status as enum ('in_progress','submitted','passed','failed','expired','voided');

create type public.proctoring_mode as enum ('none','basic'); -- basic = สุ่มข้อ + จับเวลา + block session ซ้อน (SRS Appendix A)

create type public.certificate_status as enum ('valid','revoked','superseded');

create type public.verification_result as enum ('valid','revoked','superseded','not_found');

create type public.ledger_entry_type as enum ('accrual','adjustment','reversal','expiry');

create type public.cycle_status as enum ('open','closed','grace');

create type public.notification_channel as enum ('in_app','email');

create type public.email_status as enum ('queued','sending','sent','failed');

create type public.admin_session_end as enum ('logout','timeout','revoke','rotation');

create type public.license_application_status as enum ('pending','approved','rejected');

create type public.export_status as enum ('queued','processing','completed','failed');

create type public.security_event_type as enum ('login_fail','mfa_fail','lockout','rate_limit_hit','session_revoke');
