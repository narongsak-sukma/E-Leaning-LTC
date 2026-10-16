# ⚡ ZCODE — START HERE (อ่านไฟล์นี้ก่อนไฟล์อื่นทุกครั้ง)

> เอกสารนี้เขียนให้ ZCode session ใหม่บน MacBook M4 เริ่มทำงานต่อได้ทันทีโดยไม่ต้องถามอะไรเพิ่ม
> เขียนโดย CTO seat (orchestrating session) วันที่ 2026-10-15 · คู่มือย้ายเครื่อง: `docs/09-dev/MACHINE-MIGRATION-M4.md`

## 1. โปรเจกต์นี้คืออะไร (30 วินาที)

**E-Learning LTC** — ระบบฝึกอบรมออนไลน์ของสภาทนายความแห่งประเทศไทย (หลักสูตร · สอบ · ธนาคารหน่วยกิต · MFA · PDPA) — Next.js 15 (App Router) + Supabase (Postgres/RLS/Auth) · Next.js เดียวจบ · เอกสารส่วนใหญ่เป็นภาษาไทย · Issue กลาง #94 · สาขา integration = `develop`

- **เป้าหมายสูงสุดที่ owner สั่ง**: **READY AND PASSED UAT** บน local Docker — แล้วค่อยคุย prod (Vercel + Supabase Cloud + Cloudflare)
- **Owner มอบอำนาจเต็มที่งานแบบ autonomous** (2026-10-13) — ตัดสินใจเอง หยุดเฉพาะงานทำลายหรือเปลี่ยน scope ที่ owner ต้องเป็นคนตัดสิน · แถวรับมอบบันทึก "owner-delegated team acceptance"

## 2. ห้านาทีแรกของทุก session (ทำตามลำดับ)

```bash
# (1) สถานะล่าสุด — อ่าน "สมองก้อนที่สอง" (ไฟล์ยาวมาก บรรทัดยาวหลายพันอักขระ — อย่าอ่านทั้งไฟล์)
grep -n "^### " PROJECT-STATE.md | tail -8        # ดูหัวข้อ section ล่าสุด
sed -n '<เลขบรรทัดหัวข้อสุดท้าย>,$p' PROJECT-STATE.md | head -100   # อ่านเฉพาะท้ายไฟล์

# (2) สถานะ git + stack
git log --oneline -3 && git status --short
docker compose ps --format "table {{.Name}}\t{{.Status}}"   # app(:3000) + app-prod(:3001) ต้อง healthy

# (3) บอก owner สถานะ แล้วทำงานต่อตาม resume point
```

## 3. ระบบปกครอง (บังคับทุกคน — owner วางกฎเอง)

อ่าน `docs/TEAM.md` ฉบับเต็ม · สรุปเหล็กใน:

1. **Design-first**: ทุกการแก้/เพิ่ม = DCR ใน `docs/09-dev/` ก่อนเขียนโค้ดเสมอ · consent pm+qa ผ่าน bridge ก่อน GO · ค้นพบกลางทาง = บันทึกก่อนแก้
2. **CTO go/no-go**: CTO seat (orchestrating session = ZCode ที่กำลังอ่านไฟล์นี้) เป็นผู้ตัดสินเดียวของทุก design/fix/merge
3. **ห้ามแตะ spec เงียบ**: เจอปัญหาใน doc = DCR แจ้ง ห้ามแก้ doc ตรง
4. **Test-first เสมอ**: เทสแดงก่อน → แก้ → เขียว · happy + RBAC-negative + error code ตรงเป๊ะ
5. **ห้าม rmdir ความจริง**: ทุก claim มีหลักฐาน (path:line / log / probe) + สถานะ verified/unconfirmed
6. **ห้ามรัน suite ซ้อน** + long run ใช้ detached launcher เท่านั้น · dump logs ก่อนทำลาย container (E2)
7. **งบประมาณ = เพดาน**: ขยับเฉพาะด้วยการวัดใหม่ + จดแถวตาราง baseline + ระบุ "แกน" ที่วัด (machine-speed / battery-self-load)

## 4. ทีม (agent roster — อยู่ใน repo แล้ว: `.zcode/agents/`)

