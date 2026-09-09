-- 0011_functions.sql — SECURITY DEFINER write functions (DD §4.7, F2/D12)
-- ผู้เรียนเขียนตารางได้ผ่าน function เดียวเท่านั้น; ทุกตัวตรวจ auth.uid() + เงื่อนไขธุรกิจ
-- ข้างใน + เขียน audit ใน TX เดียวกัน (AUDIT §1.5, D11-8) + grant EXECUTE ให้ authenticated
-- NB: เงื่อนไขธุรกิจที่ doc ไม่ลงละเอียด = skeleton + TODO(Wave C) ชัดเจน

-- app_owner ต้องอ่านทุกตารางเพื่อตรวจเงื่อนไข (RLS ไม่ผูก owner)
grant select on all tables in schema public to app_owner;

-- ═══ enroll() — enrollments INSERT (DD §4.7) ═══
create or replace function public.enroll(p_course_id uuid) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_course public.courses%rowtype;
  v_enrollment_id uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated (ERR-AUTH-001)';
  end if;
  select * into v_course from public.courses
  where id = p_course_id and deleted_at is null;
  if not found then
    raise exception 'course not found (ERR-CRS-404)';
  end if;
  -- TODO(Wave C): business conditions — หลักสูตรต้อง published; สิทธิ์ตาม role/is_public
  -- (lawyer-only หลักสูตรต้องมี role lawyer); prerequisite; หมดอายุ
  if v_course.status <> 'published' then
    raise exception 'course not published (ERR-ENR-001)';
  end if;
  if not v_course.is_public
     and not public.has_any_role(array['lawyer']) then
    raise exception 'course for lawyers only (ERR-ENR-002)';
  end if;
  if exists (select 1 from public.enrollments e
             where e.user_id = v_user and e.course_id = p_course_id
               and e.deleted_at is null) then
    raise exception 'already enrolled (ERR-ENR-003)';
  end if;
  insert into public.enrollments (user_id, course_id, source, created_by)
  values (v_user, p_course_id, 'self', null)
  returning id into v_enrollment_id;
  perform public.append_audit_event('ENROLL_CREATE', 'course', p_course_id::text,
    null, null,
    jsonb_build_object('course_id', p_course_id, 'user_id', v_user),
    null, null, null, null);
  return v_enrollment_id;
end;
$fn$;

-- ═══ record_lesson_progress() — lesson_progress UPSERT (DD §4.7, SDS §3.3, D11-15) ═══
create or replace function public.record_lesson_progress(
  p_enrollment_id uuid,
  p_lesson_id uuid,
  p_video_max_position_sec int default null,
  p_watch_sec_delta int default 0,
  p_dwell_sec_delta int default 0,
  p_quiz_score_pct smallint default null
) returns void
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_lp public.lesson_progress%rowtype;
begin
  if v_user is null then
    raise exception 'unauthenticated (ERR-AUTH-001)';
  end if;
  if not exists (select 1 from public.enrollments e
                 where e.id = p_enrollment_id and e.user_id = v_user
                   and e.deleted_at is null) then
    raise exception 'enrollment not owned by caller (ERR-PRG-001)';
  end if;
  -- server เป็นผู้ clamp ค่า (บวกลบ delta เข้าค่าเดิม; ห้าม client กำหนด absolute)
  select * into v_lp from public.lesson_progress
  where enrollment_id = p_enrollment_id and lesson_id = p_lesson_id
  for update;
  if found then
    update public.lesson_progress set
      video_max_position_sec = greatest(video_max_position_sec,
        coalesce(p_video_max_position_sec, video_max_position_sec)),
      watch_sec_accum = watch_sec_accum + greatest(coalesce(p_watch_sec_delta, 0), 0),
      dwell_sec = dwell_sec + greatest(coalesce(p_dwell_sec_delta, 0), 0),
      quiz_score_pct = coalesce(p_quiz_score_pct, quiz_score_pct)
    where enrollment_id = p_enrollment_id and lesson_id = p_lesson_id;
  else
    insert into public.lesson_progress
      (enrollment_id, lesson_id, video_max_position_sec,
       watch_sec_accum, dwell_sec, quiz_score_pct)
    values
      (p_enrollment_id, p_lesson_id, greatest(coalesce(p_video_max_position_sec, 0), 0),
       greatest(coalesce(p_watch_sec_delta, 0), 0),
       greatest(coalesce(p_dwell_sec_delta, 0), 0), p_quiz_score_pct);
  end if;
  -- TODO(Wave C): business conditions — bounded playback intervals (SDS §3.3);
  -- ตัดสิน completed_at จาก watch_pct >= video_complete_pct (SRS Appendix A) + audit LESSON_COMPLETED
  -- ครั้งเดียวเมื่อจบบท (idempotent)
