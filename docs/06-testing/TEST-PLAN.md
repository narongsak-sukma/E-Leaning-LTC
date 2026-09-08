# TEST PLAN — ระบบ LTC E-Learning

**เวอร์ชัน 0.2.0-draft · 2026-09-08 · LTC E-Learning**

|          |                                                   |
| -------- | ------------------------------------------------- |
| เจ้าของเอกสาร | worker-1 (Wave A) — team ปฏิบัติตามแผนนี้ Wave B–F |
| อ้างอิง   | `00-baseline/PROJECT-BRIEF.md` (0.2.0) §2, §5, §6, §7, §8, §10 · `01-management/PROJECT-PLAN.md` §9 · `01-management/RISK-REGISTER.md` |
| สถานะ    | draft — รอ CTO gate (Milestone M1)                |
| แก้ไข 0.2.0 | ตาม **DCR-1 (CTO APPROVE)**: staging ตาม brief 0.2.0 §6 กลายเป็น environment หลักของ performance/security/UAT test (แทน workaround "preview deployment"); งบ cloud tier ของ staging รอยืนยัน Q7 (brief §10) |

## สารบัญ

1. [วัตถุประสงค์และขอบเขต](#1-วัตถุประสงค์และขอบเขต)
2. [กลยุทธ์การทดสอบ](#2-กลยุทธ์การทดสอบ)
3. [ระดับการทดสอบ](#3-ระดับการทดสอบ)
4. [สภาพแวดล้อมการทดสอบ](#4-สภาพแวดล้อมการทดสอบ)
5. [Entry / Exit Criteria](#5-entry--exit-criteria)
6. [เคสทดสอบตัวอย่าง (TC-xxx)](#6-เคสทดสอบตัวอย่าง-tc-xxx)
7. [Defect Management และ Severity](#7-defect-management-และ-severity)
8. [เกณฑ์ผ่านและ Coverage Targets](#8-เกณฑ์ผ่านและ-coverage-targets)
9. [ความเสี่ยงด้านการทดสอบ](#9-ความเสี่ยงด้านการทดสอบ)

---

## 1. วัตถุประสงค์และขอบเขต

**วัตถุประสงค์:** พิสูจน์ว่าระบบ LTC E-Learning ทำงานถูกต้องตาม PROJECT-BRIEF และ SRS, ปลอดภัยตาม OWASP ASVS L2, รองรับปริมาณผู้ใช้ตามเป้าหมาย (brief §7) และพร้อมใช้งานจริงต่อผู้ใช้ 4 personas (citizen / lawyer / instructor / staff) โดยทุกผลการทดสอบมี evidence ตามหลัก no fake completion

**ในขอบเขต:** ทดสอบฟีเจอร์ทั้งหมดของ v1 ครอบคลุม 10 กลุ่ม requirement ตามโดเมนใน brief §5: **AUTH / IDENT / CAT / LRN / ASM / CRT / CRB / NTF / ADM / AUD** — ทุกระดับ Unit / Integration / E2E / Security / Performance / UAT

**นอกขอบเขต:** การทดสอบ browser เก่าที่ไม่รองรับ / อุปกรณ์ native app (นอก scope v1) / penetration test จากบุคคลที่สามภายนอก (ทำ VA ภายใน + manual ASVS L2 แทน — ถ้าผู้ว่าจ้างต้องการ pentest ภายนอกให้เพิ่มใน Wave F)

**หมายเหตุ ID:** FR-xxx ในเอกสารนี้เป็น ID ชั่วคราวตามโดเมน (เช่น FR-AUTH-01) — จะจัดชุดข้อมูล final กับ `02-requirements/SRS.md` และ `02-requirements/RTM.md` ของ worker-2 เมื่อผ่าน CTO gate M1 แล้ว (RTM จะ map TC ↔ FR ฉบับเต็ม)

## 2. กลยุทธ์การทดสอบ

1. **Shift-left:** กำหนดเคสหลักตั้งแต่ Wave A (เอกสารนี้) — SRS/RTM ขยายรายละเอียดต่อ; โค้ดเขียนพร้อม test ตั้งแต่ Wave B
2. **Pyramid:** มาก Unit (เร็ว ถูก) → Integration ระดับกลาง (API+DB+RLS) → E2E เฉพาะ flow หลัก (ช้า แพง) บวก security/performance เป็นชั้นเฉพาะทาง
3. **ทุก merge ผ่าน gate:** lint + tsc + unit + integration + build + secrets scan ใน GitHub Actions — E2E รันทุก PR ต่อ flow ที่กระทบ + nightly ทั้งชุด
4. **Config-driven ต้องถูกทดสอบ:** ค่า config (เกณฑ์ผ่าน, จำนวนครั้ง, กฎ credit, รอบต่ออายุ) ต้องมีเคสทดสอบที่เปลี่ยนค่าแล้วพฤติกรรมเปลี่ยนตาม — ไม่ assume ค่า default
5. **Evidence-based:** ทุกผลทดสอบบันทึก command + exit code + จำนวนเคสผ่าน/พังลง `docs/07-results/SYSTEM-TEST.md`
6. **ครอบคลุมความเสี่ยง:** เคส security/performance ออกแบบจาก RISK-REGISTER โดยตรง (R-01, R-02, R-10, R-22, R-25, R-26)

## 3. ระดับการทดสอบ

### 3.1 Unit Testing (Vitest)

- **ขอบเขต:** business logic ล้วน — กฎ credit (CRB), การตรวจข้อสอบ/เกณฑ์ผ่าน (ASM), คำนวณความคืบหน้า (LRN), validation schema (zod), utility
- **เป้า:** coverage ≥ 80% ของ business logic (ทั้ง lines และ branches); ทุกกฎ config มีเคส boundary (ค่าต่ำสุด/สูงสุด/ผิดพลาด)
- **งด:** ไม่ยุ่ง DB จริง / network — ใช้ mock/pure function

### 3.2 Integration Testing (Vitest + ทดสอบกับ Supabase local)

- **ขอบเขต:** API Route Handlers `/api/v1/*` + Server Actions กับ PostgreSQL จริงใน Docker — รวม **RLS policy ทุกตาราง**: ทดสอบในสิทธิ์ anon / authenticated / บทบาทย่อยของ staff และพิสูจน์ว่า policy ปฏิเสธการเข้าถึงข้ามผู้ใช้
- **เป้า:** ทุก endpoint มีอย่างน้อย 1 เคส happy path + 1 เคส auth/RLS denial; audit log append-only ถูกทดสอบ (UPDATE/DELETE ต้อง fail)

### 3.3 E2E Testing (Playwright)

**Flow หลัก 16 scenarios (≥ 12 ตามเป้า):**

| #      | Scenario                                                                 | โดเมน        |
| ------ | ------------------------------------------------------------------------ | ------------ |
| E2E-01 | สมัครสมาชิกใหม่ (citizen) ด้วย email/มือถือ + ยืนยันตัวตน               | AUTH         |
| E2E-02 | เข้าสู่ระบบ / ออกจากระบบ / ลืมรหัสผ่าน                                   | AUTH         |
| E2E-03 | ทนายความกรอกเลขที่ใบอนุญาต + เจ้าหน้าที่ตรวจยืนยัน                      | IDENT        |
| E2E-04 | ค้นหา/เลือกดูแคตตาล็อก และลงทะเบียนหลักสูตร                            | CAT          |
| E2E-05 | เรียนวิดีโอ + เอกสารจนจบโมดูล — progress อัปเดต                          | LRN          |
| E2E-06 | ทำแบบทดสอบย่อย (quiz) จนผ่าน                                             | LRN          |
| E2E-07 | เรียนครบหลักสูตร → ได้สิทธิ์เข้าสอบปลายหลักสูตร                          | LRN → ASM    |
| E2E-08 | สอบปลายหลักสูตรผ่านเกณฑ์ (default ≥ 70% — รอยืนยัน Q2)                   | ASM          |
| E2E-09 | สอบไม่ผ่าน → สอบซ้ำ (ภายในจำนวนครั้ง default 3 — รอยืนยัน Q2)            | ASM          |
| E2E-10 | นายทะเบียน (staff:registrar) ออกประกาศนียบัตร                            | CRT          |
| E2E-11 | ยืนยันประกาศนียบัตรสาธารณะด้วยรหัส/QR — ไม่เปิดเผย PII เกินจำเป็น         | CRT          |
| E2E-12 | credit สะสมแสดงใน Credit Bank ตามรอบต่ออายุ (default 1 ปี — รอยืนยัน Q1) | CRB          |
| E2E-13 | instructor สร้างหลักสูตร/นำเข้าข้อสอบ + เจ้าหน้าที่อนุมัติเผยแพร่        | ADM          |
| E2E-14 | admin ดู dashboard + สร้าง/export รายงาน                                 | ADM          |
| E2E-15 | รับแจ้งเตือนในระบบ + อีเมล (เทมเพลตภาษาไทย)                               | NTF          |
| E2E-16 | staff ล็อกอินด้วย MFA + ตรวจ audit log ของ action สำคัญ                   | AUD          |

- **งด (ยกเว้น happy path):** ไม่ทดสอบตกแต่ง UI ปลีกย่อยใน E2E (เป็นหน้าที่ unit/visual review)
- **รัน:** ทุก PR (ชุดที่กระทบ) + nightly ทั้งชุด บน browser Chromium + WebKit + Mobile Chrome (responsive)

### 3.4 Security Testing

- **OWASP ZAP:** baseline scan ทุก build (local) + active scan บน **staging** ต่อ milestone (M2–M5)
- **Manual ASVS L2:** checklist ตาม OWASP ASVS 4.0 L2 ครอบคลุม V1–V14 (architecture, authentication, session, access control, validation, crypto, errors, logging, data protection) — ทำต่อ milestone + ก่อน M5
- **Secrets scan:** CI ทุก commit (key/token ห้ามติด repo) — เป็น merge gate
- **Dependency audit:** `npm audit` + Dependabot alerts ทุก PR; Critical ต้องแก้ก่อน merge
- **จุดเน้นตาม RISK-REGISTER:** R-01 (OWASP Top 10), R-02 (account takeover/lockout), R-22 (audit แก้ไม่ได้), R-25 (RLS/service key), R-26 (verify rate limit)

### 3.5 Performance / Load Testing (k6)

ตามเป้า brief §7 (สอง profile):

| Profile                 | จำนวน VU พร้อมกัน | เกณฑ์ผ่าน                                                                 |
| ----------------------- | ------------------ | --------------------------------------------------------------------------- |
| เรียนพร้อมกัน            | 10,000             | error rate < 0.1%; API หลัก (progress sync) P95 < 500 ms; วิดีโอ start P95 < 3 s |
| สอบพร้อมกัน              | 5,000              | error rate < 0.1%; ส่งคำตอบ P95 < 1 s; ไม่มีคำตอบหาย (auto-save ครบ); ตรวจให้คะแนนถูกต้อง 100% |
| Spike (เปิดรอบสอบ)       | 0 → 5,000 ใน 60 s  | ระบบ recover ภายใน 2 นาที ไม่ล่ม; ไม่ reject ผู้เข้าสอบที่ถูกต้อง            |

- Soak test: 10,000 VU ต่อเนื่อง 1 ชั่วโมง — ไม่มี memory leak / connection leak
- รันบน **staging** (environment หลักของ performance test ตาม brief 0.2.0 §6) ใน Wave D (ก่อน M3) และ Wave F (ก่อน M5); cloud tier ของ staging รอยืนยัน Q7 — local Docker ใช้เฉพาะ smoke/shrink ระหว่างพัฒนา (ดู §4)

### 3.6 UAT (Wave F)

- **ผู้ทดสอบ:** เจ้าหน้าที่สภาฯ (registrar/content/exam) + ตัวแทนทนายความ + ตัวแทนประชาชน (lead ประสาน — รอยืนยัน QP-2)
- **คู่มือ:** จัดทำ UAT script ต่อ persona ครอบคลุม flow หลัก 16 scenarios ของ §3.3 + เคสธุรกิจจริง (เช่น ตรวจยอด credit ต่อรอบ) — เก็บผลใน `docs/07-results/UAT.md`
- **เกณฑ์:** ผ่าน ≥ 95% ของขั้นตอนใน script; flow ระดับ Critical (สอบ/ประกาศนียบัตร/credit) ต้องผ่าน 100%; ข้อความ/คำอธิบายภาษาไทยเข้าใจได้

### 3.7 Crosswalk ชั่วคราว: TC ของแผนนี้ ↔ RTM (ต้องครบก่อน CTO gate M1)

RTM (`02-requirements/RTM.md`, worker-2) นิยาม TC ID ระบบเดียวของโครงการเป็นรูปแบบ `TC-<โดเมน>-<NN>` (134 ID) ส่วนแผนนี้ใช้ TC-001…TC-018 เป็นเคสตัวแทน — ตารางนี้ mapping ทั้ง 18 เคสให้ trace ได้ต่อเนื่องก่อน gate (ตาม M-02/D8) · หลัง M1 ให้ยุบรวมเป็นระบบ ID เดียวยึด RTM (DCR-2) · ค่า default ที่อ้างเป็นบริบทในเอกสารนี้ ยึด canonical จาก **SRS Appendix A** (D8-5)

| TC ของแผนนี้       | RTM TC หลัก  | RTM TC เกี่ยวข้อง | หมายเหตุการ mapping                              |
| ------------------ | ------------ | ----------------- | -------------------------------------------------- |
| TC-001 สมัคร email ซ้ำ | TC-AUTH-01 | —                 | AUTH-001 (กรณีปฏิเสธ email ซ้ำ/anti-enumeration)  |
| TC-002 lockout     | TC-AUTH-09   | TC-SEC-08         | AUTH-009 + ธง admin lockout ของ SEC-008            |
| TC-003 ผูกใบอนุญาตผิดรูปแบบ | TC-IDENT-02 | TC-SEC-14   | IDENT-002 + zod negative ของ SEC-014              |
| TC-004 เจ้าหน้าที่อนุมัติทนาย | TC-IDENT-03 | TC-IDENT-04, TC-AUD-01 | IDENT-003/004 + audit ของ AUD-001            |
| TC-005 ลงทะเบียนหลักสูตร draft | TC-LRN-01 | TC-CAT-05     | LRN-001 + วงจรสถานะหลักสูตร CAT-005              |
| TC-006 progress จบวิดีโอ | TC-LRN-06 | TC-LRN-08         | LRN-006 (server ตัดสิน) + เงื่อนไขผ่าน LRN-008   |
| TC-007 quiz ย่อย   | TC-LRN-05    | —                 | LRN-005 (ทำซ้ำได้, ไม่นับ credit)                 |
| TC-008 สุ่มชุดข้อสอบ | TC-ASM-04  | TC-ASM-13         | ASM-004 + เงื่อนไขเข้าสอบ ASM-013                |
| TC-009 สอบเกินเวลา | TC-ASM-05    | —                 | ASM-005 (submit อัตโนมัติฝั่ง server)             |
| TC-010 เกินจำนวนครั้ง | TC-ASM-06  | —                 | ASM-006 (จำนวนครั้ง + cooldown, config-driven)    |
| TC-011 ออกประกาศนียบัตร | TC-CRT-02 | TC-CRT-03         | CRT-002 + รหัส unique/QR ของ CRT-003             |
| TC-012 verify ปลอม/rate limit | TC-CRT-04 | TC-SEC-05, TC-SEC-09 | CRT-004 + rate limit SEC-005 + ไม่ leak PII SEC-009 |
| TC-013 credit จากผลสอบ | TC-CRB-03 | TC-CRB-05         | CRB-003 (คำนวณอัตโนมัติ) + ยอดต่อรอบ CRB-005      |
| TC-014 แก้/ลบ ledger ปฏิเสธ | TC-CRB-02 | TC-AUD-02, TC-SEC-04 | CRB-002 + AUD-002 + SEC-004 (append-only 3 มุม) |
| TC-015 แจ้งเตือนออก cert | TC-NTF-01 | TC-NTF-03, TC-NTF-05 | NTF-001 (in-app) + NTF-003 (อีเมล) + ตั้งค่ารับ NTF-005 |
| TC-016 RBAC staff:viewer | TC-IDENT-07 | TC-ADM-05        | IDENT-007 (union/explicit) + ADM-005 (จัดการหลักสูตร) |
| TC-017 audit ครบ action | TC-AUD-01 | TC-AUD-04         | AUD-001 + ไม่บรรจุ PII AUD-004                    |
| TC-018 RLS ข้ามผู้ใช้ | TC-SEC-02   | —                 | SEC-002 (RLS ทุกตาราง — ครอบทุกโดเมน)            |

## 4. สภาพแวดล้อมการทดสอบ

| การทดสอบ      | Environment                                                                 |
| ------------- | ----------------------------------------------------------------------------- |
| Unit          | local (ไม่พึ่ง network/DB)                                                    |
| Integration   | **local Docker** — Supabase local stack (PostgreSQL 15 + Auth + Storage) ผ่าน docker-compose + seed data (ผู้ใช้ทุกบทบาท, หลักสูตรตัวอย่าง, ข้อสอบ) |
| E2E           | local Docker + Playwright browser (Chromium/WebKit/Mobile Chrome)             |
| Security      | **staging** (ZAP active scan + manual ASVS L2) + secrets scan/dependency audit บน repo ใน CI |
| Performance   | **staging เป็น environment หลัก** — profile 10k/5k + spike + soak รันที่นี่; local Docker ใช้เฉพาะ smoke/shrink ระหว่างพัฒนา |
| UAT           | **staging** (ข้อมูลทดสอบแยกจาก prod ด้วย Supabase staging branch)             |

**นิยาม staging ตาม brief 0.2.0 §6:** cloud preview ก่อนขึ้น prod — Vercel preview/staging deployment + Supabase staging branch + Cloudflare (โดเมน staging) ใช้ config ชุดเดียวกับ prod แยกด้วย env vars เท่านั้น — หน้าที่คือพิสูจน์ performance (k6 10k/5k) + security test ก่อน promote ขึ้น prod; งบ cloud tier ที่ต้องรองรับ load test รอยืนยัน Q7 (brief §10)

หลักการ: โค้ดชุดเดียว ต่างกันแค่ environment variables (brief §6) — seed script เดียวกันใช้ได้ทุก environment

## 5. Entry / Exit Criteria

| ระดับ         | Entry criteria                                                          | Exit criteria                                                       |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Unit          | โค้ด module ผ่าน lint + tsc                                              | coverage ≥ 80% business logic; 0 fail; ทุก config rule มี boundary test |
| Integration   | migrations รันผ่านใน Docker; unit ผ่านทั้งหมด                             | ทุก endpoint ≥ 1 happy + 1 denial; RLS ทุก policy มีเคส; audit append-only ยืนยันแล้ว |
| E2E           | integration ผ่าน; seed data พร้อม; build ผ่าน                            | 16/16 scenarios ผ่าน; ไม่มี flaky ค้าง > 1 สัปดาห์                     |
| Security      | build deploy ได้บน staging; feature freeze ของ wave นั้น                   | ZAP ไม่มี High+ ใหม่; ASVS L2 checklist ไม่มีช่องโหว่ High+; secrets scan สะอาด; dependency audit ไม่มี Critical |
| Performance   | ฟีเจอร์ที่โหลดเสถียรแล้ว; staging พร้อม (cloud tier อนุมัติตาม Q7)        | ผ่านเกณฑ์ทั้ง 3 profile ของ §3.5 + soak บน staging                  |
| UAT           | ผ่านทุกระดับข้างต้น + คู่มือ UAT + บัญชีทดสอบพร้อม                         | ≥ 95% ขั้นตอนผ่าน; Critical flow 100%; sign-off ตาม QP-2              |

## 6. เคสทดสอบตัวอย่าง (TC-xxx)

> รูปแบบ: ชื่อ / เงื่อนไขเบื้องต้น / ขั้นตอน / ผลคาดหวัง / requirement ที่ผูกกัน (FR ตามโดเมน brief §5) — 18 เคสตัวแทน (ชุดเต็มขยายใน RTM) · **mapping TC นี้ ↔ RTM อยู่ที่ §3.7**

### TC-001 สมัครสมาชิกด้วย email ที่ถูกใช้แล้ว — AUTH (Unit/Integration)

| ฟิลด์            | รายละเอียด                                                      |
| ---------------- | ---------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | มีบัญชี `u1@example.com` ในระบบแล้ว                               |
| ขั้นตอน          | 1) เปิดหน้าสมัคร 2) กรอก email ซ้ำ + รหัสผ่านที่ผ่านเกณฑ์ 3) ส่งฟอร์ม |
| ผลคาดหวัง        | ปฏิเสธด้วยข้อความไทยที่ไม่เปิดเผยว่า email นี้เป็นสมาชิกหรือยัง (anti-enumeration) หรือชี้ทางล็อกอิน; ไม่สร้างบัญชีใหม่; ไม่ log PII |
| Requirement      | FR-AUTH-สมัครสมาชิก (AUTH)                                       |

### TC-002 ล็อกอินผิดเกิน threshold ถูก lockout — AUTH (Integration)

| ฟิลด์            | รายละเอียด                                                       |
| ---------------- | ------------------------------------------------------------------ |
| เงื่อนไขเบื้องต้น | บัญชีทดสอบใช้งานได้; ค่า threshold เป็น config                     |
| ขั้นตอน          | 1) ล็อกอินผิดจนครบ threshold 2) ครั้งถัดไปกรอกถูก 3) รอพ้นระยะ lockout แล้วลองใหม่ |
| ผลคาดหวัง        | หลังครบ threshold ถูก lockout ตาม policy แม้กรอกถูก; พ้นระยะเวลาแล้วล็อกอินได้; มี audit record |
| Requirement      | FR-AUTH-lockout (AUTH + AUD)                                       |

### TC-003 ผูกเลขที่ใบอนุญาตรูปแบบไม่ถูกต้อง — IDENT (Unit)

| ฟิลด์            | รายละเอียด                                                        |
| ---------------- | -------------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | ผู้ใช้บทบาท lawyer; รูปแบบเลขที่ใบอนุญาต define ใน zod schema (รอยืนยัน Q3) |
| ขั้นตอน          | 1) กรอกเลขที่ใบอนุญาตอักษร/ความยาวผิด 2) ส่ง 3) กรอกเลขซ้ำกับผู้ใช้อื่น |
| ผลคาดหวัง        | ทั้งสองกรณีถูกปฏิเสธที่ฝั่ง server (zod) ไม่ใช่เฉพาะฝั่ง client; ข้อความ error ภาษาไทย |
| Requirement      | FR-IDENT-ผูกใบอนุญาต (IDENT)                                          |

