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
| A1   | Project Plan + Risk Register + Test Plan | worker-1 | 🔄 in_progress |
| A2   | SRS + RTM                              | worker-2 | 🔄 in_progress |
| A3   | SDS + Architecture + Data Dictionary   | worker-3 | 🔄 in_progress |
| A4   | API Spec + RBAC + Audit Log Design     | worker-4 | 🔄 in_progress |
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
