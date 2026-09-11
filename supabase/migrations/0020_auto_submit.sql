-- ═══ 0020_auto_submit.sql — D-10: auto-submit scheduler (ASM-005 · RTM L102 · TC-ASM-05/TC-009) ═══
-- ตัดสิน lead (D53 ตามอำนาจ D22) — เหตุผลเต็มอยู่ /tmp/d10-plan.md:
--   1) "submit อัตโนมัติ" = ตรวจคะแนนจากคำตอบที่บันทึกไว้แล้ว (autosave ทุกคลิกอยู่ฝั่ง server)
--      late=true → passed/failed ตามเกณฑ์ปกติ + credit.accrual ตามปกติ — grading เดียวกับ
--      submit ปกติผ่าน core ร่วม (single grader ห้าม duplicate) · downstream (view/eligibility/
--      cooldown/max_attempts/credit/my-exams) ไม่ต้องรู้จัก state ใหม่
--      enum 'expired'/'voided' (0001 L118) เหลือไม่ใช้ต่อ — เหมือน 'submitted' ที่ไม่มี path เขียน
--   2) กลไก = pg_cron ทุก 1 นาที (dev image มี pg_cron 1.6 available ยืนยันแล้ว · Supabase cloud
--      รองรับด้วย — dev/prod ใช้สิ่งเดียวกันตามหลัก 100% local ↔ 100% cloud)
--   3) ปิดเฉพาะ attempt ที่พ้น grace: now() > expires_at + 5 นาที (เส้นเดียวกับ ERR-ASM-004
--      ของ submit_attempt L799) — ระหว่าง grace ผู้เรียนยังกดส่งเองได้ (late)
--   4) ทุกแถวที่ปิด = EXAM_SUBMIT audit เดิม (ต้นทาง 0019 ก็ส่ง actor=null อยู่แล้ว —
--      parity ครบ) + details.auto=true + late_seconds (ความล่าช้า วิ — รับมาจากแถว
--      EXAM_TIME_LIMIT_EXCEED ของ AUDIT-LOG-DESIGN ที่รวมเป็นแถวเดียว ลด audit noise)
--      + idempotency_key = attempt_id เหมือนเดิม
--   5) batch สูงสุด 200 แถว/รอบ ทุก 1 นาที = headroom 12,000/ชม. > 5,000 concurrent worst case
--   6) save_answer ปฏิเสธทันทีพ้น expires_at (0011 L714 ไม่มี grace) และ start_attempt
--      ปฏิเสธ ERR-ASM-002 ขณะมี attempt ค้าง → ไม่มี scheduler = ผู้เรียนหมดเวลาถูกล็อก
--      ถาวร — migration นี้คือตัวปลดล็อกเดียว (บันทึกไว้ใน RTM บริบท ASM-005)

-- ── 1) pg_cron (schema extensions ตาม convention ของ supabase/postgres + cloud) ──
create schema if not exists extensions;
create extension if not exists pg_cron with schema extensions;

-- ── 2) core ร่วม: หางกราดของ submit_attempt "ฉบับ 0019 (PB-15)" ทุกไบต์ (grading + score +
--        credit + audit) — 0011 ถูก 0019 เขียนทับแล้ว (v_qcount + total_points + early-return
--        ครบ contract) ต้องอิง 0019 เท่านั้น
--        p_auto=false → payload/return เทียบเท่า submit_attempt ปัจจุบันเป๊ะ (gate r5 PASS คงอยู่)
--        ผู้เรียกต้องถือแถว FOR UPDATE แล้ว (idempotent-key ระดับแถว = in_progress → terminal) ──
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
            'carry_over', v_rule.carry_over)));
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

