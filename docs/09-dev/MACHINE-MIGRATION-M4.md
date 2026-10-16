# MACHINE MIGRATION — MacBook M4 (16GB/256GB) · 2026-10-15

> คู่มือย้ายเครื่องจาก Windows backup laptop → MacBook M4 · เขียนโดย CTO seat
> อ่านคู่กับ `PROJECT-STATE.md` (second brain — อ่านท้ายไฟล์ก่อนทุก session) และ `docs/TEAM.md` (ธรรมนูญ + design-first governance)

## 0. สถานะงาน ณ วันย้าย (ทุก branch ผลักขึ้น GitHub แล้ว)

| อย่าง | สถานะ |
|---|---|
| Branch หลัก | `feat/wave-i-e2e04-403` @ `598af00`+ (ทุก fix 18 consent rounds: CSRF · harness ×3 · re-baseline · teardown guard · suite-stability + A1-A3 · MFA login · barrier re-baseline + A1-A3 · CSP Critical fix · rate-override family · PBU port alignment + GoTrue allow-list) |
| Sprint 2+3 branches | 5 สาขา QA-APPROVED รอ merge หลัง close: `docs/sprint2-j-uat09-specs` · `feat/sprint2-j-ci` · `feat/sprint3-p-pattern-playbooks` · `feat/sprint3-p-uat09-specs` · `feat/sprint2-j-upgrade-next-1635` (execute lane หลัง UAT + pin-bump ≥16.3.8) |
| **r44 ยังไม่ได้รัน** | เครื่อง Windows ติด storm โหลดนอกโปรเจกต์ตลอด — **บน M4 นี่คือสิ่งแรกที่ต้องรัน** (เครื่องเงียบหลักสามารถรันได้ทันที) → คาด 13/13 → merge ladder → re-seed → formal UAT |
| D90 | นับใหม่ 0/3 หลังอัป next (ชี้ขาดแล้ว · BL-004/BL-018) |

## 1. Prerequisites (ติดตั้งบน M4)

```bash
# Homebrew แล้ว:
brew install git node@24         # node 24 LTS + git (LF โดยธรรมชาติ — ไม่ต้อง renormalize แบบ Windows)
brew install --cask docker       # Docker Desktop for Mac (Apple Silicon)
# ทางเลือก: colima/docker-compose แทน Docker Desktop ได้ — ใช้ compose v2 เหมือนเดิม
```

- `git config core.autocrlf input` (Mac default ที่ถูกต้อง — repo เป็น LF แล้ว)
- `make` มีบน macOS ได้ (`brew install make` + gnu path หรือใช้คำสั่ง compose ตรง ๆ ตาม Makefile — ดูหัวข้อ 4)

## 2. Clone + Worktrees

```bash
git clone https://<token>@github.com/narongsak-sukma/E-Leaning-LTC.git ~/E-Learning-LTC
cd ~/E-Learning-LTC
git checkout feat/wave-i-e2e04-403
# worktrees ของ sprint 2+3 (สร้างใหม่บน M4 — ของเครื่องเก่าไม่ย้าย):
git worktree add ../LTC-w1 feat/sprint2-j-ci          # หรือ merge ก่อนแล้วไม่ต้องสร้างเลย
git worktree add ../LTC-w2 docs/sprint2-j-uat09-specs
git worktree add ../LTC-w3 feat/sprint2-j-upgrade-next-1635
```

## 3. `.env` — ประกอบใหม่ (ไฟล์เครื่องเก่าไม่ได้ commit — โดยตั้งใจ)

```bash
cp .env.example .env
```

**คีย์ที่ "dev ต้องตั้งด้วย" — ห้ามลืม (บทเรียนแพงที่สุดของเครื่องก่อน):**

