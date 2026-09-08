# DATA-DICTIONARY — พจนานุกรมข้อมูล (blueprint ของ `supabase/migrations/*`)

|          |                                                   |
| -------- | ------------------------------------------------- |
| เวอร์ชัน | 0.1.0                                             |
| วันที่    | 2026-09-08                                        |
| เจ้าของ  | worker-3 (Wave A — deliverable 7)                 |
| สถานะ    | รอ CTO gate                                       |
| อ้างอิงบังคับ | PROJECT-BRIEF.md §5 (8 โดเมน), §8 (RLS/PDPA/audit) |
| เอกสารเชื่อมโยง | SDS.md, ARCHITECTURE.md, RBAC-DESIGN.md, AUDIT-LOG-DESIGN.md |

> เอกสารนี้คือ blueprint เดียวของสคีมา — migration ทุกตัวต้องตรงกับนี่ทุกตาราง/คอลัมน์/index/policy; จะเพิ่ม/แก้ต้องผ่าน DCR

## 1. แบบแผนกลาง (ใช้กับทุกตาราง)

- **PK**: `id uuid NOT NULL DEFAULT gen_random_uuid()` — ยืนยันเป็น **UUID v4** (random, built-in ของ PG13+; ไม่ใช้ v7 ใน v1) (ระบุเฉพาะเมื่อต่างจากนี้)
- **เวลา**: `created_at timestamptz NOT NULL DEFAULT now()`; ตารางที่มี `updated_at` อัปเดตด้วย trigger `set_updated_at()` (ดู §4.2); เวลาทั้งหมดเป็น timestamptz (UTC)
- **Soft delete**: ตารางที่มี `deleted_at timestamptz NULL` = ห้าม hard delete ผ่านแอป — ดู §4.3; index ที่เกี่ยวกับ lookup ใช้ partial `WHERE deleted_at IS NULL`
- **FK**: `ON DELETE RESTRICT` เป็นค่าเริ่มต้น (รักษาประวัติ/audit — ไม่ cascade ทิ้งข้อมูลอ้างอิง) ยกเว้นระบุชัด
- **บทบาท DB**: `anon`, `authenticated`, `service_role` — BFF ใช้ `service_role` ฝั่ง server เท่านั้น; policy ที่เขียนด้านล่างมีผลกับ `anon`/`authenticated` (service_role bypass RLS แต่ทุกตารางยังต้อง enable + มี policy ครบ ตาม brief §8)
- **helper ของ RLS** (canonical set ตาม D8/B-02 — นิยามเต็มที่ RBAC-DESIGN.md §3.1): `auth.uid()`, `public.my_roles()`, `public.has_any_role(text[])`, `public.is_staff()` — policy ด้านล่างเรียก helper ชุดนี้เท่านั้น ห้ามเขียนเงื่อนไข role ซ้ำซ้อนแบบ inline
- ทุกตารางระบุ: วัตถุประสงค์ / คอลัมน์ / คีย์+index / นโยบาย RLS (ใครทำอะไรได้เงื่อนไขใด) / retention

## 2. ENUM Types

| ENUM | ค่า |
| ---- | -- |
| `role_key` | citizen, lawyer, instructor, staff:viewer, staff:content, staff:exam, staff:registrar, super_admin (colon ตาม brief §4 — Postgres enum label ใส่ ':' ได้) |
| `license_status` | pending, verified, rejected, expired |
| `course_status` | draft, pending_review, published, archived |
| `lesson_type` | video, document, quiz |
| `enrollment_status` | active, completed, expired, cancelled |
| `media_provider` | supabase_storage, r2, stream |
| `media_type` | video, document, image, other |
| `media_status` | uploading, processing, ready, failed |
| `progress_status` | not_started, in_progress, completed |
| `question_type` | single_choice, multiple_choice, true_false |
| `question_status` | draft, active, retired |
| `question_difficulty` | easy, medium, hard |
| `assessment_status` | draft, published, closed, archived |
| `attempt_status` | in_progress, submitted, passed, failed, expired, voided |
| `proctoring_mode` | none, basic (basic = สุ่มข้อ + จับเวลา + block session ซ้อน ตาม SRS Appendix A) |
| `certificate_status` | valid, revoked, superseded |
| `verification_result` | valid, revoked, superseded, not_found |
| `ledger_entry_type` | accrual, adjustment, reversal, expiry |
| `cycle_status` | open, closed, grace |
| `notification_channel` | in_app, email |
| `email_status` | queued, sending, sent, failed |
| `admin_session_end` | logout, timeout, revoke, rotation |
| `license_application_status` | pending, approved, rejected |
| `export_status` | queued, processing, completed, failed |
| `security_event_type` | login_fail, mfa_fail, lockout, rate_limit_hit, session_revoke |

## 3. ตารางตามโดเมน (37 ตาราง)

### 3.1 Identity & License

#### `profiles` — บัญชีผู้ใช้/ข้อมูลสมาชิก **(PII — PDPA)**

วัตถุประสงค์: ข้อมูลสมาชิก แยกจาก auth identity (auth.users) — สร้างอัตโนมัติโดย trigger `on_auth_user_created` (ดู §4.2)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| id | uuid | PK, = auth.users.id (1:1) |
| display_name | text | NOT NULL |
| first_name / last_name | text | NULL ได้ (เก็บน้อยที่สุด — ใช้เมื่อจำเป็นพิมพ์ใบประกาศ) |
| email | text | NOT NULL UNIQUE (มิเรอร์จาก auth เพื่อ query; ต้นทางคือ Supabase Auth) |
| phone | text | NULL, format E.164 |
| preferred_locale | text | NOT NULL DEFAULT 'th', CHECK IN ('th','en') |
| pdpa_consented_at | timestamptz | NULL — จะ NOT NULL เมื่อ flow consent ใช้งาน (SRS) |
| is_active | boolean | NOT NULL DEFAULT true |
| deleted_at | timestamptz | NULL (soft delete) |
คีย์/Index: UNIQUE(email) WHERE deleted_at IS NULL; INDEX(deleted_at)
RLS: **SELECT** เจ้าของแถว (`id = auth.uid()`) หรือ staff ทุกระดับ; **INSERT** ไม่เปิดทางแอป (ผ่าน trigger security definer + service_role เท่านั้น); **UPDATE** เจ้าของแถวได้เฉพาะ display_name/phone/preferred_locale/pdpa_consented_at (บังคับผ่าน BFF + trigger guard คอลัมน์), super_admin ได้ทุกคอลัมน์; **DELETE** ไม่อนุญาต
Retention: ตลอดอายุบัญชี + 10 ปีหลังลบ (PDPA + การเรียกร้องสิทธิ)

#### `lawyer_licenses` — การผูกเลขที่ใบอนุญาตว่าความ **(PII — PDPA)**

