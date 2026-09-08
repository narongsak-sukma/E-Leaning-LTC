# RTM — Requirement Traceability Matrix · ระบบ LTC E-Learning

|          |                                                                           |
| -------- | ------------------------------------------------------------------------- |
| เอกสาร   | RTM (Requirement Traceability Matrix)                                     |
| เวอร์ชัน | 0.1.0                                                                      |
| วันที่    | 2026-09-08                                                                 |
| สถานะ    | Draft — รอ lead review + CTO gate (Wave A)                                  |
| เจ้าของ   | worker-2 (Task A2)                                                         |
| อ้างอิง  | SRS v0.1.0 (requirement ID ทั้งหมดมาจาก SRS) · PROJECT-BRIEF v0.1.0          |

## วิธีอ่าน (Legend)

**คอลัมน์ SDS Module** = ชื่อ module ตามโดเมนที่ SDS ของ worker-3 จะขยาย (M1–M10 + cross-cutting):
Auth · Identity & License · Catalog · Learning & Progress · Assessment · Certification · Credit Bank · Notification · Admin & Reporting · Audit · Platform & Infrastructure (X) · Security & Compliance (X)

**คอลัมน์ API** = กลุ่ม endpoint ภายใต้ `/api/v1` (สเปกเต็มอยู่ที่ API Spec ของ worker-4) · `(public)` = ไม่ต้องเข้าสู่ระบบ · `(DB)` = บังคับระดับฐานข้อมูล ไม่มี endpoint เฉพาะ

**คอลัมน์ Data** = ตารางหลักที่ requirement แตะ (ชื่อตารางร่างไว้เพื่อ trace — ชื่อสุดท้ายตาม Data Dictionary ของ worker-3)

**Test level:** U = Unit (Vitest) · I = Integration (Vitest + DB จริงใน Docker) · E = E2E (Playwright) · SEC = Security (ZAP/manual/CI scan) · PERF = Performance/load · UAT

**Deliverable (D13–D18):**
- **D13** = repo scaffold + โครงสร้างโค้ด + config framework (Wave B)
- **D14** = Docker dev environment (Supabase local stack + บริการเสริม) (Wave B)
- **D15** = CI pipeline + merge gates (lint/tsc/test/build/secrets scan + codex gate) (Wave B เป็นหลัก ใช้ต่อเนื่อง)
- **D16** = โค้ดระบบงาน: Wave C (catalog/enrollment/learning) → Wave D (assessment/cert) → Wave E (credit/admin)
- **D17** = รายงาน security hardening / VA + ผล load test (Wave F)
- **D18** = UAT + รายงานการทดสอบ/หลักฐานตรวจรับ (Wave F)

> หมายเหตุ: การ mapping เลข D13–D16 อ้างจาก PROJECT-STATE ("Wave B — deliverables 13–16 เริ่มต้น") เป็นสมมติฐานของ worker-2 — รอ lead ยืนยันตอน A6

---

## 1. เมทริกซ์หลัก — Functional Requirements (83/83)

### AUTH (11)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-001 | สมัครสมาชิกอีเมล + ยืนยันอีเมล | Auth | `/auth/register`, `/auth/verify` | auth.users, profiles | I, E | TC-AUTH-01 | D13, D16 |
| AUTH-002 | เข้าสู่ระบบ/ออกจากระบบ | Auth | `/auth/login`, `/auth/logout` | auth.users, sessions | I, E, SEC | TC-AUTH-02 | D16 |
| AUTH-003 | สมัคร/เข้าสู่ระบบด้วย OTP เบอร์มือถือ (S) | Auth | `/auth/otp/request`, `/auth/otp/verify` | auth.users, security_events | I (flag) | TC-AUTH-03 | D16 |
| AUTH-004 | ลืมรหัสผ่าน + รีเซ็ตทางอีเมล | Auth | `/auth/forgot-password`, `/auth/reset-password` | auth.users, sessions | I, E, SEC | TC-AUTH-04 | D16 |
| AUTH-005 | เปลี่ยนรหัสผ่าน (กรอกเดิม) | Auth | `/auth/change-password` | auth.users, sessions | I | TC-AUTH-05 | D16 |
| AUTH-006 | นโยบายรหัสผ่าน (config) | Auth | ใช้กับ register/reset/change | config | U, I | TC-AUTH-06 | D15, D16 |
| AUTH-007 | MFA (TOTP) บังคับ admin/staff | Auth | `/auth/mfa/enroll`, `/auth/mfa/verify`, `/auth/mfa/backups` | auth.users, security_events | I, E, SEC | TC-AUTH-07 | D16, D17 |
| AUTH-008 | session timeout + token rotation | Auth | middleware ทุก endpoint | sessions | I, SEC | TC-AUTH-08 | D16 |
| AUTH-009 | account lockout | Auth | `/auth/login` (ตรวจ) | security_events | I, SEC | TC-AUTH-09 | D16 |
| AUTH-010 | ออกจากระบบทุกอุปกรณ์ | Auth | `/auth/logout-all` | sessions | I | TC-AUTH-10 | D16 |
| AUTH-011 | rate limit ปลายทาง auth | Security & Compliance (X) | middleware + Cloudflare | — | SEC | TC-AUTH-11 | D15, D17 |

