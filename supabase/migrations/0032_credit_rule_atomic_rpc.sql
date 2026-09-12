-- ═══ 0032_credit_rule_atomic_rpc — กฎเครดิต: mutation+audit atomic + ปิด write ตรง ═══
-- Wave E Phase 3 (CRB) · DCR-9 · แก้ตาม codex gate r1 BLOCKER-2/3 (2026-09-12)
--
-- ประวัติการตัดสิน: เวอร์ชันแรกของไฟล์นี้เปิด CREDIT_RULE_CREATE/UPDATE ใน allowlist
-- ของ wrapper append_audit_event ฝั่ง service_role แบบ best-effort (อ้างแบบแผน
-- ADMIN_EXPORT/0025) — codex gate r1 **ปฏิเสธ**: AUDIT §1.5 บังคับ event ที่คู่กับ
-- business mutation เขียน audit ใน TX เดียวกัน (fail-closed) · ADMIN_EXPORT เป็น
-- read-side disclosure (ไม่คู่ mutation) จึงใช้เป็นแบบแผนของ config mutation ไม่ได้ ·
-- NOTICE/ความถี่ต่ำไม่ใช่ข้อยกเว้นที่ §1.5 ให้ — lead ยอมรับคำตัดสินและ implement
-- ทางเลือก "atomic RPC" ที่สงวนไว้ตั้งแต่แรก
--
-- เป้าหมาย 3 ข้อ (ปิดทุกช่องที่ mutation อาจเกิดโดยไม่มี audit):
--   1. **mutation+audit atomic**: RPC SECURITY DEFINER `admin_create_credit_rule`
--      + `admin_update_credit_rule_status` เขียนแถว credit_rules + audit
--      CREDIT_RULE_CREATE/UPDATE ผ่าน append_audit_event_internal **ใน TX เดียว**
--      — audit ล้ม = rollback ทั้งรายการ (§1.5 fail-closed แบบเดียวกับ 0019-r1
--      admin_issue/revoke/reissue_certificate)
--   2. **ตัด allowlist ที่เปิดไว้กลับสู่สถานะ 0025**: wrapper กลับมารับเฉพาะ
--      AUTH_*×12 + PII_ACCESS + ADMIN_EXPORT ทาง service_role — CREDIT_RULE_*
--      ไม่มีทางเขียนแบบ best-effort อีก (ปิดช่อง "commit แล้ว audit หลุด")
--   3. **ปิด mutation ตรงบนตาราง**: REVOKE INSERT/UPDATE บน credit_rules จาก
--      authenticated + service_role — BFF เขียนได้เฉพาะผ่าน RPC สองตัวนี้
--      (RLS cr_insert/cr_update ของ 0010 เหลือเป็นชั้น defense-in-depth ของ
--      อดีต — สิทธิ์ table ถูกถอนแล้วจึงไม่มี path ตรงเหลือ)
--
-- การตรวจสอบสิทธิ์ในตัว RPC (defense in depth คู่ requirePermission ของ BFF):
--   auth.uid() ต้องมี + has_any_role('staff:registrar','super_admin') +
--   **aal2 บังคับ** (auth.jwt() ->> 'aal' = 'aal2' — ปิดช่อง JWT aal1 เรียก
--   PostgREST ตรง ข้าม MFA gate ของ BFF — แก้ gate r1 BLOCKER-3 พร้อมกัน
--   สำหรับ RPC ใหม่ทั้งสอง; admin_credit_adjust ของ 0031 แก้แยกในไฟล์เดิม)
--
-- idempotent ทั้งไฟล์ (CREATE OR REPLACE + REVOKE/GRANT ซ้ำได้)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── (1) wrapper กลับสู่สถานะ 0025 — ตัด CREDIT_RULE_* ออกจาก allowlist ───
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
    -- class (ข) ผ่าน user-JWT RPC — 3 event เท่านั้น (D16-N1 + D18-B1)
    -- 0019-r2 (F3): CERT_VERIFY_PUBLIC ถูกถอนจาก allowlist นี้ — producer
    -- เดียว = record_certificate_verification (เขียนผ่าน
    -- append_audit_event_internal ภายใน TX ของ RPC เอง); ปล่อยไว้ตรงนี้ =
    -- ผู้ใช้ authenticated ปลอม event ผลการตรวจสอบ ({code,result:"valid"}) ได้
    -- 0025: ADMIN_EXPORT ไม่เปิดที่ class ข เช่นกัน — producer เดียว = BFF
    -- (service_role) หลังผ่าน report:export + scope ตาม type (D12-23)
    -- 0032 (atomic r2): CREDIT_RULE_* ไม่เปิดที่ class ข — mutation ของกฎ
    -- เครดิตเขียน audit ได้เฉพาะใน TX ของ admin_create/update_credit_rule_status
    if p_action not in ('AUDIT_READ','RATE_LIMIT_HIT','PII_ACCESS') then
      raise exception 'append_audit_event: event % ไม่อยู่ใน allowlist ของ RPC class ข (AUTH_*/mutation = server path เท่านั้น — AUDIT §4)', p_action
        using errcode = '42501';
    end if;
    if auth.uid() is null then
      raise exception 'append_audit_event: ต้องมี user JWT (ERR-AUTH-001)' using errcode = '42501';
    end if;
    v_keys := case p_action
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
    -- 0019-r1: CERT_ISSUE/CERT_REVOKE/CERT_REISSUE ถูกถอนออกจาก allowlist นี้ — mutation events
    -- ของ certificates ต้องบันทึกใน TX เดียวกับ mutation (D12-8) ซึ่งทำไม่ได้ผ่านสอง
    -- PostgREST call → ย้ายไป SECURITY DEFINER RPCs (admin_issue/revoke/reissue_certificate
    -- ท้ายไฟล์) เรียก append_audit_event_internal เอง (AUDIT §4 class ก) — wrapper คง
    -- PII_ACCESS (คิว eligible ของ D-4 อ่านชื่อผู้ผ่านเกณฑ์ D12-23) เหมือนเดิม
    -- 0025: + ADMIN_EXPORT — read-side disclosure event ของ reports/export (D55-6)
    -- บันทึกหลัง INSERT report_exports สำเร็จ (ไม่ใช่ mutation ของแถว business)
    -- 0032 (atomic r2): CREDIT_RULE_* ถูกตัดออก (เคยเปิดใน r1 แล้วย้อนตาม codex
    -- BLOCKER-2) — mutation ของกฎเครดิต = admin_create/update_credit_rule_status
    -- เท่านั้น ซึ่งเขียน audit ใน TX ของตัวเอง (class ก)
    if p_action not in ('AUTH_REGISTER','AUTH_LOGIN_OK','AUTH_LOGIN_FAIL','AUTH_LOGOUT',
                        'AUTH_MFA_ENROLLED','AUTH_MFA_DISABLED','AUTH_MFA_BACKUPS_REGENERATED',
                        'AUTH_PASSWORD_RESET_REQUEST','AUTH_PASSWORD_RESET_DONE',
                        'AUTH_PASSWORD_CHANGE','AUTH_LOCKOUT','AUTH_SESSION_REVOKE',
                        'PII_ACCESS','ADMIN_EXPORT') then
      raise exception 'append_audit_event: service_role บันทึกได้เฉพาะ AUTH_*/PII_ACCESS/ADMIN_EXPORT (R5-m1 + 0019-r1 + 0025 — AUDIT §4): %', p_action
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
      -- 0019-r1 — CERT_* ย้ายไป RPC path (คอมเมนต์ branch ข้างบน); context keys ของ
      -- event เหล่านั้นฝังอยู่ในตัว RPCs ตามชุด AUDIT §2.1 L85-87
      when 'PII_ACCESS'                     then array['endpoint','target_user_id','purpose']
      -- 0025 — AUDIT-LOG-DESIGN §3.3 แถว ADMIN_EXPORT: report_type / จำนวนแถว /
      -- ตัวกรอง (ห้ามค่ากรองที่เป็น PII — audit_context_pii_ok บังคับอยู่แล้ว)
      when 'ADMIN_EXPORT'                   then array['report_type','row_count','filters']
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