วัตถุประสงค์: ทะเบียนเลขที่ใบอนุญาตที่ "ผูกกับบัญชีและยืนยันแล้ว" — แถวถูกสร้างจากการอนุมัติ `license_applications` เท่านั้น (workflow Q3, default = เจ้าหน้าที่ตรวจ)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| license_no | text | NOT NULL (เก็บตามรูปแบบสภาฯ; ระบุ format-check ตอน DCR ยืน Q3) |
| status | license_status | NOT NULL DEFAULT 'pending' |
| evidence_media_id | uuid | NULL FK→media_assets (เอกสารประกอบ ถ้าขอ) |
| verified_by | uuid | NULL FK→profiles (เจ้าหน้าที่ผู้อนุมัติ) |
| verified_at | timestamptz | NULL |
| expires_on | date | NULL (วันหมดอายุใบอนุญาต — ใช้อ้างรอบต่ออายุ) |
| rejected_reason | text | NULL (เมื่อ status='rejected' ต้อง NOT NULL — CHECK) |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(user_id, license_no) WHERE deleted_at IS NULL; INDEX(license_no) WHERE deleted_at IS NULL; CHECK (status='rejected' ↔ rejected_reason IS NOT NULL)
RLS: **SELECT** เจ้าของแถว หรือ staff:exam/registrar + super_admin; **INSERT** service_role เท่านั้น (สร้างอัตโนมัติเมื่อ `license_applications` ได้รับอนุมัติ); **UPDATE** เจ้าหน้าที่ staff:registrar/super_admin เท่านั้น (เปลี่ยน status/verified_by/rejected_reason); **DELETE** ไม่อนุญาต
Retention: ตลอดอายุบัญชี + 10 ปี (เกี่ยวเนื่องสิทธิต่อใบอนุญาต)

#### `license_applications` — คำขอผูกเลขที่ใบอนุญาต **(PII — PDPA)**

วัตถุประสงค์ (ตารางเสริม B-16): คำขอผูกเลขที่ใบอนุญาต + การตัดสินของเจ้าหน้าที่ — ยื่นผ่าน `PUT /me/license` แล้วตัดสินผ่าน `PATCH /admin/license-applications/{id}` (API-SPEC §3.2/§3.8; อนุมัติ → สร้าง lawyer_licenses + มอบบทบาท lawyer อัตโนมัติ + audit)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| license_no | text | NOT NULL |
| status | license_application_status | NOT NULL DEFAULT 'pending' |
| evidence_media_id | uuid | NULL FK→media_assets (เอกสารประกอบ Q3) |
| submitted_at | timestamptz | NOT NULL DEFAULT now() |
| decided_by | uuid | NULL FK→profiles (เจ้าหน้าที่ผู้ตัดสิน) |
| decided_at | timestamptz | NULL |
| rejected_reason | text | NULL (CHECK: status='rejected' → NOT NULL) |
| resulting_license_id | uuid | NULL FK→lawyer_licenses (แถวที่สร้างเมื่ออนุมัติ) |
คีย์/Index: UNIQUE(user_id) WHERE status='pending' (กันยื่นซ้อน); INDEX(status, submitted_at)
RLS: **SELECT** เจ้าของแถว หรือ staff:registrar/super_admin; **INSERT** เจ้าของบัญชีผ่าน BFF (ได้เฉพาะ status='pending'); **UPDATE** service_role เท่านั้น (registrar ตัดสินผ่าน admin endpoint + audit `LICENSE_VERIFY`); **DELETE** ไม่อนุญาต
Retention: ตลอดอายุบัญชี + 10 ปี (หลักฐานการตัดสิน)

#### `role_assignments` — บทบาทของผู้ใช้

วัตถุประสงค์: บทบาทแบบหลายค่าต่อบัญชี (brief §4) — แหล่งเดียวที่ helper `has_any_role()` อ่าน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| role | role_key | NOT NULL |
| granted_by | uuid | NULL FK→profiles (NULL = ระบบ เช่น seed ตอนสมัคร) |
| granted_at | timestamptz | NOT NULL DEFAULT now() |
| revoked_at | timestamptz | NULL |
| reason | text | NULL |
คีย์/Index: UNIQUE(user_id, role) WHERE revoked_at IS NULL; INDEX(user_id) WHERE revoked_at IS NULL; INDEX(role)
RLS: **SELECT** เจ้าของแถว (ดูบทบาทตัวเอง) หรือ staff ทุกระดับ; **INSERT/UPDATE** service_role เท่านั้น (บังคับผ่าน BFF + audit ทุกครั้ง); **DELETE** ไม่อนุญาต (ใช้ revoked_at)
Retention: ถาวร (ประวัติการมอบ/เพิกถอนบทบาท)

#### `consents` — บันทึกความยินยอม PDPA **(PII — PDPA)**

วัตถุประสงค์ (ตารางเสริม B-16): หลักฐานการให้/ถอน consent ตาม PDPA (ผ่าน `GET/PATCH /profile/consents` — API-SPEC §3.2) — เก็บเป็นประวัติแบบ append

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| consent_type | text | NOT NULL, CHECK IN ('pdpa_essential','marketing','email_notify') (ขยายได้ตาม DCR) |
| action | text | NOT NULL, CHECK IN ('grant','revoke') |
| policy_version | text | NOT NULL (เวอร์ชันนโยบาย ณ วันให้) |
| source | text | NOT NULL, CHECK IN ('register','profile','staff') |
| created_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: INDEX(user_id, consent_type, created_at DESC)
RLS: **SELECT** เจ้าของแถว หรือ staff:registrar/super_admin; **INSERT** service_role ผ่าน BFF เท่านั้น; **UPDATE/DELETE** ไม่อนุญาต (หลักฐาน consent แก้ไม่ได้ — ถอน = เพิ่มแถว action='revoke')
Retention: ตลอดอายุบัญชี + 10 ปี (PDPA)

### 3.2 Catalog & Enrollment

#### `course_categories` — หมวดหลักสูตร

วัตถุประสงค์ (ตารางเสริมนอกรายการขั้นต่ำ): หมวด/หมวดย่อยสำหรับจัดกลุ่มหลักสูตร (brief §5.2 "หมวด/หลักสูตร")

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| slug | text | NOT NULL UNIQUE |
| name_th / name_en | text | NOT NULL / NULL |
| parent_id | uuid | NULL FK→course_categories (โครง 1 ระดับ กัน loop — CHECK ผ่าน trigger) |
| sort_order | int | NOT NULL DEFAULT 0 |
| is_active | boolean | NOT NULL DEFAULT true |
คีย์/Index: UNIQUE(slug); INDEX(parent_id)
RLS: **SELECT** ทุกคนรวม guest (เฉพาะ is_active); **INSERT/UPDATE** staff:content/super_admin ผ่าน BFF; **DELETE** ไม่อนุญาต (ปิดด้วย is_active)
Retention: ถาวร (ข้อมูลอ้างอิง)

#### `courses` — หลักสูตร

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| code | text | NOT NULL UNIQUE (รหัสหลักสูตร) |
| category_id | uuid | NOT NULL FK→course_categories |
| title_th / title_en | text | NOT NULL / NULL |
| summary | text | NULL |
| description_md | text | NULL |
| cover_media_id | uuid | NULL FK→media_assets |
| language | text | NOT NULL DEFAULT 'th' |
| is_public | boolean | NOT NULL DEFAULT true (false = สำหรับทนายเท่านั้น) |
| credit_type | text | NOT NULL DEFAULT 'general' (ค่า config จาก credit_rules) |
| status | course_status | NOT NULL DEFAULT 'draft' |
| version | int | NOT NULL DEFAULT 1 (บัมพ์เมื่อเนื้อหาเปลี่ยนสำคัญ) |
| published_at | timestamptz | NULL |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(code); INDEX(category_id, status); INDEX(status) WHERE deleted_at IS NULL
RLS: **SELECT** ทุกคนเห็นเฉพาะ status='published' (และ is_public หรือผู้ใช้มี role lawyer); instructor เจ้าของ + staff ทุกระดับเห็นทุกสถานะ; **INSERT/UPDATE** instructor (เจ้าของ)/staff:content/super_admin; การเปลี่ยนสถานะเป็น published ต้องเป็น staff:content เท่านั้น (workflow อนุมัติ); **DELETE** ไม่อนุญาต
Retention: ถาวร (ประวัติหลักสูตร/ประกาศนียบัตรอ้างถึง)