-- ── 3) submit_attempt รื้อครึ่งหลังมาเรียก core (ครึ่งหน้า = guards ทุกอย่างเดิมทุกไบต์) ──
create or replace function public.submit_attempt(
  p_attempt_id uuid,
  p_session_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_attempt public.assessment_attempts%rowtype;
  v_total int := 0;
  v_late boolean;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  select * into v_attempt from public.assessment_attempts
  where id = p_attempt_id and user_id = v_user
  for update; -- idempotent key ของ submit (DD §3.4)
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)';
  end if;
  if v_attempt.submitted_at is not null then
    -- 0019: early-return idempotent เติม contract ใหม่ให้ครบ (question_count จริงจากแถว
    -- attempt + total_points รวม snapshot) — รูป response สองทางเหมือนกันเป๊ะ
    select coalesce(sum((question_snapshot->>'points')::smallint), 0)
    into v_total
    from public.attempt_answers
    where attempt_id = p_attempt_id;
    return jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status,
                              'score_pct', v_attempt.score_pct, 'passed', v_attempt.passed,
                              'question_count', v_attempt.question_count,
                              'total_points', v_total,
                              'already_submitted', true);
  end if;
  -- B4 + D20-B5: session binding สองชั้น (แถว + JWT claim — เหมือน save_answer)
  if p_session_id is null
     or p_session_id <> v_attempt.session_id
     or p_session_id is distinct from public.auth_session_claim() then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ASM-011 — ERR-RBAC-001)';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว (ERR-ASM-005)';
  end if;
  -- deadline + grace: เกิน expires_at ได้ไม่เกิน grace (ผู้เรียนกดส่งเองยังได้ = late)
  if now() > v_attempt.expires_at + interval '5 minutes' then
    raise exception 'หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม (ERR-ASM-004)';
  end if;
  v_late := now() > v_attempt.expires_at;
  return public.submit_attempt_core(v_attempt, v_late, false);
end;
$fn$;
alter function public.submit_attempt(uuid, text) owner to app_owner;
-- (grants คงเดิมตาม 0011 tail: revoke public/anon · grant authenticated — เขียนซ้ำกันเปลี่ยน
--  definition ทำ grant ไม่หาย แต่เขียนซ้ำเพื่อความชัด)
revoke execute on function public.submit_attempt(uuid, text) from public, anon;
grant execute on function public.submit_attempt(uuid, text) to authenticated;

-- ── 4) scheduler RPC — ปิด attempt ค้างที่พ้น grace (คนเดียวที่ปลดล็อก ERR-ASM-002) ──
create or replace function public.auto_close_expired_attempts(
  p_batch_limit int default 200
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  r record;
  v_att public.assessment_attempts%rowtype;
  v_closed int := 0;
begin
  if p_batch_limit is null or p_batch_limit < 1 or p_batch_limit > 1000 then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง (ERR-VAL-001)';
  end if;
  for r in
    select id from public.assessment_attempts
    where status = 'in_progress'
      and now() > expires_at + interval '5 minutes'
    order by expires_at
    limit p_batch_limit
  loop
    select * into v_att from public.assessment_attempts
    where id = r.id and status = 'in_progress'
    for update; -- recheck ใต้ lock: อาจถูก submit มือแข่งกันระหว่างวน
    if found and now() > v_att.expires_at + interval '5 minutes' then
      perform public.submit_attempt_core(v_att, true, true);
      v_closed := v_closed + 1;
    end if;
  end loop;
  return jsonb_build_object('closed', v_closed, 'ran_at', clock_timestamp());
end;
$fn$;
alter function public.auto_close_expired_attempts(int) owner to app_owner;
revoke execute on function public.auto_close_expired_attempts(int) from public, anon, authenticated;
grant execute on function public.auto_close_expired_attempts(int) to app_owner, service_role, postgres;

-- ── 5) cron ทุก 1 นาที (ASM-005 board · upsert ตาม jobname — รัน migration ซ้ำปลอดภัย) ──
-- (ตรวจจริงบน dev image: pg_cron non-relocatable — วัตถุอยู่ schema `cron` เสมอ
--  แม้ create ... with schema extensions · อ้างเป็นชื่อ 2-part เท่านั้น ห้าม 3-part)
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'ltc-auto-close-attempts') then
    perform cron.unschedule('ltc-auto-close-attempts');
  end if;
  perform cron.schedule(
    'ltc-auto-close-attempts', '* * * * *',
    'select public.auto_close_expired_attempts()');
end
$do$;
