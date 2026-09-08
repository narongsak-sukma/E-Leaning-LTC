# RBAC Design — LTC E-Learning

|          |                                                 |
| -------- | ----------------------------------------------- |
| เวอร์ชัน | 0.1.0 — Wave A (deliverable 9)                  |
| วันที่    | 2026-09-08                                      |
| อ้างอิง  | PROJECT-BRIEF.md §4 (บทบาท seed), §5 (โดเมน), §8 (security) · API-SPECIFICATION.md · AUDIT-LOG-DESIGN.md |

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

1. **หลายบทบาทต่อบัญชีได้** — เก็บแบบ set ใน `user_roles (user_id, role, granted_by, granted_at, revoked_at)`; บัญชี "ทนายความที่เป็นวิทยากร" = `{lawyer, instructor}`
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
| attempt:view (ทุกคน) | — | — | — | — | ✓ | — | ✓ | ✓ | ✓ |
| attempt:grade_override | — | — | — | — | — | — | ✓ | — | ✓ |

*assessment:view แบบผู้เรียน = เห็นเฉพาะเมื่อมีสิทธิ์เข้าสอบ (จบเงื่อนไขหลักสูตร)

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

---

## 3. การบังคับใช้ 3 ชั้น (Defense in Depth)

| ชั้น | ที่ไหน | ทำอะไร | ข้อจำกัดที่ยอมรับ |
| --- | --- | --- | --- |
| 1. UI | React component / RSC | ซ่อนปุ่ม-เมนู-ลิงก์ที่ไม่มีสิทธิ์, แสดงสถานะ read-only | ป้องกัน UX สับสนเท่านั้น — **ไม่ใช่ความปลอดภัย** |
| 2. BFF middleware | Next.js Route Handlers `/api/v1/*` + Server Actions | `requirePermission()` ทุก request: อ่าน session → โหลด roles → map permission → allow/deny (403 ERR-RBAC-001) + zod validate | เป็นชั้นหลักของ logic; service_role key อยู่แค่ฝั่งนี้ |
| 3. RLS (PostgreSQL) | ทุกตาราง (BRIEF §6) | จำกัดแถว/คอลัมน์ที่ระดับ DB — กัน BFF โดนช่องโหว่/โค้ดหลุด | ต้องทดสอบร่วมกับชั้น 2 (Test Plan) |

หลักการ: ชั้น 2 และ 3 ต้องเขียนนโยบาย "ตรงกัน" — ถ้าเพิ่ม permission ใหม่ ต้องเพิ่มทั้ง middleware และ policy (review คู่กันเสมอ)

### 3.1 ตัวอย่างนโยบาย RLS (SQL — ที่มาของ migration จริง Wave B+)