#### `course_modules` — โมดูลของหลักสูตร

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| course_id | uuid | NOT NULL FK→courses |
| title_th | text | NOT NULL |
| sort_order | int | NOT NULL |
| is_preview | boolean | NOT NULL DEFAULT false (ดูได้โดยไม่ลงทะเบียน) |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(course_id, sort_order) WHERE deleted_at IS NULL; INDEX(course_id)
RLS: สืบตาม courses (เห็นเมื่อเห็นหลักสูตร); **INSERT/UPDATE** instructor เจ้าของ/staff:content/super_admin; **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `lessons` — บทเรียน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| module_id | uuid | NOT NULL FK→course_modules |
| type | lesson_type | NOT NULL |
| title_th | text | NOT NULL |
| content_md | text | NULL (type='document') |
| duration_sec | int | NULL CHECK > 0 (type='video') |
| media_id | uuid | NULL FK→media_assets (type='video') |
| quiz_id | uuid | NULL FK→lesson_quizzes (type='quiz') |
| sort_order | int | NOT NULL |
| completion_rule | jsonb | NULL (override เกณฑ์จบบท เช่น watch_pct — default จาก config ส่วนกลาง `video_complete_pct` ตาม SRS Appendix A) |
| is_preview | boolean | NOT NULL DEFAULT false |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(module_id, sort_order) WHERE deleted_at IS NULL; INDEX(quiz_id); CHECK (type='video' → media_id IS NOT NULL AND duration_sec IS NOT NULL); CHECK (type='quiz' → quiz_id IS NOT NULL)
RLS: สืบตาม courses; **INSERT/UPDATE** instructor เจ้าของ/staff:content/super_admin; **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `media_assets` — ทรัพยากรสื่อ (ผ่าน storage abstraction)

วัตถุประสงค์: metadata ของไฟล์ — ตัวไฟล์อยู่ที่ provider ตาม env (dev: Supabase Storage / prod: R2-Stream); ความละเอียดสูงสุด 1080p ตาม SRS Appendix A (video_max_resolution — ธง Q6)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| provider | media_provider | NOT NULL (สะท้อน environment — สลับได้เฉพาะตอน ingest) |
| media_type | media_type | NOT NULL |
| bucket | text | NOT NULL |
| storage_path | text | NOT NULL (คีย์ object ที่ provider) |
| playback_id | text | NULL (ใช้เมื่อ provider='stream') |
| mime_type | text | NOT NULL |
| size_bytes | bigint | NOT NULL CHECK >= 0 |
| duration_sec | int | NULL CHECK > 0 AND <= 3600 (วิดีโอ — คลิปจำกัด ≤ 60 นาที ตาม SRS Appendix A video_max_minutes, ธง Q6) |
| checksum_sha256 | text | NULL |
| status | media_status | NOT NULL DEFAULT 'uploading' |
| uploaded_by | uuid | NOT NULL FK→profiles |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(provider, bucket, storage_path) WHERE deleted_at IS NULL; INDEX(media_type, status)
RLS: **SELECT** service_role + instructor/staff (ระบบส่ง signed URL ให้ผู้เรียนเอง — ผู้เรียนไม่ query ตารางนี้โดยตรง); **INSERT/UPDATE** service_role ผ่าน BFF (อัปโหลด/ตรวจ status); **DELETE** ไม่อนุญาต (เก็บประวัติอ้างอิง)
Retention: ตลอดอายุการใช้งาน + ตาม retention สื่อของสภาฯ (หากไม่ถูกอ้างโดย lesson ใด ลบได้โดย job ที่มี audit)

#### `enrollments` — การลงทะเบียนเรียน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| course_id | uuid | NOT NULL FK→courses |
| status | enrollment_status | NOT NULL DEFAULT 'active' |
| source | text | NOT NULL DEFAULT 'self', CHECK IN ('self','staff') |
| created_by | uuid | NULL FK→profiles (เมื่อ source='staff') |
| enrolled_at | timestamptz | NOT NULL DEFAULT now() |
| expires_at | timestamptz | NULL (กำหนดเวลาเรียน ถ้าหลักสูตรกำหนด) |
| completed_at | timestamptz | NULL (ตั้งโดย rollup — SDS §3.3) |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(user_id, course_id) WHERE deleted_at IS NULL; INDEX(course_id, status); INDEX(user_id)
RLS: **SELECT** เจ้าของแถว หรือ staff ทุกระดับ หรือ instructor เจ้าของหลักสูตร; **INSERT** ผู้ใช้เป็นเจ้าของแถวเอง (self — ผ่าน BFF ที่ตรวจเงื่อนไขสิทธิ์ก่อน) หรือ service_role (staff ลงทะเบียนให้); **UPDATE** service_role เท่านั้น (status/completed_at คำนวณฝั่ง server); **DELETE** ไม่อนุญาต (ใช้ cancelled)
Retention: ถาวร (เป็นฐานของประกาศนียบัตร/credit)

### 3.3 Learning & Progress

#### `lesson_progress` — ความคืบหน้าต่อบทเรียน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| enrollment_id | uuid | NOT NULL FK→enrollments |
| lesson_id | uuid | NOT NULL FK→lessons |
| status | progress_status | NOT NULL DEFAULT 'not_started' |
| video_max_position_sec | int | NULL DEFAULT 0 CHECK >= 0 (monotonic ฝั่ง server) |
| watch_pct | smallint | NOT NULL DEFAULT 0, CHECK 0–100 |
| dwell_sec | int | NOT NULL DEFAULT 0 CHECK >= 0 |
| quiz_score_pct | smallint | NULL (บท quiz) |
| completed_at | timestamptz | NULL (idempotent — ตั้งครั้งเดียว) |
| updated_at | timestamptz | DEFAULT now() |
คีย์/Index: UNIQUE(enrollment_id, lesson_id); INDEX(lesson_id)
RLS: **SELECT** เจ้าของผ่าน enrollment หรือ staff/instructor เจ้าของหลักสูตร; **INSERT/UPDATE** เจ้าของ enrollment ผ่าน BFF เท่านั้น (BFF clamp ค่า + เป็นผู้ตัดสิน completed_at); **DELETE** ไม่อนุญาต
Retention: ตลอดอายุ enrollment (ถาวรตามประวัติการเรียน)

#### `lesson_quizzes` — แบบทดสอบย่อย (quiz)

