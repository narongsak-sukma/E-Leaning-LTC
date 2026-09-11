# DATA-DICTIONARY — พจนานุกรมข้อมูล (blueprint ของ `supabase/migrations/*`)

|          |                                                   |
| -------- | ------------------------------------------------- |
| เวอร์ชัน | 1.1.6 — DCR-8 walked-markers (migration 0030 ตาม codex gate r4 MAJOR-1/MAJOR-2 + MINOR-1): สถานะ "เดินแล้ว" ของ sweep แยกออกจาก watermark เป็น **marker ต่อแถว** ในตารางใหม่ `cert_auto_walked` (§3.7 — scope_key, sweep_epoch, attempt_id) + picker ใหม่ `admin_cert_auto_unmarked_pick` (เรียง desc — ใหม่สุดก่อน) + `cert_auto_issue_tick` เดิน unmarked ทีละแถว: แถวที่ commit ช้า (submitted_at = now() ตอน*เริ่ม* TX — visibility สลับลำดับกับเวลาได้) ไม่ตกหล่นอีก · `cert_auto_cursor` += `sweep_epoch` + คู่ cursor/sweep_top เหลือเป็น**ข้อมูลชี้แจง** (ไม่ใช่เงื่อนไขความถูกต้อง) · สถานะขัดที่ 0028 ค้างไว้ (คู่เดียว null) = normalize เป็น sweep ใหม่ · 1.1.5 — DCR-8 arrival-first tick (migration 0029 ตาม codex gate r3 MAJOR-1 + MINOR-1): `cert_auto_cursor` เพิ่มคอลัมน์ `sweep_top_submitted_at`/`sweep_top_attempt_id` (ขอบบนของ sweep) + picker ใหม่ `admin_cert_auto_fresh_pick` + `cert_auto_issue_tick` เป็น **tick สองเฟส** — fresh lane รับ "ผู้มาใหม่" เหนือขอบบน*ก่อน* backlog: ผู้ผ่านเงื่อนไขที่มากลาง sweep ได้ใบใน tick ถัดไปทันที ไม่รอ sweep เก่าจบ (AC ≤5 นาที — 0028 ทำให้เขาล่องหนถึงนาที 8) · ชุดที่เดินแล้วของ sweep = ช่วงต่อเนื่อง [cursor, sweep_top] โดยก่อสร้าง · 1.1.4 — DCR-8 cursor durable (migration 0028 ตาม codex gate r2 MAJOR-1/2 + MINOR-3): `cert_bulk_jobs` เพิ่มคอลัมน์ `cursor_submitted_at`/`cursor_attempt_id` + ตารางใหม่ `cert_auto_cursor` (§3.7) — step/tick เดินคิวต่อจาก cursor ที่ commit ไว้**ข้าม CALL** (at-least-once ไม่มีแถวถูกข้าม) · เพดาน 100k ของ job ตรวจก่อนลูปและก่อน branch ชนเพดาน call · builtin ทั้งหมด qualify `pg_catalog` · 1.1.3 — DCR-8 worker redesign (migration 0027 ตาม codex gate r1 M1/M2/M3): เปลี่ยน runner/tick เป็น **procedure commit ต่อใบ** `admin_cert_bulk_issue_step`/`cert_auto_issue_tick` + picker v2 มี cursor เดินผ่านแถวที่ล้ม + BFF POST insert-only 202 (worker pg_cron ทุกนาที) + ข้อจำกัด PG ≥15 (procedure ที่ COMMIT ห้าม SECURITY DEFINER/SET search_path) · 1.1.2 — DCR-8 (Wave E Phase 2, migration 0026): ตารางใหม่ `feature_flags` (§3.7) + RPC runner `admin_cert_bulk_issue_run`/`cert_auto_issue_tick` (CRT-008) + `cert_issue_core` เพิ่ม `p_mode` manual/bulk/auto ลง audit context + policy `app_owner` ของ `cert_bulk_jobs` ให้ runner (D55-5/D55-7) — *runner/tick ของ 0026 ถูก 0027 แทนแล้ว* · 1.1.1 — DCR-7 (Wave E): view `course_exam_summary` เพิ่มคอลัมน์ `assessment_id` (PB-17) · `question_snapshot` เพิ่มคีย์ `type` (PB-18) · ตารางใหม่ `cert_bulk_jobs` (§3.7) · อ่านบทเรียนยอม enrollment active/completed (ปิด D39 — D55-4) · 1.1.0 — additive (DCR-4): enum `course_level` + `courses.level`/`outcome_highlights` + views `course_public_stats`/`course_instructors_public`/`course_exam_summary` · 1.0.0 ผ่าน CTO gate (codex รอบ 5: PASS — D17) · แก้ตาม D8–D16 · baseline สำหรับ Wave B |
| วันที่    | 2026-09-09                                        |
| เจ้าของ  | worker-3 (Wave A — deliverable 7)                 |
| สถานะ    | ผ่าน CTO gate (codex รอบ 5: PASS — D17)           |
| อ้างอิงบังคับ | PROJECT-BRIEF.md §5 (8 โดเมน), §8 (RLS/PDPA/audit) |
| เอกสารเชื่อมโยง | SDS.md, ARCHITECTURE.md, RBAC-DESIGN.md, AUDIT-LOG-DESIGN.md |

> เอกสารนี้คือ blueprint เดียวของสคีมา — migration ทุกตัวต้องตรงกับนี่ทุกตาราง/คอลัมน์/index/policy; จะเพิ่ม/แก้ต้องผ่าน DCR

## 1. แบบแผนกลาง (ใช้กับทุกตาราง)

- **PK**: `id uuid NOT NULL DEFAULT gen_random_uuid()` — ยืนยันเป็น **UUID v4** (random, built-in ของ PG13+; ไม่ใช้ v7 ใน v1) (ระบุเฉพาะเมื่อต่างจากนี้)
- **Extensions ที่ migration ต้อง enable ก่อนสร้าง schema (D13-F13)**: `CREATE EXTENSION IF NOT EXISTS btree_gist;` — EXCLUDE ของ `renewal_cycles` (§3.5) ใช้ `user_id WITH =` (uuid) ใน GiST ต้องใช้ opclass จาก btree_gist (PG15 ไม่มี built-in สำหรับ uuid — ไม่ enable จะสร้าง constraint ไม่ได้); `gen_random_uuid()` ใช้ built-in ไม่ต้อง pgcrypto
- **เวลา**: `created_at timestamptz NOT NULL DEFAULT now()`; ตารางที่มี `updated_at` อัปเดตด้วย trigger `set_updated_at()` (ดู §4.2); เวลาทั้งหมดเป็น timestamptz (UTC)
- **Soft delete**: ตารางที่มี `deleted_at timestamptz NULL` = ห้าม hard delete ผ่านแอป — ดู §4.3; index ที่เกี่ยวกับ lookup ใช้ partial `WHERE deleted_at IS NULL`
- **FK**: `ON DELETE RESTRICT` เป็นค่าเริ่มต้น (รักษาประวัติ/audit — ไม่ cascade ทิ้งข้อมูลอ้างอิง) ยกเว้นระบุชัด
- **บทบาท DB**: `anon`, `authenticated`, `service_role` — BFF ใช้ `service_role` ฝั่ง server เท่านั้น; policy ที่เขียนด้านล่างมีผลกับ `anon`/`authenticated` (service_role bypass RLS แต่ทุกตารางยังต้อง enable + มี policy ครบ ตาม brief §8)
- **helper ของ RLS** (canonical set ตาม D8/B-02 — นิยามเต็มที่ RBAC-DESIGN.md §3.1): `auth.uid()`, `public.my_roles()`, `public.has_any_role(text[])`, `public.is_staff()` — policy ด้านล่างเรียก helper ชุดนี้เท่านั้น ห้ามเขียนเงื่อนไข role ซ้ำซ้อนแบบ inline
- **ขอบเขต SELECT ของ staff ใน policy ด้านล่าง derive จาก permission matrix ของ RBAC-DESIGN.md §2** (sv=staff:viewer, sc=staff:content, se=staff:exam, sr=staff:registrar, sa=super_admin) — policy ห้ามใช้ "staff ทุกระดับ" กว้าง ๆ นอกจากที่ matrix อนุญาตจริง; รายการที่ยังเขียนกว้างไว้ (ตาราง quiz/เนื้อหา) ให้ตีความตาม matrix นี้เสมอ (D11-4/5)
- ทุกตารางระบุ: วัตถุประสงค์ / คอลัมน์ / คีย์+index / นโยบาย RLS (ใครทำอะไรได้เงื่อนไขใด) / retention

## 2. ENUM Types

| ENUM | ค่า |
| ---- | -- |
| `role_key` | citizen, lawyer, instructor, staff:viewer, staff:content, staff:exam, staff:registrar, super_admin (colon ตาม brief §4 — Postgres enum label ใส่ ':' ได้) |
| `license_status` | pending, verified, rejected, expired |
| `course_status` | draft, pending_review, published, archived |
| `course_level` | beginner, intermediate, advanced (DCR-4) |
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

