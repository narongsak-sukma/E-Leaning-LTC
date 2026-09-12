-- ═══ 0043 — optional consents จากการสมัคร (Wave F · D-f-3 · [#91]) ═════════════
-- PDPA: checkbox marketing/email_notify ที่ฟอร์มสมัคร (ค่าเริ่มต้นไม่ติ๊ก)
-- ต้องกลายเป็นแถว `consents` (0003) เมื่อ "ยืนยันอีเมลสำเร็จ" เท่านั้น
-- (กันบัญชีอีเมลตายสร้างแถว consent — D-f-3)
-- กลไก: F-3 ส่งค่าผ่าน signUp `options.data.consents_granted` → GoTrue เก็บใน
--   `auth.users.raw_user_meta_data` → trigger นี้ตัดแถวเมื่อ email_confirmed_at
--   เปลี่ยน null → non-null (transition guard — re-update ไม่ซ้ำ)
-- ตัวกรองฝั่ง DB (ป้องกัน metadata ปลอมจากช่องทางอื่น): key เฉพาะ
--   marketing/email_notify · version รูป `^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$` ·
--   dedupe ต่อ (user, consent_type, action='grant') · source ตายตัว 'register'
-- ความปลอดภัยของ flow หลัก: consent เป็นของเสริม — trigger ห้ามทำให้การยืนยัน
--   อีเมลพัง (profile ยังไม่ทันเกิด ฯลฯ) → exception ใด ๆ = RAISE WARNING แล้วผ่าน
--   (เห็นได้ใน log ของ postgres ไม่ใช่หายเงียบ)

create or replace function public.consents_from_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'UPDATE'
     and new.email_confirmed_at is not null
     and old.email_confirmed_at is null then
    begin
      insert into public.consents (user_id, consent_type, action, policy_version, source)
      select new.id,
             item ->> 'key',
             'grant',
             item ->> 'version',
             'register'
        from jsonb_array_elements(
               coalesce(new.raw_user_meta_data -> 'consents_granted', '[]'::jsonb)
             ) item
       where (item ->> 'key') in ('marketing', 'email_notify')
         and coalesce(item ->> 'version', '') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'
         and exists (select 1 from public.profiles pp where pp.id = new.id)
         and not exists (select 1 from public.consents c
                          where c.user_id = new.id
                            and c.consent_type = (item ->> 'key')
                            and c.action = 'grant');
    exception when others then
      -- ของเสริมห้ามบังคับ flow หลัก (การยืนยันอีเมล) — เห็นใน log ไม่ใช่หายเงียบ
      raise warning 'consents_from_signup: ข้ามการบันทึก consent ของ % (%)', new.id, sqlerrm;
    end;
  end if;
  return null; -- AFTER trigger
end;
$fn$;

alter function public.consents_from_signup() owner to app_owner;

drop trigger if exists consents_from_signup on auth.users;
create trigger consents_from_signup
  after update of email_confirmed_at on auth.users
  for each row execute function public.consents_from_signup();
