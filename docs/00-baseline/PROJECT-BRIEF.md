# PROJECT BRIEF — ระบบ E-Learning สภาทนายความแห่งประเทศไทย (LTC E-Learning)

|          |                                                   |
| ------- | ------------------------------------------------- |
| เวอร์ชัน | 0.2.0 — CTO Baseline (ตัดสินแล้ว แก้ไขต้องผ่าน DCR) |
| วันที่    | 2026-09-08 (0.2.0: +staging env ตาม DCR-1)        |
| สถานะ    | **SOURCE OF TRUTH** — เอกสารทุกฉบับต้องสอดคล้องกับเอกสารนี้ |

## 1. ภารกิจ (Mission)

พัฒนาระบบ E-Learning ระดับมาตรฐานสากล (อ้างแบบอย่าง Coursera และระบบเรียนออนไลน์ของมหาวิทยาลัย) ให้สภาทนายความแห่งประเทศไทย เพื่อ:

1. **อบรมประชาชนทั่วไป** — หลักสูตรเพิ่มความรู้ด้านกฎหมายสำหรับสาธารณะ
2. **เพิ่มพูนความรู้ทนายความ** — หลักสูตรต่อเนื่องสำหรับทนายความ (continuing legal education)
3. **สอบออนไลน์รับประกาศนียบัตร** — การสอบท้ายหลักสูตรเพื่อรับประกาศนียบัตร ใช้ประกอบการ**ต่อใบอนุญาตว่าความ**
4. **Credit Bank** — ระบบสะสม/ติดตามคุณวุฒิแบบ credit bank ตามรอบต่ออายุใบอนุญาต (คล้าย transcript ของมหาวิทยาลัย)
5. **บริหารจัดการโดยเจ้าหน้าที่** — จัดการหลักสูตร ข้อสอบ ผู้ใช้ ประกาศนียบัตร และรายงาน
6. **UX ระดับสากล** — สวย ง่าย คล่องตัว ทันสมัย เหมาะกับบริบทไทย

## 2. ขอบเขต v1

**อยู่ในขอบเขต:** หลักสูตร self-paced (วิดีโอ + เอกสาร + แบบทดสอบย่อย), การสอบปลายหลักสูตรออนไลน์, ออกประกาศนียบัตร + ยืนยันความถูกต้อง (verify), credit bank, ระบบสมาชิก/บัญชี, admin back-office, รายงาน/สถิติ, audit log, การแจ้งเตือนพื้นฐาน

**นอกขอบเขต v1 (จดใน Risk/Open Questions):** ชำระเงินออนไลน์, คลาสสด (live), นำเข้า SCORM เต็มรูปแบบ, mobile native app (ทำ responsive web ก่อน), AI assistant

## 3. Personas

| Persona            | ลักษณะ                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| ประชาชน (Citizen)  | ไม่มีบัญชีเดิม สมัครด้วย email/มือถือ เรียนฟรี/ลงทะเบียนหลักสูตรสาธารณะ |
| ทนายความ (Lawyer)  | มีเลขที่ใบอนุญาตว่าความ เรียน+สอบ สะสม credit เพื่อต่ออายุใบอนุญาต      |
| วิทยากร (Instructor) | สร้าง/แก้เนื้อหาหลักสูตร ธนาคารข้อสอบ (ภายใต้การอนุมัติของเจ้าหน้าที่)   |
| เจ้าหน้าที่ (Staff) | หลายระดับ: ดูแลเนื้อหา / ดูแลการสอบ / นายทะเบียน (ออกประกาศนียบัตร) / ผู้ดูแลสูงสุด |

## 4. บทบาทระบบ (RBAC seed — ละเอียดที่ RBAC-DESIGN.md)

`guest` → `citizen` → `lawyer` → `instructor` → `staff:viewer|content|exam|registrar` → `super_admin`

- บทบาทไม่สืบทอดเชิงลำดับชั้นอัตโนมัติ (lawyer ≠ สิทธิ์ citizen โดย implication — กำหนด explicit)
- บัญชีเดียวมีได้หลายบทบาท (เช่น ทนายความที่เป็นวิทยากร)
- `super_admin` + `staff*` ต้องเปิด MFA

