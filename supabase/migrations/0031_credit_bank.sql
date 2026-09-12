-- ═══ 0031_credit_bank — Wave E Phase 3 (CRB) · DCR-9 · D68 (C-1..C-10) ═══
-- lead-owned ตาม D36 · DOC-FIRST: API-SPEC 1.1.0 + DD 1.2.0 + AUDIT-LOG-DESIGN 1.0.1 มาก่อนไฟล์นี้
--
-- สิ่งที่ไฟล์นี้ทำ (ตามแผน .omc/plans/wave-e-p3-plan.md §4 lane DCR-9+0031):
--   (1) credit_cycle_defaults() — จุด canonical เดียวของ default Q1 (D8): รอบ 1 ปี ·
--       เกณฑ์ {general: 12} · ไม่ยกยอดข้ามรอบ — รอยืนยัน Q1 แล้วแก้ที่จุดเดียว
--   (2) ensure_renewal_cycle() — สร้างรอบ lazy: anchor = license_applications อนุมัติล่าสุด
--       → fallback role_assignments lawyer เก่าสุด · มีรอบเดิม = ต่อจากรอบล่าสุด ·
--       สร้างเฉพาะรอบที่ cover วันที่สนใจ (ไม่ backfill) · ผู้ไม่มีสิทธิ์ = return null
--   (3) credit_accrual_tick() — consumer ของ event_outbox topic 'credit.accrual' (D11-17):
--       advisory-xact-lock กัน tick ซ้อน · ≤5 รอบ ×200 event · ต่อ event = begin/exception
--       (event หนึ่งล้มไม่ทำแถวอื่นตาย) · ใช้ snapshot เท่านั้นไม่ lookup กฎซ้ำ (F17) ·
--       INSERT ledger idempotent (partial UNIQUE 0006) · citizen = processed + no_cycle_target
--       (C-4) · ล้ม = attempts+1 + backoff ที่ available_at · attempts ≥5 → failed ·
--       audit CREDIT_ACCRUAL ณ INSERT ledger สำเร็จ (actor ระบบ) — AC ≤5 นาที (CRB-003)
--   (4) submit_attempt_core v3 — snapshot กฎเพิ่ม required_credits_per_cycle (D68):
--       event เก่าที่ค้างคิวไม่มีฟิลด์ → tick ใช้ credit_cycle_defaults() แทน
--   (5) admin_revoke_certificate v2 — reversal-on-revoke ใน TX เดียวกับการเพิกถอน (CRT-006/
--       C-5): INSERT entry_type='reversal' ต่อรายการ accrual ของ attempt ต้นทางที่ยังไม่ถูก
--       reverse · idempotent ต่อ (cert, original_entry) · audit CREDIT_REVERSAL 1 event/ครั้ง ·
--       re-issue ไม่กระทบ credit (คงเดิม — 0019)
--   (6) admin_credit_adjust() — CRB-007: reason 10-500 บังคับ + entry_type='adjustment' +
--       created_by=auth.uid() + audit CREDIT_ADJUST · ไม่ใช้ service_role ใน BFF (C-9)
--   (7) my_credit_summary() — CRB-005: ยอดรอบปัจจุบัน (ได้รับ/ต้องมี/ขาด) + ประวัติทุกรอบ
--       คำนวณจาก ledger จริง (SUM(amount) รวม reversal/adjustment)
--   (8) my_credit_transcript() — CRB-006: แถว transcript ต่อ enrollment (ผลสอบ/credit สุทธิ/
--       ใบประกาศฯ) คืน json ให้ BFF เรนเดอร์ JSON/CSV(UTF-8 BOM)/PDF
--   (9) grants/policies ที่ขาดของ app_owner (definer ไม่มี BYPASSRLS — แบบแผน 0010 §6):
--       event_outbox UPDATE · renewal_cycles INSERT
--  (10) pg_cron jobname 'ltc-credit-accrual' ทุก 1 นาที (upsert ตามแบบ 0026)