### TC-004 เจ้าหน้าที่อนุมัติการยืนยันทนาย — IDENT (Integration/E2E)

| ฟิลด์            | รายละเอียด                                                       |
| ---------------- | ------------------------------------------------------------------ |
| เงื่อนไขเบื้องต้น | มีคำขอยืนยันสถานะ waiting; ผู้ทดสอบเป็น staff ที่มีสิทธิ์           |
| ขั้นตอน          | 1) staff เปิดคิวยืนยัน 2) อนุมัติคำขอ 3) ตรวจ audit log            |
| ผลคาดหวัง        | สถานะบัญชีเปลี่ยนเป็น verified; audit บันทึกผู้อนุมัติ+เวลา; ผู้ใช้ได้แจ้งเตือน |
| Requirement      | FR-IDENT-ยืนยันโดยเจ้าหน้าที่ (IDENT + AUD + NTF)                    |

### TC-005 ลงทะเบียนหลักสูตรที่ยังไม่เปิด — CAT (Integration)

| ฟิลด์            | รายละเอียด                                                     |
| ---------------- | ----------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | หลักสูตรอยู่สถานะ draft ยังไม่เผยแพร่                              |
| ขั้นตอน          | 1) เรียก API ลงทะเบียนโดยตรง (bypass UI) ด้วยบัญชี citizen/lawyer |
| ผลคาดหวัง        | ปฏิเสธ 4xx; RLS/ตรรกะกันเงื่อนไขการเข้าเรียน; ไม่เกิดแถว enrollment |
| Requirement      | FR-CAT-เงื่อนไขการเข้าเรียน (CAT)                                   |

