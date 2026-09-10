-- 0010_security.sql — RLS + policies + REVOKE/GRANT enforcement + append-only guards
-- ที่มา: DD §3 (รายตาราง), §4.3–§4.4 + RBAC §3.1 + AUDIT §4
-- กติกา CTO D11–D17: RLS enable ทุกตาราง; policy แยกตาม operation (ห้าม FOR ALL)

-- ═══ 1) เปิด RLS ทุกตาราง (ไม่มีข้อยกเว้น) ═══
alter table public.profiles enable row level security;
alter table public.role_assignments enable row level security;
alter table public.lawyer_licenses enable row level security;
alter table public.license_applications enable row level security;
alter table public.consents enable row level security;
alter table public.notice_acknowledgments enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.course_categories enable row level security;
alter table public.courses enable row level security;
alter table public.course_modules enable row level security;
alter table public.lessons enable row level security;
alter table public.media_assets enable row level security;
alter table public.enrollments enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.lesson_quizzes enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_options enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.question_banks enable row level security;
alter table public.questions enable row level security;
alter table public.question_options enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_rules enable row level security;
alter table public.assessment_attempts enable row level security;
alter table public.attempt_answers enable row level security;
alter table public.certificates enable row level security;
alter table public.certificate_verifications enable row level security;
alter table public.credit_rules enable row level security;
alter table public.renewal_cycles enable row level security;
alter table public.credit_ledger_entries enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_recipients enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notification_templates enable row level security;
alter table public.email_outbox enable row level security;
alter table public.event_outbox enable row level security;
alter table public.report_exports enable row level security;
alter table public.security_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.audit_chain_anchors enable row level security;

-- ═══ 2) Append-only enforcement (DD §4.4 + AUDIT §4) ═══
-- ชั้น 1: DB privileges + ชั้น 3: RLS อยู่ในส่วนตารางด้านล่าง; ส่วนนี้ = ชั้น 2 trigger guards
-- D18-M10: ยกเว้น purge_role เท่านั้น (retention — DD §4.6); superuser ปกติยังโดนขวางเหมือนเดิม
-- NB: ตรวจด้วย current_role (คำสั่งเดิมระบุ pg_current_role() — ไม่มีฟังก์ชันนี้ใน PG15;
-- current_role เปลี่ยนตาม SET ROLE — purge job ต้อง SET ROLE purge_role ก่อน)
-- D19-M2: BEFORE ROW trigger คืน NULL = "ข้ามแถว" — purge_role ต้องได้คืนแถว
-- เพื่อให้ DELETE ดำเนินต่อจริง (ก่อนหน้านี้ delete ถูก swallow เงียบ ๆ)
create or replace function public.prevent_audit_mutation() returns trigger
language plpgsql as $fn$
begin
  if current_role <> 'purge_role' then
    raise exception 'audit_logs: append-only - UPDATE/DELETE/TRUNCATE ถูกห้าม (BRIEF §8, D6, D11-7)';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$fn$;

create or replace function public.prevent_append_only_mutation() returns trigger
language plpgsql as $fn$
begin
  if current_role <> 'purge_role' then
    raise exception '%: append-only - UPDATE/DELETE/TRUNCATE ถูกห้าม (DD §4.4)', tg_table_name;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$fn$;

-- audit_logs: ชื่อ trigger ตาม AUDIT §4 เป๊ะ
create trigger trg_audit_immutable_rows
  before update or delete on public.audit_logs
  for each row execute function public.prevent_audit_mutation();
create trigger trg_audit_immutable_truncate
  before truncate on public.audit_logs
  for each statement execute function public.prevent_audit_mutation();

-- ตาราง append-only อื่น (DD §4.4): row trigger + statement TRUNCATE trigger (D15-M3)
do $$
declare t text;
begin
  -- B7/D18-B7: เพิ่ม consents เข้าชุด append-only (ถอน = เพิ่มแถว action='revoke' — DD §3.1)
  foreach t in array array['audit_chain_anchors','credit_ledger_entries','security_events','notice_acknowledgments','consents']
  loop
    execute format('create trigger trg_append_only_rows before update or delete on public.%I
                    for each row execute function public.prevent_append_only_mutation();', t);
    execute format('create trigger trg_append_only_truncate before truncate on public.%I
                    for each statement execute function public.prevent_append_only_mutation();', t);
  end loop;
end $$;

-- ═══ 3) REVOKE append-only ชุดของ DD §4.4 ═══
revoke update, delete, truncate on public.audit_logs,
  public.credit_ledger_entries, public.security_events, public.audit_chain_anchors
  from anon, authenticated, service_role;
revoke update, delete, truncate on public.notice_acknowledgments
  from anon, authenticated, service_role; -- D13-F11 + D15-M3
revoke insert on public.audit_logs from anon, authenticated, service_role; -- F8/D12: path เดียวคือ append_audit_event()

-- ═══ 4) Policies + grants รายตาราง ═══

-- ─── profiles (DD §3.1 + RBAC §3.1 (1)) ───
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:registrar','super_admin']));
create policy profiles_update_owner on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_update_admin on public.profiles for update to authenticated
  using (public.has_any_role(array['super_admin']))
  with check (public.has_any_role(array['super_admin']));
-- D20-M2 (DD §3.1): "เจ้าของแถวได้เฉพาะ display_name/phone/preferred_locale/
-- pdpa_consented_at (บังคับผ่าน BFF + trigger guard คอลัมน์), super_admin ได้ทุกคอลัมน์"
-- → grant UPDATE เต็มตารางให้ authenticated แล้วบังคับขอบเขตคอลัมน์ด้วย trigger
-- guard (การจำกัดด้วย column grant อย่างเดียวบล็อก super_admin ไปด้วย)
revoke all on public.profiles from authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.profiles to service_role; -- INSERT ผ่าน trigger/service (DD §3.1)

-- D20-M2: trigger guard คอลัมน์ — คอลัมน์นอกชุด 4 ของเจ้าของ = super_admin เท่านั้น
-- (service_role/app_owner = BFF trusted ผ่านตามปกติ — ดู current_setting('role') ไม่เปลี่ยน
-- ตาม SECURITY DEFINER เหมือน append_audit_event)
create or replace function public.guard_profiles_update_columns() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
declare
  k text;
  r jsonb := to_jsonb(new);
  o jsonb := to_jsonb(old);
