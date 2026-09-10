-- 0003_identity.sql — โดเมน 1: Identity & License + admin_sessions
-- ที่มา: DD §3.1, §3.8 (admin_sessions), §4.1–§4.2

-- ═══ profiles — DD §3.1 (PII — PDPA) ═══
create table public.profiles (
  id uuid primary key default gen_random_uuid(), -- = auth.users.id (1:1, มิเรอร์โดย trigger)
  display_name text not null,
  first_name text null,
  last_name text null,
  email text not null,
  phone text null, -- format E.164
  preferred_locale text not null default 'th',
  pdpa_consented_at timestamptz null,
  is_active boolean not null default true,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(), -- แบบแผนกลาง DD §1 (D18-M11)
  constraint profiles_locale_check check (preferred_locale in ('th','en')),
  constraint profiles_phone_e164_check check (phone is null or phone ~ '^\+[1-9]\d{1,14}$')
);
create unique index uq_profiles_email_active on public.profiles (email) where deleted_at is null;
create index profiles_deleted_at_idx on public.profiles (deleted_at);

-- ═══ role_assignments — DD §3.1 ═══
create table public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  role public.role_key not null,
  granted_by uuid null references public.profiles (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz null,
  reason text null,
  created_at timestamptz not null default now()
);
create unique index uq_role_assignments_user_role_active
  on public.role_assignments (user_id, role) where revoked_at is null;
create index role_assignments_user_active_idx
  on public.role_assignments (user_id) where revoked_at is null;
create index role_assignments_role_idx on public.role_assignments (role);

-- ═══ lawyer_licenses — DD §3.1 (PII — PDPA) ═══
-- FK → media_assets เพิ่มภายหลังใน 0004 (DD §4.1 — กันอ้างอิงวน)
create table public.lawyer_licenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id), -- ON DELETE RESTRICT (default)
  license_no text not null,
  status public.license_status not null default 'pending',
  evidence_media_id uuid null, -- FK → media_assets (0004)
  verified_by uuid null references public.profiles (id),
  verified_at timestamptz null,
  expires_on date null,
  revoked_at timestamptz null,
  rejected_reason text null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint lawyer_licenses_rejected_reason_check
    check ((status = 'rejected') = (rejected_reason is not null))
);
create unique index uq_lawyer_licenses_user_license_active
  on public.lawyer_licenses (user_id, license_no) where deleted_at is null;
create unique index uq_lawyer_licenses_license_no_active_license
  on public.lawyer_licenses (license_no) where revoked_at is null;
create index lawyer_licenses_license_no_idx
  on public.lawyer_licenses (license_no) where deleted_at is null;

-- ═══ license_applications — DD §3.1 (PII — PDPA) ═══
create table public.license_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  license_no text not null,
  status public.license_application_status not null default 'pending',
  evidence_media_id uuid null, -- FK → media_assets (0004)
  submitted_at timestamptz not null default now(),
  decided_by uuid null references public.profiles (id),
  decided_at timestamptz null,
  rejected_reason text null,
  resulting_license_id uuid null references public.lawyer_licenses (id),
  created_at timestamptz not null default now(),
  constraint license_applications_rejected_reason_check
    check (status <> 'rejected' or rejected_reason is not null)
);
create unique index uq_license_applications_user_pending
  on public.license_applications (user_id) where status = 'pending';
create index license_applications_status_submitted_idx
  on public.license_applications (status, submitted_at);

-- ═══ consents — DD §3.1 (PII — PDPA) ═══
create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  consent_type text not null,
  action text not null,
  policy_version text not null,
  source text not null,
  created_at timestamptz not null default now(),
  constraint consents_type_check check (consent_type in ('pdpa_essential','marketing','email_notify')),
  constraint consents_action_check check (action in ('grant','revoke')),
  constraint consents_source_check check (source in ('register','profile','staff'))
);
create index consents_user_type_time_idx
  on public.consents (user_id, consent_type, created_at desc);

-- ═══ notice_acknowledgments — DD §3.1 (append-only — F18/D12, D13-F11) ═══
create table public.notice_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  notice_key text not null,
  version text not null,
  acknowledged_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index uq_notice_ack_user_key_version
  on public.notice_acknowledgments (user_id, notice_key, version);
create index notice_ack_key_version_idx on public.notice_acknowledgments (notice_key, version);

-- ═══ admin_sessions — DD §3.8 ═══
create table public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  session_id text not null,
  mfa_satisfied boolean not null default false, -- บังคับ true (brief §8)
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz null,
  ended_reason public.admin_session_end null,
  ip_hash text not null,
  user_agent text null,
  created_at timestamptz not null default now()
);
create unique index uq_admin_sessions_session_id on public.admin_sessions (session_id);
create index admin_sessions_user_active_idx
  on public.admin_sessions (user_id) where ended_at is null;
create index admin_sessions_last_seen_idx on public.admin_sessions (last_seen_at);

-- ═══ Triggers ตาม DD §4.2 ═══

-- set_updated_at(): ทุกตารางที่มี updated_at (lesson_progress, notification_settings,
-- notification_templates — ผูก trigger ในไฟล์ของแต่ละตาราง)
create or replace function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- on_auth_user_created(): สร้าง profiles + role_assignments(citizen) — security definer (DD §4.2)
create or replace function public.on_auth_user_created() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.role_assignments (user_id, role, granted_by, reason)
  values (new.id, 'citizen', null, 'auto-grant on signup (DD §4.2)')
  on conflict do nothing;
  return new;
end;
$$;

-- ผูกกับ auth.users (Supabase จัดหา schema auth ให้)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.on_auth_user_created();
alter function public.on_auth_user_created() owner to app_owner;
grant insert, select on public.profiles to app_owner;
grant insert, select on public.role_assignments to app_owner;