end;
$fn$;

-- ═══ record_quiz_attempt() — quiz_attempts INSERT (DD §4.7) ═══
create or replace function public.record_quiz_attempt(
  p_quiz_id uuid,
  p_answers jsonb -- [{question_id, selected_option_ids:[uuid]}]
) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_quiz public.lesson_quizzes%rowtype;
  v_attempt_no int;
  v_score smallint;
  v_passed boolean;
  v_attempt_id uuid;
begin
  if v_user is null then
    raise exception 'unauthenticated (ERR-AUTH-001)';
  end if;
  select * into v_quiz from public.lesson_quizzes where id = p_quiz_id;
  if not found then
    raise exception 'quiz not found (ERR-QZ-404)';
  end if;
  -- TODO(Wave C): business conditions — ลงทะเบียนหลักสูตรของ quiz ก่อน (active enrollment)
  -- ตรวจ max_attempts ของ v_quiz; ตรวจคะแนนจาก quiz_options ฝั่ง server ล้วน (ห้ามรับ score
  -- จาก caller); answers_snapshot = ข้อ+ตัวเลือกที่เลือก ณ ตรวจ
  if v_quiz.max_attempts is not null then
    select count(*) into v_attempt_no from public.quiz_attempts
    where quiz_id = p_quiz_id and user_id = v_user;
    if v_attempt_no >= v_quiz.max_attempts then
      raise exception 'max attempts reached (ERR-QZ-001)';
    end if;
  end if;
  select coalesce(max(attempt_no), 0) + 1 into v_attempt_no
  from public.quiz_attempts where quiz_id = p_quiz_id and user_id = v_user;
  -- TODO(Wave C): grading จาก quiz_options จริง — ด้านล่างเป็น skeleton (score ยังไม่ตัดสิน)
  v_score := null;
  v_passed := null;
  insert into public.quiz_attempts
    (quiz_id, user_id, attempt_no, submitted_at, score_pct, passed, answers_snapshot)
  values
    (p_quiz_id, v_user, v_attempt_no, now(), v_score, v_passed, p_answers)
  returning id into v_attempt_id;
  perform public.append_audit_event('QUIZ_SUBMIT', 'lesson_quiz', p_quiz_id::text,
    null, null,
    jsonb_build_object('lesson_quiz_id', p_quiz_id, 'user_id', v_user,
                       'attempt_no', v_attempt_no),
    null, null, null, null);
  return v_attempt_id;
end;
$fn$;

