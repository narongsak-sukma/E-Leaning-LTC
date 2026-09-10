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
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now() -- แบบแผนกลาง DD §1 (D18-M11)
);
create index certificate_verifications_verified_at_idx
  on public.certificate_verifications (verified_at);
create index certificate_verifications_verify_code_idx
  on public.certificate_verifications (verify_code);

-- ═══ append_audit_event() — path เดียวของการเขียน audit (AUDIT §1.4/§4 — B1/D18) ═══
-- โครงสร้าง 2 ชั้นตาม AUDIT §4 event-class contract:
--   1) append_audit_event_internal() — เนื้อกลาง (chain + insert + validation) เรียกได้จาก
--      SECURITY DEFINER business functions (DD §4.7) ที่ตรวจสิทธิ์ใน TX จริงแล้วเท่านั้น
--      — EXECUTE: app_owner เท่านั้น = server path ของ class (ก) mutation events
--   2) append_audit_event() — ชื่อตาม AUDIT §4 (signature 10 อาร์กิวเมนต์) สำหรับ RPC
--      — allowlist ราย event *ในนิยามฟังก์ชัน*: role `authenticated` → class (ข) 4 event
--      (CERT_VERIFY_PUBLIC/AUDIT_READ/RATE_LIMIT_HIT/PII_ACCESS) · role `service_role` →
--      AUTH_* 12 event (R5-m1: BFF เท่านั้น) · อื่น ๆ รวม mutation events ทั้งหมด = ปฏิเสธ
--      actor derive จาก auth.uid() เท่านั้น; p_actor_roles ถูกเมิน (derive ฝั่ง server)

-- ── helper: FreeText + PII two-track (AUDIT §3.2 — D11-9/D12-3/D13-F1) ──
-- คืน true เมื่อข้อความ "ปลอด" (ไม่มีรูปแบบบัตร 13 / เบอร์โทร / email / license 6–9)
-- กฎตัวเลขตรวจบน normalized (ตัด whitespace/ขีด/จุด) — email ตรวจบนรูปที่คง "." (D13-F1)
create or replace function public.audit_free_text_ok(p text) returns boolean
language plpgsql immutable
as $fn$
declare
  v_raw     text := coalesce(p, '');
  v_digits  text := regexp_replace(v_raw, '[\s\-–—_.]', '', 'g');
  v_email   text := regexp_replace(v_raw, '[\s\-–—]+', '', 'g');
begin
  if length(v_raw) > 500 then
    return false;
  end if;
  if v_digits ~ '\d{13}' then return false; end if;                       -- thai_national_id
  if v_digits ~ '(\+66|66|0)\d{8,9}' then return false; end if;           -- phone
  if v_email ~ '[\w.+-]+@[\w-]+\.[\w.]{2,}' then return false; end if;    -- email (คงจุด)
  if v_digits ~ '\d{6,9}' then return false; end if;                      -- license_no
  return true;
end;
$fn$;
alter function public.audit_free_text_ok(text) owner to app_owner;
revoke execute on function public.audit_free_text_ok(text) from public;

-- D19-B2: recursive PII scan บน context — คีย์ฟรีเท็กซ์ (reason/rejected_reason/device_hint/
-- purpose) ทุกชั้นความลึกต้องผ่าน FreeText (AUDIT §3.2 — ปิดช่องซ่อน PII ใน object ซ้อน
-- เช่น {"filters":{"reason":"...@x.com"}}); สกัลรองที่คีย์อื่นไม่สแกนเพราะ pattern
-- ตัวเลข (13 หลัก/6-9 หลัก) จะชน uuid ทั้งระบบเป็น false positive
create or replace function public.audit_context_pii_ok(p jsonb, p_depth int default 0)
returns boolean
language plpgsql
as $fn$
declare
  k text;
  v jsonb;