### IDENT (8)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| IDENT-001 | ดู/แก้โปรไฟล์ตนเอง | Identity & License | `/profile` (GET/PATCH) | profiles | I, E | TC-IDENT-01 | D16 |
| IDENT-002 | ยื่นผูกเลขที่ใบอนุญาต + เอกสาร | Identity & License | `/license/applications` (POST) | license_applications, storage | I, E | TC-IDENT-02 | D16 |
| IDENT-003 | เจ้าหน้าที่พิจารณาอนุมัติ/ปฏิเสธ | Identity & License | `/admin/license/applications/{id}/decision` | license_applications, audit_logs | I, E | TC-IDENT-03 | D16 |
| IDENT-004 | อนุมัติแล้วเพิ่มบทบาท lawyer | Identity & License | (workflow จาก IDENT-003) | role_assignments, audit_logs | I | TC-IDENT-04 | D16 |
| IDENT-005 | ดูสถานะ + ยื่นคำขอซ้ำ | Identity & License | `/license/status` | license_applications | E | TC-IDENT-05 | D16 |
| IDENT-006 | super_admin แต่งตั้ง/ถอดบทบาท | Identity & License | `/admin/users/{id}/roles` | role_assignments, audit_logs | I, SEC | TC-IDENT-06 | D16 |
| IDENT-007 | บัญชีเดียวหลายบทบาท (union, explicit) | Identity & License | ทุก endpoint (RBAC) | role_assignments | U, I | TC-IDENT-07 | D15, D16 |
| IDENT-008 | PDPA: export/ลบบัญชี/consent | Identity & License | `/profile/export`, `/profile/delete`, `/profile/consents` | consents, profiles, audit_logs | I, E, SEC | TC-IDENT-08 | D16, D17 |

### CAT (7)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CAT-001 | CRUD หมวดหลักสูตร | Catalog | `/admin/categories` | categories, audit_logs | I | TC-CAT-01 | D16 |
| CAT-002 | รายการหลักสูตร (guest ได้) | Catalog | `/courses` | courses, categories | E, PERF | TC-CAT-02 | D16 |
| CAT-003 | ค้นหา + กรองหลักสูตร | Catalog | `/courses?search=&category=&audience=` | courses (+index) | I, PERF | TC-CAT-03 | D16 |
| CAT-004 | หน้ารายละเอียดหลักสูตร | Catalog | `/courses/{id}` | courses, modules, lessons | E | TC-CAT-04 | D16 |
| CAT-005 | วงจรชีวิต draft→published→archived | Catalog | `/admin/courses/{id}/status` | courses, course_versions, audit_logs | I, E | TC-CAT-05 | D16 |
| CAT-006 | โครงสร้างโมดูล/บทเรียน/ลำดับ | Catalog | `/courses/{id}/structure` | modules, lessons, lesson_contents | I, E | TC-CAT-06 | D16 |
| CAT-007 | กลุ่มเป้าหมายหลักสูตร (สาธารณะ/ทนาย) | Catalog | ตรวจสิทธิ์ที่ `/enrollments` | courses | I | TC-CAT-07 | D16 |

