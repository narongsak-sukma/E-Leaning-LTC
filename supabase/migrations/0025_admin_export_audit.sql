-- ═══════════════════════════════════════════════════════════════════════════
-- 0025_admin_export_audit — เปิด ADMIN_EXPORT ใน allowlist ของ append_audit_event
-- Wave E · D55-6 (reports/export) · อ้างอิง AUDIT-LOG-DESIGN §3.3 แถว ADMIN_EXPORT
--
-- เหตุผล: endpoint ส่งออกรายงาน (GET /admin/reports/{type}/export) ต้องบันทึก
-- audit ทุกครั้ง (D12-23 "การเปิดเผยข้อมูลออกนอกระบบ") แต่ allowlist ปัจจุบันของ
-- service_role path (0019:95-100) รับเฉพาะ AUTH_* 12 event + PII_ACCESS →
-- ADMIN_EXPORT โดน 42501 ทุกครั้ง เหลือแค่ WARN tripwire ไม่มีแถว audit จริง
--
-- ขอบเขตการแก้ (น้อยที่สุด — CREATE OR REPLACE ชั้น wrapper เหมือนแบบแผน 0019):
--   1. service_role allowlist += 'ADMIN_EXPORT' (producer เดียว = BFF export route
--      ที่ผ่าน requirePermission("report:export") + scope ต่อ type แล้วเท่านั้น)
--   2. v_keys arm ใหม่: report_type / row_count / filters — ตรง schema ของ
--      AUDIT-LOG-DESIGN §3.3 (ตัวกรองห้ามมีค่า PII — บังคับโดย audit_context_pii_ok
--      อยู่แล้วใน path เดิม)
--   สัญญาอื่นทุกอย่างคงเดิมเป๊ะ: strict keys / actor lift จาก context.user_id แล้ว
--   strip / PII scan recursive / before-after null / class ข (authenticated) ไม่ได้
--   event เพิ่ม — ผู้ใช้ทั่วไปยังปลอม ADMIN_EXPORT ไม่ได้ (42501 เหมือนเดิม)
--
-- entity ของ event นี้: entity_type='report_export' + entity_id=id แถว
-- report_exports ที่เพิ่ง INSERT (ไม่ใช่ id ที่ผู้เรียกเลือกเอง)
-- ═══════════════════════════════════════════════════════════════════════════

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
    raise exception 'append_audit_event: context มีรูปแบบ PII ในฟิลด์ฟรีเท็กซ์ (ERR-VAL-001|pii_rejected)'
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

-- ยืนยันสิทธิ์คงเดิม: wrapper ยังเรียกได้จาก service_role เท่านั้น (0008 + 0019 ตั้งไว้แล้ว
-- — ไม่มี GRANT ใหม่ ไม่มี REVOKE เพิ่ม; การเปลี่ยนแปลงอยู่ที่ allowlist ภายในตัวฟังก์ชัน)
