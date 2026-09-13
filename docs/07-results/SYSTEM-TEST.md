# System Test Result — LTC E-Learning (Wave F Phase 2 · D17)

|          |                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| เวอร์ชัน | 1.0.0 — ฉบับแรก: ผลลัพธ์ชุดทดสอบระบบครบทุกชุด (battery 1.2.0 หลังปิด gate r1+r2 · **gate r3 = PASS 0B/0M/0m** ที่ `96f99c0`) + ตาราง coverage RTM must-have ↔ ชุดเทสที่พิสูจน์ด้วยเลขจริง + วิธี rerun ทุกชุด + known limitations ตาม D-f-7 |
| วันที่    | 2026-09-13                                                                                                                    |
| อ้างอิง  | RTM.md 1.1.0 (83 FR + PERF 8 + SEC 16 + NFR อื่น 27) · VA-PENTEST.md 1.2.0 · SECURITY-REMEDIATION.md 1.1.0 · `.omc/artifacts/battery-phase0-r2/` · `.omc/plans/wave-f-plan.md` (D-f-7 · D-f-8 · D-f-13) |
| ขอบเขต  | ผลการทดสอบระบบบน **local Docker dev stack** (Next.js BFF :3000 · Supabase/Kong :8000 — Mailpit/สื่อจริง) ตามลำดับ battery เดียว วันที่ 2026-09-13 · สิ่งที่เอกสารนี้ไม่ครอบคลุม: load test ระดับ production (PERF → PROD-CHECKLIST D-f-13) และ UAT โดยมนุษย์ (D18 = Phase 3) |

---

## 1. สรุปผู้บริหาร

- **ทุกชุดทดสอบที่รันผ่านครบในลำดับเดียว** (battery 1.2.0 · บน tree ที่ fix batch ทั้งหมดถูก commit — anchor G5): unit **170 ไฟล์ / 2,363 เทส** · tsc **0 error** · eslint **0 problems** · build **RC=0** (66/66 หน้า · static เหลือเฉพาะ `/_not-found`) · integration **20 ไฟล์ / 173 เทส** (fresh replay · 125.19 วิ) · health **200** · e2e **34/34** (33 first-attempt + 1 ผ่าน retry · 11.1 นาที · `E2E-EXIT=0`) — ตารางเต็ม §2
- **CTO gate (codex) ปิดครบสามรอบ** บนโค้ดชุดเดียวกับตัวเลขนี้: r1 FAIL(F1-F10) → แก้ครบ → r2 FAIL(G1-G5) → แก้ครบ → **r3 PASS 0 BLOCKER/0 MAJOR/0 MINOR** (คำวินิจฉัย `.omc/artifacts/gate-f-p0-r3-output.md` · ทบทวนที่ `96f99c0`)
- **Coverage ตาม RTM must-have: 83 FR นำไปพิสูจน์ได้จริง 78/83** (ผ่าน 74 · ผ่านบางส่วน 4) — อีก 5 รายการคือสิ่งที่ **ไม่มีใน as-built v1** (AUTH-004/005/010 · ASM-012(S) · LRN-009) จดเป็นหนี้ทะเบียนพร้อมเหตุผลที่ §5 — **ไม่มีแถวใดถูกอ้างว่า "ผ่าน" โดยไม่มีหลักฐาน**
- **PERF 8 รายการ = ยังไม่พิสูจน์ใน wave นี้โดยตั้งใจ** — เป้าหมายระดับ production (100k ผู้ใช้ · p95 ≤ 500ms · LCP ≤ 2.5s) วัดไม่ได้บน dev stack เครื่องเดียว · ส่งต่อเป็นเงื่อนไข PROD-CHECKLIST (D-f-13) — §5.2
- **SEC 16 รายการ** พิสูจน์ด้วยชุด security ของ battery + VA-PENTEST (D19) — แถวที่เหลือเป็น "บางส่วน" มีเหตุผลผูกกับ prod เสมอ (TLS/WAF จริง)

## 2. ผลชุดทดสอบทั้งหมด (battery 1.2.0 · 2026-09-13 · ลำดับเดียว)

ทุกตัวเลขคัดจาก artifact จริงใน `.omc/artifacts/battery-phase0-r2/` — ต้นทาง verbatim ของ integration/e2e คือ task output ของลำดับเดียวกัน (run.log บันทึก provenance + commit/tree hash)