### LRN (10)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LRN-001 | ลงทะเบียนเรียน (idempotent) | Learning & Progress | `/enrollments` (POST) | enrollments, audit_logs | I, E | TC-LRN-01 | D16 |
| LRN-002 | หลักสูตรของฉัน + % คืบหน้า | Learning & Progress | `/me/enrollments` | enrollments, lesson_progress | E | TC-LRN-02 | D16 |
| LRN-003 | เรียนวิดีโอ (signed URL + จับเวลาจริง) | Learning & Progress | `/lessons/{id}/media` (signed) | lesson_contents, watch_events | E, SEC | TC-LRN-03 | D16 |
| LRN-004 | เรียนเอกสาร PDF (viewer) | Learning & Progress | `/lessons/{id}/media` | lesson_contents | E | TC-LRN-04 | D16 |
| LRN-005 | quiz ย่อย + เฉลยทันที + ซ้ำได้ | Learning & Progress | `/lessons/{id}/quiz/attempts` | quiz_attempts, quiz_answers | I, E | TC-LRN-05 | D16 |
| LRN-006 | บันทึก progress รายบทเรียน (server ตัดสิน) | Learning & Progress | `/lessons/{id}/progress` | lesson_progress, watch_events | I | TC-LRN-06 | D16 |
| LRN-007 | ความคืบหน้ารวมหลักสูตร | Learning & Progress | `/me/enrollments/{id}/progress` | lesson_progress | U, I | TC-LRN-07 | D16 |
| LRN-008 | เงื่อนไขผ่านบทเรียน (config) | Learning & Progress | (server logic) | lesson_progress, config | U, I | TC-LRN-08 | D15, D16 |
| LRN-009 | resume ตำแหน่งล่าสุด | Learning & Progress | `/lessons/{id}/resume` | lesson_progress | E | TC-LRN-09 | D16 |
| LRN-010 | เงื่อนไขเข้าเรียนเพิ่มเติม (S) | Learning & Progress | ตรวจสิทธิ์ที่ `/enrollments` | courses, enrollments | I | TC-LRN-10 | D16 |

### ASM (14)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ASM-001 | question bank CRUD (soft delete) | Assessment | `/question-banks`, `/question-banks/{id}/questions` | question_banks, questions, question_versions, audit_logs | I | TC-ASM-01 | D16 |
| ASM-002 | จัดกลุ่ม/tag ข้อสอบ + ล็อกข้อที่ใช้แล้ว | Assessment | `/question-banks/{id}/questions` (metadata) | questions, exam_attempt_questions | U, I | TC-ASM-02 | D16 |
| ASM-003 | ชุดข้อสอบปลายหลักสูตร (config + อนุมัติ) | Assessment | `/admin/courses/{id}/exam-sets` | exam_sets, audit_logs | I | TC-ASM-03 | D16 |
| ASM-004 | สุ่มข้อ + สลับตัวเลือก | Assessment | `/exam-sets/{id}/attempts` (start) | exam_attempt_questions | U, I | TC-ASM-04 | D16 |
| ASM-005 | เวลาสอบ + submit อัตโนมัติฝั่ง server | Assessment | `/attempts/{id}` | exam_attempts | I, E | TC-ASM-05 | D16 |
| ASM-006 | จำกัดจำนวนครั้ง + cooldown | Assessment | `/exam-sets/{id}/attempts` (ตรวจ) | exam_attempts | I | TC-ASM-06 | D16 |
| ASM-007 | เกณฑ์ผ่าน (config) | Assessment | (grading engine) | exam_attempts | U | TC-ASM-07 | D15, D16 |
| ASM-008 | auto-save คำตอบ + ทน disconnect | Assessment | `/attempts/{id}/answers` | exam_answers | I (REL) | TC-ASM-08 | D16 |
| ASM-009 | ตรวจอัตโนมัติทุกประเภทปรนัย | Assessment | (grading engine) | exam_answers, questions | U, I | TC-ASM-09 | D15, D16 |
| ASM-010 | แสดง+แจ้งผลสอบ | Assessment | `/attempts/{id}/result` | exam_attempts, notifications | I, E | TC-ASM-10 | D16 |
| ASM-011 | anti-cheat พื้นฐาน + block session ซ้ำ (S) | Assessment + Security (X) | `/attempts/{id}/events` | exam_attempt_events | I, SEC | TC-ASM-11 | D16, D17 |
| ASM-012 | ทบทวนข้อสอบหลังสอบ (S) | Assessment | `/attempts/{id}/review` | exam_attempt_questions, exam_answers | E | TC-ASM-12 | D16 |
| ASM-013 | เงื่อนไขเข้าสอบ | Assessment | `/exam-sets/{id}/attempts` (ตรวจ) | lesson_progress, enrollments | I | TC-ASM-13 | D16 |
| ASM-014 | ประวัติการสอบ + สถิติข้อสอบ | Assessment | `/me/attempts`, `/admin/exams/statistics` | exam_attempts | E | TC-ASM-14 | D16 |

