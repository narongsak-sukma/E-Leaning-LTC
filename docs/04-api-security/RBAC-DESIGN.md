# RBAC Design — LTC E-Learning

|          |                                                 |
| -------- | ----------------------------------------------- |
| เวอร์ชัน | 1.0.0 — ผ่าน CTO gate (codex รอบ 5: PASS — D17) · แก้ตาม D8–D16 · baseline สำหรับ Wave B |
| วันที่    | 2026-09-09                                      |
| อ้างอิง  | PROJECT-BRIEF.md §4 (บทบาท seed), §5 (โดเมน), §8 (security) · API-SPECIFICATION.md · AUDIT-LOG-DESIGN.md · DATA-DICTIONARY.md · SRS.md (Appendix A) |

---

## 1. แบบจำลองบทบาท (Role Model)

### 1.1 รายการบทบาท

| บทบาท | ใคร | ขอบเขตตามหลัก least privilege | MFA |
| --- | --- | --- | --- |
| `guest` | ผู้เยี่ยมชมไม่มีบัญชี | อ่าน catalog หลักสูตร published + ตรวจสอบประกาศนียบัตรสาธารณะ เท่านั้น | ไม่บังคับ |
| `citizen` | ประชาชนทั่วไปที่สมัครแล้ว | จัดการโปรไฟล์ตัวเอง ลงทะเบียน/เรียนหลักสูตรสาธารณะ สอบ (ถ้าหลักสูตรเปิดให้) ดู transcript/ประกาศนียบัตรตัวเอง | ไม่บังคับ (สมัครได้) |
| `lawyer` | ทนายความที่ผูก+ยืนยันเลขที่ใบอนุญาตแล้ว | ทุกอย่างที่ citizen ได้ (กำหนด explicit) + หลักสูตรเฉพาะทนาย + ดู credit bank ตัวเองตามรอบต่ออายุ | ไม่บังคับ (แนะนำ) |
| `instructor` | วิทยากร (มักซ้อนกับ `lawyer`) | สร้าง/แก้หลักสูตร+บทเรียน+ธนาคารข้อสอบ **ที่ตัวเองเป็นเจ้าของ** เป็น draft — เผยแพร่ต้องผ่าน staff:content | บังคับ |
| `staff:viewer` | เจ้าหน้าที่ฝ่ายรายงาน (read-only) | อ่านข้อมูลปฏิบัติการ (ผู้ใช้ หลักสูตร ผลสอบ credit) + export รายงาน — **ห้ามแก้ข้อมูลจริงทุกตาราง** | บังคับ |
| `staff:content` | เจ้าหน้าที่ดูแลเนื้อหา | อนุมัติ/เผยแพร่/ถอนเผยแพร่หลักสูตร จัดการโครงสร้างหลักสูตรทั้งหมด — ไม่แตะข้อสอบ/ผู้ใช้/credit | บังคับ |
| `staff:exam` | เจ้าหน้าที่ดูแลการสอบ | จัดการธนาคารข้อสอบ/ชุดข้อสอบ/กติกา ดู-ตรวจ-override ผลสอบ — ไม่ออกประกาศนียบัตร ไม่แตะ credit | บังคับ |
| `staff:registrar` | นายทะเบียน | ยืนยันใบอนุญาต+มอบบทบาท `lawyer` (บางส่วน) ออก/เพิกถอนประกาศนียบัตร จัดการกฎ+การปรับ credit | บังคับ |
| `super_admin` | ผู้ดูแลสูงสุด (จำนวนน้อยมาก) | ทุก action รวมถึงมอบ/ถอนบทบาท, สร้างบัญชีเจ้าหน้าที่, export audit — ใช้เมื่อจำเป็นเท่านั้น ทุก action ของ super_admin ถูก audit ระดับ NOTICE ขึ้นไป | บังคับ + ต้องมี ≥ 2 บัญชีเสมอ |

### 1.2 กฎเชิงโครงสร้าง (binding)

1. **หลายบทบาทต่อบัญชีได้** — เก็บแบบ set ใน `role_assignments (user_id, role, granted_by, granted_at, revoked_at)` (ชื่อตารางตาม DATA-DICTIONARY.md); บัญชี "ทนายความที่เป็นวิทยากร" = `{lawyer, instructor}`
2. **ไม่สืบทอดโดย implication** — การได้ `lawyer` ไม่ได้ทำให้ได้สิทธิ์ของ `citizen` โดยอัตโนมัติ; ทุกบทบาทผูก permission แบบ explicit (ตาราง §2) — ตรวจง่าย audit ได้
3. **สิทธิ์รวมกันแบบ union** — บัญชีมีหลายบทบาท → สิทธิ์ = ยูเนียนของ permission ทุกบทบาท (ไม่มี deny-override ใน v1 — ถ้าต้องการ ยื่น DCR)
4. **ตรวจที่ระดับ permission ไม่ใช่ชื่อบทบาท** — โค้ดเรียก `requirePermission("certificate:issue")` เท่านั้น; ห้าม `requireRole("staff:registrar")` เพื่อให้เปลี่ยนแปลงบทบาทได้โดยไม่แก้โค้ด
5. **สิทธิ์เจ้าของ (ownership)** — บาง permission ทำงานคู่เงื่อนไข owner (`course:update` สำหรับ instructor = เฉพาะ course ที่ตัวเองเป็น `created_by`) — บังคับซ้ำที่ RLS เสมอ