begin
  if coalesce(current_setting('role', true), '') in ('service_role','app_owner') then
    return new;
  end if;
  for k in select jsonb_object_keys(r) loop
    -- NB: not (k = any(...)) — "ไม่อยู่ในชุด" (k <> any(...) คือ "ต่างจากสักตัว" = จริงเกือบทุกคีย์)
    if not (k = any (array['display_name','phone','preferred_locale','pdpa_consented_at']))
       and (r -> k) is distinct from (o -> k)
       and not public.has_any_role(array['super_admin']) then
      raise exception 'profiles: เจ้าของแถวแก้ได้เฉพาะ display_name/phone/preferred_locale/pdpa_consented_at — คอลัมน์อื่นเป็นของ super_admin (DD §3.1 — D20-M2): %', k;
    end if;
  end loop;
  return new;
end;
$fn$;
create trigger trg_profiles_update_guard
  before update on public.profiles
  for each row execute function public.guard_profiles_update_columns();
-- D21-M2: SECURITY DEFINER → owner = app_owner ตาม contract checklist C
alter function public.guard_profiles_update_columns() owner to app_owner;

-- ─── role_assignments (DD §3.1) ───
create policy ra_read on public.role_assignments for select to authenticated
  using (user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:registrar','super_admin']));
revoke all on public.role_assignments from authenticated;
grant select on public.role_assignments to authenticated;
grant select, insert, update on public.role_assignments to service_role; -- INSERT/UPDATE เท่านั้น (DD)

-- ─── lawyer_licenses (DD §3.1) ───
create policy ll_read on public.lawyer_licenses for select to authenticated
  using (user_id = auth.uid()
         or public.has_any_role(array['staff:exam','staff:registrar','super_admin']));
create policy ll_update_registrar on public.lawyer_licenses for update to authenticated
  using (public.has_any_role(array['staff:registrar','super_admin']))
  with check (public.has_any_role(array['staff:registrar','super_admin']));
revoke all on public.lawyer_licenses from authenticated;
grant select, update on public.lawyer_licenses to authenticated;
grant select, insert, update on public.lawyer_licenses to service_role;

-- ─── license_applications (DD §3.1) ───
create policy la_read on public.license_applications for select to authenticated
  using (user_id = auth.uid()
         or public.has_any_role(array['staff:registrar','super_admin']));
create policy la_insert_owner on public.license_applications for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending'
              and decided_by is null and decided_at is null
              and resulting_license_id is null and rejected_reason is null); -- decision fields = server-controlled (DD §3.1) ผู้ยื่นใส่เองไม่ได้ (D18-M4)
revoke all on public.license_applications from authenticated;
grant select, insert on public.license_applications to authenticated;
grant select, update on public.license_applications to service_role; -- ตัดสินผ่าน BFF + audit

-- ─── consents (DD §3.1 — append-only: ถอน = เพิ่มแถว action='revoke') ───
create policy consents_read on public.consents for select to authenticated
  using (user_id = auth.uid()
         or public.has_any_role(array['staff:registrar','super_admin']));
revoke all on public.consents from authenticated;
-- B7/D18-B7: ปิด path UPDATE/DELETE/TRUNCATE ชัดเจน (หลักฐาน consent แก้ไม่ได้ — DD §3.1)
revoke update, delete, truncate on public.consents from authenticated, service_role;
grant select on public.consents to authenticated;
grant select, insert on public.consents to service_role;

-- ─── notice_acknowledgments (DD §3.1 — append-only) ───
create policy na_read on public.notice_acknowledgments for select to authenticated
  using (user_id = auth.uid());
create policy na_insert_owner on public.notice_acknowledgments for insert to authenticated
  with check (user_id = auth.uid());
revoke all on public.notice_acknowledgments from authenticated, anon;
grant select, insert on public.notice_acknowledgments to authenticated;
grant select on public.notice_acknowledgments to service_role; -- อ่านเพื่อ gate ฟีเจอร์ (DD)

-- ─── admin_sessions (DD §3.8) ───
create policy admin_sessions_read on public.admin_sessions for select to authenticated
  using (user_id = auth.uid() or public.has_any_role(array['super_admin']));
revoke all on public.admin_sessions from authenticated;
grant select on public.admin_sessions to authenticated;
grant select, insert, update on public.admin_sessions to service_role;

-- ─── course_categories (DD §3.2 — SELECT ทุกคนรวม guest) ───
create policy cc_read on public.course_categories for select to anon, authenticated
  using (is_active);
create policy cc_insert on public.course_categories for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin']));
create policy cc_update on public.course_categories for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin']))
  with check (public.has_any_role(array['staff:content','super_admin']));
revoke all on public.course_categories from authenticated;
grant select on public.course_categories to anon, authenticated;
grant insert, update on public.course_categories to authenticated;
grant select, insert, update on public.course_categories to service_role;

-- ─── courses (RBAC §3.1 (2) — 7 policies เป๊ะ) ───
create policy courses_public_read on public.courses for select to anon, authenticated
  using (status = 'published'
         and (is_public or public.has_any_role(array['lawyer'])));
create policy courses_owner_read on public.courses for select to authenticated
  using (created_by = auth.uid());
create policy courses_staff_read on public.courses for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:content','super_admin'])); -- D13-F5
create policy courses_owner_insert on public.courses for insert to authenticated
  with check (created_by = auth.uid()
              and public.has_any_role(array['instructor'])
              and status in ('draft','pending_review'));
create policy courses_staff_insert on public.courses for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin']));
create policy courses_owner_update on public.courses for update to authenticated
  using (created_by = auth.uid()
         and public.has_any_role(array['instructor'])
         and status in ('draft','pending_review'))
  with check (created_by = auth.uid()
              and public.has_any_role(array['instructor'])
              and status in ('draft','pending_review'));
create policy courses_staff_update on public.courses for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin']))
  with check (public.has_any_role(array['staff:content','super_admin']));