## 3. ตารางตามโดเมน (41 ตาราง)

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
| pdpa_consented_at | timestamptz | NULL — (หมายเหตุ D12/F18) หลักฐาน "รับทราบประกาศ" แยกไป `notice_acknowledgments` แล้ว — คอลัมน์นี้เหลือเฉพาะ consent PDPA จริง จะ NOT NULL เมื่อ flow consent ใช้งาน (SRS) |
| is_active | boolean | NOT NULL DEFAULT true |
| deleted_at | timestamptz | NULL (soft delete) |
คีย์/Index: UNIQUE(email) WHERE deleted_at IS NULL; INDEX(deleted_at)
RLS: **SELECT** เจ้าของแถว (`id = auth.uid()`) หรือ `has_any_role('staff:viewer','staff:registrar','super_admin')` (user:view ผู้อื่น = มี PII — RBAC §2 ให้เฉพาะ sv/sr/sa **ไม่ใช่ staff ทุกระดับ** — D11-4); **INSERT** ไม่เปิดทางแอป (ผ่าน trigger security definer + service_role เท่านั้น); **UPDATE** เจ้าของแถวได้เฉพาะ display_name/phone/preferred_locale/pdpa_consented_at (บังคับผ่าน BFF + trigger guard คอลัมน์), super_admin ได้ทุกคอลัมน์; **DELETE** ไม่อนุญาต — staff อ่าน PII ผู้อื่นผ่าน BFF เท่านั้น (จำกัดตาม permission matrix)
Retention: อายุบัญชี + 10 ปีหลังลบ — **anonymize เมื่อใช้สิทธิ์ลบ** (เก็บ audit/หลักฐานธุรกิจไว้ — canonical ที่ §4.6)

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
| revoked_at | timestamptz | NULL (เพิกถอนใบอนุญาต — NULL + status='verified' = ใบใช้งานอยู่ — F20/D12) |
| rejected_reason | text | NULL (เมื่อ status='rejected' ต้อง NOT NULL — CHECK) |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(user_id, license_no) WHERE deleted_at IS NULL; **UNIQUE(license_no) WHERE revoked_at IS NULL** (เลขใบอนุญาตหนึ่งเลขผูกกับบัญชี active ได้เดียว — F20/D12); INDEX(license_no) WHERE deleted_at IS NULL; CHECK (status='rejected' ↔ rejected_reason IS NOT NULL) — หมายเหตุ: approval function ตรวจ conflict ของ license_no **แบบ atomic ใน TX เดียวกับการ grant** ก่อนอนุมัติ (ชน → ERR-PRF-001)
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
RLS: **SELECT** เจ้าของแถว (ดูบทบาทตัวเอง) หรือ `has_any_role('staff:viewer','staff:registrar','super_admin')` (ดูบทบาทผู้อื่น = user:view — RBAC §2); **INSERT/UPDATE** service_role เท่านั้น (บังคับผ่าน BFF + audit ทุกครั้ง); **DELETE** ไม่อนุญาต (ใช้ revoked_at)
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

#### `notice_acknowledgments` — หลักฐานการรับทราบประกาศ **(append-only — แยกจาก consents — F18/D12)**

วัตถุประสงค์ (ตารางเสริม D12): บันทึกว่าผู้ใช้กดรับทราบประกาศ/ข้อกำหนดของระบบ (notice_key + version) — **คนละความหมายกับ `consents`** (consent PDPA จริง — ให้/ถอนได้) ตารางนี้เป็น append-only เพื่อเป็นหลักฐานการรับทราบต่อเวอร์ชัน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| notice_key | text | NOT NULL (คีย์ประกาศ เช่น 'regulation_update_2026') |
| version | text | NOT NULL (เวอร์ชันของประกาศที่รับทราบ) |
| acknowledged_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: UNIQUE(user_id, notice_key, version); INDEX(notice_key, version)
RLS: **SELECT** เจ้าของแถว; **INSERT** เจ้าของแถวผ่าน BFF (acknowledge ของตัวเอง); **UPDATE/DELETE/TRUNCATE ไม่มี path เด็ดขาด** (append-only — รวม REVOKE ใน §4.4; TRUNCATE อยู่นอก RLS จึงบังคับด้วย REVOKE — D15-M3); service_role อ่านเพื่อ gate ฟีเจอร์ที่ต้องรับทราบก่อน
Retention: ตลอดอายุบัญชี (หลักฐานการรับทราบ — canonical ที่ §4.6)

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
RLS: **SELECT** ทุกคนรวม guest (เฉพาะ is_active) + **policy เสริม (DCR-4): `cc_read_admin`** — `has_any_role('staff:viewer','staff:content','super_admin')` เห็นทุกแถวรวม is_active=false (ให้ GET /admin/categories "ทุกสถานะ" ตาม API-SPEC §3.8 ได้ด้วย user-JWT — policy เสริมแบบ permissive รวมกับ cc_read); **INSERT/UPDATE** staff:content/super_admin ผ่าน BFF; **DELETE** ไม่อนุญาต (ปิดด้วย is_active)
Retention: ถาวร (ข้อมูลอ้างอิง)

#### `courses` — หลักสูตร

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| code | text | NOT NULL UNIQUE (รหัสหลักสูตร) |
| category_id | uuid | NOT NULL FK→course_categories |
| created_by | uuid | NOT NULL FK→profiles (เจ้าของหลักสูตร — instructor ผู้สร้าง; ใช้กับ RLS ownership — D11-4/DCR-3) |
| title_th / title_en | text | NOT NULL / NULL |
| summary | text | NULL |
| description_md | text | NULL |
| cover_media_id | uuid | NULL FK→media_assets |
| language | text | NOT NULL DEFAULT 'th' |
| is_public | boolean | NOT NULL DEFAULT true (false = สำหรับทนายเท่านั้น) |
| level | course_level | NOT NULL DEFAULT 'beginner' (DCR-4 — ระดับชั้นหลักสูตร แสดงบน catalog) |
| outcome_highlights | text[] | NULL (DCR-4 — จุดเด่น "สิ่งที่จะได้เรียนรู้" แสดงบนรายละเอียด) |
| credit_type | text | NOT NULL DEFAULT 'general' (ค่า config จาก credit_rules) |
| status | course_status | NOT NULL DEFAULT 'draft' |
| version | int | NOT NULL DEFAULT 1 (บัมพ์เมื่อเนื้อหาเปลี่ยนสำคัญ) |
| published_at | timestamptz | NULL |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(code); INDEX(category_id, status); INDEX(status) WHERE deleted_at IS NULL
RLS: **SELECT** ทุกคนเห็นเฉพาะ status='published' (และ is_public หรือผู้ใช้มี role lawyer); instructor เจ้าของ + `has_any_role('staff:viewer','staff:content','super_admin')` เห็นทุกสถานะ (course:view draft — RBAC §2); **INSERT/UPDATE** instructor (เจ้าของ)/staff:content/super_admin; การเปลี่ยนสถานะเป็น published ต้องเป็น staff:content เท่านั้น (workflow อนุมัติ); **DELETE** ไม่อนุญาต
Retention: ถาวร (ประวัติหลักสูตร/ประกาศนียบัตรอ้างถึง)

**Views สาธารณะของ catalog (DCR-4 — เติมฟิลด์แสดงผลที่ SRS CAT-002/CAT-004 กำหนดแต่ตารางฐานถูก RLS กั้น):** ทั้งสามเป็น `security_invoker = off` (definer-owned โดย postgres) + `GRANT SELECT` ให้ `anon, authenticated` — เปิดเฉพาะคอลัมน์ระบุ ไม่เปิดตารางฐาน:

- `course_public_stats` — ต่อหลักสูตร published: `learner_count` (count enrollments สถานะไม่ใช่ cancelled — ค่ารวม ไม่ใช่ PII) + `credits` (จาก `credit_rules` ที่ `course_id` ตรง + `status='active'` + effective window ครอบ `now()` + `priority` ต่ำสุด — NULL ถ้าไม่มีกฎ) — ทำให้ catalog แสดงยอดผู้เรียน/credit ได้โดยไม่เปิด SELECT บน enrollments/credit_rules (RLS ของตารางฐานคงเดิมทั้งหมด)
- `course_instructors_public` — `course_id` + display ของผู้สอนหลัก (join `profiles` ผ่าน `courses.created_by`): เปิดเฉพาะ `display_name`, `title` (ถ้ามีคอลัมน์/fallback NULL), `bio` — **ห้ามเปิด email/phone/ชื่อจริง** (ปรับปรุงเป็นตาราง course_instructors หลายคนตอน authoring wave — D25-O3)
- `course_exam_summary` — `course_id`, `question_count`, `time_limit_minutes`, `pass_score_pct`, `max_attempts` จาก assessments ปลายหลักสูตรที่ active (CAT-004 AC — เงื่อนไขสอบแสดงก่อนลงทะเบียน) + `assessment_id` (uuid — id ของแถว assessments ที่ view เลือก: published+is_final ล่าสุดต่อหลักสูตร · DCR-7/PB-17) — **ห้ามสลับตำแหน่งคอลัมน์เดิม — คอลัมน์ใหม่ต่อท้ายสุดเสมอ** ตามข้อจำกัด CREATE OR REPLACE ของ PostgreSQL (D55-10)

#### `course_modules` — โมดูลของหลักสูตร

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| course_id | uuid | NOT NULL FK→courses |
| title_th | text | NOT NULL |
| sort_order | int | NOT NULL |
| is_preview | boolean | NOT NULL DEFAULT false (ดูได้โดยไม่ลงทะเบียน) |
| deleted_at | timestamptz | NULL |
คีย์/Index: UNIQUE(course_id, sort_order) WHERE deleted_at IS NULL; INDEX(course_id)
RLS: สืบตาม courses (เห็นเมื่อเห็นหลักสูตร); **INSERT/UPDATE** instructor เจ้าของ/staff:content/super_admin; **DELETE** ไม่อนุญาต — **หมายเหตุ (DCR-7 — ปิด D39 · D55-4):** เงื่อนไข enrollment ของ policy อ่าน (`cm_read`) ยอม `e.status in ('active','completed')` ตั้งแต่ DCR-7 (ผู้เรียนที่จบหลักสูตรแล้วยังอ่านบทเรียนทบทวนได้) · `uq_enrollments_user_course_active` **คงเดิม** (1 แถว/คน/หลักสูตรข้ามสถานะ)
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
RLS: สืบตาม courses; **INSERT/UPDATE** instructor เจ้าของ/staff:content/super_admin; **DELETE** ไม่อนุญาต — **หมายเหตุ (DCR-7 — ปิด D39 · D55-4):** เงื่อนไข enrollment ของ policy อ่าน (`lessons_read`) ยอม `e.status in ('active','completed')` ตั้งแต่ DCR-7 (ผู้เรียนที่จบหลักสูตรแล้วยังอ่านบทเรียนทบทวนได้) · `uq_enrollments_user_course_active` **คงเดิม** (1 แถว/คน/หลักสูตรข้ามสถานะ)
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
RLS: **SELECT** เจ้าของแถว · `has_any_role('staff:viewer','super_admin')` · instructor เจ้าของหลักสูตร · staff:exam/staff:registrar เฉพาะขอบเขตรายงานของตน (ผลสอบ/credit — อ่านผ่าน view ตาม report:view RBAC §2) — ไม่เปิด SELECT ทั้งตารางให้ staff ทุกระดับ (D11-4); **INSERT/UPDATE ไม่มี policy ให้ผู้เรียน (F2/D12)** — INSERT ผ่าน `enroll()` SECURITY DEFINER (ตรวจสิทธิ์/หลักสูตร published/ห้ามซ้ำข้างใน), UPDATE เฉพาะ rollup/งานทะเบียน; **DELETE** ไม่อนุญาต (ใช้ cancelled)
Retention: ตามอายุบัญชี (learning records — canonical ที่ §4.6; ฐานของประกาศนียบัตร/credit คงอยู่ผ่าน certificates/credit_ledger_entries ที่เป็นถาวร)