### TC-006 ความคืบหน้าเรียนอัปเดตเมื่อจบวิดีโอ — LRN (Integration)

| ฟิลด์            | รายละเอียด                                                    |
| ---------------- | ---------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | ผู้ใช้ลงทะเบียนหลักสูตรแล้ว; บทเรียนวิดีโอความยาว t นาที          |
| ขั้นตอน          | 1) เล่นวิดีโอ 2) เดินหน้าจนจบ 3) ตรวจ API progress               |
| ผลคาดหวัง        | บทเรียนถือว่าเสร็จเมื่อดูครบตามเกณฑ์; progress รวมของโมดูล/หลักสูตรถูกต้อง; ปิดกลางคันไม่นับเป็นจบ |
| Requirement      | FR-LRN-ติดตามความคืบหน้า (LRN)                                     |

### TC-007 แบบทดสอบย่อยผ่านเกณฑ์ — LRN (Integration)

| ฟิลด์            | รายละเอียด                                              |
| ---------------- | ---------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | บทเรียนมี quiz 3 ข้อ; ผู้ใช้ยังไม่เคยทำ                       |
| ขั้นตอน          | 1) ตอบถูก 2) ตอบผิดทั้งหมด 3) ทำซ้ำจนผ่าน                    |
| ผลคาดหวัง        | สถานะ quiz เปลี่ยนตามเกณฑ์; ทำซ้ำได้; quiz ไม่นับ credit โดยตรง (ตาม Glossary) |
| Requirement      | FR-LRN-แบบทดสอบย่อย (LRN)                                   |