-- publish (status -> 'published') = staff:content/super_admin เท่านั้น — trigger guard (RBAC §3.1 (2))
create or replace function public.guard_course_publish() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
begin
  if new.status = 'published' and old.status <> 'published' then
    if not public.has_any_role(array['staff:content','super_admin']) then
      raise exception 'courses: publish ต้องเป็น staff:content/super_admin (SoD - RBAC §2.1)';
    end if;
  end if;
  return new;
end;
$fn$;
create trigger trg_courses_publish_guard
  before update on public.courses
  for each row execute function public.guard_course_publish();

-- B6/D19-B6: course:delete (soft — deleted_at) = staff:content/super_admin เท่านั้น
-- (RBAC §2.1 L50) — instructor เจ้าของแก้เนื้อหาได้แต่ตั้ง deleted_at เองไม่ได้;
-- RLS เห็นแถวเดียวต่อครั้ง จึงบังคับ transition ด้วย trigger guard เหมือน publish
create or replace function public.guard_course_soft_delete() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
begin
  if new.deleted_at is distinct from old.deleted_at then
    if not public.has_any_role(array['staff:content','super_admin']) then
      raise exception 'courses: ตั้ง/ยกเลิก deleted_at (soft delete) ได้เฉพาะ staff:content/super_admin (RBAC §2.1 course:delete — D19-B6)';
    end if;
  end if;
  return new;
end;
$fn$;
create trigger trg_courses_soft_delete_guard
  before update on public.courses
  for each row execute function public.guard_course_soft_delete();
revoke all on public.courses from authenticated;
grant select on public.courses to anon, authenticated;
grant insert, update on public.courses to authenticated;
grant select, insert, update on public.courses to service_role;

-- ─── course_modules / lessons (DD: สืบตาม courses + lesson:view ต้องมี enrollment
--     active หรือ preview หรือเจ้าของหรือ staff — RBAC §2.1 footnote) ───
create policy cm_read on public.course_modules for select to authenticated
  using (
    exists (select 1 from public.courses c where c.id = course_modules.course_id
            and (c.status = 'published'
                 and (c.is_public or public.has_any_role(array['lawyer']))
                 or c.created_by = auth.uid()
                 or public.has_any_role(array['staff:viewer','staff:content','super_admin'])))
    and (course_modules.is_preview
         or exists (select 1 from public.enrollments e
                    where e.course_id = course_modules.course_id
                      and e.user_id = auth.uid() and e.status = 'active')
         or exists (select 1 from public.courses c2
                    where c2.id = course_modules.course_id and c2.created_by = auth.uid())
         or public.is_staff())
  );
create policy cm_insert on public.course_modules for insert to authenticated
  with check (exists (select 1 from public.courses c where c.id = course_modules.course_id
                      and c.created_by = auth.uid())
              and public.has_any_role(array['instructor'])
              or public.has_any_role(array['staff:content','super_admin']));
create policy cm_update on public.course_modules for update to authenticated
  using (exists (select 1 from public.courses c where c.id = course_modules.course_id
                 and c.created_by = auth.uid())
         and public.has_any_role(array['instructor'])
         or public.has_any_role(array['staff:content','super_admin']))
  with check (exists (select 1 from public.courses c where c.id = course_modules.course_id
                      and c.created_by = auth.uid())
              and public.has_any_role(array['instructor'])
              or public.has_any_role(array['staff:content','super_admin']));
revoke all on public.course_modules from authenticated;
grant select, insert, update on public.course_modules to authenticated;
grant select, insert, update on public.course_modules to service_role;

create policy lessons_read on public.lessons for select to authenticated
  using (
    exists (
      select 1 from public.course_modules m
      join public.courses c on c.id = m.course_id
      where m.id = lessons.module_id
        and ((c.status = 'published'
              and (c.is_public or public.has_any_role(array['lawyer'])))
             or c.created_by = auth.uid()
             or public.has_any_role(array['staff:viewer','staff:content','super_admin']))
        and (lessons.is_preview
             or exists (select 1 from public.enrollments e
                        where e.course_id = c.id and e.user_id = auth.uid()
                          and e.status = 'active')
             or c.created_by = auth.uid()
             or public.is_staff())
    )
  );
create policy lessons_insert on public.lessons for insert to authenticated
  with check (
    -- D21-B3: ห้ามสร้างแถว "เกิดมาพร้อม deleted_at" (soft-delete เกิดทาง UPDATE เท่านั้น
    -- — แถวเช่นนั้นเคยหลุด partial index แล้วถูกใช้อ้าง ownership quiz ต่างถิ่น)
    lessons.deleted_at is null
    and exists (
    select 1 from public.course_modules m
    join public.courses c on c.id = m.course_id
    where m.id = lessons.module_id
      and ((c.created_by = auth.uid() and public.has_any_role(array['instructor']))
           or public.has_any_role(array['staff:content','super_admin']))));
create policy lessons_update on public.lessons for update to authenticated
  using (exists (
    select 1 from public.course_modules m
    join public.courses c on c.id = m.course_id
    where m.id = lessons.module_id
      and ((c.created_by = auth.uid() and public.has_any_role(array['instructor']))
           or public.has_any_role(array['staff:content','super_admin']))))
  with check (exists (
    select 1 from public.course_modules m
    join public.courses c on c.id = m.course_id
    where m.id = lessons.module_id
      and ((c.created_by = auth.uid() and public.has_any_role(array['instructor']))
           or public.has_any_role(array['staff:content','super_admin']))));
revoke all on public.lessons from authenticated;
grant select, insert, update on public.lessons to authenticated;
grant select, insert, update on public.lessons to service_role;

-- ─── media_assets (DD §3.2 — SELECT instructor/staff; เขียน service เท่านั้น) ───
create policy media_read on public.media_assets for select to authenticated
  using (public.has_any_role(array['instructor'])
         or public.is_staff());
revoke all on public.media_assets from authenticated;
grant select on public.media_assets to authenticated;
grant select, insert, update on public.media_assets to service_role;

-- ─── enrollments (RBAC §3.1 (3) — ผู้เรียนเหลือ SELECT; เขียนผ่าน enroll()) ───
create policy enrollments_owner_read on public.enrollments for select to authenticated
  using (enrollments.user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','super_admin'])
         or exists (select 1 from public.courses c
                    where c.id = enrollments.course_id and c.created_by = auth.uid()));