-- ═══ (1) credit_cycle_defaults — canonical default Q1 (D8 — จุดเดียว ห้าม duplicate) ═══
create or replace function public.credit_cycle_defaults() returns jsonb
language sql stable
set search_path = public
as $$
  -- SRS Appendix A / Q1: รอบต่ออายุ 1 ปี · ต้องมี 12 หน่วย/รอบ (general) · ไม่สะสมข้ามรอบ
  select jsonb_build_object(
    'cycle_years', 1,
    'required_credits', jsonb_build_object('general', 12),
    'carry_over', false);
$$;
alter function public.credit_cycle_defaults() owner to app_owner;
revoke execute on function public.credit_cycle_defaults() from public, anon, authenticated;
grant execute on function public.credit_cycle_defaults() to app_owner, service_role;

-- ═══ (2) ensure_renewal_cycle — lazy · หาครอบ/ต่อเชื่อม/สร้างใหม่ตาม anchor (C-3) ═══
create or replace function public.ensure_renewal_cycle(
  p_user_id uuid,
  p_on_date date,
  -- ผู้เรียกส่งเกณฑ์จาก rule snapshot ของ event ได้ ({"<credit_type>": numeric}) —
  -- null = ใช้ default Q1 จาก credit_cycle_defaults() (รวม event เก่าที่ไม่มีฟิลด์)
  p_required_credits jsonb default null
) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_id uuid;
  v_no int;
  v_start date;
  v_end date;
  v_anchor timestamptz;
  v_years int;
  v_last_no int;
  v_last_end date;
begin
  if p_user_id is null or p_on_date is null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องระบุผู้ใช้และวันที่ (ERR-VAL-001|ensure_cycle_args)'
      using errcode = '22023';
  end if;
  -- (a) มีรอบที่ cover อยู่แล้ว (รวมรอบที่ปิดแล้ว: accrual ตามวันผ่านยังเข้ารอบนั้น —
  --     "ห้ามแปลงรอบที่ปิด" คือห้าม UPDATE แถวรอบ ไม่ใช่ห้ามผนวก ledger)
  select id into v_id from public.renewal_cycles
  where user_id = p_user_id
    and p_on_date >= starts_on and p_on_date <= ends_on
  limit 1;
  if found then return v_id; end if;

  -- (b) เป้าหมายของรอบ = ผู้ถือ role lawyer หรือผู้มีรอบอยู่แล้ว — นอกนั้น (citizen)
  --     = ไม่สร้างรอบ → caller จัดการ no_cycle_target (C-4)
  if not exists (select 1 from public.role_assignments
                 where user_id = p_user_id and role = 'lawyer' and revoked_at is null)
     and not exists (select 1 from public.renewal_cycles where user_id = p_user_id) then
    return null;
  end if;

  -- (c) หน้าต่างรอบ: มีรอบเดิม = ต่อจากรอบล่าสุด (เลขรอบต่อเนื่อง แม้ช่องว่างเวลาหลายปี
  --     ก็กระโดดไปรอบที่ cover วันที่สนใจ ไม่ materialize รอบระหว่างทาง) ·
  --     รอบแรก = anchor จากใบอนุญาตอนุมัติล่าสุด → ไม่มีจึงใช้ role lawyer เก่าสุด (C-3)
  select cycle_no, ends_on into v_last_no, v_last_end
  from public.renewal_cycles where user_id = p_user_id
  order by cycle_no desc limit 1;
  if found then
    v_no := v_last_no + 1;
    v_start := v_last_end + 1;
    v_years := greatest(0, floor((p_on_date - v_start)::numeric / 365.25)::int);
    v_start := (v_start::timestamp + make_interval(years => v_years))::date;
  else
    select max(decided_at) into v_anchor from public.license_applications
    where user_id = p_user_id and status = 'approved' and decided_at is not null;
    if v_anchor is null then
      select min(granted_at) into v_anchor from public.role_assignments
      where user_id = p_user_id and role = 'lawyer' and revoked_at is null;
    end if;
    -- ถึงตรงนี้แล้ว anchor ต้องไม่ null (ผ่าน (b) ด้วย role lawyer) — กันไว้ fail-closed
    if v_anchor is null then
      raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cycle_anchor_missing)'
        using errcode = 'P0001';
    end if;
    v_no := 1;
    v_years := greatest(0, floor((p_on_date - v_anchor::date)::numeric / 365.25)::int);
    v_start := (v_anchor::date::timestamp + make_interval(years => v_years))::date;
  end if;
  -- กัน calendar drift ของปีอธิกสุรทิน (floor บน 365.25 + make_interval ปีจริง):
  -- หาก start เลยวันที่สนใจไป 1 วัน ให้ถอยหนึ่งปี — รอบต้อง cover p_on_date เสมอ
  if v_start > p_on_date then
    v_start := (v_start::timestamp - interval '1 year')::date;
  end if;
  v_end := (v_start::timestamp + make_interval(years => 1) - interval '1 day')::date;

  -- (d) snapshot เกณฑ์ ณ สร้างรอบ (DD §3.5 renewal_cycles.required_credits)
  if p_required_credits is null or p_required_credits = '{}'::jsonb then
    p_required_credits := (public.credit_cycle_defaults() -> 'required_credits');
  end if;

  -- (e) INSERT — ชน uq(user_id, cycle_no) / EXCLUDE ไม่ซ้อน (การแข่งกับ tick อื่น/
  --     request อื่น) = อ่านรอบที่ชนะไปแล้วคืน (idempotent)
  begin
    insert into public.renewal_cycles (user_id, cycle_no, starts_on, ends_on, required_credits)
    values (p_user_id, v_no, v_start, v_end, p_required_credits)
    returning id into v_id;
    return v_id;
  exception
    when unique_violation or exclusion_violation then
      select id into v_id from public.renewal_cycles
      where user_id = p_user_id
        and p_on_date >= starts_on and p_on_date <= ends_on
      limit 1;
      if found then return v_id; end if;
      raise;
  end;
