-- ═══ 0049 — Wave G P3 (D81 · แผน r5 gate APPROVED · D83-D87/D88) [#93] ═══
-- ASM-012 ครึ่งหลังของ AC: เปิดเฉลยเมื่อ "ผ่านแล้ว" ⇔ บล็อกผู้ผ่านสอบซ้ำ —
-- สองการเปลี่ยนขึ้น migration เดียว ห้ามแยก deploy (invariant คู่พลัง D84):
--   เฉลยเปิด ⟺ ไม่มี attempt in_progress ของ (user, assessment)
--              ∧ current exam_review_mode ≠ 'never'
--              ∧ (submitted-count(D20-B1) ≥ current max_attempts ∨ passed)
--   "current" = current effective rules — สูตรเดียวกับ start_attempt 0048:58-62
--   (cr null = ปิดแม้เคยผ่าน — fail-closed)
-- ฝั่งสร้างใหม่: B3.5 หลัง max_attempts ก่อน cooldown → ERR-ASM-007 (422 ที่ BFF)
-- โครงสร้าง:
-- (1) D83: enum exam_review_mode 2 ค่า + คอลัมน์บน assessment_rules + grant
-- (2) D84.3: recreate learner/instructor_attempt_view (lateral current rules
--     + NOT EXISTS in_progress + passed-OR) + ACL re-assert
-- (3) D84.1: start_attempt full-copy 0048 + แทรก B3.5 จุดเดียว
--     (diff ต่อ 0048 = header + B3.5 — pool recheck :219 ครบ)
-- (4) D87.1: RPC admin_add_assessment_rules (guards แบบแผน 0047 · version =
--     max+1 ใน INSERT...SELECT เดียว · unique_violation retry ×3)
-- (5) D87.5: audit trigger ASSESSMENT_CONFIG_CHANGE ทุก INSERT ของ
--     assessment_rules — ปิด 3 ทาง: RPC/endpoint ใหม่ · POST v1 เดิม ·
--     insert ตรงผ่าน ar_write

-- ─── (1) D83: enum + คอลัมน์ + grant ───
create type public.exam_review_mode as enum ('after_final_attempt', 'never');

alter table public.assessment_rules
  add column exam_review_mode public.exam_review_mode
    not null default 'after_final_attempt';
-- default ตาม SRS Appendix A (F2) · NOT NULL + default = แถวเดิมได้ baseline
-- after_final_attempt ทันที (PG ≥11 catalog-only ไม่ rewrite)

-- grant ตามแบบแผน pass_pct/0019:195 — จำเป็นสำหรับ embed ทาง admin GET
-- (view security_invoker=false อ่านในนามเจ้าของ view — ไม่ต้องรอ grant นี้: 0009:22-23)
grant select (exam_review_mode) on public.assessment_rules to authenticated;

-- ─── (2) D84.3: recreate projection views ด้วย current-rules gating ───
-- คอลัมน์เฉลย 4 ตัวเปิดเมื่อ "จบโอกาสสอบ หรือผ่านแล้ว" ตามกติกา **ปัจจุบัน**:
-- · lateral cr = current effective rules ของ assessment (สูตรเดียวกับ
--   start_attempt 0048:58-62) — ไม่ใช่ rules ของ attempt เอง (at.rules_id เป็น
--   snapshot ของครั้งนั้น F4 — skew ที่ gate แผน r1-B4 จับ)
-- · cr null (ไม่มีกติกามีผล ณ ตอนนั้น) = เงื่อนไข false = ปิด แม้เคยผ่าน
-- · NOT EXISTS(in_progress): มี attempt ค้าง = ปิดทุกกรณี — ปิด counterexample
--   "ลด max ขณะมี attempt ค้าง" (gate แผน r2): submitted-count ≥ max ใหม่แล้ว
--   ก็ต้องรอครั้งค้างจบก่อน (save_answer/takeover ทำต่อได้ 0011:711 · 0048:87-116)
-- · passed-OR: ผ่าน (non-voided) ครั้งใด = เปิด — คู่กับ B3.5 ที่บล็อกผู้ผ่าน
--   สอบซ้ำ ใน migration เดียวกัน
-- · cr.exam_review_mode = 'never' = ปิดเสมอ
-- NB ของ 0009:17-23 ครบตามที่สัญญา: "เมื่อเพิ่มคอลัมน์ (DCR) เงื่อนไขต้องขยาย
-- ตามโหมดนั้น ๆ" — แถวเดิม default after_final_attempt = พฤติกรรมเดิม + ผ่านแล้ว
create or replace view public.learner_attempt_view
  with (security_invoker = false) as
select
  at.id as attempt_id,
  at.user_id,
  at.assessment_id,
  at.attempt_no,
  at.status,
  at.started_at,
  at.expires_at,
  at.submitted_at,
  at.score_pct,
  at.passed,
  aa.question_id,
  aa.seq,
  aa.option_order,
  aa.selected_option_ids,
  aa.answered_at,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then aa.is_correct end as is_correct,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then aa.points_earned end as points_earned,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then aa.question_snapshot end as question_snapshot,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then q.explanation end as explanation
  from public.assessment_attempts at
  join public.attempt_answers aa on aa.attempt_id = at.id
  left join public.questions q on q.id = aa.question_id
  left join lateral (
    select ar.max_attempts, ar.exam_review_mode
    from public.assessment_rules ar
    where ar.assessment_id = at.assessment_id and ar.effective_from <= now()
    order by ar.effective_from desc, ar.version desc
    limit 1
  ) cr on true
  where at.user_id = auth.uid();

-- instructor mirror: เงื่อนไขเฉลยเดียวกันเป๊ะ + predicate บทบาท/เจ้าของคงเดิม
-- (0009:134-135 — RBAC §2.2 attempt:view O†)
create or replace view public.instructor_attempt_view
  with (security_invoker = false) as
select
  at.id as attempt_id,
  at.user_id,
  at.assessment_id,
  at.attempt_no,
  at.status,
  at.score_pct,
  at.passed,
  at.submitted_at,
  aa.question_id,
  aa.seq,
  aa.selected_option_ids,
  aa.answered_at,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then aa.is_correct end as is_correct,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then aa.points_earned end as points_earned,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then aa.question_snapshot end as question_snapshot,
  case when at.submitted_at is not null
        and cr.exam_review_mode <> 'never'
        and not exists (select 1 from public.assessment_attempts atp
                        where atp.assessment_id = at.assessment_id
                          and atp.user_id = at.user_id
                          and atp.status = 'in_progress')
        and ((select count(*) from public.assessment_attempts at2
              where at2.assessment_id = at.assessment_id
                and at2.user_id = at.user_id and at2.status <> 'voided'
                and at2.submitted_at is not null) -- D20-B1
             >= cr.max_attempts
             or exists (select 1 from public.assessment_attempts atp2
                        where atp2.assessment_id = at.assessment_id
                          and atp2.user_id = at.user_id
                          and atp2.status <> 'voided'
                          and atp2.passed))
       then q.explanation end as explanation
  from public.assessment_attempts at
  join public.enrollments e on e.id = at.enrollment_id
  join public.courses c on c.id = e.course_id
  join public.attempt_answers aa on aa.attempt_id = at.id
  left join public.questions q on q.id = aa.question_id
  left join lateral (
    select ar.max_attempts, ar.exam_review_mode
    from public.assessment_rules ar
    where ar.assessment_id = at.assessment_id and ar.effective_from <= now()
    order by ar.effective_from desc, ar.version desc
    limit 1
  ) cr on true
  where public.has_any_role(array['instructor'])
    and c.created_by = auth.uid();

-- ACL re-assert ตามแบบแผน 0009 §ACL / 0012 §6 / 0021:50-53 (CREATE OR REPLACE
-- คง ACL เดิมตาม spec แต่ประกาศซ้ำให้ migration สมบูรณ์ในตัว — อ่านรูปเดียวกัน)
revoke all on public.learner_attempt_view from public, anon, authenticated, service_role;
revoke all on public.instructor_attempt_view from public, anon, authenticated, service_role;
grant select on public.learner_attempt_view to authenticated;
grant select on public.instructor_attempt_view to authenticated;

-- ─── (3) D84.1: start_attempt full-copy 0048 + B3.5 จุดเดียว ───
-- โครงสร้าง: copy start_attempt ทั้งฟังก์ชันจาก 0048 (แบบแผน 0019/0020/0022/0048
-- ที่แทนฟังก์ชันด้วยสำเนาเต็ม) แทรก B3.5 หลัง B3 max_attempts ก่อน cooldown —
-- guards ทุกตัวอื่น + pool recheck (:219) คงเดิมทุกไบต์
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
  -- B3.5 (0049 · D84 · ASM-012 ครึ่งหลังของ AC): ผ่านแล้ว = สอบซ้ำไม่ได้ — คู่กับ
  -- view ที่เปิดเฉลยเมื่อผ่าน (invariant คู่พลัง ห้ามมีสถานะ "เฉลยเปิด + สอบต่อได้")
  -- · voided ไม่นับเป็นผ่าน · วางก่อน cooldown: ผ่าน+เหลือครั้ง+ใน cooldown →
  --   ASM-007 (การห้ามสอบซ้ำของผู้ผ่านเป็นการถาวร ไม่ใช่เรื่องระยะห่างครั้ง)
  if exists (select 1 from public.assessment_attempts atp
             where atp.assessment_id = p_assessment_id and atp.user_id = v_user
               and atp.status <> 'voided' and atp.passed) then
    raise exception 'ผ่านการสอบนี้แล้ว จึงสอบซ้ำไม่ได้ — ดูผลสอบได้ที่หน้าผลสอบ (ERR-ASM-007)';
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
    -- 0048 (D77 หน้าต่าง A): นับ pool กับหยิบจริงเป็นคนละ statement — retire ที่
    -- commit แทรกกลางคันทำให้หยิบได้น้อยกว่าที่นับ (Read Committed อ่านใหม่ทุก
    -- statement) · re-check หลัง selection ตามแบบแผน mix branch ด้านบน —
    -- หยิบไม่ครบ = คลังข้อไม่พอ ไม่สร้าง attempt สั้น
    if cardinality(v_qids) < v_rules.question_count then
      raise exception 'ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว: คลังข้อไม่พอ (ERR-ASM-003)';
    end if;
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

-- ─── (4) D87.1: RPC admin_add_assessment_rules ───
-- แก้กติกา = เพิ่ม rules version ใหม่ (UPDATE semantic โดน guard_rule_semantics
-- 0010:721-749 ปิด) · ลอกโครง 0047 admin_set_question_status: guards
-- AUTH-001 → aal2 AUTH-004 → RBAC-001 → VAL-001 (errcode ตามแบบแผน) + NF ไม่มี
-- errcode (P0001 default — D80(4)) · version = coalesce(max,0)+1 ใน
-- INSERT...SELECT เดียว · ชน uq_assessment_rules_version จากการแข่งขัน =
-- unique_violation → retry 3 ครั้ง (subtransaction ต่อรอบ) · หมด → ERR-SYS-002
-- · audit ยิงโดย trigger ข้อ (5) ภายใน INSERT นี้เอง (actor = auth.uid())
create or replace function public.admin_add_assessment_rules(
  p_assessment_id uuid,
  p_time_limit_minutes int,
  p_question_count int,
  p_pass_pct int,
  p_max_attempts int,
  p_attempt_cooldown_minutes int,
  p_shuffle_questions boolean,
  p_shuffle_options boolean,
  p_require_course_complete boolean,
  p_proctoring_mode public.proctoring_mode,
  p_selection jsonb default null,
  p_effective_from timestamptz default null,
  p_exam_review_mode public.exam_review_mode default 'after_final_attempt'
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_row public.assessment_rules%rowtype;
  v_try int;
begin
  if v_actor is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|auth_required)'
      using errcode = '42501';
  end if;
  -- aal2 ตามแบบแผน staff guard 0032:226/0047:38 — defense in depth คู่ชั้น BFF
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- ar_write role-set เท่านั้น (0010:703-704) — instructor ผ่าน BFF โดน pre-check
  -- ก่อนถึงที่นี่อยู่แล้ว (route :203-211) · ชั้นนี้ปิดทางเรียก RPC ตรง
  if not public.has_any_role(array['staff:exam','super_admin']) then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|rules_write_forbidden)'
      using errcode = '42501';
  end if;
  -- ค่ากติกาต้องผ่านข้อกำหนดคอลัมน์จริง (0005:70-74) — RPC ตรวจเองเพราะ
  -- การเรียกตรงผ่าน PostgREST ไม่ผ่าน zod ของ BFF
  if p_time_limit_minutes is null or p_time_limit_minutes < 5 or p_time_limit_minutes > 480
     or p_question_count is null or p_question_count < 1
     or p_pass_pct is null or p_pass_pct < 1 or p_pass_pct > 100
     or p_max_attempts is null or p_max_attempts < 1
     or p_attempt_cooldown_minutes is null or p_attempt_cooldown_minutes < 0
     or p_shuffle_questions is null or p_shuffle_options is null
     or p_require_course_complete is null
     or p_proctoring_mode is null or p_exam_review_mode is null then
    raise exception 'ข้อมูลที่ส่งมาไม่ถูกต้อง: ค่ากติกาไม่ผ่านข้อกำหนด (ERR-VAL-001|rules_values)'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.assessments a
                 where a.id = p_assessment_id and a.deleted_at is null) then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|assessment_not_found)';
  end if;

  -- version ถัดไปจากแถวจริงใน INSERT เดียว — สอง TX คำนวณพร้อมกันได้ค่าเดียวกัน
  -- ชน uq (assessment_id, version) → รอบใหม่เห็น max ใหม่ (probe พิสูจน์ด้วย
  -- pg_locks: B รอ transactionid ของ A จริงก่อน A commit — แผน §5(g))
  for v_try in 1..3 loop
    begin
      insert into public.assessment_rules
        (assessment_id, version, time_limit_minutes, question_count, pass_pct,
         max_attempts, attempt_cooldown_minutes, shuffle_questions, shuffle_options,
         selection, require_course_complete, proctoring_mode, effective_from,
         exam_review_mode)
      select p_assessment_id, coalesce(max(ar.version), 0) + 1,
             p_time_limit_minutes, p_question_count, p_pass_pct, p_max_attempts,
             p_attempt_cooldown_minutes, p_shuffle_questions, p_shuffle_options,
             coalesce(p_selection, '{}'::jsonb), p_require_course_complete,
             p_proctoring_mode, coalesce(p_effective_from, now()), p_exam_review_mode
      from public.assessment_rules ar
      where ar.assessment_id = p_assessment_id
      returning * into v_row;
      return to_jsonb(v_row);
    exception when unique_violation then
      null; -- retry รอบถัดไป (subtransaction นี้ rollback เฉพาะ INSERT)
    end;
  end loop;
  raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|rules_version_conflict)'
    using errcode = 'P0001';