revoke insert, update, delete on public.enrollments from authenticated, anon; -- D12-1
grant select on public.enrollments to authenticated;
grant select, insert, update on public.enrollments to service_role;
grant select, insert, update on public.enrollments to app_owner; -- enroll()

-- ─── lesson_progress (RBAC §3.1 (4)) ───
create policy lp_owner_read on public.lesson_progress for select to authenticated
  using (exists (select 1 from public.enrollments e
                 where e.id = lesson_progress.enrollment_id and e.user_id = auth.uid())
         or public.has_any_role(array['staff:viewer','super_admin'])
         or exists (select 1 from public.enrollments e
                    join public.courses c on c.id = e.course_id
                    where e.id = lesson_progress.enrollment_id and c.created_by = auth.uid()));
revoke insert, update, delete on public.lesson_progress from authenticated, anon; -- D12-1
grant select on public.lesson_progress to authenticated;
grant select, insert, update on public.lesson_progress to service_role;
grant select, insert, update on public.lesson_progress to app_owner; -- record_lesson_progress()

-- ─── lesson_quizzes (DD §3.3 — SELECT ผู้ลงทะเบียน + instructor/staff) ───
create policy lq_read on public.lesson_quizzes for select to authenticated
  using (exists (
    select 1 from public.lessons l
    join public.course_modules m on m.id = l.module_id
    join public.courses c on c.id = m.course_id
    where l.quiz_id = lesson_quizzes.id and l.deleted_at is null
      and ((c.status = 'published'
            and (c.is_public or public.has_any_role(array['lawyer'])))
           or c.created_by = auth.uid()
           or public.has_any_role(array['staff:viewer','staff:content','super_admin']))
      and (exists (select 1 from public.enrollments e
                   where e.course_id = c.id and e.user_id = auth.uid() and e.status = 'active')
           or c.created_by = auth.uid()
           or public.is_staff())));
create policy lq_insert on public.lesson_quizzes for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.lessons l2
                              join public.course_modules m2 on m2.id = l2.module_id
                              join public.courses c2 on c2.id = m2.course_id
                              where l2.quiz_id = lesson_quizzes.id and l2.deleted_at is null
                                and c2.created_by = auth.uid())));
create policy lq_update on public.lesson_quizzes for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.lessons l3
                         join public.course_modules m3 on m3.id = l3.module_id
                         join public.courses c3 on c3.id = m3.course_id
                         where l3.quiz_id = lesson_quizzes.id and l3.deleted_at is null
                           and c3.created_by = auth.uid())))
  with check (public.has_any_role(array['staff:content','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.lessons l4
                              join public.course_modules m4 on m4.id = l4.module_id
                              join public.courses c4 on c4.id = m4.course_id
                              where l4.quiz_id = lesson_quizzes.id and l4.deleted_at is null
                                and c4.created_by = auth.uid())));
revoke all on public.lesson_quizzes from authenticated;
grant select, insert, update on public.lesson_quizzes to authenticated;
grant select, insert, update on public.lesson_quizzes to service_role;

-- ─── quiz_questions / quiz_options (DD §3.3 — F4/D12: ไม่มี policy ผู้เรียน) ───
create policy qq_read on public.quiz_questions for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:content','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.lessons l
                         join public.course_modules m on m.id = l.module_id
                         join public.courses c on c.id = m.course_id
                         where l.quiz_id = quiz_questions.quiz_id and l.deleted_at is null
                           and c.created_by = auth.uid())));
create policy qq_insert on public.quiz_questions for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.lessons l
                              join public.course_modules m on m.id = l.module_id
                              join public.courses c on c.id = m.course_id
                              where l.quiz_id = quiz_questions.quiz_id and l.deleted_at is null
                                and c.created_by = auth.uid())));
create policy qq_update on public.quiz_questions for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.lessons l
                         join public.course_modules m on m.id = l.module_id
                         join public.courses c on c.id = m.course_id
                         where l.quiz_id = quiz_questions.quiz_id and l.deleted_at is null
                           and c.created_by = auth.uid())))
  with check (public.has_any_role(array['staff:content','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.lessons l
                              join public.course_modules m on m.id = l.module_id
                              join public.courses c on c.id = m.course_id
                              where l.quiz_id = quiz_questions.quiz_id and l.deleted_at is null
                                and c.created_by = auth.uid())));
revoke all on public.quiz_questions from authenticated;
grant select, insert, update on public.quiz_questions to authenticated;
grant select, insert, update on public.quiz_questions to service_role;

create policy qo_read on public.quiz_options for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:content','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.quiz_questions qq
                         join public.lessons l on l.quiz_id = qq.quiz_id and l.deleted_at is null
                         join public.course_modules m on m.id = l.module_id
                         join public.courses c on c.id = m.course_id
                         where qq.id = quiz_options.question_id
                           and c.created_by = auth.uid())));
create policy qo_insert on public.quiz_options for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.quiz_questions qq
                              join public.lessons l on l.quiz_id = qq.quiz_id and l.deleted_at is null
                              join public.course_modules m on m.id = l.module_id
                              join public.courses c on c.id = m.course_id
                              where qq.id = quiz_options.question_id
                                and c.created_by = auth.uid())));
create policy qo_update on public.quiz_options for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.quiz_questions qq
                         join public.lessons l on l.quiz_id = qq.quiz_id and l.deleted_at is null
                         join public.course_modules m on m.id = l.module_id
                         join public.courses c on c.id = m.course_id
                         where qq.id = quiz_options.question_id
                           and c.created_by = auth.uid())))
  with check (public.has_any_role(array['staff:content','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.quiz_questions qq
                              join public.lessons l on l.quiz_id = qq.quiz_id and l.deleted_at is null
                              join public.course_modules m on m.id = l.module_id
                              join public.courses c on c.id = m.course_id
                              where qq.id = quiz_options.question_id
                                and c.created_by = auth.uid())));
revoke all on public.quiz_options from authenticated;
grant select, insert, update on public.quiz_options to authenticated;
grant select, insert, update on public.quiz_options to service_role;
-- NB: quiz_options/quiz_questions ไม่เปิด SELECT ให้ผู้เรียน (F4/D12 — is_correct เป็นเฉลย);
-- BFF อ่านผ่าน service_role แล้วตัด is_correct ก่อนส่ง (DD §3.3)

