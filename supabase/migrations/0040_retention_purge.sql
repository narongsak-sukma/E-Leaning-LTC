-- ═══ 0040 — retention purge v1 (Wave F · D-f-4 · [#91]) ═════════════════════
-- ทำจริงตาม DD §4.6 "สรุป retention (canonical เดียว)" เฉพาะรายการที่ v1 ต้อง purge:
--   security_events 1 ปี · certificate_verifications 90 วัน ·
--   notification_recipients / notifications / report_exports 12 เดือน ·
--   event_outbox (processed) 30 วัน · admin_sessions (จบแล้ว) 24 เดือน
-- นอกขอบเขต v1 = v1.1 ตาม DD เอง: audit_logs 5 ปี (ต้อง export สำเร็จก่อน purge) ·
--   learning records ตามอายุบัญชี (anonymize ใต้ FK ของ certificates/credit ledger)
-- สิทธิ์ (DD §4.3/§4.6 — F19/D12): งาน purge รันใต้บทบาทเฉพาะ `purge_role`
--   ไม่ใช่ service_role ของแอป — ฟังก์ชัน SECURITY DEFINER owner = purge_role
--   (current_role = purge_role ตอนรัน — ผ่านด่าน prevent_audit_mutation ของ 0010
--   เมื่ออนาคต v1.1 ต่อ audit purge) · EXECUTE เฉพาะ purge_role + supabase_admin
--   (pg_cron ยิงในนามผู้ตารางเวลา) · ปฏิเสธ public/anon/authenticated/service_role
-- ทุกการรันจริงเขียน audit `PURGE_EXECUTED` (ผ่าน append_audit_event_internal —
--   hash-chain ครบ) context = จำนวนต่อตารางเท่านั้น ไม่มี PII ใด ๆ

-- ── สิทธิ์ DELETE/SELECT ให้ purge_role + policy RLS แคบเฉพาะบทบาท ──────────────
-- (ตารางเจ้าของ = supabase_admin ซึ่ง owner อยู่ — policy+grant คือทางเดียวของ
--  บทบาล purge_role; ชื่อ policy ใช้ prefix ltc_purge_ เพื่อไม่ชน policy แอป)
grant select, delete on public.security_events          to purge_role;
grant select, delete on public.certificate_verifications to purge_role;
grant select, delete on public.notification_recipients  to purge_role;
grant select, delete on public.notifications            to purge_role;
grant select, delete on public.report_exports           to purge_role;
grant select, delete on public.event_outbox             to purge_role;
grant select, delete on public.admin_sessions           to purge_role;

do $do$
declare
  t text;
begin
  foreach t in array array[
    'security_events','certificate_verifications','notification_recipients',
    'notifications','report_exports','event_outbox','admin_sessions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = t
                      and policyname = 'ltc_purge_read') then
      execute format('create policy ltc_purge_read on public.%I for select to purge_role using (true)', t);
    end if;
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = t
                      and policyname = 'ltc_purge_delete') then
      execute format('create policy ltc_purge_delete on public.%I for delete to purge_role using (true)', t);
    end if;
  end loop;
end
$do$;

-- ── ตัว purge (dry-run เป็น default — cron ส่ง false เอง) ─────────────────────
create or replace function public.purge_expired_retention(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_dry   boolean := coalesce(p_dry_run, true);
  v_count bigint;
  v_out   jsonb   := '{}'::jsonb;
  r       record;
begin
  -- predicate เป็น literal นิ่งที่ migration คุมเอง (ไม่รับจากผู้เรียก) — ไม่มีพื้นที่ injection
  for r in
    select * from (values
      ('security_events',          'created_at < now() - interval ''1 year'''),
      ('certificate_verifications','created_at < now() - interval ''90 days'''),
      ('notification_recipients',  'created_at < now() - interval ''12 months'''),
      ('notifications',            'created_at < now() - interval ''12 months'' and not exists (select 1 from public.notification_recipients nr where nr.notification_id = public.notifications.id)'),
      ('report_exports',           'created_at < now() - interval ''12 months'''),
      ('event_outbox',             'status = ''processed'' and created_at < now() - interval ''30 days'''),
      ('admin_sessions',           'ended_at is not null and ended_at < now() - interval ''24 months''')
    ) as t(tbl, pred)
  loop
    if v_dry then
      execute format('select count(*) from public.%I where %s', r.tbl, r.pred) into v_count;
    else
      execute format('with d as (delete from public.%I where %s returning 1) select count(*) from d',
                     r.tbl, r.pred) into v_count;
    end if;
    v_out := v_out || jsonb_build_object(r.tbl, v_count::int);
  end loop;

  if not v_dry then
    -- context คีย์ snake_case ตามด่าน audit_context_pii_ok (0008 — ห้าม camelCase) ·
    -- request_id = uuid ตามแบบแผนทั้งระบบ (digit-run ใน timestamp ชนด่าน license_no)
    perform public.append_audit_event_internal(
      'PURGE_EXECUTED', 'system', null, null, null,
      jsonb_build_object('job', 'ltc-purge-retention', 'dry_run', false, 'purged', v_out),
      null, null, gen_random_uuid()::text);
  end if;

  return jsonb_build_object('dryRun', v_dry, 'counts', v_out);
end;
$fn$;

alter function public.purge_expired_retention(boolean) owner to purge_role;
revoke execute on function public.purge_expired_retention(boolean) from public, anon, authenticated, service_role;
grant  execute on function public.purge_expired_retention(boolean) to purge_role, supabase_admin;

-- append_audit_event_internal (เจ้าของ app_owner) เปิดทางให้ purge_role เรียกได้
grant execute on function public.append_audit_event_internal(text, text, text, jsonb, jsonb, jsonb, text, text, text, uuid)
  to purge_role;

-- ── cron รายวัน 04:23 (idempotent — แบบแผน 0034/0031) ─────────────────────────
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'ltc-purge-retention') then
    perform cron.unschedule('ltc-purge-retention');
  end if;
  perform cron.schedule('ltc-purge-retention', '23 4 * * *',
    'select public.purge_expired_retention(false)');
end
$do$;