end;
$fn$;
alter function public.ensure_renewal_cycle(uuid, date, jsonb) owner to app_owner;
revoke execute on function public.ensure_renewal_cycle(uuid, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.ensure_renewal_cycle(uuid, date, jsonb)
  to app_owner, service_role;

-- ═══ (3) credit_accrual_tick — consumer ของ credit.accrual (C-1 · CRB-003 AC ≤5 นาที) ═══
create or replace function public.credit_accrual_tick() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_rounds int := 0;
  v_batch int;
  v_processed int := 0;
  v_already int := 0;
  v_no_cycle int := 0;
  v_failed int := 0;
  v_event uuid;
  v_user uuid;
  v_attempt uuid;
  v_rule jsonb;
  v_cycle uuid;
  v_ledger uuid;
  v_req jsonb;
  r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('ltc:credit_accrual')::bigint) then
    return jsonb_build_object('skipped', true, 'reason', 'already_running');
  end if;
  <<batches>>
  loop
    v_rounds := v_rounds + 1;
    if v_rounds > 5 then exit; end if; -- ≤1,000 event/tick กัน TX ยาว (รอบถัดไป 1 นาที)
    v_batch := 0;
    for r in
      select id, payload from public.event_outbox
      where topic = 'credit.accrual' and status = 'pending' and available_at <= now()
      order by available_at, id
      limit 200
    loop
      v_batch := v_batch + 1;
      v_event := r.id;
      begin
        v_user := (r.payload ->> 'user_id')::uuid;
        v_attempt := (r.payload ->> 'source_id')::uuid;
        v_rule := r.payload -> 'rule';
        v_ledger := null;

        -- รอบ lazy ที่ cover วันสอบผ่าน (ไม่ backfill — C-3) · เกณฑ์จาก rule snapshot
        -- เมื่อมี (event ใหม่ของ v3) ไม่มี = default Q1 (event เก่าของ 0020)
        v_req := null;
        if v_rule ? 'required_credits_per_cycle'
           and (v_rule ->> 'required_credits_per_cycle') is not null then
          v_req := jsonb_build_object(v_rule ->> 'credit_type',
                                      (v_rule ->> 'required_credits_per_cycle')::numeric);
        end if;
        v_cycle := public.ensure_renewal_cycle(
          v_user, (r.payload ->> 'passed_at')::timestamptz::date, v_req);

        if v_cycle is null then
          -- citizen ฯลฯ: ไม่มีรอบเป้าหมาย = ไม่เขียน ledger แต่ event จบเรียบร้อย (C-4)
          update public.event_outbox
          set status = 'processed', processed_at = now(),
              last_error = null
          where id = v_event;
          v_no_cycle := v_no_cycle + 1;
        else
          -- INSERT idempotent: partial UNIQUE(source_type, source_id, credit_type)
          -- WHERE accrual ของ 0006 กัน consume ซ้ำ (at-least-once → exactly-once ที่ ledger)
          insert into public.credit_ledger_entries (
            user_id, renewal_cycle_id, entry_type, credit_type, amount,
            source_type, source_id, rule_id, created_by)
          values (
            v_user, v_cycle, 'accrual', v_rule ->> 'credit_type',
            (v_rule ->> 'credits')::numeric,
            'assessment_attempt', v_attempt, (v_rule ->> 'rule_id')::uuid, null)
          on conflict (source_type, source_id, credit_type)
            where entry_type = 'accrual' and source_id is not null
          do nothing
          returning id into v_ledger;

          if v_ledger is not null then
            perform public.append_audit_event_internal(
              'CREDIT_ACCRUAL', 'credit_ledger', v_ledger::text, null, null,
              jsonb_build_object(
                'ledger_id', v_ledger, 'user_id', v_user, 'attempt_id', v_attempt,
                'rule_id', (v_rule ->> 'rule_id')::uuid, 'cycle_id', v_cycle,
                'credit_type', v_rule ->> 'credit_type',
                'amount', (v_rule ->> 'credits')::numeric,
                'source_type', 'assessment_attempt'),
              null, null, null, null); -- actor null = ระบบ (cron ไม่มี session)
            v_processed := v_processed + 1;
          else
            v_already := v_already + 1; -- ส่งซ้ำ (re-delivery) — ledger มีอยู่แล้ว
          end if;
          update public.event_outbox
          set status = 'processed', processed_at = now(), last_error = null
          where id = v_event;
        end if;
      exception when others then
        -- ต่อ event: บันทึกความล้ม + backoff (60s × 2^attempts สูงสุด 15 นาที) ·
        -- attempts ≥5 → failed (หยุด retry — ดูด้วย last_error / ops)
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
    exit when v_batch = 0;        -- คิวหมด
    exit when v_batch < 200;      -- เศษท้ายคิว
  end loop batches;
  return jsonb_build_object('skipped', false,
                            'processed', v_processed, 'already_accrued', v_already,
                            'no_cycle_target', v_no_cycle, 'failed', v_failed);
