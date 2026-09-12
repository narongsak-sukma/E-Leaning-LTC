-- ═══ 0034_notifications — Wave E Phase 4 (NTF) · #89 ═══
-- lead-owned ตาม D36 · DOC-FIRST: SRS §3.8 (NTF-001..006) + API-SPEC §3.9/§2.4 + DD §3.6
-- แผน: .omc/plans/wave-e-p4-plan.md §4 (lane A) · การตัดสินใจผูกทุกจุด = D-p4-1..10
--
-- สิ่งที่ไฟล์นี้ทำ:
--   (1) seed notification_templates 14 แถว (7 key × 2 channel · th) — ON CONFLICT DO NOTHING
--       ตาม partial UNIQUE (เคารพการแก้ของ staff:content)
--   (2) notification_email_allowed() — ประตูอีเมล fail-closed สองชั้น (D-p4-4/F18/D12):
--       settings[family].email ≠ false **และ** consents ล่าสุด (email_notify) = grant
--   (3) render_notification() — active template + replace {{var}} · ตัวแปรที่ template
--       ต้องการแต่ payload ไม่มี = raise (fail-loud → backoff ไม่ส่งเมล์เพี้ยน)
--   (4) notification_dispatch_tick() — consumer ของ event_outbox 4 topic (exam.result ·
--       certificate.issued · certificate.revoked · credit.adjusted — ไม่กิน credit.accrual):
--       advisory-xact-lock global → temp table (≤5 รอบ×200) → ต่อ event 1 subtransaction
--       (ทุก payload cast อยู่ "ใน" subtx ราย event — poison-tolerant โดยโครงสร้าง บทเรียน
--       gate r4 B1) · dedupe (D-p4-3) → ประตูรายช่องทาง (gate r1 B3: in_app และ email
--       ตัดสินแยก — ปิด in_app = ไม่สร้างแถว recipient · ปิดครบทั้งคู่ = ข้าม event) →
--       render → INSERT notifications + recipients(in_app, sent_at=now) → email? →
--       INSERT email_outbox · ล้ม = attempts+1 + backoff 60s×2^n
--       cap 900s · ≥5 → failed (เหมือน credit_accrual_tick 0031 เป๊ะ)
--       + renewal_reminder_scan() — NTF-004 (D-p4-6): cycle open + ends_on = +30/+7 วัน
--   (5) ผู้ผลิต event 4 ตัว (D-p4-1) — create or replace คัดลอก byte-verbatim จากฉบับล่าสุด
--       + เพิ่มบล็อก INSERT event_outbox จุดเดียว (แบบเดียวกับที่ 0031 ทำกับ 0020/0019):
--         submit_attempt_core v4   ← 0031 v3 + event exam.result (ทั้งผ่าน/ไม่ผ่าน ·
--                                     gate r1 B5: payload มี attempt_no ครั้งที่สอบ)
--         admin_issue_certificate v2 ← 0019 v1 + event certificate.issued (gate r1/r2
--                                     B5: payload มี verify_code + certificate_id ครบ
--                                     ทั้งคู่ — ตัวระบุสองตัวคนละชนิด สำหรับลิงก์
--                                     verify/PDF ที่ worker ประกอบจาก config)
--         admin_revoke_certificate v4 ← 0031 v2 + event certificate.revoked (gate r2
--                                     B5: payload มี verify_code + certificate_id เหมือน
--                                     issued — AC ของ NTF-003 ครอบทั้งออกใบและเพิกถอน)
--         admin_credit_adjust v2   ← 0031 v1 + event credit.adjusted
--   (6) RPC ผู้ใช้: my_notifications (unreadFirst + keyset) · my_notification_read
--       (idempotent · NF-001) · my_notification_settings / _update (validate family/boolean
--       ใน SQL + upsert ตาม D-p4-5) · my_consents_get / my_consents_update
--       (marketing|email_notify · append-only · audit CONSENT_UPDATE)
--   (7) email_claim_batch / email_complete — คิว worker (D-p4-7): FOR UPDATE SKIP LOCKED +
--       reclaim crash (lease 10 นาทีจากจุด claim — gate r1 M1) · claim ตรวจสิทธิ์ล่าสุด
--       ก่อนส่ง (gate r1 B2: ถอน consent/ปิด settings หลัง enqueue → failed ไม่ส่ง) ·
--       ok → sent + recipients.sent_at · ไม่ ok → attempts+1 · backoff 60s×2^n cap 3600s ·
--       ≥5 → failed · last_error left 500
--   (8) grants/policies ของ app_owner (definer ไม่มี BYPASSRLS — แบบแผน 0010 §6 / 0031 §9)
--   (9) pg_cron 3 ตัว (upsert ตาม jobname — แบบแผน 0026/0031): ltc-notification-dispatch
--       ทุก 1 นาที · ltc-renewal-reminder 03:17 · ltc-email-outbox-purge 04:19 (D-p4-10)
--   D-p4-9: ไม่มี audit ต่อ notification (noise — เป็นผลลัพธ์ ไม่ใช่ action) · action ต้นทาง
--   ถูก audit ที่จุดเกิดแล้ว เพิ่มเฉพาะ CONSENT_UPDATE ของ my_consents_update
--   ห้าม CREATE type/table/index ใหม่ — ตาราง 5 + event_outbox + enum พร้อมจาก 0001/0007

-- ═══ (1) seed templates — 7 key × 2 channel = 14 แถว (th) ═══
-- ON CONFLICT ตาม partial UNIQUE uq_notification_templates_active (template_key, locale, channel)
-- WHERE is_active — เคารพการแก้ไขของ staff:content (ไม่ overwrite) · replay ใหม่ = seed ครบ
insert into public.notification_templates
  (template_key, locale, channel, subject_tpl, body_tpl)