## 5. โดเมนหลัก (Bounded Contexts — SRS/API/Data Dictionary แยกตามนี้)

1. **Identity & License** — profile, การผูกเลขที่ใบอนุญาต, การยืนยันตัวตนโดยเจ้าหน้าที่
2. **Catalog & Enrollment** — หมวด/หลักสูตร, การลงทะเบียน, เงื่อนไขการเข้าเรียน
3. **Learning & Progress** — โมดูล/บทเรียน (วิดีโอ, เอกสาร, แบบทดสอบย่อย), ติดตามความคืบหน้า
4. **Assessment & Certification** — question bank, ชุดข้อสอบ, กติกาสอบ (เวลา, สุ่ม, จำนวนครั้ง, เกณฑ์ผ่าน), ตรวจ, ออกประกาศนียบัตร + QR verify
5. **Credit Bank** — กฎการได้ credit, credit ledger (append-only), รอบต่ออายุ, สรุปยอด credit
6. **Notification** — แจ้งเตือนในระบบ + email (เทมเพลตภาษาไทย)
7. **Admin & Reporting** — dashboard, รายงานการเรียน/ผลสอบ/credit, export
8. **Audit** — บันทึกการกระทำสำคัญทั้งหมด (append-only, ห้ามแก้/ลบ)

## 6. สถาปัตยกรรม + Stack (CTO ตัดสินแล้ว — binding)

| Layer          | เทคโนโลยี                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| Web app        | Next.js 15 (App Router, RSC) + **TypeScript strict** + Tailwind CSS                 |
| API            | Next.js Route Handlers `/api/v1/*` + Server Actions, ตรวจ input ด้วย **zod** ทุกจุด |
| Database/Auth  | **Supabase** — PostgreSQL 15 + Auth + Storage; **RLS เปิดทุกตาราง** เป็นชั้นความปลอดภัยร่วมกับ RBAC |
| Migration      | SQL migrations (supabase/migrations) — ใช้ SQL เป็นหลัก เพื่อ parity กับ prod       |
| Media/วิดีโอ    | ผ่าน storage abstraction: dev = Supabase local storage (Docker) → prod = **Cloudflare R2/Stream** |
| Dev environment| **100% local Docker** (Supabase local stack + บริการเสริมใน docker-compose ถ้าจำเป็น) |
| Staging        | **Cloud preview ก่อนขึ้น prod** — Vercel preview/staging deployment + Supabase staging branch + Cloudflare (โดเมน staging) ใช้ config ชุดเดียวกับ prod แยกด้วย env vars เท่านั้น — ใช้พิสูจน์ performance (k6 10k/5k) + security test ก่อน promote (เพิ่มเมื่อ 0.2.0 ตาม DCR-1) |
| Production     | **100% cloud services** — Vercel (app) + Supabase Cloud (data/auth/storage) + Cloudflare (DNS, WAF, CDN, rate limit, R2/Stream) |
| i18n           | **Thai-first**, รองรับอังกฤษ (โครงสร้างพร้อม next-intl-style)                        |
| Testing        | Vitest (unit) + Playwright (E2E) + OWASP ZAP/manual security pass                   |
| CI             | GitHub Actions — lint + tsc + test + build + secrets scan เป็น merge gate            |

**หลักการสำคัญ:** โค้ดชุดเดียว รันได้ทั้ง local docker และ prod cloud โดยต่างกันแค่ config/environment variables — ห้าม hardcode ค่าที่ environment-specific

## 7. เป้าหมายคุณภาพ (targets — NFR จะขยายใน SRS)

| ด้าน            | เป้า                                                      |
| --------------- | ---------------------------------------------------------- |
| ผู้ใช้          | รองรับผู้ใช้จดทะเบียน ≥ 100,000 ราย                        |
| Concurrency     | เรียนพร้อมกัน ≥ 10,000 sessions / สอบพร้อมกัน ≥ 5,000 คน |
| Availability    | ≥ 99.9% (วิดีโอ/เนื้อหาผ่าน CDN)                            |
| ความปลอดภัย     | OWASP ASVS L2, PDPA compliant, audit ครบทุก action สำคัญ   |
| Accessibility   | WCAG 2.1 AA (อย่างน้อยเนื้อหาสาธารณะ)                      |