-- ═══ start_attempt() — assessment_attempts + attempt_answers INSERT (DD §4.7) ═══
create or replace function public.start_attempt(
  p_assessment_id uuid,
  p_session_id text
) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_attempt_id uuid;
  v_rules public.assessment_rules%rowtype;
  v_attempt_no int;
  v_questions jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated (ERR-AUTH-001)';
  end if;
  if p_session_id is null or btrim(p_session_id) = '' then
    raise exception 'session_id required (ASM-011)';
  end if;
  select * into v_rules from public.assessment_rules r
  where r.assessment_id = p_assessment_id
    and r.effective_from <= now() -- ใช้กฎเวอร์ชันที่มีผล ณ วันสอบ (DD §3.4 - F21)
  order by r.effective_from desc, r.version desc
  limit 1;
  if not found then
    raise exception 'no effective assessment rules (ERR-ASM-001)';
  end if;
  -- TODO(Wave C): business conditions ตาม DD §4.7 —
  --   enrollment active + require_course_complete + max_attempts + cooldown
  --   + ไม่มี attempt in_progress (UNIQUE partial กันซ้ำอยู่แล้ว) + ผูก lease_expires_at
  --   + สุ่มข้อตาม selection + เขียน question_snapshot ต่อข้อ (F13/F14)
  if exists (select 1 from public.assessment_attempts a
             where a.assessment_id = p_assessment_id and a.user_id = v_user
               and a.status = 'in_progress') then
    raise exception 'attempt already in progress (ERR-ASM-002)';
  end if;
  select coalesce(max(attempt_no), 0) + 1 into v_attempt_no
  from public.assessment_attempts
  where assessment_id = p_assessment_id and user_id = v_user;
  insert into public.assessment_attempts
    (assessment_id, user_id, enrollment_id, rules_id, attempt_no,
     session_id, lease_expires_at, expires_at, question_count)
  select
    p_assessment_id, v_user, e.id, v_rules.id, v_attempt_no,
    p_session_id, now() + interval '5 minutes',
    now() + make_interval(mins => v_rules.time_limit_minutes), v_rules.question_count
  from public.enrollments e
  where e.user_id = v_user
    and e.course_id = (select a.course_id from public.assessments a
                       where a.id = p_assessment_id)
    and e.status = 'active' and e.deleted_at is null
  returning id into v_attempt_id;
  if v_attempt_id is null then
    raise exception 'no active enrollment (ERR-ASM-003)';
  end if;
  perform public.append_audit_event('EXAM_ATTEMPT_START', 'assessment', p_assessment_id::text,
    null, null,
    jsonb_build_object('attempt_id', v_attempt_id, 'assessment_id', p_assessment_id,
                       'deadline_at', now() + make_interval(mins => v_rules.time_limit_minutes)),
    null, null, null, null);
  return v_attempt_id;
end;
$fn$;

-- ═══ save_answer() — attempt_answers UPDATE + lease (DD §4.7) ═══
create or replace function public.save_answer(
  p_attempt_id uuid,
  p_question_id uuid,
  p_selected_option_ids uuid[]
) returns void
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_attempt public.assessment_attempts%rowtype;
begin
  if v_user is null then
    raise exception 'unauthenticated (ERR-AUTH-001)';
  end if;
  select * into v_attempt from public.assessment_attempts
  where id = p_attempt_id and user_id = v_user;
  if not found then
    raise exception 'attempt not found (ERR-ASM-004)';
  end if;
  -- TODO(Wave C): business conditions — lease/session ตรง caller (session_id/lease_expires_at),
  -- subset ของ options ใน question_snapshot, seq/option_order คงเดิมของ attempt
  if v_attempt.status <> 'in_progress' then
    raise exception 'attempt not in progress (ERR-ASM-005)';
  end if;
  if now() > v_attempt.expires_at then
    raise exception 'attempt expired (ERR-ASM-006)';
  end if;
  update public.attempt_answers
  set selected_option_ids = p_selected_option_ids, answered_at = now()
  where attempt_id = p_attempt_id and question_id = p_question_id;
  update public.assessment_attempts
  set lease_expires_at = now() + interval '5 minutes'
  where id = p_attempt_id;
end;
$fn$;