-- ─── quiz_attempts (DD §3.3 — F2/D12: เขียนผ่าน record_quiz_attempt()) ───
create policy qa_read on public.quiz_attempts for select to authenticated
  using (quiz_attempts.user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.lessons l
                         join public.course_modules m on m.id = l.module_id
                         join public.courses c on c.id = m.course_id
                         where l.quiz_id = quiz_attempts.quiz_id and l.deleted_at is null
                           and c.created_by = auth.uid())));
revoke insert, update, delete on public.quiz_attempts from authenticated, anon; -- F2/D12
grant select on public.quiz_attempts to authenticated;
grant select, insert, update on public.quiz_attempts to service_role;
grant select, insert, update on public.quiz_attempts to app_owner; -- record_quiz_attempt()

-- ─── question_banks (DD §3.4 + RBAC §2.2) ───
create policy qb_read on public.question_banks for select to authenticated
  using ((public.has_any_role(array['instructor'])
          and created_by = auth.uid())
         or public.has_any_role(array['staff:viewer','staff:exam','super_admin']));
create policy qb_insert on public.question_banks for insert to authenticated
  with check ((public.has_any_role(array['instructor'])
               and created_by = auth.uid())
              or public.has_any_role(array['staff:exam','super_admin']));
create policy qb_update on public.question_banks for update to authenticated
  using ((public.has_any_role(array['instructor'])
          and created_by = auth.uid())
         or public.has_any_role(array['staff:exam','super_admin']))
  with check ((public.has_any_role(array['instructor'])
               and created_by = auth.uid())
              or public.has_any_role(array['staff:exam','super_admin']));
revoke all on public.question_banks from authenticated;
grant select, insert, update on public.question_banks to authenticated;
grant select, insert, update on public.question_banks to service_role;

-- ─── questions (RBAC §3.1 (5) — q_read/q_insert/q_update เป๊ะ) ───
create policy q_read on public.questions for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:exam','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.question_banks qb
                         where qb.id = questions.bank_id and qb.created_by = auth.uid())));
create policy q_insert on public.questions for insert to authenticated
  with check (public.has_any_role(array['staff:exam','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and questions.created_by = auth.uid()
                  and exists (select 1 from public.question_banks qb
                              where qb.id = questions.bank_id and qb.created_by = auth.uid())));
create policy q_update on public.questions for update to authenticated
  using (public.has_any_role(array['staff:exam','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.question_banks qb
                         where qb.id = questions.bank_id and qb.created_by = auth.uid())))
  with check (public.has_any_role(array['staff:exam','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and questions.created_by = auth.uid()
                  and exists (select 1 from public.question_banks qb
                              where qb.id = questions.bank_id and qb.created_by = auth.uid())));
revoke all on public.questions from authenticated;
grant select, insert, update on public.questions to authenticated;
grant select, insert, update on public.questions to service_role;

-- B5/D18-B5: status -> 'active' เฉพาะ staff:exam/super_admin (RBAC §3.1 L237 สั่ง trigger guard ไว้ชัด)
-- เช็คบทบาท "ผู้ใช้จริง" ผ่าน helper ปกติ (has_any_role อ่าน role_assignments ของ auth.uid())
-- — ห้ามใช้ pg_current_role() เพราะ SECURITY DEFINER write functions ของ 0011 รันเป็น app_owner
create or replace function public.guard_question_activation() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
begin
  if new.status = 'active'
     and not public.has_any_role(array['staff:exam','super_admin']) then
    raise exception 'questions: เปิดใช้งาน (active) ได้เฉพาะ staff:exam/super_admin (RBAC §3.1, D18-B5)';
  end if;
  -- D20-M3: โจทย์ปรนัยต้องมีตัวเลือก ≥1 ก่อน active — กันข้อไม่มีตัวเลือกหลุดเข้า
  -- selection pool แล้วถูกดรอปจาก snapshot เงียบ ๆ ทำให้ question_count/score
  -- พื้นฐานผิด (ทุก type ใน enum เป็น choice-type)
  if new.status = 'active'
     and not exists (select 1 from public.question_options o where o.question_id = new.id) then
    raise exception 'questions: โจทย์ปรนัยต้องมีตัวเลือกอย่างน้อย 1 ข้อก่อนเปิดใช้งาน (D20-M3)';
  end if;
  return new;
end;
$fn$;
create trigger guard_question_activation
  before insert or update on public.questions
  for each row execute function public.guard_question_activation();

-- ─── question_options (DD §3.4 — instructor เจ้าของ bank + sv/se/sa) ───
create policy qopts_read on public.question_options for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:exam','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.questions q
                         join public.question_banks qb on qb.id = q.bank_id
                         where q.id = question_options.question_id
                           and qb.created_by = auth.uid())));
create policy qopts_insert on public.question_options for insert to authenticated
  with check (public.has_any_role(array['staff:exam','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.questions q
                              join public.question_banks qb on qb.id = q.bank_id
                              where q.id = question_options.question_id
                                and qb.created_by = auth.uid())));
create policy qopts_update on public.question_options for update to authenticated
  using (public.has_any_role(array['staff:exam','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.questions q
                         join public.question_banks qb on qb.id = q.bank_id
                         where q.id = question_options.question_id
                           and qb.created_by = auth.uid())))
  with check (public.has_any_role(array['staff:exam','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.questions q
                              join public.question_banks qb on qb.id = q.bank_id
                              where q.id = question_options.question_id
                                and qb.created_by = auth.uid())));
revoke all on public.question_options from authenticated;
grant select, insert, update on public.question_options to authenticated;
grant select, insert, update on public.question_options to service_role;

-- ─── assessments (DD §3.4 + RBAC §2.2) ───
create policy asm_read on public.assessments for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin'])
         or (public.has_any_role(array['instructor'])
             and exists (select 1 from public.courses c
                         where c.id = assessments.course_id and c.created_by = auth.uid()))
         or (status = 'published'
             and exists (select 1 from public.enrollments e
                         where e.course_id = assessments.course_id
                           and e.user_id = auth.uid() and e.status = 'active')));