### TC-008 สุ่มชุดข้อสอบจาก question bank — ASM (Integration)

| ฟิลด์            | รายละเอียด                                                |
| ---------------- | ------------------------------------------------------------ |
| เงื่อนไขเบื้องต้น | หลักสูตรมีข้อสอบในธนาคารข้อสอบมากพอ; กติกาสอบเป็น config      |
| ขั้นตอน          | 1) เริ่มสอบ 2 ครั้ง (ผู้เข้าสอบคนละคน) 3) เทียบชุดข้อสอบ       |
| ผลคาดหวัง        | จำนวนข้อ/คะแนนตรงตาม config; ลำดับ/คำเลือกสุ่ม; ผู้เข้าสอบเห็นเฉพาะชุดตัวเอง; ข้อสอบไม่รั่วผ่าน API ก่อนเริ่ม |
| Requirement      | FR-ASM-ชุดข้อสอบแบบสุ่ม (ASM)                                 |

### TC-009 สอบเกินเวลาที่กำหนด — ASM (E2E)

| ฟิลด์            | รายละเอียด                                             |
| ---------------- | ---------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | ผู้ใช้กำลังสอบ; เวลาสอบเป็น config (เช่น 60 นาที)           |
| ขั้นตอน          | 1) ทิ้งจนหมดเวลา 2) พยายามส่งคำตอบหลังหมดเวลา 3) ตรวจผล    |
| ผลคาดหวัง        | ระบบปิดการสอบ/ส่งอัตโนมัติตามกติกา (server-side enforcement ไม่ใช่เฉพาะ client timer); ผลถูกกำหนดตามนโยบาย; มี audit |
| Requirement      | FR-ASM-กติกาสอบเวลา (ASM + AUD)                             |

