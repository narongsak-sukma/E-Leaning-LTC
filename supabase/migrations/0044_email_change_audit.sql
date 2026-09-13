-- ═══ 0044 — audit การเปลี่ยนอีเมล (Wave F · D-f-2 · [#91]) ═════════════════════
-- D-f-2: การเปลี่ยนอีเมลต้องมี audit `USER_EMAIL_CHANGE_REQUEST` (BFF หลัง
-- updateUser สำเร็จ) + `USER_EMAIL_CHANGE_CONFIRMED` (GoTrue ยืนยันที่อีเมลใหม่
-- แล้ว — double opt-in) — ทั้งคู่เป็น USER_* ซึ่ง allowlist ของ append_audit_event
-- ปฏิเสธ (บทเรียน 1.2.3 → 0038) จึงต้องเป็นงาน DB ของ lead:
--   1) RPC `my_audit_email_change_request(p_new_email_sha256)` — user-JWT · เขียน
--      REQUEST durable · guard: บัญชีบทบาทบังคับ MFA (instructor/staff:*/super_admin)
--      ต้อง aal2 ตาม D-f-2 (SoD เดียวกับการลบบัญชี)
--   2) trigger บน auth.users AFTER UPDATE OF email (old <> new) — เขียน
--      CONFIRMED อัตโนมัติเมื่อ GoTrue ผูกอีเมลใหม่จริง (จุดเดียวที่รู้ความจริง)
-- context ทั้งคู่ = hash/domain-free: ไม่ใส่อีเมลเด็ดขาด (PII) — ใช้ sha256 ของ
-- อีเมลใหม่เพื่อ correlation ฝั่งตรวจสอบย้อนหลังเท่านั้น

-- ── 1) REQUEST (เรียกจาก BFF หลัง GoTrue updateUser สำเร็จ) ────────────────────
create or replace function public.my_audit_email_change_request(p_new_email_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_aal  text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '');
  v_mandatory boolean;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  if p_new_email_sha256 is null or p_new_email_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องส่ง sha256 ของอีเมลใหม่ (ERR-VAL-001|hash_format)'
      using errcode = '22023';
  end if;
  -- D-f-2: บัญชีบังคับ MFA ต้องผ่าน aal2 ก่อนขอเปลี่ยน (SoD)
  select exists (select 1 from public.role_assignments ra
                  where ra.user_id = v_user and ra.revoked_at is null
                    and ra.role in ('instructor','staff:viewer','staff:content',
                                    'staff:exam','staff:registrar','super_admin'))
    into v_mandatory;
  if v_mandatory and v_aal <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;

  perform public.append_audit_event_internal(
    'USER_EMAIL_CHANGE_REQUEST', 'user', v_user::text, null, null,
    jsonb_build_object('new_email_sha256', p_new_email_sha256),
    null, null, gen_random_uuid()::text, v_user);
  return jsonb_build_object('userId', v_user, 'audited', true);
end;
$fn$;

-- ── 2) CONFIRMED (trigger — จุดเดียวที่รู้ว่า GoTrue ผูกอีเมลใหม่สำเร็จ) ───────
create or replace function public.audit_email_change_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE' and new.email is distinct from old.email then
    begin
      perform public.append_audit_event_internal(
        'USER_EMAIL_CHANGE_CONFIRMED', 'user', new.id::text, null, null,
        jsonb_build_object('old_email_sha256', encode(sha256(convert_to(lower(old.email), 'UTF8')), 'hex'),
                           'new_email_sha256', encode(sha256(convert_to(lower(new.email), 'UTF8')), 'hex')),
        null, null, gen_random_uuid()::text, new.id);
    exception when others then
      -- audit เป็นหลักฐานเกิดรอง: ห้ามทำให้การยืนยันเปลี่ยนอีเมลของผู้ใช้พัง
      raise warning 'audit_email_change_confirmed: ข้าม audit ของ % (%)', new.id, sqlerrm;
    end;
  end if;
  return null; -- AFTER trigger
end;
$fn$;

alter function public.my_audit_email_change_request(text) owner to app_owner;
alter function public.audit_email_change_confirmed() owner to app_owner;

revoke execute on function public.my_audit_email_change_request(text) from public, anon;
grant  execute on function public.my_audit_email_change_request(text) to authenticated;

drop trigger if exists audit_email_change_confirmed on auth.users;
create trigger audit_email_change_confirmed
  after update of email on auth.users
  for each row execute function public.audit_email_change_confirmed();