create policy asm_insert on public.assessments for insert to authenticated
  with check (public.has_any_role(array['staff:exam','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and status in ('draft')
                  and exists (select 1 from public.courses c
                              where c.id = assessments.course_id
                                and c.created_by = auth.uid())));
create policy asm_update on public.assessments for update to authenticated
  using (public.has_any_role(array['staff:exam','super_admin'])
         or (public.has_any_role(array['instructor'])
             and status in ('draft')
             and exists (select 1 from public.courses c
                         where c.id = assessments.course_id and c.created_by = auth.uid())))
  with check (public.has_any_role(array['staff:exam','super_admin'])
              or (public.has_any_role(array['instructor'])
                  and exists (select 1 from public.courses c
                              where c.id = assessments.course_id
                                and c.created_by = auth.uid())));
-- publish ต้อง staff:exam/super_admin (DD §3.4 "publish ต้อง staff:exam")
create or replace function public.guard_assessment_publish() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
begin
  if new.status = 'published' and old.status <> 'published' then
    if not public.has_any_role(array['staff:exam','super_admin']) then
      raise exception 'assessments: publish ต้องเป็น staff:exam/super_admin (DD §3.4)';
    end if;
  end if;
  return new;
end;
$fn$;
create trigger trg_assessments_publish_guard
  before update on public.assessments
  for each row execute function public.guard_assessment_publish();
revoke all on public.assessments from authenticated;
grant select, insert, update on public.assessments to authenticated;
grant select, insert, update on public.assessments to service_role;

-- ─── assessment_rules (DD §3.4 — learner เห็นเฉพาะฟิลด์กติกาที่เกี่ยวกับผู้สอบ) ───
create policy ar_read on public.assessment_rules for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin'])
         or exists (select 1 from public.assessments a
                    join public.courses c on c.id = a.course_id
                    where a.id = assessment_rules.assessment_id
                      and c.created_by = auth.uid())
         or exists (select 1 from public.assessments a2
                    join public.enrollments e on e.course_id = a2.course_id
                    where a2.id = assessment_rules.assessment_id
                      and e.user_id = auth.uid() and e.status = 'active'
                      and a2.status = 'published'));
create policy ar_write on public.assessment_rules for insert to authenticated
  with check (public.has_any_role(array['staff:exam','super_admin']));
create policy ar_update on public.assessment_rules for update to authenticated
  using (public.has_any_role(array['staff:exam','super_admin']))
  with check (public.has_any_role(array['staff:exam','super_admin']));
revoke all on public.assessment_rules from authenticated;
-- column protection: ผู้เรียนเห็นเฉพาะฟิลด์ เวลา/จำนวนครั้ง/โหมด (DD §3.4);
-- pass_pct/selection อ่านเต็มผ่าน BFF (service_role) เท่านั้น
grant select (id, assessment_id, version, time_limit_minutes, question_count,
              max_attempts, attempt_cooldown_minutes, shuffle_questions, shuffle_options,
              require_course_complete, proctoring_mode, effective_from)
  on public.assessment_rules to authenticated;
grant insert, update on public.assessment_rules to authenticated;
grant select, insert, update on public.assessment_rules to service_role;

-- B6/D18-B6: rules semantic immutability — แก้กฎที่ใช้งาน = สร้าง version ใหม่ (DD §3.4/§3.5)
-- BEFORE UPDATE: ยอมเฉพาะ lifecycle columns (status / effective_to / updated_at ถ้ามี);
-- คอลัมน์ semantic อื่นแก้ไม่ได้เด็ดขาด (INSERT version ใหม่ยังทำได้ปกติ)
create or replace function public.guard_rule_semantics() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_allowed text[] := array['status','effective_to','updated_at'];
  r jsonb := to_jsonb(new);
  o jsonb := to_jsonb(old);
  k text;
begin
  -- คอลัมน์ใด ๆ นอก whitelist ที่ค่าเปลี่ยน = semantic edit → ปฏิเสธ
  for k in select jsonb_object_keys(r) loop
    if not (k = any(v_allowed)) and (r -> k) is distinct from (o -> k) then
      raise exception '%: ห้ามแก้คอลัมน์ "%" — แก้กฎที่ใช้งาน = สร้าง version ใหม่ (DD §3.4/§3.5, D18-B6)', tg_table_name, k;
    end if;
  end loop;
  -- status เปลี่ยนได้ตาม lifecycle เท่านั้น: draft -> active (เปิดใช้) และ * -> retired (ปิดใช้)
  if (r ->> 'status') is distinct from (o ->> 'status') then
    if not ((r ->> 'status') = 'retired'
            or ((r ->> 'status') = 'active' and (o ->> 'status') = 'draft')) then
      raise exception '%: status เปลี่ยนได้เฉพาะ draft->active และ ->retired — แก้กฎที่ใช้งาน = สร้าง version ใหม่ (DD §3.4/§3.5, D18-B6)', tg_table_name;
    end if;
  end if;
  return new;
end;
$fn$;
create trigger guard_rule_versioning
  before update on public.assessment_rules
  for each row execute function public.guard_rule_semantics();
create trigger guard_credit_rule_versioning
  before update on public.credit_rules
  for each row execute function public.guard_rule_semantics();

-- ─── assessment_attempts (RBAC §3.1 (6) — ผู้เรียนเหลือ SELECT) ───
create policy attempts_owner_read on public.assessment_attempts for select to authenticated
  using (assessment_attempts.user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin'])
         or exists (select 1 from public.enrollments e
                    join public.courses c on c.id = e.course_id
                    where e.id = assessment_attempts.enrollment_id and c.created_by = auth.uid()));
revoke insert, update, delete on public.assessment_attempts from authenticated, anon; -- D12-1
grant select on public.assessment_attempts to authenticated;
grant select, insert, update on public.assessment_attempts to service_role;
grant select, insert, update on public.assessment_attempts to app_owner; -- start/save/submit + auto-submit job