end;
$fn$;
alter function public.credit_accrual_tick() owner to app_owner;
revoke execute on function public.credit_accrual_tick() from public, anon, authenticated;
grant execute on function public.credit_accrual_tick() to app_owner, service_role, postgres;

-- ═══ (4) submit_attempt_core v3 — snapshot เพิ่ม required_credits_per_cycle ═══
-- เนื้อคัดลอก byte-verbatim จาก 0020:30-138 แก้จุดเดียว — rule jsonb เพิ่มฟิลด์
-- (D68: consumer ใช้ค่านี้ snapshot เกณฑ์รอบตอนสร้างแทรก) · signature เดิม →
-- create or replace คง ACL/owner เดิม (ระบุซ้ำเพื่อความชัดเจนเท่านั้น)
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

-- ═══ (5) admin_revoke_certificate v2 — reversal-on-revoke (CRT-006 · C-5) ═══
-- คัดลอกจาก 0019:648-689 + เพิ่ม: หยิบ enrollment/user จากแถวใบ · INSERT reversal ต่อรายการ
-- accrual ของ attempt ต้นทาง (ผ่าน enrollment ของใบ) ที่ยังไม่ถูก reverse · audit
-- CREDIT_REVERSAL 1 event สรุปต่อการเพิกถอน · return เพิ่ม credit_reversed_rows/total
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
  -- อ่าน cert_no + enrollment + user คืนให้ BFF ใน TX เดียวกัน
  select cert_no, enrollment_id, user_id
    into v_cert_no, v_enrollment, v_user
  from public.certificates where id = p_certificate_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)';
  end if;
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
    returning id, amount
  )
  select count(*), coalesce(sum(amount), 0), coalesce(jsonb_agg(id), '[]'::jsonb)
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