### TC-010 สอบเกินจำนวนครั้งที่อนุญาต — ASM (Integration)

| ฟิลด์            | รายละเอียด                                                       |
| ---------------- | ------------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | จำนวนครั้ง default 3 (รอยืนยัน Q2); ผู้ใช้ใช้ครบแล้ว                |
| ขั้นตอน          | 1) เรียกเริ่มสอบครั้งที่ 4 (ผ่าน API ตรง ๆ) 2) ปรับ config เป็น 5 แล้วลองใหม่ |
| ผลคาดหวัง        | ปฏิเสธครั้งที่ 4; เมื่อ config = 5 อนุญาต (พิสูจน์ config-driven); นับครั้งถูกต้องแม้สอบค้างกลางคัน |
| Requirement      | FR-ASM-จำนวนครั้ง (ASM)                                              |

### TC-011 ออกประกาศนียบัตรหลังสอบผ่าน — CRT (E2E)

| ฟิลด์            | รายละเอียด                                                     |
| ---------------- | ----------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | ผู้ใช้สอบผ่านเกณฑ์ (default ≥ 70% — รอยืนยัน Q2); registrar พร้อม |
| ขั้นตอน          | 1) registrar ออกประกาศนียบัตร 2) ตรวจ PDF/หน้าเว็บ 3) ตรวจกรหัสอ้างอิง + QR |
| ผลคาดหวัง        | ประกาศนียบัตรมีข้อมูลถูกต้อง (ชื่อ หลักสูตร วันที่ รหัส); ออกซ้ำไม่ได้ (idempotent); มี audit |
| Requirement      | FR-CRT-ออกประกาศนียบัตร (CRT + AUD)                                 |