-- ─── attempt_answers (DD §3.4 — instructor ไม่มี SELECT ตรง (D15-N2)) ───
create policy aa_read_staff on public.attempt_answers for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin']));
-- ไม่มี policy ใดให้ผู้เรียนหรือ instructor (มีเฉลยใน question_snapshot) — อ่านผ่าน views (0009)
revoke all on public.attempt_answers from authenticated, anon;
grant select on public.attempt_answers to authenticated; -- ผ่าน policy aa_read_staff เท่านั้น
grant select, insert, update on public.attempt_answers to service_role;
grant select, insert, update on public.attempt_answers to app_owner; -- start/save/submit

-- M2/D18-M2: save_answer() (SECURITY DEFINER owner=app_owner) ต้อง UPDATE แถวได้
-- (RLS บังคับกับ definer ด้วย — ต้องมี UPDATE policy ให้ app_owner)
create policy aa_owner_update on public.attempt_answers for update to app_owner
  using (true) with check (true);

-- ─── certificates (RBAC §3.1 (7)) ───
create policy certs_owner_read on public.certificates for select to authenticated
  using (certificates.user_id = auth.uid()
         or public.has_any_role(array['staff:registrar','super_admin']));
revoke insert, update, delete, truncate on public.certificates from authenticated, anon;
revoke all on public.certificates from authenticated; -- เหลือ SELECT ผ่าน policy เดียว
grant select on public.certificates to authenticated;
grant select, insert, update on public.certificates to service_role; -- issue/revoke ผ่าน BFF + audit

-- ─── certificate_verifications (DD §3.4) ───
create policy cv_read on public.certificate_verifications for select to authenticated
  using (public.has_any_role(array['staff:registrar','super_admin']));
revoke all on public.certificate_verifications from authenticated, anon;
grant select on public.certificate_verifications to authenticated;
grant select, insert on public.certificate_verifications to service_role;

-- ─── credit_rules (DD §3.5 + RBAC §2.3) ───
create policy cr_read on public.credit_rules for select to authenticated
  using (public.has_any_role(array['lawyer'])
         or public.has_any_role(array['staff:viewer','staff:registrar','super_admin']));
create policy cr_insert on public.credit_rules for insert to authenticated
  with check (public.has_any_role(array['staff:registrar','super_admin']));
create policy cr_update on public.credit_rules for update to authenticated
  using (public.has_any_role(array['staff:registrar','super_admin']))
  with check (public.has_any_role(array['staff:registrar','super_admin']));
revoke all on public.credit_rules from authenticated;
grant select, insert, update on public.credit_rules to authenticated;
grant select, insert, update on public.credit_rules to service_role;

-- ─── renewal_cycles (DD §3.5) ───
create policy rc_read on public.renewal_cycles for select to authenticated
  using (renewal_cycles.user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:registrar','super_admin']));
revoke all on public.renewal_cycles from authenticated;
grant select on public.renewal_cycles to authenticated;
grant select, insert, update on public.renewal_cycles to service_role;

-- ─── credit_ledger_entries (RBAC §3.1 (8) — append-only) ───
create policy credits_self_read on public.credit_ledger_entries for select to authenticated
  using (credit_ledger_entries.user_id = auth.uid()
         or public.has_any_role(array['staff:registrar','staff:viewer','super_admin']));
revoke update, delete, truncate on public.credit_ledger_entries
  from authenticated, anon, service_role; -- ตรง DD §4.4 (D11-7)
revoke all on public.credit_ledger_entries from authenticated;
grant select on public.credit_ledger_entries to authenticated;
grant insert on public.credit_ledger_entries to service_role;
grant insert on public.credit_ledger_entries to app_owner;

-- ─── notifications / notification_recipients (RBAC §3.1 (10)) ───
create policy notif_read on public.notifications for select to authenticated
  using (exists (select 1 from public.notification_recipients nr
                 where nr.notification_id = notifications.id and nr.user_id = auth.uid()));
revoke all on public.notifications from authenticated;
grant select on public.notifications to authenticated;
grant select, insert, update on public.notifications to service_role;

create policy nr_owner_read on public.notification_recipients for select to authenticated
  using (notification_recipients.user_id = auth.uid());
create policy nr_owner_update on public.notification_recipients for update to authenticated
  using (notification_recipients.user_id = auth.uid())
  with check (notification_recipients.user_id = auth.uid());
revoke all on public.notification_recipients from authenticated;
grant select, update (read_at, deleted_at)
  on public.notification_recipients to authenticated; -- column protection (RBAC)
grant select, insert, update on public.notification_recipients to service_role;

-- ─── notification_settings (DD §3.6) ───
create policy ns_read on public.notification_settings for select to authenticated
  using (notification_settings.user_id = auth.uid());
revoke all on public.notification_settings from authenticated;
grant select on public.notification_settings to authenticated;
grant select, insert, update on public.notification_settings to service_role;

-- ─── notification_templates (DD §3.6) ───
create policy nt_read on public.notification_templates for select to authenticated
  using (public.has_any_role(array['staff:content','super_admin']));
create policy nt_insert on public.notification_templates for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin']));
create policy nt_update on public.notification_templates for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin']))
  with check (public.has_any_role(array['staff:content','super_admin']));
revoke all on public.notification_templates from authenticated;
grant select, insert, update on public.notification_templates to authenticated;
grant select, insert, update on public.notification_templates to service_role;

-- ─── email_outbox (DD §3.6 — PII: ไม่มี policy ใดให้ anon/authenticated) ───
revoke all on public.email_outbox from authenticated, anon;
grant select, insert, update on public.email_outbox to service_role;

-- ─── event_outbox (DD §3.6 — service เท่านั้น) ───
revoke all on public.event_outbox from authenticated, anon;
grant select, insert, update on public.event_outbox to service_role;
grant insert on public.event_outbox to app_owner; -- submit_attempt() เขียน event ใน TX เดียว

-- ─── report_exports (DD §3.7 — ขอบเขต report:view/export ตาม RBAC §2.4) ───
create policy re_read on public.report_exports for select to authenticated
  using (requested_by = auth.uid()
         or public.has_any_role(array['staff:viewer','super_admin'])
         or (public.has_any_role(array['staff:exam'])
             and report_type like 'exam%')
         or (public.has_any_role(array['staff:registrar'])
             and report_type like 'credit%'));
-- TODO(Wave C): ยืนยัน taxonomy ของ report_type ('exam*','credit*') กับ API-SPEC §3.8
revoke all on public.report_exports from authenticated;
grant select on public.report_exports to authenticated;
grant select, insert, update on public.report_exports to service_role;

-- ─── security_events (DD §3.8 — SELECT super_admin เท่านั้น) ───
create policy se_read on public.security_events for select to authenticated
  using (public.has_any_role(array['super_admin']));
revoke all on public.security_events from authenticated, anon;
grant select on public.security_events to authenticated;
grant select, insert on public.security_events to service_role;

-- ─── audit_logs (AUDIT §4 / RBAC §3.1 (9)) ───
create policy audit_read_admin on public.audit_logs for select to authenticated
  using (public.has_any_role(array['staff:viewer','super_admin']));
create policy audit_read_self on public.audit_logs for select to authenticated
  using (audit_logs.actor_user_id = auth.uid());
revoke all on public.audit_logs from authenticated;
grant select on public.audit_logs to authenticated;
-- INSERT เฉพาะผ่าน append_audit_event() (SECURITY DEFINER, owner app_owner) — D11-8
-- RLS บังคับกับ app_owner ด้วย (ไม่ใช่ table owner, ไม่มี BYPASSRLS) → ต้องมี policy + grant ให้ definer
create policy audit_insert_definer on public.audit_logs
  for insert to app_owner with check (true);
grant insert on public.audit_logs to app_owner;

-- ─── audit_chain_anchors (DD §3.8) ───
create policy aca_read on public.audit_chain_anchors for select to authenticated
  using (public.has_any_role(array['staff:viewer','super_admin']));
revoke all on public.audit_chain_anchors from authenticated, anon;
grant select on public.audit_chain_anchors to authenticated;
grant insert on public.audit_chain_anchors to service_role; -- anchor cron job

-- ═══ 5) purge_role — บทบาท retention (DD §4.3, §4.6 — ไม่ใช่ service_role) ═══
-- purge audit_logs เป็นงาน v1.1 (DD §4.6) — จึงไม่ grant delete บน audit_logs
grant delete on public.certificate_verifications,
  public.email_outbox, public.notifications, public.notification_recipients,
  public.event_outbox, public.security_events, public.report_exports,
  public.admin_sessions to purge_role;