วัตถุประสงค์: quiz ท้ายบทเรียน — คนละ entity จากข้อสอบปลายหลักสูตร (GLOSSARY)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| title | text | NOT NULL |
| pass_pct | smallint | NOT NULL DEFAULT 60, CHECK 1–100 (default ตาม SRS Appendix A `quiz_pass_percent`) |
| max_attempts | int | NULL (NULL = ไม่จำกัด) |
| shuffle_questions | boolean | NOT NULL DEFAULT true |
| status | text | NOT NULL DEFAULT 'active', CHECK IN ('draft','active','archived') |
คีย์/Index: (PK id ตามแบบแผน)
RLS: **SELECT** ผู้ที่ลงทะเบียนหลักสูตร + instructor/staff; **INSERT/UPDATE** instructor เจ้าของ/staff:content/super_admin; **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `quiz_questions` — คำถามของ quiz

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| quiz_id | uuid | NOT NULL FK→lesson_quizzes |
| question_text | text | NOT NULL |
| type | question_type | NOT NULL |
| explanation | text | NULL (เฉลย/คำอธิบาย — เปิดหลังทำเสร็จ) |
| points | smallint | NOT NULL DEFAULT 1 CHECK > 0 |
| sort_order | int | NOT NULL |
| is_active | boolean | NOT NULL DEFAULT true |
คีย์/Index: INDEX(quiz_id, sort_order)
RLS: **SELECT** ผู้ลงทะเบียน (BFF ตัด explanation ออกจนกว่าจะทำเสร็จ) + instructor/staff; **INSERT/UPDATE** instructor เจ้าของ/staff:content; **DELETE** ไม่อนุญาต (ใช้ is_active=false)
Retention: ถาวร

#### `quiz_options` — ตัวเลือกของคำถาม quiz

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| question_id | uuid | NOT NULL FK→quiz_questions |
| option_text | text | NOT NULL |
| is_correct | boolean | NOT NULL |
| sort_order | int | NOT NULL |
คีย์/Index: UNIQUE(question_id, sort_order)
RLS: **SELECT** ผู้ลงทะเบียน/instructor/staff แต่ **BFF ห้ามส่ง is_correct ออกไปตลอดการทำ quiz** (คะแนนตัดสินฝั่ง server); **INSERT/UPDATE** instructor เจ้าของ/staff:content; **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `quiz_attempts` — ผลการทำ quiz รายครั้ง

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| quiz_id | uuid | NOT NULL FK→lesson_quizzes |
| user_id | uuid | NOT NULL FK→profiles |
| attempt_no | int | NOT NULL CHECK > 0 |
| started_at | timestamptz | NOT NULL DEFAULT now() |
| submitted_at | timestamptz | NULL |
| score_pct | smallint | NULL CHECK 0–100 |
| passed | boolean | NULL |
| answers_snapshot | jsonb | NULL (เก็บข้อ+ตัวเลือกที่เลือก ณ ตรวจ — ง่ายต่อเฉลย) |
คีย์/Index: UNIQUE(quiz_id, user_id, attempt_no); INDEX(user_id)
RLS: **SELECT** เจ้าของแถว/staff/instructor เจ้าของ; **INSERT** เจ้าของ (ผ่าน BFF ตรวจ max_attempts); **UPDATE** service_role เท่านั้น (บันทึกผลตอน submit); **DELETE** ไม่อนุญาต
Retention: ถาวร (ประวัติการเรียน)

### 3.4 Assessment & Certification

#### `question_banks` — ธนาคารข้อสอบ

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| code | text | NOT NULL UNIQUE |
| name | text | NOT NULL |
| course_id | uuid | NULL FK→courses (NULL = ใช้ร่วม) |
| category_id | uuid | NULL FK→course_categories |
| description | text | NULL |
| is_active | boolean | NOT NULL DEFAULT true |
คีย์/Index: UNIQUE(code); INDEX(course_id)
RLS: **SELECT** instructor/staff:exam/staff:content/super_admin (ผู้เรียนไม่เห็น); **INSERT/UPDATE** instructor/staff:exam/super_admin; **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `questions` — ข้อสอบ (ของธนาคาร)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| bank_id | uuid | NOT NULL FK→question_banks |
| type | question_type | NOT NULL |
| difficulty | question_difficulty | NOT NULL DEFAULT 'medium' |
| question_text | text | NOT NULL |
| explanation | text | NULL |
| points | smallint | NOT NULL DEFAULT 1 CHECK > 0 |
| status | question_status | NOT NULL DEFAULT 'draft' |
| tags | text[] | NOT NULL DEFAULT '{}' |
| created_by | uuid | NOT NULL FK→profiles |
คีย์/Index: INDEX(bank_id, status, difficulty); GIN(tags)
RLS: **SELECT** instructor/staff:exam/super_admin เท่านั้น — **ผู้เรียนห้าม query โดยตรง** (ได้รับเฉพาะ snapshot ผ่าน BFF ตอนสอบ); **INSERT/UPDATE** instructor/staff:exam/super_admin (เปลี่ยน status='active' ต้อง staff:exam); **DELETE** ไม่อนุญาต (ใช้ retired)
Retention: ถาวร (อ้างอิงโดย attempt_answers)

#### `question_options` — ตัวเลือกของข้อสอบ

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| question_id | uuid | NOT NULL FK→questions |
| option_text | text | NOT NULL |
| is_correct | boolean | NOT NULL |
| sort_order | int | NOT NULL |
คีย์/Index: UNIQUE(question_id, sort_order); เงื่อนไขความถูกต้องบังคับด้วย trigger (single_choice/true_false ต้องมีคำตอบถูก 1 ตัว)
RLS: **SELECT** เฉพาะ instructor/staff:exam/super_admin และ service_role — ผู้เรียนได้รับทาง BFF โดย **ตัด is_correct ทิ้งเสมอ**; **INSERT/UPDATE** instructor/staff:exam/super_admin; **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `assessments` — การสอบของหลักสูตร

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| course_id | uuid | NOT NULL FK→courses |
| code | text | NOT NULL |
| title | text | NOT NULL |
| description | text | NULL |
| is_final | boolean | NOT NULL DEFAULT true (ใช้ประกอบเกณฑ์จบหลักสูตร) |
| status | assessment_status | NOT NULL DEFAULT 'draft' |
| published_at | timestamptz | NULL |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(course_id, code) WHERE deleted_at IS NULL
RLS: **SELECT** ผู้ลงทะเบียน (เมื่อ published) + instructor/staff; **INSERT/UPDATE** instructor/staff:exam/super_admin (publish ต้อง staff:exam); **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `assessment_rules` — กติกาการสอบ (config ต่อการสอบ — Q2)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| assessment_id | uuid | NOT NULL FK→assessments |
| version | int | NOT NULL DEFAULT 1 |
| time_limit_minutes | int | NOT NULL DEFAULT 60 CHECK BETWEEN 5 AND 480 |
| question_count | int | NOT NULL DEFAULT 30 CHECK > 0 |
| pass_pct | smallint | NOT NULL CHECK 1–100 — default seed อ้าง SRS Appendix A `exam_pass_threshold_percent` (ธง Q2) |
| max_attempts | int | NOT NULL DEFAULT 3 CHECK > 0 (ตาม SRS Appendix A `exam_max_attempts`) |
| attempt_cooldown_minutes | int | NOT NULL DEFAULT 1440 CHECK >= 0 (24 ชม. ตาม SRS Appendix A `exam_attempt_cooldown_hours`) |
| shuffle_questions | boolean | NOT NULL DEFAULT true |
| shuffle_options | boolean | NOT NULL DEFAULT true |
| selection | jsonb | NOT NULL DEFAULT '{}' (เงื่อนไขคัด pool: bank_ids, categories, difficulty mix) |
| require_course_complete | boolean | NOT NULL DEFAULT true |
| proctoring_mode | proctoring_mode | NOT NULL DEFAULT 'basic' (ตาม SRS Appendix A `proctoring_mode` — ธง Q4) |
| effective_from | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: UNIQUE(assessment_id, version); INDEX(assessment_id) WHERE effective_from <= now() — attempt ใช้ rules เวอร์ชันที่มีผล ณ วันสอบ (การแก้กฎไม่ย้อนหลัง)
RLS: **SELECT** ผู้ลงทะเบียน (เห็นเฉพาะฟิลด์ที่เกี่ยวกับผู้สอบ เช่น เวลา/จำนวนครั้ง) + instructor/staff:exam เห็นเต็ม; **INSERT/UPDATE** staff:exam/super_admin ผ่าน BFF + audit (แก้ = สร้าง version ใหม่); **DELETE** ไม่อนุญาต
Retention: ถาวร (versioned)