### 3.3 Learning & Progress

#### `lesson_progress` — ความคืบหน้าต่อบทเรียน

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| enrollment_id | uuid | NOT NULL FK→enrollments |
| lesson_id | uuid | NOT NULL FK→lessons |
| status | progress_status | NOT NULL DEFAULT 'not_started' |
| video_max_position_sec | int | NULL DEFAULT 0 CHECK >= 0 (monotonic ฝั่ง server — ใช้เป็นตำแหน่ง resume ไม่ใช่ฐานคำนวณจบบท) |
| watch_sec_accum | int | NOT NULL DEFAULT 0 CHECK >= 0 (วินาทีรับชมที่ server ยอมรับจาก bounded playback intervals — D11-15/SDS §3.3) |
| watch_pct | smallint | NOT NULL DEFAULT 0, CHECK 0–100 (= min(100, watch_sec_accum/duration*100)) |
| dwell_sec | int | NOT NULL DEFAULT 0 CHECK >= 0 |
| quiz_score_pct | smallint | NULL (บท quiz) |
| completed_at | timestamptz | NULL (idempotent — ตั้งครั้งเดียว) |
| updated_at | timestamptz | DEFAULT now() |
คีย์/Index: UNIQUE(enrollment_id, lesson_id); INDEX(lesson_id)
RLS: **SELECT** เจ้าของผ่าน enrollment · `has_any_role('staff:viewer','super_admin')` · instructor เจ้าของหลักสูตร (ความคืบหน้าเป็นข้อมูลผู้อื่น — RBAC §2); **INSERT/UPDATE ไม่มี policy ให้ผู้เรียน (F2/D12)** — เขียนผ่าน `record_lesson_progress()` SECURITY DEFINER (server ตัดสิน bounded intervals/completed_at ข้างใน — SDS §3.3); **DELETE** ไม่อนุญาต
Retention: ตามอายุบัญชี (learning records — canonical ที่ §4.6)

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
RLS: **ไม่มี policy ให้ผู้เรียน (F4/D12 — ตารางฐานมี explanation/เฉลย)** — ผู้เรียนได้รับโจทย์ผ่าน BFF เท่านั้น; **SELECT** instructor เจ้าของ + `has_any_role('staff:viewer','staff:content','super_admin')`; **INSERT/UPDATE** instructor เจ้าของ/staff:content; **DELETE** ไม่อนุญาต (ใช้ is_active=false)
Retention: ถาวร

#### `quiz_options` — ตัวเลือกของคำถาม quiz

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| question_id | uuid | NOT NULL FK→quiz_questions |
| option_text | text | NOT NULL |
| is_correct | boolean | NOT NULL |
| sort_order | int | NOT NULL |
คีย์/Index: UNIQUE(question_id, sort_order)
RLS: **ไม่มี policy ให้ผู้เรียน (F4/D12 — is_correct เป็นเฉลย)** — BFF อ่านผ่าน service path แล้วส่งเฉพาะ id/text/sort_order **ไม่มี is_correct ตลอดการทำ quiz** (คะแนนตัดสินฝั่ง server); **SELECT** instructor เจ้าของ + `has_any_role('staff:viewer','staff:content','super_admin')`; **INSERT/UPDATE** instructor เจ้าของ/staff:content; **DELETE** ไม่อนุญาต
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
RLS: **SELECT** เจ้าของแถว + `has_any_role('staff:viewer','staff:exam','staff:registrar','super_admin')` + instructor เจ้าของหลักสูตร; **INSERT/UPDATE ไม่มี policy ให้ผู้เรียน (F2/D12)** — เขียนผ่าน `record_quiz_attempt()` SECURITY DEFINER (INSERT + ตรวจ max_attempts + ตรวจคะแนนจาก quiz_options ข้างใน function เดียว); **DELETE** ไม่อนุญาต
Retention: ตามอายุบัญชี (learning records — canonical ที่ §4.6)

### 3.4 Assessment & Certification

#### `question_banks` — ธนาคารข้อสอบ

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| code | text | NOT NULL UNIQUE |
| name | text | NOT NULL |
| created_by | uuid | NOT NULL FK→profiles (เจ้าของ bank; ใช้กับ RLS ownership — D11-4/DCR-3) |
| course_id | uuid | NULL FK→courses (NULL = ใช้ร่วม) |
| category_id | uuid | NULL FK→course_categories |
| description | text | NULL |
| is_active | boolean | NOT NULL DEFAULT true |
คีย์/Index: UNIQUE(code); INDEX(course_id)
RLS: **SELECT** instructor เจ้าของ bank + `has_any_role('staff:viewer','staff:exam','super_admin')` (question_bank:view — RBAC §2; ไม่รวม staff:content; ผู้เรียนไม่เห็น); **INSERT/UPDATE** instructor/staff:exam/super_admin; **DELETE** ไม่อนุญาต
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
| version | int | NOT NULL DEFAULT 1 (bump เมื่อแก้โจทย์/ตัวเลือก — `attempt_answers.question_snapshot` อ้างเวอร์ชันนี้ — F13/D12) |
คีย์/Index: INDEX(bank_id, status, difficulty); GIN(tags)
RLS: **SELECT** instructor เจ้าของ bank + `has_any_role('staff:viewer','staff:exam','super_admin')` เท่านั้น (question_bank:view — RBAC §2) — **ผู้เรียนห้าม query โดยตรง — ไม่มี learner policy (F4/D12)** (ได้รับเฉพาะ snapshot ผ่าน BFF ตอนสอบ); **INSERT/UPDATE** instructor/staff:exam/super_admin (เปลี่ยน status='active' ต้อง staff:exam); **DELETE** ไม่อนุญาต (ใช้ retired)
Retention: ถาวร (อ้างอิงโดย attempt_answers)

#### `question_options` — ตัวเลือกของข้อสอบ

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| question_id | uuid | NOT NULL FK→questions |
| option_text | text | NOT NULL |
| is_correct | boolean | NOT NULL |
| sort_order | int | NOT NULL |
คีย์/Index: UNIQUE(question_id, sort_order); เงื่อนไขความถูกต้องบังคับด้วย trigger (single_choice/true_false ต้องมีคำตอบถูก 1 ตัว)
RLS: **SELECT** เฉพาะ instructor เจ้าของ bank + `has_any_role('staff:viewer','staff:exam','super_admin')` และ service_role (question_bank:view — RBAC §2) — ผู้เรียนได้รับทาง BFF โดย **ตัด is_correct ทิ้งเสมอ**; **INSERT/UPDATE** instructor/staff:exam/super_admin; **DELETE** ไม่อนุญาต
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
คีย์/Index: UNIQUE(assessment_id, version); INDEX(assessment_id, effective_from) — attempt ใช้ rules เวอร์ชันที่มีผล ณ วันสอบ โดยใส่เงื่อนไข `effective_from <= now()` **ตอน query** (ห้ามเป็น index predicate — now() ไม่ immutable ใช้ใน index predicate ไม่ได้ — F21/D12); การแก้กฎไม่ย้อนหลัง
RLS: **SELECT** ผู้ลงทะเบียน (เห็นเฉพาะฟิลด์ที่เกี่ยวกับผู้สอบ เช่น เวลา/จำนวนครั้ง) + instructor เจ้าของหลักสูตร + `has_any_role('staff:viewer','staff:exam','staff:registrar','super_admin')` เห็นเต็ม (assessment:view กติกา — RBAC §2); **INSERT/UPDATE** staff:exam/super_admin ผ่าน BFF + audit (แก้ = สร้าง version ใหม่); **DELETE** ไม่อนุญาต
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
| session_id | text | NOT NULL (session เจ้าของ attempt — lease จาก JWT claim `session_id` — F22/D12) |
| lease_expires_at | timestamptz | NULL (อายุ lease ต่อ request — session/อุปกรณ์อื่น takeover ได้หลังหมด `exam_disconnect_grace_minutes` (default 5 นาที) + audit `EXAM_SESSION_TAKEOVER` — SDS §3.1f) |
| started_at | timestamptz | NOT NULL DEFAULT now() (DB clock — จับเวลา server-side) |
| expires_at | timestamptz | NOT NULL (= started_at + rules.time_limit_minutes ตอนสร้าง) |
| submitted_at | timestamptz | NULL (idempotent key ของ submit) |
| score_pct | smallint | NULL CHECK 0–100 |
| passed | boolean | NULL |
| question_count | int | NOT NULL |
| correct_count | int | NULL |
| client_events | jsonb | NULL (proctoring ระดับ basic — บันทึก client events เช่น tab blur; จำกัดขนาด, ไม่มี PII) |
คีย์/Index: UNIQUE(assessment_id, user_id, attempt_no); **UNIQUE(assessment_id, user_id) WHERE status='in_progress'** (ป้องกันสอบซ้อน — SDS §3.1f); INDEX(status) WHERE status='in_progress' (auto-submit job); INDEX(user_id)
RLS: **SELECT** เจ้าของแถว + `has_any_role('staff:viewer','staff:exam','staff:registrar','super_admin')` + instructor เจ้าของหลักสูตร (attempt:view ทุกคน — RBAC §2); **INSERT/UPDATE ไม่มี policy ให้ผู้เรียน (F2/D12)** — INSERT ผ่าน `start_attempt()` (ตรวจ enrollment/max_attempts/attempt ค้าง + ผูก session_id/lease ข้างใน), UPDATE ผ่าน `save_answer()`/`submit_attempt()`/auto-submit job เท่านั้น; **DELETE** ไม่อนุญาต (ยกเลิกด้วย status='voided' โดย staff:exam + audit)
Retention: ตามอายุบัญชี (learning records — canonical ที่ §4.6)