### TC-012 ยืนยันประกาศนียบัตรรหัสปลอม/ไม่มีจริง — CRT (Integration/Security)

| ฟิลด์            | รายละเอียด                                                  |
| ---------------- | -------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | มี certificate จริง 1 รายการ                                    |
| ขั้นตอน          | 1) verify ด้วยรหัสจริง 2) verify รหัสไม่มีจริง 3) ยิง verify ซ้ำเร็ว ๆ 1,000 ครั้ง |
| ผลคาดหวัง        | จริง → แสดงข้อมูลที่จำเป็นโดยไม่เปิด PII เกินจำเป็น (brief §8); ไม่มีจริง → ไม่พบ; รัวได้ถูก rate limit (ตาม R-26) |
| Requirement      | FR-CRT-verify สาธารณะ (CRT)                                      |

### TC-013 บันทึก credit จากผลสอบผ่าน — CRB (Integration)

| ฟิลด์            | รายละเอียด                                                       |
| ---------------- | ------------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | กฎ credit กำหนดว่าหลักสูตรนี้ให้ 3 credit (config); ทนาย verified อยู่ในรอบต่ออายุปัจจุบัน |
| ขั้นตอน          | 1) สอบผ่าน 2) ตรวจ credit ledger 3) ตรวจยอดสรุปตามรอบต่ออายุ 4) ผ่านซ้ำหลักสูตรเดิม |
| ผลคาดหวัง        | ledger เพิ่ม 1 รายการ +3 credit พร้อมอ้างอิงผลสอบ; ยอดรวมต่อรอบถูกต้อง; ผ่านซ้ำไม่เพิ่ม credit ซ้ำ (idempotent) |
| Requirement      | FR-CRB-กฎการได้ credit + FR-CRB-สรุปยอด (CRB)                          |