| Agent | โมเดล | หน้าที่ |
|---|---|---|
| `cto` | GLM-5.3$max | executor seat ของ CTO — วิ่ง ladder ยาว (battery→merge→UAT) |
| `pm` | GLM-5.3$max | สเปก Gherkin + งานสั่ง (work orders) + backlog |
| `dev-frontend` / `dev-backend` | GLM-5.3-Flash$high | งานโค้ด TDD |
| `qa` | GLM-5.3-Flash$max | gate PASS/FAIL อ่านอย่างเดียว — วิ่ง gate เอง + audit ทั้ง diff |
| `tester` | GLM-5.3-Flash$high | Playwright ดำ-กล่อง ห้ามแก้โค้ดแอป |
| `devops` | GLM-5.3-Flash$high | สแตก/CI/secret/deploy |

- **คำสั่ง**: `/cto` `/sprint` `/uat` `/team` (อยู่ใน `.zcode/commands/`)
- **Skills**: `.agents/skills/` — ui-ux-pro-max + Vercel/Supabase official (deploy ใช้ `deploy-to-vercel` + `vercel-cli-with-tokens` + `supabase`)
- ⚠️ **subagent ไม่มี Agent tool ซ้อน** — dispatch ผ่าน CTO seat (bridge) เสมอ · ตัวแทนล่มตอน provider error = เรียกคืนด้วย SendMessage + statepoint อยู่บนดิสก์อยู่แล้ว ไม่มีอะไรหาย
- ⚠️ **frontmatter ต้องมี $level** (เช่น `model: account:zai-individual-coding-plan/GLM-5.3$max`) — ไม่งั้น spawn ไม่ได้ · **FlashX ไม่อยู่ในแผน ห้ามใช้**

## 5. RESUME POINT ปัจจุบัน (2026-10-15 — ย้ายเครื่องเป็น M4)

**ทุกอย่าง push แล้ว** · สาขาหลัก `feat/wave-i-e2e04-403` (18 consent rounds ครบ — ทุก fix ที่เคยเจอถูกแก้+พิสูจน์แล้ว: CSRF · harness · re-baseline · teardown · suite-stability · MFA login · barrier · **CSP Critical** · rate-override · PBU port-alignment + GoTrue allow-list)

**ลำดับบน M4 (ทำทันที — เครื่องเงียบแน่นอน):**
1. ตั้งสแตกตาม `docs/09-dev/MACHINE-MIGRATION-M4.md` (สำคัญสุด: `.env` ต้องตั้ง `LTC_MFA_PENDING_KEY` — ไม่มี fallback ลืม = ทุกล็อกอินตายเงียบ · + `CRON_SECRET` · `UAT_DEMO_PASSWORD=UatAdmin-2026-LTC!`) · ⚠️ digest-pin ของ postgrest เป็น amd64 — ถ้า ARM pull ชน = ถอน digest กลับเป็น tag + micro-DCR จด digest ใหม่
2. **BATTERY r44 ยังไม่เคยรัน** (เครื่องเก่าติด storm ตลอด) — รันเลย: `PROD_RATE_LIMIT_AUTH_PER_MIN=60 PROD_RATE_LIMIT_PWD_RESET_PER_HOUR=60 sh scripts/battery-prod.sh` (detached!) — คาด **13/13**
3. 13/13 → push → merge `--no-ff` ลง `develop` → post-merge gates + MFA live-smoke (:3001 ล็อกอิน uat.admin จริง) → RISK ACCEPTANCE + ceiling table + BL-015 closure (แถวทุกอย่างเตรียมไว้ใน PROJECT-STATE แล้ว)
4. **RE-SEED → FORMAL UAT** ตาม `docs/09-dev/UAT-EXECUTION-PLAN.md` (PF-1..5 → 8 scenarios → verdict records + owner-eyes list) ← *เป้าหมายที่ owner รอ*
5. หลัง UAT: execute lane ของ upgrade (**audit หมดอายุแล้ว — วิ่งทันที** · branch `feat/sprint2-j-upgrade-next-1635` pre-staged + pin-bump ≥16.3.8 + 9 lint fixes) → merge 5 สาขา sprint (UAT-09 specs → CI → playbooks → Playwright) → **Wave-J prod** (ต้องการบัญชี Vercel/Supabase/Cloudflare จาก owner — คำวินิจฉัย OQ-1..14 พร้อมที่ `docs/09-dev/DCR-PROD-DEPLOY-OQ-RULINGS.md`)
6. Redesign wave (Coursera-aligned): skill ติดตั้งแล้ว · design system ตั้งต้นที่ `design-system/` (untracked — สร้างใหม่ได้ด้วย search.py) · ทำหลัง UAT ผ่านพร้อม UAT รอบใหม่ของตัวเอง · ห้ามลอก asset/โลโก้ของ Coursera (เอา pattern ไม่เอาพิกเซล)

