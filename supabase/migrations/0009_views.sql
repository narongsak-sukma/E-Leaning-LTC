-- 0009_views.sql — projection views (DD §3.4, §3.7 + RBAC §3.1 (7))
-- ทุก view ปิด ACL inheritance ของ Supabase baseline: REVOKE ALL ก่อน GRANT SELECT
-- เท่านั้น (view updatable รับสิทธิ์เจ้าของ — B7/D18-B7)

-- ═══ certificate_public_view — 4 คอลัมน์เสมอ (RBAC §3.1 (7) — SQL เป๊ะ) ═══
create view public.certificate_public_view
  with (security_invoker = false) as
  select cert_no as code,
         course_title_snapshot as course_title,
         issued_at,
         status
  from public.certificates;

-- ═══ learner_attempt_view (DD §3.4 — F4/D12 + B1/D19-B1) ═══
-- SELECT เฉพาะแถวของตัวเอง + คอลัมน์เฉลย (is_correct, points_earned, question_snapshot,
-- explanation) เปิดเฉลยเมื่อ "ส่งแล้ว และเป็นครั้งสุดท้ายตามกติกา" —
-- exam_review_mode baseline = after_final_attempt (SRS Appendix A: "กันรั่วไหลของข้อสอบ
-- ระหว่างยังมีครั้งเหลือ") — ผู้เรียนส่งครั้งที่ 1 เพื่อ "เก็บเฉลย" แล้วใช้ครั้งที่เหลือ
-- ตอบให้ผ่านไม่ได้ (D19-B1)
-- NB: คอลัมน์ exam_review_mode ยังไม่มีในสคีมา → view บังคับ baseline ของ default;
--     เมื่อเพิ่มคอลัมน์ (DCR) เงื่อนไขต้องขยายตามโหมดนั้น ๆ (DD §3.4)
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
    aa.answered_at,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then aa.is_correct end as is_correct,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then aa.points_earned end as points_earned,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then aa.question_snapshot end as question_snapshot,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then q.explanation end as explanation
  from public.assessment_attempts at
  join public.attempt_answers aa on aa.attempt_id = at.id
  left join public.questions q on q.id = aa.question_id
  where at.user_id = auth.uid();

-- ═══ instructor_attempt_view (DD §3.4 — D15-N2, RBAC §2.2 attempt:view O†) ═══
-- ตรวจสองชั้นในนิยาม view: บทบาท instructor + เป็นเจ้าของหลักสูตร
-- (assessment_attempts -> enrollments -> courses.created_by = auth.uid())
-- คอลัมน์เฉลยเปิดตามเงื่อนไข exam_review_mode เหมือน learner view
-- (after_final_attempt — B1/D19-B1, DD L479)
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
    aa.answered_at,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then aa.is_correct end as is_correct,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then aa.points_earned end as points_earned,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then aa.question_snapshot end as question_snapshot,
    case when at.submitted_at is not null
          and (select count(*) from public.assessment_attempts at2
               where at2.assessment_id = at.assessment_id
                 and at2.user_id = at.user_id and at2.status <> 'voided'
                 and at2.submitted_at is not null) -- D20-B1: นับเฉพาะครั้งที่ส่งแล้ว — เริ่มครั้งสุดท้ายยังไม่ส่งต้องไม่เปิดเฉลยกลางคัน
              >= (select r.max_attempts from public.assessment_rules r
                  where r.id = at.rules_id)
         then q.explanation end as explanation
  from public.assessment_attempts at
  join public.enrollments e on e.id = at.enrollment_id
  join public.courses c on c.id = e.course_id
  join public.attempt_answers aa on aa.attempt_id = at.id
  left join public.questions q on q.id = aa.question_id
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

-- ═══ assessment_rules_full_view (M5/D18-M5) ═══
-- ชดเชย column grant ที่ตัด pass_pct/selection จาก base (0010 — column protection DD §3.4):
-- staff 4 roles + instructor เจ้าของหลักสูตรของ assessment นั้น — กรองในนิยาม view เอง
create view public.assessment_rules_full_view
  with (security_invoker = false) as
  select ar.*
  from public.assessment_rules ar
  where public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin'])
     or exists (select 1 from public.assessments a
                join public.courses c on c.id = a.course_id
                where a.id = ar.assessment_id and c.created_by = auth.uid());

-- ═══ Reporting views ครบ 4 ตาม DD §3.7 (B5/D19-B5 — กรอกบทบาทตามขอบเขต
--     report:view ของ RBAC §2.4 L109: sv=ทั่วไป · se=ผลสอบ · sr=credit · sa=ทั้งหมด
--     — is_staff() กว้างเกิน (sc/se/sr เกินขอบเขตตัวเอง); v_credit_balance อยู่ด้านบน) ═══

-- สรุปความคืบหน้าต่อ enrollment (จำนวน lesson ทั้งหมด / completed / pct)
-- — รายงานผู้ใช้/การเรียน: report:view (ทั่วไป) = sv/sa เท่านั้น
create view public.v_enrollment_progress
  with (security_invoker = false) as
  select
    s.enrollment_id,
    s.user_id,
    s.course_id,
    s.lesson_total,
    s.lesson_completed,
    case when s.lesson_total = 0 then 0
         else round(100.0 * s.lesson_completed / s.lesson_total)::int
    end as progress_pct -- pct ความคืบหน้า 0-100
  from (
    select
      e.id as enrollment_id,
      e.user_id,
      e.course_id,
      (select count(*)
       from public.course_modules m
       join public.lessons l on l.module_id = m.id
       where m.course_id = e.course_id
         and m.deleted_at is null and l.deleted_at is null) as lesson_total,
      (select count(*)
       from public.lesson_progress lp
       where lp.enrollment_id = e.id and lp.status = 'completed') as lesson_completed
    from public.enrollments e
  ) s
  where public.has_any_role(array['staff:viewer','super_admin']);

-- ผลสอบต่อ assessment (จำนวน attempt / ผ่าน / pass_rate)
-- — รายงานผลสอบ: sv/se/sa (RBAC §2.4 — sr เกินขอบเขต credit)
create view public.v_assessment_statistics
  with (security_invoker = false) as
  select
    s.assessment_id,
    s.attempt_total,
    s.attempt_passed,
    case when s.attempt_total = 0 then 0
         else round(100.0 * s.attempt_passed / s.attempt_total)::int
    end as pass_rate_pct
  from (
    select
      a.id as assessment_id,
      (select count(*)
       from public.assessment_attempts at
       where at.assessment_id = a.id) as attempt_total,
      (select count(*)
       from public.assessment_attempts at2
       where at2.assessment_id = a.id and at2.passed = true) as attempt_passed
    from public.assessments a
  ) s
  where public.has_any_role(array['staff:viewer','staff:exam','super_admin']);

-- ประกาศนียบัตรต่อ course — แยกคอลัมน์ตาม status + วันที่ออกล่าสุด
-- — รายงานประกาศนียบัตร (โดเมน credit/ต่ออายุ): sv/sr/sa (RBAC §2.4)
create view public.v_certificates_issued
  with (security_invoker = false) as
  select
    c.id as course_id,
    c.code as course_code,
    count(ct.id) filter (where ct.status = 'valid') as cert_valid,
    count(ct.id) filter (where ct.status = 'superseded') as cert_superseded,
    count(ct.id) filter (where ct.status = 'revoked') as cert_revoked,
    max(ct.issued_at) as last_issued_at
  from public.courses c
  left join public.certificates ct on ct.course_id = c.id
  where public.has_any_role(array['staff:viewer','staff:registrar','super_admin'])
  group by c.id, c.code;

-- ═══ ACL: ปิด inheritance ก่อน แล้วค่อยเปิด SELECT เท่านั้น (B7/D18-B7) ═══
-- view updatable รับสิทธิ์เจ้าของ — ต้องถอนให้ชัดว่าเหลือ SELECT อย่างเดียว
revoke all on public.certificate_public_view from public, anon, authenticated, service_role;
revoke all on public.learner_attempt_view from public, anon, authenticated, service_role;
revoke all on public.instructor_attempt_view from public, anon, authenticated, service_role;
revoke all on public.v_credit_balance from public, anon, authenticated, service_role;
revoke all on public.assessment_rules_full_view from public, anon, authenticated, service_role;
revoke all on public.v_enrollment_progress from public, anon, authenticated, service_role;
revoke all on public.v_assessment_statistics from public, anon, authenticated, service_role;
revoke all on public.v_certificates_issued from public, anon, authenticated, service_role;

-- grant ให้ authenticated (นิยาม view กรองเอง) — anon ไม่มี path
grant select on public.learner_attempt_view to authenticated;
grant select on public.instructor_attempt_view to authenticated;
grant select on public.v_credit_balance to authenticated;
grant select on public.assessment_rules_full_view to authenticated;
grant select on public.v_enrollment_progress to authenticated;
grant select on public.v_assessment_statistics to authenticated;
grant select on public.v_certificates_issued to authenticated;
grant select on public.certificate_public_view to anon, authenticated;