### CRT (8)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CRT-001 | ตรวจคุณสมบัติรับใบรับรองอัตโนมัติ | Certification | (eligibility engine) | exam_attempts, enrollments, license_applications | U, I | TC-CRT-01 | D16 |
| CRT-002 | registrar ออกใบรับรอง (ราย/ชุด) | Certification | `/admin/certificates` (POST, bulk) | certificates, audit_logs | I, E | TC-CRT-02 | D16 |
| CRT-003 | รหัส unique + QR | Certification | (generator) | certificates | U, I | TC-CRT-03 | D16 |
| CRT-004 | หน้า verify สาธารณะ (ไม่ leak PII) | Certification | `/verify/{code}` (public) | certificates | E, SEC, PERF | TC-CRT-04 | D16, D17 |
| CRT-005 | ดาวน์โหลด PDF | Certification | `/certificates/{id}/pdf` | certificates | E | TC-CRT-05 | D16 |
| CRT-006 | เพิกถอน + ปรับ credit | Certification | `/admin/certificates/{id}/revoke` | certificates, certificate_events, credit_ledger | I, E | TC-CRT-06 | D16 |
| CRT-007 | ออกใหม่แทนใบเดิม (S) | Certification | `/admin/certificates/{id}/reissue` | certificates, certificate_events | I | TC-CRT-07 | D16 |
| CRT-008 | โหมดออกอัตโนมัติ (S, default ปิด) | Certification | (job/config) | certificates, audit_logs | I | TC-CRT-08 | D16 |

### CRB (8)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CRB-001 | กฎ credit เป็น config (CRUD) | Credit Bank | `/admin/credit-rules` | credit_rules, audit_logs | I | TC-CRB-01 | D16 |
| CRB-002 | credit ledger append-only (DB บังคับ) | Credit Bank | (DB) | credit_ledger | I, SEC | TC-CRB-02 | D15, D17 |
| CRB-003 | คำนวณ credit อัตโนมัติเมื่อผ่าน | Credit Bank | (event handler) | credit_ledger, certificates | U, I | TC-CRB-03 | D15, D16 |
| CRB-004 | รอบต่ออายุรายบุคคล (รอ Q1) | Credit Bank | (cycle engine) | renewal_cycles, license_applications | U, I | TC-CRB-04 | D16 |
| CRB-005 | ยอดสะสม/ขาด ต่อรอบ | Credit Bank | `/me/credits` | credit_ledger, renewal_cycles | U, I | TC-CRB-05 | D16 |
| CRB-006 | transcript (ออนไลน์ + PDF/CSV) | Credit Bank | `/me/transcript`, `/me/transcript.pdf` | credit_ledger, certificates, courses | E | TC-CRB-06 | D16 |
| CRB-007 | เจ้าหน้าที่ปรับ credit (adjustment) | Credit Bank | `/admin/credits/adjustments` | credit_ledger, audit_logs | I, E | TC-CRB-07 | D16 |
| CRB-008 | กฎอายุ/ข้ามรอบ (S, รอ Q1) | Credit Bank | (cycle engine) | credit_ledger, renewal_cycles | U | TC-CRB-08 | D16 |

### NTF (6)

| Req ID | คำอธิบาดย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| NTF-001 | แจ้งเตือนในระบบ (inbox + badge) | Notification | `/notifications` | notifications | E | TC-NTF-01 | D16 |
| NTF-002 | อีเมลผลสอบ (เทมเพลตไทย) | Notification | (event) | notification_templates, email_outbox | I, E | TC-NTF-02 | D16 |
| NTF-003 | อีเมลออก/เพิกถอนใบรับรอง | Notification | (event) | email_outbox | I | TC-NTF-03 | D16 |
| NTF-004 | แจ้งใกล้หมดรอบต่ออายุ (S, รอ Q1) | Notification | (scheduled job) | renewal_cycles, email_outbox | I | TC-NTF-04 | D16 |
| NTF-005 | ตั้งค่ารับแจ้งเตือนรายประเภท (C) | Notification | `/me/notification-settings` | notification_settings | E | TC-NTF-05 | D16 |
| NTF-006 | คิวอีเมล + retry | Notification | (worker) | email_outbox | I (REL) | TC-NTF-06 | D16 |