#### `attempt_answers` — คำตอบรายข้อ (snapshot ของการสุ่ม)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| attempt_id | uuid | NOT NULL FK→assessment_attempts |
| question_id | uuid | NOT NULL FK→questions |
| seq | int | NOT NULL (ลำดับที่สุ่มได้) |
| option_order | int[] | NULL (ลำดับตัวเลือกที่สุ่ม ณ ตอน start) |
| selected_option_ids | uuid[] | NULL (บันทึกทีละข้อ — UPSERT) |
| question_snapshot | jsonb | NOT NULL — โครง `{question_id, version, text, type, options:[{id, text, is_correct, points}], points}` (snapshot ณ วินาที start — D11-16/F13/F14: Grader ตรวจจาก snapshot ล้วน การแก้ข้อสอบระหว่างสอบไม่กระทบ attempt ที่กำลังสอบ) · **`type`** (text: single_choice/multiple_choice/true_false — ชนิดข้อ ณ เวลา start attempt · DCR-7/PB-18) — snapshot เดิมก่อน DCR-7 ไม่มี type → projection view ใช้ default `'multiple_choice'` (พฤติกรรม checkbox เดิม · grading set-equality ฝั่ง server เป็นผู้ตัดสินอยู่แล้ว) |
| is_correct | boolean | NULL (ตั้งตอนตรวจ) |
| points_earned | smallint | NULL |
| answered_at | timestamptz | NULL |
คีย์/Index: UNIQUE(attempt_id, question_id); INDEX(question_id)
RLS: **ผู้เรียนไม่มี SELECT policy บนตารางฐาน (F4/D12)** — แถวมี `question_snapshot` (is_correct = เฉลย) ผู้เรียนอ่านผ่าน view `learner_attempt_view` เท่านั้น; **SELECT** เฉพาะ `has_any_role('staff:viewer','staff:exam','staff:registrar','super_admin')` — **instructor ไม่มี SELECT ตรงแม้เป็นเจ้าของหลักสูตร (D15-N2: ownership เฉย ๆ ไม่เปิด raw table เพราะมีเฉลยใน `question_snapshot`) — instructor อ่านผ่าน `instructor_attempt_view` ตามนิยามด้านล่าง**; **INSERT/UPDATE ไม่มี policy ให้ผู้เรียน (F2)** — สร้าง snapshot โดย `start_attempt()`, บันทึกคำตอบ/ผลตรวจโดย `save_answer()`/`submit_attempt()`; **DELETE** ไม่อนุญาต
Retention: ตามอายุบัญชี (learning records — canonical ที่ §4.6)

**View สำหรับผู้เรียน (F4/D12)**: `learner_attempt_view` — SELECT เฉพาะแถวของตัวเอง (join ผ่าน `assessment_attempts.user_id = auth.uid()`) และ **ตัดคอลัมน์เฉลยออก** (`is_correct`, `points_earned`, `question_snapshot` และ explanation) — เปิดเฉลยเมื่อครบเงื่อนไขตาม `exam_review_mode` (SRS Appendix A; เงื่อนไขอยู่ในนิยาม view เช่น `submitted_at IS NOT NULL` + grace) ; grant SELECT ให้ authenticated — ผู้เรียนไม่ SELECT ตารางฐานโดยตรง

**View สำหรับ instructor (D15-N2 — รองรับ `attempt:view O†` ของ RBAC §2.2)**: `instructor_attempt_view` — SELECT เฉพาะแถวของ attempt ที่อยู่ในหลักสูตรที่ตนเป็นเจ้าของ (ตรวจสองชั้นในนิยาม view: บทบาท `instructor` + `courses.created_by = auth.uid()` ผ่าน join assessment_attempts → enrollments → courses) และ **ตัดคอลัมน์เฉลยออกเหมือน learner view** (`is_correct`, `points_earned`, `question_snapshot`, explanation) — เหลือข้อมูลผลลัพธ์ระดับรายการ (`selected_option_ids`, `answered_at`, `seq`) + คะแนนรวม/สถานะจาก `assessment_attempts` เพื่อให้ผู้สอนเห็นผลรอบสอบที่ตนดูแลโดยไม่เปิดเฉลยข้อสอบ; เปิดเฉลยเฉพาะเมื่อครบเงื่อนไข `exam_review_mode` เช่นเดียวกับ learner view; grant SELECT ให้ authenticated (นิยาม view กรองเอง) — instructor ไม่ SELECT ตารางฐานโดยตรงเช่นกัน

#### `certificates` — ประกาศนียบัตร **(PII — PDPA: holder_name_snapshot)**

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| cert_no | text | NOT NULL UNIQUE — รูปแบบ `LTC-<ปี ค.ศ.>-<สุ่ม 6 หลัก>` ตาม SRS Appendix A `certificate_code_format` (สุ่มด้วย CSPRNG + ตรวจ UNIQUE ซ้ำใน transaction; **ไม่ใช้ sequence** เพราะลำดับถูกเดาเลขถัดไปได้ — รอยืนยันรูปแบบกับสภาฯ) |
| verify_code | text | NOT NULL UNIQUE (nanoid 43 อักขระ, CSPRNG — คีย์สาธารณะ ไม่มี PII) |
| enrollment_id | uuid | NOT NULL FK→enrollments (partial UNIQUE WHERE status='valid' — 1 หลักสูตรต่อบัญชีมีใบ valid ได้ 1 ใบ แต่มีประวัติ reissue ได้ — F16/D12) |
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
| supersedes_cert_id | uuid | NULL FK→certificates (lineage — ใบใหม่ชี้กลับใบเก่าที่ตนแทนที่ — F16/D12) |
คีย์/Index: UNIQUE(cert_no); UNIQUE(verify_code); **UNIQUE(enrollment_id) WHERE status='valid'** (partial — F16/D12); INDEX(user_id); INDEX(supersedes_cert_id); CHECK (status='revoked' ↔ revoked_at IS NOT NULL)
RLS: **SELECT** เจ้าของแถว หรือ staff:registrar/super_admin — path สาธารณะเป็น BFF อย่างเดียว: `GET /certificates/{code}` ตอบ **200 เสมอ** ด้วย 4 ฟิลด์ `{code, course_title, issued_at, status ∈ valid|revoked|superseded}` — **ห้ามแสดงชื่อเจ้าของ** (ชื่ออยู่บน PDF เท่านั้น — D8); **INSERT** service_role ผ่าน BFF โดย staff:registrar/super_admin เท่านั้น + audit; **UPDATE** service_role (เปลี่ยน status พร้อมเหตุผล — registrar); **DELETE** ไม่อนุญาตเด็ดขาด
Retention: ถาวร (เอกสารสิทธิ)

#### `certificate_verifications` — บันทึกการตรวจสอบสาธารณะ

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| verify_code | text | NOT NULL (ค่าที่ผู้ตรวจสอบส่งมา — ไม่ FK เพราะ not_found ก็ต้องบันทึก) |
| result | verification_result | NOT NULL |
| ip_hash | text | NOT NULL (sha256 + salt — ไม่เก็บ IP ตรง) |
| user_agent_hash | text | NULL (sha256 hex 64 + CHECK `^[0-9a-f]{64}$` — r9-O1: header UA เป็นค่าอิสระของ anon จึง hash ก่อนเก็บเหมือน ip_hash ไม่เก็บข้อความดิบ) |
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
| status | text | NOT NULL DEFAULT 'draft', CHECK IN ('draft','active','retired') (lifecycle versioned — **การจับคู่กฎเกิดครั้งเดียว ณ grading**: rule ที่ status='active' + effective window ครอบวันผ่าน **ณ ตอนตรวจ** จะถูก snapshot (`rule_id` + ค่าที่ใช้) ลง outbox event — credit worker ใช้ snapshot อย่างเดียว **ไม่ lookup ซ้ำ** แม้ rule ถูก retire ภายหลังระหว่าง event ค้างคิว — F17/D12 + D13-F6) |
| renewal_cycle | text | NULL (ประเภทรอบที่กฎผูก เช่น 'annual' — NULL = ตามรอบ default ของ config — รอยืนยัน Q1 — F17/D12) |
คีย์/Index: UNIQUE(code); INDEX(course_id, priority)
RLS: **SELECT** ผู้ใช้ role lawyer (ดูกฎของตัวเองแบบสรุป) + `has_any_role('staff:viewer','staff:registrar','super_admin')` (credit_rule:view — RBAC §2); **INSERT/UPDATE** super_admin/staff:registrar ผ่าน BFF + audit (แก้ = สร้างเวอร์ชันใหม่ไม่แก้ย้อนหลัง); **DELETE** ไม่อนุญาต (retire ด้วย status='retired' / effective_to — F17/D12)
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
คีย์/Index: UNIQUE(user_id, cycle_no); EXCLUDE USING gist (user_id WITH =, daterange(starts_on, ends_on) WITH &&) — ห้ามรอบซ้อนกัน; **migration prerequisite: `CREATE EXTENSION IF NOT EXISTS btree_gist;` ก่อน constraint นี้ (uuid ใน GiST ต้องใช้ opclass จาก extension — §1, D13-F13)**; INDEX(user_id) WHERE status='open'
RLS: **SELECT** เจ้าของแถว + `has_any_role('staff:viewer','staff:registrar','super_admin')` (credit_ledger:view ผู้อื่น — RBAC §2); **INSERT/UPDATE** service_role เท่านั้น (สร้าง/ปิดรอบโดยระบบหรือ registrar ผ่าน BFF + audit); **DELETE** ไม่อนุญาต
Retention: ถาวร (ประวัติการต่ออายุ)