| # | ชุด | ผล | ไฟล์หลักฐาน |
| --- | --- | --- | --- |
| 1 | unit (vitest) | **170 ไฟล์ / 2,363 เทส ALL PASS** · `UNIT_RC=0` · 6.17s | `unit.txt` |
| 2 | tsc --noEmit (isolated) | **0 error** · `TSC_RC=0` | `tsc.txt` (ว่าง) |
| 3 | eslint | **0 problems** · `ESLINT_RC=0` | `eslint.txt` (ว่าง) |
| 4 | next build (**บน host เท่านั้น** — ห้าม build ในคอนเทนเนอร์ที่ dev ถือ `next_cache`) | **BUILD_RC=0** · 66/66 หน้า · prerender เหลือ `["/_not-found"]` | `build.txt` |
| 5 | integration (fresh replay — ยกเลิก seed เดิม replay migration+seed ใหม่) | **20 ไฟล์ / 173 เทส ALL PASS** · 125.19 วิ · `INTEGRATION-EXIT=0` | `integration.txt` |
| 6 | health wait | `health=200` ก่อนปล่อย e2e เสมอ | `run.log` |
| 7 | e2e (Playwright · 1 worker · retries:1) | **34/34 เขียว** — 33 first-attempt + 1 flaky ผ่าน retry (e2e-15 ฟอร์มใบอนุญาต · timing ของ dev stack — §5.1) · 11.1 นาที · `E2E-EXIT=0` | `e2e.txt` |
| 8 | gitleaks staged (ทุก commit ของ fix batch) | **0 leaks** | `gitleaks-wf-r2fix*-staged.json` = `[]` |
| 9 | probe CSP บน production server (`next start` :3001) | ทุกหน้า 200 + nonce หมุนทุก request (ปิด G2) | `probe-g2-csp.txt` |
| 10 | ZAP baseline passive scan (D-f-10 · หลังปิด gate r3 — ผิวสาธารณะ 10 URL) | **0 High** · 3 Medium/7 Low/3 Info — triage ครบ: ทุก Medium = สิ่งที่รู้อยู่แล้ว (dev-only/design decision) · รายการใหม่เดียว COOP/COEP/CORP → PROD-CHECKLIST | `zap/zap-baseline-2026-09-13.{json,md}` (VA-PENTEST §3.5) |

### 2.1 องค์ประกอบชุด unit (170 ไฟล์ / 2,363 เทส)

| กลุ่ม | จำนวนไฟล์ | ตัวอย่างไฟล์หลัก |
| --- | --- | --- |
| `src/app/**` (route handlers + pages/actions) | 72 | `/me/transcript/route.test.ts` (14 — json/csv/pdf) · admin reports ×4 · question-banks ×2 · users ×3 |
| `src/lib/**` (business logic) | 63 | `auth/mfa.test.ts` (รวม pin G1/G3) · `schemas/v1/*.test.ts` · `certificates/{issue,revoke,reissue,bulk,pdf,list,shared}.test.ts` · `rbac.test.ts` · `middleware.test.ts` (CSP nonce) |
| `src/components/**` | 32 | admin surfaces + learner components |
| ราก `src/*` | 3 | — |

### 2.2 องค์ประกอบชุด integration (20 ไฟล์ / 173 เทส — นับต่อไฟล์จาก artifact r2 + r1)

| ไฟล์ | เทส | ครอบ (โดเมน RTM) |
| --- | --- | --- |
| d8-exam-cert-flow | 31 | ASM · CRT (สอบ→ตรวจ→ใบประกาศ ครบสาย) |
| dcr8-bulk-auto-cert | 18 | CRT-002/007/008 (ราย/ชุด/ออกใหม่/auto ปิด) |
| dcr10-notifications | 15 | NTF ทั้งกลุ่ม + renewal + backoff |
| dcr9-credit | 13 | CRB-001..005/007 (กฎ/ledger/รอบ/ยอด/ปรับ) |
| dcr4-views-and-policy | 10 | SEC-002 (RLS views/policies) |
| dcr12-p5r1-hardening | 8 | IDENT-008 (export/ลบบัญชี) · REL (lease reclaim) · SoD |
| dcr11-identity | 8 | IDENT-002/003/004 (ยื่น/ตัดสิน/บทบาท TX เดียว) |
| dcr14-mfa | 7 | AUTH-007/SEC-008 (MFA+โค้ดสำรอง+stash G1/G3/G4 — รวม f1 re-host end-to-end, f2 กรอบ/fail-closed/lock) |
| dcr15-email-change | 7 | IDENT-001 (เปลี่ยนอีเมลสองลิงก์) |
| dcr7-cert-list-views | 7 | CRT (มุมมองรายการ/สถานะ) |
| dcr9-audit-allowlist | 7 | AUD-001..003 (append-only + allowlist) |
| lesson-parent-softdelete | 7 | CAT-006 (โครงสร้าง+soft delete) |
| dcr13-admin-users | 6 | ADM-002/IDENT-006 (ค้นหา/ปิด-เปิด/บทบาท) |
| repeated-or-cursor | 5 | pagination (NTF-01/LRN-02 มุม cursor) |
| tc005-guest-catalog | 5 | CAT-002/003/007 (guest catalog/ค้นหา/audience) |
| dcr3-enroll-idempotent | 4 | LRN-001/010 (idempotent+เงื่อนไขเข้าเรียน) |
| my_active_enrollments | 3 | LRN-002 |
| v_enrollment_progress_softdelete | 3 | LRN-007 (คืบหน้ารวม+soft delete) |
| dcr11-pdpa | 7 | IDENT-008/SEC-011 (export/ลบ/consent) |
| dcr11-admin | 2 | SEC-013 (audit การกระทำเจ้าหน้าที่ 0038) |

(ผลรวม 173 — dcr14 จาก 5 → 7 ด้วยเคส f1/f2 ของ gate r2 · ตัวเลข r1 รวม 171 เก็บไว้เทียบที่ `battery-phase0/integration.txt`)

### 2.3 องค์ประกอบชุด e2e (14 สเปก / 34 เทส — จำนวน test() ต่อสเปกยืนยันกับ "Total: 34 tests in 14 files" ของรอบจริง)