```sql
-- helper กลาง: คืนบทบาทของ user ปัจจุบันเป็น array (materialize ใน JWT claims ก็ได้ — ตัดสินตอน implement)
create or replace function public.my_roles() returns text[]
language sql stable security definer as $$
  select coalesce(array_agg(role), '{}') from public.user_roles
  where user_id = auth.uid() and revoked_at is null;
$$;

-- (1) profiles: เจ้าของอ่าน/แก้ตัวเองได้; staff:viewer/registrar/super_admin อ่านได้ (PII_ACCESS บันทึกที่ชั้น BFF)
alter table public.profiles enable row level security;
create policy profiles_self on public.profiles for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
create policy profiles_staff_read on public.profiles for select to authenticated
  using (my_roles() && array['staff:viewer','staff:registrar','super_admin']);

-- (2) courses: guest/anon อ่าน published; instructor แก้ได้เฉพาะที่ตัวเองสร้าง; staff:content ทุกแถว
create policy courses_public_read on public.courses for select to anon, authenticated
  using (status = 'published');
create policy courses_owner_write on public.courses for all to authenticated
  using (created_by = auth.uid() or my_roles() && array['staff:content','super_admin'])
  with check (created_by = auth.uid() or my_roles() && array['staff:content','super_admin']);

-- (3) enrollments: เห็น/แก้เฉพาะแถวของตัวเอง; staff อ่านได้
create policy enrollments_self on public.enrollments for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy enrollments_staff_read on public.enrollments for select to authenticated
  using (my_roles() && array['staff:viewer','staff:exam','staff:registrar','super_admin']);

-- (4) lesson_progress: เจ้าของเท่านั้น (แม้แต่ instructor ก็ไม่เห็นรายบุคคล — ดูได้ผ่าน report รวมเท่านั้น)
create policy lesson_progress_self on public.lesson_progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- (5) question_banks + questions: instructor เจ้าของ; staff:exam ทั้งหมด; ผู้เรียนไม่เห็นเด็ดขาด
--     (ผู้เรียนได้คำถามผ่าน attempt view ที่คัดแล้วเท่านั้น)
create policy qb_staff_exam on public.questions for all to authenticated
  using (my_roles() && array['staff:exam','super_admin']
         or (my_roles() && array['instructor'] and exists (
              select 1 from public.question_banks qb
              where qb.id = question_bank_id and qb.created_by = auth.uid())))
  with check (my_roles() && array['staff:exam','super_admin']);

-- (6) attempts: เจ้าของ; staff:exam/registrar/super_admin อ่าน — แต่ "ตอนสอบ" อ่านคำตอบไม่ได้จนกว่าจะ submit (เงื่อนไข status)
create policy attempts_self on public.attempts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy attempts_staff_read on public.attempts for select to authenticated
  using (my_roles() && array['staff:exam','staff:registrar','staff:viewer','super_admin']);

-- (7) certificates: เจ้าของเห็นของตัวเอง; registrar ทุกแถว; สาธารณะตรวจผ่าน view แยก (จำกัดคอลัมน์)
create policy certs_self on public.certificates for select to authenticated
  using (user_id = auth.uid() or my_roles() && array['staff:registrar','super_admin']);
create policy certs_registrar_write on public.certificates for insert to authenticated
  with check (my_roles() && array['staff:registrar','super_admin']);
-- public verify: ผ่าน view ไม่ใช่ตาราง (ไม่เปิด RLS ตรง table)
create view public.certificate_public_view
  with (security_invoker = false) as
  select code, holder_display_name, course_title, issued_at, status, revoked_at
  from public.certificates;

-- (8) credit_ledger: append-only สำหรับระบบ; เจ้าของอ่านได้; registrar/super_admin อ่านได้; ไม่มีใคร update/delete
create policy credits_self_read on public.credit_ledger for select to authenticated
  using (user_id = auth.uid() or my_roles() && array['staff:registrar','staff:viewer','super_admin']);
revoke update, delete on public.credit_ledger from authenticated, anon;

-- (9) audit_logs: แทรกได้เฉพาะ service_role (BFF); อ่านได้ตาม §ของ AUDIT-LOG-DESIGN.md
create policy audit_insert_service on public.audit_logs for insert to authenticated
  with check (false); -- service_role ไม่ถูก RLS บังคับ — นี่ปิดฝั่ง client
create policy audit_read_admin on public.audit_logs for select to authenticated
  using (my_roles() && array['staff:viewer','super_admin']);
create policy audit_read_self on public.audit_logs for select to authenticated
  using (actor_id = auth.uid());

-- (10) notifications: เจ้าของเท่านั้น
create policy notif_self on public.notifications for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

---

## 4. การออก/ถอนบทบาท + Session Policy

### 4.1 ใครมอบ/ถอนอะไรได้

| การเปลี่ยน | ผู้อนุญัติ | เงื่อนไข |
| --- | --- | --- |
| มอบ `lawyer` | `staff:registrar`, `super_admin` | หลังตรวจเลขที่ใบอนุญาตผ่าน (license:verify) |
| มอบ/ถอน `instructor` | `super_admin` เท่านั้น | มีเอกสารมอบหมายจากสภาฯ (เก็บ reason) |
| มอบ/ถอน `staff:viewer|content|exam|registrar` | `super_admin` เท่านั้น | บังคับ MFA ก่อนใช้งานบทบาทนั้น (login ถูก block ด้วย ERR-AUTH-004 จนกว่าจะ enrolled) |
| มอบ/ถอน `super_admin` | `super_admin` อีกบัญชี (ต้อง ≥ 2 คนเห็นชอบนอกระบบ — บันทึกอ้างอิงใน reason) | จำนวน super_admin พร้อมกัน ≥ 2 เสมอ |
| ถอนบทบาทตัวเอง | ห้าม | กัน lockout ตัวเอง |

ทุกการมอบ/ถอน → **audit `ROLE_GRANT`/`ROLE_REVOKE` พร้อม granted_by + reason (บังคับ)** และบังคับ session refresh ทันที (role เปลี่ยนมีผล request ถัดไป — revoke ตัด session ปัจจุบันทันที)

### 4.2 Session & Lockout policy (ค่า default — config ทั้งหมด)

| นโยบาย | ค่า default | หมายเหตุ |
| --- | --- | --- |
| Session idle timeout | ผู้เรียน 60 นาที / staff+instructor 15 นาที | config `SESSION_IDLE_MINUTES_BY_ROLE` |
| Absolute timeout | 12 ชม. (ผู้เรียน) / 8 ชม. (staff) | บังคับ login ใหม่ |
| Lockout หลังพลาดรหัสผ่าน | 5 ครั้ง / ล็อก 15 นาที (ต่อบัญชี+IP) | ERR-AUTH-003; audit `AUTH_LOCKOUT` |
| MFA สำหรับ staff/instructor/super_admin | บังคับ (TOTP) | ไม่ผ่าน MFA = ไม่ได้ token บทบาท staff (ERR-AUTH-004) |
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
| T9 | staff:exam | POST /api/v1/certificates (issue) | 403 ERR-RBAC-001 — SoD |
| T10 | staff:registrar | PATCH /api/v1/admin/question-banks/{id}/... | 403 ERR-RBAC-001 |
| T11 | staff:viewer | PATCH /api/v1/admin/users/{id} | 403 ERR-RBAC-001 (อ่านอย่างเดียว) |
| T12 | staff:viewer | GET /api/v1/admin/users | 200 + audit PII_ACCESS เกิด 1 รายการ |
| T13 | lawyer A | GET /api/v1/attempts/{ของ B}/result | 403/404 ERR-ASM-006 |
| T14 | ทุกบทบาท | POST/PUT/PATCH/DELETE ใด ๆ บน /api/v1/admin/audit-logs | 404 — route ไม่มีอยู่ (ไม่มี write path เลย) |
| T15 | staff:exam (ยังไม่ MFA) | POST /api/v1/auth/login | 200 แต่ token ไร้บทบาท staff + ERR-AUTH-004 เมื่อเรียก admin endpoint |
| T16 | super_admin | DELETE /api/v1/admin/audit-logs/{id} | 404 — แม้ super_admin ก็ลบไม่ได้ |

หมายเหตุ: T14/T16 ทดสอบว่า "write path ไม่มีในระบบ" ซึ่งแรงกว่าการทดสอบ 403 — audit เป็น append-only โดยการออกแบบ (AUDIT-LOG-DESIGN.md §4)

---

## 7. เปิดประเด็น

| ประเด็น | สถานะ |
| --- | --- |
| บัญชีเจ้าหน้าที่ 1 คนถือหลาย sub-role (เช่น content+exam) — ยอมรับได้แค่ไหนในทีมเล็ก | เสนอ default: อนุญัติพร้อม flag SoD; เข้มงวดขึ้นเมื่อทีมโต (DCR) |
| การยืนยันตัวตนทนายผ่าน SSO ระบบสมาชิกสภาฯ (Q3) จะเพิ่มบทบาท/การ map แบบใหม่ | รอยืนยัน Q3 — โครง permission ไม่กระทบ (เพิ่มที่ชั้น identity) |
| ชื่อ permission ต้องตรงกับ DATA-DICTIONARY.md (ตาราง user_roles) | ประสาน worker-3 |