## 8. Security & Compliance Baseline (binding)

- **PDPA** (พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล): เก็บข้อมูลน้อยที่สุดเท่าที่จำเป็น, consent, สิทธิเข้าถึง/แก้ไข/ลบ, data retention policy, บันทึกการเข้าถึงข้อมูลส่วนบุคคล
- **OWASP Top 10 + ASVS L2** เป็นเกณฑ์ออกแบบ/ทดสอบ
- RLS ทุกตาราง + least-privilege DB roles (anon / authenticated / service_role ใช้เฉพาะ server-side)
- Audit log **append-only** ห้าม UPDATE/DELETE (บังคับด้วย DB privileges + RLS)
- Rate limiting + WAF rules (Cloudflare prod / middleware dev)
- Secrets เฉพาะ environment variables — **ห้าม commit ห้าม log ทุก environment**
- ห้าม log PII (เลขบัตรประชาชน, เลขที่ใบอนุญาต, email) — ใช้ user_id อ้างอิงแทน
- Admin ทุกระดับ: MFA + session timeout + lockout policy
- Certificate ต้อง verify ได้สาธารณะโดยไม่เปิดเผย PII เกินจำเป็น

## 9. กฎโครงการ (binding rules)

1. **Doc-first** — เอกสารคือ source of truth; โค้ดพบปัญหาเอกสาร → ยื่น DCR (doc §, ปัญหา, ข้อเสนอ) → CTO ตัดสิน → แก้เอกสารก่อน (bump version) แล้วจึงแก้โค้ด
2. TypeScript strict, ห้าม `any` โดยไม่จำเป็น, validate ขอบเขตด้วย zod
3. UI string ภาษาไทยก่อน (i18n-ready), error message เป็นภาษาที่ผู้ใช้เข้าใจ
4. Conventional Commits + อ้าง task ID
5. Merge gates: lint + tsc + tests + build + secrets scan; โค้ด auth/security/data เพิ่ม codex gate (PASS ก่อน merge เท่านั้น)
6. No fake completion — completion ทุกครั้งต้องมี evidence (exit code, test count, ไฟล์+บรรทัด)
7. ทำงานเป็น wave เล็ก ๆ, commit บ่อย, รายงานเพื่อ verify

## 10. คำถามค้าง (Open Questions — model เป็น config อย่า hardcode)

| # | คำถาม                                                          | ผลกระทบ                      |
| - | -------------------------------------------------------------- | ---------------------------- |
| Q1 | รอบต่ออายุใบอนุญาตกี่ปี + ต้องมี credit กี่หน่วยต่อรอบ        | credit_rules (config-driven) |
| Q2 | เกณฑ์ผ่านการสอบ / จำนวนครั้งที่สอบได้ต่อหลักสูตร                 | assessment config ต่อหลักสูตร |
| Q3 | การยืนยันตัวตนทนายความ (เลขที่ใบอนุญาต / เอกสาร / SSO ระบบสมาชิกสภาฯ) | identity & license workflow  |
| Q4 | proctoring ระดับที่ยอมรับได้ (บันทึกหน้าจอ? lock browser?)        | exam engine design           |
| Q5 | Data residency — PDPA cross-border (Supabase region ใกล้ไทยคือ SG/JP) | deployment arch            |
| Q6 | วิดีโอ: จำกัดความยาว/ความละเอียด? ป้องกันดาวน์โหลด?              | media pipeline               |
| Q7 | Staging: ยอมรับค่าใช้จ่าย cloud tier สำหรับ load test 10k/5k หรือไม่ (Vercel/Supabase/Cloudflare plan) | staging env + performance gate |

> ค่าเริ่มต้น (default) ต้องกำหนดทุก config พร้อมเหตุผล และระบุ "รอยืนยัน Q#"