| สเปก | เทส | ครอบ (TC หลัก) |
| --- | --- | --- |
| e2e-16-admin-surfaces | 7 | ADM-001..006 · IDENT-006 · AUD-003 (SoD 403 · มอบ/ถอนบทบาท) |
| e2e-15-license-flow | 4 | IDENT-002/005 (ยื่นใบอนุญาตผ่าน browser — เคส flaky เดียวของรอบ §5.1) |
| e2e-04-catalog-enroll | 3 | CAT-002/004 · LRN-001 (enroll idempotent t3) |
| e2e-05-learn-progress | 3 | LRN-003/004/006 (วิดีโอ heartbeat จริง · document attestation) |
| e2e-06-quiz-until-pass | 1 | LRN-005 (quiz ซ้ำได้+เฉลย) |
| e2e-07-exam-rules-eligibility | 2 | ASM-013 (+LRN-008 ประตูเข้าสอบ) |
| e2e-08-exam-pass | 1 | ASM-005/007/010 · CRT-001 |
| e2e-09-exam-retake | 3 | ASM-006 (ครั้งที่ 3 = ERR-ASM-001 · cooldown) |
| e2e-10-registrar-issues-certificate | 1 | CRT-002/005 (ออกใบ+ดาวน์โหลด PDF) |
| e2e-11-public-verify | 3 | CRT-004/SEC-009 (verify สาธารณะ ไม่ leak PII) |
| e2e-12-instructor-admin-shell | 2 | ADM/นโยบาย admin shell (ADR-VA-01 tripwire) |
| e2e-13-credit-after-pass | 2 | CRB-003/005 (credit อัตโนมัติ+ยอด) |
| e2e-14-notifications | 2 | NTF-001/005 (inbox+ตั้งค่า) |
| logout-flow | 1 | AUTH-002 (logout revoke จริง) |

### 2.4 วิธี rerun ทุกชุด (ลำดับบังคับ — ห้ามสลับ)

> กฎ: **ห้ามรัน integration กับ e2e พร้อมกัน** (fresh replay ของ integration เช็ด dev DB กลางคัน) · build บน host เท่านั้น · dev stack ต้อง `health=200` ก่อน e2e

```bash
# 0) dev stack พร้อม
docker compose -f docker/supabase/docker-compose.yml up -d   # + ltc-dev-app (:3000)
curl -sf localhost:3000/api/health >/dev/null && echo health=200

# 1-4) unit → tsc → eslint → build (host)
npm test                                                        # UNIT_RC=0 · 170/2,363
npx tsc --noEmit                                                # TSC_RC=0
npm run lint                                                    # ESLINT_RC=0
npm run build                                                   # BUILD_RC=0 · static=/_not-found

# 5) integration แบบ fresh replay (เช็ด DB → migrations+seed ใหม่ → รัน)
bash scripts/integration-fresh-replay.sh 2>&1 | tee /tmp/integration.log
curl -sf localhost:3000/api/health >/dev/null && echo health=200   # รอกลับมาก่อน

# 6) e2e รอบเต็ม (1 worker · retries:1 — ใช้ dev server ที่รันอยู่)
E2E_NO_SERVER=1 npx playwright test 2>&1 | tee /tmp/e2e.log      # E2E-EXIT=0 · 34/34
```

สคริปต์ต้นฉบับของรอบจริง: `.omc/artifacts/battery-phase0.sh` (สคริปต์ battery เดิมของ Phase 0) — รอบ r2 รันคำสั่งชุดเดียวกันนี้เป็นลำดับเดียว ผลอยู่ที่ `battery-phase0-r2/`

---

## 3. Coverage ตาม RTM must-have ↔ ชุดเทสที่พิสูจน์

สถานะ: **ผ่าน** (มีหลักฐานตามระดับที่ RTM กำหนด) · **ผ่านบางส่วน** (มีข้อจำกัดที่ระบุ) · **ไม่มีใน as-built v1** (หนี้ทะเบียน §5) — ทุกแถวอ้างไฟล์/ชุดที่รันจริงใน battery 1.2.0 หรือหน้า VA-PENTEST (D19) · TC ID ตาม RTM §1-§2

### AUTH (11)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| AUTH-001 สมัคร+ยืนยันอีเมล | ผ่าน | unit `src/app/(auth)/signup-consents.test.ts` · e2e ทุกสเปกสร้างบัญชีผ่าน register จริง (d9-helpers) · dcr12 เคส f (audit USER_CREATED) |
| AUTH-002 เข้า/ออกจากระบบ | ผ่าน | `logout-flow.spec.ts` (revoke จริงก่อนลบ cookie) · dcr14 เคส c (login สองขั้น) · ทุก e2e ล็อกอินผ่าน UI |
| AUTH-003 OTP มือถือ (S) | **ปิดตามนโยบาย D-f-8** | ไม่มีเส้นทาง OTP ใน as-built — ผลลัพธ์ Wave F = ย่อหน้า prod-checklist เท่านั้น (VA-PENTEST §1.2 ข้อ 3) |
| AUTH-004 ลืม/รีเซ็ตรหัสผ่าน | **ไม่มีใน as-built v1** | ไม่พบ route/UI (grep ทั้ง repo) — ความสามารถอยู่ที่ GoTrue แต่ BFF/หน้าจอยังไม่สร้าง — หนี้ §5.3 |
| AUTH-005 เปลี่ยนรหัสผ่าน | **ไม่มีใน as-built v1** | เช่นเดียวกัน — หนี้ §5.3 |
| AUTH-006 นโยบายรหัสผ่าน | ผ่าน | `GOTRUE_PASSWORD_MIN_LENGTH=12` (compose · ไม่มี override อ่อนกว่า — ตรวจจริงใน VA-PENTEST V2.1.1) |
| AUTH-007 MFA บังคับ staff | ผ่าน | dcr14 (7 เทส: enroll/verify/โค้ดสำรอง/lockout/stash G1-G4) · unit `auth/mfa.test.ts` · e2e ทุกสเปก staff ผ่าน MFA จริง |
| AUTH-008 session timeout+rotation | ผ่าน | unit `middleware.test.ts` (หมุน refresh ล่วงหน้า LEAD 180 วิ) · `session.auth.test.ts` (fail-closed) · VA-PENTEST V3 |
| AUTH-009 account lockout | ผ่านบางส่วน | ชดเชย 3 ชั้น (GoTrue rate limit + BFF AUTH 10/นาที + lockout โค้ดสำรอง 5 ผิด/15 นาที 0045) — ERR-AUTH-003 เป็นหนี้ทะเบียน (SECURITY-REMEDIATION §6) |
| AUTH-010 ออกจากระบบทุกอุปกรณ์ | **ไม่มีใน as-built v1** | มีแค่ `/auth/logout` เครื่องเดียว — หนี้ §5.3 |
| AUTH-011 rate limit ปลายทาง auth | ผ่านบางส่วน | unit `rate-limit.test.ts` (10 กลุ่ม canonical) · dev = in-memory · prod WAF/Cloudflare = PROD-CHECKLIST (D-f-13) |