#### `assessment_attempts` — รอบการสอบของผู้ใช้

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| assessment_id | uuid | NOT NULL FK→assessments |
| user_id | uuid | NOT NULL FK→profiles |
| enrollment_id | uuid | NOT NULL FK→enrollments |
| rules_id | uuid | NOT NULL FK→assessment_rules (snapshot กติกาที่ใช้) |
| attempt_no | int | NOT NULL CHECK > 0 |
| status | attempt_status | NOT NULL DEFAULT 'in_progress' |
| started_at | timestamptz | NOT NULL DEFAULT now() (DB clock — จับเวลา server-side) |
| expires_at | timestamptz | NOT NULL (= started_at + rules.time_limit_minutes ตอนสร้าง) |
| submitted_at | timestamptz | NULL (idempotent key ของ submit) |
| score_pct | smallint | NULL CHECK 0–100 |
| passed | boolean | NULL |
| question_count | int | NOT NULL |
| correct_count | int | NULL |
| client_events | jsonb | NULL (proctoring ระดับ basic — บันทึก client events เช่น tab blur; จำกัดขนาด, ไม่มี PII) |
คีย์/Index: UNIQUE(assessment_id, user_id, attempt_no); **UNIQUE(assessment_id, user_id) WHERE status='in_progress'** (ป้องกันสอบซ้อน — SDS §3.1f); INDEX(status) WHERE status='in_progress' (auto-submit job); INDEX(user_id)
RLS: **SELECT** เจ้าของแถว/staff:exam/registrar/instructor เจ้าของ; **INSERT** เจ้าของผ่าน BFF (หลังตรวจเงื่อนไขครบ); **UPDATE** service_role เท่านั้น (answer/submit/grade ทั้งหมดฝั่ง server); **DELETE** ไม่อนุญาต (ยกเลิกด้วย status='voided' โดย staff:exam + audit)
Retention: ถาวร (หลักฐานผลสอบ)

#### `attempt_answers` — คำตอบรายข้อ (snapshot ของการสุ่ม)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| attempt_id | uuid | NOT NULL FK→assessment_attempts |
| question_id | uuid | NOT NULL FK→questions |
| seq | int | NOT NULL (ลำดับที่สุ่มได้) |
| option_order | int[] | NULL (ลำดับตัวเลือกที่สุ่ม ณ ตอน start) |
| selected_option_ids | uuid[] | NULL (บันทึกทีละข้อ — UPSERT) |
| is_correct | boolean | NULL (ตั้งตอนตรวจ) |
| points_earned | smallint | NULL |
| answered_at | timestamptz | NULL |
คีย์/Index: UNIQUE(attempt_id, question_id); INDEX(question_id)
RLS: **SELECT** เจ้าของผ่าน attempt เฉพาะ status ไม่ใช่ in_progress หรือเป็นของตัวเองระหว่างสอบแบบไม่มี is_correct (BFF ควบคุม); **INSERT** service_role (สร้าง snapshot ตอน start); **UPDATE** service_role เท่านั้น (บันทึกคำตอบ/ผลตรวจ); **DELETE** ไม่อนุญาต
Retention: ถาวร

#### `certificates` — ประกาศนียบัตร **(PII — PDPA: holder_name_snapshot)**

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| cert_no | text | NOT NULL UNIQUE — รูปแบบ `LTC-<ปี ค.ศ.>-<สุ่ม 6 หลัก>` ตาม SRS Appendix A `certificate_code_format` (สุ่มด้วย CSPRNG + ตรวจ UNIQUE ซ้ำใน transaction; **ไม่ใช้ sequence** เพราะลำดับถูกเดาเลขถัดไปได้ — รอยืนยันรูปแบบกับสภาฯ) |
| verify_code | text | NOT NULL UNIQUE (nanoid 43 อักขระ, CSPRNG — คีย์สาธารณะ ไม่มี PII) |
| enrollment_id | uuid | NOT NULL UNIQUE FK→enrollments (idempotent ของการออก) |
| user_id | uuid | NOT NULL FK→profiles |
| course_id | uuid | NOT NULL FK→courses |
| holder_name_snapshot | text | NOT NULL (ชื่อตามที่พิมพ์บนใบประกาศ) |
| course_title_snapshot | text | NOT NULL |
| credit_snapshot | numeric(6,2) | NULL (credit ที่ให้ ณ วันออก) |
| issued_by | uuid | NOT NULL FK→profiles (นายทะเบียน) |
| issued_at | timestamptz | NOT NULL DEFAULT now() |
| status | certificate_status | NOT NULL DEFAULT 'valid' |
| revoked_at | timestamptz | NULL |
| revoked_reason | text | NULL |
| pdf_media_id | uuid | NULL FK→media_assets |
| superseded_by | uuid | NULL FK→certificates (reissue → ใบเดิมเปลี่ยน status='superseded' และชี้ใบใหม่) |
คีย์/Index: UNIQUE(cert_no); UNIQUE(verify_code); UNIQUE(enrollment_id); INDEX(user_id); CHECK (status='revoked' ↔ revoked_at IS NOT NULL)
RLS: **SELECT** เจ้าของแถว หรือ staff:registrar/super_admin — path สาธารณะเป็น BFF อย่างเดียว: `GET /certificates/{code}` ตอบ **200 เสมอ** ด้วย 4 ฟิลด์ `{code, course_title, issued_at, status ∈ valid|revoked|superseded}` — **ห้ามแสดงชื่อเจ้าของ** (ชื่ออยู่บน PDF เท่านั้น — D8); **INSERT** service_role ผ่าน BFF โดย staff:registrar/super_admin เท่านั้น + audit; **UPDATE** service_role (เปลี่ยน status พร้อมเหตุผล — registrar); **DELETE** ไม่อนุญาตเด็ดขาด
Retention: ถาวร (เอกสารสิทธิ)