### TC-014 แก้/ลบแถว credit ledger ต้องถูกปฏิเสธ — CRB/AUD (Integration/Security)

| ฟิลด์            | รายละเอียด                                            |
| ---------------- | -------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | มีรายการ ledger; ทดสอบในสิทธิ์ authenticated และ service_role |
| ขั้นตอน          | 1) UPDATE แถว ledger 2) DELETE แถว ledger 3) เรียก API ที่พยายามแก้ |
| ผลคาดหวัง        | ทุกช่องทาง fail ด้วย DB privileges/RLS; ไม่มี API แก้/ลบ ledger และ audit เลย (D6); มีการบันทึกความพยายาม |
| Requirement      | FR-CRB-ledger append-only + FR-AUD-append-only (CRB + AUD)  |

### TC-015 แจ้งเตือนเมื่อได้ประกาศนียบัตร — NTF (Integration)

| ฟิลด์            | รายละเอียด                                        |
| ---------------- | ---------------------------------------------------- |
| เงื่อนไขเบื้องต้น | ผู้ใช้เปิดรับแจ้งเตือน; SMTP/provider ทดสอบพร้อม     |
| ขั้นตอน          | 1) registrar ออกประกาศนียบัตร 2) ตรวจกล่องแจ้งเตือนในระบบ + อีเมล |
| ผลคาดหวัง        | แจ้งเตือนในระบบทันที; อีเมลใช้เทมเพลตภาษาไทยถูกฉบับ; ผู้ปิดรับไม่ได้รับ; ไม่ log อีเมลเต็มใน log ระบบ |
| Requirement      | FR-NTF-แจ้งเตือนในระบบ+อีเมล (NTF)                     |

### TC-016 staff:viewer สร้างหลักสูตรไม่ได้ — ADM/RBAC (Integration/Security)

| ฟิลด์            | รายละเอียด                                              |
| ---------------- | ---------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | บัญชี staff:viewer; บัญชี staff:content                     |
| ขั้นตอน          | 1) viewer เรียก API สร้างหลักสูตร 2) content เรียกเดียวกัน     |
| ผลคาดหวัง        | viewer ถูกปฏิเสธ 4xx (RBAC + RLS สองชั้น); content ทำได้; audit บันทึกทั้งสำเร็จ/ถูกปฏิเสธกรณีสำคัญ |
| Requirement      | FR-ADM-RBAC sub-role (ADM + AUTH)                            |

### TC-017 Audit log ครบ action สำคัญ — AUD (Integration/E2E)

| ฟิลด์            | รายละเอียด                                                  |
| ---------------- | -------------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | รันชุด action: ล็อกอิน admin, อนุมัติเนื้อหา, ออกประกาศนียบัตร    |
| ขั้นตอน          | 1) ทำ action ทั้งหมด 2) ตรวจ audit log 3) พยายาม UPDATE/DELETE audit |
| ผลคาดหวัง        | ทุก action มี record (actor, action, object, เวลา); แก้/ลบไม่ได้; ไม่มี PII เกินจำเป็นใน log |
| Requirement      | FR-AUD-บันทึกการกระทำสำคัญ (AUD)                                 |

### TC-018 ผู้ใช้ A ดึง progress ของผู้ใช้ B — RLS (Integration/Security)

| ฟิลด์            | รายละเอียด                                            |
| ---------------- | -------------------------------------------------------- |
| เงื่อนไขเบื้องต้น | ผู้ใช้ A, B ลงทะเบียนหลักสูตรเดียวกัน                       |
| ขั้นตอน          | 1) A เรียก API progress โดยส่ง user_id ของ B 2) เรียกตรงผ่าน DB role anon |
| ผลคาดหวัง        | API ปฏิเสธ/ไม่คืนข้อมูล; RLS กันข้ามผู้ใช้ทุกตารางที่เก็บข้อมูลส่วนบุคคล (ตาม R-25) |
| Requirement      | ครอบทุกโดเมน (RLS ทุกตาราง — brief §6)                     |

## 7. Defect Management และ Severity