values
  -- NTF-002: ผลสอบผ่าน
  ('exam.result.passed', 'th', 'in_app',
   'สอบผ่าน: {{course_title}}',
   'ยินดีด้วย คุณสอบผ่านหลักสูตร {{course_title}} ด้วยคะแนน {{score_pct}}% (เกณฑ์ผ่าน {{pass_pct}}%)'),
  ('exam.result.passed', 'th', 'email',
   'ผลการสอบ: คุณผ่านการสอบ หลักสูตร {{course_title}}',
   'เรียน คุณ{{full_name}}

ยินดีด้วย ท่านได้สอบผ่านการสอบหลักสูตร "{{course_title}}"
ด้วยคะแนน {{score_pct}}% (เกณฑ์ผ่าน {{pass_pct}}%) — ครั้งที่สอบที่ {{attempt_no}}

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน'),
  -- ผลสอบไม่ผ่าน (NTF-002 — คนละ template ตาม NTF-002)
  ('exam.result.failed', 'th', 'in_app',
   'ผลการสอบ: {{course_title}}',
   'คุณยังไม่ผ่านการสอบหลักสูตร {{course_title}} คะแนน {{score_pct}}% (เกณฑ์ผ่าน {{pass_pct}}%) — สามารถสอบใหม่ได้ตามกำหนดของหลักสูตร'),
  ('exam.result.failed', 'th', 'email',
   'ผลการสอบ: คุณยังไม่ผ่านการสอบ หลักสูตร {{course_title}}',
   'เรียน คุณ{{full_name}}

จากการสอบหลักสูตร "{{course_title}}" ครั้งที่สอบที่ {{attempt_no}}
ท่านได้คะแนน {{score_pct}}% ซึ่งยังไม่ผ่านเกณฑ์ผ่าน {{pass_pct}}%
ท่านสามารถสอบใหม่ได้ตามกำหนดของหลักสูตร

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน'),
  -- NTF-003: ออกใบประกาศนียบัตร
  ('certificate.issued', 'th', 'in_app',
   'ได้รับใบประกาศนียบัตรแล้ว',
   'ใบประกาศนียบัตรหลักสูตร {{course_title}} เลขที่ {{cert_no}} ออกให้เรียบร้อยแล้ว — ดูได้ที่เมนูใบประกาศนียบัตร'),
  ('certificate.issued', 'th', 'email',
   'ใบประกาศนียบัตร หลักสูตร {{course_title}} ออกให้แล้ว',
   'เรียน คุณ{{full_name}}

ทางสภาทนายความแห่งประเทศไทยได้ออกใบประกาศนียบัตรให้ท่านแล้ว
หลักสูตร: {{course_title}}
เลขที่ใบประกาศนียบัตร: {{cert_no}}

ตรวจสอบความถูกต้องของใบประกาศนียบัตร: {{verify_url}}
ดาวน์โหลด PDF: {{pdf_url}}

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน'),
  -- NTF-003: เพิกถอนใบประกาศนียบัตร (ไม่มีเหตุผลเต็มในข้อความ — แบบแผน PII)
  ('certificate.revoked', 'th', 'in_app',
   'ใบประกาศนียบัตรถูกเพิกถอน',
   'ใบประกาศนียบัตรเลขที่ {{cert_no}} ถูกเพิกถอนแล้ว หากมีข้อสงสัยกรุณาติดต่อสภาทนายความแห่งประเทศไทย'),
  ('certificate.revoked', 'th', 'email',
   'แจ้งเพิกถอนใบประกาศนียบัตร เลขที่ {{cert_no}}',
   'เรียน คุณ{{full_name}}

ใบประกาศนียบัตรเลขที่ {{cert_no}} ถูกเพิกถอนแล้ว
หากมีข้อสงสัยกรุณาติดต่อสภาทนายความแห่งประเทศไทย

ตรวจสอบสถานะใบประกาศนียบัตร: {{verify_url}}
ดาวน์โหลด PDF: {{pdf_url}}

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน'),
  -- แจ้งปรับหน่วยกิตสะสม
  ('credit.adjusted', 'th', 'in_app',
   'มีการปรับหน่วยกิตสะสม',
   'ระบบได้ปรับหน่วยกิตสะสมของคุณ จำนวน {{amount}} หน่วย หากมีข้อสงสัยกรุณาติดต่อสภาทนายความแห่งประเทศไทย'),
  ('credit.adjusted', 'th', 'email',
   'แจ้งปรับหน่วยกิตสะสม จำนวน {{amount}} หน่วย',
   'เรียน คุณ{{full_name}}

ระบบได้ปรับหน่วยกิตสะสมของท่าน จำนวน {{amount}} หน่วย
หากมีข้อสงสัยกรุณาติดต่อสภาทนายความแห่งประเทศไทย

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน'),
  -- NTF-004: เตือนรอบต่ออายุ 30/7 วัน (D-p4-6)
  ('renewal.reminder.30d', 'th', 'in_app',
   'แจ้งเตือน: รอบสะสมหน่วยกิตครบกำหนดใน 30 วัน',
   'รอบสะสมหน่วยกิตของคุณสิ้นสุดวันที่ {{cycle_end}} ปัจจุบันสะสมได้ {{earned}}/{{required}} หน่วย ขาดอีก {{missing}} หน่วย'),
  ('renewal.reminder.30d', 'th', 'email',
   'แจ้งเตือนรอบต่ออายุวุฒิบัตร ครบกำหนดวันที่ {{cycle_end}}',
   'เรียน คุณ{{full_name}}

รอบสะสมหน่วยกิตเพื่อต่ออายุวุฒิบัตรของท่านจะสิ้นสุดวันที่ {{cycle_end}}
ปัจจุบันท่านสะสมได้ {{earned}} / {{required}} หน่วย ขาดอีก {{missing}} หน่วย
กรุณาสะสมหน่วยกิตให้ครบก่อนวันครบกำหนด

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน'),
  ('renewal.reminder.7d', 'th', 'in_app',
   'แจ้งเตือน: รอบสะสมหน่วยกิตครบกำหนดใน 7 วัน',
   'รอบสะสมหน่วยกิตของคุณสิ้นสุดวันที่ {{cycle_end}} ปัจจุบันสะสมได้ {{earned}}/{{required}} หน่วย ขาดอีก {{missing}} หน่วย'),
  ('renewal.reminder.7d', 'th', 'email',
   'แจ้งเตือนรอบต่ออายุวุฒิบัตร ครบกำหนดวันที่ {{cycle_end}}',
   'เรียน คุณ{{full_name}}

รอบสะสมหน่วยกิตเพื่อต่ออายุวุฒิบัตรของท่านจะสิ้นสุดวันที่ {{cycle_end}}
ปัจจุบันท่านสะสมได้ {{earned}} / {{required}} หน่วย ขาดอีก {{missing}} หน่วย
กรุณาสะสมหน่วยกิตให้ครบก่อนวันครบกำหนด

ด้วยความเคารพ
สภาทนายความแห่งประเทศไทย — ระบบแจ้งเตือนอัตโนมัติ

ถ้าไม่ต้องการรับอีเมล ปิดได้ที่ การตั้งค่าการแจ้งเตือน')
  on conflict (template_key, locale, channel) where is_active do nothing;

-- ═══ (2) notification_email_allowed — ประตูอีเมล fail-closed สองชั้น (D-p4-4/F18/D12) ═══
-- คืน true เฉพาะเมื่อ (ก) settings[family].email ≠ false (ไม่มีแถว/ไม่มีคีย์ = อนุญาต — default on)
-- **และ** (ข) consents ล่าสุดของ (user, email_notify) = grant (ไม่มีแถวเลย = ปฏิเสธ — PDPA)
-- in_app ไม่ผูก consent ใด — ส่งเสมอ
create or replace function public.notification_email_allowed(p_user uuid, p_family text)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $fn$
declare
  v_action text;
begin
  if p_user is null then
    return false;
  end if;
  -- (ก) settings: family.email = false → ปิด (ค่าที่เขียนผ่าน my_notification_settings_update
  --     ถูก validate เป็น boolean เท่านั้น — cast นี้จึงปลอดภัย)
  if exists (
    select 1 from public.notification_settings ns
    where ns.user_id = p_user
      and coalesce((ns.settings -> p_family ->> 'email')::boolean, true) is false
  ) then
    return false;
  end if;
  -- (ข) consents ล่าสุด = grant เท่านั้น · ไม่มีแถวเลย = ปฏิเสธ (fail-closed)
  select c.action into v_action
  from public.consents c
  where c.user_id = p_user and c.consent_type = 'email_notify'
  order by c.created_at desc, c.id desc
  limit 1;
  if not found then
    return false;
  end if;
  return (v_action = 'grant');
end;
$fn$;
alter function public.notification_email_allowed(uuid, text) owner to app_owner;
revoke execute on function public.notification_email_allowed(uuid, text)
  from public, anon, authenticated;
grant execute on function public.notification_email_allowed(uuid, text)
  to app_owner, service_role;

-- ═══ (2b) notification_in_app_allowed — ประตู in_app ราย family (gate r1 B3 / NTF-005) ═══
-- ต่างจากอีเมลตรงที่ "ไม่ผูก consent" (D-p4-4) — ตัดสินจาก settings ล่าสุดเท่านั้น:
-- settings[family].in_app = false → ปิด · ไม่มีแถว/ไม่มีคีย์/ไม่ใช่ false = เปิด (default on)
-- ใช้ ณ จุดผลิต (dispatch_tick/renewal_reminder_scan) — ปิดแล้ว "ไม่สร้างแถว recipient
-- in_app เลย" (ไม่ใช่สร้างแล้วซ่อน) เพื่อให้ my_notifications/unread_count ไม่นับ
create or replace function public.notification_in_app_allowed(p_user uuid, p_family text)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $fn$
begin
  if p_user is null then
    return false;
  end if;
  return not exists (
    select 1 from public.notification_settings ns
    where ns.user_id = p_user
      and coalesce((ns.settings -> p_family ->> 'in_app')::boolean, true) is false
  );
end;
$fn$;
alter function public.notification_in_app_allowed(uuid, text) owner to app_owner;
revoke execute on function public.notification_in_app_allowed(uuid, text)
  from public, anon, authenticated;
grant execute on function public.notification_in_app_allowed(uuid, text)
  to app_owner, service_role;

-- ═══ (3) render_notification — active template + replace {{var}} ═══
-- fail-loud (แผน §4.3): ตัวแปรที่ template ต้องการแต่ vars ไม่มี = raise → event ล้มเข้า
-- backoff ไม่ส่งเมล์เพี้ยน · var เกินใน vars = ไม่เป็นไร
-- เชิงอรรถ: แผนเขียน signature (p_key, p_locale, p_vars) — เพิ่ม p_channel เข้ามาเป็นพารามิเตอร์
-- ที่ 3 เพราะ notification_templates เป็นราย channel (uq: key+locale+channel) — ไม่มี
-- พารามิเตอร์ channel จะเลือกแถว template ไม่ได้เลย · สัญญาผลลัพธ์คงเดิม: {subject, body}
create or replace function public.render_notification(
  p_key text,
  p_locale text,
  p_channel public.notification_channel,
  p_vars jsonb
) returns jsonb
language plpgsql stable
security definer
set search_path = public
as $fn$
declare
  v_subject text;
  v_body text;
  v_var text;
  v_vars jsonb := coalesce(p_vars, '{}'::jsonb);
begin
  if p_key is null or p_channel is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุ template key และช่องทาง (ERR-VAL-001|render_args)'
      using errcode = '22023';
  end if;
  select t.subject_tpl, t.body_tpl into v_subject, v_body
  from public.notification_templates t
  where t.template_key = p_key
    and t.locale = coalesce(p_locale, 'th')
    and t.channel = p_channel
    and t.is_active
  limit 1;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ: template "%" ช่องทาง % ยังไม่มีหรือถูกปิดใช้งาน (ERR-NF-001|template_not_found)', p_key, p_channel;
  end if;
  -- fail-loud: วนตัวแปรทั้งหมดที่ template อ้าง (subject+body) — ขาดใน vars = raise
  for v_var in
    select distinct (regexp_matches(v_subject || v_body, '\{\{([a-z0-9_]+)\}\}', 'g'))[1]
  loop
    if not (v_vars ? v_var) then
      raise exception 'ข้อมูลไม่ถูกต้อง: template % ต้องการตัวแปร {{%}} ที่ไม่พบในข้อมูล (ERR-VAL-001|render_missing_var)', p_key, v_var
        using errcode = '22023';
    end if;
    v_subject := replace(v_subject, '{{' || v_var || '}}', coalesce(v_vars ->> v_var, ''));
    v_body := replace(v_body, '{{' || v_var || '}}', coalesce(v_vars ->> v_var, ''));
  end loop;
  return jsonb_build_object('subject', v_subject, 'body', v_body);
end;
$fn$;
alter function public.render_notification(text, text, public.notification_channel, jsonb) owner to app_owner;
revoke execute on function public.render_notification(text, text, public.notification_channel, jsonb)
  from public, anon, authenticated;
grant execute on function public.render_notification(text, text, public.notification_channel, jsonb)
  to app_owner, service_role;

-- ═══ (4a) notification_dispatch_tick — consumer ของ 4 topic (D-p4-2/D-p4-3) ═══
-- โครงสร้างเดียวกับ credit_accrual_tick (0031): advisory-xact-lock global → temp table
-- (≤5 รอบ × 200 event) → ต่อ event 1 subtransaction · ล้ม = attempts+1 + last_error +
-- backoff 60s×2^n cap 900s · ≥5 → failed
-- ต่างจาก credit tick โดยเจตนา (D-p4-2): ไม่มี phase-1 cast ใด ๆ — ทุก payload cast
-- อยู่ "ใน" subtransaction ราย event เท่านั้น (บทเรียน gate r4 B1) → poison event ล้ม
-- ราย event แล้วเข้า backoff/failed ตามกติกา คิวปกติไหลต่อ
create or replace function public.notification_dispatch_tick() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_rounds int := 0;
  v_batch int;
  v_processed int := 0;
  v_already int := 0;
  v_email int := 0;
  v_failed int := 0;
  v_skipped int := 0;
  v_event uuid;
  v_user uuid;
  v_ref_id uuid;
  v_family text;
  v_ref_type text;
  v_tpl_key text;
  v_severity text;
  v_full_name text;
  v_amount numeric;
  v_vars jsonb;
  v_render jsonb;
  v_notif uuid;
  v_in_app boolean;
  v_email_ok boolean;
  r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('ltc:notification_dispatch')::bigint) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;

  -- ── เฟส 1: เก็บ event ทั้งหมด (≤5 รอบ × 200) — ไม่มี cast ใด ๆ ในเฟสนี้ ═══
  -- drop if exists กันซ้ำใน pooled session ที่ TX ก่อน abort ค้างไว้ (แบบ 0031)
  drop table if exists _notif_events;
  create temp table _notif_events (
    seq bigint generated always as identity primary key,
    event_id uuid not null unique,
    topic text not null,
    payload jsonb not null
  ) on commit drop;

  <<collect>>
  loop
    v_rounds := v_rounds + 1;
    if v_rounds > 5 then exit; end if; -- ≤1,000 event/tick (รอบถัดไป 1 นาที)
    insert into _notif_events (event_id, topic, payload)
    select e.id, e.topic, e.payload
      from public.event_outbox e
     where e.topic in ('exam.result','certificate.issued','certificate.revoked','credit.adjusted')
       and e.status = 'pending'
       and e.available_at <= now()
       and not exists (select 1 from _notif_events t where t.event_id = e.id)
     order by e.available_at, e.id
     limit 200;
    get diagnostics v_batch = row_count;
    exit when v_batch = 0;        -- คิวหมด
    exit when v_batch < 200;      -- เศษท้ายคิว
  end loop collect;

  -- ── เฟส 2: ต่อ event 1 subtransaction — ทุก payload cast ใน begin/exception นี้ ──
  for r in select event_id, topic, payload from _notif_events order by seq loop
    v_event := r.event_id;
    begin
      -- cast ราย event — poison (user_id/source_id เสีย) ล้มเฉพาะ event ตัวเอง (r4 B1)
      v_user := (r.payload ->> 'user_id')::uuid;
      v_ref_id := coalesce(
        nullif(r.payload ->> 'source_id', '')::uuid,
        nullif(r.payload ->> 'certificate_id', '')::uuid,
        nullif(r.payload ->> 'ledger_id', '')::uuid);

      -- D-p4-5: topic → settings family
      v_family := case r.topic
        when 'exam.result' then 'exam.result'
        when 'certificate.issued' then 'certificate'
        when 'certificate.revoked' then 'certificate'
        when 'credit.adjusted' then 'credit'
        else null end;
      -- ref_type ตาม topic (dedupe + แถว notification ใช้ค่าเดียวกัน)
      -- certificate.issued = 'certificate' เหมือน revoked (สมมาตร — id/ประเภทอ้างอิง
      -- เดียวกันตลอดตระกูล ไม่มีเหตุผลให้ฝั่งออกใบเป็น null)
      v_ref_type := case r.topic
        when 'exam.result' then coalesce(r.payload ->> 'source_type', 'assessment_attempt')
        when 'certificate.issued' then 'certificate'
        when 'certificate.revoked' then 'certificate'
        when 'credit.adjusted' then 'credit_ledger'
        else null end;
      -- template key + severity — exam แตก variant ตามผล (NTF-002 คนละ template ผ่าน/ไม่ผ่าน)
      v_tpl_key := case r.topic
        when 'exam.result' then case when coalesce((r.payload ->> 'passed')::boolean, false)
                                     then 'exam.result.passed' else 'exam.result.failed' end
        when 'certificate.issued' then 'certificate.issued'
        when 'certificate.revoked' then 'certificate.revoked'
        when 'credit.adjusted' then 'credit.adjusted'
        else null end;
      v_severity := case r.topic
        when 'exam.result' then case when coalesce((r.payload ->> 'passed')::boolean, false)
                                     then 'success' else 'warning' end
        when 'certificate.issued' then 'success'
        when 'certificate.revoked' then 'warning'
        when 'credit.adjusted' then 'info'
        else 'info' end;
      if v_user is null or v_ref_id is null or v_family is null or v_tpl_key is null then
        raise exception 'ข้อมูลไม่ถูกต้อง: payload ขาด user_id/ref_id (ERR-VAL-001|dispatch_payload)';
      end if;

      -- D-p4-3 dedupe (at-least-once → exactly-once) ก่อน INSERT เสมอ:
      -- แถวเดิม (topic, ref_id, user) ช่องทางใดก็ได้ มีอยู่ = ปิด event processed +
      -- นับ already_notified — ไม่กรองช่องทาง (gate r1 B3: ผู้ใช้ปิด in_app แล้ว event
      -- ถูกจัดการด้วยแถว email เดียว ก็ต้อง dedupe ได้เหมือนกัน)
      if exists (
        select 1
        from public.notifications n
        join public.notification_recipients nr
          on nr.notification_id = n.id
        where n.topic = r.topic
          and n.ref_id = v_ref_id
          and nr.user_id = v_user
      ) then
        update public.event_outbox
        set status = 'processed', processed_at = now(), last_error = null
        where id = v_event;
        v_already := v_already + 1;
      else
        -- ประตูรายช่องทาง (gate r1 B3 / NTF-005): in_app และ email ตัดสินแยกจากกัน —
        -- in_app ดู settings ของ family เท่านั้น (ไม่ผูก consent · D-p4-4) · email ยัง
        -- fail-closed สองชั้นเหมือนเดิม · ปิดครบทั้งสองช่องทาง = ไม่สร้างแถวเลย
        -- (ผู้ใช้ไม่ต้องการรับ — event ปิดเป็น processed ไม่ retry ไปเรื่อย ๆ)
        v_in_app := public.notification_in_app_allowed(v_user, v_family);
        v_email_ok := public.notification_email_allowed(v_user, v_family);
        if not v_in_app and not v_email_ok then
          update public.event_outbox
          set status = 'processed', processed_at = now(), last_error = null
          where id = v_event;
          v_skipped := v_skipped + 1;
        else
          -- ชื่อเต็ม (แบบ holderNameOf — ชื่อ+นามสกุล, fallback display_name)
          select coalesce(nullif(concat_ws(' ', nullif(pr.first_name, ''), nullif(pr.last_name, '')), ''),
                          nullif(pr.display_name, ''), 'สมาชิก') into v_full_name
          from public.profiles pr where pr.id = v_user;

          -- ตัวแปร render ต่อ topic — ครบตามที่ template อ้าง (render จะ raise ถ้าขาด) ·
          -- email ใบประกาศฯ ส่งตัวระบุสองตัวให้ worker ประกอบลิงก์ (gate r2 B5 ·
          -- adjudication-2: SQL ผู้ผลิตไม่รู้ env — ส่ง verify_code + certificate_id
          -- เท่านั้น): verify_url = base/verify/<verify_code> (หน้า verify สาธารณะ ·
          -- route ยอมรับ verify_code/cert_no) แต่ pdf_url = base/api/v1/certificates/
          -- <certificate_id>/pdf เพราะ route PDF บังคับ {code} = UUID ของ certificates.id
          -- (API-SPEC §3.6) — ใช้ verify_code (nanoid-43) จะได้ 400 เสมอ
          v_vars := jsonb_build_object('full_name', v_full_name);
          if r.topic = 'exam.result' then
            v_vars := v_vars || jsonb_build_object(
              'course_title', r.payload ->> 'course_title_th',
              'score_pct', r.payload ->> 'score_pct',
              'pass_pct', r.payload ->> 'pass_pct',
              'attempt_no', r.payload ->> 'attempt_no');
          elsif r.topic = 'certificate.issued' then
            v_vars := v_vars || jsonb_build_object(
              'course_title', r.payload ->> 'course_title_th',
              'cert_no', r.payload ->> 'cert_no',
              'verify_code', r.payload ->> 'verify_code',
              'certificate_id', r.payload ->> 'certificate_id');
          elsif r.topic = 'certificate.revoked' then
            v_vars := v_vars || jsonb_build_object(
              'cert_no', r.payload ->> 'cert_no',
              'verify_code', r.payload ->> 'verify_code',
              'certificate_id', r.payload ->> 'certificate_id');
          elsif r.topic = 'credit.adjusted' then
            v_amount := (r.payload ->> 'amount')::numeric;
            v_vars := v_vars || jsonb_build_object('amount',
              case when v_amount >= 0 then '+' else '' end
              || to_char(v_amount, 'FM999999990.00'));
          end if;

          -- render in_app — template หาย/ตัวแปรขาด = raise → backoff (fail-loud) ·
          -- เนื้อหาแถว notification มาจาก template in_app เสมอ (แม้ผู้ใช้ปิด in_app
          -- แต่ยังเปิด email — แถวเป็นที่เก็บเนื้อหาอ้างอิงของอีเมล)
          v_render := public.render_notification(v_tpl_key, 'th', 'in_app', v_vars);
          insert into public.notifications (topic, title, body, severity, ref_type, ref_id)
          values (r.topic, v_render ->> 'subject', v_render ->> 'body', v_severity, v_ref_type, v_ref_id)
          returning id into v_notif;

          -- ปิด in_app แล้ว = ไม่สร้างแถว recipient in_app เลย (gate r1 B3 — badge/
          -- inbox ไม่เห็น ไม่ใช่สร้างแล้วซ่อน)
          if v_in_app then
            insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
            values (v_notif, v_user, 'in_app', now());
          end if;

          -- email? (D-p4-4 fail-closed สองชั้น) — tick เข้าคิวเท่านั้น · render+ส่งจริงที่
          -- worker (D-p4-8) · payload ใส่ notification_id เสมอ (D-p4-8) + user_id + vars
          if v_email_ok then
            insert into public.email_outbox (recipient_user_id, to_email, template_key, payload, locale)
            select v_user, pr.email, v_tpl_key,
                   jsonb_build_object('notification_id', v_notif, 'user_id', v_user, 'vars', v_vars),
                   'th'
            from public.profiles pr where pr.id = v_user;
            -- แถวผู้รับช่องทาง email (sent_at = null รอ worker ยืนยัน — D-p4-7)
            insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
            values (v_notif, v_user, 'email', null)
            on conflict (notification_id, user_id, channel) do nothing;
            v_email := v_email + 1;
          end if;

          update public.event_outbox
          set status = 'processed', processed_at = now(), last_error = null
          where id = v_event;
          v_processed := v_processed + 1;
        end if;
      end if;
    exception when others then
      -- ต่อ event: attempts+1 + backoff 60s×2^n cap 900s · ≥5 → failed (เหมือน 0031 เป๊ะ)
      update public.event_outbox
      set attempts = attempts + 1,
          last_error = left(sqlerrm, 500),
          status = case when attempts + 1 >= 5 then 'failed' else 'pending' end,
          available_at = now() + make_interval(
            secs => least(60 * power(2, attempts + 1), 900))
      where id = v_event;
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('skipped', false,
                            'processed', v_processed,
                            'already_notified', v_already,
                            'email_queued', v_email,
                            'skipped_no_channel', v_skipped,
                            'failed', v_failed);
end;
$fn$;
alter function public.notification_dispatch_tick() owner to app_owner;
revoke execute on function public.notification_dispatch_tick() from public, anon, authenticated;
grant execute on function public.notification_dispatch_tick() to app_owner, service_role, postgres;

-- ═══ (4b) renewal_reminder_scan — NTF-004 (D-p4-6) ═══
-- cycle status='open' และ ends_on = current_date+30 หรือ +7 → เจ้าของยังเป็น lawyer
-- → แจ้งเตือน in_app + อีเมล (ประตูเดียวกับ D-p4-4) · dedupe ธรรมชาติ: topic ต่างกัน
-- renewal.reminder.30d/7d + ref_type='renewal_cycle' ref_id=cycle_id + เงื่อนไข D-p4-3
-- เนื้อหามียอด earned/required/missing คำนวณจาก ledger จริง (SUM เหมือน my_credit_summary)
create or replace function public.renewal_reminder_scan() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_notified int := 0;
  v_already int := 0;
  v_not_lawyer int := 0;
  v_email int := 0;
  v_failed int := 0;
  v_skipped int := 0;
  v_topic text;
  v_full_name text;
  v_vars jsonb;
  v_render jsonb;
  v_notif uuid;
  v_required numeric;
  v_earned numeric;
  v_missing numeric;
  v_cycle_end text;
  v_in_app boolean;
  v_email_ok boolean;
  r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('ltc:renewal_reminder')::bigint) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;

  for r in
    select c.id as cycle_id, c.user_id, c.ends_on, c.required_credits,
           (c.ends_on - current_date) as days_left
    from public.renewal_cycles c
    where c.status = 'open'
      and c.ends_on in (current_date + 30, current_date + 7)
    order by c.user_id, c.ends_on
  loop
    begin
      -- เจ้าของรอบต้องยังเป็น lawyer (ไม่ revoked) — D-p4-6
      if not exists (
        select 1 from public.role_assignments ra
        where ra.user_id = r.user_id and ra.role = 'lawyer' and ra.revoked_at is null
      ) then
        v_not_lawyer := v_not_lawyer + 1;
        continue;
      end if;

      v_topic := 'renewal.reminder.' || r.days_left::text || 'd';

      -- dedupe เงื่อนไขเดียวกับ D-p4-3 → scan รันซ้ำไม่สร้างซ้ำ — ไม่กรองช่องทาง
      -- (เหตุผลเดียวกับ tick: แถว email เดี่ยวก็ต้อง dedupe ได้ — gate r1 B3)
      if exists (
        select 1
        from public.notifications n
        join public.notification_recipients nr
          on nr.notification_id = n.id
        where n.topic = v_topic and n.ref_id = r.cycle_id and nr.user_id = r.user_id
      ) then
        v_already := v_already + 1;
        continue;
      end if;

      -- ยอด earned/required/missing ณ วัน scan — SUM จาก ledger จริง (แบบ my_credit_summary)
      select coalesce(sum(le.amount), 0) into v_earned
      from public.credit_ledger_entries le
      where le.renewal_cycle_id = r.cycle_id;
      select coalesce(sum(kv.value::numeric), 0) into v_required
      from jsonb_each_text(r.required_credits) as kv(k, value);

      v_missing := greatest(v_required - v_earned, 0);

      -- วันครบกำหนดรูปแบบไทย (พ.ศ.) — เช่น 12/10/2569
      v_cycle_end := to_char(r.ends_on, 'DD/MM/') || (extract(year from r.ends_on)::int + 543)::text;

      -- ชื่อเต็ม (แบบ holderNameOf — ชื่อ+นามสกุล, fallback display_name)
      select coalesce(nullif(concat_ws(' ', nullif(pr.first_name, ''), nullif(pr.last_name, '')), ''),
                      nullif(pr.display_name, ''), 'สมาชิก') into v_full_name
      from public.profiles pr where pr.id = r.user_id;

      v_vars := jsonb_build_object(
        'full_name', v_full_name,
        'cycle_end', v_cycle_end,
        'earned', rtrim(to_char(v_earned, 'FM999999990.00'), '.'),
        'required', rtrim(to_char(v_required, 'FM999999990.00'), '.'),
        'missing', rtrim(to_char(v_missing, 'FM999999990.00'), '.'));

      -- ประตูรายช่องทาง (gate r1 B3) — family 'renewal' · ปิดครบทั้งสองช่องทาง = ข้าม
      v_in_app := public.notification_in_app_allowed(r.user_id, 'renewal');
      v_email_ok := public.notification_email_allowed(r.user_id, 'renewal');
      if not v_in_app and not v_email_ok then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      -- render in_app + เขียนแถว (ประตู consent/settings ใช้ family 'renewal')
      v_render := public.render_notification(v_topic, 'th', 'in_app', v_vars);
      insert into public.notifications (topic, title, body, severity, ref_type, ref_id)
      values (v_topic, v_render ->> 'subject', v_render ->> 'body', 'warning', 'renewal_cycle', r.cycle_id)
      returning id into v_notif;
      if v_in_app then
        insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
        values (v_notif, r.user_id, 'in_app', now());
      end if;

      if v_email_ok then
        insert into public.email_outbox (recipient_user_id, to_email, template_key, payload, locale)
        select r.user_id, pr.email, v_topic,
               jsonb_build_object('notification_id', v_notif, 'user_id', r.user_id, 'vars', v_vars),
               'th'
        from public.profiles pr where pr.id = r.user_id;
        -- แถวผู้รับช่องทาง email (sent_at = null รอ worker ยืนยัน — D-p4-7)
        insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
        values (v_notif, r.user_id, 'email', null)
        on conflict (notification_id, user_id, channel) do nothing;
        v_email := v_email + 1;
      end if;

      v_notified := v_notified + 1;
    exception when others then
      -- scan รายวัน ไม่มี event_outbox ให้ backoff — รอบใดล้ม = ข้าม แล้วลองวันถัดไป
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object('skipped', false,
                            'notified', v_notified,
                            'already', v_already,
                            'not_lawyer', v_not_lawyer,
                            'email_queued', v_email,
                            'skipped_no_channel', v_skipped,
                            'failed', v_failed);
end;
$fn$;
alter function public.renewal_reminder_scan() owner to app_owner;
revoke execute on function public.renewal_reminder_scan() from public, anon, authenticated;
grant execute on function public.renewal_reminder_scan() to app_owner, service_role, postgres;

-- ═══ (5) ผู้ผลิต event 4 ตัว (D-p4-1) — create or replace คัดลอก byte-verbatim ═══
-- จากฉบับล่าสุด + เพิ่มบล็อก INSERT event_outbox จุดเดียว — แบบเดียวกับที่ 0031 ทำกับ 0020/0019
-- (ใช้ sed สกัดเนื้อจาก migration เดิมเป็นไบต์ แล้วแทรกบล็อกเดียว — ห้ามแตะเนื้ออื่น)
--   submit_attempt_core v4     ← 0031 v3 + event exam.result (NTF-002 · เกิดทั้งผ่าน/ไม่ผ่าน)
--   admin_issue_certificate v2 ← 0019 v1 + event certificate.issued (NTF-003 ·
--                               payload verify_code + certificate_id ครบคู่)
--   admin_revoke_certificate v4 ← 0031 v2 + event certificate.revoked (NTF-003 ·
--                               reason_snippet 120 · gate r2 B5b: verify_code +
--                               certificate_id ครบคู่เหมือน issued)
--   admin_credit_adjust v2     ← 0031 v1 + event credit.adjusted
-- signature เดิมทุกตัว → create or replace คง ACL/owner เดิม (ระบุซ้ำเพื่อความชัดเจนเท่านั้น)

-- ── submit_attempt_core v4 — เนื้อคัดลอกจาก 0031 v3 + จุดเดียว (event exam.result) ──


create or replace function public.submit_attempt_core(
  p_attempt public.assessment_attempts,
  p_late boolean,
  p_auto boolean
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_earned int := 0;
  v_total int := 0;
  v_correct int := 0;
  v_qcount int := 0;
  v_score smallint;
  v_passed boolean;
  v_rules public.assessment_rules%rowtype;
  v_rule public.credit_rules%rowtype;
  v_answered int;
  v_details jsonb;
begin
  select * into v_rules from public.assessment_rules where id = p_attempt.rules_id;
  -- (เหมือนเดิม: grading จาก question_snapshot ล้วน — F14 · exact-match ชุด is_correct ต่อข้อ)
  with g as (
    select aa.id,
           (aa.question_snapshot->>'points')::smallint as pts,
           coalesce((select jsonb_agg(o->>'id')
                     from jsonb_array_elements(aa.question_snapshot->'options') o
                     where (o->>'is_correct')::boolean), '[]'::jsonb) as correct_ids,
           coalesce(to_jsonb(aa.selected_option_ids), '[]'::jsonb) as sel_ids
    from public.attempt_answers aa
    where aa.attempt_id = p_attempt.id
  ),
  s as (
    select g.*,
           (jsonb_array_length(g.sel_ids) > 0
            and g.sel_ids <@ g.correct_ids
            and g.correct_ids <@ g.sel_ids) as ok
    from g
  )
  update public.attempt_answers aa
  set is_correct = s.ok,
      points_earned = case when s.ok then s.pts else 0 end
  from s
  where aa.id = s.id;

  -- 0019: นับแยก 4 ค่า — คะแนนรวม / คะแนนเต็ม / ถูก / ตอบแล้ว (+ question_count = count(*))
  select coalesce(sum(points_earned), 0),
         coalesce(sum((question_snapshot->>'points')::smallint), 0),
         count(*) filter (where is_correct),
         count(*) filter (where selected_option_ids is not null),
         count(*)
  into v_earned, v_total, v_correct, v_answered, v_qcount
  from public.attempt_answers
  where attempt_id = p_attempt.id;

  v_score := least(round(v_earned * 100.0 / greatest(v_total, 1))::int, 100)::smallint;
  v_passed := v_score >= v_rules.pass_pct;

  update public.assessment_attempts
  set status = case when v_passed then 'passed' else 'failed' end::public.attempt_status,
      submitted_at = now(), score_pct = v_score, passed = v_passed, correct_count = v_correct
  where id = p_attempt.id;

  -- ผ่าน → credit accrual event ใน TX เดียวกับ grading (F15/D13-F6 — snapshot กฎ ห้าม worker lookup ซ้ำ)
  if v_passed then
    select * into v_rule from public.credit_rules
    where status = 'active'
      and effective_from <= now()
      and (effective_to is null or effective_to > now())
      and (course_id = (select a.course_id from public.assessments a
                        where a.id = p_attempt.assessment_id)
           or course_id is null)
    order by (course_id is null), priority, effective_from desc
    limit 1;
    if found then
      insert into public.event_outbox (topic, payload)
      values ('credit.accrual',
        jsonb_build_object(
          'source_type', 'assessment_attempt',
          'source_id', p_attempt.id,
          'user_id', p_attempt.user_id,
          'enrollment_id', p_attempt.enrollment_id,
          'passed_at', now(),
          'rule', jsonb_build_object(
            'rule_id', v_rule.id, 'code', v_rule.code,
            'credits', v_rule.credits, 'credit_type', v_rule.credit_type,
            'renewal_cycle', v_rule.renewal_cycle, 'valid_days', v_rule.valid_days,
            'carry_over', v_rule.carry_over,
            'required_credits_per_cycle', v_rule.required_credits_per_cycle)));
    end if;
  end if;

  -- 0034: เพิ่ม event exam.result (D-p4-1 · NTF-002) — เกิดทั้งผ่านและไม่ผ่าน in-TX เดียวกับ
  -- grading · consumer dedupe ด้วย (topic, source_id, user_id) ตาม D-p4-3 ·
  -- attempt_no = ครั้งที่สอบของผู้ใช้ในรอบนี้ (นับรวมแถวปัจจุบันที่กำลังตรวจ —
  -- gate r1 B5: อีเมลผลสอบต้องมี "ครั้งที่" ตาม AC ของ NTF-002)
  insert into public.event_outbox (topic, payload)
  values ('exam.result', jsonb_build_object(
    'source_type', 'assessment_attempt',
    'source_id', p_attempt.id,
    'user_id', p_attempt.user_id,
    'assessment_id', p_attempt.assessment_id,
    'passed', v_passed,
    'score_pct', v_score,
    'pass_pct', v_rules.pass_pct,
    'attempt_no', (select count(*) from public.assessment_attempts a2
                    where a2.assessment_id = p_attempt.assessment_id
                      and a2.user_id = p_attempt.user_id),
    'course_title_th', (select c.title_th
                        from public.assessments a
                        join public.courses c on c.id = a.course_id
                        where a.id = p_attempt.assessment_id),
    'submitted_at', now()));

  v_details := jsonb_build_object('attempt_id', p_attempt.id, 'answered_count', v_answered,
                                  'late', p_late, 'idempotency_key', p_attempt.id::text);
  if p_auto then
    -- D53-4: ระบบปิดแทน → auto marker + late_seconds (แทน event EXAM_TIME_LIMIT_EXCEED
    -- แยกของ doc — รวมเป็นแถวเดียวลด audit noise ต่อการปิด 1 แถว)
    v_details := v_details || jsonb_build_object(
      'auto', true,
      'late_seconds', extract(epoch from (now() - p_attempt.expires_at))::int);
  end if;
  perform public.append_audit_event_internal('EXAM_SUBMIT', 'assessment_attempt',
    p_attempt.id::text, null, null, v_details, null, null, null);
  return jsonb_build_object('attempt_id', p_attempt.id,
                            'status', case when v_passed then 'passed' else 'failed' end,
                            'score_pct', v_score, 'passed', v_passed,
                            'correct_count', v_correct,
                            'question_count', v_qcount,
                            'total_points', v_total);
end;
$fn$;
alter function public.submit_attempt_core(public.assessment_attempts, boolean, boolean)
  owner to app_owner;
revoke execute on function public.submit_attempt_core(public.assessment_attempts, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.submit_attempt_core(public.assessment_attempts, boolean, boolean)
  to app_owner, service_role;


-- ── admin_issue_certificate v2 — เนื้อคัดลอกจาก 0019 v1 + จุดเดียว (event certificate.issued) ──

create or replace function public.admin_issue_certificate(
  p_actor_user_id uuid,
  p_enrollment_id uuid,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  -- 0034: ตัวแปรเดียวที่เพิ่ม — รับผล core เพื่อ emit event ก่อน return
  v_cert jsonb;
begin
  if p_actor_user_id is null then
    raise exception 'ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)';
  end if;
  select public.cert_issue_core(p_actor_user_id, p_enrollment_id, null, p_request_id) into v_cert;
  -- 0034: เพิ่ม event certificate.issued (D-p4-1 · NTF-003) — in-TX เดียวกับการออกใบ ·
  -- verify_code + certificate_id ครบคู่ (gate r1/r2 B5 — อีเมลต้องมีลิงก์ verify/PDF ตาม AC
  -- ของ NTF-003; worker เป็นผู้ประกอบ URL จาก config ของแอป)
  insert into public.event_outbox (topic, payload)
  select 'certificate.issued', jsonb_build_object(
    'user_id', (v_cert ->> 'user_id')::uuid,
    'cert_no', v_cert ->> 'cert_no',
    'certificate_id', (v_cert ->> 'id')::uuid,
    'verify_code', c.verify_code,
    'course_title_th', v_cert ->> 'course_title',
    'issued_at', (v_cert ->> 'issued_at')::timestamptz)
  from public.certificates c
  where c.id = (v_cert ->> 'id')::uuid;
  return v_cert;
end;
$fn$;
alter function public.admin_issue_certificate(uuid, uuid, text) owner to app_owner;
revoke execute on function public.admin_issue_certificate(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_issue_certificate(uuid, uuid, text)
  to service_role;


-- admin_revoke_certificate v4 — เนื้อคัดลอกจาก 0031 v2 + จุดเดียว (event certificate.revoked)
-- v4 (gate r2 B5b): SELECT เพิ่ม verify_code แล้วใส่ใน event payload คู่กับ
-- certificate_id ที่มีอยู่เดิม — อีเมลเพิกถอนต้องมีลิงก์ verify/PDF ครบตาม AC ของ
-- NTF-003 (SRS:353 ครอบทั้งออกใบและเพิกถอน) เหมือนอีเมลออกใบทุกประการ

create or replace function public.admin_revoke_certificate(
  p_actor_user_id uuid,
  p_certificate_id uuid,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_cert_no text;
  v_verify_code text;
  v_revoked_at timestamptz;
  v_enrollment uuid;
  v_user uuid;
  v_rev_rows int := 0;
  v_rev_total numeric := 0;
  v_rev_ids jsonb := '[]'::jsonb;
begin
  if p_actor_user_id is null then
    raise exception 'ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 ตัวอักษร (ERR-VAL-001|reason_length)'
      using errcode = '22023';
  end if;
  -- อ่าน cert_no + verify_code + enrollment + user คืนให้ BFF ใน TX เดียวกัน
  select cert_no, verify_code, enrollment_id, user_id
    into v_cert_no, v_verify_code, v_enrollment, v_user
  from public.certificates where id = p_certificate_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)';
  end if;
  -- gate r2 BLOCKER-2: serialize กับ credit_accrual_tick บน enrollment เดียวกัน —
  -- ไม่มี lock นี้: tick อ่าน cert valid → การเพิกถอนนี้ reverse ได้ 0 แถว (accrual
  -- ยังไม่ถูกเขียน) → tick INSERT accrual หลัง commit ของเรา = เครดิตรอดจากใบที่ถูกเพิกถอน
  perform pg_advisory_xact_lock(hashtext('ltc:credit:enr:' || v_enrollment::text)::bigint);
  update public.certificates
  set status = 'revoked', revoked_at = now(), revoked_reason = p_reason
  where id = p_certificate_id and status = 'valid'
  returning revoked_at into v_revoked_at;
  if not found then
    raise exception 'ข้อมูลไม่ถูกต้อง: ใบประกาศนียบัตรนี้ไม่ได้อยู่ในสถานะออกใบแล้ว (ERR-VAL-001|not_valid)'
      using errcode = '22023';
  end if;
  -- reason อยู่ในคอลัมน์ revoked_reason เท่านั้น (ฟรีเท็กซ์ — ห้ามลง audit context ตาม
  -- แบบแผน PII scan ของ AUDIT §3.2; context เก็บเฉพาะ id ที่ validate แล้ว)
  perform public.append_audit_event_internal(
    'CERT_REVOKE', 'certificate', p_certificate_id::text, null, null,
    jsonb_build_object('certificate_id', p_certificate_id),
    null, null, p_request_id, p_actor_user_id);

  -- 0034: เพิ่ม event certificate.revoked (D-p4-1 · NTF-003) — in-TX เดียวกับการเพิกถอน ·
  -- verify_code + certificate_id ครบคู่ (gate r2 B5b — ลิงก์ของอีเมลเพิกถอนตาม AC) ·
  -- reason_snippet = left(reason,120) — เหตุผลเต็มอยู่ที่ cert row/audit เท่านั้น (แบบแผน PII)
  insert into public.event_outbox (topic, payload)
  values ('certificate.revoked', jsonb_build_object(
    'user_id', v_user,
    'cert_no', v_cert_no,
    'verify_code', v_verify_code,
    'certificate_id', p_certificate_id,
    'reason_snippet', left(p_reason, 120)));

  -- reversal: ทุก accrual ที่ต้นทาง = attempt ของ enrollment นี้ และยังไม่ถูก reverse
  -- โดยใบนี้ (idempotent ต่อคู่ cert×original — partial UNIQUE 0006 คลุมเฉพาะ accrual)
  with src as (
    select le.id as orig_id, le.renewal_cycle_id, le.credit_type, le.amount, le.user_id
    from public.credit_ledger_entries le
    where le.entry_type = 'accrual'
      and le.source_type = 'assessment_attempt'
      and le.source_id in (select a.id from public.assessment_attempts a
                           where a.enrollment_id = v_enrollment)
      and not exists (
        select 1 from public.credit_ledger_entries rv
        where rv.entry_type = 'reversal'
          and rv.source_type = 'certificate_revocation'
          and rv.source_id = p_certificate_id
          and rv.original_entry_id = le.id)
  ),
  ins as (
    insert into public.credit_ledger_entries (
      user_id, renewal_cycle_id, entry_type, credit_type, amount,
      source_type, source_id, original_entry_id, reason, created_by)
    select src.user_id, src.renewal_cycle_id, 'reversal', src.credit_type, -src.amount,
           'certificate_revocation', p_certificate_id, src.orig_id,
           'เพิกถอนประกาศนียบัตร ' || v_cert_no, p_actor_user_id
    from src
    -- gate r1 MINOR-4: returning original_entry_id (id ของแถว accrual ต้นทาง) —
    -- คีย์ original_entry_ids ของ audit ต้องหมายถึงแถวต้นทาง ไม่ใช่ id แถว reversal
    returning original_entry_id, amount
  )
  select count(*), coalesce(sum(amount), 0), coalesce(jsonb_agg(original_entry_id), '[]'::jsonb)
  into v_rev_rows, v_rev_total, v_rev_ids
  from ins;

  if v_rev_rows > 0 then
    perform public.append_audit_event_internal(
      'CREDIT_REVERSAL', 'certificate', p_certificate_id::text, null, null,
      jsonb_build_object('certificate_id', p_certificate_id, 'cert_no', v_cert_no,
                         'reversed_rows', v_rev_rows, 'total_amount', v_rev_total,
                         'original_entry_ids', v_rev_ids),
      null, null, p_request_id, p_actor_user_id);
  end if;
  return jsonb_build_object('id', p_certificate_id, 'cert_no', v_cert_no,
                            'revoked_at', v_revoked_at,
                            'credit_reversed_rows', v_rev_rows,
                            'credit_reversed_total', v_rev_total);
end;
$fn$;
alter function public.admin_revoke_certificate(uuid, uuid, text, text) owner to app_owner;
revoke execute on function public.admin_revoke_certificate(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_revoke_certificate(uuid, uuid, text, text)
  to service_role;


-- ── admin_credit_adjust v2 — เนื้อคัดลอกจาก 0031 v1 + จุดเดียว (event credit.adjusted) ──

create or replace function public.admin_credit_adjust(
  p_user_id uuid,
  p_cycle_id uuid,
  p_credit_type text,
  p_amount numeric,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_ledger uuid;
  v_cycle_user uuid;
  v_now timestamptz;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  if not public.has_any_role(array['staff:registrar', 'super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|credit_adjust_forbidden)';
  end if;
  -- gate r1 BLOCKER-3: JWT aal1 (ยังไม่ผ่าน MFA) เรียก RPC ตรงที่ PostgREST ข้าม
  -- MFA gate ของ BFF ไม่ได้ — event CRITICAL ของ ledger บังคับ aal2 (API-SPEC §1.2
  -- · แบบแผนเดียวกับ admin_create/update_credit_rule_status ของ 0032)
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  if p_user_id is null or p_cycle_id is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุผู้ใช้และรอบ (ERR-VAL-001|adjust_args)'
      using errcode = '22023';
  end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 9999.99
     or p_amount <> round(p_amount, 2) then
    raise exception 'ข้อมูลไม่ถูกต้อง: จำนวนต้องไม่เป็น 0 และอยู่ในช่วง ±9999.99 ทศนิยม 2 ตำแหน่ง (ERR-VAL-001|adjust_amount)'
      using errcode = '22023';
  end if;
  if p_credit_type is null or p_credit_type !~ '^[a-z][a-z0-9_]{0,49}$' then
    raise exception 'ข้อมูลไม่ถูกต้อง: ประเภท credit ไม่ถูกต้อง (ERR-VAL-001|adjust_credit_type)'
      using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'การปรับ credit ต้องระบุเหตุผล (ERR-CRD-002|reason_required)'
      using errcode = '22023';
  end if;
  select user_id into v_cycle_user from public.renewal_cycles
  where id = p_cycle_id and user_id = p_user_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|cycle_not_found_for_user)'
      using errcode = 'P0002';
  end if;

  insert into public.credit_ledger_entries (
    user_id, renewal_cycle_id, entry_type, credit_type, amount,
    source_type, source_id, original_entry_id, reason, created_by)
  values (
    p_user_id, p_cycle_id, 'adjustment', p_credit_type, p_amount,
    'manual_adjustment', null, null, btrim(p_reason), v_actor)
  returning id, created_at into v_ledger, v_now;

  -- reason อยู่ในคอลัมน์ของ ledger เท่านั้น (แบบแผนเดียวกับ CERT_REVOKE — ฟรีเท็กซ์
  -- ห้ามลง audit context); context เก็บเฉพาะ id/ค่าตัวเลข
  perform public.append_audit_event_internal(
    'CREDIT_ADJUST', 'credit_ledger', v_ledger::text, null, null,
    jsonb_build_object('ledger_id', v_ledger, 'user_id', p_user_id,
                       'cycle_id', p_cycle_id, 'credit_type', p_credit_type,
                       'delta', p_amount),
    null, null, p_request_id, v_actor);

  -- 0034: เพิ่ม event credit.adjusted (D-p4-1) — in-TX เดียวกับ ledger + audit
  insert into public.event_outbox (topic, payload)
  values ('credit.adjusted', jsonb_build_object(
    'user_id', p_user_id,
    'cycle_id', p_cycle_id,
    'credit_type', p_credit_type,
    'amount', p_amount,
    'ledger_id', v_ledger));

  return jsonb_build_object('id', v_ledger, 'user_id', p_user_id,
                            'renewal_cycle_id', p_cycle_id,
                            'credit_type', p_credit_type, 'amount', p_amount,
                            'reason', btrim(p_reason), 'created_at', v_now);
end;
$fn$;
alter function public.admin_credit_adjust(uuid, uuid, text, numeric, text, text)
  owner to app_owner;
revoke execute on function public.admin_credit_adjust(uuid, uuid, text, numeric, text, text)
  from public, anon;
grant execute on function public.admin_credit_adjust(uuid, uuid, text, numeric, text, text)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) my_* RPCs — ผู้ใช้จัดการการแจ้งเตือนและ consent ของตนเอง (ทาง BFF)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 6.1 my_notifications — รายการ in_app ของตนเอง (unread ก่อน + keyset pagination) ──
-- D-p4-13: keyset = ทูเปิลเต็มของ ORDER BY ((unread-rank), created_at, id) —
-- keyset (created_at,id) เปล่า ๆ ตัดแถว read ที่ created_at เก่ากว่าแถว cursor
-- (อยู่หลังรอยต่อ unread→read) ทิ้งไปเรื่อย ๆ · cursor ต้องครบสามค่าจึงกรอง
-- (ขาดค่าใด = ไม่มี cursor → หน้าแรก) — BFF บรรจุ rank ใน sortKey แบบ "1|<ISO>"
-- ⚠ ลายเซ็นเพิ่ม p_after_unread (ตำแหน่งแรก) — drop ของเดิมก่อน ไม่งั้นเกิด overload
-- กำกวมชื่อ args เดียวกัน (named call แก้ไม่ตรงตัว)
drop function if exists public.my_notifications(timestamptz, uuid, int);
create or replace function public.my_notifications(
  p_after_unread boolean default null,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 20
) returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_unread int := 0;
  v_items jsonb;
  v_has_more boolean := false;
  v_cursor jsonb;
  v_next jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;

  -- unread นับจากทั้งก้อน (ไม่ตัดด้วย cursor — เพื่อ badge บน UI)
  select count(*) into v_unread
  from public.notification_recipients
  where user_id = v_uid and channel = 'in_app'
    and deleted_at is null and read_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'recipient_id', recipient_id, 'topic', topic,
           'title', title, 'body', body, 'severity', severity,
           'ref_type', ref_type, 'ref_id', ref_id,
           'created_at', created_at, 'read_at', read_at) order by rn)
         filter (where rn <= v_limit), '[]'::jsonb),
         coalesce(bool_or(rn = v_limit + 1), false),
         (max(jsonb_build_object('unread', (read_at is null),
                                 'created_at', created_at, 'id', id)::text)
           filter (where rn = v_limit))::jsonb
  into v_items, v_has_more, v_cursor
  from (
    select nr.id as recipient_id, n.id, n.topic, n.title, n.body, n.severity,
           n.ref_type, n.ref_id, n.created_at, nr.read_at,
           row_number() over (order by (nr.read_at is null) desc,
                                       n.created_at desc, n.id::text desc) as rn
    from public.notification_recipients nr
    join public.notifications n on n.id = nr.notification_id
    where nr.user_id = v_uid
      and nr.channel = 'in_app'
      and nr.deleted_at is null
      -- keyset ทูเปิลเต็ม (D-p4-13) — แถวอยู่ "หลัง" cursor ในลำดับ sort คือ:
      -- (ก) rank เดียวกัน + (created_at,id) น้อยกว่า หรือ (ข) rank ต่ำกว่า (cursor
      -- ยัง unread แต่แถวนี้ read แล้ว) — ส่ง cursor ครบสามค่าเท่านั้น ไม่งั้น = หน้าแรก
      and (p_after_unread is null or p_after_created_at is null or p_after_id is null
           or ((nr.read_at is null) = p_after_unread
               and (n.created_at < p_after_created_at
                    or (n.created_at = p_after_created_at and n.id::text < p_after_id::text)))
           or (p_after_unread and nr.read_at is not null))
  ) w;

  -- ไม่มีหน้าถัดไป → next_cursor = null (BFF หยุดโหลดเพิ่ม)
  v_next := case when v_has_more then v_cursor end;
  return jsonb_build_object('items', v_items, 'unread_count', v_unread,
                            'next_cursor', v_next);
end;
$fn$;

-- ── 6.2 my_notification_read — ทำเครื่องหมายอ่าน (idempotent: read_at คงเดิมถ้ามีแล้ว) ──
create or replace function public.my_notification_read(p_notification_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_read_at timestamptz;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  if p_notification_id is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุ id การแจ้งเตือน (ERR-VAL-001|notification_id_required)'
      using errcode = '22023';
  end if;
  update public.notification_recipients
  set read_at = coalesce(read_at, now())
  where user_id = v_uid
    and notification_id = p_notification_id
    and channel = 'in_app'
    and deleted_at is null
  returning read_at into v_read_at;
  if not found then
    -- D-p4-12: ใช้ errcode default P0001 (ไม่ใช่ P0002) — PostgREST (12.2 errors
    -- table) แปลง P0001 เป็น HTTP 400 พร้อม "message ของ raise ทะลุถึง caller"
    -- (ต่างจาก P0* อื่นที่กลายเป็น 500) · BFF อ่าน tag ERR-NF-001 ใน message ผ่าน
    -- parseRpcErrorCode แล้วตอบ 404 ตามทะเบียน error ของ repo — ส่วน P0002 ถูก
    -- ชั้น gateway แทน message เป็น "Something went wrong" (สังเกตจริงบน stack
    -- นี้ระหว่าง D-p4-12 — เหตุผลที่เลิกใช้)
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|notification_not_found)';
  end if;
  return jsonb_build_object('id', p_notification_id, 'read_at', v_read_at);
end;
$fn$;

-- ── 6.3 my_notification_settings — ค่าที่ใช้จริง = ค่าเริ่มต้น merge กับค่าที่บันทึกไว้ ──
create or replace function public.my_notification_settings() returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_families text[] := array['exam.result','certificate','credit','renewal'];
  v_stored jsonb := '{}'::jsonb;
  v_fam text;
  v_out jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  select settings into v_stored
  from public.notification_settings where user_id = v_uid;
  if not found then
    v_stored := '{}'::jsonb;
  end if;
  foreach v_fam in array v_families loop
    v_out := jsonb_set(v_out, array[v_fam],
      jsonb_build_object(
        'in_app', coalesce((v_stored -> v_fam ->> 'in_app')::boolean, true),
        'email', coalesce((v_stored -> v_fam ->> 'email')::boolean, true)));
  end loop;
  return jsonb_build_object('settings', v_out);
end;
$fn$;

-- ── 6.4 my_notification_settings_update — validate strict แล้ว upsert merge ต่อ family ──
create or replace function public.my_notification_settings_update(p_settings jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_allowed text[] := array['exam.result','certificate','credit','renewal'];
  v_key text;
  v_val jsonb;
  v_clean jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'ข้อมูลไม่ถูกต้อง: settings ต้องเป็น object (ERR-VAL-001|settings_must_be_object)'
      using errcode = '22023';
  end if;
  for v_key, v_val in select key, value from jsonb_each(p_settings) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'ข้อมูลไม่ถูกต้อง: family ไม่รู้จัก (ERR-VAL-001|unknown_family)'
        using errcode = '22023';
    end if;
    if v_val is null or jsonb_typeof(v_val) <> 'object'
       or not (v_val ?& array['in_app','email'])
       or jsonb_typeof(v_val -> 'in_app') <> 'boolean'
       or jsonb_typeof(v_val -> 'email') <> 'boolean' then
      raise exception 'ข้อมูลไม่ถูกต้อง: แต่ละ family ต้องมี in_app และ email แบบ boolean เท่านั้น (ERR-VAL-001|family_shape)'
        using errcode = '22023';
    end if;
    v_clean := jsonb_set(v_clean, array[v_key], v_val);
  end loop;
  if v_clean = '{}'::jsonb then
    raise exception 'ข้อมูลไม่ถูกต้อง: settings ว่างเปล่า (ERR-VAL-001|settings_empty)'
      using errcode = '22023';
  end if;
  insert into public.notification_settings (user_id, settings)
  values (v_uid, v_clean)
  on conflict (user_id) do update
    set settings = public.notification_settings.settings || excluded.settings;
  return public.my_notification_settings();
end;
$fn$;

-- ── 6.5 my_consents_get — แถวล่าสุดต่อประเภท (append-only: ล่าสุดชนะ) ──
-- รูปขาออกตาม BFF zod strict (consents/schema.ts): {consents:[{type,status,updated_at}]}
-- — type ที่ไม่เคยมีประวัติ = ไม่อยู่ในรายการ (สถานะ de-facto = ไม่อนุญาต ตาม D-p4-4
-- fail-closed · status เก็บเฉพาะ granted|revoked มาจาก action ล่าสุด)
create or replace function public.my_consents_get() returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  return jsonb_build_object('consents', coalesce((
    select jsonb_agg(jsonb_build_object(
             'type', latest.consent_type,
             'status', case latest.action when 'grant' then 'granted' else 'revoked' end,
             'updated_at', latest.created_at)
           order by latest.consent_type)
    from (
      select distinct on (c.consent_type) c.consent_type, c.action, c.created_at
      from public.consents c
      where c.user_id = v_uid
        and c.consent_type in ('marketing','email_notify')
      order by c.consent_type, c.created_at desc, c.id desc
    ) latest), '[]'::jsonb));
end;
$fn$;

-- ── 6.6 my_consents_update — append-only + audit (D-p4-4: ไม่มีแถว = ไม่อนุญาต) ──
-- ขาออก strict ตาม ConsentStatusView ของ BFF: {type,status} เท่านั้น (policy_version/
-- created_at อยู่ที่ consents row + audit context — ไม่ส่งกลับ ไม่งั้น zod strict ตี 503)
create or replace function public.my_consents_update(p_type text, p_action text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  if p_type not in ('marketing','email_notify') then
    raise exception 'ข้อมูลไม่ถูกต้อง: ประเภท consent ไม่ถูกต้อง (ERR-VAL-001|consent_type)'
      using errcode = '22023';
  end if;
  if p_action not in ('grant','revoke') then
    raise exception 'ข้อมูลไม่ถูกต้อง: action ต้องเป็น grant หรือ revoke (ERR-VAL-001|consent_action)'
      using errcode = '22023';
  end if;
  insert into public.consents (user_id, consent_type, action, policy_version, source)
  values (v_uid, p_type, p_action, '2025-09', 'profile')
  returning id into v_id;
  perform public.append_audit_event_internal(
    'CONSENT_UPDATE', 'consent', v_id::text, null, null,
    jsonb_build_object('consent_type', p_type, 'action', p_action,
                       'policy_version', '2025-09'),
    null, null, null, v_uid);
  return jsonb_build_object('type', p_type,
                            'status', case p_action when 'grant' then 'granted' else 'revoked' end);
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) email worker RPCs — ให้ worker (service_role) ดึง/ปิดงานส่งอีเมล
--    D-p4-7: claim ด้วย FOR UPDATE SKIP LOCKED + reclaim งานค้าง sending เกิน 10 นาที
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 7.1 email_claim_batch — ดึงงานพร้อมส่ง + ตรวจสิทธิ์ล่าสุดก่อนส่ง (gate r1 B2/M1) ──
-- อธิบายความหมายของ scheduled_at (M1 — เลือกความหมายเดียวให้ตรงกันทั้งคิว):
--   status='queued'  → เวลาที่แถว "พร้อมถูกเลือก" (backoff เลื่อนออกไป)
--   status='sending' → กำหนดสิ้นสุด lease ของ worker (ตั้ง = claim_time + 10 นาที)
-- reclaim งานที่ worker ตายกลางทาง = status='sending' และ lease หมดแล้ว
-- (scheduled_at <= now()) — รวมเป็น 10 นาทีจริงจากจุด claim ไม่ใช่ 10+10
-- B2: ก่อนส่งจริงต้องเช็กสิทธิ์ "ล่าสุด" อีกครั้ง ณ จุด claim — grant→enqueue→
-- revoke ระหว่างนั้น ต้องไม่ส่ง: แถวที่ notification_email_allowed ตอบ false
-- (consents ถูกถอน หรือ settings[family].email ถูกปิดหลัง enqueue — รวมงาน retry)
-- ถูกปิดเป็น failed + last_error คงที่ (ไม่ใช่ send แล้วค่อยพบ) · family ของแถว
-- อนุมานจาก template_key (ไม่รู้จัก → consent ยังตรวจ — fail-closed ฝั่ง consent)
create or replace function public.email_claim_batch(p_limit int default 20)
returns table (
  id uuid,
  recipient_user_id uuid,
  to_email text,
  template_key text,
  payload jsonb,
  locale text,
  attempts int
)
language plpgsql volatile security definer
set search_path = public
as $fn$
begin
  return query
  with eligible as (
    select e.id
    from public.email_outbox e
    where (e.status = 'queued' and e.scheduled_at <= now())
       or (e.status = 'sending' and e.scheduled_at <= now())
    order by e.scheduled_at, e.created_at
    limit greatest(least(coalesce(p_limit, 20), 100), 1)
    for update skip locked
  ),
  denied as (
    update public.email_outbox e
    set status = 'failed',
        last_error = 'email_gate_denied_before_send'
    where e.id in (select el.id from eligible el)
      and not public.notification_email_allowed(e.recipient_user_id,
        case
          when e.template_key like 'exam.result.%' then 'exam.result'
          when e.template_key like 'certificate.%' then 'certificate'
          when e.template_key = 'credit.adjusted' then 'credit'
          when e.template_key like 'renewal.reminder.%' then 'renewal'
          else 'unknown'
        end)
    returning e.id
  ),
  claimed as (
    update public.email_outbox e
    set status = 'sending',
        scheduled_at = now() + interval '10 minutes'
    where e.id in (select el.id from eligible el)
      and e.id not in (select d.id from denied d)
    returning e.id, e.recipient_user_id, e.to_email, e.template_key,
              e.payload, e.locale, e.attempts
  )
  select u.id, u.recipient_user_id, u.to_email, u.template_key,
         u.payload, u.locale, u.attempts
  from claimed u;
end;
$fn$;

-- ── 7.2 p_results = [{id, ok, error}] — ต่อแถวแยก subtransaction (งานพิษตัวไหนพัง ตัวนั้นนับ invalid) ──
create or replace function public.email_complete(p_results jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_item jsonb;
  v_id uuid;
  v_ok boolean;
  v_err text;
  v_sent int := 0;
  v_retried int := 0;
  v_invalid int := 0;
begin
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'ข้อมูลไม่ถูกต้อง: results ต้องเป็น array (ERR-VAL-001|results_must_be_array)'
      using errcode = '22023';
  end if;
  for v_item in select * from jsonb_array_elements(p_results) loop
    begin
      v_id := nullif(v_item ->> 'id', '')::uuid;
      if v_id is null then
        v_invalid := v_invalid + 1;
        continue;
      end if;
      v_ok := coalesce((v_item ->> 'ok')::boolean, false);
      v_err := nullif(btrim(coalesce(v_item ->> 'error', '')), '');
      if v_ok then
        update public.email_outbox
        set status = 'sent', sent_at = now(), last_error = null
        where id = v_id and status = 'sending';
        if found then
          v_sent := v_sent + 1;
          update public.notification_recipients nr
          set sent_at = coalesce(nr.sent_at, now())
          from public.email_outbox e
          where e.id = v_id
            and nr.channel = 'email'
            and nr.notification_id = (e.payload ->> 'notification_id')::uuid
            and nr.user_id = e.recipient_user_id;
        end if;
      else
        update public.email_outbox
        set attempts = attempts + 1,
            last_error = left(v_err, 500),
            status = case when attempts + 1 >= 5 then 'failed' else 'queued' end::public.email_status,
            scheduled_at = now() + make_interval(secs => least(60 * power(2, attempts + 1), 3600))
        where id = v_id and status = 'sending';
        if found then
          v_retried := v_retried + 1;
        end if;
      end if;
    exception when others then
      v_invalid := v_invalid + 1;
    end;
  end loop;
  return jsonb_build_object('sent', v_sent, 'retried', v_retried, 'invalid', v_invalid);
end;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) grants + RLS — เติมเฉพาะส่วนที่ขาด (0010 §6 ให้ blanket SELECT+INSERT policy
--    ให้ app_owner ครบทุกตารางแล้ว; ที่นี่เติม UPDATE ที่ functions ของ 0034 ใช้จริง)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 8.1 UPDATE บนตาราง notification (definer ของ 0034 เป็น app_owner ซึ่งไม่มี BYPASSRLS) ──
drop policy if exists app_owner_update_notification_recipients on public.notification_recipients;
create policy app_owner_update_notification_recipients
  on public.notification_recipients for update to app_owner
  using (true) with check (true);
grant update on public.notification_recipients to app_owner;

drop policy if exists app_owner_update_notification_settings on public.notification_settings;
create policy app_owner_update_notification_settings
  on public.notification_settings for update to app_owner
  using (true) with check (true);
grant update on public.notification_settings to app_owner;

drop policy if exists app_owner_update_email_outbox on public.email_outbox;
create policy app_owner_update_email_outbox
  on public.email_outbox for update to app_owner
  using (true) with check (true);
grant update on public.email_outbox to app_owner;

-- ── 8.2 INSERT grants บนตาราง notification (0010 §6 สร้าง policy ไว้แต่ไม่เคย grant) ──
grant insert on public.notifications to app_owner;
grant insert on public.notification_recipients to app_owner;
grant insert on public.notification_settings to app_owner;
grant insert on public.email_outbox to app_owner;
-- consents — INSERT grant (policy app_owner_insert_consents มีแล้วจาก 0010 §6)
grant insert on public.consents to app_owner;

-- ── 8.3 owner ของ functions ทั้งหมด = app_owner (definer plumbing — แบบแผน 0031) ──
alter function public.my_notifications(boolean, timestamptz, uuid, int) owner to app_owner;
alter function public.my_notification_read(uuid) owner to app_owner;
alter function public.my_notification_settings() owner to app_owner;
alter function public.my_notification_settings_update(jsonb) owner to app_owner;
alter function public.my_consents_get() owner to app_owner;
alter function public.my_consents_update(text, text) owner to app_owner;
alter function public.email_claim_batch(int) owner to app_owner;
alter function public.email_complete(jsonb) owner to app_owner;

-- ── 8.4 execute grants ให้ client roles ตามชั้นผู้ใช้ ──
-- my_* → authenticated เท่านั้น
revoke execute on function public.my_notifications(boolean, timestamptz, uuid, int)
  from public, anon, authenticated;
grant execute on function public.my_notifications(boolean, timestamptz, uuid, int) to authenticated;

revoke execute on function public.my_notification_read(uuid)
  from public, anon, authenticated;
grant execute on function public.my_notification_read(uuid) to authenticated;

revoke execute on function public.my_notification_settings()
  from public, anon, authenticated;
grant execute on function public.my_notification_settings() to authenticated;

revoke execute on function public.my_notification_settings_update(jsonb)
  from public, anon, authenticated;
grant execute on function public.my_notification_settings_update(jsonb) to authenticated;

revoke execute on function public.my_consents_get()
  from public, anon, authenticated;
grant execute on function public.my_consents_get() to authenticated;

revoke execute on function public.my_consents_update(text, text)
  from public, anon, authenticated;
grant execute on function public.my_consents_update(text, text) to authenticated;

-- email worker RPCs → service_role เท่านั้น
revoke execute on function public.email_claim_batch(int)
  from public, anon, authenticated;
grant execute on function public.email_claim_batch(int) to service_role;

revoke execute on function public.email_complete(jsonb)
  from public, anon, authenticated;
grant execute on function public.email_complete(jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) pg_cron — 3 งาน (upsert ตาม jobname — แบบแผน 0026/0031)
--    ltc-notification-dispatch  * * * * *  → notification_dispatch_tick()
--    ltc-renewal-reminder       17 3 * * * → renewal_reminder_scan()
--    ltc-email-outbox-purge     19 4 * * * → purge email_outbox (sent/failed เกิน 90 วัน)
-- ─────────────────────────────────────────────────────────────────────────────
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'ltc-notification-dispatch') then
    perform cron.unschedule('ltc-notification-dispatch');
  end if;

  if exists (select 1 from cron.job where jobname = 'ltc-renewal-reminder') then
    perform cron.unschedule('ltc-renewal-reminder');
  end if;

  if exists (select 1 from cron.job where jobname = 'ltc-email-outbox-purge') then
    perform cron.unschedule('ltc-email-outbox-purge');
  end if;

  perform cron.schedule('ltc-notification-dispatch', '* * * * *',
    'select public.notification_dispatch_tick()');
  perform cron.schedule('ltc-renewal-reminder', '17 3 * * *',
    'select public.renewal_reminder_scan()');
  perform cron.schedule('ltc-email-outbox-purge', '19 4 * * *',
    $cmd$ delete from public.email_outbox
          where status in ('sent','failed')
            and coalesce(sent_at, created_at) < now() - interval '90 days' $cmd$);
end
$do$;