#### `certificate_verifications` — บันทึกการตรวจสอบสาธารณะ

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| verify_code | text | NOT NULL (ค่าที่ผู้ตรวจสอบส่งมา — ไม่ FK เพราะ not_found ก็ต้องบันทึก) |
| result | verification_result | NOT NULL |
| ip_hash | text | NOT NULL (sha256 + salt — ไม่เก็บ IP ตรง) |
| user_agent | text | NULL (ตัดทอน 128 อักขรา) |
| source | text | NOT NULL DEFAULT 'qr', CHECK IN ('qr','manual') |
| verified_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: INDEX(verified_at); INDEX(verify_code)
RLS: **SELECT** staff:registrar/super_admin เท่านั้น (สถิติการตรวจ); **INSERT** service_role ผ่าน BFF (ทุกครั้งที่มีการ verify — rate limited); **UPDATE/DELETE** ไม่อนุญาต (purge ตาม retention เป็น job แยกที่มี audit)
Retention: **90 วัน** (ตัดด้วย job — เก็บสถิติพอสำหรับตรวจ abuse)

### 3.5 Credit Bank

#### `credit_rules` — กฎการได้ credit (config — Q1)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| code | text | NOT NULL UNIQUE |
| name | text | NOT NULL |
| course_id | uuid | NULL FK→courses (NULL = กฎทั่วไป) |
| credit_type | text | NOT NULL DEFAULT 'general' |
| credits | numeric(6,2) | NOT NULL CHECK > 0 |
| valid_days | int | NULL (อายุ credit — NULL = ตามรอบ) |
| carry_over | boolean | NOT NULL DEFAULT false (ยกยอดข้ามรอบได้?) |
| required_credits_per_cycle | numeric(6,2) | NULL (เกณฑ์ต่อรอบ — default 12, **รอยืนยัน Q1**) |
| priority | int | NOT NULL DEFAULT 100 (ตัวเลขน้อย = จับคู่ก่อน) |
| effective_from / effective_to | timestamptz | NOT NULL DEFAULT now() / NULL |
| is_active | boolean | NOT NULL DEFAULT true |
คีย์/Index: UNIQUE(code); INDEX(course_id, priority)
RLS: **SELECT** ผู้ใช้ role lawyer (ดูกฎของตัวเองแบบสรุป) + staff ทุกระดับ; **INSERT/UPDATE** super_admin/staff:registrar ผ่าน BFF + audit; **DELETE** ไม่อนุญาต (ปิดด้วย is_active/effective_to)
Retention: ถาวร (versioned ด้วย effective window)

#### `renewal_cycles` — รอบต่ออายุใบอนุญาตรายบุคคล

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| cycle_no | int | NOT NULL CHECK > 0 |
| starts_on / ends_on | date | NOT NULL (ความยาวรอบจาก config — default 1 ปี, **รอยืนยัน Q1**) |
| required_credits | jsonb | NOT NULL (snapshot เกณฑ์ ณ สร้างรอบ แยกตาม credit_type) |
| status | cycle_status | NOT NULL DEFAULT 'open' |
| closed_at | timestamptz | NULL |
คีย์/Index: UNIQUE(user_id, cycle_no); EXCLUDE USING gist (user_id WITH =, daterange(starts_on, ends_on) WITH &&) — ห้ามรอบซ้อนกัน; INDEX(user_id) WHERE status='open'
RLS: **SELECT** เจ้าของแถว/staff ทุกระดับ; **INSERT/UPDATE** service_role เท่านั้น (สร้าง/ปิดรอบโดยระบบหรือ registrar ผ่าน BFF + audit); **DELETE** ไม่อนุญาต
Retention: ถาวร (ประวัติการต่ออายุ)

#### `credit_ledger_entries` — รายการ credit **(append-only — บังคับด้วย grants + RLS)**

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| renewal_cycle_id | uuid | NOT NULL FK→renewal_cycles |
| entry_type | ledger_entry_type | NOT NULL |
| credit_type | text | NOT NULL DEFAULT 'general' |
| amount | numeric(6,2) | NOT NULL (signed — reversal ติดลบ) |
| certificate_id | uuid | NULL FK→certificates (accrual) |
| original_entry_id | uuid | NULL FK→credit_ledger_entries (ต้นทางของ reversal) |
| rule_id | uuid | NULL FK→credit_rules (กฎที่ใช้ตอน accrual) |
| reason | text | NULL (บังคับเมื่อ type IN ('adjustment','reversal') — CHECK) |
| created_by | uuid | NULL FK→profiles (NULL = ระบบ) |
| created_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: INDEX(user_id, renewal_cycle_id); INDEX(certificate_id); CHECK (entry_type IN ('adjustment','reversal') → reason IS NOT NULL AND created_by IS NOT NULL)
RLS: **SELECT** เจ้าของแถว/staff ทุกระดับ; **INSERT** service_role เท่านั้น (accrual อัตโนมัติ / adjustment-reversal โดย registrar ผ่าน BFF + audit); **UPDATE/DELETE ไม่มี path เด็ดขาด** — REVOKE UPDATE, DELETE จากทุกบทบาท (คงไว้เฉพาะ migration owner) + ไม่มี policy อนุญาต + trigger guard กันซ้ำซ้อน (เช่น audit_logs — ดู §4.4)
Retention: ถาวร (transcript ของทนายความ)

### 3.6 Notification

#### `notifications` — หัวข้อแจ้งเตือน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| topic | text | NOT NULL (คีย์เหตุการณ์ เช่น certificate.issued) |
| title | text | NOT NULL |
| body | text | NOT NULL |
| severity | text | NOT NULL DEFAULT 'info', CHECK IN ('info','success','warning','error') |
| ref_type | text | NULL |
| ref_id | uuid | NULL (อ้างอิง entity ที่เกี่ยวข้อง) |
| created_by | uuid | NULL FK→profiles (NULL = ระบบ) |
| expires_at | timestamptz | NULL |
คีย์/Index: INDEX(created_at DESC); INDEX(topic)
RLS: **SELECT** ผู้รับเท่านั้น (JOIN ผ่าน notification_recipients — policy ใช้ EXISTS); **INSERT** service_role ผ่าน BFF (notification service); **UPDATE** service_role (แก้ไขก่อนส่งได้); **DELETE** ไม่อนุญาต (ล้างตาม expires_at ด้วย job)
Retention: 12 เดือน หรือตาม expires_at

#### `notification_recipients` — ผู้รับแจ้งเตือนรายคน/รายช่องทาง

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| notification_id | uuid | NOT NULL FK→notifications |
| user_id | uuid | NOT NULL FK→profiles |
| channel | notification_channel | NOT NULL |
| sent_at | timestamptz | NULL |
| read_at | timestamptz | NULL (ช่องทาง in_app) |
| deleted_at | timestamptz | NULL (ผู้รับซ่อน/ลบข้อความของตัวเอง) |
คีย์/Index: UNIQUE(notification_id, user_id, channel); INDEX(user_id, channel) WHERE deleted_at IS NULL
RLS: **SELECT** เจ้าของแถวเท่านั้น; **INSERT** service_role; **UPDATE** เจ้าของแถว (read_at/deleted_at ผ่าน BFF) เท่านั้น; **DELETE** ไม่อนุญาต
Retention: ตาม notifications (12 เดือน)

