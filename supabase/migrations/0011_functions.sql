-- 0011_functions.sql — SECURITY DEFINER write functions (DD §4.7, F2/D12)
-- ผู้เรียนเขียนตารางได้ผาน function เดียวเท่านั้น; ทุกตัวตรวจ auth.uid() + เงื่อนไขธุรกิจ
-- ข้างใน + เขียน audit ใน TX เดียวกัน (AUDIT §1.5, D11-8) + grant EXECUTE ให้ authenticated
-- B-02 fix round (D18): B2/B3/B4 + M1 — เงื่อนไขธุรกิจ implement จริงครบตาม DD §4.7:
--   · grading ทำฝั่ง server ล้วน (quiz_options / question_snapshot — ห้ามรับคะแนนจาก caller)
--   · session_id ของ exam = lease จาก JWT claim `session_id` (D20-B5, DD §3.4 L446); save/submit เทียบ session
--   · eligibility ครบ: role/published/enrollment active/require_course_complete/max_attempts/cooldown
--   · credit accrual = event_outbox ใน TX ของ grading เมื่อผ่าน (F15) + rule snapshot (F6/D13-F6)
-- defaults อ้าง SRS Appendix A (defaults master เดียว): video_complete_pct=80,
--   exam_disconnect_grace_minutes=5 (lease), heartbeat delta cap 900 วินาที/call

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
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  -- B3: สิทธิ์ตาม permission matrix — enroll:create = citizen/lawyer/instructor/super_admin
  -- (RBAC §2.1 L54 — instructor ลงทะเบียนเรียนได้เหมือนผู้เรียนทั่วไป — D19-M3)
  if not public.has_any_role(array['citizen','lawyer','instructor','super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001)';
  end if;
  select * into v_course from public.courses
  where id = p_course_id and deleted_at is null;
  if not found then
    raise exception 'ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ (ERR-CRS-001)';
  end if;
  if v_course.status <> 'published' then
    raise exception 'ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ (ERR-CRS-001)';
  end if;
  if not v_course.is_public
     and not public.has_any_role(array['lawyer']) then
    raise exception 'หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว (ERR-ENR-002)';
  end if;
  -- prerequisite: DD §3.2 courses ไม่มีคอลัมน์ prerequisite ใน v1 — เงื่อนไขนี้ไม่มีผล
  -- จนกว่า DCR จะเพิ่มคอลัมน์ (บันทึกไว้ตรง ๆ ไม่ปลอมเงื่อนไข)
  begin
    insert into public.enrollments (user_id, course_id, source, created_by)
    values (v_user, p_course_id, 'self', null)
    returning id into v_enrollment_id;
  exception when unique_violation then
    raise exception 'คุณลงทะเบียนหลักสูตรนี้แล้ว (ERR-ENR-001)';
  end;
  perform public.append_audit_event_internal('ENROLL_CREATE', 'course', p_course_id::text,
    null, null,
    jsonb_build_object('course_id', p_course_id, 'user_id', v_user),
    null, null, null);
  return v_enrollment_id;
end;
$fn$;

-- ═══ record_lesson_progress() — lesson_progress UPSERT (DD §4.7, SDS §3.3, D11-15/D12-12) ═══
-- B2: ห้ามรับ quiz_score_pct (grading = server ล้วน ผ่าน record_quiz_attempt เท่านั้น)
--     + clamp delta ต่อ call + ตรวจ lesson ∈ course ของ enrollment + enrollment active
--     + ตัดสิน completed_at ตามชนิดบทเรียน (video=watch_pct≥80 / document=attestation /
--       quiz=ผ่าน record_quiz_attempt เท่านั้น) + audit LESSON_COMPLETED ครั้งเดียว
create or replace function public.record_lesson_progress(
  p_enrollment_id uuid,
  p_lesson_id uuid,
  p_video_max_position_sec int default null,
  p_watch_sec_delta int default 0,
  p_dwell_sec_delta int default 0
) returns void
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_course_id uuid;
  v_enr_status public.enrollment_status;
  v_ltype public.lesson_type;
  v_duration int;
  v_crule jsonb;
  v_threshold smallint;
  v_watch_delta int;
  v_dwell_delta int;
  v_max_pos int;
  v_watch_cap int;
  v_watch_pct smallint;
  v_init_pct smallint := 0;
  v_done boolean := false;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  -- B2: เป็นเจ้าของ enrollment + สถานะ active
  select e.course_id, e.status into v_course_id, v_enr_status
  from public.enrollments e
  where e.id = p_enrollment_id and e.user_id = v_user and e.deleted_at is null;
  if not found or v_enr_status <> 'active' then
    raise exception 'ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)';
  end if;
  -- B2: บทเรียนต้องอยู่ในหลักสูตรของ enrollment นี้ (และยังไม่ถูกลบ) + completion_rule (DD §3.3)
  select l.type, l.duration_sec, l.completion_rule into v_ltype, v_duration, v_crule
  from public.lessons l
  join public.course_modules m on m.id = l.module_id
  where l.id = p_lesson_id and l.deleted_at is null and m.course_id = v_course_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)';
  end if;

  -- ── clamp ฝั่ง server สองชั้น (SDS §3.3 — bounded playback intervals, D11-15) ──
  -- (1) ต่อ call ≤ 900 วินาที (heartbeat 15 วินาที/ครั้ง) และ (2) ช่วงที่ยอมรับต้อง
  -- ≤ เวลาที่ผ่านจริงฝั่ง server นับจากการเขียนก่อนหน้า + grace 60 วินาที — "ช่วงที่ยาว
  -- เกิน elapsed ถูกตัดที่เพดาน elapsed" (D19-B4: ป้องกันเร่ง call รวดเพื่อเติมเวลาดู)
  v_watch_delta := least(greatest(coalesce(p_watch_sec_delta, 0), 0), 900);
  v_dwell_delta := least(greatest(coalesce(p_dwell_sec_delta, 0), 0), 900);
  v_max_pos := case when v_ltype = 'video'
                    then least(greatest(coalesce(p_video_max_position_sec, 0), 0),
                               coalesce(v_duration, 0))
                    else 0 end;
  -- เพดานสะสม: ดูซ้ำได้ แต่ไม่เกิน 2 เท่าของความยาว (หรือ 30 นาทีสำหรับคลิปสั้น) / dwell ≤ 8 ชม.
  v_watch_cap := greatest(coalesce(v_duration, 0) * 2, 1800);
  -- heartbeat แรกของบทเรียน: ยอมรับได้ไม่เกินหน้าต่าง grace (60 วินาที) เท่านั้น
  -- (แถวยังไม่มี = ไม่มี elapsed ให้อ้าง — D19-B4) + watch_pct ถูกตั้งจริงตั้งแต่ INSERT (D19-M6)
  if v_ltype = 'video' and v_duration is not null then
    v_init_pct := least(round(least(v_watch_delta, 60) * 100.0 / greatest(v_duration, 1))::int, 100)::smallint;
  end if;

  insert into public.lesson_progress
    (enrollment_id, lesson_id, status, video_max_position_sec, watch_sec_accum, watch_pct, dwell_sec)
  values
    (p_enrollment_id, p_lesson_id, 'in_progress', v_max_pos,
     least(v_watch_delta, 60), v_init_pct, least(v_dwell_delta, 60))
  on conflict (enrollment_id, lesson_id) do update
    -- elapsed-clamp ผูกกับ updated_at ของแถวเดิม (แถวถูกล็อกโดย upsert — กัน TOCTOU
    -- จาก heartbeat ซ้อนสอง TX ที่อ่าน anchor เดียวกัน)
    -- D20-B2: เพดานเวลาจริง (wall-clock) เพิ่มอีกชั้น — total watch/dwell สะสม
    -- ห้ามเกินเวลาที่ผ่านจริงนับแต่เริ่มบท (created_at) + grace 60 วิ: per-call grace
    -- ถูกต่ออายุใหม่ทุก call (updated_at เดินตาม) ทำให้เร่ง call รัว ๆ ~48 ครั้ง
    -- ตุนยอดรวมได้เท่าความยาววิดีโอ — เพดาน created_at ปิดช่องนี้ถาวร
    set video_max_position_sec = least(
          greatest(public.lesson_progress.video_max_position_sec, v_max_pos),
          coalesce(v_duration, 0)),
        watch_sec_accum = least(public.lesson_progress.watch_sec_accum
              + least(v_watch_delta,
                      extract(epoch from (now() - public.lesson_progress.updated_at))::int + 60),
              v_watch_cap,
              extract(epoch from (now() - public.lesson_progress.created_at))::int + 60),
        watch_pct = case when v_ltype = 'video' and v_duration is not null
                         then least(round(
                                (least(public.lesson_progress.watch_sec_accum
                                       + least(v_watch_delta,
                                               extract(epoch from (now() - public.lesson_progress.updated_at))::int + 60),
                                       v_watch_cap,
                                       extract(epoch from (now() - public.lesson_progress.created_at))::int + 60))
                                * 100.0 / greatest(v_duration, 1))::int, 100)::smallint
                         else public.lesson_progress.watch_pct end,
        dwell_sec = least(public.lesson_progress.dwell_sec
              + least(v_dwell_delta,
                      extract(epoch from (now() - public.lesson_progress.updated_at))::int + 60),
              28800,
              extract(epoch from (now() - public.lesson_progress.created_at))::int + 60),
        status = case when public.lesson_progress.status = 'completed'
                      then public.lesson_progress.status
                      else 'in_progress'::public.progress_status end,
        updated_at = now();

  -- ── ตัดสิน completion (D11-15: server เป็นผู้ตัดสิน — client แจ้ง completed ไม่ได้) ──
  -- video: สะสม bounded intervals ≥ เกณฑ์ — default video_complete_pct=80 (SRS Appendix A)
  --        แต่ lesson.completion_rule override ได้ เช่น {"watch_pct":90} (DD §3.3 — D19-M6)
  -- document: attestation ของผู้เรียนที่ลงทะเบียนแล้ว (D12-12; dwell = telemetry เท่านั้น D14-F9)
  -- quiz: ไม่ตัดสินที่นี่ — ผ่าน record_quiz_attempt เมื่อผ่านเกณฑ์เท่านั้น
  v_threshold := 80;
  if v_crule is not null and jsonb_typeof(v_crule -> 'watch_pct') = 'number' then
    begin
      v_threshold := greatest(least((v_crule ->> 'watch_pct')::numeric::int, 100), 1)::smallint;
    exception when others then
      v_threshold := 80; -- ค่าผิดรูปแบบ → ใช้ default (fail-safe: การเรียนไม่สะดุด)
    end;
  end if;
  if v_ltype = 'video' then
    select least(round(watch_sec_accum * 100.0 / greatest(coalesce(v_duration, 1), 1))::int, 100)
      into v_watch_pct
    from public.lesson_progress
    where enrollment_id = p_enrollment_id and lesson_id = p_lesson_id;
    v_done := coalesce(v_watch_pct, 0) >= v_threshold;
  elsif v_ltype = 'document' then
    v_done := true;
  end if;

  if v_done then
    update public.lesson_progress
    set status = 'completed', completed_at = now(), updated_at = now()
    where enrollment_id = p_enrollment_id and lesson_id = p_lesson_id
      and status <> 'completed';
    if found then
      perform public.append_audit_event_internal('LESSON_COMPLETED', 'lesson', p_lesson_id::text,
        null, null,
        jsonb_build_object('lesson_id', p_lesson_id, 'user_id', v_user),
        null, null, null);
    end if;
  end if;
end;
$fn$;

-- ═══ record_quiz_attempt() — quiz_attempts INSERT + grading ฝั่ง server ล้วน (DD §4.7) ═══
-- B3: ตรวจ enrollment active ของหลักสูตรที่ quiz สังกัด + M1: ตรวจคะแนนจาก quiz_options
--     จริง (exact-match ของชุดตัวเลือกที่ถูก) — answers_snapshot = คำตอบที่ผ่านการตรวจแล้ว
create or replace function public.record_quiz_attempt(
  p_quiz_id uuid,
  p_answers jsonb -- [{question_id, selected_option_ids:[uuid]}]
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_quiz public.lesson_quizzes%rowtype;
  v_course_id uuid;
  v_enrollment_id uuid;
  v_lesson_id uuid;
  v_attempt_no int;
  v_prior int;
  v_total int := 0;
  v_earned int := 0;
  v_score smallint;
  v_passed boolean;
  v_attempt_id uuid;
  v_newly_completed uuid[];
  v_l uuid;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  select * into v_quiz from public.lesson_quizzes where id = p_quiz_id;
  if not found or v_quiz.status <> 'active' then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)';
  end if;
  -- B3: quiz ต้องถูกอ้างโดยบทเรียนในหลักสูตรที่ผู้เรียนมี enrollment active
  select m.course_id, e.id, l.id into v_course_id, v_enrollment_id, v_lesson_id
  from public.lessons l
  join public.course_modules m on m.id = l.module_id
  join public.enrollments e on e.course_id = m.course_id
  where l.quiz_id = p_quiz_id and l.deleted_at is null and l.type = 'quiz'
    and e.user_id = v_user and e.status = 'active' and e.deleted_at is null
  limit 1;
  if not found then
    raise exception 'ต้องลงทะเบียนหลักสูตรก่อนเรียน (ERR-LRN-001)';
  end if;

  -- ── ตรวจรูปแบบคำตอบ (fail-closed → ERR-VAL-001) ──
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง (ERR-VAL-001)';
  end if;
  begin
    if exists (
      select 1 from jsonb_array_elements(p_answers) e
      where jsonb_typeof(e) <> 'object'
         or not (e ? 'question_id')
         or (e ? 'selected_option_ids' and jsonb_typeof(e->'selected_option_ids') <> 'array')
         or (e->>'question_id')::uuid is null
         or exists (select 1 from jsonb_array_elements_text(
                      coalesce(e->'selected_option_ids', '[]'::jsonb)) s
                    where s::uuid is null)
    ) then
      raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง (ERR-VAL-001)';
    end if;
  exception when others then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง (ERR-VAL-001)';
  end;
  -- ข้อซ้ำในชุดคำตอบ
  if (select count(*) from jsonb_to_recordset(p_answers) a(question_id uuid, selected_option_ids jsonb))
     <> (select count(distinct question_id) from jsonb_to_recordset(p_answers) a(question_id uuid, selected_option_ids jsonb))
  then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: ข้อซ้ำ (ERR-VAL-001)';
  end if;
  -- ข้อต้องสังกัด quiz นี้และยัง active
  if exists (
    select 1 from jsonb_to_recordset(p_answers) a(question_id uuid, selected_option_ids jsonb)
    where not exists (select 1 from public.quiz_questions qq
                      where qq.id = a.question_id and qq.quiz_id = p_quiz_id and qq.is_active))
  then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: ข้อไม่อยู่ใน quiz (ERR-VAL-001)';
  end if;
  -- ตัวเลือกต้องสังกัดข้อนั้น
  if exists (
    select 1
    from jsonb_to_recordset(p_answers) a(question_id uuid, selected_option_ids jsonb)
    cross join lateral jsonb_array_elements_text(coalesce(a.selected_option_ids, '[]'::jsonb)) s(oid)
    where not exists (select 1 from public.quiz_options qo
                      where qo.id = s.oid::uuid and qo.question_id = a.question_id))
  then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: ตัวเลือกไม่ถูกต้อง (ERR-VAL-001)';
  end if;

  -- max_attempts (NULL = ไม่จำกัด — DD §3.3)
  if v_quiz.max_attempts is not null then
    select count(*) into v_prior from public.quiz_attempts
    where quiz_id = p_quiz_id and user_id = v_user;
    if v_prior >= v_quiz.max_attempts then
      raise exception 'คุณใช้จำนวนครั้งทำ quiz ครบตามกติกาแล้ว (ERR-ASM-001)';
    end if;
  end if;
  select coalesce(max(attempt_no), 0) + 1 into v_attempt_no
  from public.quiz_attempts where quiz_id = p_quiz_id and user_id = v_user;

  -- ── M1: grading ฝั่ง server ล้วน — exact match กับชุดตัวเลือกที่ถูกของแต่ละข้อ ──
  select coalesce(sum(qq.points), 0) into v_total
  from public.quiz_questions qq where qq.quiz_id = p_quiz_id and qq.is_active;

  select coalesce(sum(g.pts), 0) into v_earned
  from (
    select a.question_id,
           (select qq.points from public.quiz_questions qq where qq.id = a.question_id) as pts,
           ((select coalesce(array_agg(qo.id::text order by qo.id::text), '{}'::text[])
             from public.quiz_options qo
             where qo.question_id = a.question_id and qo.is_correct)
            = (select coalesce(array_agg(s order by s), '{}'::text[])
               from jsonb_array_elements_text(a.selected_option_ids) s)) as ok
    from jsonb_to_recordset(p_answers) a(question_id uuid, selected_option_ids jsonb)
  ) g
  where g.ok;

  v_score := least(round(v_earned * 100.0 / greatest(v_total, 1))::int, 100)::smallint;
  v_passed := v_score >= v_quiz.pass_pct;

  insert into public.quiz_attempts
    (quiz_id, user_id, attempt_no, submitted_at, score_pct, passed, answers_snapshot)
  values
    (p_quiz_id, v_user, v_attempt_no, now(), v_score, v_passed,
     coalesce((select jsonb_agg(jsonb_build_object('question_id', a.question_id,
                                                   'selected_option_ids', a.selected_option_ids)
                                order by a.question_id::text)
               from jsonb_to_recordset(p_answers) a(question_id uuid, selected_option_ids jsonb)),
              '[]'::jsonb))
  returning id into v_attempt_id;

  -- ผ่าน → จบบทเรียนชนิด quiz ที่อ้าง quiz นี้ (เก็บคะแนนสูงสุด — progress_pass_score_policy=highest)
  if v_passed then
    select coalesce(array_agg(l.id), '{}'::uuid[]) into v_newly_completed
    from public.lessons l
    join public.course_modules m on m.id = l.module_id
    where l.quiz_id = p_quiz_id and l.type = 'quiz' and l.deleted_at is null
      and m.course_id = v_course_id
      and not exists (select 1 from public.lesson_progress lp
                      where lp.enrollment_id = v_enrollment_id and lp.lesson_id = l.id
                        and lp.status = 'completed');

    insert into public.lesson_progress
      (enrollment_id, lesson_id, status, quiz_score_pct, completed_at)
    select v_enrollment_id, l.id, 'completed', v_score, now()
    from public.lessons l
    join public.course_modules m on m.id = l.module_id
    where l.quiz_id = p_quiz_id and l.type = 'quiz' and l.deleted_at is null
      and m.course_id = v_course_id
    on conflict (enrollment_id, lesson_id) do update
      set quiz_score_pct = greatest(coalesce(public.lesson_progress.quiz_score_pct, 0),
                                    excluded.quiz_score_pct),
          status = 'completed',
          completed_at = coalesce(public.lesson_progress.completed_at, now()),
          updated_at = now();

    foreach v_l in array v_newly_completed loop
      perform public.append_audit_event_internal('LESSON_COMPLETED', 'lesson', v_l::text,
        null, null,
        jsonb_build_object('lesson_id', v_l, 'user_id', v_user),
        null, null, null);
    end loop;
  end if;

  perform public.append_audit_event_internal('QUIZ_SUBMIT', 'lesson_quiz', p_quiz_id::text,
    null, null,
    jsonb_build_object('lesson_id', v_lesson_id, 'user_id', v_user,
                       'score_pct', v_score, 'attempt_no', v_attempt_no),
    null, null, null);
  return jsonb_build_object('attempt_id', v_attempt_id, 'score_pct', v_score, 'passed', v_passed);
end;
$fn$;

-- ── D20-B5: session claim จาก JWT ปัจจุบัน (DD §3.4 L446 — session_id ของ attempt
-- = "lease จาก JWT claim `session_id`") — start/takeover ผูก session จาก claim ของ
-- อุปกรณ์ที่เรียก และ save/submit ตรวจ p_session = claim ปัจจุบันด้วย → อุปกรณ์ที่สอง
-- ของบัญชีเดียวกันอ่าน session_id จากแถวตัวเองแล้วอ้างเป็นเจ้าของ attempt ไม่ได้
-- supabase จริง: claim แยก GUC `request.jwt.claim.session_id`; vanilla shim 0001:
-- อ่านจาก jsonb `request.jwt.claims` (contract เดียวกัน)
create or replace function public.auth_session_claim() returns text
language plpgsql stable
set search_path = public
as $fn$
declare
  v text;
begin
  v := nullif(current_setting('request.jwt.claim.session_id', true), '');
  if v is not null then
    return v;
  end if;
  return nullif(coalesce(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'session_id', '');
end;
$fn$;
alter function public.auth_session_claim() owner to app_owner;
revoke execute on function public.auth_session_claim() from public, anon;
grant execute on function public.auth_session_claim() to authenticated, app_owner, service_role;

-- ═══ start_attempt() — assessment_attempts + attempt_answers INSERT (DD §4.7) ═══
-- B3: published + enrollment active + require_course_complete + max_attempts + cooldown
-- B4/D20-B5: session_id = lease จาก JWT claim `session_id` (DD §3.4 L446) + lease ผูก
--     grace; ASM-011: takeover เมื่อ lease หมด (session ใหม่จาก claim อุปกรณ์ใหม่ + audit)
-- M1: สุ่มข้อจาก pool (selection.bank_ids — เว้นว่าง = bank ของหลักสูตร) + เขียน
--     question_snapshot ต่อข้อ (F13/F14: ข้อ/ตัวเลือก/เฉลย/points/version)
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
    select q.id as qid, q.question_text, q.points, q.version,
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
                            'points', ord.points)
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

-- ═══ save_answer() — attempt_answers UPDATE + lease (DD §4.7) ═══
-- B4: ต้องส่ง session_id มาเทียบ (ASM-011 — คำขอจาก session อื่นถูกปฏิเสธ) + ตรวจ deadline
--     + selected_option_ids ⊆ ตัวเลือกใน question_snapshot ของข้อนั้น (dedup ฝั่ง server)
create or replace function public.save_answer(
  p_attempt_id uuid,
  p_question_id uuid,
  p_selected_option_ids uuid[],
  p_session_id text
) returns void
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_attempt public.assessment_attempts%rowtype;
  v_snap jsonb;
  v_sel uuid[];
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  select * into v_attempt from public.assessment_attempts
  where id = p_attempt_id and user_id = v_user
  for update; -- D19-B3: ล็อกแถวก่อนตรวจ — submit/takeover ที่แซงระหว่างนี้จะติด row lock
             -- แล้วเงื่อนไข status/session ด้านล่างจับได้หลังแถวถูกปล่อย (DD §4.7)
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)';
  end if;
  -- B4 + D20-B5: session binding สองชั้น — p_session ต้องตรง session_id ของแถว
  -- (ตาม B4 เดิม) และตรง JWT session claim ของผู้เรียกด้วย (DD §3.4 L446) —
  -- ปิดช่องอุปกรณ์ที่สองของบัญชีเดียวกันอ่าน session_id จากแถวตัวเองแล้ว
  -- อ้างเป็น session เจ้าของ attempt
  if p_session_id is null
     or p_session_id <> v_attempt.session_id
     or p_session_id is distinct from public.auth_session_claim() then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ERR-RBAC-001|session_mismatch)';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว (ERR-ASM-005)';
  end if;
  if now() > v_attempt.expires_at then
    raise exception 'หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม (ERR-ASM-004)';
  end if;

  select question_snapshot into v_snap from public.attempt_answers
  where attempt_id = p_attempt_id and question_id = p_question_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)';
  end if;

  if p_selected_option_ids is null or cardinality(p_selected_option_ids) = 0 then
    v_sel := null; -- เคลียร์คำตอบ
  else
    select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_sel
    from unnest(p_selected_option_ids) as x;
    if exists (
      select 1 from unnest(v_sel) s(x)
      where not exists (select 1 from jsonb_array_elements(v_snap->'options') o
                        where (o->>'id')::uuid = s.x))
    then
      raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: ตัวเลือกไม่อยู่ในข้อนี้ (ERR-VAL-001)';
    end if;
  end if;

  update public.attempt_answers
  set selected_option_ids = v_sel,
      answered_at = case when v_sel is null then null else now() end
  where attempt_id = p_attempt_id and question_id = p_question_id;

  -- ต่ออายุ lease ทุกคำขอที่สำเร็จ (grace = exam_disconnect_grace_minutes)
  update public.assessment_attempts
  set lease_expires_at = now() + interval '5 minutes'
  where id = p_attempt_id;