**กระบวนการ:** พบ defect → เปิด issue (GitHub Issues) ผูก TC/FR + ระดับ + รูป/screenshot/log → triage โดย lead (มอบหมาย owner) → แก้ → ผู้แจ้ง verify กับเคสเดิม → ปิดพร้อม evidence → สรุปเป็นรายงานใน `docs/07-results/SYSTEM-TEST.md`

| Severity | นิยาม                                                                  | ตัวอย่าง                                      | SLA แก้            |
| -------- | ------------------------------------------------------------------------ | ----------------------------------------------- | ------------------- |
| Critical | ระบบล่ม/ใช้งาน flow หลักไม่ได้/ข้อมูลเสียหาย/รั่ว PII/ความปลอดภัยถูกทะลุ | สอบแล้วผลหาย, ledger ผิด, RLS บายพาส           | ทันที — บล็อก merge/deploy |
| High     | ฟีเจอร์หลักผิดพลาดแต่มีทางผ่านชั่วคราว / ผิดกฎหมาย-นโยบาย                 | คำนวณเกณฑ์ผ่านผิด, อีเมลไม่ส่งทั้งกลุ่ม         | ภายใน wave เดียวกัน  |
| Medium   | ฟีเจอร์รอง/UX ผิดปกติ กระทบบางกรณี                                       | แสดงผล progress ช้า, ข้อความไทยสะกดผิด        | ภายใน 2 wave        |
| Low      | ข้อสังเกต/ความสวยงาม/เอกสาร                                            | จัดหน้าเพี้ยนเบา ๆ                            | ตามโอกาส            |

กฎเพิ่มเติม: defect ซ้ำ (regression) ผูก issue เดิม + ทบทวนว่าเคสทดสอบครอบจุดนั้นหรือยัง; ห้ามปิด issue โดยไม่มี evidence การ verify

## 8. เกณฑ์ผ่านและ Coverage Targets

| ด้าน                | เกณฑ์ผ่าน (Wave F / M5)                                            |
| ------------------- | -------------------------------------------------------------------- |
| Unit                | coverage ≥ 80% ของ business logic (lines + branches); 0 fail          |
| Integration         | 100% endpoint มี happy + denial; 100% ตารางมีเคส RLS; 0 fail         |
| E2E                 | 16/16 scenarios ผ่าน (ทั้ง 3 browsers); flaky rate < 2%               |
| Security            | ZAP + ASVS L2: 0 Critical/High ค้าง; secrets scan สะอาด; dependency 0 Critical |
| Performance         | ผ่านทั้ง 3 profile (10k เรียน / 5k สอบ / spike) + soak 1 ชม.          |
| UAT                 | ≥ 95% ขั้นตอนผ่าน; Critical flow 100%; sign-off ครบ                   |
| Regression          | ทุก PR เข้า develop ผ่าน merge gate ครบ 5 ด่าน + codex gate (โค้ด auth/security/data) |

## 9. ความเสี่ยงด้านการทดสอบ

| ID  | ความเสี่ยง                                                            | ผลกระทบ                                    | แผนรับมือ                                                                       |
| --- | ------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| T-1 | staging (brief 0.2.0 §6) ยังไม่พร้อม หรืองบ cloud tier สำหรับ load test ยังไม่อนุมัติ (Q7 ค้าง) | เกณฑ์ performance 10k/5k พิสูจน์ไม่ได้ก่อน M3/M5 | ขอคำตอบ Q7 ก่อนสิ้น Wave C; ตั้ง staging ให้พร้อมต้น Wave D; ระหว่างรอใช้ shrink profile บน local Docker |
| T-2 | การทดสอบ UAT ขึ้นกับความพร้อมเจ้าหน้าที่สภาฯ (QP-2)                          | M5 เลื่อน                                       | เตรียม script + บัญชีทดสอบล่วงหน้า; นัดล่วง 2 สัปดาห์                             |
| T-3 | E2E บน flow สอบ (timer/สุ่มข้อสอบ) เปราะบางเป็น flaky                       | เสียเวลาดูแล มั่นใจผลต่ำ                        | คุม timer ผ่าน inject clock/config ในโหมดทดสอบ; retry policy + แยกชุด nightly      |
| T-4 | ข้อมูลทดสอบไม่เหมือนของจริง (ปริมาณผู้ใช้/หลักสูตรน้อย)                       | พฤติกรรมต่างจาก production                     | seed script สร้างชุดข้อมูลใหญ่ (10k+ ผู้ใช้) + ใช้ profile ข้อมูลจากสถิติจริงเมื่อมี |
| T-5 | Q1–Q6 ยังไม่ยืนยัน ทำให้เคส config-driven ต้องเขียนใหม่ตามคำตอบ              | rework ชุดเคสทดสอบ (ผูก R-18)                  | เขียนเคสอิงพารามิเตอร์ + default ตั้งแต่ต้น; เมื่อได้คำตอบปรับเฉพาะค่าทดสอบ ไม่ใช่โครงเคส |
| T-6 | coverage ตัวเลขสูงแต่ไม่ครอบจุดเสี่ยงจริง (false confidence)                | พบ defect ช้าใน Wave F                        | รีวิวความครอบคลุมคู่กับ RTM + จุดเสี่ยงจาก RISK-REGISTER ทุก milestone            |