#### `notification_settings` — การตั้งค่าแจ้งเตือนรายบุคคล

วัตถุประสงค์ (ตารางเสริม B-16): ช่องทาง/ประเภทแจ้งเตือนต่อผู้ใช้ (`GET/PATCH /me/notification-settings` — API-SPEC §3.9)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | PK, FK→profiles (1:1) |
| settings | jsonb | NOT NULL DEFAULT '{}' (โครงสร้าง topic → {in_app, email}) |
| updated_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: PK = (user_id)
RLS: **SELECT** เจ้าของแถวเท่านั้น; **INSERT/UPDATE** service_role ผ่าน BFF (เจ้าของแก้ของตัวเอง); **DELETE** ไม่อนุญาต
Retention: ตามอายุบัญชี

#### `notification_templates` — เทมเพลตแจ้งเตือน (ไทยก่อน)

วัตถุประสงค์ (ตารางเสริม B-16): เทมเพลตอีเมล/in-app ภาษาไทย (brief §5.6) — `email_outbox.template_key` อ้างมาที่นี่

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| template_key | text | NOT NULL |
| locale | text | NOT NULL DEFAULT 'th', CHECK IN ('th','en') |
| channel | notification_channel | NOT NULL |
| subject_tpl | text | NOT NULL |
| body_tpl | text | NOT NULL (ตัวแปรรูปแบบ {{var}}) |
| version | int | NOT NULL DEFAULT 1 |
| is_active | boolean | NOT NULL DEFAULT true |
| updated_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: UNIQUE(template_key, locale, channel) WHERE is_active; INDEX(template_key)
RLS: **SELECT** service_role (BFF ใช้ render) + staff:content/super_admin; **INSERT/UPDATE** staff:content/super_admin ผ่าน BFF + audit (แก้ = สร้าง version ใหม่); **DELETE** ไม่อนุญาต (ปิดด้วย is_active)
Retention: ถาวร (versioned)

#### `email_outbox` — คิวอีเมลขาออก **(PII — PDPA: to_email)**

วัตถุประสงค์ (ตารางเสริมที่เพิ่มนอกรายการขั้นต่ำ): แยกการส่งอีเมลออกจาก request path + retry ได้ (SDS §8) — dev ใช้ Mailpit จับ, prod ใช้ Resend/SMTP

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| recipient_user_id | uuid | NULL FK→profiles |
| to_email | text | NOT NULL |
| template_key | text | NOT NULL (เทมเพลตภาษาไทย — brief §5.6) |
| payload | jsonb | NOT NULL DEFAULT '{}' (ตัวแปรเทมเพลต — ห้ามใส่ PII เกินจำเป็น) |
| locale | text | NOT NULL DEFAULT 'th' |
| status | email_status | NOT NULL DEFAULT 'queued' |
| attempts | int | NOT NULL DEFAULT 0 |
| last_error | text | NULL (ข้อความ error ของ provider ตัดทอน — ห้ามมีเนื้อหาอีเมล) |
| scheduled_at | timestamptz | NOT NULL DEFAULT now() |
| sent_at | timestamptz | NULL |
คีย์/Index: INDEX(status, scheduled_at) WHERE status IN ('queued','sending'); INDEX(recipient_user_id)
RLS: **SELECT** service_role เท่านั้น (มี PII — ผู้ใช้เห็นสถานะผ่าน notifications แทน); **INSERT** service_role; **UPDATE** service_role (worker); **DELETE** ไม่อนุญาต (purge ตาม retention)
Retention: 90 วันหลัง sent/failed

### 3.7 Admin & Reporting

#### `report_exports` — งาน export ของเจ้าหน้าที่

วัตถุประสงค์ (ตารางเสริม B-16): ตามงาน export CSV/JSON (`GET /admin/reports/{type}/export` — API-SPEC §3.8) เป็น job แบบ async + ไฟล์มีอายุสั้น

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| requested_by | uuid | NOT NULL FK→profiles |
| report_type | text | NOT NULL (ตามกลุ่ม /admin/reports/*) |
| params | jsonb | NOT NULL DEFAULT '{}' (ตัวกรอง — ห้ามบรรจุ PII เกินจำเป็น) |
| format | text | NOT NULL DEFAULT 'csv', CHECK IN ('csv','json') |
| status | export_status | NOT NULL DEFAULT 'queued' |
| file_media_id | uuid | NULL FK→media_assets |
| row_count | int | NULL |
| error | text | NULL (ตัดทอน) |
| requested_at | timestamptz | NOT NULL DEFAULT now() |
| completed_at | timestamptz | NULL |
| expires_at | timestamptz | NULL (อายุไฟล์ — default 7 วัน) |
คีย์/Index: INDEX(requested_by, requested_at DESC); INDEX(status) WHERE status IN ('queued','processing')
RLS: **SELECT** ผู้ขอเอง หรือ staff ทุกระดับ; **INSERT** service_role ผ่าน BFF (บังคับ audit `ADMIN_EXPORT`); **UPDATE** service_role (worker); **DELETE** ไม่อนุญาต (ล้างตาม expires_at ด้วย job ที่มี audit)
Retention: แถว 12 เดือน (ไฟล์ 7 วันตาม expires_at)

Reporting ทั้งหมดอ่านผ่าน view + สิทธิ์ staff เท่านั้น (SDS §2 M7): `v_credit_balance` (ยอด credit ต่อรอบ/ประเภท จาก SUM ledger), `v_enrollment_progress` (สรุปความคืบหน้าจาก lesson_progress), `v_assessment_statistics` (ผลสอบต่อหลักสูตร), `v_certificates_issued` — นิยามใน migration แยก; export CSV ทำที่ BFF โดย stream จาก view

### 3.8 Audit & Admin Session

#### `audit_logs` — บันทึกการกระทำสำคัญ **(append-only — ห้าม UPDATE/DELETE เด็ดขาด)**

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| occurred_at | timestamptz | NOT NULL DEFAULT now() |
| actor_user_id | uuid | NULL FK→profiles (NULL = ระบบ/ผู้ไม่ระบุตัวตน) |
| actor_roles | text[] | NOT NULL DEFAULT '{}' (snapshot ตอนเกิดเหตุการณ์) |
| action | text | NOT NULL (คีย์จุด เช่น auth.login, certificate.issue, credit.adjust — รายการเต็มที่ AUDIT-LOG-DESIGN.md) |
| entity_type | text | NOT NULL |
| entity_id | uuid | NULL |
| before / after | jsonb | NULL (diff ข้อมูล — audit service ต้อง mask PII ก่อนเขียน §4.5) |
| ip_hash | text | NULL (sha256 + salt) |
| user_agent | text | NULL (ตัดทอน) |
| request_id | text | NULL (เชื่อมกับ app log) |
| context | jsonb | NULL |
คีย์/Index: INDEX(entity_type, entity_id, occurred_at DESC); INDEX(actor_user_id, occurred_at DESC); INDEX(action, occurred_at DESC); ไม่มี FK แบบ enforce ต่อ actor เพื่อกันการ rewrite ประวัติ (ใช้ lookup ที่แอป)
RLS: **SELECT** staff ทุกระดับ + super_admin (สิทธิ์อ่านตามขอบเขต sub-role — รายละเอียดที่ AUDIT-LOG-DESIGN.md); **INSERT** service_role ผ่าน audit service เท่านั้น; **UPDATE/DELETE ไม่มี path เด็ดขาด** — `REVOKE UPDATE, DELETE ON audit_logs FROM anon, authenticated, service_role` + ไม่มี policy ใดอนุญาต (D6); ไม่มี API แก้/ลบ audit
Retention: ≥ 5 ปี (นโยบายสภาฯ + PDPA) — partition รายเดือนเมื่อโต (SDS §8)

#### `security_events` — เหตุการณ์ความปลอดภัย (ปริมาณสูง แยกจาก audit_logs)

วัตถุประสงค์ (ตารางเสริม B-16): login ล้มเหลว / lockout / rate-limit hit / MFA fail — เก็บแยกจาก audit_logs เพื่อ correlation และไม่ให้หลักฐานธุรกิจถูก flood

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| event_type | security_event_type | NOT NULL |
| occurred_at | timestamptz | NOT NULL DEFAULT now() |
| target_user_id | uuid | NULL FK→profiles (NULL = ไม่ระบุตัวตน) |
| ip_hash | text | NOT NULL (sha256 + salt — ไม่เก็บ IP ตรง) |
| user_agent | text | NULL (ตัดทอน 128 อักขระ) |
| request_id | text | NULL (เชื่อมกับ app log) |
| detail | jsonb | NULL (ห้ามบรรจุ PII) |
คีย์/Index: INDEX(occurred_at DESC); INDEX(target_user_id, event_type); INDEX(ip_hash, event_type, occurred_at DESC)
RLS: **SELECT** super_admin เท่านั้น (รายละเอียด sensitive); **INSERT** service_role ผ่าน BFF/middleware; **UPDATE/DELETE** ไม่มี path — รวมอยู่ใน REVOKE append-only เดียวกับ audit_logs (§4.4)
Retention: 12 เดือน

#### `admin_sessions` — ติดตาม session ของ staff/admin

วัตถุประสงค์ (ตารางเสริมที่เพิ่มนอกรายการขั้นต่ำ): บังคับ idle timeout/absolute timeout/lockout/revoke ทันที ของบัญชี staff (SDS §5.5) — JWT ของ Supabase เพียงอย่างเดียวทำ policy แบบนี้ไม่สะดวก

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles (ต้องเป็นบทบาท staff*/super_admin — ตรวจที่ BFF) |
| session_id | text | NOT NULL UNIQUE (ค่าจาก Supabase session) |
| mfa_satisfied | boolean | NOT NULL DEFAULT false (บังคับ true — brief §8) |
| started_at | timestamptz | NOT NULL DEFAULT now() |
| last_seen_at | timestamptz | NOT NULL DEFAULT now() |
| ended_at | timestamptz | NULL |
| ended_reason | admin_session_end | NULL |
| ip_hash | text | NOT NULL (sha256 + salt) |
| user_agent | text | NULL (ตัดทอน) |
คีย์/Index: UNIQUE(session_id); INDEX(user_id) WHERE ended_at IS NULL; INDEX(last_seen_at)
RLS: **SELECT** เจ้าของแถว (แถวของตัวเอง) หรือ super_admin; **INSERT/UPDATE** service_role ผ่าน BFF/middleware เท่านั้น; **DELETE** ไม่อนุญาต
Retention: 24 เดือน