#### `credit_ledger_entries` — รายการ credit **(append-only — บังคับด้วย grants + RLS)**

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles |
| renewal_cycle_id | uuid | NOT NULL FK→renewal_cycles |
| entry_type | ledger_entry_type | NOT NULL |
| credit_type | text | NOT NULL DEFAULT 'general' |
| amount | numeric(6,2) | NOT NULL (signed — reversal ติดลบ) |
| certificate_id | uuid | NULL FK→certificates (เติมได้เฉพาะตอน INSERT เมื่อมีใบแล้ว — เช่น รอบ bulk; **ห้าม backfill แถวที่ INSERT ไปแล้ว** เพราะ UPDATE ถูก REVOKE (§4.4) — D13-F7; reporting เชื่อมใบผ่าน enrollment แทน: `certificates.enrollment_id` = enrollment ของ `source_id` attempt; **ไม่ใช่ต้นทางของ accrual** — F15/D12) |
| source_type | text | NOT NULL DEFAULT 'assessment_attempt' (ต้นทางของ accrual = attempt ที่ผ่าน — **การออกประกาศนียบัตรไม่ใช่ต้นทาง credit** — F15/D12) |
| source_id | uuid | NULL (= assessment_attempts.id เมื่อ source_type='assessment_attempt') |
| original_entry_id | uuid | NULL FK→credit_ledger_entries (ต้นทางของ reversal) |
| rule_id | uuid | NULL FK→credit_rules (กฎที่ใช้ตอน accrual) |
| reason | text | NULL (บังคับเมื่อ type IN ('adjustment','reversal') — CHECK) |
| created_by | uuid | NULL FK→profiles (NULL = ระบบ) |
| created_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: INDEX(user_id, renewal_cycle_id); INDEX(certificate_id); **UNIQUE(source_type, source_id, credit_type) WHERE entry_type='accrual' AND source_id IS NOT NULL** (กัน accrual ซ้ำจาก outbox consumer — D11-17); CHECK (entry_type IN ('adjustment','reversal') → reason IS NOT NULL AND created_by IS NOT NULL)
RLS: **SELECT** เจ้าของแถว + `has_any_role('staff:viewer','staff:registrar','super_admin')` (credit_ledger:view ผู้อื่น — RBAC §2); **INSERT** service_role เท่านั้น (accrual อัตโนมัติ / adjustment-reversal โดย registrar ผ่าน BFF + audit); **UPDATE/DELETE ไม่มี path เด็ดขาด** — REVOKE UPDATE, DELETE จากทุกบทบาท (คงไว้เฉพาะ migration owner) + ไม่มี policy อนุญาต + trigger guard กันซ้ำซ้อน (เช่น audit_logs — ดู §4.4)
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
RLS: **SELECT** ผู้รับเท่านั้น (JOIN ผ่าน notification_recipients — policy ใช้ EXISTS); **INSERT** service_role ผ่าน BFF (notification service — **เช็ค consent active ของผู้รับก่อนสร้าง** — F18/D12); **UPDATE** service_role (แก้ไขก่อนส่งได้); **DELETE** ไม่อนุญาต (ล้างตาม expires_at ด้วย job)
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

วัตถุประสงค์ (ตารางเสริมที่เพิ่มนอกรายการขั้นต่ำ): แยกการส่งอีเมลออกจาก request path + retry ได้ (SDS §8) — dev ใช้ Mailpit จับ, prod ใช้ Resend/SMTP; **worker เช็ค consent ที่ยัง active ของผู้รับ ณ ตอน dispatch** (ถอน consent = งดส่ง — F18/D12)

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

#### `event_outbox` — transactional outbox ของ event โดเมน **(D11-17)**

วัตถุประสงค์ (ตารางเสริม D11-17): กัน event หาย/เขียนครึ่ง ๆ กลาง ๆ — business TX (เช่น ออกประกาศนียบัตร) INSERT event ลงที่นี่ **ใน TX เดียวกัน** แล้ว worker ดึงไปทำงานต่อ (เช่น credit accrual — SDS §3.2/§4.5) หลัง commit

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| topic | text | NOT NULL (ชื่อ event เช่น certificate.issued) |
| payload | jsonb | NOT NULL (ข้อมูล event — ห้าม PII เกินจำเป็น) |
| status | text | NOT NULL DEFAULT 'pending', CHECK IN ('pending','processing','processed','failed') |
| attempts | int | NOT NULL DEFAULT 0 |
| last_error | text | NULL (ตัดทอน — ห้าม PII) |
| available_at | timestamptz | NOT NULL DEFAULT now() (retry backoff) |
| processed_at | timestamptz | NULL |
คีย์/Index: INDEX(status, available_at) WHERE status IN ('pending','processing'); INDEX(topic, processed_at)
RLS: **SELECT/UPDATE** service_role เท่านั้น (worker + BFF เขียน INSERT ใน TX ธุรกิจ); ไม่เปิดให้ `anon`/`authenticated` เห็น; **DELETE** ไม่อนุญาตจากแอป (purge ตาม retention ด้วย job เฉพาะ + audit)
Retention: purge 30 วันหลัง processed (canonical ที่ §4.6)

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
RLS: **SELECT** ผู้ขอเอง + `has_any_role('staff:viewer','super_admin')` + staff:exam (เฉพาะ report ผลสอบ) / staff:registrar (เฉพาะ report credit) — ตามขอบเขต report:view/export ของ RBAC §2; **INSERT** service_role ผ่าน BFF (บังคับ audit `ADMIN_EXPORT`); **UPDATE** service_role (worker); **DELETE** ไม่อนุญาต (ล้างตาม expires_at ด้วย job ที่มี audit)
Retention: แถว 12 เดือน (ไฟล์ 7 วันตาม expires_at)

#### `cert_bulk_jobs` — งานออกประกาศนียบัตรเป็นชุด **(DCR-7 · D55-5 · D36-O4)**

วัตถุประสงค์ (ตารางเสริม DCR-7 · D55-5 · D36-O4): งานออกประกาศนียบัตรเป็นชุด (`POST /admin/certificates/bulk` — API-SPEC §3.6) — job async ตารางสถานะ; คิว eligible กรองก่อนตัดหน้า (filter-before-cut) · **โมเดล worker ของ 0027**: BFF insert job (`status='pending'`) แล้วตอบ 202 ทันที — **ไม่รันใน request**; worker `admin_cert_bulk_issue_step` (pg_cron `ltc-cert-bulk-step` ทุกนาที) หยิบ job รัน **commit ต่อใบ** (ใบ + audit `CERT_ISSUE` mode='bulk' + counts ของ job = TX เดียวต่อใบ) และเดินผ่านแถวที่ล้มด้วย cursor · **0028**: cursor ของ job commit พร้อม counts ทุกใบ = CALL ถัดไปเดินต่อจริง (ไม่เริ่มหัวคิวใหม่ — at-least-once)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| id | uuid | PK (DEFAULT gen_random_uuid() — แบบแผนกลาง §1) |
| status | text | NOT NULL DEFAULT 'pending', CHECK IN ('pending','running','completed','failed') |
| total_attempts | int | NOT NULL (จำนวน attempt ในชุด — กรองจากคิว eligible แล้ว) |
| issued_count | int | NOT NULL DEFAULT 0 |
| failed_count | int | NOT NULL DEFAULT 0 |
| created_by | uuid | NOT NULL FK→profiles |
| course_id | uuid | NULL FK→courses (ขอบเขตรอบ) |
| last_error | text | NULL (ตัดทอน — ห้าม PII) |
| created_at | timestamptz | NOT NULL DEFAULT now() |
| finished_at | timestamptz | NULL |
| cursor_submitted_at | timestamptz | NULL (0028 MAJOR-1 — ตำแหน่งเดินคิวล่าสุดของ job commit พร้อม counts ทุกใบ ข้าม CALL; null = ยังไม่เริ่มเดิน) |
| cursor_attempt_id | uuid | NULL (0028 — tie-break เมื่อ submitted_at ซ้ำ) |
คีย์/Index: PK(id); INDEX(status) WHERE status IN ('pending','running'); INDEX(created_by, created_at DESC)
RLS: **ไม่มี policy สำหรับ JWT path ใด (fail-closed)** — ทุกการเข้าถึงผ่าน BFF `service_role` เท่านั้น (บทบาท gate ที่ BFF: staff:registrar + super_admin ตาม D55-2) — **ห้าม UPDATE issued_count/failed_count นอก worker path** · policy `app_owner_select_cert_bulk_jobs`/`app_owner_update_cert_bulk_jobs` (D58/0026 — ยังใช้เมื่อ invoker เป็น `app_owner`) · ผู้เขียนจริงของ 0027 = worker procedure ที่ cron (supabase_admin — superuser) เรียก
Retention: ถาวร (ประวัติงานออกใบ — ตรวจสอบย้อนหลัง)