-- ═══ (6) admin_credit_adjust — CRB-007 (C-6/C-9: user-JWT ผ่าน BFF ตรวจสิทธิ์เอง) ═══
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

-- ═══ (7) my_credit_summary — CRB-005 (owner-check ภายใน · lazy รอบปัจจุบัน) ═══
create or replace function public.my_credit_summary() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_cur record;
begin
  if v_me is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  -- lazy: ผู้เรียกเป็น lawyer (หรือมีรอบ) = สร้างรอบปัจจุบันให้ ไม่ใช่ = null
  select * into v_cur from public.renewal_cycles
  where id = public.ensure_renewal_cycle(v_me, current_date)
  limit 1;

  return jsonb_build_object(
    'user_id', v_me,
    'current', case when v_cur.id is null then null else
      jsonb_build_object(
        'cycle_id', v_cur.id, 'cycle_no', v_cur.cycle_no,
        'starts_on', v_cur.starts_on, 'ends_on', v_cur.ends_on,
        'status', v_cur.status, 'required_credits', v_cur.required_credits,
        'balances', coalesce((
          select jsonb_object_agg(t.credit_type, jsonb_build_object(
                   'earned', t.earned, 'required', t.required,
                   'missing', greatest(t.required - t.earned, 0)))
          from (select le.credit_type,
                       sum(le.amount) as earned,
                       coalesce((v_cur.required_credits ->> le.credit_type)::numeric, 0)
                         as required
                from public.credit_ledger_entries le
                where le.renewal_cycle_id = v_cur.id
                group by le.credit_type) t), '{}'::jsonb))
    end,
    'history', coalesce((
      select jsonb_agg(row_to_json(h) order by h.cycle_no)
      from (
        select c.id as cycle_id, c.cycle_no, c.starts_on, c.ends_on, c.status,
               c.required_credits,
               coalesce((select jsonb_object_agg(t.credit_type, jsonb_build_object(
                          'earned', t.earned, 'required', t.required,
                          'missing', greatest(t.required - t.earned, 0)))
                         from (select le.credit_type,
                                      sum(le.amount) as earned,
                                      coalesce((c.required_credits ->> le.credit_type)::numeric, 0)
                                        as required
                               from public.credit_ledger_entries le
                               where le.renewal_cycle_id = c.id
                               group by le.credit_type) t), '{}'::jsonb) as balances
        from public.renewal_cycles c
        where c.user_id = v_me
      ) h), '[]'::jsonb));
end;
$fn$;
alter function public.my_credit_summary() owner to app_owner;
revoke execute on function public.my_credit_summary() from public, anon;
grant execute on function public.my_credit_summary() to authenticated;

