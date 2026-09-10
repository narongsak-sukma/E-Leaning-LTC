-- 0012_dcr4_catalog_display.sql — DCR-4 (DD 1.1.0): ฟิลด์แสดงผล catalog + views สาธารณะ 3 ตัว
-- ที่มา: DD §3.2 "Views สาธารณะของ catalog (DCR-4)" · §4.5 (PII — instructors) · §4.4 (convention revoke→grant)
-- หลักการ: เปิดเฉพาะคอลัมน์แสดงผลผ่าน definer-view (security_invoker = off) — ตารางฐาน
--          (enrollments / credit_rules / profiles) คง RLS + grant เดิมทั้งหมด ไม่ grant เพิ่ม

-- ═══ 1) enum course_level (DD §2) ═══
create type public.course_level as enum ('beginner', 'intermediate', 'advanced');

-- ═══ 2) courses.level + courses.outcome_highlights (DD §3.2) ═══
alter table public.courses
  add column level public.course_level not null default 'beginner',
  add column outcome_highlights text[] null;

-- ═══ 3) course_public_stats — ยอดผู้เรียน + credit ต่อหลักสูตร published (DD §3.2 DCR-4) ═══
-- learner_count = count(enrollments) ที่ status <> 'cancelled' (DD §3.2 — enrollment_status:
-- active/completed/expired/cancelled — cancelled เท่านั้นที่ไม่นับ) และยังไม่ soft-delete
-- credits = credit_rules ที่ course_id ตรง + status='active' + effective window ครอบ now()
--           + priority ต่ำสุด (น้อย = จับคู่ก่อน — DD §3.5); tie ด้วย effective_from ล่าสุด → code
--           — NULL ถ้าไม่มีกฎที่ผ่านเงื่อนไข
create view public.course_public_stats
  with (security_invoker = off) as
select
  c.id as course_id,
  (
    select count(*)::int
    from public.enrollments e
    where e.course_id = c.id
      and e.deleted_at is null
      and e.status <> 'cancelled'
  ) as learner_count,
  (
    select r.credits
    from public.credit_rules r
    where r.course_id = c.id
      and r.status = 'active'
      and r.effective_from <= now()
      and (r.effective_to is null or r.effective_to > now())
    order by r.priority asc, r.effective_from desc, r.code asc
    limit 1
  ) as credits
from public.courses c
where c.status = 'published'
  and c.deleted_at is null;

-- ═══ 4) course_instructors_public — ผู้สอนหลักของหลักสูตร published (DD §3.2 + §4.5) ═══
-- join profiles ผ่าน courses.created_by — เปิดเฉพาะ display_name + title + bio
-- (profiles ปัจจุบัน "ไม่มี" คอลัมน์ title/bio จริง (0003_identity.sql) → คืน NULL ตาม DD
--  "ถ้ามีคอลัมน์/fallback NULL" — เมื่อ DCR ภายหลังเพิ่มคอลัมน์ ให้แทน literal ด้วยคอลัมน์จริง)
-- ห้ามเปิด email/phone/first_name/last_name เด็ดขาด (ทะเบียน PII §4.5)
create view public.course_instructors_public
  with (security_invoker = off) as
select
  c.id as course_id,
  p.display_name,
  null::text as title,
  null::text as bio
from public.courses c
join public.profiles p on p.id = c.created_by
where c.status = 'published'
  and c.deleted_at is null;

-- ═══ 5) course_exam_summary — เงื่อนไขสอบปลายหลักสูตร (DD §3.2 DCR-4 + §3.4) ═══
-- "assessment ปลายหลักสูตรที่ active" = assessments สถานะ 'published' (assessment_status
-- draft/published/closed/archived — ไม่มี label 'active' ใน enum) + ยังไม่ soft-delete
-- + is_final (DD §3.2: "assessments ปลายหลักสูตร" — แบบทดสอบซ้อม non-final ไม่นับแม้ published)
-- — หนึ่งแถวต่อหลักสูตร: เลือก assessment ที่ published ล่าสุด (published_at → created_at → id)
-- + หลักสูตรแม่ต้อง published และยังไม่ soft-delete ด้วย (gate r1: ไม่งั้น assessment
--   published ของหลักสูตร draft/archived/deleted รั่วผ่าน view ที่ anon เรียกตรง ๆ)
-- time_limit_minutes / pass_score_pct / max_attempts ← assessment_rules เวอร์ชันที่มีผล ณ now()
--   (effective_from <= now() ใส่ตอน query เท่านั้น — ห้ามเป็น index predicate — F21/D12)
-- question_count = นับ questions สถานะ 'active' ของ question_banks ที่ผูก course_id นี้
--   (DD §3.4 — ไม่มีตาราง assessment_questions; questions ผูกหลักสูตรผ่าน bank)
create view public.course_exam_summary
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
  r.max_attempts
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

-- ═══ 6) revoke → grant (แบบ 0009_views.sql — เปิดเฉพาะ SELECT ของ view, ไม่ grant ตารางฐาน) ═══
revoke all on public.course_public_stats from public, anon, authenticated, service_role;
revoke all on public.course_instructors_public from public, anon, authenticated, service_role;
revoke all on public.course_exam_summary from public, anon, authenticated, service_role;

grant select on public.course_public_stats to anon, authenticated;
grant select on public.course_instructors_public to anon, authenticated;
grant select on public.course_exam_summary to anon, authenticated;

-- ═══ 7) policy เสริม cc_read_admin (DCR-4 — permissive รวมกับ cc_read ที่มีอยู่) ═══
-- staff:viewer/staff:content/super_admin เห็นทุกแถวรวม is_active=false
-- (ให้ GET /admin/categories "ทุกสถานะ" ตาม API-SPEC §3.8 ได้ด้วย user-JWT)
create policy cc_read_admin on public.course_categories for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:content','super_admin']));