-- M10/D18-M10: purge job ต้องอ่านก่อน purge (นับแถว/กรองตามอายุ retention — DD §4.6)
-- รวม learning records ที่ DD §4.6 กำหนด purge ด้วย purge_role + audit:
-- แถวที่ยังถูก certificates/credit_ledger_entries อ้าง FK = anonymize ไม่ใช่ delete
-- → learning records มีเฉพาะ SELECT (ไม่มี DELETE grant — ตามคำสั่ง D18-M10)
-- D20-M1: เติม 4 ตารางที่มี DELETE grant แต่ไม่มี SELECT (RLS กรองเป็น 0 แถว
-- = job อ่านเพื่อนับ/กรองอายุไม่ได้เลย): certificate_verifications, event_outbox,
-- report_exports, admin_sessions
grant select on public.security_events, public.audit_logs, public.email_outbox,
  public.event_outbox, public.notifications, public.notification_recipients,
  public.lesson_progress, public.quiz_attempts, public.assessment_attempts,
  public.attempt_answers, public.enrollments, public.certificate_verifications,
  public.report_exports, public.admin_sessions to purge_role;

-- ═══ 6) RLS สำหรับ role ภายใน (app_owner / purge_role) — plumbing ของ SECURITY DEFINER ═══
-- RLS บังคับกับ definer context ด้วย: app_owner ไม่ใช่ table owner และ hosted Supabase
-- ไม่อนุญาต ALTER ROLE ... BYPASSRLS (ต้อง superuser) → definer ต้องมี policy ของตัวเอง
-- ขอบเขต: SELECT+INSERT ทุกตาราง (server write path), UPDATE เฉพาะตารางที่ functions อัปเดต
-- (lesson_progress, assessment_attempts); ตาราง append-only **ไม่มี UPDATE/DELETE policy ให้ใคร**
-- และ trigger guard (§2) ยังบล็อก mutation แม้เป็น owner/superuser; client roles (anon/authenticated/
-- service_role) ไม่ได้รับสิทธิ์ใหม่ใด ๆ จากบล็อกนี้ (app_owner/purge_role เป็น NOLOGIN)
do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('create policy %I on public.%I for select to app_owner using (true)',
                   'app_owner_select_' || t, t);
    execute format('create policy %I on public.%I for insert to app_owner with check (true)',
                   'app_owner_insert_' || t, t);
  end loop;
end $$;

create policy app_owner_update_lesson_progress on public.lesson_progress
  for update to app_owner using (true) with check (true);
create policy app_owner_update_assessment_attempts on public.assessment_attempts
  for update to app_owner using (true) with check (true);

-- purge_role (retention — DD §4.3/§4.6): DELETE ตามตารางที่ grant ไว้ข้างบน
do $$
declare
  t text;
begin
  for t in
    select unnest(array['certificate_verifications','email_outbox','notifications',
                        'notification_recipients','event_outbox','security_events',
                        'report_exports','admin_sessions'])
  loop
    execute format('create policy %I on public.%I for delete to purge_role using (true)',
                   'purge_delete_' || t, t);
  end loop;
end $$;

-- D19-M2 + D20-M1: purge job ต้องอ่านก่อน purge (นับแถว/กรองตามอายุ retention — DD §4.6)
-- — grant SELECT มีแล้วแต่ไม่มี SELECT policy = RLS กรองเป็น 0 แถว: เติมให้ครบ
-- ครบทุกตารางที่ grant SELECT ให้ purge_role รวม 4 ตาราง delete-grant ของ D20-M1
do $$
declare
  t text;
begin
  for t in
    select unnest(array['security_events','audit_logs','email_outbox',
                        'event_outbox','notifications','notification_recipients',
                        'lesson_progress','quiz_attempts','assessment_attempts',
                        'attempt_answers','enrollments','certificate_verifications',
                        'report_exports','admin_sessions'])
  loop
    execute format('create policy %I on public.%I for select to purge_role using (true)',
                   'purge_select_' || t, t);
  end loop;
end $$;
