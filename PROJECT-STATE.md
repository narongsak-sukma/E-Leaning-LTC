# PROJECT-STATE — Second Brain (อัปเดตทุก stage transition + commit ทุกครั้ง)

> เอกสารนี้คือ "สมองก้อนที่สอง" ของโครงการ — session ใหม่ใด ๆ ต้องอ่านไฟล์นี้ก่อน แล้ว resume จาก
> wave board + decision log ไม่ต้องเริ่มใหม่จากศูนย์

|          |                                        |
| -------- | -------------------------------------- |
| อัปเดตล่าสุด | 2026-09-08 · Wave A (เอกสาร) กำลังระหว่างดำเนินการ |
| Lead/PM  | Claude Code session (GLM 5.3) — sole channel ของ user directives |
| CTO gate | codex CLI (มีในเครื่อง ✅) — ใช้ตอน milestone gates / auth-security-data merges |
| Repo     | local git · สาขาหลัก `develop`            |

## Wave Board (task → owner → status)

### Wave A — เอกสารนำ (deliverables 1–12) — CTO gate ก่อนเริ่มโค้ด

| Task | งาน                                    | Owner    | Status        |
| ---- | -------------------------------------- | -------- | ------------- |
| A0   | Repo init + baseline docs + brief      | lead     | ✅ done       |
| A1   | Project Plan + Risk Register + Test Plan | worker-1 | ✅ เสร็จสมบูรณ์ + align brief 0.2.0 แล้ว (รอ A6 review) |
| A2   | SRS + RTM                              | worker-2 | ✅ ส่งงาน+commit แล้ว (รอ A6 review) |
| A3   | SDS + Architecture + Data Dictionary   | worker-3 | ✅ ส่งงาน+commit แล้ว (รอ A6 review) |
| A4   | API Spec + RBAC + Audit Log Design     | worker-4 | ✅ ส่งงาน+commit แล้ว (รอ A6 review) |
| A5   | Design System + UI Prototype           | worker-5 | 🔄 in_progress |
| A6   | Lead review + ข้อมูลตรงกัน (cross-doc consistency) + codex/CTO verdict | lead + CTO | ⏳ pending |

### ลำดับถัดไป (จะขยายเป็น task เมื่อ Wave A ผ่าน gate)

- Wave B — repo scaffold + Docker dev env + CI (deliverable 13–16 เริ่มต้น)
- Wave C — MVP: courses, enrollment, progress
- Wave D — Assessment + Certificates
- Wave E — Credit Bank + admin/reporting
- Wave F — Security hardening + VA/penest + UAT + User Manual (deliverables 17–21)

## CTO Decision Log (append-only — ห้ามลบ/แก้รายการเก่า)

| # | วันที่    | การตัดสิน (decision)                                                                                                  | เหตุผล |
| - | --------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| D1 | 2026-09-08 | Stack: Next.js 15 + TS strict + Tailwind / Supabase (Postgres+Auth+Storage+RLS) / prod = Vercel+Supabase Cloud+Cloudflare / dev = local Docker ทั้งหมด | ตาม intention ผู้ว่าจ้าง (cloud 100% ที่ prod, docker ที่ dev) + parity ระหว่างสอง environment |
| D2 | 2026-09-08 | Doc-first + DCR process — เอกสาร 12 ฉบับ (deliverables 1–12) ต้องเสร็จและผ่าน CTO gate ก่อนเริ่มเขียนโค้ด | ผู้ว่าจ้างกำหนด + ลดความเสี่ยงคุมโครงการ |
| D3 | 2026-09-08 | Credit rules / เกณฑ์สอบ / รอบต่ออายุ = config-driven พร้อม default + flag "รอยืนยัน Q#" — ห้าม hardcode | ยังไม่มีคำตอบทางการ (Q1–Q6 ใน PROJECT-BRIEF) |
| D4 | 2026-09-08 | Wave A ใช้ shared checkout + กรรมสิทธิ์ไฟล์แยกกัน (docs ไม่ทับกัน) — workers ห้ามใช้ git, lead เป็นคนเดียวที่ branch/commit/merge; per-worker worktrees เริ่มใช้ Wave B (โค้ด) | ไฟล์เอกสาร disjoint ไม่มี conflict; ลด overhead การ merge ใน phase เอกสาร |
| D5 | 2026-09-08 | Model routing จริงของ environment นี้: workers = tier ราคาถูกสุดที่รับผิดชอบงานได้ (sonnet สำหรับงานเอกสาร/โค้ดหลัก, haiku สำหรับงานเล็ก), lead/CTO = session model (GLM 5.3) + codex gate สำหรับ milestone | environment นี้ spawn glm-5.3-flash โดยตรงไม่ได้ (ไม่มีใน model list ของ Agent tool) — ใช้ tier ถูกที่สุดที่คุณภาพรับได้แทน ตามเจตนาประหยัด token |
| D6 | 2026-09-08 | Audit log ออกแบบเป็น append-only + บังคับด้วย DB privilege + RLS; ห้ามมี API แก้/ลบ audit | ข้อกำหนดความมั่นคงปลอดภัย/ตรวจสอบได้ |
| D7 | 2026-09-08 | **DCR-1 APPROVE** (จาก worker-1): เพิ่ม Staging environment ใน brief §6 (cloud preview: Vercel staging + Supabase staging branch + Cloudflare staging domain, แยกด้วย env vars เท่านั้น ใช้พิสูจน์ perf 10k/5k + security test) → brief เป็น 0.2.0 + เพิ่ม Q7 (ความยินยอมค่า cloud tier) | เป้า performance พิสูจน์ไม่ได้บน local docker; DCR-2 (reconcile FR ID กับ SRS) กำหนดเป็นรายการ A6 ไม่กระทบ brief |

