-- ═══ 0022 — DCR-7 / PB-18 (Wave E): question_snapshot + type ของข้อสอบ ═══
-- ทำไม: snapshot ไม่เก็บชนิดข้อ (single/multiple_choice/true_false) — ห้องสอบจึง
-- ตอบ checkbox ทุกข้อ (D37 สัญญา {question_id,version,text,options} + points นับ
-- จากตอนนั้น) · D55-1: เติม 'type' ตอน start (จาก questions.type ณ เวลานั้น —
-- snapshot immutability คงเดิม: type เปลี่ยนหลัง version bump ไม่ย้อนแก้ attempt
-- เก่า) · snapshot เดิมก่อน 0022 ไม่มี type → paper view default 'multiple_choice'
-- (= พฤติกรรม checkbox วันนี้เป๊ะ · grading set-equality ฝั่ง server ตัดสินอยู่
-- แล้ว คะแนนไม่เพี้ยน · cron 0020 ปิด attempt ค้างทุก 1 นาที ทำให้ attempt เก่า
-- หลัง deploy ≈ ศูนย์)
-- โครงสร้าง: copy start_attempt ทั้งฟังก์ชันจาก 0011 (แบบแผน 0019/0020 ที่แทน
-- ฟังก์ชันด้วยสำเนาเต็ม) แก้ 2 จุด: (1) ord CTE select q.type เพิ่ม (2)
-- jsonb_build_object เติมคีย์ 'type' · guards ทุกตัวคงเดิมทุกไบต์
create or replace function public.start_attempt(
  p_assessment_id uuid
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_assessment public.assessments%rowtype;
  v_rules public.assessment_rules%rowtype;
  v_enrollment_id uuid;
  v_attempt_id uuid;
  v_attempt_no int;
  v_prior int;
  v_last_submitted timestamptz;
  v_cur public.assessment_attempts%rowtype;
  v_new_session text;
  v_deadline timestamptz;
  v_bank_ids uuid[];
  v_cat_ids uuid[];
  v_diffs text[];
  v_pool int;
  v_qids uuid[];
  v_pick uuid[];
  v_cnt int;
  v_seed text;
  r_mix record;
  v_grace constant interval := interval '5 minutes'; -- exam_disconnect_grace_minutes (Appendix A)
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  -- D20-B5: session ของ attempt ผูกกับ auth session ของอุปกรณ์ผู้เรียก (fail-closed)
  v_new_session := public.auth_session_claim();
  if v_new_session is null then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: token ไม่มี session_id (ERR-VAL-001)';
  end if;
  select * into v_assessment from public.assessments
  where id = p_assessment_id and deleted_at is null;
  if not found or v_assessment.status <> 'published' then
    raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว (ERR-ASM-003)';
  end if;
  select * into v_rules from public.assessment_rules r
  where r.assessment_id = p_assessment_id
    and r.effective_from <= now() -- ใช้กตเวอร์ชันที่มีผล ณ วันสอบ (DD §3.4 - F21)
  order by r.effective_from desc, r.version desc
  limit 1;
  if not found then
    raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว (ERR-ASM-003)';
  end if;
  select e.id into v_enrollment_id
  from public.enrollments e
  where e.course_id = v_assessment.course_id and e.user_id = v_user
    and e.status = 'active' and e.deleted_at is null;
  if not found then
    raise exception 'ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)';
  end if;
  -- B3: เรียนครบตามกติกา (require_course_complete — default true)
  if v_rules.require_course_complete then
    if exists (
      select 1
      from public.lessons l
      join public.course_modules m on m.id = l.module_id
      where m.course_id = v_assessment.course_id and l.deleted_at is null
        and not exists (select 1 from public.lesson_progress lp
                        where lp.lesson_id = l.id and lp.enrollment_id = v_enrollment_id
                          and lp.status = 'completed'))
    then
      raise exception 'ยังเรียนบทก่อนหน้าไม่ครบตามเงื่อนไข (ERR-LRN-002)';
    end if;
  end if;
  -- B4 + ASM-011 (D19-M4): มี attempt ค้าง → ตรวจก่อนนับ max_attempts — takeover ของ
  -- attempt ที่ lease หมดต้องสำเร็จแม้จะใช้ครบจำนวนครั้งแล้ว (แถวค้างคือครั้งสุดท้ายของ
  -- ตัวเอง — ห้ามปฏิเสธด้วย ERR-ASM-001; DD §3.4 lease/takeover)
  select * into v_cur from public.assessment_attempts
  where assessment_id = p_assessment_id and user_id = v_user and status = 'in_progress';
  if found then
    if now() <= coalesce(v_cur.lease_expires_at, v_cur.started_at + v_grace) then
      raise exception 'มีการสอบที่ยังไม่จบอยู่แล้ว (ERR-ASM-002)';
    end if;
    -- v_new_session = claim ของอุปกรณ์ที่ขอ takeover แล้ว (D20-B5 — อ่านต้นฟังก์ชัน)
    -- recheck เงื่อนไข lease ใน UPDATE เอง (กัน TOCTOU: save_answer จาก session
    -- เดิมอาจ renew lease หลังจาก SELECT ข้างบน — ถ้าแถวไม่ถูกแก้ = lease ยังไม่หมดจริง)
    update public.assessment_attempts
    set session_id = v_new_session, lease_expires_at = now() + v_grace
    where id = v_cur.id
      and now() > coalesce(lease_expires_at, started_at + v_grace);
    if not found then
      raise exception 'มีการสอบที่ยังไม่จบอยู่แล้ว (ERR-ASM-002)';
    end if;
    perform public.append_audit_event_internal('EXAM_SESSION_TAKEOVER',
      'assessment_attempt', v_cur.id::text, null, null,
      jsonb_build_object('attempt_id', v_cur.id,
                         'session_id_old', v_cur.session_id,
                         'session_id_new', v_new_session,
                         'reason', 'lease_expired'),
      null, null, null);
    return jsonb_build_object('attempt_id', v_cur.id, 'session_id', v_new_session,
                              'expires_at', v_cur.expires_at, 'question_count', v_cur.question_count,
                              'takeover', true);
  end if;

  -- B3: max_attempts (นับทุก attempt ที่ไม่ถูก voided)
  select count(*) into v_prior from public.assessment_attempts
  where assessment_id = p_assessment_id and user_id = v_user and status <> 'voided';
  if v_prior >= v_rules.max_attempts then
    raise exception 'คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว (ERR-ASM-001)';
  end if;
  -- B3: cooldown นับจากครั้งล่าสุดที่ส่งแล้ว
  select max(submitted_at) into v_last_submitted
  from public.assessment_attempts
  where assessment_id = p_assessment_id and user_id = v_user and submitted_at is not null;
  if v_last_submitted is not null
     and v_last_submitted + make_interval(mins => v_rules.attempt_cooldown_minutes) > now() then
    raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว: ยังอยู่ในระยะห่างระหว่างครั้ง (ERR-ASM-003)';
  end if;

  -- ── M1 + D19-M5: คัด pool ตาม selection ครบ (DD §3.4: bank_ids, categories,
  --    difficulty mix) + shuffle_questions/shuffle_options มีผลจริง ──
  -- seed สุ่มฝั่ง server ต่อ attempt (ใช้ทั้งลำดับข้อและลำดับตัวเลือก)
  v_seed := gen_random_uuid()::text;
  v_bank_ids := coalesce((select array_agg(b::uuid)
                           from jsonb_array_elements_text(
                             coalesce(v_rules.selection->'bank_ids', '[]'::jsonb)) b),
                          '{}'::uuid[]);
  v_cat_ids := coalesce((select array_agg(c::uuid)
                           from jsonb_array_elements_text(
                             coalesce(v_rules.selection->'categories', '[]'::jsonb)) c),
                          '{}'::uuid[]);
  v_diffs := coalesce((select array_agg(d)
                        from jsonb_array_elements_text(
                          coalesce(v_rules.selection->'difficulty', '[]'::jsonb)) d),
                       '{}'::text[]);
  -- difficulty_mix = {"easy":n,"medium":n,"hard":n} — สรุปแทนการสุ่มตาม question_count
  if v_rules.selection ? 'difficulty_mix'
     and jsonb_typeof(v_rules.selection -> 'difficulty_mix') = 'object' then
    v_qids := '{}'::uuid[];
    for r_mix in select key, value from jsonb_each_text(v_rules.selection -> 'difficulty_mix') loop
      if r_mix.key not in ('easy','medium','hard') then
        raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: difficulty_mix (ERR-VAL-001)';
      end if;
      begin
        v_cnt := r_mix.value::int;
      exception when others then
        raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: difficulty_mix (ERR-VAL-001)';
      end;
      if v_cnt < 0 or v_cnt > 500 then
        raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: difficulty_mix (ERR-VAL-001)';
      end if;
      select coalesce(array_agg(t.id), '{}'::uuid[]) into v_pick
      from (select q.id
            from public.questions q
            join public.question_banks qb on qb.id = q.bank_id
            where q.status = 'active' and q.difficulty::text = r_mix.key
              and ((cardinality(v_bank_ids) > 0 and q.bank_id = any (v_bank_ids))
                   or (cardinality(v_bank_ids) = 0 and qb.course_id = v_assessment.course_id))
              and (cardinality(v_cat_ids) = 0 or qb.category_id = any (v_cat_ids))
              -- D20-M3: หยิบเฉพาะข้อที่มีตัวเลือก — กันข้อ optionless หลุดเข้า snapshot
              and exists (select 1 from public.question_options o where o.question_id = q.id)
            order by md5(q.id::text || v_seed)
            limit v_cnt) t;
      if cardinality(v_pick) < v_cnt then
        raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว: คลังข้อไม่พอ (ERR-ASM-003)';
      end if;
      v_qids := v_qids || v_pick;
    end loop;
    if cardinality(v_qids) = 0 then
      raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: difficulty_mix (ERR-VAL-001)';
    end if;
  else
    select count(*) into v_pool
    from public.questions q
    join public.question_banks qb on qb.id = q.bank_id
    where q.status = 'active'
      and ((cardinality(v_bank_ids) > 0 and q.bank_id = any (v_bank_ids))
           or (cardinality(v_bank_ids) = 0 and qb.course_id = v_assessment.course_id))
      and (cardinality(v_cat_ids) = 0 or qb.category_id = any (v_cat_ids))
      and (cardinality(v_diffs) = 0 or q.difficulty::text = any (v_diffs))
      -- D20-M3: นับ pool ด้วยเกณฑ์เดียวกับที่หยิบจริง (มีตัวเลือกเท่านั้น)
      and exists (select 1 from public.question_options o where o.question_id = q.id);
    if v_pool < v_rules.question_count then
      raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว: คลังข้อไม่พอ (ERR-ASM-003)';
    end if;
    -- shuffle_questions=false → ลำดับเสถียรตาม created_at,id (ไม่สุ่ม) — D19-M5
    select coalesce(array_agg(t.id), '{}'::uuid[]) into v_qids
    from (select q.id
          from public.questions q
          join public.question_banks qb on qb.id = q.bank_id
          where q.status = 'active'
            and ((cardinality(v_bank_ids) > 0 and q.bank_id = any (v_bank_ids))
                 or (cardinality(v_bank_ids) = 0 and qb.course_id = v_assessment.course_id))
            and (cardinality(v_cat_ids) = 0 or qb.category_id = any (v_cat_ids))
            and (cardinality(v_diffs) = 0 or q.difficulty::text = any (v_diffs))
            and exists (select 1 from public.question_options o where o.question_id = q.id) -- D20-M3
          order by case when v_rules.shuffle_questions
                        then md5(q.id::text || v_seed)
                        else q.created_at::text || q.id::text end,
                   q.created_at, q.id
          limit v_rules.question_count) t;
  end if;

  -- v_new_session = JWT session claim ของผู้เรียก (D20-B5 — อ่านไว้ต้นฟังก์ชันแล้ว)
  v_deadline := now() + make_interval(mins => v_rules.time_limit_minutes);
  select coalesce(max(attempt_no), 0) + 1 into v_attempt_no
  from public.assessment_attempts
  where assessment_id = p_assessment_id and user_id = v_user;

  begin
    insert into public.assessment_attempts
      (assessment_id, user_id, enrollment_id, rules_id, attempt_no,
       session_id, lease_expires_at, expires_at, question_count)
    values
      (p_assessment_id, v_user, v_enrollment_id, v_rules.id, v_attempt_no,
       v_new_session, now() + v_grace, v_deadline, cardinality(v_qids))
    returning id into v_attempt_id;
  exception
    -- race: start ซ้อนสอง TX (double-click) ชน uq_assessment_attempts_in_progress
    when unique_violation then
      raise exception 'มีการสอบที่ยังไม่จบอยู่แล้ว (ERR-ASM-002)';
  end;

  -- snapshot ต่อข้อ: ลำดับข้อตามที่คัดไว้ (seq เสถียรเมื่อ shuffle_questions=false)
  -- + options เรียงตามการแสดงผลจริง (shuffle_options=false → sort_order เดิม — D19-M5
  -- ใช้ lpad กัน lexicographic "10"<"2")
  with ord as (
    select q.id as qid, q.question_text, q.points, q.version, q.type,
           row_number() over (order by case when v_rules.shuffle_questions
                                             then md5(q.id::text || v_seed)
                                             else q.created_at::text || q.id::text end,
                                        q.created_at, q.id) as seq
    from public.questions q
    where q.id = any (v_qids)
  ),
  snap as (
    select o.question_id,
           jsonb_agg(jsonb_build_object('id', o.id, 'text', o.option_text,
                                        'is_correct', o.is_correct, 'points', ord.points)
                     order by case when v_rules.shuffle_options
                                   then md5(o.id::text || v_seed)
                                   else lpad(o.sort_order::text, 8, '0') end) as options
    from public.question_options o
    join ord on ord.qid = o.question_id
    group by o.question_id
  )
  insert into public.attempt_answers (attempt_id, question_id, seq, option_order, question_snapshot)
  select v_attempt_id, ord.qid, ord.seq,
         (select coalesce(array_agg(t.ord::int order by t.ord), '{}'::int[])
          from jsonb_array_elements(snap.options) with ordinality as t(o, ord)),
         jsonb_build_object('question_id', ord.qid, 'version', ord.version,
                            'text', ord.question_text, 'options', snap.options,
                            'points', ord.points, 'type', ord.type)
  from ord join snap on snap.question_id = ord.qid;

  perform public.append_audit_event_internal('EXAM_ATTEMPT_START', 'assessment',
    p_assessment_id::text, null, null,
    jsonb_build_object('attempt_id', v_attempt_id, 'assessment_id', p_assessment_id,
                       'deadline_at', v_deadline),
    null, null, null);
  return jsonb_build_object('attempt_id', v_attempt_id, 'session_id', v_new_session,
                            'expires_at', v_deadline, 'question_count', cardinality(v_qids));
end;
$fn$;
alter function public.start_attempt(uuid) owner to app_owner;
revoke execute on function public.start_attempt(uuid) from public, anon;
grant execute on function public.start_attempt(uuid) to authenticated;

-- ═══ paper view: คืน type จาก snapshot · เก่าไม่มี → default 'multiple_choice' ═══
-- (DCR-7/PB-18 · D55-1) — โครง stripping เดิมของ 0019 คงทุกไบต์ (ตัด 'points'
-- ระดับบน + is_correct/points ในทุก option) เพิ่มคีย์ 'type' ทาง coalesce
create or replace view public.learner_attempt_paper_view
  with (security_invoker = false) as
select
  at.id as attempt_id,
  at.user_id,
  at.assessment_id,
  at.attempt_no,
  at.status,
  at.started_at,
  at.expires_at,
  aa.question_id,
  aa.seq,
  aa.option_order,
  aa.selected_option_ids,
  aa.answered_at,
  (aa.question_snapshot - 'points') || jsonb_build_object(
    'type', coalesce(aa.question_snapshot ->> 'type', 'multiple_choice'),
    'options', coalesce((
    select jsonb_agg(o - 'is_correct' - 'points' order by ord)
    from jsonb_array_elements(aa.question_snapshot -> 'options') with ordinality as t(o, ord)
  ), '[]'::jsonb)) as question_paper
from public.assessment_attempts at
join public.attempt_answers aa on aa.attempt_id = at.id
where at.user_id = auth.uid()
  and at.status = 'in_progress';

revoke all on public.learner_attempt_paper_view from public, anon, authenticated, service_role;
grant select on public.learner_attempt_paper_view to authenticated;