## 6. แผนที่ไฟล์ (พับตัวเอง)

| อยากรู้ | เปิด |
|---|---|
| สถานะงานล่าสุด (second brain) | `PROJECT-STATE.md` — **ท้ายไฟล์เท่านั้น** (grep `^### ` หา section) |
| ธรรมนูญทีม + governance | `docs/TEAM.md` |
| งานค้างทั้งหมด | `docs/backlog.md` (BL-000..BL-018 + Wave J DRAFT) |
| คำวินิจฉัย CTO ทั้งหมดของ deploy | `docs/09-dev/DCR-PROD-DEPLOY-OQ-RULINGS.md` |
| แผน UAT พร้อมรัน | `docs/09-dev/UAT-EXECUTION-PLAN.md` (+ UAT-09 specs: branch `docs/sprint2-j-uat09-specs`) |
| Work orders sprint 2+3 (+gate) | `.omc/sprint/SPRINT{2,3}-workorders.md` |
| DCR ทั้งหมด (ประวัติ decision) | `docs/09-dev/DCR-*.md` |
| คู่มือย้ายเครื่อง M4 | `docs/09-dev/MACHINE-MIGRATION-M4.md` |
| หลักฐาน/gateway log ต่าง ๆ | `.omc/artifacts/` (gitignored — ของเครื่องเก่าหายได้ แต่ใจความถูกบันทึกใน PROJECT-STATE แล้ว) |

## 7. บทเรียนแพง ๆ (อย่าทำซ้ำ — ทุกอันมีหลักฐานใน PROJECT-STATE)

1. `.env` จาก template มีคีย์ "dev ต้องตั้งด้วย" ที่ comment ไว้ — ลืม = ตายเงียบไม่มี error บอก (`LTC_MFA_PENDING_KEY`)
2. ค่าใน `.env` ที่มี `#` ต้อง quote — loader ตัดที่ # (`TEST_USER_PASSWORD`)
3. `docker compose up -d --build` **ไม่ recreate** container — env แก้แล้วต้อง `--force-recreate`
4. สีแดงใน suite บอกความจริงเสมอ — ทุก "flake" ของโปรเจกต์นี้กลายเป็นบั๊กจริง/env จริง/image เปลี่ยนจริง · สอง-strike = เปิดตั๋วสอบสวน ห้ามจัด flake ซ้ำ
5. รันเทสชนกัน = ข้อมูลปนกัน (RUN_ID collision) — hygiene ก่อนทุก run ใหญ่
6. แดงแบบ timeout พอดีเป๊ะ = budget-marginal (วัดซ้ำ → ขอย้ายเพดานผ่าน gate) · แดงแบบ assertion = ของจริง (สอบสวน)
7. โหลด CPU นอกโปรเจกต์ฆ่า timing-sensitive suite — เครื่องต้องเงียบตอนรัน (M4 เป็นเครื่องเดี่ยว น่าจะจบปัญหานี้)
8. **สัญญาไว้ก่อน**: PR ของ e2e/ระบบ = "13/13 battery" — ห้าม merge โดยไม่มี

## 8. เริ่มเลย

Owner จะพิมพ์ **"continue"** — แล้วเธอ (Zcode) อ่าน §2 (ห้านาทีแรก) → §5 (resume point) → วิ่งเลย ไม่ต้องถามอะไรเพิ่ม ขอเแค่รายงานผลที่ transition ทุกขั้น ตามธรรมนีย์ที่ทีมนี้ทำมาตลอด: **evidence ก่อนเสมอ ไม่มีการเดา ไม่มีการง้อผลเทส**

*— CTO seat (orchestrating session) · 2026-10-15 · ส่งต่อให้ผู้สืบทอดบน M4 ด้วยความภาคภูมิใจ: 18 consent rounds ไม่มี even หนึ่งที่เสียเปล่า*