Worker/procedure (0030 — canonical ของ tick · step ของ 0028 ยัง canonical ต่อ · tick แทนของ 0029 ตาม codex gate r4 MAJOR-1/2 · picker v2/ตาราง/cron/grants ยังเป็นของ 0027 · สัญญา inout p_result เท่าเดิมทุกการแทนที่):
- **`admin_cert_bulk_pick(p_course_id, p_limit, p_after_submitted_at, p_after_attempt_id)`** (SECURITY DEFINER `app_owner`) — คิว eligible เรียง `(submitted_at, attempt_id)` desc · **cursor คู่ (M1)**: caller ส่งตำแหน่งแถวสุดท้ายที่เห็น → ชุดถัดไปเริ่มหลังจากนั้น *ไม่สนผลสำเร็จ* (แถวที่ล้มถูกเดินผ่าน ไม่ปิดคิว) · EXECUTE: `app_owner`/`postgres` เท่านั้น (0027 ถอน service_role — BFF ไม่เรียกเองแล้ว)
- **`admin_cert_auto_unmarked_pick(p_course_id, p_limit, p_epoch)`** (0030 r4 MAJOR-1 — SECURITY DEFINER `app_owner` · language sql stable · แทน `admin_cert_auto_fresh_pick` ของ 0029 ที่ถูก drop) — คิว eligible ที่*ยังไม่ถูก mark* ของรอบ (scope, epoch): eligibility เหมือน picker v2 เป๊ะ (anti-join ใบ valid · enrollment completed · attempt passed) + anti-join `cert_auto_walked` · เรียง `(submitted_at, attempt_id)` **desc** = ใหม่สุดก่อน (arrival-first โดยลำดับ — แถวที่ commit ช้า ไม่มี marker จึงมองเห็นเสมอ ไม่ผูกกับช่วง submitted_at อีกต่อไป) · `p_epoch null` = ไม่คืนแถว (guard การเรียกลำพัง — tick ส่ง epoch จริงเสมอ) · EXECUTE: `app_owner`/`postgres` เท่านั้น (revoke รวม service_role)
- **`admin_cert_bulk_issue_step(p_job_id, p_max_certs, inout p_result)`** — PROCEDURE (ไม่ใช่ function) เพราะ **commit ต่อใบ**: หยิบทีละแถวผ่าน cursor → `cert_issue_core(actor=job.created_by, mode='bulk')` ใน savepoint (ใบล้มย้อนเฉพาะใบ) → update counts ของ job **+ cursor (0028)** → **COMMIT** (= TX เดียวต่อใบ — ใบ+audit+ความคืบหน้ามองเห็นจาก session อื่นทันที · M2) → เดินต่อ · เพดาน `p_max_certs` (clamp 1..10000, default 1000) ชนกลางคิว = คืน `status:'running'` แล้ว worker รอบถัดไปเล่นต่อจาก **cursor ที่ commit ไว้ในแถว job** (0028 MAJOR-1 — self-healing — รอบที่ pick ได้ 0 แถวปิด completed เอง) · เพดานสะสมของ job 100k แถว = `failed` **(0028 MAJOR-2: ตรวจก่อนเริ่มลูป — job ที่ถึงเพดานอยู่แล้วปิดทันทีไม่ประมวลผลแถวใด · และตรวจทุกแถวหลัง update counts *ก่อน* branch ชน v_max — ครบ 100,000 พอดีปิดในรอบเดียวแม้ p_max_certs=1)** · session advisory lock ต่อ job (`pg_try_advisory_lock` — ตัวอื่นถืออยู่ = คืน `locked`; row lock หลุดที่ COMMIT แรกจึงต้องระดับ session) · `p_job_id null` = worker หยิบ pending/running เก่าสุด (ไม่มี = `idle`) · เรียกตรง job ที่จบแล้ว → `ERR-VAL-001|bulk_job_already_finished` · job ไม่มี → `ERR-NF-001|bulk_job_not_found`
- **`cert_auto_issue_tick(p_course_id, p_max_certs, inout p_result)`** — **tick marker-based single lane (0030 r4 MAJOR-1/2 · แทน tick สองเฟสของ 0029)**: โหลด epoch + watermark สองคู่ — สถานะขัด (คู่ใดคู่หนึ่ง null คู่เดียว = สถานะที่ 0028 ค้างมา 0029 ไม่ normalize) → **normalize** เป็น sweep ใหม่ (epoch+1 · null ทั้งสี่ · ลบ marker เก่า) ภายใต้ advisory lock ของ scope · เดินแถว eligible ที่ยังไม่ mark **เรียง desc ทีละแถว** (ใหม่สุดก่อน = ผู้มาใหม่หัวคิวเสมอแม้ submitted_at จะตกในช่วงที่เดินไปแล้ว — AC ≤5 นาที): `cert_issue_core(actor ระบบ a170, mode='auto')` ใบล้มยกเลือกเฉพาะใบ → upsert watermark + **insert marker** = TX เดียวต่อแถว (ข้าม CALL จริง) · watermark สองคู่ = **ข้อมูลชี้แจง** (cursor = แถวสุดท้ายที่เดิน · sweep_top = หัวของ sweep ตั้งครั้งเดียวต่อรอบ — cursor อาจใหม่กว่าหัว) ไม่ใช่เงื่อนไข picker อีกต่อไป · คิวหมด (ไม่ capped หรือ capped แล้ว probe ด้วย picker ตัวเองยืนยัน ไม่มีแถว unmarked เหลือ) → ลบ marker รอบนี้ + epoch+1 + reset ทั้งสองคู่ = รอบ retry ใหม่ · รับขอบเขตหลักสูตร (`p_course_id null` = ทุกหลักสูตร — cron; test/ops ส่งหลักสูตรเจาะจง) · flag `cert_auto_issue` ปิด → `{skipped:true,reason:'flag_off'}` (ไม่ audit) · advisory lock **ต่อ scope** (`'ltc:cert-auto-issue:'||scope_key`) กำลังรัน → `{skipped:true,reason:'already_running'}`
- **ข้อจำกัด PG ≥15 (บทเรียนสำคัญ — พิสูจน์บน dev 15.8)**: procedure ที่ COMMIT **ห้ามเป็น SECURITY DEFINER และห้ามมี SET clause** (ทั้งคู่ทำให้ `0B000 invalid transaction termination`) → ทั้งสอง procedure เป็น INVOKER ธรรมดา + อ้างชื่อ 2-part ครบทุกตาราง/ฟังก์ชัน + **คุมสิทธิ์ที่ EXECUTE**: revoke ทุก JWT role รวม service_role เหลือ `app_owner`/`postgres` (cron supabase_admin = superuser) · ผลข้างเคียง: **PostgREST เรียก CALL procedure ไม่ได้** จึงเป็นเหตุผลรองของโมเดล worker (BFF insert job อย่างเดียว)
- **cron ×2**: `ltc-cert-bulk-step` ทุกนาที → `call public.admin_cert_bulk_issue_step(null, 1000, null)` · `ltc-cert-auto-issue` ทุก 2 นาที (SRS AC ≤ 5 นาที) → `call public.cert_auto_issue_tick(null, 1000, null)`

#### `cert_auto_cursor` — cursor ของ auto tick ต่อ scope **(DCR-8 · 0028+0029+0030 · codex gate r2 MAJOR-1/r3 MAJOR-1/r4 MAJOR-1/2)**

วัตถุประสงค์ (ตารางใหม่ 0028 · ขยาย 0029 · เปลี่ยนบทบาท 0030): จุดเดินคิวล่าสุดของ `cert_auto_issue_tick` แยกตามขอบเขต — `scope_key` = uuid หลักสูตร (tick แบบระบุหลักสูตร) หรือ `'*'` (tick ของ cron ทุกหลักสูตร) — commit พร้อมใบ+audit+marker เป็น TX เดียวต่อแถว ทำให้ tick รอบถัดไปเดินต่อ**ข้าม CALL** จริง (at-least-once) · **0030: ความถูกต้องวัดจาก marker ต่อแถวใน `cert_auto_walked` ผูก `sweep_epoch` — คู่ cursor (แถวสุดท้ายที่เดิน) + คู่ sweep_top (หัวของ sweep) เหลือเป็นข้อมูลชี้แจง/สังเกตการณ์ ไม่ใช่เงื่อนไขความถูกต้องอีกต่อไป** (แถว commit ช้าที่ submitted_at ตกในช่วง watermark ไม่ตกหล่น — ไม่มี marker = มองเห็นเสมอ) · สถานะขัด (0028 ค้าง: คู่เดียว null) = normalize เป็น sweep ใหม่ · sweep จบ = epoch+1 + reset ทั้งสองคู่ → รอบ retry ใหม่

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| scope_key | text | PK CHECK `<> ''` (uuid หลักสูตร หรือ '*') |
| cursor_submitted_at | timestamptz | NULL (null = sweep รอบใหม่) |
| cursor_attempt_id | uuid | NULL (tie-break เมื่อ submitted_at ซ้ำ) |
| sweep_top_submitted_at | timestamptz | NULL (0029 r3 MAJOR-1 — ขอบบนของ sweep = แถวใหม่ที่สุดที่ถูกเดินแล้วรอบนี้; แถวที่ใหม่กว่า = "ผู้มาใหม่" ของ fresh lane · null = sweep ยังไม่เริ่ม/จบแล้ว · 0030: ข้อมูลชี้แจง — ไม่ใช่เงื่อนไข picker) |
| sweep_top_attempt_id | uuid | NULL (0029 — tie-break ของขอบบน) |
| sweep_epoch | bigint | NOT NULL DEFAULT 0 (0030 r4 — รอบ sweep ปัจจุบัน · marker ของ `cert_auto_walked` ผูกค่านี้ · sweep จบ (คิวหมด/probe ยืนยัน) = +1 พร้อมลบ marker รอบเก่า = รอบ retry ใหม่ · สถานะขัดของ 0028 = normalize +1 เมื่อโหลด) |
| updated_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: PK(scope_key)
RLS: **ไม่มี policy สำหรับ JWT path ใด (fail-closed)** — ตารางภายในของ worker เท่านั้น (BFF/PostgREST ไม่แตะ — revoke รวม service_role) · policy `app_owner_select/insert/update_cert_auto_cursor` (D58 — invoker `app_owner` ของ tick; upsert on conflict ต้องมีครบสามคำสั่ง) · ผู้เขียนจริง = tick procedure ที่ cron (supabase_admin — superuser) เรียก
Retention: ถาวร (แถวเดียวต่อ scope — ไม่โต)