### ADM (6)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADM-001 | dashboard KPI + กรองวันที่ | Admin & Reporting | `/admin/dashboard` | (aggregate) | E, PERF | TC-ADM-01 | D16 |
| ADM-002 | ค้นหา/ปิด-เปิดบัญชี/บทบาท | Admin & Reporting | `/admin/users` | profiles, role_assignments, audit_logs | I, E, SEC | TC-ADM-02 | D16 |
| ADM-003 | รายงานเรียน/สอบ/credit | Admin & Reporting | `/admin/reports/*` | (aggregate) | E, PERF | TC-ADM-03 | D16 |
| ADM-004 | export CSV (UTF-8 BOM) | Admin & Reporting | `/admin/reports/{id}/export` | report_exports, audit_logs | I, PERF | TC-ADM-04 | D16 |
| ADM-005 | จัดการ/อนุมัติหลักสูตร | Admin & Reporting | `/admin/courses` | courses, course_versions, audit_logs | I, E | TC-ADM-05 | D16 |
| ADM-006 | ติดตามการสอบ (aggregate) (S) | Admin & Reporting | `/admin/exams/monitoring` | exam_attempts (aggregate) | E | TC-ADM-06 | D16 |

### AUD (5)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUD-001 | บันทึก audit ทุก action สำคัญ | Audit | (cross-cutting) | audit_logs | I | TC-AUD-01 | D15, D16 |
| AUD-002 | append-only บังคับ DB (ห้าม UPDATE/DELETE) | Audit | (DB) | audit_logs | I, SEC | TC-AUD-02 | D15, D17 |
| AUD-003 | ค้นหา/กรอง audit (self-auditing) | Audit | `/admin/audit` | audit_logs | I, PERF | TC-AUD-03 | D16 |
| AUD-004 | ไม่บรรจุ PII (CI scan) | Audit | (serializer) | audit_logs | U, SEC | TC-AUD-04 | D15, D17 |
| AUD-005 | retention ตามนโยบาย (config) | Audit | (retention job) | audit_logs | I | TC-AUD-05 | D16 |

---

## 2. เมทริกซ์ NFR สำคัญ — PERF (8/8) + SEC (16/16)

