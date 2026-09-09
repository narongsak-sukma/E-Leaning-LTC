-- 0009_views.sql — projection views (DD §3.4, §3.7 + RBAC §3.1 (7))

-- ═══ certificate_public_view — 4 คอลัมน์เสมอ (RBAC §3.1 (7) — SQL เป๊ะ) ═══
create view public.certificate_public_view
  with (security_invoker = false) as
  select cert_no as code,
         course_title_snapshot as course_title,
         issued_at,
         status
  from public.certificates;

-- ═══ learner_attempt_view (DD §3.4 — F4/D12) ═══
-- SELECT เฉพาะแถวของตัวเอง + ตัดคอลัมน์เฉลย (is_correct, points_earned,
-- question_snapshot, explanation) — เปิดเฉลยเมื่อครบเงื่อนไข exam_review_mode
create view public.learner_attempt_view
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
    aa.answered_at
  from public.assessment_attempts at
  join public.attempt_answers aa on aa.attempt_id = at.id
  where at.user_id = auth.uid();

-- ═══ instructor_attempt_view (DD §3.4 — D15-N2, RBAC §2.2 attempt:view O†) ═══
-- ตรวจสองชั้นในนิยาม view: บทบาท instructor + เป็นเจ้าของหลักสูตร
-- (assessment_attempts -> enrollments -> courses.created_by = auth.uid())
-- ตัดคอลัมน์เฉลยเหมือน learner view — เหลือ selected_option_ids/answered_at/seq + คะแนนรวม
create view public.instructor_attempt_view
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
    aa.answered_at
  from public.assessment_attempts at
  join public.enrollments e on e.id = at.enrollment_id
  join public.courses c on c.id = e.course_id
  join public.attempt_answers aa on aa.attempt_id = at.id
  where public.has_any_role(array['instructor'])
    and c.created_by = auth.uid();

-- ═══ v_credit_balance (DD §3.7 — ยอด credit ต่อรอบ/ประเภท จาก SUM ledger) ═══
create view public.v_credit_balance
  with (security_invoker = false) as
  select
    l.user_id,
    l.renewal_cycle_id,
    l.credit_type,
    sum(l.amount) as balance,
    max(l.created_at) as last_entry_at
  from public.credit_ledger_entries l
  group by l.user_id, l.renewal_cycle_id, l.credit_type
  having (l.user_id = auth.uid()
          or public.has_any_role(array['staff:viewer','staff:registrar','super_admin']));

-- grant ให้ authenticated (นิยาม view กรองเอง) — anon ไม่มี path
grant select on public.learner_attempt_view to authenticated;
grant select on public.instructor_attempt_view to authenticated;
grant select on public.v_credit_balance to authenticated;
grant select on public.certificate_public_view to anon, authenticated;