## Git Protocol

- `develop` = integration branch; feature branch ต่อ task (`feat/<task-id>-<slug>`, `docs/<task-id>-<slug>`)
- **Lead เท่านั้น** ที่ commit ลง develop / merge — workers ห้าม git ทุกชนิด (Wave A) และห้าม merge ตลอดโครงการ
- Merge gates: lint + tsc + tests + build + secrets scan เขียว; โค้ด auth/security/data ต้องผ่าน codex gate PASS
- Conventional Commits + task ref เช่น `docs(a2): add SRS v0.1.0 [A2]`
- Per-worker git worktrees เริ่ม Wave B (`git worktree` ต่อ worker, สาขา `omc-team/...`)

## Resume Procedure (สำหรับ session ใหม่)

1. อ่านไฟล์นี้ทั้งฉบับ + `docs/00-baseline/PROJECT-BRIEF.md`
2. ดู wave board → หา task ที่ยังไม่ terminal (pending/in_progress)
3. `git log --oneline -15` ดู progress ล่าสุด + `ls docs/` เทียบกับ board
4. ตรวจ `.omc/handoffs/*.md` (ถ้ามี) สำหรับบริบท stage
5. ทำงานต่อจาก task ที่ค้าง — ห้ามเริ่ม wave ใหม่ถ้า wave เดิมยังไม่ผ่าน gate
6. workers ที่หายไป: lead รับ/มอบหมายงานใหม่ตาม board

## เหตุการณ์สำคัญ (Event Log — append-only)

- 2026-09-08 · เริ่มโครงการ · Wave A spawn workers 1–5 (docs) · lead = session นี้
- 2026-09-08 · **A4 เสร็จ** — API-SPEC 350 บรรทัด (52 endpoints), RBAC 279 บรรทัด (47 permissions), AUDIT 257 บรรทัด (46 event types) · ตรวจรับ: wc -l ตรงรายงาน, ไม่แตะไฟล์อื่น · commit d02c574 + merge a031172 · ไม่มี DCR · **โจทย์ A6:** (1) ประสานชื่อตาราง/คอลัมน์/UUID กับ DATA-DICTIONARY ของ worker-3 (2) re-map AUD-01…12 ของ audit doc ให้ตรง SRS ของ worker-2 (3) ค่า default ทั้งหมด flag รอยืนยัน Q1–Q4 แล้ว
- 2026-09-08 · **A1 เสร็จ** — PROJECT-PLAN 242 บรรทัด (11 sections), RISK-REGISTER 161 บรรทัด (26 risks), TEST-PLAN 334 บรรทัด (18 TC + 16 E2E) · ตรวจรับ: wc -l ตรงรายงาน · commit 7a88da6 + merge e9fd2b3 · **DCR-1 APPROVE → brief 0.2.0 (+staging env, +Q7)** · DCR-2 เป็นรายการ A6 · คำถามค้าง QP-1/QP-2/QP-3/QP-5 รอ user/หน่ยงาน (ดู §คำถามค้างใน PROJECT-PLAN) · สั่ง worker-1 align TEST-PLAN กับ brief 0.2.0
- 2026-09-08 · **A1 follow-up เสร็จ** — TEST-PLAN 0.2.0-draft (337 บรรทัด): staging เป็น env หลักของ security/perf test, entry criteria + T-1 อัปเดต, ลบ QP-5 ออก · lead แก้ QP-5 เดิมใน PROJECT-PLAN §11 ยุบรวม Q7 · commit 4840b93 + merge d64e378 · **A1 ปิดสมบูรณ์**
- 2026-09-08 · **A3 เสร็จ** — SDS 394 บรรทัด, ARCHITECTURE 266 บรรทัด (mermaid 15 block), DATA-DICTIONARY 646 บรรทัด (**31 ตาราง** ครบขั้นต่ำ 29 + course_categories + email_outbox พร้อมเหตุผล; RLS 31/31; REVOKE บังคับ append-only audit+ledger; PII registry 5 จุด) · ตรวจรับ: wc -l/grep ตรงรายงาน · commit 291952f + merge 73d0bc8 · ไม่มี DCR · **เพิ่มโจทย์ A6:** (4) role key `staff:viewer` (brief/RBAC) vs `staff_viewer` (DB enum) ต้องตกลงชื่อเดียว (5) นิยาม helper `has_any_role()`/`is_staff()` canonical ที่ RBAC doc (6) API paths ใน SDS ต้องตรง API-SPEC (7) รูปแบบ cert_no `LTC-<ปี>-<6หลัก>` รอยืนยันกับรูปแบบจริงของสภาฯ (ผูก Q1–Q6)
- 2026-09-08 · **A2 เสร็จ** — SRS 647 บรรทัด (**134 requirements**: FR 83 + NFR 51, M114/S19/C1, ทุกตัวมี AC วัดได้) + RTM 252 บรรทัด (trace 5 มิติ coverage 100%) · ตรวจรับ: wc -l ตรง, unique Req ID = 134 พอดี · commit eb003e4 + merge c340531 · ไม่มี DCR · **เพิ่มโจทย์ A6:** (8) RTM อ้าง D13–D18 mapping เป็นสมมติฐาน — lead ยืนยัน (9) ชื่อตาราง/endpoint ใน RTM เป็นร่าง ต้องกระทบยอดกับ DATA-DICT + API-SPEC (10) SRS เขียนบน brief 0.1.0 — ต้องเช็คว่าขัดกับ staging (brief 0.2.0) ไหม (11) default `credits_required_per_cycle=12`, `renewal_cycle_years=1` เป็นสมมติฐานล้วน — **เร่งคำตอบ Q1–Q2 ก่อน Wave D–E**