### IDENT (8)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| IDENT-001 ดู/แก้โปรไฟล์ | ผ่าน | unit `/me` route · dcr15 (7) · e2e-14/15 ผ่าน `/my/*` จริง |
| IDENT-002 ยื่นผูกใบอนุญาต | ผ่าน | dcr11-identity (8) · e2e-15 ฟอร์ม+อัปโหลดผ่าน browser |
| IDENT-003 พิจารณาอนุมัติ/ปฏิเสธ | ผ่าน | dcr11-identity เคส c/d/e (TX เดียว · เลขซ้ำ rollback) · e2e-10 |
| IDENT-004 อนุมัติแล้ว+บทบาท lawyer | ผ่าน | dcr11-identity เคส c (roleGranted · ซ้ำไม่ซ้ำ ROLE_GRANT) |
| IDENT-005 สถานะ+ยื่นซ้ำ | ผ่าน | e2e-15 (canResubmit) · unit `/me/license` |
| IDENT-006 super_admin แต่งตั้ง/ถอด | ผ่าน | dcr13 (6) · e2e-16 (มอบ/ถอด DELETE + body → 204 + audit · SoD 403) |
| IDENT-007 หลายบทบาท union | ผ่าน | unit `rbac.test.ts` · `fixtures/admin.test.ts` · dcr4 (RLS มุมบทบาท) |
| IDENT-008 PDPA export/ลบ/consent | ผ่าน | dcr11-pdpa (7) + dcr12 (export สายจริงถึง Mailpit · delete confirm สาธารณะ) · SEC มุม VA-PENTEST V8 · UAT = D18 |

### CAT (7)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| CAT-001 CRUD หมวด | ผ่าน | unit `/admin/categories` route · audit ครบ (AUD-001 มุมเดียวกัน) |
| CAT-002 รายการหลักสูตร (guest) | ผ่าน | tc005 (5) · e2e-04 |
| CAT-003 ค้นหา+กรอง | ผ่านบางส่วน | tc005 (ค้นหา/กรองถูกต้อง) — เกณฑ์เวลา p95 ≤ 2s วัดที่ prod (PERF-007 → §5.2) |
| CAT-004 หน้ารายละเอียด | ผ่าน | e2e-04 |
| CAT-005 วงจร draft→published→archived | ผ่าน | unit `/admin/courses` ×2 · dcr4 (policy ตามสถานะ) · e2e-16 |
| CAT-006 โครงสร้างโมดูล/บทเรียน | ผ่าน | lesson-parent-softdelete (7) · unit `schemas/v1/catalog.test.ts` |
| CAT-007 audience สาธารณะ/ทนาย | ผ่าน | tc005 (ประตู audience) · dcr3 (ปฏิเสธผิดกลุ่ม) |

### LRN (10)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| LRN-001 ลงทะเบียน idempotent | ผ่าน | dcr3 (4 — ซ้ำได้ผลเดิม) · e2e-04 t3 |
| LRN-002 หลักสูตรของฉัน+% คืบหน้า | ผ่าน | my_active_enrollments (3) · repeated-or-cursor (5) · e2e-04 |
| LRN-003 วิดีโอ signed URL+จับเวลา | ผ่าน | e2e-05 (heartbeat จริงจน watch_pct ≥ 80% · 7.4 นาที) · DCR-12 เคส g (signed URL ตาย/ใช้ซ้ำ — integration) |
| LRN-004 เอกสาร PDF viewer | ผ่าน | e2e-05/07 (attestation "อ่านจบแล้ว" → ป้ายเรียนจบ — regression จับได้และแก้แล้ว SECURITY-REMEDIATION §3) |
| LRN-005 quiz ย่อย+เฉลย+ซ้ำ | ผ่าน | e2e-06 (quiz จนผ่าน) · unit `/lessons/[id]/quiz` routes |
| LRN-006 progress server ตัดสิน | ผ่าน | d8 (RPC record_lesson_progress) · e2e-05 |
| LRN-007 คืบหน้ารวมหลักสูตร | ผ่าน | v_enrollment_progress_softdelete (3) · unit `schemas/v1/progress.test.ts` |
| LRN-008 เงื่อนไขผ่านบทเรียน (config) | ผ่าน | unit progress engine · d8 (เงื่อนไข watch_pct/attestation) |
| LRN-009 resume ตำแหน่งล่าสุด | **ไม่มีใน as-built v1** | ไม่พบ endpoint/ฟิลด์ตำแหน่งล่าสุดแยก (grep) — ผู้เรียนกลับเข้าหน้าบทเรียนเดิมได้ แต่ไม่มี "ต่อจุดที่ค้าง" เฉพาะสื่อ — หนี้ §5.3 |
| LRN-010 เงื่อนไขเข้าเรียนเพิ่ม (S) | ผ่าน | dcr3 (ประตู prerequisite/สถานะ) · tc005 |