-- ═══ submit_attempt() — grading + outbox event (DD §4.7, F14/F15) ═══
create or replace function public.submit_attempt(p_attempt_id uuid) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_attempt public.assessment_attempts%rowtype;
  v_correct int;
  v_score smallint;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'unauthenticated (ERR-AUTH-001)';
  end if;
  select * into v_attempt from public.assessment_attempts
  where id = p_attempt_id and user_id = v_user
  for update; -- idempotent key ของ submit (DD §3.4)
  if not found then
    raise exception 'attempt not found (ERR-ASM-004)';
  end if;
  if v_attempt.submitted_at is not null then
    return jsonb_build_object('attempt_id', v_attempt.id,
                              'status', v_attempt.status,
                              'already_submitted', true);
  end if;
  -- TODO(Wave C): business conditions — ตรวจ lease/session, deadline vs submitted_at,
  -- Grader ตรวจจาก question_snapshot ล้วน (F14); คะแนน/ผ่าน; ออก credit accrual event
  -- ใน TX เดียวกัน (F15: event_outbox ต่อเมื่อผ่าน — snapshot rule_id/ค่ากฎ ณ ตรวจ - F17)
  select count(*) into v_correct
  from public.attempt_answers
  where attempt_id = p_attempt_id and is_correct = true;
  v_score := null; -- TODO(Wave C): grading จาก snapshot
  update public.assessment_attempts
  set status = 'submitted', submitted_at = now(), correct_count = v_correct
  where id = p_attempt_id;
  v_result := jsonb_build_object('attempt_id', p_attempt_id, 'status', 'submitted');
  perform public.append_audit_event('EXAM_SUBMIT', 'assessment_attempt', p_attempt_id::text,
    null, null,
    jsonb_build_object('attempt_id', p_attempt_id, 'user_id', v_user),
    null, null, null, null);
  return v_result;
end;
$fn$;

-- ═══ EXECUTE contract ของ write functions (PG15 default PUBLIC → revoke ก่อน grant) ═══
revoke execute on function public.enroll(uuid) from public, anon;
revoke execute on function public.record_lesson_progress(uuid, uuid, int, int, int, smallint) from public, anon;
revoke execute on function public.record_quiz_attempt(uuid, jsonb) from public, anon;
revoke execute on function public.start_attempt(uuid, text) from public, anon;
revoke execute on function public.save_answer(uuid, uuid, uuid[]) from public, anon;
revoke execute on function public.submit_attempt(uuid) from public, anon;
grant execute on function public.enroll(uuid) to authenticated; -- DD §4.7: grant authenticated
grant execute on function public.record_lesson_progress(uuid, uuid, int, int, int, smallint) to authenticated;
grant execute on function public.record_quiz_attempt(uuid, jsonb) to authenticated;
grant execute on function public.start_attempt(uuid, text) to authenticated;
grant execute on function public.save_answer(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.submit_attempt(uuid) to authenticated;

-- ownership ของ functions ที่เขียนตาราง → app_owner (DD §4.7)
alter function public.enroll(uuid) owner to app_owner;
alter function public.record_lesson_progress(uuid, uuid, int, int, int, smallint) owner to app_owner;
alter function public.record_quiz_attempt(uuid, jsonb) owner to app_owner;
alter function public.start_attempt(uuid, text) owner to app_owner;
alter function public.save_answer(uuid, uuid, uuid[]) owner to app_owner;
alter function public.submit_attempt(uuid) owner to app_owner;
alter function public.set_updated_at() owner to app_owner;
alter function public.validate_option_correctness() owner to app_owner;
alter function public.validate_quiz_option_correctness() owner to app_owner;
alter function public.guard_course_publish() owner to app_owner;
alter function public.guard_assessment_publish() owner to app_owner;
alter function public.my_roles() owner to app_owner;
alter function public.has_any_role(text[]) owner to app_owner;
alter function public.is_staff() owner to app_owner;
alter function public.prevent_audit_mutation() owner to app_owner;
alter function public.prevent_append_only_mutation() owner to app_owner;
-- app_owner ต้องเรียก append_audit_event ภายใน (owner ของ function เอง)
grant execute on function public.append_audit_event(text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  to app_owner;
grant insert, select on public.event_outbox to app_owner;
