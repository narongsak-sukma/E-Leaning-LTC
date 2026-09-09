-- 0006_cert_credit.sql — certificates + credit bank (DD §3.4 ต่อ, §3.5)

-- ═══ certificates (DD §3.4 - PII: holder_name_snapshot) ═══
create table public.certificates (
  id uuid primary key default gen_random_uuid(),
  cert_no text not null,
  verify_code text not null,
  enrollment_id uuid not null references public.enrollments (id),
  user_id uuid not null references public.profiles (id),
  course_id uuid not null references public.courses (id),
  holder_name_snapshot text not null,
  course_title_snapshot text not null,
  credit_snapshot numeric(6,2) null,
  issued_by uuid not null references public.profiles (id),
  issued_at timestamptz not null default now(),
  status public.certificate_status not null default 'valid',
  revoked_at timestamptz null,
  revoked_reason text null,
  pdf_media_id uuid null, -- FK เพิ่มท้ายไฟล์ (media_assets อยู่ 0004)
  superseded_by uuid null,
  supersedes_cert_id uuid null,
  created_at timestamptz not null default now(), -- แบบแผนกลาง DD §1 (D18-M11)
  constraint certificates_revoked_check
    check ((status = 'revoked') = (revoked_at is not null))
);

create unique index uq_certificates_cert_no on public.certificates (cert_no);
create unique index uq_certificates_verify_code on public.certificates (verify_code);
create unique index uq_certificates_enrollment_valid
  on public.certificates (enrollment_id) where status = 'valid';
create index certificates_user_idx on public.certificates (user_id);
create index certificates_supersedes_idx on public.certificates (supersedes_cert_id);

alter table public.certificates add constraint certificates_pdf_media_id_fkey
  foreign key (pdf_media_id) references public.media_assets (id);
alter table public.certificates add constraint certificates_superseded_by_fkey
  foreign key (superseded_by) references public.certificates (id);
alter table public.certificates add constraint certificates_supersedes_cert_id_fkey
  foreign key (supersedes_cert_id) references public.certificates (id);


-- ═══ credit_rules (DD §3.5 - Q1) ═══
create table public.credit_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  course_id uuid null references public.courses (id),
  credit_type text not null default 'general',
  credits numeric(6,2) not null check (credits > 0),
  valid_days int null,
  carry_over boolean not null default false,
  required_credits_per_cycle numeric(6,2) null,
  priority int not null default 100,
  effective_from timestamptz not null default now(),
  effective_to timestamptz null,
  status text not null default 'draft' check (status in ('draft','active','retired')),
  renewal_cycle text null,
  created_at timestamptz not null default now()
);
create unique index uq_credit_rules_code on public.credit_rules (code);
create index credit_rules_course_priority_idx on public.credit_rules (course_id, priority);

-- ═══ renewal_cycles (DD §3.5) ═══
create table public.renewal_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  cycle_no int not null check (cycle_no > 0),
  starts_on date not null,
  ends_on date not null,
  required_credits jsonb not null,
  status public.cycle_status not null default 'open',
  closed_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_renewal_cycles_user_no
  on public.renewal_cycles (user_id, cycle_no);
-- EXCLUDE: ห้ามรอบซ้อนกัน — ต้องมี btree_gist ก่อน (0001, D13-F13)
alter table public.renewal_cycles add constraint renewal_cycles_no_overlap
  exclude using gist (user_id with =, daterange(starts_on, ends_on) with &&);
create index renewal_cycles_user_open_idx
  on public.renewal_cycles (user_id) where status = 'open';

-- ═══ credit_ledger_entries (DD §3.5 - append-only) ═══
create table public.credit_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  renewal_cycle_id uuid not null references public.renewal_cycles (id),
  entry_type public.ledger_entry_type not null,
  credit_type text not null default 'general',
  amount numeric(6,2) not null,
  certificate_id uuid null references public.certificates (id),
  source_type text not null default 'assessment_attempt',
  source_id uuid null,
  original_entry_id uuid null,
  rule_id uuid null references public.credit_rules (id),
  reason text null,
  created_by uuid null references public.profiles (id),
  created_at timestamptz not null default now()
);
create index credit_ledger_user_cycle_idx
  on public.credit_ledger_entries (user_id, renewal_cycle_id);
create index credit_ledger_certificate_idx on public.credit_ledger_entries (certificate_id);
create unique index uq_credit_ledger_accrual_unique
  on public.credit_ledger_entries (source_type, source_id, credit_type)
  where entry_type = 'accrual' and source_id is not null;
alter table public.credit_ledger_entries
  add constraint credit_ledger_adjust_reversal_reason_check
  check (entry_type not in ('adjustment','reversal')
         or (reason is not null and created_by is not null));
alter table public.credit_ledger_entries add constraint credit_ledger_original_entry_fkey
  foreign key (original_entry_id) references public.credit_ledger_entries (id);