## 4. หมายเหตุบังคับสำหรับ migration

### 4.1 ลำดับสร้างตาราง (ปัญหาอ้างอิงวน)

`lessons ↔ lesson_quizzes` อ้างกัน (lessons.quiz_id ↔ lesson_quizzes) และ `courses ↔ media_assets`, `lawyer_licenses ↔ media_assets` — สร้างตารางก่อนแล้ว `ALTER TABLE ... ADD CONSTRAINT` ทีหลังใน migration เดียวกัน

### 4.2 Triggers ที่ต้องมี

| Trigger | ตาราง | พฤติกรรม |
| ------- | ----- | -------- |
| `set_updated_at()` | ทุกตารางที่มี updated_at | ตอน UPDATE ให้ updated_at = now() |
| `on_auth_user_created()` | auth.users (event) | สร้าง profiles + role_assignments(citizen) — security definer |
| ตรวจ options ถูกต้อง | question_options / quiz_options | single_choice/true_false ต้องมี is_correct=true จำนวน 1 |

### 4.3 Soft-delete policy

- แอปไม่มีสิทธิ์ hard delete เลย (RLS ไม่มี policy DELETE ยกเว้นระบุ) — ลบ = ตั้ง deleted_at
- การ purge ตาม retention เป็น job แยกที่ใช้ role เฉพาะ (ไม่ใช่ service_role ของแอป) + บันทึก audit ทุกครั้ง

### 4.4 Append-only enforcement (audit_logs + credit_ledger_entries + security_events)

1. `REVOKE UPDATE, DELETE ON TABLE audit_logs, credit_ledger_entries, security_events FROM anon, authenticated, service_role` — เหลือ path เขียน INSERT อย่างเดียว
2. RLS ไม่มี policy สำหรับ UPDATE/DELETE เลย
3. trigger guard สุดท้าย: ถ้ามีการ UPDATE/DELETE (โดน role ที่ยังมีสิทธิ์ เช่น ตอน migration) ให้ RAISE EXCEPTION
4. ไม่มี API/Server Action ใดเปิด path แก้/ลบ (ตรวจด้วย codex gate ตอน review โค้ด auth/security/data)

### 4.5 ทะเบียน PII (PDPA — ห้าม log/ห้ามเปิด API สาธารณะ)

| ตาราง.คอลัมน์ | ข้อมูล | มาตรการ |
| ------------ | ------ | ------- |
| profiles.email, phone, first_name, last_name, display_name | ข้อมูลส่วนบุคคล | RLS เจ้าของ+staff, ห้าม log, แจ้งเหตุการเข้าถึงตามนโยบาย PDPA |
| lawyer_licenses.license_no, license_applications.license_no | ข้อมูลส่วนบุคคล (วิชาชีพ) | RLS เจ้าของ+staff:exam/registrar, ห้าม log, ไม่แสดงในหน้าสาธารณะ |
| certificates.holder_name_snapshot | ชื่อตามใบประกาศ | แสดงเฉพาะบน PDF ที่เจ้าของ/registrar ดาวน์โหลด — ห้ามออกทาง public verify (D8) |
| email_outbox.to_email | ข้อมูลติดต่อ | SELECT ได้เฉพาะ service_role; purge 90 วัน |
| audit_logs.before/after | อาจมี PII ปน | audit service mask ก่อนเขียน (allowlist field) |

### 4.6 สรุป retention

| กลุ่มตาราง | Retention |
| ---------- | --------- |
| audit_logs, credit_ledger_entries, renewal_cycles, certificates, enrollments, assessment_attempts, attempt_answers, notification_templates | ถาวร |
| profiles, lawyer_licenses, license_applications, consents | อายุบัญชี + 10 ปี |
| certificate_verifications, email_outbox | 90 วัน |
| notifications, notification_recipients, security_events, report_exports | 12 เดือน (ไฟล์ export 7 วัน) |
| admin_sessions | 24 เดือน |
| notification_settings | ตามอายุบัญชี |