-- ═══ (8) my_credit_transcript — CRB-006 (แถวต่อ enrollment ให้ BFF เรนเดอร์) ═══
create or replace function public.my_credit_transcript() returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|login_required)';
  end if;
  -- สุทธิ credit ต่อ enrollment = accrual ของ attempt ใน enrollment นั้น + reversal
  -- ที่ชี้กลับมา (ติดลบ) — adjustment ไม่ผูก enrollment จึงอยู่ที่ /me/credits เท่านั้น
  return jsonb_build_object(
    'user_id', v_me,
    'generated_at', now(),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'enrollment_id', e.id,
               'course_id', e.course_id,
               'course_title', c.title_th,
               'enrollment_status', e.status,
               'completed_at', e.completed_at,
               'passed', b.passed,
               'best_score_pct', b.best_score,
               'passed_at', b.passed_at,
               'credits', coalesce(led.credits, '{}'::jsonb),
               'certificates', coalesce(cr.certs, '[]'::jsonb))
             order by coalesce(e.completed_at, e.enrolled_at) desc, e.id)
      from public.enrollments e
      join public.courses c on c.id = e.course_id
      left join (
        select enrollment_id,
               max(score_pct) as best_score,
               bool_or(passed) as passed,
               min(submitted_at) filter (where passed) as passed_at
        from public.assessment_attempts
        where user_id = v_me and submitted_at is not null
        group by enrollment_id) b on b.enrollment_id = e.id
      left join (
        select enrollment_id,
               jsonb_agg(jsonb_build_object('cert_no', cert_no, 'status', status,
                                            'issued_at', issued_at)
                         order by issued_at) as certs
        from public.certificates
        where user_id = v_me
        group by enrollment_id) cr on cr.enrollment_id = e.id
      left join (
        -- สุทธิ = SUM ข้าม union ก่อน แล้วค่อยต่อเป็น object ต่อ enrollment
        -- (jsonb_object_agg เจอคีย์ซ้ำเก็บค่าหลังสุด — ต้อง sum ให้จบก่อน object_agg เสมอ)
        select g.enrollment_id, jsonb_object_agg(g.credit_type, g.net) as credits
        from (
          select s.enrollment_id, s.credit_type, sum(s.net) as net
          from (
            select aa.enrollment_id, le.credit_type, le.amount as net
            from public.credit_ledger_entries le
            join public.assessment_attempts aa on aa.id = le.source_id
            where le.user_id = v_me
              and le.source_type = 'assessment_attempt'
              and le.entry_type = 'accrual'
            union all
            select aa.enrollment_id, le.credit_type, le.amount as net
            from public.credit_ledger_entries le
            join public.credit_ledger_entries le_o on le_o.id = le.original_entry_id
            join public.assessment_attempts aa on aa.id = le_o.source_id
            where le.user_id = v_me
              and le.entry_type = 'reversal'
          ) s
          group by s.enrollment_id, s.credit_type
        ) g
        group by g.enrollment_id) led on led.enrollment_id = e.id
      where e.user_id = v_me and e.deleted_at is null), '[]'::jsonb));
end;
$fn$;
alter function public.my_credit_transcript() owner to app_owner;
revoke execute on function public.my_credit_transcript() from public, anon;
grant execute on function public.my_credit_transcript() to authenticated;

-- ═══ (9) grants/policies ที่ขาดของ app_owner (definer ไม่มี BYPASSRLS — 0010 §6) ═══
-- event_outbox: SELECT/INSERT มีแล้ว (0010 §6 + 0011) · tick ต้อง UPDATE สถานะ event
grant update on public.event_outbox to app_owner;
drop policy if exists app_owner_update_event_outbox on public.event_outbox;
create policy app_owner_update_event_outbox
  on public.event_outbox for update to app_owner
  using (true) with check (true);
-- renewal_cycles: policy แบบ blanket มีแล้ว (0010 §6) แต่ไม่เคยมี grant INSERT ให้ app_owner
grant insert on public.renewal_cycles to app_owner;

-- ═══ (10) pg_cron ทุก 1 นาที (upsert ตาม jobname — แบบแผน 0026) ═══
-- CRB-003 AC ≤5 นาที: pickup ≤1 นาที + ประมวลผล ≤5 รอบ/tick
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'ltc-credit-accrual') then
    perform cron.unschedule('ltc-credit-accrual');
  end if;
  perform cron.schedule(
    'ltc-credit-accrual', '* * * * *',
    'select public.credit_accrual_tick()');
end
$do$;
