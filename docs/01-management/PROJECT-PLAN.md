# PROJECT PLAN — ระบบ LTC E-Learning

**เวอร์ชัน 0.1.0-draft · 2026-09-08 · LTC E-Learning**

|          |                                                  |
| -------- | ------------------------------------------------ |
| เจ้าของเอกสาร | worker-1 (Wave A)                            |
| อ้างอิง   | `00-baseline/PROJECT-BRIEF.md` (source of truth), `01-management/RISK-REGISTER.md`, `06-testing/TEST-PLAN.md` |
| สถานะ    | draft — รอ CTO gate (Milestone M1)               |

## สารบัญ

1. [บทนำและวัตถุประสงค์](#1-บทนำและวัตถุประสงค์)
2. [ขอบเขตโครงการ](#2-ขอบเขตโครงการ)
3. [Stakeholders และ RACI](#3-stakeholders-และ-raci)
4. [วิธีทำงาน: Doc-first, DCR, Wave Model](#4-วิธีทำงาน-doc-first-dcr-wave-model)
5. [แผนเวลาและ Milestones (Wave A–F)](#5-แผนเวลาและ-milestones-wave-af)
6. [โครงสร้างทีมและบทบาท](#6-โครงสร้างทีมและบทบาท)
7. [การทยอยส่งมอบ (21 Deliverables)](#7-การทยอยส่งมอบ-21-deliverables)
8. [การบริหารความเสี่ยง](#8-การบริหารความเสี่ยง)
9. [KPI และ Definition of Done](#9-kpi-และ-definition-of-done)
10. [เครื่องมือและ Infrastructure](#10-เครื่องมือและ-infrastructure)
11. [สมมติฐาน ข้อจำกัด และคำถามค้าง](#11-สมมติฐาน-ข้อจำกัด-และคำถามค้าง)

---

## 1. บทนำและวัตถุประสงค์

โครงการนี้พัฒนาระบบ E-Learning ระดับมาตรฐานสากล (อ้างแบบอย่าง Coursera และระบบเรียนออนไลน์ของมหาวิทยาลัย) ให้สภาทนายความแห่งประเทศไทย (LTC) ตามภารกิจ 6 ข้อใน PROJECT-BRIEF §1: อบรมประชาชนทั่วไป เพิ่มพูนความรู้ทนายความต่อเนื่อง (continuing legal education) สอบออนไลน์รับประกาศนียบัตรเพื่อต่อใบอนุญาตว่าความ ระบบ Credit Bank ตามรอบต่ออายุ บริหารจัดการโดยเจ้าหน้าที่ และ UX ระดับสากลเหมาะกับบริบทไทย

**วัตถุประสงค์เชิงธุรกิจ (Business Objectives):**

1. เปิดบริการหลักสูตรกฎหมายสำหรับประชาชนและทนายความบนแพลตฟอร์มเดียว รองรับผู้ใช้จดทะเบียน ≥ 100,000 ราย
2. ทนายความสอบท้ายหลักสูตรและรับประกาศนียบัตรที่ยืนยันความถูกต้องได้สาธารณะ (QR verify) เพื่อใช้ต่อใบอนุญาตว่าความ
3. Credit Bank สะสม/ติดตาม credit ตามรอบต่ออายุได้ถูกต้อง ตรวจสอบย้อนหลังได้ (append-only ledger)
4. เจ้าหน้าที่บริหารหลักสูตร ข้อสอบ ผู้ใช้ ประกาศนียบัตร และรายงานได้ครบในระบบเดียว
5. ความมั่นคงปลอดภัยและความเป็นส่วนตัวระดับ OWASP ASVS L2 + PDPA compliant ตั้งแต่วันส่งมอบ

**วัตถุประสงค์เชิงโครงการ (Project Objectives):**

1. ส่งมอบระบบตามขอบเขต v1 ทั้ง 21 deliverables ผ่าน Milestone M1–M5
2. คุมคุณภาพด้วย merge gates (lint + tsc + tests + build + secrets scan) และ codex gate สำหรับโค้ด auth/security/data
3. ทุกการส่งมอบมี evidence ตามหลัก no fake completion (brief §9.6)

## 2. ขอบเขตโครงการ

**อยู่ในขอบเขต v1** (ตาม brief §2): หลักสูตร self-paced (วิดีโอ + เอกสาร + แบบทดสอบย่อย), การสอบปลายหลักสูตรออนไลน์, ออกประกาศนียบัตร + ยืนยันความถูกต้อง (verify), Credit Bank, ระบบสมาชิก/บัญชี, admin back-office, รายงาน/สถิติ, audit log, การแจ้งเตือนพื้นฐาน — ครอบคลุม 8 โดเมน (brief §5): Identity & License, Catalog & Enrollment, Learning & Progress, Assessment & Certification, Credit Bank, Notification, Admin & Reporting, Audit

**นอกขอบเขต v1:** ชำระเงินออนไลน์, คลาสสด (live), นำเข้า SCORM เต็มรูปแบบ, mobile native app (ทำ responsive web ก่อน), AI assistant — บันทึกเป็นความเสี่ยง/คำถามค้าง (R-18, §11)

**เกณฑ์คุณภาพที่โครงการต้องส่งมอบ** (brief §7): ผู้ใช้ ≥ 100,000 ราย, เรียนพร้อมกัน ≥ 10,000 sessions / สอบพร้อมกัน ≥ 5,000 คน, availability ≥ 99.9%, OWASP ASVS L2 + PDPA, WCAG 2.1 AA (เนื้อหาสาธารณะอย่างน้อย)

## 3. Stakeholders และ RACI

| Stakeholder                          | ความสนใจ/บทบาทหลัก                                      |
| ------------------------------------ | -------------------------------------------------------- |
| ผู้ว่าจ้าง (LTC executive)           | งบประมาณ นโยบาย รับมอบระบบ                                |
| เจ้าหน้าที่สภาฯ (registrar/content/exam) | ผู้ใช้ admin back-office, ผู้ทดสอบ UAT              |
| วิทยากร                              | ผู้ให้เนื้อหา/ธนาคารข้อสอบ (ภายใต้การอนุมัติเจ้าหน้าที่) |
| ทนายความ                             | ผู้ใช้หลัก เรียน+สอบ+สะสม credit ต่อใบอนุญาต             |
| ประชาชน                              | ผู้เรียนหลักสูตรสาธารณะ                                  |
| CTO (codex CLI gate)                 | ตัดสินใจสถาปัตยกรรม, DCR verdict, milestone gates        |
| Lead/PM (session model)              | แผน มอบหมาย คุม wave board, git แต่ผู้เดียว               |
| workers 1–5                          | ผลิตเอกสาร (Wave A) และโค้ด (Wave B+) ตาม ownership      |

**RACI Matrix** (R = Responsible, A = Accountable, C = Consulted, I = Informed):

| กิจกรรม                          | ผู้ว่าจ้าง | CTO | Lead | workers | เจ้าหน้าที่/วิทยากร |
| -------------------------------- | ---------- | --- | ---- | ------- | -------------------- |
| กำหนด vision/scope/baseline      | C          | A/R | R    | I       | I                    |
| ตัดสินสถาปัตยกรรม + stack        | I          | A/R | C    | I       | —                    |
| จัดทำเอกสาร Wave A (deliverable 1–12) | I     | C   | A    | R       | C (เนื้อหาธุรกิจ)    |
| CTO gate เอกสาร (M1)             | I          | A/R | R    | I       | —                    |
| พัฒนาโค้ด Wave B–E               | I          | C   | A    | R       | —                    |
| Merge ลง develop                 | —          | C   | A/R  | —       | —                    |
| ทดสอบ (unit/integration/E2E)     | I          | I   | A    | R       | —                    |
| Security testing + VA/Pentest    | I          | A   | R    | R       | —                    |
| UAT (Wave F)                     | A          | I   | C    | C       | R                    |
| Release + ส่งมอบระบบ (M5)        | A          | C   | R    | I       | I                    |

## 4. วิธีทำงาน: Doc-first, DCR, Wave Model

**Doc-first** (brief §9.1): เอกสารคือ source of truth — ห้ามเขียนโค้ดก่อนเอกสาร 12 ฉบับ (deliverables 1–12) ผ่าน CTO gate เมื่อโค้ดพบปัญหาในเอกสาร ต้องยื่น **DCR (Document Change Request)** ไม่แก้โค้ดพร้อมกันเอง

**ขั้นตอน DCR:** (1) ผู้พบปัญหาเขียน DCR: ระบุ section เอกสาร + ปัญหา + ข้อเสนอ (2) CTO ตัดสิน (3) แก้เอกสารก่อน + bump version (4) จึงแก้โค้ดตามเอกสารใหม่ — บันทึกทุก verdict ใน CTO Decision Log (PROJECT-STATE.md)

**Wave Model** (brief §9.7): ทำงานเป็น wave เล็ก ๆ มี entry/exit criteria ชัดเจน ทุก wave จบต้องผ่าน gate ก่อนเริ่ม wave ถัดไป — ทุก task มี owner เดียว รายงานด้วย evidence และ commit บ่อย (lead เป็นผู้ commit ใน Wave A ตาม D4)

**Git protocol:** สาขาหลัก `develop` — lead เท่านั้นที่ branch/commit/merge; Conventional Commits + task ID เช่น `docs(a1): add PROJECT-PLAN v0.1.0 [A1]`; per-worker worktrees เริ่ม Wave B

**Merge gates ทุก PR:** lint + tsc + tests + build + secrets scan เขียว; โค้ด auth/security/data เพิ่ม codex gate (PASS ก่อน merge เท่านั้น)

## 5. แผนเวลาและ Milestones (Wave A–F)

> สมมติฐานวันที่แบบ relative (W# = สัปดาห์ที่ n ของโครงการ นับจากวันเริ่ม) — ยังไม่ผูกวันที่จริง รอ lead ยืนยัน calendar เมื่อทราบความพร้อมทีม

| Wave | ช่วงเวลา | เนื้อหาหลัก                                 | Milestone / Exit criteria                                      |
| ---- | -------- | ------------------------------------------- | --------------------------------------------------------------- |
| A    | W1–W3    | เอกสารนำ 12 ฉบับ + cross-doc consistency    | **M1: เอกสารผ่าน CTO gate** — deliverables 1–12 ได้ verdict PASS ทั้งชุด |
| B    | W4–W6    | repo scaffold + local Docker dev env + CI   | `docker compose up` รัน Supabase local ได้; CI gates ทำงานครบ 5 ด่าน |
| C    | W7–W12   | MVP: courses, enrollment, progress           | **M2: MVP** — flow เรียน end-to-end ผ่าน E2E; unit ≥ 80% business logic |
| D    | W13–W18  | Assessment + Certificates                    | **M3: สอบ+ประกาศนียบัตร** — สอบ/ตรวจ/ออก certificate + QR verify ผ่าน E2E |
| E    | W19–W24  | Credit Bank + admin/reporting                | **M4: credit bank+admin** — credit ledger append-only + dashboard/รายงาน |
| F    | W25–W30  | Security hardening + VA/pentest + UAT + คู่มือ | **M5: ส่งมอบ** — ASVS L2 ผ่าน, 0 High/Critical, UAT sign-off, deliverables 17–21 |

**รายละเอียด Milestone:**

| Milestone | นิยามควบคุม (ครบจึงนับว่าผ่าน)                                                                 |
| --------- | ---------------------------------------------------------------------------------------------- |
| M1        | เอกสาร 12 ฉบับสอดคล้อง brief ทุกจุด + ไม่มีขัดแย้งข้ามเอกสาร + CTO verdict PASS บันทึกใน Decision Log |
| M2        | MVP ใช้งานได้ใน local Docker: สมัคร/เข้าสู่ระบบ/ลงทะเบียน/เรียน/ติดตามความคืบหน้า + audit log ทำงาน |
| M3        | สอบปลายหลักสูตรตามกติกา (config-driven) + ออกประกาศนียบัตร + verify สาธารณะได้ + credit บันทึกถูกต้อง |
| M4        | Credit Bank สรุปยอดตามรอบต่ออายุ + admin back-office ครบ sub-role + รายงาน/export                |
| M5        | Security hardening ผ่าน ASVS L2 + VA/pentest ปิด High/Critical ทั้งหมด + UAT ผ่านเกณฑ์ + ส่งมอบ 21 รายการครบ |

**Dependency สำคัญ:** Wave B ต้องรอ M1; Q1–Q7 ต้องได้คำตอบก่อนสิ้น Wave C (R-18 — Q7 ผูกงบ cloud tier ของ staging ตาม §10) มิฉะนั้นทีมใช้ค่า default ตาม §11 และทำ config-driven

## 6. โครงสร้างทีมและบทบาท

| บทบาท                | ผู้รับผิดชอบ | หน้าที่หลัก                                                                           |
| -------------------- | ------------ | ------------------------------------------------------------------------------------- |
| CTO                  | codex CLI    | ตัดสินสถาปัตยกรรม/stack, DCR verdict, milestone gates M1–M5, codex gate โค้ด auth/security/data |
| Lead/PM              | session model | วางแผน มอบหมาย task คุม wave board/PROJECT-STATE, review ความสอดคล้องข้ามเอกสาร, จัดการ git แต่เพียงผู้เดียว, sole channel ต่อผู้ว่าจ้าง |
| worker-1             | เอกสารบริหารโครงการ | PROJECT-PLAN, RISK-REGISTER, TEST-PLAN (Wave A); Wave B+ รับ lane งานโค้ดที่ lead มอบหมาย |
| worker-2             | requirements | SRS, RTM (Wave A); Wave B+ รับ lane งานโค้ด                                          |
| worker-3             | design       | SDS, ARCHITECTURE, DATA-DICTIONARY (Wave A); Wave B+ รับ lane งานโค้ด                |
| worker-4             | API/security docs | API-SPECIFICATION, RBAC-DESIGN, AUDIT-LOG-DESIGN (Wave A); Wave B+ รับ lane งานโค้ด |
| worker-5             | UI           | DESIGN-SYSTEM + UI prototype (Wave A); Wave B+ รับ lane งานโครงการ                   |
| ทีม (รวม)            | —            | Wave B–E พัฒนาระบบ, Wave F ทดสอบ/ส่งมอบร่วมกัน (deliverables 13–21)                  |

**หลักการ:** กรรมสิทธิ์ไฟล์ไม่ทับกันใน Wave A (D4); Wave B เป็นต้นไปใช้ per-worker git worktrees; workers ห้ามใช้ git ทุกชนิดจนกว่า lead ประกาศเปลี่ยนกฎ

## 7. การทยอยส่งมอบ (21 Deliverables)

| #  | Deliverable            | ไฟล์/ตำแหน่ง                          | Owner    | Wave | เชื่อม Milestone |
| -- | ---------------------- | ------------------------------------- | -------- | ---- | ---------------- |
| 1  | Project Plan           | `01-management/PROJECT-PLAN.md`       | worker-1 | A    | M1               |
| 2  | Risk Register          | `01-management/RISK-REGISTER.md`      | worker-1 | A    | M1               |
| 3  | SRS                    | `02-requirements/SRS.md`              | worker-2 | A    | M1               |
| 4  | RTM                    | `02-requirements/RTM.md`              | worker-2 | A    | M1               |
| 5  | SDS                    | `03-design/SDS.md`                    | worker-3 | A    | M1               |
| 6  | Architecture Diagram   | `03-design/ARCHITECTURE.md`           | worker-3 | A    | M1               |
| 7  | Data Dictionary        | `03-design/DATA-DICTIONARY.md`        | worker-3 | A    | M1               |
| 8  | API Specification      | `04-api-security/API-SPECIFICATION.md`| worker-4 | A    | M1               |
| 9  | RBAC Design            | `04-api-security/RBAC-DESIGN.md`      | worker-4 | A    | M1               |
| 10 | Audit Log Design       | `04-api-security/AUDIT-LOG-DESIGN.md` | worker-4 | A    | M1               |
| 11 | UI Prototype           | `05-ui/DESIGN-SYSTEM.md` + prototype  | worker-5 | A    | M1               |
| 12 | Test Plan              | `06-testing/TEST-PLAN.md`             | worker-1 | A    | M1               |
| 13 | Developed System       | `apps/*`                              | team     | B–E  | M2–M4            |
| 14 | Source Code            | repo ทั้งหมด                          | team     | B–E  | M2–M4            |
| 15 | Database Script        | `supabase/migrations/*`               | team     | B–E  | M2–M4            |
| 16 | Deployment Package     | `infra/` + CI + คู่มือ deploy          | team     | B, F | M1→B, M5         |
| 17 | System Test Result     | `docs/07-results/SYSTEM-TEST.md`      | team     | F    | M5               |
| 18 | UAT Result             | `docs/07-results/UAT.md`              | team     | F    | M5               |
| 19 | VA/Pentest Report      | `docs/07-results/VA-PENTEST.md`       | team     | F    | M5               |
| 20 | Security Remediation   | `docs/07-results/SECURITY-REMEDIATION.md` | team  | F    | M5               |
| 21 | User Manual            | `docs/08-manuals/USER-MANUAL.md`      | team     | F    | M5               |

สถานะรายการติดตามแบบ real-time ที่ `docs/README.md` (deliverable checklist) + wave board ที่ `PROJECT-STATE.md`

## 8. การบริหารความเสี่ยง

รายละเอียดครบถ้วนอยู่ที่ `01-management/RISK-REGISTER.md` (26 ความเสี่ยง) — เอกสารนี้สรุปกระบวนการเท่านั้น:

- **ระบุ:** ทุก wave เริ่มต้นด้วยการ review risk register; ความเสี่ยงใหม่เพิ่มได้ทุกเมื่อ (append + re-score)
- **ประเมิน:** โอกาส (1–5) × ผลกระทบ (1–5) = คะแนน; ≥ 15 = วิกฤต (ต้องมีแผนก่อนเริ่ม wave ที่เกี่ยวข้อง), 10–14 = สูง, 5–9 = ปานกลาง, ≤ 4 = ต่ำ
- **ติดตาม:** Top-5 risks รายงานทุก milestone gate; Trigger ตรวจจับถูกฝังใน metric/log ที่นิยามไว้ต่อความเสี่ยง
- **เจ้าของ:** ทุกความเสี่ยงมี owner ตัวเดียว (lead หรือ worker ที่รับ lane นั้น) — escalation ไป CTO เมื่อคะแนน ≥ 15 หรือ trigger แตะ

## 9. KPI และ Definition of Done

**KPI โครงการ:**

| KPI                                             | เป้า      | วัดที่ milestone |
| ------------------------------------------------ | --------- | ---------------- |
| Milestone ตรงตามแผน (M1–M5)                      | ≥ 4/5 ตรง | ทุก M            |
| Deliverables ผ่าน CTO gate ตั้งแต่ครั้งแรก (Wave A) | ≥ 10/12   | M1               |
| Merge gate ผ่านโดยไม่ถูกตีกลับ                  | ≥ 80%     | M2–M5            |
| Defect ค้างระดับ High/Critical ตอนส่งมอบ         | 0         | M5               |
| Unit test coverage ของ business logic            | ≥ 80%     | M2 ขึ้นไป        |
| DCR ที่ไม่ผ่านการตัดสินแล้วค้าง > 1 สัปดาห์       | 0         | ต่อเนื่อง        |
| ความผิดพลาดคำนวณ credit ที่พบหลังส่งมอบ          | 0         | หลัง M5          |

**Definition of Done (ตาม Glossary และ brief §9.6):**

- **เอกสาร (Wave A):** ครบทุก section ตามโครงที่กำหนด + สอดคล้อง brief/Glossary ทุกจุด + ค่าธุรกิจที่ยังไม่ยืนยันระบุเป็นพารามิเตอร์ + default + "รอยืนยัน Q#" + ผ่าน lead review และ CTO gate
- **โค้ด (Wave B+):** lint + tsc + tests + build + secrets scan ผ่าน (evidence: exit code 0 + test count) + โค้ด auth/security/data ผ่าน codex gate + review ผ่าน + อัปเดตเอกสารที่เกี่ยวข้องก่อน (ถ้ามี DCR) + ไม่มี debug code ตกค้าง
- **Milestone:** ผ่านเกณฑ์นิยามควบคุมใน §5 + บันทึกใน PROJECT-STATE.md + wave board อัปเดต

## 10. เครื่องมือและ Infrastructure

| ด้าน            | เครื่องมือ/บริการ                                                                     |
| --------------- | --------------------------------------------------------------------------------------- |
| Dev environment | 100% local Docker — Supabase local stack (PostgreSQL 15 + Auth + Storage) ผ่าน docker-compose |
| Staging environment | Cloud preview ก่อนขึ้น prod (brief 0.2.0 §6, DCR-1) — **Vercel staging + Supabase staging branch + Cloudflare staging domain**; config ชุดเดียวกับ prod แยกด้วย env vars เท่านั้น · เริ่มใช้ตั้งแต่ **Wave D** สำหรับ k6 10k/5k + security test และ UAT (TEST-PLAN §4) · งบ cloud tier **ผูกกับ Q7** — ต้องได้คำตอบก่อนสิ้น Wave C |
| Production      | 100% cloud — Vercel (app) + Supabase Cloud (data/auth/storage) + Cloudflare (DNS, WAF, CDN, rate limit, R2/Stream) |
| Stack           | Next.js 15 (App Router, RSC) + TypeScript strict + Tailwind CSS + zod ทุก input          |
| Migration       | SQL migrations ที่ `supabase/migrations` (parity กับ prod) + RLS ทุกตาราง                |
| Testing         | Vitest (unit) + Playwright (E2E) + k6 (load) + OWASP ZAP + manual ASVS L2                |
| CI              | GitHub Actions — lint + tsc + test + build + secrets scan เป็น merge gate                 |
| โครงการ         | PROJECT-STATE.md (second brain) + wave board + CTO Decision Log + DCR                    |
| กฎเหล็ก         | โค้ดชุดเดียวรันได้ทั้ง local/prod ต่างกันแค่ environment variables — ห้าม hardcode |

## 11. สมมติฐาน ข้อจำกัด และคำถามค้าง

**สมมติฐานหลัก:**

1. ผู้ว่าจ้างพร้อมตอบ Q1–Q6 ภายในสิ้น Wave C — ไม่เช่นนั้นใช้ค่า default ตามตารางล่าง (config-driven แก้ได้ภายหลัง)
2. ทีมพัฒนา = CTO + Lead + workers 1–5 ทำงานต่อเนื่อง (continuously) ตลอด wave ตาม model routing D5
3. งบ cloud services อนุมัติเป็นรายเดือน และยืดหยุ่นได้เมื่อปริมาณใช้งานสูงกว่าคาด (R-19)
4. เนื้อหาหลักสูตร/ธนาคารข้อสอบ ทีมฝั่งสภาฯ จัดเตรียมให้ทัน Wave D (R-12)

**พารามิเตอร์ธุรกิจที่ยังไม่ยืนยัน (default + "รอยืนยัน Q#"):**

> หมายเหตุ (D8-5): ค่า default canonical ของโครงการยึด **SRS Appendix A** เป็นหลัก — ตารางนี้เป็นสรุปเพื่อการวางแผน หากค่าขัดกันให้ยึด SRS Appendix A

| พารามิเตอร์                | ค่า default (เหตุผล)                        | สถานะ      |
| --------------------------- | -------------------------------------------- | ---------- |
| ความยาวรอบต่ออายุ            | 1 ปี (ค่ากลางที่ config รองรับ 1–5 ปี)        | รอยืนยัน Q1 |
| จำนวน credit ต่อรอบต่ออายุ    | 12 หน่วย/รอบ (สมมติฐานทีม ยังไม่มีข้อกำหนดทางการ) | รอยืนยัน Q1 |
| เกณฑ์ผ่านการสอบ              | ≥ 70% ของคะแนนเต็ม (ตั้งต่ำกว่าครึ่ง สมเหตุสมผล) | รอยืนยัน Q2 |
| จำนวนครั้งสอบได้ต่อหลักสูตร   | 3 ครั้ง (ให้โอกาสสอบซ้ำแบบสถาบันทั่วไป)       | รอยืนยัน Q2 |
| วิธียืนยันตัวตนทนายความ      | กรอกเลขที่ใบอนุญาต + เจ้าหน้าที่ตรวจยืนยัน manual | รอยืนยัน Q3 |
| Proctoring                  | บันทึก event พื้นฐาน (เวลา, การเปลี่ยน tab) ไม่ lock browser | รอยืนยัน Q4 |
| Data residency              | Supabase region Singapore (ใกล้ไทยที่สุดที่มี) | รอยืนยัน Q5 |
| วิดีโอ: ความยาว/ความละเอียด  | ≤ 60 นาที/บทเรียน, ≤ 1080p, ผ่าน CDN เท่านั้น | รอยืนยัน Q6 |

ทุกพารามิเตอร์เก็บใน config เดียว (credit_rules / assessment config) ตาม D3 — ห้าม hardcode ในโค้ด

**ข้อจำกัด:**

1. งบซื้อ cloud service ต้องอนุมัติผ่านผู้ว่าจ้าง (R-19) — ทีมไม่มีสิทธิ์ซื้อเพิ่มเอง
2. Workers ห้ามใช้ git / ห้าม npm install โดยพลการ (Wave A) — lead จัดการแต่ผู้เดียว (D4)
3. ห้าม log PII ทุก environment (brief §8) — กระทบวิธี debug ต้องใช้ user_id อ้างอิง
4. เอกสาร baseline แก้ไม่ได้นอกกระบวนการ DCR

**คำถามค้าง (นอกเหนือ Q1–Q6) ที่ lead ต้องชี้ขาด:**

| #  | คำถาม                                                                 | ผลกระทบ                    |
| -- | ---------------------------------------------------------------------- | --------------------------- |
| QP-1 | วันที่เริ่มนับ W1 จริงคือวันใด (ผูก calendar กับแผน relative W1–W30)    | แผนเวลาทั้งหมด §5           |
| QP-2 | ใครเป็นผู้ sign-off UAT ฝั่งสภาฯ (กี่คน ต้องผ่านกี่ flow)                | เกณฑ์ M5                    |
| QP-3 | มี SME กฎหมายตรวจความถูกต้องเนื้อหาหลักสูตรหรือไม่ (R-12)              | คุณภาพเนื้อหา Wave C–D     |
| QP-4 | ต้องรายงานความคืบหน้าถึงผู้ว่าจ้างในรูปแบบ/ความถี่ใด                    | กระบวนการรายงาน             |
| QP-5 | ~~ใช้ staging/preview deployment อย่างไร~~ **ยุบรวมเข้า Q7** — brief 0.2.0 §6 นิยาม staging environment แล้ว (DCR-1) เหลือเฉพาะคำถามงบ cloud tier ซึ่ง Q7 ครอบคลุม (TEST-PLAN §4, T-1) | เกณฑ์ performance ของ M3/M5 — **ต้องได้คำตอบ Q7 ก่อนสิ้น Wave C** |