### ASM (14)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| ASM-001 question bank CRUD+soft delete | ผ่าน | unit `/admin/question-banks` ×2 · d8 · e2e-16 |
| ASM-002 จัดกลุ่ม/tag+ล็อกข้อที่ใช้แล้ว | ผ่าน | unit `exam-admin.{server,client,view}.test.ts` (version lock — gate r5 K2) · d8 |
| ASM-003 ชุดข้อสอบ config+อนุมัติ | ผ่าน | unit exam-admin + d8 |
| ASM-004 สุ่มข้อ+สลับตัวเลือก | ผ่าน | d8 (start attempt จริง) · unit |
| ASM-005 เวลาสอบ+submit อัตโนมัติ server | ผ่าน | d8 (deadline บังคับที่ RPC) · e2e-08 |
| ASM-006 จำกัดครั้ง+cooldown | ผ่าน | d8 · **e2e-09 (3/3 — ครั้งที่ 3 = ERR-ASM-001)** |
| ASM-007 เกณฑ์ผ่าน (config) | ผ่าน | d8 (ตัดสินที่ server) · unit grading ใน submit route tests |
| ASM-008 auto-save+ทน disconnect | ผ่าน | d8 (answers UPSERT idempotent) · unit `/attempts/[id]/answers` |
| ASM-009 ตรวจอัตโนมัติทุกปรนัย | ผ่าน | d8 (ครบทุกประเภท) |
| ASM-010 แสดง+แจ้งผล | ผ่าน | d8 · dcr10 เคส 1/2 (อีเมลผลสอบเทมเพลตไทยถึง Mailpit) · e2e-08 |
| ASM-011 anti-cheat พื้นฐาน (S) | ผ่านบางส่วน | กติกาบังคับจริง (ครั้ง/cooldown/session เดียว — d8/e2e-09) · การโกงเชิงมนุษย์ = ขอบเขต external pentest (VA-PENTEST §5.2 ข้อ 1) |
| ASM-012 ทบทวนข้อสอบหลังสอบ (S) | **ไม่มีใน as-built v1** | ไม่พบ `/attempts/{id}/review` (grep) — (S) เลื่อนตาม SRS — หนี้ §5.3 |
| ASM-013 เงื่อนไขเข้าสอบ | ผ่าน | d8 · e2e-07 (eligibility จริง) |
| ASM-014 ประวัติ+สถิติ | ผ่าน | unit `/me/attempts` · `/admin/exams/statistics` · e2e-08/16 |

### CRT (8)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| CRT-001 ตรวจคุณสมบัติอัตโนมัติ | ผ่าน | d8 · unit `/admin/certificates/eligible` |
| CRT-002 registrar ออกราย/ชุด | ผ่าน | dcr8 (18) · e2e-10 |
| CRT-003 รหัส unique+QR | ผ่าน | unit `certificates/shared.test.ts` (โค้ด unique) · pdf.test.ts (QR) · d8 |
| CRT-004 verify สาธารณะไม่ leak PII | ผ่าน | **e2e-11 (3/3)** · VA-PENTEST V7.4.2 |
| CRT-005 ดาวน์โหลด PDF | ผ่าน | e2e-10 (โหลดผ่าน browser) · unit `certificates/pdf.test.ts` |
| CRT-006 เพิกถอน+ปรับ credit | ผ่าน | unit `certificates/revoke.test.ts` · dcr9-credit (ปรับยอด) · dcr10 เคส 5 (แจ้งเพิกถอน) |
| CRT-007 ออกใหม่แทน (S) | ผ่าน | unit `certificates/reissue.test.ts` · dcr8 |
| CRT-008 โหมดอัตโนมัติ (S, default ปิด) | ผ่าน | dcr8 (auto default ปิด · เปิดแล้วออกครบ) |

### CRB (8)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| CRB-001 กฎ credit CRUD | ผ่าน | unit `/admin/credit-rules` · dcr9-credit |
| CRB-002 ledger append-only (DB) | ผ่าน | dcr9-credit (DB บังคับ) · dcr4 |
| CRB-003 คำนวณอัตโนมัติเมื่อผ่าน | ผ่าน | dcr9-credit · d8 · e2e-13 |
| CRB-004 รอบต่ออายุรายบุคคล (รอ Q1) | ผ่าน | dcr9-credit (cycle engine) · dcr10 เคส 11 (renewal scan จริง) |
| CRB-005 ยอดสะสม/ขาดต่อรอบ | ผ่าน | unit `/me/credits` · dcr9-credit · e2e-13 |
| CRB-006 transcript ออนไลน์+PDF/CSV | ผ่าน | unit `/me/transcript/route.test.ts` (14 — json/csv BOM/pdf Sarabun) |
| CRB-007 เจ้าหน้าที่ปรับ credit | ผ่าน | unit `/admin/credits/adjustments` · dcr9-credit |
| CRB-008 กฎอายุ/ข้ามรอบ (S, รอ Q1) | ผ่านบางส่วน | ฐาน cycle มี+ทดสอบ · กฎอายุข้ามรอบเต็มชุด = รอ Q1 ตาม SRS |