---

## 2. Permission Matrix (resource × action × บทบาท)

สัญลักษณ์: ✓ = อนุญอต · O = เฉพาะทรัพยากรของตัวเอง (owner) · P = public ไม่ต้องมีบทบาท · — = ปฏิเสธ
บทบาทย่อ: gu=guest, ci=citizen, la=lawyer, ins=instructor, sv=staff:viewer, sc=staff:content, se=staff:exam, sr=staff:registrar, sa=super_admin

### 2.1 Course / Lesson (โดเมน 2–3)

| Resource:Action | gu | ci | la | ins | sv | sc | se | sr | sa |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| course:view (published) | P | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| course:view (draft) | — | — | — | O | ✓ | ✓ | — | — | ✓ |
| course:create | — | — | — | ✓ | — | ✓ | — | — | ✓ |
| course:update | — | — | — | O | — | ✓ | — | — | ✓ |
| course:delete (soft) | — | — | — | — | — | ✓ | — | — | ✓ |
| course:publish (อนุมัติเผยแพร่) | — | — | — | — | — | ✓ | — | — | ✓ |
| lesson:view (เนื้อหา) | — | ✓* | ✓* | O | ✓ | ✓ | ✓ | ✓ | ✓ |
| lesson:update | — | — | — | O | — | ✓ | — | — | ✓ |
| enroll:create (ตัวเอง) | — | ✓ | ✓ | ✓ | — | — | — | — | ✓ |

*lesson:view ต้องมี enrollment ที่สถานะ active ของหลักสูตรนั้น (ตรวจซ้ำที่ RLS)

### 2.2 Question Bank / Assessment / Attempt (โดเมน 4)

| Resource:Action | gu | ci | la | ins | sv | sc | se | sr | sa |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| question_bank:view | — | — | — | O | ✓ | — | ✓ | — | ✓ |
| question_bank:create | — | — | — | ✓ | — | — | ✓ | — | ✓ |
| question_bank:update | — | — | — | O | — | — | ✓ | — | ✓ |
| question_bank:delete | — | — | — | — | — | — | ✓ | — | ✓ |
| assessment:view (กติกา) | — | ✓* | ✓* | O | ✓ | — | ✓ | ✓ | ✓ |
| assessment:create | — | — | — | ✓(draft) | — | — | ✓ | — | ✓ |
| assessment:update | — | — | — | O(draft) | — | — | ✓ | — | ✓ |
| assessment:approve (เปิดใช้จริง) | — | — | — | — | — | — | ✓ | — | ✓ |
| attempt:start (ตัวเอง) | — | ✓ | ✓ | ✓ | — | — | — | — | ✓ |
| attempt:view (ตัวเอง) | — | ✓ | ✓ | ✓ | — | — | — | — | ✓ |
| attempt:view (ทุกคน) | — | — | — | O† | ✓ | — | ✓ | ✓ | ✓ |
| attempt:grade_override | — | — | — | — | — | — | ✓ | — | ✓ |

*assessment:view แบบผู้เรียน = เห็นเฉพาะเมื่อมีสิทธิ์เข้าสอบ (จบเงื่อนไขหลักสูตร)
†attempt:view แบบ instructor = เฉพาะ attempt ของ assessment ที่อยู่ในหลักสูตรที่ตนเป็นเจ้าของ (`courses.created_by`) — ผู้สอนต้องเห็นผลของรอบสอบที่ตนดูแลเพื่อปรับปรุงเนื้อหา (canonical ตาม policy attempts_owner_read — D14/D13-F5); แถว attempt_answers ยังติด answer-key deny (อ่านผ่าน projection เท่านั้น — `instructor_attempt_view` DD §3.4, D12-2/D15-N2) และ grade_override ยังเป็นของ staff:exam เท่านั้น (SoD)

### 2.3 Certificate / Credit (โดเมน 4–5)