| คีย์ | ค่าที่ใช้บนเครื่องเก่า | หมายเหตุ |
|---|---|---|
| `CRON_SECRET` | openssl rand -hex 16 | ว่าง = app fail-fast |
| **`LTC_MFA_PENDING_KEY`** | openssl rand -base64 32 | **ไม่มี fallback — ว่าง = ทุกฟอร์มล็อกอินตายเงียบ ERR-SYS-001 (ค่าเริ่มต้นใน .env.example เป็น comment!)** |
| `UAT_DEMO_PASSWORD` | `UatAdmin-2026-LTC!` | รหัสเดียวทั้ง 8 บัญชี demo |
| `TEST_USER_PASSWORD` | ใส่ quote — `Integration#2026` (มี # ต้อง quote ไม่งั้น loader ตัด) | |

## 4. สตาร์ทสแตก

```bash
sh scripts/dump-app-logs.sh            # ธรรมนีย์ E2 (ไม่มี container ครั้งแรก = ผ่าน)
docker compose up -d --build           # = make up
docker compose run --rm db-migrate     # migrations 46 ไฟล์ + seed (idempotent)
docker compose --profile prod up -d --build app-prod   # = make up-prod (:3001)
# ตรวจ: curl localhost:3000/api/health → 200 · curl localhost:3001/api/health → 200
```

## 5. ⚠️ ข้อควรระวังสถาปัตยกรรม ARM (M4 = Apple Silicon)

1. **Image ที่ pin ไว้อาจเป็น amd64-only**: `postgrest` ถูก digest-pin (`sha256:729bf65c…`) จากเครื่อง x64 — **digest เป็นค่าเฉพาะสถาปัตยกรรม** บน ARM อาจไม่มี manifest ตรง → ถ้า pull ชน: ถอน digest กลับเป็น tag `postgrest/postgrest:v12.2.3` + บันทึก digest ใหม่ของ arm64 (เปิด micro-DCR ตามกติกา — จดใน PROJECT-STATE)
2. ตระกูล supabase images (postgres/gotrue/storage-api) + kong:2.8.1 + imgproxy + mailpit: ส่วนใหญ่มี multi-arch แล้ว แต่ **ตรวจ `docker compose pull` ทีละตัว** — Docker Desktop บน M4 มี Rosetta emulation สำหรับ amd64 (ช้ากว่าแต่รันได้) — ถ้าเจอ image ที่ emulation เท่านั้น ให้วัด timeout ใหม่ก่อนสรุปว่า suite แดง
3. **งบประมาณเพดาน (ceiling table)**: ทุกตัว calibrate บนเครื่อง Windows ช้า 3-4 เท่า — บน M4 แค่ "เพดานกว้าง" ไม่ต้องแก้ (หลักคำสอบ: ขยับเฉพาะด้วยการวัด · เครื่องเร็วจบก่อนเพดาน = ตามดีไซน์ patience bound)
4. `/tmp` มีจริงบน macOS → BL-014 (os.tmpdir) ยังถูก แต่ไม่ blocker อีก

## 6. ลำดับแรกบนเครื่องใหม่ (resume point)

1. สตาร์ทสแตก (ข้อ 4) + `sh scripts/uat-seed.sh` ตามต้องการ
2. **r44** (detached ตามแบบแผน): `sh scripts/battery-prod.sh` พร้อม exports `PROD_RATE_LIMIT_AUTH_PER_MIN=60 PROD_RATE_LIMIT_PWD_RESET_PER_HOUR=60` (PBU/CERT default :3001 แล้ว) — เครื่องเงียบ → คาด **13/13 ครั้งแรก**
3. 13/13 → `git push` → merge `--no-ff` ลง `develop` → post-merge gates + MFA live-smoke (:3001 ล็อกอิน uat.admin จริง) → RISK ACCEPTANCE + ceiling table + BL-015 closure (ทุกแถวตามที่บันทึกไว้ใน PROJECT-STATE)
4. re-seed → **formal UAT** ตาม `docs/09-dev/UAT-EXECUTION-PLAN.md` (PF-1..5 → 8 scenarios → verdict records)
5. หลัง UAT: execute lane ของ upgrade (BL-005/BL-018 — **audit หมดอายุแล้ว วิ่งทันที**) → merge 5 สาขา sprint → Wave-J (ต้องการบัญชี Vercel/Supabase/Cloudflare ของ owner)

## 7. ทักษะที่ติดตั้งไว้บนเครื่องเก่า (.agents/skills — ไม่ได้ commit)

ติดตั้งใหม่บน M4: `npm install -g ui-ux-pro-max-cli && uipro init --ai universal` + copy skills ของ Vercel/Supabase จาก `vercel-labs/agent-skills` และ `supabase/agent-skills` (deploy-to-vercel · vercel-cli-with-tokens · vercel-optimize · supabase · supabase-postgres-best-practices)

*— CTO seat · 2026-10-15 · ทาบทาม resume: "continue" แล้วอ่าน PROJECT-STATE ท้ายไฟล์*