### NTF (6)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| NTF-001 inbox+badge | ผ่าน | dcr10 เคส 10 (cursor+unread) · e2e-14 |
| NTF-002 อีเมลผลสอบเทมเพลตไทย | ผ่าน | dcr10 เคส 1/2 (Mailpit จริง) |
| NTF-003 อีเมลออก/เพิกถอนใบ | ผ่าน | dcr10 เคส 5 |
| NTF-004 ใกล้หมดรอบต่ออายุ (S, รอ Q1) | ผ่าน | dcr10 เคส 11 (7d/30d · ไม่ซ้ำ · citizen=not_lawyer) |
| NTF-005 ตั้งค่ารายประเภท | ผ่าน | dcr10 เคส 4/15 (4 family · ประตูรายช่องทาง) · e2e-14 |
| NTF-006 คิว+retry | ผ่าน | dcr10 เคส 7/8/12 (re-delivery · poison · backoff 5 ครั้ง) |

### ADM (6) และ AUD (5)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| ADM-001 dashboard KPI | ผ่าน | unit `/admin/dashboard` · e2e-16 |
| ADM-002 ค้นหา/ปิด-เปิด/บทบาท | ผ่าน | dcr13 (6) · e2e-16 |
| ADM-003 รายงานเรียน/สอบ/credit | ผ่าน | unit `/admin/reports/*` ×4 · e2e-16 |
| ADM-004 export CSV UTF-8 BOM | ผ่าน | unit `/admin/reports/[type]/export` (BOM) |
| ADM-005 จัดการ/อนุมัติหลักสูตร | ผ่าน | unit `/admin/courses` ×2 · e2e-16 |
| ADM-006 ติดตามการสอบ (S) | ผ่าน | unit `/admin/exams/monitoring` · e2e-16 |
| AUD-001 audit ทุก action สำคัญ | ผ่าน | dcr9-audit-allowlist (7) + audit assertions ในทุก dcr (คู่ mutation) |
| AUD-002 append-only DB บังคับ | ผ่าน | dcr9-audit (ห้าม UPDATE/DELETE — trigger 0010) · e2e d9-helpers ยืนยันพฤติกรรม |
| AUD-003 ค้นหา/กรอง audit | ผ่าน | unit `/admin/audit-logs` · dcr9-audit · e2e-16 |
| AUD-004 ไม่บรรจุ PII | ผ่าน | unit serializer (อีเมล sha256) · CI scan · VA-PENTEST V8.1 |
| AUD-005 retention ตามนโยบาย | ผ่านบางส่วน | purge cron รายวันครอบ 7 ตาราง (0040) + PURGE_EXECUTED audit · **audit_logs (5 ปี)+learning records = v1.1 ตาม DATA-DICTIONARY §4.6 (D-f-4)** |

### PERF (8) — ทั้งกลุ่ม: ยังไม่พิสูจน์ใน wave นี้ (โดยตั้งใจ)

PERF-001..008 เป็นเป้าหมายระดับ production (100,000 ผู้ใช้ · 10,000 session เรียนพร้อมกัน · 5,000 สอบพร้อมกัน · p95/LCP) — **วัดไม่ได้บน dev stack เครื่องเดียว** และไม่มี k6/lighthouse run ใน battery · สถานะทุกแถว = **รอวัดบน staging/prod** ผูกกับ PROD-CHECKLIST (D-f-13): มีเครื่องมือ (k6 ตาม SDS) แต่ต้องรันบน environment ที่ config ตรง prod · สิ่งที่พิสูจน์ได้ใน dev: ประตูทางเดียวของ query ผ่าน RLS views + cursor pagination (repeated-or-cursor) และ health check OPE-002 = 200

### SEC (16) — พิสูจน์ด้วยชุด security + VA-PENTEST (D19)

