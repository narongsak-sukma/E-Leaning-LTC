-- 0008_audit.sql — audit_logs + audit_chain_anchors + append_audit_event()
-- ที่มา: DD §3.8 + AUDIT-LOG-DESIGN.md §3.3 (hash-chain) + §4 (append-only + EXECUTE contract)

-- ═══ audit_logs (DD §3.8 — append-only, hash-chain) ═══
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null,
  actor_user_id uuid null, -- ไม่มี FK (DD §3.8: กัน rewrite ประวัติ — lookup ที่แอป)
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id uuid null,
  before jsonb null,
  after jsonb null,
  ip_hash text null,
  user_agent text null,
  request_id text null,
  context jsonb null,
  prev_hash text not null,
  row_hash text not null
);

create unique index uq_audit_logs_row_hash on public.audit_logs (row_hash);
create index audit_logs_entity_idx
  on public.audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, occurred_at desc);
create index audit_logs_action_idx on public.audit_logs (action, occurred_at desc);
create index audit_logs_traversal_idx on public.audit_logs (occurred_at, id);

-- audit_chain_anchors (DD §3.8 - append-only, D11-6)
create table public.audit_chain_anchors (
  id uuid primary key default gen_random_uuid(),
  anchor_date date not null,
  last_id uuid not null,
  last_row_hash text not null,
  entry_count int not null check (entry_count > 0),
  created_at timestamptz not null default now()
);
create unique index uq_audit_chain_anchors_date on public.audit_chain_anchors (anchor_date);
create index audit_chain_anchors_created_idx on public.audit_chain_anchors (created_at);

-- ═══ certificate_verifications (DD §3.4) ═══
create table public.certificate_verifications (
  id uuid primary key default gen_random_uuid(),
  verify_code text not null,
  result public.verification_result not null,
  ip_hash text not null,
  user_agent text null,
  source text not null default 'qr' check (source in ('qr','manual')),
  verified_at timestamptz not null default now()
);
create index certificate_verifications_verified_at_idx
  on public.certificate_verifications (verified_at);
create index certificate_verifications_verify_code_idx
  on public.certificate_verifications (verify_code);

-- ═══ append_audit_event() — path เดียวของการเขียน audit (AUDIT §1.4/§4) ═══
-- signature 10 อาร์กิวเมนต์ตาม AUDIT §4:
--   (p_action, p_entity_type, p_entity_id, p_before, p_after, p_context,
--    p_actor_roles, p_ip_hash, p_user_agent, p_request_id)
--   * actor_user_id/actor_roles derive จาก session ฝั่ง server (auth.uid() + my_roles())
--     ตาม D15-N1 — ไม่รับค่าจาก caller
create or replace function public.append_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_context jsonb,
  p_actor_roles jsonb,
  p_ip_hash text,
  p_user_agent text,
  p_request_id text
) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_id uuid;
  v_actor uuid;
  v_roles text[];
  v_prev_id uuid;
  v_prev_at timestamptz;
  v_prev_hash text;
  v_occurred_at timestamptz;
  v_ip text;
  v_ua text;
  v_eid uuid;
  v_canonical text;
  v_hash text;
begin
  -- ── payload validation ภายใน (fail-closed) ──
  if p_action is null or btrim(p_action) = '' then
    raise exception 'append_audit_event: action ห้ามว่าง';
  end if;
  if p_entity_type is null or btrim(p_entity_type) = '' then
    raise exception 'append_audit_event: entity_type ห้ามว่าง';
  end if;
  if p_entity_id is not null then
    begin
      v_eid := p_entity_id::uuid;
    exception when others then
      raise exception 'append_audit_event: entity_id ต้องเป็น uuid';
    end;
  end if;
  if p_context is not null and jsonb_typeof(p_context) <> 'object' then
    raise exception 'append_audit_event: context ต้องเป็น jsonb object (AUDIT §3.2)';
  end if;
  if (p_before is not null and jsonb_typeof(p_before) <> 'object')
     or (p_after is not null and jsonb_typeof(p_after) <> 'object') then
    raise exception 'append_audit_event: before/after ต้องเป็น jsonb object';
  end if;
  if p_actor_roles is not null and jsonb_typeof(p_actor_roles) <> 'array' then
    raise exception 'append_audit_event: actor_roles ต้องเป็น jsonb array';
  end if;
  -- TODO(Wave C): payload schema ราย event (strict, AUDIT §3.2) — BFF zod + ตรวจซ้ำที่นี่

  -- ── actor/roles derive จาก session (D15-N1) ──
  v_actor := auth.uid();
  if v_actor is not null then
    v_roles := public.my_roles();
  else
    v_roles := '{}'::text[];
  end if;

  -- ── truncate คอลัมน์ตัดทอน (DD §3.8) ──
  v_ip := left(p_ip_hash, 128);
  v_ua := left(p_user_agent, 512);

  -- ── hash-chain ภายใต้ advisory lock (AUDIT §3.3) ──
  perform pg_advisory_xact_lock(hashtext('ltc:audit_chain')::bigint);
  select id, occurred_at, row_hash into v_prev_id, v_prev_at, v_prev_hash
  from public.audit_logs
  order by occurred_at desc, id desc
  limit 1;
  if not found then
    v_prev_hash := repeat('0', 40); -- genesis = 40 ค่า 0 (AUDIT §3.3)
  end if;
  -- strictly increasing ภายใต้ lock (D13-F3)
  v_occurred_at := greatest(now(), coalesce(v_prev_at, to_timestamp(0)) + interval '1 microsecond');

  v_id := gen_random_uuid();

  -- ── row_hash = sha256 บน canonical serialization ครบทุก evidentiary field ──
  -- ลำดับฟิลด์ตาม AUDIT §3.3; jsonb::text = canonical; NULL -> '' (สัญญา serialization)
  v_canonical := coalesce(v_prev_hash, '')
    || v_id::text
    || to_char(v_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    || p_action
    || coalesce(v_actor::text, '')
    || (to_jsonb(v_roles))::text
    || p_entity_type
    || coalesce(v_eid::text, '')
    || coalesce(p_before::text, '')
    || coalesce(p_after::text, '')
    || coalesce(p_context::text, '')
    || coalesce(v_ip, '')
    || coalesce(v_ua, '')
    || coalesce(p_request_id, '');
  v_hash := encode(sha256(convert_to(v_canonical, 'utf8')), 'hex');

  insert into public.audit_logs (
    id, occurred_at, actor_user_id, actor_roles, action,
    entity_type, entity_id, before, after,
    ip_hash, user_agent, request_id, context, prev_hash, row_hash
  ) values (
    v_id, v_occurred_at, v_actor, v_roles, p_action,
    p_entity_type, v_eid, p_before, p_after,
    v_ip, v_ua, p_request_id, p_context, v_prev_hash, v_hash
  );
  return v_id;
end;
$fn$;

alter function public.append_audit_event(text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  owner to app_owner;
grant insert, select on public.audit_logs to app_owner;

-- EXECUTE contract (AUDIT §4 — D15-N1): revoke จาก PUBLIC/anon ก่อน แล้ว grant สอง role
revoke execute on function public.append_audit_event(text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  from public, anon;
grant execute on function public.append_audit_event(text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  to authenticated, service_role;