| Req ID | คำอธิบายย่อ | SDS Module | API group | Data table(s) | Test | TC ID | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PERF-001 | รองรับผู้ใช้ 100,000 ราย | Platform & Infra (X) | ทั้งระบบ | ทุกตารางหลัก | PERF | TC-PERF-01 | D17, D18 |
| PERF-002 | เรียนพร้อมกัน 10,000 sessions | Platform & Infra (X) | `/lessons/*`, progress | lesson_progress, watch_events | PERF | TC-PERF-02 | D17, D18 |
| PERF-003 | สอบพร้อมกัน 5,000 คน | Platform & Infra (X) | `/attempts/*` | exam_attempts, exam_answers | PERF | TC-PERF-03 | D17, D18 |
| PERF-004 | API p95 ≤ 500ms read / ≤ 1s write | Platform & Infra (X) | ทุก `/api/v1` | — | PERF + OPE monitor | TC-PERF-04 | D17, D18 |
| PERF-005 | LCP ≤ 2.5s / INP ≤ 200ms | Platform & Infra (X) | หน้าหลัก 5 หน้า | — | PERF (RUM + CI lighthouse) | TC-PERF-05 | D17, D18 |
| PERF-006 | วิดีโอเริ่ม ≤ 3 วินาที p75 (S) | Platform & Infra (X) | streaming/CDN | — | PERF | TC-PERF-06 | D17, D18 |
| PERF-007 | ค้นหาหลักสูตร p95 ≤ 2s | Catalog | `/courses?search` | courses (+index) | PERF | TC-PERF-07 | D17, D18 |
| PERF-008 | export 10,000 แถว ≤ 60 วินาที (S) | Admin & Reporting | `/admin/reports/{id}/export` | report_exports | PERF | TC-PERF-08 | D17, D18 |
| SEC-001 | OWASP ASVS L2 + Top 10 | Security & Compliance (X) | ทั้งระบบ | — | SEC (ZAP + manual) | TC-SEC-01 | D17, D18 |
| SEC-002 | RLS ทุกตาราง | Security & Compliance (X) | (DB) | ทุกตาราง | I, SEC | TC-SEC-02 | D15, D17 |
| SEC-003 | least-privilege DB roles | Security & Compliance (X) | (DB/BFF) | — | SEC review | TC-SEC-03 | D15, D17 |
| SEC-004 | audit append-only (มุม security) | Security & Compliance (X) | (DB) | audit_logs | I, SEC | TC-SEC-04 | D15, D17 |
| SEC-005 | rate limit + WAF ทุก environment | Security & Compliance (X) | middleware + Cloudflare | — | SEC | TC-SEC-05 | D15, D17 |
| SEC-006 | secrets เฉพาะ env (ห้าม commit/log) | Security & Compliance (X) | (CI pipeline) | — | SEC (CI scan) | TC-SEC-06 | D15, D17 |
| SEC-007 | ห้าม log PII | Security & Compliance (X) | (logger) | — | SEC (CI scan) | TC-SEC-07 | D15, D17 |
| SEC-008 | admin MFA + timeout + lockout | Security & Compliance (X) | auth | security_events | I, SEC | TC-SEC-08 | D16, D17 |
| SEC-009 | verify ไม่เปิด PII เกินจำเป็น | Certification | `/verify/{code}` (public) | certificates | SEC | TC-SEC-09 | D16, D17 |
| SEC-010 | PDPA minimal + consent | Security & Compliance (X) | ทั้งระบบ | profiles, consents | SEC review + UAT | TC-SEC-10 | D17, D18 |
| SEC-011 | PDPA สิทธิเจ้าของข้อมูล | Identity & License | `/profile/*` | consents, audit_logs | I, E | TC-SEC-11 | D16, D18 |
| SEC-012 | data retention policy | Security & Compliance (X) | (job) | หลายตาราง | SEC review | TC-SEC-12 | D17, D18 |
| SEC-013 | บันทึกการเข้าถึง PII | Audit | staff view endpoints | audit_logs | I | TC-SEC-13 | D16 |
| SEC-014 | zod ทุกขอบเขตรับข้อมูล | Security & Compliance (X) | ทุก endpoint | — | I (negative/fuzz) | TC-SEC-14 | D15, D16 |
| SEC-015 | HTTPS + security headers | Security & Compliance (X) | edge / Next.js | — | SEC | TC-SEC-15 | D17 |
| SEC-016 | at-rest/in-transit + signed URL + region | Security & Compliance (X) | storage | เอกสาร/วิดีโอ, config | SEC | TC-SEC-16 | D16, D17 |

---

## 3. NFR กลุ่มอื่น (REL/USA/I18N/ACC/MAINT/OPE) — trace แบบย่อ

