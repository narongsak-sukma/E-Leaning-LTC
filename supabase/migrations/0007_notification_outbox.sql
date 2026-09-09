-- 0007_notification_outbox.sql — notifications + outbox + reporting + security_events
-- ที่มา: DD §3.6, §3.7, §3.8 (security_events)

-- ═══ notifications (DD §3.6) ═══
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  title text not null,
  body text not null,
  severity text not null default 'info' check (severity in ('info','success','warning','error')),
  ref_type text null,
  ref_id uuid null,
  created_by uuid null references public.profiles (id),
  expires_at timestamptz null,
  created_at timestamptz not null default now()
);
create index notifications_created_idx on public.notifications (created_at desc);
create index notifications_topic_idx on public.notifications (topic);

-- ═══ notification_recipients (DD §3.6) ═══
create table public.notification_recipients (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id),
  user_id uuid not null references public.profiles (id),
  channel public.notification_channel not null,
  sent_at timestamptz null,
  read_at timestamptz null,
  deleted_at timestamptz null
);
create unique index uq_notification_recipients_triplet
  on public.notification_recipients (notification_id, user_id, channel);
create index notification_recipients_user_channel_idx
  on public.notification_recipients (user_id, channel) where deleted_at is null;

-- ═══ notification_settings (DD §3.6) ═══
create table public.notification_settings (
  user_id uuid primary key references public.profiles (id),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create trigger trg_notification_settings_updated_at
  before update on public.notification_settings
  for each row execute function public.set_updated_at();

-- ═══ notification_templates (DD §3.6) ═══
create table public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null,
  locale text not null default 'th' check (locale in ('th','en')),
  channel public.notification_channel not null,
  subject_tpl text not null,
  body_tpl text not null,
  version int not null default 1,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create unique index uq_notification_templates_active
  on public.notification_templates (template_key, locale, channel) where is_active;
create index notification_templates_key_idx on public.notification_templates (template_key);
create trigger trg_notification_templates_updated_at
  before update on public.notification_templates
  for each row execute function public.set_updated_at();

-- ═══ email_outbox (DD §3.6 - PII: to_email) ═══
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid null references public.profiles (id),
  to_email text not null,
  template_key text not null,
  payload jsonb not null default '{}'::jsonb,
  locale text not null default 'th',
  status public.email_status not null default 'queued',
  attempts int not null default 0,
  last_error text null,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz null
);
create index email_outbox_queue_idx
  on public.email_outbox (status, scheduled_at) where status in ('queued','sending');
create index email_outbox_recipient_idx on public.email_outbox (recipient_user_id);

-- ═══ event_outbox (DD §3.6 - D11-17) ═══
create table public.event_outbox (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','processing','processed','failed')),
  attempts int not null default 0,
  last_error text null,
  available_at timestamptz not null default now(),
  processed_at timestamptz null
);
create index event_outbox_queue_idx
  on public.event_outbox (status, available_at) where status in ('pending','processing');
create index event_outbox_topic_processed_idx on public.event_outbox (topic, processed_at);

-- ═══ report_exports (DD §3.7) ═══
create table public.report_exports (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles (id),
  report_type text not null,
  params jsonb not null default '{}'::jsonb,
  format text not null default 'csv' check (format in ('csv','json')),
  status public.export_status not null default 'queued',
  file_media_id uuid null,
  row_count int null,
  error text null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz null,
  expires_at timestamptz null
);
create index report_exports_requester_idx
  on public.report_exports (requested_by, requested_at desc);
create index report_exports_queue_idx
  on public.report_exports (status) where status in ('queued','processing');

alter table public.report_exports add constraint report_exports_file_media_id_fkey
  foreign key (file_media_id) references public.media_assets (id);

-- ═══ security_events (DD §3.8 - append-only per §4.4) ═══
create table public.security_events (
  id uuid primary key default gen_random_uuid(),
  event_type public.security_event_type not null,
  occurred_at timestamptz not null default now(),
  target_user_id uuid null references public.profiles (id),
  ip_hash text not null,
  user_agent text null,
  request_id text null,
  detail jsonb null
);
create index security_events_occurred_idx on public.security_events (occurred_at desc);
create index security_events_target_type_idx on public.security_events (target_user_id, event_type);
create index security_events_ip_type_idx
  on public.security_events (ip_hash, event_type, occurred_at desc);