#### `cert_auto_walked` — marker "เดินแล้วของรอบ" ต่อแถว **(DCR-8 · 0030 · codex gate r4 MAJOR-1)**

วัตถุประสงค์ (ตารางใหม่ 0030): สถานะ "แถวนี้ถูกเดินแล้วในรอบ sweep นี้" แยกออกจาก watermark — แทนสมมติฐาน "ชุดที่เดินแล้ว = ช่วงต่อเนื่อง [cursor, sweep_top]" ที่เป็นเท็จเมื่อ submitted_at (now() ตอน*เริ่ม* TX ของ 0020) กับเวลา commit สลับลำดับกัน (READ COMMITTED): แถวที่ commit ช้าตกช่อง (cursor, sweep_top) ของ 0029 = ไม่ใช่ fresh ไม่ใช่ backlog → ล่องหนจน sweep จบ+reset (ขัด SRS AC ≤5 นาที) · picker `admin_cert_auto_unmarked_pick` หยิบเฉพาะแถวที่ยังไม่ถูก mark — แถวไม่มี marker = มองเห็นเสมอ ไม่ผูกกับช่วงเวลา · insert พร้อมใบ+audit+watermark TX เดียวต่อแถว · sweep จบ (probe ยืนยัน) = ลบทั้งรอบ + epoch+1 = แถวที่เคยล้มถูก retry รอบหน้า · ลบ cursor ของ scope = cascade ลบ marker ด้วย · **ไม่มีการ backfill จาก cursor ของ 0028/0029** — scope ที่กำลังเดินค้างตอนใช้ 0030 ครั้งแรก แถวที่เดินไปแล้ว ถูกลองซ้ำรอบเดียว (anti-join ใบ valid ทำให้ idempotent · failed ได้ retry เพิ่มหนึ่งครั้งต่อ scope — bounded)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| scope_key | text | NOT NULL FK→cert_auto_cursor(scope_key) ON DELETE CASCADE (uuid หลักสูตร หรือ '*') |
| sweep_epoch | bigint | NOT NULL (รอบ sweep ที่เดินแถวนี้ — ตรง sweep_epoch ของ cert_auto_cursor ตอนนั้น) |
| attempt_id | uuid | NOT NULL (แถว assessment_attempts ที่ถูกเดิน — สำเร็จหรือล้ม · ล้มก็ mark เพื่อไม่กินงบซ้ำในรอบเดียว) |
| created_at | timestamptz | NOT NULL DEFAULT now() |
คีย์/Index: PK(scope_key, sweep_epoch, attempt_id); FK cascade ผ่าน scope_key
RLS: **ไม่มี policy สำหรับ JWT path ใด (fail-closed)** — ตารางภายในของ worker เท่านั้น (BFF/PostgREST ไม่แตะ — revoke รวม service_role) · policy `app_owner_select/insert/delete_cert_auto_walked` (D58 — invoker `app_owner` ของ tick · ไม่ต้องมี update)
Retention: สั้นตามรอบ sweep (ลบทั้งรอบเมื่อ sweep จบ — ขนาดไม่โตเกินจำนวนแถว eligible ค้างของรอบ)
#### `feature_flags` — feature flag ของ job ระบบ **(DCR-8 · D55-7 · CRT-008)**

วัตถุประสงค์ (ตารางใหม่ 0026): source of truth ฝั่ง DB ของ flag คุม job อัตโนมัติ — แก้ได้โดย super_admin ผ่าน BFF (`service_role`) โดยไม่ต้อง redeploy; BFF อ่านอย่างเดียว (E-6) · seed flag แรก `cert_auto_issue` default **false** (ปิดจนกว่าจะสั่งเปิด)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| key | text | PK CHECK `^[a-z][a-z0-9_]{0,63}$` |
| enabled | boolean | NOT NULL DEFAULT false |
| note | text | NULL (คำอธิบาย/เหตุผลการสั่ง) |
| updated_at | timestamptz | NOT NULL DEFAULT now() |
| updated_by | uuid | NULL FK→profiles (ผู้สั่งล่าสุด) |
คีย์/Index: PK(key)
RLS: **ไม่มี policy สำหรับ JWT path ใด (fail-closed)** — อ่าน/เขียนผ่าน BFF `service_role` เท่านั้น · policy `app_owner_select_feature_flags` (D58/0026 — ยังใช้เมื่อ invoker เป็น `app_owner`; tick ของ 0027 เป็น INVOKER ที่ cron/superuser เรียก)
Retention: ถาวร

Reporting ทั้งหมดอ่านผ่าน view + สิทธิ์ staff เท่านั้น (SDS §2 M7): `v_credit_balance` (ยอด credit ต่อรอบ/ประเภท จาก SUM ledger), `v_enrollment_progress` (สรุปความคืบหน้าจาก lesson_progress), `v_assessment_statistics` (ผลสอบต่อหลักสูตร), `v_certificates_issued` — นิยามใน migration แยก; export CSV ทำที่ BFF โดย stream จาก view

### 3.8 Audit & Admin Session

#### `audit_logs` — บันทึกการกระทำสำคัญ **(append-only — ห้าม UPDATE/DELETE เด็ดขาด)**

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| occurred_at | timestamptz | NOT NULL — **กำหนดโดย `append_audit_event()` ภายใต้ advisory lock ให้ strictly increasing เสมอ**: `greatest(now(), prev.occurred_at + 1µs)` ทำให้ traversal `(occurred_at, id)` = ลำดับ append ทุกกรณี แม้ `now()` จะคงที่ตลอด TX เดียวและ `id` เป็น UUID v4 สุ่ม (D13-F3 — ห้ามพึ่ง DEFAULT now() ตรง ๆ) |
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
| prev_hash | text | NOT NULL (hash ของแถวก่อนหน้าในสาย — แถวแรกของวันใช้ค่า seed ตาม AUDIT-LOG-DESIGN §3.3 — F7/D12) |
| row_hash | text | NOT NULL UNIQUE — **sha256 บน canonical serialization ครบทุก evidentiary field** (prev_hash, id, actor_user_id, actor_roles, action, entity_type, entity_id, before, after, context, occurred_at — ลำดับฟิลด์ตามนิยาม AUDIT-LOG-DESIGN §3.3) · การไล่ตรวจสายใช้ traversal order `(occurred_at, id)` **= ลำดับ append เป๊ะ (occurred_at strictly increasing ภายใต้ lock — D13-F3)** · anchor รายวันที่ `audit_chain_anchors` (F7/D12) |
คีย์/Index: INDEX(entity_type, entity_id, occurred_at DESC); INDEX(actor_user_id, occurred_at DESC); INDEX(action, occurred_at DESC); INDEX(occurred_at, id) (traversal order ของ hash-chain — F7); ไม่มี FK แบบ enforce ต่อ actor เพื่อกันการ rewrite ประวัติ (ใช้ lookup ที่แอป)
RLS: **SELECT** `has_any_role('staff:viewer','super_admin')` (audit_log:view ทั้งหมด — sv อ่านอย่างเดียว ตาม RBAC §2) + แถว activity ของตัวเอง (ทุกบทบาท — audit_log:view activity ตัวเอง); **INSERT ไม่มี policy/grant ใด** — เขียนผ่าน `append_audit_event()` SECURITY DEFINER (owner `app_owner`) เท่านั้น (F8/D12); **UPDATE/DELETE ไม่มี path เด็ดขาด** — `REVOKE UPDATE, DELETE, INSERT ON audit_logs FROM anon, authenticated, service_role` + ไม่มี policy ใดอนุญาต (D6); ไม่มี API แก้/ลบ audit
Retention: 5 ปี (นโยบายสภาฯ + PDPA — canonical ที่ §4.6) — purge job หลัง export เป็นงาน v1.1; partition รายเดือนเมื่อโต (SDS §8)

#### `audit_chain_anchors` — anchor รายวันของ hash-chain audit_logs **(append-only — D11-6)**

วัตถุประสงค์ (ตารางเสริม D11-6): เก็บ anchor รายวันของ hash-chain ของ `audit_logs` (นิยาม chain + สูตร row_hash ที่ AUDIT-LOG-DESIGN.md §3.3) เพื่อใช้ตรวจความสมบูรณ์ของสาย audit ย้อนหลังและสืบสายต่อ — append-only เช่นเดียวกับ audit_logs

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| anchor_date | date | NOT NULL UNIQUE (anchor หนึ่งตัวต่อวัน) |
| last_id | uuid | NOT NULL (id ของแถวสุดท้ายของวันนั้นใน audit_logs) |
| last_row_hash | text | NOT NULL (sha256 ตามสูตร row_hash — AUDIT-LOG-DESIGN §3.3) |
| entry_count | int | NOT NULL CHECK > 0 (จำนวนแถวของวันนั้น — ใช้ตรวจความครบถ้วน) |
| created_at | timestamptz | NOT NULL DEFAULT now() (เวลา anchor job ปิดวัน) |
คีย์/Index: UNIQUE(anchor_date); INDEX(created_at)
RLS: **SELECT** staff:viewer/super_admin (audit_log:view ทั้งหมด — RBAC §2.4); **INSERT** service_role job เท่านั้น (anchor cron — AUDIT-LOG-DESIGN §3.3); **UPDATE/DELETE ไม่มี path เด็ดขาด** — รวมอยู่ใน REVOKE append-only เดียวกัน (§4.4)
Retention: ถาวร (ต้องครบทุกวันเพื่อตรวจสายย้อนหลัง — canonical ที่ §4.6)

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
Retention: 1 ปี (canonical ที่ §4.6)