| Req ID | คำอธิบายย่อ | วิธีพิสูจน์ (Test) | TC ID | D |
| --- | --- | --- | --- | --- |
| REL-001 | availability ≥ 99.9%/เดือน | PERF/OPE monitoring + รายงานรายเดือน | TC-REL-01 | D17, D18 |
| REL-002 | backup RPO ≤ 24 ชม. / RTO ≤ 4 ชม. | operation drill + หลักฐาน restore | TC-REL-02 | D17, D18 |
| REL-003 | บริการเสริมล่มไม่กระทบธุรกรรมหลัก (S) | I (fault injection อีเมล) | TC-REL-03 | D16 |
| REL-004 | การสอบทน disconnect | I (ทดสอบร่วมกันกับ ASM-008) | TC-REL-04 | D16 |
| USA-001 | ภาษาไทยหลักทุกหน้าจอ | E + รีวิวหน้าจอ | TC-USA-01 | D16, D18 |
| USA-002 | responsive 360–1920 px | E (Playwright viewports) | TC-USA-02 | D16, D18 |
| USA-003 | ภารกิจหลัก ≤ 5 คลิก (S) | UAT journey test | TC-USA-03 | D18 |
| USA-004 | error ไทย + วิธีแก้ | E + รีวิว message catalog | TC-USA-04 | D16 |
| USA-005 | สมัครเสร็จ ≤ 3 นาที median (S) | UAT (ผู้ทดสอบ ≥ 5 คน) | TC-USA-05 | D18 |
| I18N-001 | string ทั้งหมดผ่าน message catalog | U (lint rule) | TC-I18N-01 | D13, D15 |
| I18N-002 | สลับไทย/อังกฤษ (S — ขอบเขต v1) | E | TC-I18N-02 | D16 |
| I18N-003 | ฟอร์แมตวันที่/เลขตาม locale (พ.ศ. default) | U + E | TC-I18N-03 | D16 |
| I18N-004 | layout ไม่พังเมื่อสลับภาษา (S) | E (string ยาวสุด) | TC-I18N-04 | D16 |
| ACC-001 | WCAG 2.1 AA เนื้อหา+เส้นทางหลัก | E (axe) + manual checklist | TC-ACC-01 | D17, D18 |
| ACC-002 | ใช้คีย์บอร์ดล้วนได้ครบ | E + manual | TC-ACC-02 | D18 |
| ACC-003 | contrast ≥ 4.5:1 | เครื่องมือตรวจสี design system | TC-ACC-03 | D17 |
| ACC-004 | alt/ transcript ไทยของสื่อ (S) | E + content checklist | TC-ACC-04 | D16, D18 |
| MAINT-001 | TS strict + ห้าม `any` ไม่จำเป็น | CI gate (tsc + lint) | TC-MAINT-01 | D13, D15 |
| MAINT-002 | โค้ดเดียว dev/prod ต่างกันแค่ config | review + smoke test parity (D14) | TC-MAINT-02 | D13, D14 |
| MAINT-003 | schema เปลี่ยนผ่าน SQL migration เท่านั้น | CI (migrations รันบน Docker) | TC-MAINT-03 | D14, D15 |
| MAINT-004 | unit test business logic ≥ 80% | CI coverage report | TC-MAINT-04 | D15 |
| MAINT-005 | สแกนช่องโหว่ dependency (S) | CI dependency scan | TC-MAINT-05 | D15 |
| MAINT-006 | merge gates + codex gate กลุ่ม auth/security/data | CI policy + audit ของ merge | TC-MAINT-06 | D15 |
| OPE-001 | structured log + correlation ID | PERF/OPE + ตรวจ log ตัวอย่าง | TC-OPE-01 | D16, D17 |
| OPE-002 | `/api/health` ตรวจ dependency | I + PERF | TC-OPE-02 | D16 |
| OPE-003 | alerting เกินเกณฑ์ | operation test + หลักฐานแจ้งเตือน | TC-OPE-03 | D17 |
| OPE-004 | runbook deploy/rollback (S) | drill + เอกสาร | TC-OPE-04 | D17, D18 |

---

## 4. สรุปสถิติ Coverage

| กลุ่ม | จำนวน requirement | มี trace ใน RTM | Coverage |
| --- | --- | --- | --- |
| FR ทั้งหมด (AUTH–AUD) | 83 | 83 (ตาราง §1) | 100% |
| NFR PERF | 8 | 8 (ตาราง §2) | 100% |
| NFR SEC | 16 | 16 (ตาราง §2) | 100% |
| NFR REL/USA/I18N/ACC/MAINT/OPE | 27 | 27 (ตาราง §3) | 100% |
| **รวม** | **134** | **134** | **100%** |

ข้อสังเกต:
- ทุก FR ชี้ SDS module + กลุ่ม API + ตารางข้อมูล + TC ID + deliverable ครบ 5 มิติ
- ทุกแถว PERF/SEC (NFR สำคัญตาม Brief §7–8) อยู่ในตาราง §2 — ไม่มีข้อใดตก
- จุดเสี่ยง trace: ชื่อตารางข้อมูลเป็นร่าง (ชื่อสุดท้ายตาม Data Dictionary worker-3) และ endpoint path เป็นร่าง (สุดท้ายตาม API Spec worker-4) — ต้องกระทบยอดตอน A6 (cross-doc consistency)

*จบ RTM v0.1.0 — การเปลี่ยนแปลงต้องผ่าน DCR ตามกฎโครงการ Brief §9*