-- ─── (2) ตัวช่วยกลาง: ตรวจ actor+roles+aal2 ของ staff path (ใช้ซ้ำ 3 RPC) ───
create or replace function public.admin_credit_rule_staff_guard()
returns uuid
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  -- aal2 บังคับ (gate r1 BLOCKER-3): JWT aal1 (ยังไม่ผ่าน MFA) เรียกตรงที่
  -- PostgREST ข้าม MFA gate ของ BFF ไม่ได้ — เช่นเดียวกับที่ BFF บังคับผ่าน
  -- requirePermission + MFA aal2 (API-SPEC §1.2)
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  if not public.has_any_role(array['staff:registrar', 'super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|credit_rule_forbidden)'
      using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;
alter function public.admin_credit_rule_staff_guard() owner to app_owner;
revoke execute on function public.admin_credit_rule_staff_guard() from public, anon, authenticated, service_role;

-- ─── (3) admin_create_credit_rule — INSERT + audit ใน TX เดียว (class ก) ───
create or replace function public.admin_create_credit_rule(
  p_code text,
  p_name text,
  p_course_id uuid,
  p_credit_type text,
  p_credits numeric,
  p_valid_days int,
  p_carry_over boolean,
  p_required_credits_per_cycle numeric,
  p_priority int,
  p_renewal_cycle text,
  p_effective_from date,
  p_effective_to date,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid;
  r record;
begin
  v_actor := public.admin_credit_rule_staff_guard();

  -- validation ฝั่ง DB (defense in depth — BFF ตรวจ zod แล้ว ตรวจซ้ำชุดเดียวกัน)
  if p_code is null or p_code !~ '^CR-LTC-[0-9]{3}$' then
    raise exception 'ข้อมูลไม่ถูกต้อง: รหัสกฎต้องอยู่ในรูป CR-LTC-### (ERR-VAL-001|code_format)'
      using errcode = '22023';
  end if;
  if p_name is null or length(btrim(p_name)) < 1 or length(p_name) > 200 then
    raise exception 'ข้อมูลไม่ถูกต้อง: ชื่อกฎยาว 1-200 อักขระ (ERR-VAL-001|name_length)'
      using errcode = '22023';
  end if;
  if p_credit_type is null or p_credit_type !~ '^[a-z][a-z0-9_]{0,49}$' then
    raise exception 'ข้อมูลไม่ถูกต้อง: ประเภท credit ไม่ถูกต้อง (ERR-VAL-001|credit_type_format)'
      using errcode = '22023';
  end if;
  if p_credits is null or p_credits <= 0 or p_credits > 9999.99
     or p_credits <> round(p_credits, 2) then
    raise exception 'ข้อมูลไม่ถูกต้อง: จำนวน credit ต้องเป็นบวกไม่เกิน 9999.99 ทศนิยม 2 ตำแหน่ง (ERR-VAL-001|credits_range)'
      using errcode = '22023';
  end if;
  if p_priority is null or p_priority < 0 or p_priority > 2147483647 then
    raise exception 'ข้อมูลไม่ถูกต้อง: ลำดับความสำคัญต้องเป็นจำนวนเต็มไม่ติดลบ (ERR-VAL-001|priority_range)'
      using errcode = '22023';
  end if;
  if (p_required_credits_per_cycle is not null
      and (p_required_credits_per_cycle <= 0 or p_required_credits_per_cycle > 9999.99
           or p_required_credits_per_cycle <> round(p_required_credits_per_cycle, 2)))
     or (p_valid_days is not null and (p_valid_days < 1 or p_valid_days > 36500)) then
    raise exception 'ข้อมูลไม่ถูกต้อง: เกณฑ์รอบ/อายุความไม่อยู่ในช่วงที่กำหนด (ERR-VAL-001|rule_range)'
      using errcode = '22023';
  end if;
  if p_renewal_cycle is not null and p_renewal_cycle !~ '^[a-z][a-z0-9_]{0,49}$' then
    raise exception 'ข้อมูลไม่ถูกต้อง: รอบต่ออายุไม่ถูกต้อง (ERR-VAL-001|renewal_cycle_format)'
      using errcode = '22023';
  end if;
  if p_effective_from is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุวันเริ่มมีผล (ERR-VAL-001|effective_from_required)'
      using errcode = '22023';
  end if;
  if p_effective_to is not null and p_effective_to <= p_effective_from then
    raise exception 'ข้อมูลไม่ถูกต้อง: วันสิ้นสุดต้องหลังวันเริ่มมีผล (ERR-VAL-001|effective_range)'
      using errcode = '22023';
  end if;

  begin
    insert into public.credit_rules (
      code, name, course_id, credit_type, credits, valid_days, carry_over,
      required_credits_per_cycle, priority, renewal_cycle,
      effective_from, effective_to)
    values (
      p_code, p_name, p_course_id, p_credit_type, p_credits, p_valid_days,
      coalesce(p_carry_over, false), p_required_credits_per_cycle,
      coalesce(p_priority, 100), p_renewal_cycle, p_effective_from, p_effective_to)
    returning id, code, name, course_id, credit_type, credits, valid_days,
              carry_over, required_credits_per_cycle, priority, renewal_cycle,
              effective_from, effective_to, status, created_at
    into r;
  exception
    when unique_violation then
      raise exception 'ข้อมูลไม่ถูกต้อง: รหัสกฎนี้ถูกใช้แล้ว (ERR-VAL-001|code_duplicate)'
        using errcode = '23505';
    when foreign_key_violation then
      raise exception 'ข้อมูลไม่ถูกต้อง: หลักสูตรที่อ้างไม่มีจริง (ERR-VAL-001|course_not_found)'
        using errcode = '23503';
  end;

  -- audit ใน TX เดียวกับ INSERT — ล้ม = rollback ทั้งรายการ (AUDIT §1.5 class ก)
  perform public.append_audit_event_internal(
    'CREDIT_RULE_CREATE', 'credit_rule', (r.id)::text, null, null,
    jsonb_build_object(
      'rule_id', r.id, 'code', r.code, 'credit_type', r.credit_type,
      'credits', r.credits, 'effective_from', r.effective_from),
    null, null, p_request_id, v_actor);

  return to_jsonb(r);
end;
$fn$;
alter function public.admin_create_credit_rule(text, text, uuid, text, numeric, int, boolean, numeric, int, text, date, date, text) owner to app_owner;
revoke execute on function public.admin_create_credit_rule(text, text, uuid, text, numeric, int, boolean, numeric, int, text, date, date, text)
  from public, anon;
grant execute on function public.admin_create_credit_rule(text, text, uuid, text, numeric, int, boolean, numeric, int, text, date, date, text)
  to authenticated;

-- ─── (4) admin_update_credit_rule_status — lifecycle + audit ใน TX เดียว ───
create or replace function public.admin_update_credit_rule_status(
  p_rule_id uuid,
  p_status text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid;
  v_from text;
  r record;
begin
  v_actor := public.admin_credit_rule_staff_guard();
  if p_rule_id is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุกฎ (ERR-VAL-001|rule_id_required)'
      using errcode = '22023';
  end if;
  if p_status not in ('active', 'retired') then
    raise exception 'ข้อมูลไม่ถูกต้อง: เปลี่ยนสถานะได้เฉพาะ active/retired (ERR-VAL-001|status_value)'
      using errcode = '22023';
  end if;

  select status into v_from from public.credit_rules where id = p_rule_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|rule_not_found)';
  end if;
  if not ((v_from = 'draft' and p_status = 'active')
          or (v_from = 'active' and p_status = 'retired')) then
    raise exception 'เปลี่ยนสถานะกฎเครดิตไม่ได้: ทำได้เฉพาะเผยแพร่จากฉบับร่าง (ร่าง→ใช้งาน) หรือปลดระวัง (ใช้งาน→ปลดระวัง) (ERR-VAL-001|invalid_transition)'
      using errcode = '22023';
  end if;

  begin
    update public.credit_rules set status = p_status
    where id = p_rule_id
    returning id, code, name, course_id, credit_type, credits, valid_days,
              carry_over, required_credits_per_cycle, priority, renewal_cycle,
              effective_from, effective_to, status, created_at
    into r;
  exception
    when raise_exception then
      -- trigger guard_credit_rule_versioning (0010) ปฏิเสธ (race กับผู้ใช้อื่น) —
      -- ตอบข้อความ transition เดียวกับที่ตรวจเองไว้ (SQL message ไม่หลุดออก client)
      raise exception 'เปลี่ยนสถานะกฎเครดิตไม่ได้: ทำได้เฉพาะเผยแพร่จากฉบับร่าง (ร่าง→ใช้งาน) หรือปลดระวัง (ใช้งาน→ปลดระวัง) (ERR-VAL-001|invalid_transition)'
        using errcode = '22023';
  end;
  -- fail-closed (พบจาก integration จริงรอบสอง): UPDATE ที่ match 0 แถว (เช่น RLS
  -- ไม่มี policy UPDATE ให้ app_owner — ครั้งแรกของ 0032) เดิมคืน 200 แถว null
  -- ทั้งหมด + เขียน audit entity_id ว่าง = สำเร็จปลอม — บังคับ rollback เสมอ
  if r.id is null then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|rule_update_noop)'
      using errcode = 'P0001';
  end if;

  perform public.append_audit_event_internal(
    'CREDIT_RULE_UPDATE', 'credit_rule', (r.id)::text, null, null,
    jsonb_build_object(
      'rule_id', r.id, 'code', r.code,
      'status_from', v_from, 'status_to', r.status),
    null, null, p_request_id, v_actor);

  return to_jsonb(r);
end;
$fn$;
alter function public.admin_update_credit_rule_status(uuid, text, text) owner to app_owner;
revoke execute on function public.admin_update_credit_rule_status(uuid, text, text)
  from public, anon;
grant execute on function public.admin_update_credit_rule_status(uuid, text, text)
  to authenticated;

-- ─── (5) ปิด mutation ตรงบนตาราง — เหลือ path เดียว = RPC สองตัวข้างบน ───
--  (SELECT คงเดิมสำหรับ GET/RLS cr_read · migration รันในนาม superuser ไม่กระทบ)
revoke insert, update on public.credit_rules from authenticated, service_role;
-- definer ของ RPC สองตัวข้างบน = app_owner (definer ไม่มีสิทธิ์เกินที่ role นั้น
-- ได้รับ — แบบแผน 0010 §6): 0006/0010 ไม่เคยให้ INSERT/UPDATE บน credit_rules แก่
-- app_owner (เดิมเส้นเขียน = BFF service_role เขียนตรง) — RPC ใหม่เขียนตารางนี้เอง
-- จึงต้อง grant ให้เจ้าของฟังก์ชันโดยเฉพาะ (พบจาก integration จริง: ผ่าน guard
-- แล้วแต่ INSERT ได้ "permission denied for table credit_rules")
grant insert, update on public.credit_rules to app_owner;
-- RLS บังคับแม้ต่อ app_owner (definer ไม่มี BYPASSRLS): 0010 มี policy ของ
-- app_owner เฉพาะ SELECT/INSERT บนตารางนี้ — ไม่มี policy UPDATE = UPDATE
-- ของ RPC เงียบไป 0 แถว (พบจาก integration จริง: 200 + แถว null ทั้งหมด) —
-- เพิ่ม policy UPDATE ตามแบบแผน 0010 §6/0031 §9 (event_outbox · renewal_cycles)
drop policy if exists app_owner_update_credit_rules on public.credit_rules;
create policy app_owner_update_credit_rules
  on public.credit_rules for update to app_owner
  using (true) with check (true);