end;
$fn$;
alter function public.admin_add_assessment_rules(uuid, int, int, int, int, int, boolean, boolean, boolean, public.proctoring_mode, jsonb, timestamptz, public.exam_review_mode)
  owner to app_owner;
revoke execute on function public.admin_add_assessment_rules(uuid, int, int, int, int, int, boolean, boolean, boolean, public.proctoring_mode, jsonb, timestamptz, public.exam_review_mode)
  from public, anon;
grant execute on function public.admin_add_assessment_rules(uuid, int, int, int, int, int, boolean, boolean, boolean, public.proctoring_mode, jsonb, timestamptz, public.exam_review_mode)
  to authenticated;
-- app_owner = บริบท SECURITY DEFINER ของ RPC — ต้องมีสิทธิ์เขียนจริงตามแบบแผน 0010:764/773
-- (grant ตารางให้ฟังก์ชัน owner ทุกตัว · SELECT สำหรับ INSERT...SELECT max(version))
grant select, insert on public.assessment_rules to app_owner;

-- ─── (5) D87.5: audit trigger — ASSESSMENT_CONFIG_CHANGE ทุก INSERT ───
-- ปิด 3 ทาง: RPC/endpoint ใหม่ · POST v1 เดิม · insert ตรงผ่าน ar_write —
-- หนี้เดิม (POST v1 ไม่เคยเขียน audit) ถูกปิดพร้อมกันโดย trigger เดียว
-- · SECURITY DEFINER + search_path=public + owner app_owner (runner ของ
--   migrate.sh ไม่สลับ role — ไม่ระบุ = ฟังก์ชันตกเป็นของ supabase_admin)
-- · ท่า ACL ของ internal audit (0008:389-395): revoke จากทุก client role และ
--   ไม่ grant ให้ใคร — trigger ทำงานตาม privilege ของ function เอง เรียก
--   append_audit_event_internal ผ่าน owner context (app_owner มี grant 0008:394)
-- · actor derive จาก auth.uid() ภายใน session ของผู้ insert (0008:325-326)
create or replace function public.audit_assessment_rules_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $fn$
begin
  perform public.append_audit_event_internal(
    'ASSESSMENT_CONFIG_CHANGE', 'assessment_rules', new.id::text, null, null,
    jsonb_build_object('assessment_id', new.assessment_id, 'version', new.version,
                       'exam_review_mode', new.exam_review_mode,
                       'max_attempts', new.max_attempts, 'pass_pct', new.pass_pct,
                       'effective_from', new.effective_from),
    null, null, null);
  return null; -- AFTER trigger: ค่าที่คืนถูกเพิกเฉย
end;
$fn$;
alter function public.audit_assessment_rules_insert() owner to app_owner;
revoke execute on function public.audit_assessment_rules_insert()
  from public, anon, authenticated, service_role;

create trigger audit_assessment_rules_after_insert
  after insert on public.assessment_rules
  for each row execute function public.audit_assessment_rules_insert();