| Req | สถานะ | หลักฐานหลัก |
| --- | --- | --- |
| SEC-001 ASVS L2 + Top 10 | ผ่าน | VA-PENTEST §2 (checklist 14 บท พร้อม file:line) — self-VA · external pentest = งานจ้าง (§5) |
| SEC-002 RLS ทุกตาราง | ผ่าน | 48 จุด enable ใน migrations · dcr4 (10) · RLS probes anon/authenticated |
| SEC-003 least-privilege DB roles | ผ่าน | service_role เฉพาะ job เจาะจง (VA-PENTEST V1.4.5) |
| SEC-004 audit append-only (security มุม) | ผ่าน | dcr9-audit · hash-chain (VA-PENTEST V7.3.1) |
| SEC-005 rate limit+WAF ทุก env | ผ่านบางส่วน | 10 กลุ่ม canonical (unit) · dev in-memory · **WAF prod = PROD-CHECKLIST** |
| SEC-006 secrets เฉพาะ env | ผ่าน | gitleaks CI Gate 5 (full history) + staged 0 leaks ทุก commit |
| SEC-007 ห้าม log PII | ผ่าน | กฎ harness + CI scan · VA-PENTEST V7.1 |
| SEC-008 admin MFA+timeout+lockout | ผ่าน | dcr14 (7) · 0045 lockout · VA-PENTEST V2/V3 |
| SEC-009 verify ไม่เปิด PII เกินจำเป็น | ผ่าน | e2e-11 (3/3) · VA-PENTEST V7.4.2 |
| SEC-010 PDPA minimal+consent | ผ่านบางส่วน | dcr11-pdpa + consents 0043 · มุม UAT = D18 |
| SEC-011 PDPA สิทธิเจ้าของข้อมูล | ผ่าน | dcr11-pdpa (7) + dcr12 (export/delete สายจริง) |
| SEC-012 data retention policy | ผ่านบางส่วน | 0040 purge 7 ตาราง · audit_logs/learning records = v1.1 (D-f-4) |
| SEC-013 บันทึกการเข้าถึง PII | ผ่าน | dcr11-admin (0038 audit คู่ mutation) |
| SEC-014 zod ทุกขอบขอบเขตรับ | ผ่าน | unit `schemas/v1/*` (strict ทุกชั้น — ผล codex gate wave D) + negative tests ทุก route |
| SEC-015 HTTPS+security headers | ผ่านบางส่วน | CSP nonce หมุนทุก request (unit + probe G2 บน `next start`) · HSTS ทุก env · TLS จริง = prod |
| SEC-016 at-rest/in-transit+signed URL | ผ่านบางส่วน | signed URL 7 วัน (DCR-12 เคส g) · at-rest/TLS = แพลตฟอร์ม prod (PROD-CHECKLIST) |

---

## 4. NFR กลุ่มอื่น (RTM §3) — หลักฐานที่มีในมือ (สรุปย่อ)

| Req | สถานะ | หลักฐาน |
| --- | --- | --- |
| REL-003 เสริมล่อไม่กระทบธุรกรรมหลัก | ผ่าน | dcr10 เคส 8/12 (อีเมลล้ม → ธุรกรรมหลักผ่าน · backoff) |
| REL-004 สอบทน disconnect | ผ่าน | d8 (answers idempotent — ส่งซ้ำได้ผลเดิม) |
| USA-001 ไทยหลักทุกหน้าจอ | ผ่าน | e2e ทุกสเปก assert ข้อความไทยจริง (subject/ป้าย/ข้อผิดพลาด) |
| USA-002 responsive 360–1920 | บางส่วน | e2e รัน 1 project (chromium Desktop Chrome) — **เมทริกซ์ viewport เต็มยังไม่รัน** (§5.2) |
| USA-004 error ไทย+วิธีแก้ | ผ่าน | ทะเบียน ERR-* fixed copy ไทย (unit errors.test.ts) · e2e เห็นจริงทุก negative path |
| I18N-003 ฟอร์แมตวันที่ พ.ศ. | ผ่าน | dcr10 เคส 11 (วัน DD/MM/พ.ศ. ในอีเมล renewal — assert จริง) |
| MAINT-001 TS strict+lint | ผ่าน | battery: tsc 0 · eslint 0 ทุกรอบ (CI gate) |
| MAINT-003 schema ผ่าน migration เท่านั้น | ผ่าน | fresh replay รัน migrations 0040-0046 ได้ทุกรอบ (integration 20/173) |
| MAINT-005 dependency scan | ผ่าน (ตัดสินแล้ว) | npm audit 4 findings = accept-with-expiry ตาม D29 (register ที่ SECURITY-REMEDIATION §4) |
| MAINT-006 merge gates | ผ่าน | ทุก commit ผ่าน gitleaks staged · codex gate 3 รอบ (r1/r2/r3) กลุ่ม auth/security/data |
| OPE-002 /api/health | ผ่าน | health=200 ทุกรอบ battery (บังคับในลำดับ) |
| OPE-001 structured log+correlation | บางส่วน | มีโครงสรร (request_id v4 — gate r3 H4 wave D) · ตรวจ log ตัวอย่างบน prod = PROD-CHECKLIST |

(USA-003/005 · ACC-001..004 · MAINT-002/004 · OPE-003/004 · REL-001/002 · I18N-001/002/004 = รอ UAT (D18) / prod drill / เครื่องมือเฉพาะ — จดตำแหน่งใน §5.2 ไม่อ้างผ่าน)

## 5. Known Limitations & หนี้ทะเบียน (ตาม D-f-7 — จดทุกจุดที่ผลไม่สมบูรณ์)

### 5.1 ข้อจำกัดของชุดทดสอบเอง (D79/D-f-7)

