-- 0047_question_status_rpc.sql — Wave G P2 (D75 · แผน r4 ผ่าน gate r4 APPROVED [#92])
--
-- (1) RPC admin_set_question_status — เปิด/ปิดข้อสอบผ่านทางเดียว:
--     ลอกโครง 0032 admin_update_credit_rule_status (FOR UPDATE · ERR token ท้ายข้อความ
--     · transition matrix · version+1 · audit ใน TX เดียว · p_request_id ส่งเป็น
--     argument ของ append_audit_event_internal ตรง ๆ ตาม 0032:411)
-- (2) revoke UPDATE ตรงบน public.questions จาก authenticated — ปิดทางเขียนตรง
--     (D75): RPC เป็น SECURITY DEFINER owner app_owner จึงไม่กระทบ
--     (grant 0019:1031 + policy 0019:1040 คงอยู่) · INSERT/SELECT ของ authenticated
--     คงไว้ (bank create ใช้) · service_role คงไว้ · policy q_update (0010:570)
--     เหลือเป็น dead-layer กัน future regression (ไม่ drop — จดตามแผน)
--
-- แหล่งค่า p_request_id: header `x-request-id` ที่ middleware สร้าง (uuid) →
-- `text | null` — ไม่มี header = null (ตามต้นแบบ credit-rules route :179
-- `requestId ?? null` · บทเรียน F-3: request_id ต้องเป็น uuid จึงไม่ pass-through ค่าอื่น)

-- ─── (1) RPC admin_set_question_status ───
create or replace function public.admin_set_question_status(
  p_question_id uuid,
  p_bank_id uuid,
  p_status text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_from public.question_status;
  v_to public.question_status;
  v_version int;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|auth_required)'
      using errcode = '42501';
  end if;
  -- aal2 ตามแบบแผน staff guard 0032:226 — defense in depth คู่ชั้น BFF
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- D75: staff:exam/super_admin เท่านั้น — instructor เจ้าของก็ไม่มีสิทธิ์ toggle
  if not public.has_any_role(array['staff:exam','super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|question_status_forbidden)'
      using errcode = '42501';
  end if;
  if p_status not in ('active', 'retired') then
    raise exception 'ข้อมูลไม่ถูกต้อง: เปลี่ยนสถานะได้เฉพาะ active/retired (ERR-VAL-001|status_value)'
      using errcode = '22023';
  end if;

  -- FOR UPDATE ล็อกแถวก่อนอ่านสถานะ (แบบแผน 0032:374 gate r2 MINOR-1): toggle สอง
  -- คำขอพร้อมกันบนข้อเดียวกันต้องอ่านค่าหลังคนแรก commit — กรองทั้ง qid+bank_id
  -- (แบบแบบ D74: qid ผิด bank = ไม่พบ)
  select q.status into v_from
  from public.questions q
  where q.id = p_question_id and q.bank_id = p_bank_id
  for update;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|question_not_found)';
  end if;

  -- transition matrix (D75): draft→active · active→retired · retired→active
  -- อื่น ๆ รวม same-status = ปฏิเสธ (rejected ไม่บัมพ์ version ไม่ audit)
  if not (
        (v_from = 'draft'   and p_status = 'active')
     or (v_from = 'active'  and p_status = 'retired')
     or (v_from = 'retired' and p_status = 'active')
      ) then
    raise exception 'เปลี่ยนสถานะข้อสอบไม่ได้: ทำได้เฉพาะ ฉบับร่าง→ใช้งาน · ใช้งาน→ปลดระวัง · ปลดระวัง→ใช้งาน เท่านั้น (ERR-VAL-001|question_status_transition)'
      using errcode = '22023';
  end if;

  -- pre-check ตัวเลือก ≥1 เมื่อเป้า active (D20-M3 ปก normal path ด้วย 400 ไทย
  -- พร้อม code — trigger guard_question_activation 0010:587 เหลือเป็น backstop:
  -- ชน trigger = P0001 ไป 503 ตาม fallback)
  if p_status = 'active' and not exists (
      select 1 from public.question_options o where o.question_id = p_question_id) then
    raise exception 'ข้อมูลไม่ถูกต้อง: ข้อสอบต้องมีตัวเลือกอย่างน้อย 1 ข้อก่อนเปิดใช้งาน (ERR-VAL-001|question_needs_options)'
      using errcode = '22023';
  end if;

  -- cast ต้องระบุเอง: p_status เป็น text ปลายทางเป็น enum question_status —
  -- plpgsql ไม่ cast ให้ใน SET expression (probe จริงเจอ 42804 "column status is
  -- of type question_status but expression is of type text") · ปลอดภัยเพราะค่า
  -- ผ่าน in-check ('active','retired') มาก่อนแล้ว
  update public.questions q
  set status = p_status::public.question_status, version = q.version + 1
  where q.id = p_question_id
  returning q.status, q.version into v_to, v_version;
  if v_version is null then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|question_status_noop)'
      using errcode = 'P0001';
  end if;

  -- audit คู่ mutation ใน TX เดียว (D12-8) — action ใหม่ใน registry เดิม
  -- (0008:254 ตรวจแค่ไม่ว่าง) · p_request_id ลงช่อง audit จริง (0032:411 แบบแผน)
  perform public.append_audit_event_internal(
    'QB_QUESTION_STATUS', 'question', p_question_id::text, null, null,
    jsonb_build_object('question_id', p_question_id, 'from', v_from, 'to', v_to,
                       'version', v_version),
    null, null, p_request_id, v_actor);

  return jsonb_build_object('question_id', p_question_id, 'status', v_to,
                            'version', v_version);
end;
$fn$;
alter function public.admin_set_question_status(uuid, uuid, text, text) owner to app_owner;
revoke execute on function public.admin_set_question_status(uuid, uuid, text, text)
  from public, anon;
grant execute on function public.admin_set_question_status(uuid, uuid, text, text)
  to authenticated;

-- ─── (2) ปิดทางเขียนตรง — เหลือ path เดียว = RPC ข้างบน (D75 · ตามแบบแผน 0032:422) ───
--  SELECT คงเดิมสำหรับ GET/RLS q_read · INSERT คงไว้ (bank create) · service_role คงเดิม
--  ขอบเขตรัด: เฉพาะ UPDATE ของ questions — question_options ยังเปิด INSERT/UPDATE
--  แก่ authenticated (0010:639) ตามของเดิม (จด known behavior ไม่ขยายใน P2)
revoke update on public.questions from authenticated;