end;
$fn$;

-- ═══ submit_attempt() — grading จาก snapshot ล้วน + outbox ใน TX เดียว (DD §4.7, F14/F15) ═══
-- B4: session binding + idempotent + in_progress + deadline(grace)
-- M1: Grader ตรวจจาก question_snapshot ล้วน (exact-match ชุด is_correct ต่อข้อ) →
--     score/passed ตาม rules ของ attempt; ผ่าน → event_outbox 'credit.accrual' พร้อม
--     rule snapshot (F6/D13-F6: worker ไม่ lookup credit_rules ซ้ำ)
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
  v_rules public.assessment_rules%rowtype;
  v_earned int := 0;
  v_total int := 0;
  v_correct int := 0;
  v_score smallint;
  v_passed boolean;
  v_rule public.credit_rules%rowtype;
  v_answered int;
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
    return jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status,
                              'score_pct', v_attempt.score_pct, 'passed', v_attempt.passed,
                              'already_submitted', true);
  end if;
  -- B4 + D20-B5: session binding สองชั้น (แถว + JWT claim — เหมือน save_answer)
  if p_session_id is null
     or p_session_id <> v_attempt.session_id
     or p_session_id is distinct from public.auth_session_claim() then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ERR-RBAC-001|session_mismatch)';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว (ERR-ASM-005)';
  end if;
  -- deadline + grace: เกิน expires_at ได้ไม่เกิน grace (auto-submit job = Wave C)
  if now() > v_attempt.expires_at + interval '5 minutes' then
    raise exception 'หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม (ERR-ASM-004)';
  end if;
  v_late := now() > v_attempt.expires_at;

  select * into v_rules from public.assessment_rules where id = v_attempt.rules_id;

  -- ── M1: grading จาก snapshot ล้วน (F14) ──
  with g as (
    select aa.id,
           (aa.question_snapshot->>'points')::smallint as pts,
           coalesce((select jsonb_agg(o->>'id')
                     from jsonb_array_elements(aa.question_snapshot->'options') o
                     where (o->>'is_correct')::boolean), '[]'::jsonb) as correct_ids,
           coalesce(to_jsonb(aa.selected_option_ids), '[]'::jsonb) as sel_ids
    from public.attempt_answers aa
    where aa.attempt_id = p_attempt_id
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

  select coalesce(sum(points_earned), 0),
         coalesce(sum((question_snapshot->>'points')::smallint), 0),
         count(*) filter (where is_correct),
         count(*) filter (where selected_option_ids is not null)
  into v_earned, v_total, v_correct, v_answered
  from public.attempt_answers
  where attempt_id = p_attempt_id;

  v_score := least(round(v_earned * 100.0 / greatest(v_total, 1))::int, 100)::smallint;
  v_passed := v_score >= v_rules.pass_pct;

  update public.assessment_attempts
  set status = case when v_passed then 'passed' else 'failed' end::public.attempt_status,
      submitted_at = now(), score_pct = v_score, passed = v_passed, correct_count = v_correct
  where id = p_attempt_id;

  -- ── M1/F15: ผ่าน → credit accrual event ใน TX เดียวกับ grading ──
  -- เลือกกฎครั้งเดียว ณ วันผ่าน: rule เฉพาะหลักสูตรก่อน generic แล้วตาม priority (F6/D13-F6)
  if v_passed then
    select * into v_rule from public.credit_rules
    where status = 'active'
      and effective_from <= now()
      and (effective_to is null or effective_to > now())
      and (course_id = (select a.course_id from public.assessments a
                        where a.id = v_attempt.assessment_id)
           or course_id is null)
    order by (course_id is null), priority, effective_from desc
    limit 1;
    if found then
      insert into public.event_outbox (topic, payload)
      values ('credit.accrual',
        jsonb_build_object(
          'source_type', 'assessment_attempt',
          'source_id', p_attempt_id,
          'user_id', v_user,
          'enrollment_id', v_attempt.enrollment_id,
          'passed_at', now(),
          'rule', jsonb_build_object(       -- snapshot — worker ห้าม lookup ซ้ำ (D13-F6)
            'rule_id', v_rule.id, 'code', v_rule.code,
            'credits', v_rule.credits, 'credit_type', v_rule.credit_type,
            'renewal_cycle', v_rule.renewal_cycle, 'valid_days', v_rule.valid_days,
            'carry_over', v_rule.carry_over)));
    end if;
    -- ไม่มีกฎที่ active = ไม่คิด credit (ไม่ใช่ error — บางหลักสูตรไม่ให้ credit)
  end if;

  perform public.append_audit_event_internal('EXAM_SUBMIT', 'assessment_attempt',
    p_attempt_id::text, null, null,
    jsonb_build_object('attempt_id', p_attempt_id, 'answered_count', v_answered,
                       'late', v_late, 'idempotency_key', p_attempt_id::text),
    null, null, null);
  return jsonb_build_object('attempt_id', p_attempt_id,
                            'status', case when v_passed then 'passed' else 'failed' end,
                            'score_pct', v_score, 'passed', v_passed,
                            'correct_count', v_correct, 'question_count', v_total);
end;
$fn$;

-- ═══ EXECUTE contract ของ write functions (PG15 default PUBLIC → revoke ก่อน grant) ═══
revoke execute on function public.enroll(uuid) from public, anon;
revoke execute on function public.record_lesson_progress(uuid, uuid, int, int, int) from public, anon;
revoke execute on function public.record_quiz_attempt(uuid, jsonb) from public, anon;
revoke execute on function public.start_attempt(uuid) from public, anon;
revoke execute on function public.save_answer(uuid, uuid, uuid[], text) from public, anon;
revoke execute on function public.submit_attempt(uuid, text) from public, anon;
grant execute on function public.enroll(uuid) to authenticated; -- DD §4.7: grant authenticated
grant execute on function public.record_lesson_progress(uuid, uuid, int, int, int) to authenticated;
grant execute on function public.record_quiz_attempt(uuid, jsonb) to authenticated;
grant execute on function public.start_attempt(uuid) to authenticated;
grant execute on function public.save_answer(uuid, uuid, uuid[], text) to authenticated;
grant execute on function public.submit_attempt(uuid, text) to authenticated;

-- ownership ของ functions ที่เขียนตาราง → app_owner (DD §4.7)
alter function public.enroll(uuid) owner to app_owner;
alter function public.record_lesson_progress(uuid, uuid, int, int, int) owner to app_owner;
alter function public.record_quiz_attempt(uuid, jsonb) owner to app_owner;
alter function public.start_attempt(uuid) owner to app_owner;
alter function public.save_answer(uuid, uuid, uuid[], text) owner to app_owner;
alter function public.submit_attempt(uuid, text) owner to app_owner;
alter function public.set_updated_at() owner to app_owner;
alter function public.validate_option_correctness() owner to app_owner;
alter function public.validate_quiz_option_correctness() owner to app_owner;
alter function public.guard_course_publish() owner to app_owner;
alter function public.guard_assessment_publish() owner to app_owner;
-- D19-M1: trigger guards ที่เป็น SECURITY DEFINER ต้องเป็นของ app_owner ให้ครบ
alter function public.validate_question_type_change() owner to app_owner;
alter function public.validate_quiz_question_type_change() owner to app_owner;
alter function public.guard_question_activation() owner to app_owner;
alter function public.guard_rule_semantics() owner to app_owner;
alter function public.guard_course_soft_delete() owner to app_owner;
alter function public.my_roles() owner to app_owner;
alter function public.has_any_role(text[]) owner to app_owner;
alter function public.is_staff() owner to app_owner;
alter function public.prevent_audit_mutation() owner to app_owner;
alter function public.prevent_append_only_mutation() owner to app_owner;
-- app_owner เรียก append_audit_event_internal (EXECUTE contract อยู่ที่ 0008) +
-- เขียน event_outbox ได้ (privilege/policy อยู่ที่ 0010)
grant insert, select on public.event_outbox to app_owner;

-- ── prerequisites ของ SECURITY DEFINER context (app_owner) ──
-- 0001 grant usage บน schema auth ให้ anon/authenticated/service_role เท่านั้น และ
-- 0002 revoke EXECUTE ของ helpers จาก PUBLIC — app_owner ที่รัน business functions
-- เรียก auth.uid()/my_roles()/has_any_role() เองไม่ได้ ต้อง grant ตรง ๆ (DD §4.7)
grant usage on schema auth to app_owner;
grant execute on function auth.uid() to app_owner;
grant execute on function public.my_roles() to app_owner;
grant execute on function public.has_any_role(text[]) to app_owner;
grant execute on function public.is_staff() to app_owner;