1. **e2e รัน 1 worker ไม่ parallel · retries:1** — เหตุ: Next dev router-server restart กลาง suite เมื่อ used_heap เกิน threshold (`playwright.config.ts:63-69` คอมเมนต์ · หลักฐาน e2e-full-r2/r3) — deterministic failure ยังตายเหมือนเดิม (ไม่มีการ mask)
2. **เคส flaky เดียวของรอบ: e2e-15 ฟอร์มยื่นใบอนุญาต** — ผ่าน retry ในรอบเดียว (เคสเดียวกับรอบ r1 · timing ของ dev stack) — ตาม D-f-7: รอบเต็ม 1 ครั้งต่อ battery + isolated-rerun เป็นหลักฐานเสริมเมื่อมีเคสตก
3. **e2e-05 ช้าสุด 7.4 นาที** (วิดีโอ heartbeat จริงจน watch_pct ≥ 80%) — known dev-stack cost
4. **HMR-history**: รอบ 34/34 ของ 1.0.0 เคยผ่าน document-attestation 4 เคสด้วยโชค HMR — ปิดแล้วด้วยการแก้ `document-viewer.tsx` (router.refresh) + battery สด — บทเรียนบันทึกที่ SECURITY-REMEDIATION §3 · **VideoPlayer/QuizPanel มีช่องว่าง live-update แนวเดียวกัน** = งานตาม wave ถัดไป (ไม่มี assertion ที่ตายจากมันในรอบนี้)
5. **integration กับ e2e ห้ามรันพร้อมกัน** — fresh replay เช็ด dev DB กลางคัน (กฎ §2.4)

### 5.2 ขอบเขตที่ dev battery พิสูจน์ไม่ได้ (ส่งต่อ prod/UAT — ไม่อ้างผ่าน)

| รายการ | ไปที่ไหน |
| --- | --- |
| PERF-001..008 (100k users · p95 · LCP · k6/lighthouse) | PROD-CHECKLIST (D-f-13) — วัดบน staging/prod ที่ config ตรง |
| TLS/HSTS/WAF/Cloudflare จริง · secure cookie บนโดเมน prod | PROD-CHECKLIST + external pentest (VA-PENTEST §5) |
| USA-002 เมทริกซ์ responsive 360–1920 + ACC-001..004 (axe/keyboard) | เครื่องมือเฉพาะ — เปิดเป็นงานหลัง wave นี้ / UAT |
| MAINT-004 coverage ≥ 80% (รายงาน coverage ยังไม่รันใน battery) | งาน CI เสริมหลัง wave (จดไว้ตรง ๆ — ไม่มีตัวเลขให้อ้างในเอกสารนี้) |
| MAINT-002 parity สาม environment · REL-001/002 · OPE-003/004 | prod drill — PROD-CHECKLIST |
| USA-003/005 (≤5 คลิก · สมัคร ≤3 นาที โดยมนุษย์ ≥5 คน) | UAT (D18 · Phase 3) |
| I18N-002/004 (สลับภาษา) | ขอบเขต v1 ไทยเดี่ยว — (S) ตาม SRS |

### 5.3 หนี้ทะเบียน — ฟีเจอร์ที่ไม่มีใน as-built v1 (RTM วางไว้ แต่ยังไม่สร้าง)

| Req | สิ่งที่ขาด | เงื่อนไขปิดหนี้ |
| --- | --- | --- |
| AUTH-004 ลืม/รีเซ็ตรหัสผ่าน | ไม่มี route/UI (GoTrue รองรับ) | สร้าง BFF+หน้าจอ ผ่าน DCR + เทส I/E ก่อนใช้ |
| AUTH-005 เปลี่ยนรหัสผ่าน | ไม่มี route/UI | เช่นเดียวกัน (ควรบังคับ recent-MFA สำหรับ staff) |
| AUTH-010 ออกจากระบบทุกอุปกรณ์ | มีแค่ logout เครื่องเดียว | GoTrue signOut(scope:global) ผ่าน BFF + เทส |
| ASM-012 ทบทวนข้อสอบหลังสอบ (S) | ไม่มี `/attempts/{id}/review` | (S) ตาม SRS — เปิดเมื่อยกระดับ |
| LRN-009 resume ตำแหน่งล่าสุด | ไม่มีฟิลด์/endpoint ตำแหน่งสื่อ | บันทึกตำแหน่ง watch ล่าสุด + หน้า "เรียนต่อ" |

หมายเหตุ: ทั้ง 5 รายการเป็น **ความจริงของ as-built v1 ที่ RTM วางแผนไว้กว้างกว่า** — บันทึกเปิด ไม่ปิดบัง และไม่นับเข้า coverage ที่อ้างผ่านของ §3

---

## 6. คำวินิจฉัยชุดทดสอบ (สรุปปิด Phase 2)

- ชุดทดสอบที่รันจริงครอบครบทุกฟังก์ชันหลักที่ส่งมอบใน v1 (78/83 FR มีหลักฐาน · 5 รายการไม่มีใน as-built จดเปิด) และ NFR กลุ่ม security ทั้งหมดมีหลักฐานระดับโค้ด+ชุดทดสอบ
- ความเสี่ยงที่เหลืออยู่รูปธรรม: (1) กลุ่ม PERF รอวัดจริงบน prod (2) การโจมตีเชิงมนุษย์/business logic รอ external pentest (3) หนี้ 5 รายการของ §5.3
- ตัวเลขทั้งหมดผูกกับ commit `96f99c0` (tree `8d2160c`) — rerun ได้ตามสูตร §2.4 โดยไม่ต้องตีความเพิ่ม

*ท้ายเอกสาร — D17 ฉบับนี้เขียนโดย lead (PM) จาก artifact จริงใน `.omc/artifacts/battery-phase0-r2/` และการอ่าน repo ณ `feat/wave-f` (หลัง `4c73266`) · ตัวเลขไม่ได้เรียบเรียงจากความจำทั้งหมด · การเปลี่ยนแปลงผ่าน DCR ตามกฎ Brief §9*