begin
  if p_depth > 8 then
    return false; -- จำกัดความลึก (DoS guard)
  end if;
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      -- D21-B4: ชื่อคีย์ต้องเป็น identifier เช่นเดียวกับ path RPC (ปิดช่อง PII ในชื่อคีย์)
      -- D22-B4''(r5): identifier ยังพา digit-run ได้ — ปิดช่องเบอร์/บัตรซ่อนในชื่อคีย์
      -- เช่น {"endpoint":{"phone_0812345678":true}} (license 6-9 / เบอร์ 9-10 / บัตร 13
      -- หลัก ครอบครบด้วย digit-run >= 6 หลัง strip `_` — หลักเดียวกับ audit_free_text_ok)
      if k !~ '^[a-z][a-z0-9_]{0,63}$'
         or regexp_replace(k, '_', '', 'g') ~ '\d{6}' then
        return false;
      end if;
      if k = any (array['reason','rejected_reason','device_hint','purpose']) then
        if jsonb_typeof(v) <> 'string' or not public.audit_free_text_ok(v #>> '{}') then
          return false;
        end if;
      elsif not public.audit_context_pii_ok(v, p_depth + 1) then
        return false;
      end if;
    end loop;
    return true;
  elsif jsonb_typeof(p) = 'array' then
    for v in select jsonb_array_elements(p) loop
      if not public.audit_context_pii_ok(v, p_depth + 1) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return true; -- สกัลรอง (uuid/ตัวเลข/boolean) ที่คีย์ไม่ใช่ฟรีเท็กซ์
end;
$fn$;
alter function public.audit_context_pii_ok(jsonb, int) owner to app_owner;
revoke execute on function public.audit_context_pii_ok(jsonb, int) from public;

-- D19-B2: diff (before/after) — สตริงทุกค่าต้องผ่าน PII scan เว้น uuid และ ISO timestamp
-- (ค่า diff ที่ชอบธรรมตามนโยบาย DD §4.5/AUDIT §3.2 = "ชื่อฟิลด์ที่เปลี่ยน"/uuid/วันที่
-- — ค่าดิบของฟิลด์ PII ห้ามเข้าทั้งคู่ path)
create or replace function public.audit_diff_ok(p jsonb, p_depth int default 0)
returns boolean
language plpgsql
as $fn$
declare
  k text;
  v jsonb;
  s text;
begin
  if p_depth > 8 then
    return false;
  end if;
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      if not public.audit_diff_ok(v, p_depth + 1) then
        return false;
      end if;
    end loop;
    return true;
  elsif jsonb_typeof(p) = 'array' then
    for v in select jsonb_array_elements(p) loop
      if not public.audit_diff_ok(v, p_depth + 1) then
        return false;
      end if;
    end loop;
    return true;
  elsif jsonb_typeof(p) = 'string' then
    s := p #>> '{}';
    return s ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           or s ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$'
           or public.audit_free_text_ok(s);
  end if;
  return true; -- ตัวเลข/boolean/null
end;
$fn$;
alter function public.audit_diff_ok(jsonb, int) owner to app_owner;
revoke execute on function public.audit_diff_ok(jsonb, int) from public;
grant execute on function public.audit_free_text_ok(text) to app_owner;

-- D20-B4: typed value validation สำหรับ context ที่มาจาก RPC ฝั่งผู้ใช้ (authenticated)
-- สตริงทุกค่าทุกคีย์ทุกชั้นต้องเป็น uuid / ISO-8601 / sha256-hex(64) / ผ่าน FreeText
-- และคีย์ที่ schema กำหนดเป็นตัวเลข/บูลีน/uuid ต้องเป็นชนิด jsonb นั้นจริง
-- (ปิดช่อง {"filters":{},"row_count":"person@example.com"} — ค่าสตริงใต้คีย์
-- ที่ไม่ใช่ฟรีเท็กซ์เดิมไม่ถูกสแกนเลย) — ใช้เฉพาะ path ผู้ใช้; service_role = BFF
-- trusted (R5-m1) ส่งชนิดถูกอยู่แล้วและอาจมี user_agent ยาวที่ digit-run บังเอิญ
create or replace function public.audit_rpc_context_schema_ok(p jsonb, p_depth int default 0)
returns boolean
language plpgsql
as $fn$
declare
  k text;
  v jsonb;
  s text;
begin
  if p_depth > 8 then
    return false;
  end if;
  if p is null then
    return true;
  end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      -- D21-B4: ชื่อคีย์ทุกชั้นต้องเป็น identifier — ปิดช่องซ่อน PII ใน "ชื่อคีย์"
      -- (เช่น {"group":"api","endpoint":{"person@example.com":true}}) เพราะ
      -- recursion เดิมสแกนเฉพาะค่า คีย์ที่มี @ / จุด / ขึ้นต้นด้วยตัวเลขจึงรอดทุกกฎ
      if k !~ '^[a-z][a-z0-9_]{0,63}$'
         or regexp_replace(k, '_', '', 'g') ~ '\d{6}' then
        return false;
      end if;
      if k = any (array['row_count','count','fail_count']) then
        if jsonb_typeof(v) <> 'number' then return false; end if;
      elsif k = any (array['mfa_used','recent_mfa']) then
        if jsonb_typeof(v) <> 'boolean' then return false; end if;
      elsif k = any (array['target_user_id','session_id','actor_id']) then
        if v is not null and (jsonb_typeof(v) <> 'string'
           or (v #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
          return false;
        end if;
      elsif not public.audit_rpc_context_schema_ok(v, p_depth + 1) then
        return false;
      end if;
    end loop;
    return true;
  elsif jsonb_typeof(p) = 'array' then
    for v in select jsonb_array_elements(p) loop
      if not public.audit_rpc_context_schema_ok(v, p_depth + 1) then
        return false;
      end if;
    end loop;
    return true;
  elsif jsonb_typeof(p) = 'string' then
    s := p #>> '{}';
    return s ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           or s ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$'
           or s ~ '^[0-9a-f]{64}$' -- sha256 hex (ip_hash) — ยกเว้นกฎ digit-run ของ FreeText
           or public.audit_free_text_ok(s);
  end if;
  return true; -- ตัวเลข/boolean/null นอกคีย์ typed
end;
$fn$;
alter function public.audit_rpc_context_schema_ok(jsonb, int) owner to app_owner;
revoke execute on function public.audit_rpc_context_schema_ok(jsonb, int) from public;

-- ── ชั้นใน: เนื้อกลางการเขียน audit (app_owner เท่านั้น) ──
create or replace function public.append_audit_event_internal(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_context jsonb,
  p_ip_hash text,
  p_user_agent text,
  p_request_id text,
  -- ใช้เฉพาะ RPC service path (AUTH_* ของ BFF): actor ที่ lift จาก context.user_id
  -- หลังตรวจ uuid แล้ว — business functions (DD §4.7) ไม่ส่ง ให้ derive จาก auth.uid()
  p_actor_override uuid default null
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
  v_ft text;
begin
  -- ── validation พื้นฐาน (fail-closed — เหมือนเดิมทุกข้อ) ──
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
  if length(coalesce(p_context::text, '')) > 4096
     or length(coalesce(p_before::text, '')) > 4096
     or length(coalesce(p_after::text, '')) > 4096 then
    raise exception 'append_audit_event: payload ใหญ่เกิน 4096 ต่อฟิลด์';
  end if;
  -- D19-B2: before/after (diff) — สตริงที่ไม่ใช่ uuid/timestamp ต้องผ่าน PII scan
  -- (นโยบาย DD §4.5/AUDIT §3.2: PII เก็บเฉพาะ "ชื่อฟิลด์ที่เปลี่ยน" — ค่าดิบห้ามเข้า)
  if (p_before is not null and not public.audit_diff_ok(p_before))
     or (p_after is not null and not public.audit_diff_ok(p_after)) then
    raise exception 'append_audit_event: before/after มีรูปแบบ PII (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)'
      using errcode = '22023';
  end if;
  -- D19-B2: FreeText + PII scan แบบ recursive ทุกชั้น (defense-in-depth แม้เป็น path ภายใน)
  if not public.audit_context_pii_ok(p_context) then
    raise exception 'append_audit_event: context มีรูปแบบ PII ในฟิลด์ฟรีเท็กซ์ (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)'
      using errcode = '22023';
  end if;

  -- ── actor/roles derive จาก session (D15-N1) / actor_override (service path เท่านั้น) ──
  v_actor := coalesce(p_actor_override, auth.uid());
  if v_actor is not null then
    if p_actor_override is not null then
      -- D19-M8: snapshot เฉพาะบทบาทที่ยังมีผล (revoked_at IS NULL) — บทบาทที่ถูกถอน
      -- (รวม super_admin) ต้องไม่ถูกบันทึกว่า active ตอนเกิดเหตุการณ์ (DD §3.8)
      select coalesce(array_agg(r.role::text), '{}'::text[]) into v_roles
      from public.role_assignments r
      where r.user_id = v_actor and r.revoked_at is null;
    else
      v_roles := public.my_roles();
    end if;
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

alter function public.append_audit_event_internal(text, text, text, jsonb, jsonb, jsonb, text, text, text, uuid)
  owner to app_owner;
revoke execute on function public.append_audit_event_internal(text, text, text, jsonb, jsonb, jsonb, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.append_audit_event_internal(text, text, text, jsonb, jsonb, jsonb, text, text, text, uuid)
  to app_owner;

-- ── ชั้นนอก: RPC path — allowlist ราย event ตาม AUDIT §4 class (ข) ──
create or replace function public.append_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_context jsonb,
  p_actor_roles jsonb, -- เมินโดยเจตนา: derive ฝั่ง server (D15-N1) — คงไว้ตาม signature ของ AUDIT §4
  p_ip_hash text,
  p_user_agent text,
  p_request_id text
) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_role text := coalesce(current_setting('role', true), ''); -- SET ROLE ของ session ผู้เรียก (ไม่เปลี่ยนตาม SECURITY DEFINER)
  v_keys text[];
  v_ft text;
  v_actor uuid;
begin
  if p_context is null then
    p_context := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_context) <> 'object' then
    raise exception 'append_audit_event: context ต้องเป็น jsonb object (AUDIT §3.2)';
  end if;

  if v_role = 'authenticated' then
    -- class (ข) ผ่าน user-JWT RPC — 4 event เท่านั้น (D16-N1 + D18-B1)
    if p_action not in ('CERT_VERIFY_PUBLIC','AUDIT_READ','RATE_LIMIT_HIT','PII_ACCESS') then
      raise exception 'append_audit_event: event % ไม่อยู่ใน allowlist ของ RPC class ข (AUTH_*/mutation = server path เท่านั้น — AUDIT §4)', p_action
        using errcode = '42501';
    end if;
    if auth.uid() is null then
      raise exception 'append_audit_event: ต้องมี user JWT (ERR-AUTH-001)' using errcode = '42501';
    end if;
    v_keys := case p_action
      when 'CERT_VERIFY_PUBLIC' then array['code','result']
      when 'AUDIT_READ'         then array['filters','row_count']
      when 'RATE_LIMIT_HIT'     then array['group','endpoint']
      when 'PII_ACCESS'         then array['endpoint','target_user_id','purpose']
    end;
    -- ตัดฟิลด์อ้างตัวตนที่ caller ใส่มา — actor มาจาก auth.uid() เท่านั้น (D16-N1)
    p_context := p_context - 'user_id' - 'actor_user_id';
    -- D20-B4: typed value validation ทุกค่าใต้ทุกคีย์ทุกชั้น (AUDIT §3.2 strict schema)
    if not public.audit_rpc_context_schema_ok(p_context) then
      raise exception 'append_audit_event: ค่า context ไม่ตรงชนิดตาม schema ของ event % (ERR-VAL-001)', p_action
        using errcode = '22023';
    end if;
    -- D20-B4b (AUDIT §2 แถว request_id/ip_hash + §4.5): request_id/ip_hash มาจาก
    -- middleware header เท่านั้น — RPC ฝั่งผู้ใช้ override เป็น null เสมอ
    -- (service_role path = BFF trusted ได้ฉีดจาก middleware ตามปกติ)
    p_ip_hash := null;
    p_request_id := null;
  elsif v_role = 'service_role' then
    -- R5-m1: AUTH_* ทั้งชุด (12 event ของ §2.1) = BFF (service key ไม่ออกจาก server) เท่านั้น
    if p_action not in ('AUTH_REGISTER','AUTH_LOGIN_OK','AUTH_LOGIN_FAIL','AUTH_LOGOUT',
                        'AUTH_MFA_ENROLLED','AUTH_MFA_DISABLED','AUTH_MFA_BACKUPS_REGENERATED',
                        'AUTH_PASSWORD_RESET_REQUEST','AUTH_PASSWORD_RESET_DONE',
                        'AUTH_PASSWORD_CHANGE','AUTH_LOCKOUT','AUTH_SESSION_REVOKE') then
      raise exception 'append_audit_event: service_role บันทึกได้เฉพาะ AUTH_* (R5-m1 — AUDIT §4): %', p_action
        using errcode = '42501';
    end if;
    v_keys := case p_action
      when 'AUTH_REGISTER'                  then array['method','user_agent']
      when 'AUTH_LOGIN_OK'                  then array['session_id','mfa_used','ip_hash']
      when 'AUTH_LOGIN_FAIL'                then array['reason','ip_hash']
      when 'AUTH_LOGOUT'                    then array['session_id','reason']
      when 'AUTH_MFA_ENROLLED'              then array['device_hint']
      when 'AUTH_MFA_DISABLED'              then array['reason']
      when 'AUTH_MFA_BACKUPS_REGENERATED'   then array['count','recent_mfa','user_agent','ip_hash']
      when 'AUTH_PASSWORD_RESET_REQUEST'    then array['ip_hash']
      when 'AUTH_PASSWORD_RESET_DONE'       then array['ip_hash']
      when 'AUTH_PASSWORD_CHANGE'           then array['method','session_id']
      when 'AUTH_LOCKOUT'                   then array['fail_count','ip_hash']
      when 'AUTH_SESSION_REVOKE'            then array['session_id','reason']
    end;
    -- actor = auth.uid() (null ใต้ service key) — ยกจาก context.user_id ที่ BFF (trusted) ใส่มา
    -- ตาม §1.2 "ใคร" ของ 5W แล้ว strip ออกจาก context ที่เก็บจริง
    if p_context ? 'user_id' then
      begin
        v_actor := (p_context ->> 'user_id')::uuid;
      exception when others then
        raise exception 'append_audit_event: context.user_id ต้องเป็น uuid' using errcode = '22023';
      end;
      p_context := p_context - 'user_id';
    end if;
  else
    raise exception 'append_audit_event: role % ไม่ได้รับอนุญาต (class ข เท่านั้นที่ RPC — AUDIT §4)', v_role
      using errcode = '42501';
  end if;

  -- strict keys: ห้ามคีย์นอก allowlist ของ event นั้น (zod .strict() ตรง §3.2)
  if exists (select 1 from jsonb_object_keys(p_context) k where k <> all (v_keys)) then
    raise exception 'append_audit_event: context มีคีย์นอก schema ของ event % (strict — AUDIT §3.2)', p_action
      using errcode = '22023';
  end if;
  -- D19-B2: AUDIT_READ.filters = typed allowlist .strict() ระดับซ้อนด้วย (D12-3 BLOCKER F9)
  -- — ห้าม field อื่นนอกชุด §3.2 และค่าทุก field ต้องตรงชนิด (uuid/datetime/short text)
  -- และผ่าน PII scan — ปิดช่อง exfil เช่น {"filters":{"email":"...@x.com"}}
  if p_action = 'AUDIT_READ' and p_context ? 'filters' then
    if jsonb_typeof(p_context -> 'filters') <> 'object' then
      raise exception 'append_audit_event: filters ต้องเป็น object (AUDIT §3.2)' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_object_keys(p_context -> 'filters') k
               where k <> all (array['actor_id','action','entity_type','entity_id',
                                     'occurred_from','occurred_to'])) then
      raise exception 'append_audit_event: filters มีคีย์นอก allowlist (strict — AUDIT §3.2)'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_each_text(p_context -> 'filters') f
      where (f.key in ('actor_id','entity_id')
             and f.value !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
         or (f.key in ('occurred_from','occurred_to')
             and f.value !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$')
         or (f.key in ('action','entity_type')
             and (length(f.value) > 64 or not public.audit_free_text_ok(f.value)))
    ) then
      raise exception 'append_audit_event: ค่า filters ไม่ถูกต้องตามชนิด/มีรูปแบบ PII (ERR-VAL-001)'
        using errcode = '22023';
    end if;
  end if;
  -- D19-B2: class ข (RPC) ไม่มี event ใดที่ schema มี diff — before/after เป็นของ
  -- class ก (business function derive ฝั่ง server) เท่านั้น
  if p_before is not null or p_after is not null then
    raise exception 'append_audit_event: before/after บันทึกผ่าน business function เท่านั้น — RPC ส่ง diff มาไม่ได้ (AUDIT §3.2/§4)'
      using errcode = '22023';
  end if;
  -- D19-B2: FreeText + PII แบบ recursive ทุกชั้น (รวม object ซ้อนเช่น filters)
  if not public.audit_context_pii_ok(p_context) then
    raise exception 'append_audit_event: context มีรูปแบบ PII ในฟิลด์ฟรีเท็กซ์ (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)'
      using errcode = '22023';
  end if;
  -- คีย์ uuid ที่รู้จักต้องเป็น uuid จริง
  if p_context ? 'target_user_id' then
    begin perform (p_context ->> 'target_user_id')::uuid;
    exception when others then
      raise exception 'append_audit_event: target_user_id ต้องเป็น uuid' using errcode = '22023';
    end;
  end if;

  return public.append_audit_event_internal(
    p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_context, p_ip_hash, p_user_agent, p_request_id,
    v_actor);
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