| Resource:Action | gu | ci | la | ins | sv | sc | se | sr | sa |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| certificate:verify (public) | P | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| certificate:view (ตัวเอง) | — | ✓ | ✓ | ✓ | — | — | — | — | ✓ |
| certificate:issue | — | — | — | — | — | — | — | ✓ | ✓ |
| certificate:revoke | — | — | — | — | — | — | — | ✓ | ✓ |
| credit_rule:view | — | — | — | — | ✓ | — | — | ✓ | ✓ |
| credit_rule:create | — | — | — | — | — | — | — | ✓ | ✓ |
| credit_rule:update | — | — | — | — | — | — | — | ✓(draft) | ✓ |
| credit_ledger:view (ตัวเอง) | — | — | ✓ | ✓ | — | — | — | — | ✓ |
| credit_ledger:view (ผู้อื่น) | — | — | — | — | ✓ | — | — | ✓ | ✓ |
| credit_adjustment:create | — | — | — | — | — | — | — | ✓ | ✓ |

### 2.4 Users / Roles / Audit / Reports / Notifications (โดเมน 1, 7, 8)

| Resource:Action | gu | ci | la | ins | sv | sc | se | sr | sa |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| user:view (ตัวเอง) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| user:view (ผู้อื่น — PII) | — | — | — | — | ✓ | — | — | ✓ | ✓ |
| user:create (บัญชีเจ้าหน้าที่) | — | — | — | — | — | — | — | — | ✓ |
| user:update (ข้อมูลสมาชิก) | — | — | — | — | — | — | — | ✓ | ✓ |
| user:disable | — | — | — | — | — | — | — | — | ✓ |
| license:verify (อนุมัติ) | — | — | — | — | — | — | — | ✓ | ✓ |
| role:grant (lawyer หลังยืนยัน) | — | — | — | — | — | — | — | ✓ | ✓ |
| role:grant (ทุกบทบาท) | — | — | — | — | — | — | — | — | ✓ |
| role:revoke | — | — | — | — | — | — | — | ✓(lawyer เท่านั้น) | ✓ |
| audit_log:view (ทั้งหมด) | — | — | — | — | ✓(อ่านอย่างเดียว) | — | — | — | ✓ |
| audit_log:view (activity ตัวเอง) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| audit_log:export | — | — | — | — | — | — | — | — | ✓ |
| report:view | — | — | — | — | ✓ | — | se: ผลสอบ | sr: credit | ✓ |
| report:export | — | — | — | — | ✓ | — | ✓(ผลสอบ) | ✓(credit) | ✓ |
| notification:view/read (ตัวเอง) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| notification:send (ระบบ→ผู้ใช้) | — | — | — | — | — | — | — | ✓ | ✓ |

ข้อสังเกต: ไม่มีบทบาทใด (รวมถึง super_admin) มี `audit_log:update/delete` — ไม่มี permission นี้อยู่ในระบบเลย (BRIEF §8, CTO decision D6)

### 2.5 นโยบาย admin shell (D55-3 · DCR-7)

