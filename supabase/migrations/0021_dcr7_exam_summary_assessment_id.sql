-- ═══ 0021 — DCR-7 / PB-17 (Wave E): course_exam_summary + assessment_id ═══
-- ทำไม: ผู้เรียนไม่มีทางรู้ assessmentId ของสอบปลายหลักสูตร (BFF อ่าน view นี้
-- แต่ view ไม่คืน id ของ assessment ที่เลือกไว้ — หน้าหลักสูตรจึงไม่มีทางสร้าง
-- ลิงก์ "เข้าสอบ") · D55-10: CREATE OR REPLACE ของ PG เพิ่มคอลัมน์ได้ **ท้ายสุด
-- เท่านั้น** — แทรกกลางลำดับเดิม = ต้อง DROP VIEW (เสี่ยง ACL/dependency หลุด)
-- ทุกส่วนอื่นคงเดิมทุกไบต์กับ 0012 §5 (ตรรกะเลือก assessment published+is_final
-- ล่าสุดต่อหลักสูตร · หลักสูตรแม่ต้อง published · rules ที่มีผล ณ now())
create or replace view public.course_exam_summary
  with (security_invoker = off) as
select
  a.course_id,
  (
    select count(*)::int
    from public.questions q
    join public.question_banks b on b.id = q.bank_id
    where b.course_id = a.course_id
      and b.is_active
      and q.status = 'active'
  ) as question_count,
  r.time_limit_minutes,
  r.pass_pct as pass_score_pct,
  r.max_attempts,
  a.id as assessment_id
from public.assessments a
join public.courses c on c.id = a.course_id
left join lateral (
  select ar.time_limit_minutes, ar.pass_pct, ar.max_attempts
  from public.assessment_rules ar
  where ar.assessment_id = a.id
    and ar.effective_from <= now()
  order by ar.effective_from desc, ar.version desc
  limit 1
) r on true
where c.status = 'published'
  and c.deleted_at is null
  and a.deleted_at is null
  and a.status = 'published'
  and a.is_final
  and a.id = (
    select a2.id
    from public.assessments a2
    where a2.course_id = a.course_id
      and a2.deleted_at is null
      and a2.status = 'published'
      and a2.is_final
    order by a2.published_at desc nulls last, a2.created_at desc, a2.id desc
    limit 1
  );

-- ACL re-assert ตามแบบแผน 0012 §6 (CREATE OR REPLACE คง ACL เดิมไว้ตาม spec แต่
-- ประกาศซ้ำให้ migration สมบูรณ์ในตัว — อ่านรูปเดียวกัน 0009/0012)
revoke all on public.course_exam_summary from public, anon, authenticated, service_role;
grant select on public.course_exam_summary to anon, authenticated;
