-- 0038_user_admin_audit.sql — gate p5-r1 B4: audit USER_* แบบ durable atomic
--
-- ที่มา: BFF เดิมเรียก append_audit_event (RPC ชั้นนอก 0008 §4) กับ event
-- USER_CREATE/USER_DISABLE/USER_UPDATE — allowlist ของทั้งสองชั้น (authenticated
-- = 4 event class ข · service_role = AUTH_* เท่านั้น R5-m1) ปฏิเสธ USER_* ทุกครั้ง
-- → audit หลุดทั้งเส้น เหลือ WARN tripwire เก็บแค่ route (ผิด AUDIT §1.5 ที่กำหนด
-- mutation ต้องคู่ audit และต้องมี actor+reason แบบ durable)
--
-- ทางออก (แบบแผนเดียวกับ ROLE_GRANT/ROLE_REVOKE ของ 0035 §6 ที่ผ่าน gate มาแล้ว):
-- SECURITY DEFINER RPC รับ user-JWT → เขียน audit ผ่าน append_audit_event_internal
-- (path ของ business functions — DD §4.7 · actor = auth.uid() ที่ RPC derive เอง)
--
-- (1) admin_audit_user_created — USER_CREATE หลัง GoTrue invite + admin_grant_role
--     สำเร็จ: การสร้างบัญชีใน GoTrue เป็นระบบภายนอกจึงไม่มี TX ร่วมกับ DB แต่
--     เหตุการณ์ audit ต้อง durable — BFF เรียกพร้อม retry จำกัด · ล้มค้าง = 503
--     fail-closed (บัญชีถูกสร้างแล้วแต่ซองมี reason ให้ตรวจซ้ำ ไม่ใช่ WARN เงียบ)
-- (2) admin_set_user_active — profiles.is_active + audit USER_DISABLE/USER_UPDATE
--     atomic ใน TX เดียว · GoTrue ban/unban เกิดก่อนที่ BFF (ตัวบังคับจริง)

-- ─── (1) admin_audit_user_created — USER_CREATE durable (D-p5-6 · AUDIT §2.4) ───
create or replace function public.admin_audit_user_created(
  p_target_user_id uuid,
  p_role text,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- user:create = super_admin เท่านั้น (RBAC §2 · เดียวกับ POST /admin/users)
  if not public.has_any_role(array['super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|user_create_forbidden)'
      using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('instructor','staff:viewer','staff:content',
                                      'staff:exam','staff:registrar') then
    raise exception 'ข้อมูลไม่ถูกต้อง: มอบบทบาทนี้ผ่านระบบไม่ได้ (ERR-VAL-001|role_not_grantable)'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    raise exception 'ไม่พบผู้ใช้ (ERR-NF-001|user_not_found)' using errcode = 'P0002';
  end if;

  perform public.append_audit_event_internal(
    'USER_CREATE', 'user', (p_target_user_id)::text, null, null,
    jsonb_build_object(
      'target_user_id', p_target_user_id,
      'role', p_role,
      'reason', btrim(p_reason)),
    null, null, p_request_id, v_actor);

  return jsonb_build_object('userId', p_target_user_id, 'role', p_role, 'audited', true);
end;
$fn$;
alter function public.admin_audit_user_created(uuid, text, text, text) owner to app_owner;
revoke execute on function public.admin_audit_user_created(uuid, text, text, text) from public, anon;
grant execute on function public.admin_audit_user_created(uuid, text, text, text) to authenticated;

-- ─── (2) admin_set_user_active — profiles.is_active + USER_* audit TX เดียว ───
-- GoTrue ban/unban เกิดก่อนที่ BFF (ตัวบังคับจริง) — RPC นี้จึงรับผิดชอบเฉพาะฝั่ง DB:
-- mutation + audit atomic ตาม AUDIT §1.5 · เรียกซ้ำปลอดภัย (update ตำแหน่งเดิม +
-- audit append-only — BFF retry อาจซ้ำแถว audit ในสถานการณ์ response หาย รับได้)
create or replace function public.admin_set_user_active(
  p_target_user_id uuid,
  p_is_active boolean,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)'
      using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- user:disable = super_admin เท่านั้น (RBAC §2 · เดียวกับ PATCH /admin/users/{id})
  if not public.has_any_role(array['super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|user_disable_forbidden)'
      using errcode = '42501';
  end if;
  -- reason บังคับเมื่อปิดใช้งาน (BFF ตรวจ cross-field ก่อน — ชั้นนี้ซ้ำเป็นกำเนิดจริง)
  if p_is_active = false and (p_reason is null or length(btrim(p_reason)) < 10
                              or length(p_reason) > 500) then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if p_reason is not null and length(btrim(p_reason)) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 อักขระ (ERR-VAL-001|reason_required)'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_target_user_id) then
    raise exception 'ไม่พบผู้ใช้ (ERR-NF-001|user_not_found)' using errcode = 'P0002';
  end if;

  update public.profiles
     set is_active = p_is_active
   where id = p_target_user_id;
  if not found then
    raise exception 'ไม่พบผู้ใช้ (ERR-NF-001|user_not_found)' using errcode = 'P0002';
  end if;

  if p_is_active then
    -- USER_UPDATE (AUDIT §2.4): ชื่อฟิลด์ที่เปลี่ยนเท่านั้น ไม่ใส่ค่าเดิม/ใหม่
    perform public.append_audit_event_internal(
      'USER_UPDATE', 'user', (p_target_user_id)::text, null, null,
      jsonb_build_object(
        'target_user_id', p_target_user_id,
        'fields', to_jsonb(array['is_active'])),
      null, null, p_request_id, v_actor);
  else
    -- USER_DISABLE (AUDIT §2.4): target_user_id + reason (ระดับ WARN)
    perform public.append_audit_event_internal(
      'USER_DISABLE', 'user', (p_target_user_id)::text, null, null,
      jsonb_build_object(
        'target_user_id', p_target_user_id,
        'reason', btrim(p_reason)),
      null, null, p_request_id, v_actor);
  end if;

  return jsonb_build_object('userId', p_target_user_id, 'isActive', p_is_active);
end;
$fn$;
alter function public.admin_set_user_active(uuid, boolean, text, text) owner to app_owner;
revoke execute on function public.admin_set_user_active(uuid, boolean, text, text) from public, anon;
grant execute on function public.admin_set_user_active(uuid, boolean, text, text) to authenticated;