พื้นที่ `/admin/*` (admin shell ตาม DESIGN-SYSTEM §6.3) = บทบาท `staff:viewer`/`staff:content`/`staff:exam`/`staff:registrar`/`super_admin` เท่านั้น — guard ที่ `src/app/(admin)/layout.tsx` (fail-closed redirect) · บทบาท instructor แม้ RBAC matrix §2.2 ให้สิทธิ์ `question_bank:*/assessment:*` (ใช้ได้ผ่าน BFF endpoints ตาม matrix) แต่ **ไม่เข้า admin shell** — instructor workspace จะเป็น UI แยกในอนาคต (ไม่ใช่ /admin/*) เหตุผล: sidebar ของ shell เป็น static ไม่กรองตามสิทธิ์ (เปิดให้ instructor = เห็นลิงก์ที่กดแล้วโดนปฏิเสธทั้งแถบ) + โครง shell ออกแบบสำหรับเจ้าหน้าที่ — **ห้ามแก้แถว matrix เดิมใด ๆ ตามข้อนี้** (สิทธิ์ instructor ใน matrix §2.1–2.4 คงเดิมทั้งหมด)

---

## 3. การบังคับใช้ 3 ชั้น (Defense in Depth)

| ชั้น | ที่ไหน | ทำอะไร | ข้อจำกัดที่ยอมรับ |
| --- | --- | --- | --- |
| 1. UI | React component / RSC | ซ่อนปุ่ม-เมนู-ลิงก์ที่ไม่มีสิทธิ์, แสดงสถานะ read-only | ป้องกัน UX สับสนเท่านั้น — **ไม่ใช่ความปลอดภัย** |
| 2. BFF middleware | Next.js Route Handlers `/api/v1/*` + Server Actions | `requirePermission()` ทุก request: อ่าน session → โหลด roles → map permission → allow/deny (403 ERR-RBAC-001) + zod validate | เป็นชั้นหลักของ logic; service_role key อยู่แค่ฝั่งนี้ |
| 3. RLS (PostgreSQL) | ทุกตาราง (BRIEF §6) | จำกัดแถว/คอลัมน์ที่ระดับ DB — กัน BFF โดนช่องโหว่/โค้ดหลุด | ต้องทดสอบร่วมกับชั้น 2 (Test Plan) |

หลักการ: ชั้น 2 และ 3 ต้องเขียนนโยบาย "ตรงกัน" — ถ้าเพิ่ม permission ใหม่ ต้องเพิ่มทั้ง middleware และ policy (review คู่กันเสมอ)

### 3.1 ตัวอย่างนโยบาย RLS (SQL — ที่มาของ migration จริง Wave B+)

หลักการแก้ D11-3/D11-4/D11-5: ทุก policy **แยกตาม operation** (SELECT/INSERT/UPDATE — ไม่ใช้ `FOR ALL`) · column protection สำหรับคอลัมน์ server-controlled ด้วย column-level GRANT + trigger guard · ชื่อตาราง/คอลัมน์ใน policy อ้าง DATA-DICTIONARY.md เป็น canonical · ทุก policy **derive ตรงจาก permission matrix §2** (D11-4) — ถ้า matrix เปลี่ยน ต้องแก้ policy คู่กันเสมอ

```sql
-- ═══ Canonical helper set (B-02) — DATA-DICTIONARY / AUDIT-LOG-DESIGN / ARCHITECTURE อ้างชุดนี้ ═══
-- ตารางบทบาทใช้ชื่อตาม DATA-DICTIONARY.md: role_assignments (B-03)
create or replace function public.my_roles() returns text[]
language sql stable security definer as $$
  select coalesce(array_agg(role), '{}') from public.role_assignments
  where user_id = auth.uid() and revoked_at is null;
$$;

create or replace function public.has_any_role(roles text[]) returns boolean
language sql stable security definer as $$
  select public.my_roles() && roles;
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer as $$
  select public.has_any_role(array['staff:viewer','staff:content',
                                  'staff:exam','staff:registrar','super_admin']);
$$;

-- (1) profiles (D11-3/D11-4): แยก operation + column protection (owner แก้ได้เฉพาะคอลัมน์ที่กำหนด)
alter table public.profiles enable row level security;
create policy profiles_read on public.profiles for select to authenticated
  using (profiles.id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:registrar','super_admin'])); -- D11-4: เฉพาะ staff ที่งานเกี่ยวข้อง ไม่ใช่ทุก staff (ตรง §2.4 user:view ผู้อื่น — PII)
create policy profiles_update_owner on public.profiles for update to authenticated
  using (profiles.id = auth.uid()) with check (profiles.id = auth.uid());
revoke all on public.profiles from authenticated;
grant select, update (display_name, phone, preferred_locale, pdpa_consented_at) on public.profiles to authenticated; -- column protection ตาม DD §3.1
-- INSERT/DELETE ไม่มี policy (สร้างโดย trigger security definer; ไม่มี hard delete)

-- (2) courses (D11-3): แยก operation — instructor เจ้าของ INSERT/UPDATE ได้ แต่ publish = staff:content เท่านั้น
--     เจ้าของหลักสูตรอ้างคอลัมน์ courses.created_by (DD §3.2 — เพิ่มแล้วโดย DCR-3, 2026-09-08)
create policy courses_public_read on public.courses for select to anon, authenticated
  using (status = 'published'
         and (is_public or public.has_any_role(array['lawyer'])));
create policy courses_owner_read on public.courses for select to authenticated
  using (created_by = auth.uid());
create policy courses_staff_read on public.courses for select to authenticated
  using (public.has_any_role(array['staff:viewer','staff:content','super_admin'])); -- D13-F5: ตรง matrix §2.1 course:view(draft) = sv/sc/sa เท่านั้น (is_staff() กว้างเกิน — se/sr อ่าน draft ไม่ได้)
create policy courses_owner_insert on public.courses for insert to authenticated
  with check (courses.created_by = auth.uid()
              and public.has_any_role(array['instructor'])
              and courses.status in ('draft','pending_review')); -- D12-5: role gate + status gate (publish = staff:content เท่านั้น)
create policy courses_staff_insert on public.courses for insert to authenticated
  with check (public.has_any_role(array['staff:content','super_admin']));
create policy courses_owner_update on public.courses for update to authenticated
  using (courses.created_by = auth.uid()
         and public.has_any_role(array['instructor'])
         and courses.status in ('draft','pending_review'))
  with check (courses.created_by = auth.uid()
              and public.has_any_role(array['instructor'])
              and courses.status in ('draft','pending_review')); -- D12-5; ใช้ค่า enum จริงของ DD course_status ('pending_review')
create policy courses_staff_update on public.courses for update to authenticated
  using (public.has_any_role(array['staff:content','super_admin']))
  with check (public.has_any_role(array['staff:content','super_admin']));
-- publish (status → 'published') = staff:content/super_admin เท่านั้น (§2.1 course:publish — SoD)
--   RLS ไม่เห็น OLD/NEW พร้อมกัน จึงบังคับ transition ด้วย trigger guard (DD §4.2) + requirePermission("course:publish") ที่ BFF

-- (3) enrollments (D12-1): ผู้เรียนเหลือ SELECT เท่านั้น — INSERT/UPDATE ไม่มี policy ใด ๆ
--     เขียนผ่าน SECURITY DEFINER functions (enroll — รายชื่อ canonical ที่ DD §3.2) เท่านั้น (D12-1 BLOCKER F2)
create policy enrollments_owner_read on public.enrollments for select to authenticated
  using (enrollments.user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','super_admin'])
         or exists (select 1 from public.courses c
                    where c.id = enrollments.course_id and c.created_by = auth.uid())); -- instructor เจ้าของหลักสูตร (ตาม DD §3.2)
revoke update, delete, insert on public.enrollments from authenticated, anon; -- server-controlled (D12-1)

-- (4) lesson_progress (D11-5 + D12-1): ตารางนี้ไม่มีคอลัมน์ user_id (ตาม DD §3.3) — เจ้าของอ้างผ่าน enrollment;
--     ผู้เรียนเหลือ SELECT — เขียนผ่าน SECURITY DEFINER function `record_lesson_progress` เท่านั้น (D12-1)
create policy lp_owner_read on public.lesson_progress for select to authenticated
  using (exists (select 1 from public.enrollments e
                 where e.id = lesson_progress.enrollment_id and e.user_id = auth.uid())
         or public.has_any_role(array['staff:viewer','super_admin'])
         or exists (select 1 from public.enrollments e
                    join public.courses c on c.id = e.course_id
                    where e.id = lesson_progress.enrollment_id and c.created_by = auth.uid()));
revoke insert, update, delete on public.lesson_progress from authenticated, anon; -- เขียนผ่าน function เท่านั้น (D12-1)

-- (5) questions (D11-4/D11-5 + D12-5): ชื่อคอลัมน์ตาม DD — questions.bank_id (ไม่ใช่ question_bank_id)
--     instructor เห็นเฉพาะ bank ที่ตัวเองเป็นเจ้าของ (question_banks.created_by — DD §3.4, เพิ่มแล้วโดย DCR-3)
--     ผู้เรียนไม่มี policy ใด ๆ (D12-2 BLOCKER F4: ห้าม SELECT raw — อ่านผ่าน projection view ที่ตัด is_correct/explanation
--     จนครบเงื่อนไขเปิดเฉลย ตาม DD); q_read เพิ่ม staff:viewer ตาม DD §3.4 (D12-5)
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
-- q_update with check ครอบ "destination bank" ด้วย (D12-5) — ย้ายข้อสอบไป bank ที่ตัวเองไม่เป็นเจ้าของไม่ได้
-- เปลี่ยน status → 'active' = staff:exam/super_admin เท่านั้น (ตาม DD §3.4) — บังคับซ้ำด้วย trigger guard + BFF
-- DELETE ไม่มี policy (ใช้ status='retired')

-- (6) assessment_attempts (D12-1/D12-5): ผู้เรียนเหลือ SELECT (metadata) เท่านั้น — เริ่ม/บันทึก/ส่งข้อสอบ
--     ผ่าน SECURITY DEFINER functions (start_attempt, save_answer, submit_attempt — DD) เท่านั้น (D12-1 BLOCKER F2);
--     read เพิ่ม staff:viewer/super_admin ตาม DD (D12-5) + D12-21: session_id/lease_expires_at บนตารางนี้ (ASM-011)
create policy attempts_owner_read on public.assessment_attempts for select to authenticated
  using (assessment_attempts.user_id = auth.uid()
         or public.has_any_role(array['staff:viewer','staff:exam','staff:registrar','super_admin'])
         or exists (select 1 from public.enrollments e
                    join public.courses c on c.id = e.course_id
                    where e.id = assessment_attempts.enrollment_id and c.created_by = auth.uid()));
revoke insert, update, delete on public.assessment_attempts from authenticated, anon; -- server-controlled (D12-1)

-- (6b) quiz_attempts / attempt_answers (D12-1/D12-2 BLOCKER F2+F4) — หมายเหตุแทน policy:
--   • ผู้เรียน **ไม่มี INSERT/UPDATE policy** บน quiz_attempts — บันทึกผลผ่าน `record_quiz_attempt` เท่านั้น
--   • ผู้เรียน **ไม่มี SELECT ตรง** บน attempt_answers (มี answer key ใน question_snapshot/is_correct) —
--     อ่านผ่าน projection view ของ DD (ตัด is_correct/explanation/snapshot จนครบเงื่อนไขเปิดเฉลย)
--   • การเขียนทั้งหมดเป็นของ server functions ที่ DD ระบุ (save_answer ฯลฯ) — owner เฉพาะ + audit ภายใน function

-- (7) certificates (D11-14): SELECT เจ้าของ/registrar; INSERT/UPDATE เป็นของ server (D11-1)
create policy certs_owner_read on public.certificates for select to authenticated
  using (certificates.user_id = auth.uid()
         or public.has_any_role(array['staff:registrar','super_admin']));
revoke insert, update, delete, truncate on public.certificates from authenticated, anon;
-- public verify ผ่าน view เท่านั้น — 4 คอลัมน์เท่านั้น (D11-14) แมพจากคอลัมน์จริงของ DD §3.4:
--   cert_no → code, course_title_snapshot → course_title, issued_at, status
create view public.certificate_public_view
  with (security_invoker = false) as
  select cert_no as code,
         course_title_snapshot as course_title,
         issued_at,
         status
  from public.certificates;
-- status ∈ valid|revoked|superseded (DD certificate_status); กรณี "ไม่พบ" BFF สังเคราะห์ 200 + status="not_found" (ไม่เปิดเผยการมีอยู่)
-- การค้นด้วย verify_code (QR) ทำที่ BFF ผ่าน server function ที่คืน 4 ฟิลด์เดียวกัน — view ยังคง 4 คอลัมน์เสมอ

-- (8) credit_ledger_entries (ชื่อตาม DATA-DICTIONARY.md — B-03): append-only สำหรับระบบ;
--     เจ้าของ/registrar/staff:viewer/super_admin อ่านได้; ไม่มีใคร update/delete/truncate
create policy credits_self_read on public.credit_ledger_entries for select to authenticated
  using (credit_ledger_entries.user_id = auth.uid()
         or public.has_any_role(array['staff:registrar','staff:viewer','super_admin']));
revoke update, delete, truncate on public.credit_ledger_entries from authenticated, anon, service_role; -- ตรง DD §4.4 (D11-7)

-- (9) audit_logs: เขียนผ่าน append_audit_event() SECURITY DEFINER เท่านั้น (D11-8 — ห้าม direct INSERT แม้ service_role);
--     อ่านได้ตาม AUDIT-LOG-DESIGN.md §4
create policy audit_read_admin on public.audit_logs for select to authenticated
  using (public.has_any_role(array['staff:viewer','super_admin']));
create policy audit_read_self on public.audit_logs for select to authenticated
  using (audit_logs.actor_user_id = auth.uid()); -- ชื่อคอลัมน์ตาม DD §3.8 (D11-6) + qualify (D12-6)
revoke update, delete, truncate on public.audit_logs from anon, authenticated, service_role; -- D11-7
-- INSERT ไม่มี policy/grant ให้ client role ใด (เขียนเฉพาะใน security definer function)

-- (10) notifications (D11-5): ผู้รับอยู่ที่ notification_recipients.user_id (ตาม DD §3.6)
create policy notif_read on public.notifications for select to authenticated
  using (exists (select 1 from public.notification_recipients nr
                 where nr.notification_id = notifications.id and nr.user_id = auth.uid())); -- qualify ครบ (D12-6)
create policy nr_owner_read on public.notification_recipients for select to authenticated
  using (notification_recipients.user_id = auth.uid());
create policy nr_owner_update on public.notification_recipients for update to authenticated
  using (notification_recipients.user_id = auth.uid())
  with check (notification_recipients.user_id = auth.uid());
revoke all on public.notification_recipients from authenticated;
grant select, update (read_at, deleted_at) on public.notification_recipients to authenticated; -- column protection
-- INSERT ทั้งสองตาราง = service_role ผ่าน BFF (ไม่มี policy ให้ authenticated)
```

---

## 4. การออก/ถอนบทบาท + Session Policy

### 4.1 ใครมอบ/ถอนอะไรได้

| การเปลี่ยน | ผู้อนุญัติ | เงื่อนไข |
| --- | --- | --- |
| มอบ `lawyer` | `staff:registrar`, `super_admin` | หลังตรวจเลขที่ใบอนุญาตผ่าน (license:verify) |
| มอบ/ถอน `instructor` | `super_admin` เท่านั้น | มีเอกสารมอบหมายจากสภาฯ (เก็บ reason) |
| มอบ/ถอน `staff:viewer|content|exam|registrar` | `super_admin` เท่านั้น | MFA state machine เดียวกับ §4.2 (D12-10) — **grant ได้แม้ยังไม่มี MFA (IDENT-006)** แต่บัญชีเข้า state **enrollment-only** ทันทีเมื่อ login ถัดไป; protected request ใด ๆ ตอบ ERR-AUTH-004 จนกว่า state = verified |
| มอบ/ถอน `super_admin` | `super_admin` อีกบัญชี (ต้อง ≥ 2 คนเห็นชอบนอกระบบ — บันทึกอ้างอิงใน reason) | จำนวน super_admin พร้อมกัน ≥ 2 เสมอ |
| ถอนบทบาทตัวเอง | ห้าม | กัน lockout ตัวเอง |

ทุกการมอบ/ถอน → **audit `ROLE_GRANT`/`ROLE_REVOKE` พร้อม granted_by + reason (บังคับ)** และบังคับ session refresh ทันที (role เปลี่ยนมีผล request ถัดไป — revoke ตัด session ปัจจุบันทันที)

### 4.2 Session & Lockout policy (ชุดที่ตัดสินแล้ว — ตรงกับ SRS Appendix A)

| นโยบาย | ค่าที่ตัดสิน | หมายเหตุ |
| --- | --- | --- |
| Session idle timeout — ผู้เรียน | **60 นาที** | config `SESSION_IDLE_MINUTES_LEARNER` |
| Session idle timeout — staff (ทุก sub-role) | **15 นาที** | config `SESSION_IDLE_MINUTES_STAFF` |
| **MFA state machine (เดียวทั้งระบบ — D12-10)** | states: `none` → `enrollment-only` → `verified` | transitions: login (password ผ่าน, ยังไม่มี MFA) → **enrollment-only** — allowlist = `/auth/mfa/enroll` + `/auth/mfa/verify` + **`/auth/logout` (ทุก state)** + **`GET /me` (read-only — ดูข้อมูลตัวเองได้ แก้ไม่ได้; ตรง SRS AUTH-007 — D13-F8)**; enroll+verify สำเร็จ → **verified**; ทุก protected request เช็ค claim `mfa_verified` ทุกครั้ง (D11-11) |
| MFA บังคับกับใคร | instructor / staff ทุกระดับ / super_admin (TOTP) | บัญชีบังคับ MFA ที่ยังไม่ verified = state enrollment-only ทุก login (ERR-AUTH-004) |
| ปิด MFA (`/auth/mfa/disable`) | **v1: เฉพาะบัญชี citizen/lawyer (MFA optional)** | เงื่อนไข: recent-MFA (≤ 15 นาที) + ห้ามเหลือ 0 factor; **บัญชี staff/instructor/super_admin block ใน v1** ตาม API §3.1; audit `AUTH_MFA_DISABLED` (WARN) |
| Absolute timeout | 12 ชม. (ผู้เรียน) / 8 ชม. (staff) | บังคับ login ใหม่ |
| Lockout หลังพลาดรหัสผ่าน | 5 ครั้ง / ล็อก 15 นาที (ต่อบัญชี+IP) | ERR-AUTH-003; audit `AUTH_LOCKOUT` |
| รหัสผ่าน | ≥ 12 ตัวอักษร + ตรวจ breached-password list | นโยบายอยู่ที่ Supabase Auth config |

---

## 5. Separation of Duties (SoD)

| หน้าที่ A (แตะได้) | หน้าที่ B (ห้ามแตะพร้อมกัน) | เหตุผล |
| --- | --- | --- |
| สร้าง/แก้เนื้อหา (`instructor`) | อนุมัติเผยแพร่เนื้อหา (`course:publish` = staff:content) | ผู้เขียนไม่อนุมัติผลงานตัวเอง |
| สร้าง/คัดข้อสอบ (`instructor`, `staff:exam`) | ออกประกาศนียบัตร (`certificate:issue` = staff:registrar) | คนตรวจไม่ใช่คนออกใบรับรอง |
| ตรวจ/override ผลสอบ (`staff:exam`) | ปรับ credit มือ (`credit_adjustment:create` = staff:registrar) | กันย้ายผลสอบ→คูณ credit ในมือเดียว |
| ปรับ credit (`staff:registrar`) | อ่าน audit log ทั้งหมดเพื่อปิดร่องรอย (`audit_log:export` = super_admin) | คนแก้ข้อมูลไม่ใช่คนเก็บหลักฐาน |
| มอบบทบาท (`super_admin`) | ปฏิเสธ — ไม่มีใคร "ปิด" audit ของตัวเองได้ | audit เป็น append-only สำหรับทุกบทบาท |

การบังคับ: คู่บทบาทต้องห้าม (เช่น `staff:exam` + `staff:registrar` ในบัญชีเดียว) ระบบ**เตือน + บังคับยืนยันจาก super_admin พร้อมเหตุผล** (ไม่ block ตายตัว เพราะทีมเล็กช่วงเริ่ม) — ทุกกรณีที่มีคู่ต้องห้าม flag `sod_exception=true` ใน audit `ROLE_GRANT`

---

## 6. ตารางทดสอบ RBAC (ตัวอย่าง test case — โยง TEST-PLAN.md)

| # | บทบาท | Action / Endpoint | คาดหวัง |
| --- | --- | --- | --- |
| T1 | guest | GET /api/v1/me | 401 ERR-AUTH-001 |
| T2 | guest | GET /api/v1/courses | 200 (เห็นเฉพาะ published) |
| T3 | citizen | POST /api/v1/admin/users/{id}/roles | 403 ERR-RBAC-001 |
| T4 | citizen | POST /api/v1/courses/{id}/enroll (หลักสูตรเฉพาะทนาย) | 422 ERR-ENR-002 |
| T5 | lawyer (ไม่มี citizen perm ขอ enroll หลักสูตรสาธารณะ) | POST /api/v1/courses/{id}/enroll | 201 — พิสูจน์ว่า explicit map ครบ (lawyer มี enroll:create เหมือน citizen โดย explicit ไม่ใช่ inheritance) |
| T6 | instructor (เจ้าของ) | PATCH หลักสูตรของคนอื่น | 403/404 (RLS บัง) |
| T7 | instructor | PATCH /api/v1/admin/courses/{id} (publish) | 403 ERR-RBAC-001 — ผู้เขียนอนุมัติตัวเองไม่ได้ (SoD) |
| T8 | staff:content | POST /api/v1/credit-adjustments | 403 ERR-RBAC-001 |
| T9 | staff:exam | POST /api/v1/admin/certificates (ออกประกาศนียบัตร) | 403 ERR-RBAC-001 — SoD |
| T10 | staff:registrar | PATCH /api/v1/admin/question-banks/{id}/... | 403 ERR-RBAC-001 |
| T11 | staff:viewer | PATCH /api/v1/admin/users/{id} | 403 ERR-RBAC-001 (อ่านอย่างเดียว) |
| T12 | staff:viewer | GET /api/v1/admin/users | 200 + audit PII_ACCESS เกิด 1 รายการ |
| T13 | lawyer A | GET /api/v1/attempts/{ของ B}/result | 403/404 ERR-ASM-006 |
| T14 | ทุกบทบาท | POST/PUT/PATCH/DELETE ใด ๆ บน /api/v1/admin/audit-logs | 404 — route ไม่มีอยู่ (ไม่มี write path เลย) |
| T15 | staff:exam (ยังไม่ MFA) | POST /api/v1/auth/login | 200 — state = **enrollment-only**; `GET /api/v1/me` → **200 (allowlist รวม GET /me read-only — D13-F8)**; `PATCH /api/v1/me` → ERR-AUTH-004 (เช็ค claim ทุก request); `/auth/mfa/enroll`, `/auth/mfa/verify`, `/auth/logout` ยังใช้ได้ (allowlist รวม logout ทุก state — D12-10) |
| T16 | super_admin | DELETE /api/v1/admin/audit-logs/{id} | 404 — แม้ super_admin ก็ลบไม่ได้ |

หมายเหตุ: T14/T16 ทดสอบว่า "write path ไม่มีในระบบ" ซึ่งแรงกว่าการทดสอบ 403 — audit เป็น append-only โดยการออกแบบ (AUDIT-LOG-DESIGN.md §4)

---

## 7. เปิดประเด็น

| ประเด็น | สถานะ |
| --- | --- |
| บัญชีเจ้าหน้าที่ 1 คนถือหลาย sub-role (เช่น content+exam) — ยอมรับได้แค่ไหนในทีมเล็ก | เสนอ default: อนุญัติพร้อม flag SoD; เข้มงวดขึ้นเมื่อทีมโต (DCR) |
| การยืนยันตัวตนทนายผ่าน SSO ระบบสมาชิกสภาฯ (Q3) จะเพิ่มบทบาท/การ map แบบใหม่ | รอยืนยัน Q3 — โครง permission ไม่กระทบ (เพิ่มที่ชั้น identity) |
| ชื่อตาราง/คอลัมน์ในตัวอย่าง SQL ยึด DATA-DICTIONARY.md แล้ว (B-03: role_assignments, assessment_attempts, credit_ledger_entries) — คงตรวจซ้ำอีกครั้งเมื่อ DATA-DICTIONARY เปลี่ยนเวอร์ชัน | ปิดจาก A6 review |
| **คอลัมน์เจ้าของทรัพยากร** — `courses.created_by` และ `question_banks.created_by` ที่ policy §3.1 ใช้อ้าง "instructor เจ้าของ" (D11-5: policy ห้ามอ้างคอลัมน์ที่ไม่มีจริง) | **ปิดแล้ว — DCR-3 (2026-09-08):** DATA-DICTIONARY §3.2/§3.4 เพิ่มคอลัมน์ครบทั้งสองตาราง |