#### `admin_sessions` — ติดตาม session ของ staff/admin

วัตถุประสงค์ (ตารางเสริมที่เพิ่มนอกรายการขั้นต่ำ): บังคับ idle timeout/absolute timeout/lockout/revoke ทันที ของบัญชี **staff/instructor/super_admin** (SDS §5.5) — JWT ของ Supabase เพียงอย่างเดียวทำ policy แบบนี้ไม่สะดวก (F10/D12)

| คอลัมน์ | ชนิด | Constraints / Default |
| ------- | ---- | --------------------- |
| user_id | uuid | NOT NULL FK→profiles (ต้องเป็นบทบาท staff*/instructor/super_admin — ตรวจที่ BFF — F10/D12) |
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
- การ purge ตาม retention เป็น job แยกที่ใช้บทบาทเฉพาะ **`purge_role`** (ชื่อเดียวกับที่ API/AUDIT อ้าง — ไม่ใช่ service_role ของแอป — F19/D12) + บันทึก audit ทุกครั้ง

### 4.4 Append-only enforcement (audit_logs + credit_ledger_entries + security_events + notice_acknowledgments)

1. `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs, credit_ledger_entries, security_events, audit_chain_anchors FROM anon, authenticated, service_role` (D11-7) + **`REVOKE UPDATE, DELETE, TRUNCATE ON notice_acknowledgments FROM anon, authenticated, service_role` (append-only — D13-F11 + D15-M3: TRUNCATE อยู่นอก RLS จึงต้อง revoke ด้วย; INSERT ยังเป็นสิทธิ์ของเจ้าของแถวตาม RLS §3.1)** + **`REVOKE INSERT ON audit_logs FROM anon, authenticated, service_role` (F8/D12)** — เขียน audit ได้เฉพาะผ่าน `append_audit_event()` SECURITY DEFINER (owner เฉพาะ `app_owner`; **EXECUTE contract เดียวทุกเอกสารตาม AUDIT-LOG-DESIGN §4: `revoke จาก PUBLIC/anon ก่อน` (PG15 ให้ PUBLIC โดย default — D15-N1) แล้ว grant `authenticated` + `service_role` — ฟังก์ชันตรวจ actor/payload/event-class ภายในเอง (mutation event = server path เท่านั้น — D15-N1(ก))**); ตารางอื่นในกลุ่มนี้ยังเหลือ path INSERT อย่างเดียว
2. RLS ไม่มี policy สำหรับ UPDATE/DELETE เลย
3. trigger guard สุดท้าย: ถ้ามีการ UPDATE/DELETE/TRUNCATE (โดน role ที่ยังมีสิทธิ์ เช่น ตอน migration) ให้ RAISE EXCEPTION — ครอบทุกตารางในกลุ่มนี้รวม notice_acknowledgments (row trigger สำหรับ UPDATE/DELETE + statement trigger สำหรับ TRUNCATE ตามแบบ audit_logs — D15-M3)
4. ไม่มี API/Server Action ใดเปิด path แก้/ลบ (ตรวจด้วย codex gate ตอน review โค้ด auth/security/data)

### 4.5 ทะเบียน PII (PDPA — ห้าม log/ห้ามเปิด API สาธารณะ)

| ตาราง.คอลัมน์ | ข้อมูล | มาตรการ |
| ------------ | ------ | ------- |
| profiles.email, phone, first_name, last_name, display_name | ข้อมูลส่วนบุคคล | RLS เจ้าของ+staff, ห้าม log, แจ้งเหตุการเข้าถึงตามนโยบาย PDPA |
| lawyer_licenses.license_no, license_applications.license_no | ข้อมูลส่วนบุคคล (วิชาชีพ) | RLS เจ้าของ+staff:exam/registrar, ห้าม log, ไม่แสดงในหน้าสาธารณะ |
| certificates.holder_name_snapshot | ชื่อตามใบประกาศ | แสดงเฉพาะบน PDF ที่เจ้าของ/registrar ดาวน์โหลด — ห้ามออกทาง public verify (D8) |
| email_outbox.to_email | ข้อมูลติดต่อ | SELECT ได้เฉพาะ service_role; purge 90 วัน |
| audit_logs.before/after | อาจมี PII ปน | audit service mask ก่อนเขียน (allowlist field) |
| profiles.display_name, title, bio (ผ่าน `course_instructors_public` — DCR-4) | ข้อมูลผู้สอนที่เปิดเผยโดยตั้งใจ | เปิดทาง view เฉพาะ 3 คอลัมน์ display นี้เท่านั้น (ห้าม email/phone/ชื่อจริง) — ผู้สอนยินยอมเปิดเผยโดยการเป็นผู้สอนของหลักสูตร published |

### 4.6 สรุป retention (canonical เดียวของโปรเจกต์ — D11-19)

> **ตารางนี้เป็น canonical เดียว** ของนโยบาย retention — เอกสารอื่น (SDS/API-SPEC/TEST-PLAN ฯลฯ) ชี้มาที่นี่เท่านั้น ห้ามประกาศค่า retention ซ้ำ (เช่นเดียวกับ D8 ของ defaults)

| กลุ่มตาราง | Retention | หมายเหตุ |
| ---------- | --------- | -------- |
| credit_ledger_entries, renewal_cycles, certificates, notification_templates | ถาวร | หลักฐานธุรกิจ/transcript — ไม่มี purge |
| audit_logs | 5 ปี | partition รายเดือนเมื่อโต · **purge job โดยบทบาทเฉพาะ `purge_role` หลัง export สำเร็จ — เป็นงาน v1.1** (v1 = export อย่างเดียว ยังไม่ purge) |
| audit_chain_anchors | ถาวร | ต้องครบทุกวันเพื่อตรวจสาย hash-chain ย้อนหลัง |
| security_events | 1 ปี | purge ด้วย `purge_role` + audit ทุกครั้ง |
| certificate_verifications, email_outbox | 90 วัน | |
| notifications, notification_recipients, report_exports | 12 เดือน (ไฟล์ export 7 วัน) | |
| event_outbox | purge 30 วันหลัง processed | |
| admin_sessions | 24 เดือน | |
| profiles, lawyer_licenses, license_applications, consents, notice_acknowledgments | อายุบัญชี + 10 ปี | **anonymize เมื่อเจ้าของข้อมูลใช้สิทธิ์ลบ** (ระบบเก็บ audit/หลักฐานธุรกิจไว้ตาม §4.5; notice_acknowledgments = หลักฐานการรับทราบต่อเวอร์ชันประกาศ — D13-F11) |
| enrollments, lesson_progress, quiz_attempts, assessment_attempts, attempt_answers (learning records) | ตามอายุบัญชี | purge ด้วย `purge_role` + audit · **แถวที่ยังถูก certificates/credit_ledger_entries อ้าง FK อยู่ = anonymize ไม่ลบแถว** (FK RESTRICT บังคับ — ตัดค่าระบุตัวตนในคอลัมน์/snapshot คงโครง ledger/certificate ไว้ — F19/D12) |
| notification_settings | ตามอายุบัญชี | |

### 4.7 Server-controlled write functions (การเขียนของผู้เรียน — F2/D12)

ตารางที่ผู้เรียนต้องเขียนได้ทั้งหมด **ไม่มี INSERT/UPDATE policy ให้บทบาทผู้เรียน** (`anon`/`citizen`/`lawyer`) — เขียนผ่าน **SECURITY DEFINER functions** เท่านั้น (owner เฉพาะ เช่น `app_owner`; ตรวจ `auth.uid()` + เงื่อนไขธุรกิจข้างใน + เขียน audit ใน TX เดียวกัน; grant EXECUTE ให้ `authenticated`):

| Function | ตารางที่เขียน | เงื่อนไขที่ตรวจข้างใน |
| -------- | ------------- | --------------------- |
| `enroll()` | enrollments (INSERT) | หลักสูตร published, สิทธิ์ตาม role/is_public, ไม่ซ้ำ (UNIQUE), prerequisite |
| `record_lesson_progress()` | lesson_progress (INSERT/UPDATE) | เป็นเจ้าของ enrollment, clamp ค่า, bounded playback intervals (SDS §3.3 — D11-15), ตัดสิน completed_at |
| `record_quiz_attempt()` | quiz_attempts (INSERT/UPDATE) | ลงทะเบียน, ตรวจ max_attempts, ตรวจคะแนนจาก quiz_options ฝั่ง server ล้วน |
| `start_attempt()` | assessment_attempts + attempt_answers (INSERT) | enrollment active, require_course_complete, max_attempts, ไม่มี attempt in_progress, ผูก session_id + lease, สุ่มข้อ + เขียน `question_snapshot` |
| `save_answer()` | attempt_answers (UPDATE), assessment_attempts (UPDATE lease) | attempt in_progress, ยังไม่ `expires_at`, lease/session ตรง, `selected_option_ids` เป็น subset ของ options ใน snapshot |
| `submit_attempt()` | assessment_attempts + attempt_answers (UPDATE), event_outbox (INSERT เมื่อผ่าน) | idempotent (`submitted_at IS NULL`), ตรวจ lease, Grader ตรวจจาก `question_snapshot` ล้วน (F14), TX เดียวกับ outbox event (F15) |

หลักการ: RLS ยังเป็นชั้นกันการอ่านตาม permission matrix (RBAC §2) แต่ **การเขียนควบคุมศูนย์กลางที่ functions** — BFF เรียก function ด้วย user JWT และ function ตรวจ `auth.uid()` เอง ทำให้เงื่อนไขธุรกิจ (max_attempts / lease / grading / accrual) ไม่สามารถถูกเขียนตรงจาก client ได้ทุกกรณี (เสริม D11-1)
