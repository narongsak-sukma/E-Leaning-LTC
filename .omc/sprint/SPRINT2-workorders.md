# SPRINT 2 — Work Orders (เอกสารสั่งงานรายเลน · ขนานกับ close-ladder ของ Sprint 1)

| | |
| --- | --- |
| สถานะ | **DRAFT — รอ CTO gate** (สั่งงานได้เฉพาะงานเตรียมใน worktree ของตัวเอง · รอ CTO ตรวจ ASSUMPTION register §9 ก่อน release เต็ม) |
| ผู้เขียน | PM · 2026-10-13 · ตาม owner charter ของ Sprint 2 (CTO กำหนดลำดับเลน: J-CI → J-UAT09 → J-UPGRADE-PREP) |
| ข้อจำกัดแข็ง (สืบทอดจาก owner directive) | Sprint 1 close-ladder (npx portability addendum → battery r38 → merge → UAT) **กำลังบิน และเป็นเจ้าของ** main tree (`D:/Lawer-E-Learning` · branch `feat/wave-i-e2e04-403`) · docker stacks · DB · และคิว battery ทั้งหมด — ทุก work order ของ Sprint 2 ต้อง (ก) อยู่ใน git worktree ของตัวเอง (ข) แก้ไขไฟล์ใน tests/, src/, docker/, docker-compose.yml, .env*, scripts/ = **ศูนย์ไฟล์** (ยกเว้นข้อยกเว้นที่ CTO รับรองต่อเลน — ดู WO-3) · อ่าน (read-only grounding) ได้ทุกไฟล์ (ค) ห้ามรันอะไรที่แตะ docker/DB จนกว่า CTO ประกาศ **close drained** |
| เอกสารนี้ self-contained | คนงานไม่ต้องเปิดอ่านเอกสารต้นทางยาว ๆ — สัญญา/เวอร์ชัน/คำสั่งที่จำเป็นคัดมาให้ครบในแต่ละ WO แล้ว (ต้นทาง: WAVE-J-PLAN-DRAFT · DCR-PROD-DEPLOY-DRAFT §5.1/§6/§7 · DCR-NEXT-UPGRADE-1635-DRAFT · TEAM-ENHANCEMENT-RETRO #3 · UAT-EXECUTION-PLAN §7 · docs/backlog.md · .github/workflows/ci.yml · package.json — ตรวจคำนวณกับ working tree จริงแล้วทุกอ้างอิง file:line) |

---

## 0. SPRINT 2 Board

| Lane | WO | Branch | Worktree (absolute) | ผู้รับผิดชอบ | Priority | สถานะ | Deliverables (ไฟล์ที่สร้าง/แก้ — ใน worktree เท่านั้น) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **J-CI** — GitHub Actions สำหรับ serial test ladder | WO-1 | `feat/sprint2-j-ci` | `D:/LTC-w1` | **normal worker Flash** | **P0** (longest-lead) | todo | `docs/09-dev/DCR-GH-ACTIONS-CI.md` (ใหม่) · `.github/workflows/ci-integration.yml` (ใหม่) |
| **J-UAT09** — สเปก Gherkin ช่องว่าง UAT | WO-2 | `docs/sprint2-j-uat09-specs` | `D:/LTC-w2` | **PM เขียนเอง** (ผู้รัน: tester agent — post-close) | P1 | todo | `docs/07-results/UAT-09-SPECS-DRAFT.md` (ใหม่ · ไฟล์เดียวจบ) |
| **J-UPGRADE-PREP** — pre-stage next@16.3.5 | WO-3 | `feat/sprint2-j-upgrade-next-1635` | `D:/LTC-w3` | **main worker GLM-5.3** | P2 | todo | `package.json` · `package-lock.json` · (มีเงื่อนไข) `eslint.config.mjs` — **ใน branch ของ worktree เท่านั้น** (ข้อยกเว้นต่อ constraint แบบ hard — ดู A-5) |

### 0.1 คำสั่งสร้าง worktree (ผู้รับงานรันเองจาก main tree — ครั้งเดียวต่อเลน)

```bash
# WO-1 (J-CI):
git worktree add D:/LTC-w1 -b feat/sprint2-j-ci develop
# WO-2 (J-UAT09):
git worktree add D:/LTC-w2 -b docs/sprint2-j-uat09-specs develop
# WO-3 (J-UPGRADE-PREP):
git worktree add D:/LTC-w3 -b feat/sprint2-j-upgrade-next-1635 develop
```

- ทุกเลนแตกจาก `develop` (ปัจจุบัน `65fbac9` — จุดก่อน merge ของ close-ladder) — **เจตนา**: ไม่หยิบงานที่ยังไม่ merge ของ Sprint 1 มาปน
- ห้ามสลับ branch ใน main tree `D:/Lawer-E-Learning` (ปัจจุบัน checkout `feat/wave-i-e2e04-403` — ของ close-ladder) · ห้าม `git worktree remove/prune` ของเลนอื่น
- ผลตรวจจริง ณ วันเขียน: ยังไม่มี worktree ใดนอก main tree · ยังไม่มีไดเรกทอรี `D:/LTC-w1|w2|w3`

### 0.2 คำแถลงความปลอดภัยขนาน (parallel-safety — ไฟล์ที่แต่ละเลน "แตะ" ไม่ซ้อนกันเลย)

| ไฟล์/กลุ่มไฟล์ | WO-1 (J-CI) | WO-2 (J-UAT09) | WO-3 (J-UPGRADE-PREP) | close-ladder (Sprint 1) |
| --- | --- | --- | --- | --- |
| `docs/09-dev/DCR-GH-ACTIONS-CI.md` (ใหม่) | **เขียน** | — | — | — |
| `.github/workflows/ci-integration.yml` (ใหม่) | **เขียน** | — | — | — |
| `.github/workflows/ci.yml` (มีอยู่) | อ่านอย่างเดียว (**ห้ามแก้**) | — | — | — |
| `docs/07-results/UAT-09-SPECS-DRAFT.md` (ใหม่) | — | **เขียน** | — | — |
| `package.json` / `package-lock.json` / `eslint.config.mjs` | — | — | **แก้ (ใน branch ตัวเองเท่านั้น)** | (คาดว่าไม่แตะ — ถ้าแตะจริง แก้ตอน rebase หลัง close) |
| `tests/` · `src/` · `docker/` · `docker-compose.yml` · `.env*` · `scripts/` · `Makefile` | ศูนย์ไฟล์ (อ่านได้) | ศูนย์ไฟล์ (อ่านได้) | ศูนย์ไฟล์ (อ่านได้) | เจ้าของพื้นที่นี้ |
| `PROJECT-STATE.md` / `docs/backlog.md` | ห้ามแตะ (PM อัปเดตเองตอน gate) | ห้ามแตะ | ห้ามแตะ | เจ้าของ |

สรุป: **คู่ไหนก็ไม่มีไฟล์ที่แก้ร่วมกัน** · ความเสี่ยง conflict ที่เหลือมีเพียงจุดเดียว = `package-lock.json` ระหว่าง WO-3 กับ merge ของ close-ladder (ถ้า close แตะ package.json) — บริหารด้วย rebase หลัง close drained (ขั้น P-3 ของ WO-3) โดย CTO สั่งลำดับ

### 0.3 กฎคิวหลัง close (queue-behind-close — ทุกเลนผูกกฎเดียวกัน)

1. งานที่ทำได้ **เดี๋ยวนี้**: สร้าง worktree · เขียนเอกสาร/YAML/commit ใน branch ตัวเอง · push branch ขึ้น remote ได้ (git transport ใช้ได้ตาม retro #7 — แต่**ห้ามเปิด PR/merge**) · รันเช็คที่ไม่แตะ docker/DB (unit/typecheck/lint/build/npm install ใน worktree)
2. งานที่**ห้าม**จนกว่า CTO ประกาศ **close drained** (= merge ของ Sprint 1 เข้า develop แล้ว + ปล่อยคิวเครื่อง): integration · e2e · probe ห้าทิศ · battery ทุกชนิด · `make up*` ใด ๆ · การแตะ DB/`.env` จริงของเครื่อง · การ merge เข้า develop · การเปิด trigger จริงของ workflow ใหม่
3. ทุก WO มี DoD แยกเป็น **worktree-local** (ทำได้เลย) กับ **post-close (deferred · CTO-gated)** — ห้ามเบลอทั้งสองส่วน

---

## WO-1 · Lane J-CI (P0) — DCR + workflow สำหรับ serial test ladder บน GitHub Actions

### 1.1 ตัวตนงาน

| | |
| --- | --- |
| Lane / Task id | J-CI (retro ข้อ 3 — "top efficiency item" ทางเทคนิค) |
| ผู้รับงาน | **normal worker Flash** |
| Branch / Worktree | `feat/sprint2-j-ci` · `D:/LTC-w1` (สร้างด้วยคำสั่ง §0.1) |
| ปัญหา (problem statement) | คอขวดอันดับ 1 ที่วัดได้: บันไดตรวจรับ (integration full-suite + battery) รอเครื่อง local เป็นหลัก ~3.5–4.5 ชม./รอบ merge · ชนกับงานภายนอก (โปรเซสอื่นเคยดัน CPU 100% จน suite แดง) · เครื่องสำรองช้ากว่า 3–4 เท่า — ย้ายขึ้น runner แล้ว**ไม่แย่งคิวเครื่อง + รันคู่ขนานระหว่างทีมทำงานต่อ** แม้ runner 2 คอร์จะไม่เร็วกว่าต่อรอบ |
| User story | ในฐานะทีมพัฒนา ฉันต้องการให้ชุดทดสอบยาว (integration full-suite → battery) รันบน GitHub Actions runner แทนคิวเครื่อง local เดียว เพื่อคืนเวลาทีม 3–4 ชม./รอบ merge และตัดเหตุ suite แดงจากงานภายนอกบนเครื่อง |

### 1.2 สัญญา (verbatim จากต้นทาง — ห้ามตีความเอง)

**(ก) ด่านที่มีอยู่แล้วบน runner — คำสั่งตรงจาก `.github/workflows/ci.yml` (branch develop · job `merge-gates` · `runs-on: ubuntu-latest` · `timeout-minutes: 20` · env placeholder: `NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY = ci-placeholder*`):**

- Gate 1/5 lint → `npm run lint`  (= `eslint .` · package.json:13)
- Gate 2/5 typecheck → `npm run typecheck`  (= `next typegen && tsc --noEmit` · package.json:14)
- Gate 3/5 test (vitest) → `npm run test`  (= `vitest run` · package.json:15)
- Gate 4/5 build → `npm run build`  (= `next build` · package.json:11)
- Gate 5/5 secrets scan → `gitleaks/gitleaks-action@v2` · `GITLEAKS_VERSION: 8.24.2` · `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` · ไม่ตั้ง `GITLEAKS_ENABLE_UPLOAD`
- ส่วนที่ต้องเก็บไว้เหมือนเดิมเมื่อเขียน workflow ใหม่: `permissions: contents: read` · `defaults.run.shell: bash` · checkout pin full SHA `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` + `fetch-depth: 0` (gitleaks ต้องใช้) · `actions/setup-node@v4` + `node-version: 22` + `cache: npm` · concurrency ปัจจุบัน `group: ci-${{ github.event_name }}-${{ github.ref }}` + `cancel-in-progress: true`
- กระจก local ของด่านเดียวกัน: `bash scripts/ci-local.sh` (ci.yml บรรทัดหัวเอกสาร — WO นี้อ่านอ้างได้ **ห้ามแก้สคริปต์**)

**(ข) สายที่ DCR-PROD-DEPLOY-DRAFT §5.1 ร่างไว้สำหรับ CI (คัดมาตรง — นี่คือ scope ต่อยอดของ WO นี้):**

> ```
> PR (ci.yml เดิม + ด่านใหม่)
>   ├─ lint → tsc → unit → build → gitleaks          (มีอยู่แล้ว)
>   ├─ integration (ใหม่): ปั้น service db/auth/rest/kong ด้วย compose บน runner
>   │   → TEST_DATABASE_URL ชี้ localhost → npm run test:integration
>   └─ (ไม่รัน e2e บน PR — หนักเกิน ทำที่ staging)
> ```

- คำสั่ง integration: `npm run test:integration` (= `vitest run --config vitest.integration.config.ts` · package.json:16)
- token ที่ต้องมีใน GitHub secrets **เฉพาะสาย deploy** (§5.1 ท้ายย่อหน้า — **อยู่นอก scope WO นี้** แค่บันทึกส่งต่อใน DCR): `SUPABASE_ACCESS_TOKEN` + DB connection ของ staging/prod · `VERCEL_TOKEN` + org/project id (OQ-13)
- หลักการลำดับที่ต้องสืบทอด: "**ลำดับ migration ก่อน app เสมอ**" (ใช้เมื่อวันหน้าต่อสาย deploy — ไม่ใช่ของ WO นี้)

**(ค) สัญญาจาก retro ข้อ 3 (TEAM-ENHANCEMENT-RETRO §2 แถว 3 — คัดตรง):**

> "ย้าย suite ยาว/battery ขึ้น GitHub Actions (repo มี CI 5 ประตู B-04 อยู่แล้ว): full-suite + battery รันบน runner แยก — ชนะที่ **ไม่แย่งคิวเครื่อง + ไม่โดนงานภายนอก + รันคู่ขนานระหว่างทีมทำงานต่อ** (แม้ runner 2 คอร์จะไม่เร็วกว่าเครื่องนี้ต่อรอบ)" — Impact สูงมาก (คืนเวลาทีม 3–4 ชม./รอบ merge) · Effort สูง (setup stack ใน CI + secrets) · **สิทธิ์อนุมัติ: owner (ค่าใช้จ่าย/บัญชี) + CTO (เทคนิค)**

**(ง) ตัวเลข ground truth สำหรับออกแบบ budget/timeout (retro §1 คัดตรง):** isolated ต่อไฟล์: dcr9 289–441 วิ · waveh 625–656 วิ · dcr14 58–83 วิ · full-suite 35 ไฟล์ 2189–2461 วิ · battery 30–60+ นาที — บนเครื่องหลัก; runner 2 คอร์อาจช้ากว่า — DCR ต้องตั้ง timeout และความคาดหวังเองจากตัวเลขนี้ (แนะนำเริ่ม: job integration ≥ 120 นาที + แยก job ต่อชุดถ้าจำเป็น)

**(จ) กฎ no-overlap ที่ต้องจำลองบน runner (บทเรียน BL-015):** "ห้ามรันสวีทซ้อน + long run ใช้ detached launcher เท่านั้น" (local) — บน GitHub Actions แปลเป็น **concurrency group เดี่ยวทั้ง workflow** (เช่น `group: serial-ladder` + `cancel-in-progress: false`) เพื่อบังคับ integration/battery ทีละรอบบน runner ด้วย — DCR ต้องเขียนเรื่องนี้ไว้ชัด

### 1.3 ขอบเขตการออกแบบที่ DCR ต้องตอบครบ (ตาม lane charter)

1. **ด่านไหนขึ้น runner ด่านไหนอยู่ local** — ฐาน: lint/typecheck/unit/build/gitleaks อยู่บน runner แล้ว (ci.yml) · integration ต้องมี docker stack → ทางเลือก: (ก) runner-hosted compose (ตาม §5.1) หรือ (ข) คงไว้ที่ local ช่วงแรก · e2e/battery หนักสุด → แนะนำ **phased** (ดูข้อ 5)
2. **วิธีปั้น stack บน runner** — รายการ service ที่ harness ต้องการ (ตรวจอ่าน `vitest.integration.config.ts` + `docker-compose.yml` + `.env.example` กลุ่ม `TEST_*` — **อ่านอย่างเดียว ห้ามแก้**) · รูปตั้งค่า env `TEST_DATABASE_URL`/`TEST_SUPABASE_URL`/`TEST_SUPABASE_ANON_KEY`/`TEST_SUPABASE_SERVICE_ROLE_KEY`/`TEST_USER_PASSWORD` ชี้ localhost-of-runner · ระวัง: ห้ามนำค่า canonical V14.2.x ใดไปใส่ GitHub secrets (ค่า placeholder ทางการของ local เท่านั้น ตามกฎ DCR-PROD-DEPLOY §1 แถว 2)
3. **Secrets matrix** — Phase 1 (integration บน runner): ตั้งเป้า **ไม่ต้องมี secret จริงใด** (ทุกค่าชี้ localhost/placeholder ใน env ของ job เอง · `GITHUB_TOKEN` ที่มีอยู่แล้วพอ) · Phase 2+ (e2e/battery/deploy): ระบุรายการส่งต่อ (`SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN`, org/project id — อ้าง §5.1/OQ-13) พร้อมหมายเหตุว่าเป็นของสาย deploy ที่อยู่นอก WO นี้
4. **Cache strategy** — npm cache ผ่าน setup-node (มีแล้ว) · ประเมิน `.next/cache` (ระวัง: หลัง upgrade Turbopack ความเข้ากันของ cache ต้องพิสูจน์ใหม่ — ผูก WO-3) · Playwright browser cache (`~/.cache/ms-playwright` + key ตาม `@playwright/test` เวอร์ชัน) สำหรับ Phase 2 · ทุกข้อต้องมีเหตุผลเชิงนาทีที่ประหยัดได้จริง
5. **Concurrency guards** — กฎ no-overlap บน runner (ข้อ (จ) ข้างบน) + ไม่ทำลาย concurrency เดิมของ ci.yml · กันซ้อนกับ battery ของ CTO บนเครื่อง local **ไม่เกี่ยวกันโดยสิ่งปลูกสร้าง** (คนละเครื่อง — ระบุไว้ใน DCR)
6. **แผน phase (PM เสนอ — CTO ตัดสิน):**
   - **Phase 1 (งาน WO นี้)**: workflow ใหม่ `ci-integration.yml` — integration full-suite แบบอนุกรมบน runner-hosted compose · **trigger = `workflow_dispatch` อย่างเดียว**จนกว่า CTO จะสั่งเปิด `pull_request`/`push` (กันกิน runner minutes ก่อน owner ให้สัตยาบันค่าใช้จ่ายตาม retro #3)
   - **Phase 2 (post-close · CTO-gated)**: เพิ่ม e2e + battery (`scripts/battery-prod.sh` + compose profile `prod` + `scripts/prod-build-proof.mjs`) บน runner — ออกแบบไว้ใน DCR พร้อมชื่อไฟล์ (เช่น `ci-battery.yml`) แต่**ยังไม่สร้างไฟล์**ใน WO นี้
   - **Phase 3 (นอก scope)**: สาย deploy-staging/deploy-prod — ของ DCR-PROD-DEPLOY §5.1 รอบ implement (J-P3+) · WO นี้ทำได้ถึงการอ้างอิงส่งต่อเท่านั้น
7. **Node version pin** — 22 (ให้ตรง ci.yml ปัจจุบัน + ทิศทาง OQ-11) — ASSUMPTION A-3

### 1.4 EXACT file list (WO-1 แตะเท่านี้ — ใน `D:/LTC-w1`)

| ไฟล์ (path จริงใน tree) | การกระทำ | เช็คกลาง |
| --- | --- | --- |
| `docs/09-dev/DCR-GH-ACTIONS-CI.md` | **สร้างใหม่** | ยังไม่มีใน tree (ตรวจแล้ว · ใน dir มี DCR อื่น 9 ฉบับ) |
| `.github/workflows/ci-integration.yml` | **สร้างใหม่** | dir `.github/workflows/` มีอยู่ · มีเฉพาะ `ci.yml` (ตรวจแล้ว) — ชื่อไฟล์สุดท้าย DCR เป็นผู้หล่อหลอม ห้ามชนกับ `ci.yml` |

- **ห้ามแก้**: `.github/workflows/ci.yml` (implementation-in-waiting หมายถึงไฟล์ใหม่เท่านั้น — แก้ ci.yml หลัง gate เท่านั้น และเป็นตั๋วแยกถ้า CTO สั่ง)
- **อ่านได้ (grounding ห้ามแก้)**: `.github/workflows/ci.yml` · `package.json` · `scripts/ci-local.sh` · `vitest.integration.config.ts` · `vitest.config.ts` · `docker-compose.yml` · `.env.example` · `docs/09-dev/TEAM-ENHANCEMENT-RETRO.md` · `docs/09-dev/DCR-PROD-DEPLOY-DRAFT.md` §5.1 · `docs/backlog.md` (BL-015)

### 1.5 ขั้นตอนแบบ test-first (ทำตามลำดับ — เอกสารคือชิ้นงานหลัก)

1. สร้าง worktree (§0.1) · อ่านไฟล์ grounding ข้อ 1.4 พร้อมจด: รายชื่อ service ที่ integration harness ต้องการ · env `TEST_*` ที่ config อ้าง · เวลาที่ ci.yml ตั้งไว้
2. **เขียน DCR ส่วน "Acceptance criteria (Gherkin)" ก่อนเขียน YAML** — อย่างน้อย: (a) workflow รัน integration ครบทุกไฟล์แบบอนุกรมและเขียว (b) รอบใหม่ที่เข้ามาขณะมีรอบกำลังรัน = **เข้าคิว ไม่ cancel** (concurrency) (c) ไม่มี secret จริงใดใน log/artifact (d) trigger เริ่มต้น = `workflow_dispatch` เท่านั้น (e) งาน fail = summary บอกไฟล์/ชุดที่แดง
3. เขียน YAML ให้ตรง Gherkin ข้อ 2 ทุกข้อ (รูปเดียวกับ ci.yml: bash defaults · least-privilege · checkout pin SHA เดิม · setup-node 22 + cache npm · env placeholder ใน job)
4. ตรวจ YAML: เครื่องนี้**ไม่มี** actionlint/yamllint/yq (ตรวจแล้ว) — ลำดับที่ใช้ได้: (1) parse ด้วย worktree-local `npx --yes js-yaml <file>` ต่อไฟล์ (2) รีวิวเชิงโครงสร้างกับ checklist: `on:`/`permissions:`/`concurrency:`/`defaults:`/steps ทุก step มี `name`/ไม่มี secret ตามตัว/`timeout-minutes` ตั้งทุก job — แนบผลทั้งสองข้อลง DCR
5. เขียน DCR ให้ครบทุกหัวข้อ §1.3 (รวม phased plan + ตาราง "อะไรรันบนไหน" + secrets matrix + budget นาทีโดยประมาณจากตัวเลข §1.2(ง))
6. Commit ลง branch · (ทางเลือก) push branch ขึ้น remote — **ห้ามเปิด PR**
7. รายงานกลับตาม §1.6 (worktree-local DoD) — รอ CTO gate

### 1.6 DoD

**Worktree-local (เสร็จได้เลย — สิ้นสุดงาน WO-1):**
- [ ] `docs/09-dev/DCR-GH-ACTIONS-CI.md` ครบทุกหัวข้อ §1.3 + Gherkin AC อยู่ก่อน YAML (มี history ยืนยันลำดับเขียน)
- [ ] `.github/workflows/ci-integration.yml` ผ่าน parse + รีวิว checklist ข้อ 1.5.4 · trigger = `workflow_dispatch` อย่างเดียว
- [ ] ศูนย์ conflict ไฟล์กับ close-ladder: แก้เพียง 2 ไฟล์ใหม่ตาม §1.4 · `git -C D:/LTC-w1 diff --stat develop` ยืนยันไม่มีไฟล์อื่น
- [ ] ไม่รันอะไรกับ docker/DB เครื่องนี้เลย (รวมถึง `make` ทุกเป้า)

**Post-close (deferred · CTO-gated):**
- [ ] CTO อนุมัติ DCR + owner ให้สัตยาบันค่าใช้จ่าย runner (retro #3) → merge เข้า develop
- [ ] รันสูบบุหรี่จริงครั้งแรก: `workflow_dispatch` บน branch → integration เขียว 1 รอบบน runner (evidence: run URL + summary)
- [ ] เปิด trigger `pull_request` (ตาม §5.1 ของ DCR-PROD-DEPLOY) เมื่อรอบสูบบุหรี่นิ่ง
- [ ] Phase 2: ออกแบบ battery/e2e บน runner (ไฟล์ `ci-battery.yml` ฯลฯ) — ตั๋วแยกหลัง close drained

### 1.7 Out-of-scope fences (ห้ามทำเด็ดขาด)

- ห้ามแก้ `.github/workflows/ci.yml` · ห้ามแตะ `tests/`, `src/`, `docker/`, `docker-compose.yml`, `package.json`, `.env*`, `scripts/`, `Makefile`
- ห้าม author สาย deploy (deploy-staging/deploy-prod · Vercel/Supabase secrets จริง) — ของ DCR-PROD-DEPLOY รอบ implement
- ห้ามเปิด trigger อัตโนมัติใด (PR/push/schedule) ใน YAML ชุดนี้ก่อน CTO GO
- ห้ามเก็บค่าใดที่เป็นค่าจริง/ค่า canonical V14.2.x ลง YAML หรือ DCR
- ห้าม implement sharding หลาย compose project (retro #8 — "ทำ #3 แล้วค่อยว่า" — DCR บันทึกเป็น future work ได้)

### 1.8 ASSUMPTION (CTO confirm)

- **A-1**: owner ยังไม่ได้ให้สัตยาบันค่าใช้จ่าย runner ของ retro #3 อย่างเป็นทางการ — WO นี้เดินหน้าเป็น implementation-in-waiting (trigger มือ) บนสมมติฐานว่า lane charter ของ CTO = คำรับรองเบื้องต้น · การเปิดใช้จริงรอ owner
- **A-2**: integration บน runner ตั้งค่าได้ครบด้วย localhost `TEST_*` env ไม่ต้องมี secret จริง (ตามนัย §5.1) — ยืนยันระหว่างเขียน DCR กับ `vitest.integration.config.ts` จริง · ถ้า harness ต้องการอย่างอื่น = หยุดรายงาน CTO
- **A-3**: Node 22 สำหรับ workflow ใหม่ (ตรง ci.yml ปัจจุบัน + ทิศ OQ-11) — CTO ยืนยันพร้อมคำวินิจฉัย OQ-11

---

## WO-2 · Lane J-UAT09 (P1) — สเปก Gherkin ช่องว่าง UAT (doc-only · PM-authored)

### 2.1 ตัวตนงาน

| | |
| --- | --- |
| Lane / Task id | J-UAT09 (UAT-EXECUTION-PLAN §7 ข้อ 4–5: ช่องว่างสคริปต์ + ธง stale) |
| ผู้รับงาน | **PM เขียนสเปกเอง** (ตาม lane charter) · **ผู้รัน: tester agent — post-close เท่านั้น** |
| Branch / Worktree | `docs/sprint2-j-uat09-specs` · `D:/LTC-w2` (สร้างด้วยคำสั่ง §0.1) |
| ปัญหา | UAT.md 1.0.2 (plan-of-record ของสคริปต์) ไม่มีสคริปต์ครอบฟีเจอร์ที่**มีจริงในแอป** 5 ชิ้น (ส่งมอบ Wave G) — ทะเบียนไว้แล้วว่าเป็น "ช่องว่างของสคริปต์ ไม่ใช่ความผิดของแอป" · ต้องมีสเปก AC ก่อนเปิดตั๋ว execute (กฎ: ห้ามเริ่ม ticket ที่ไม่มี acceptance criteria) |
| User story | ในฐานะ PM/QA ฉันต้องมีสเปก Gherkin ของ 5 ฟีเจอร์ที่ขาด เพื่อให้ tester รัน UAT-09 เป็นรอบเสริมได้ทันทีหลัง close drained โดยไม่ต้องวิเคราะห์อะไรตอน execute (ตามปรัชญา "ไม่มีการวิเคราะห์ค้างอยู่ตอน execute" ของ UAT-EXECUTION-PLAN) |

### 2.2 สัญญา (verbatim จาก UAT-EXECUTION-PLAN §7 — ห้ามตีความเอง)

**(ก) ช่องว่างที่ต้องเขียนสเปก — §7 ข้อ 4 คัดตรง:**

> "UAT.md ไม่มีสคริปต์: ลืมรหัสผ่าน `/forgot-password` · เปลี่ยนรหัสผ่าน · ออกจากระบบทุกเครื่อง (มาใน Wave G P1) · โมดัล '+ เพิ่มกติกา version ใหม่' (Wave G P3) · หน้ารายละเอียดคลัง (Wave G P2)" — ผลต่อการ execute: "ช่องว่างของสคริปต์ ไม่ใช่ความผิดของแอป — บันทึกเป็นข้อเสนอรอบถัดไป (**เพิ่ม UAT-09..**) ไม่ขยาย scope รอบนี้"

**(ข) ช่อง exam_review_mode — §7 ข้อ 5 คัดตรง:**

> "UAT-06 ขั้น 2b ไม่มีช่อง 'การเปิดเฉลย (exam_review_mode)' ในรายการฟอร์ม | ฟอร์ม/โมดัลปัจจุบันมีการตั้งค่าเปิดเฉลย (**after_final_attempt/never**) ในโมดัลกติกา version ใหม่"

**(ค) ธง stale ที่สเปกต้องบันทึกไว้ (แจ้งไว้เท่านั้น — §7 หัวข้อ: "ห้ามแก้ UAT.md ในรอบนี้" · แก้ตอน execute ผ่าน DCR เท่านั้น):**

1. หมายเหตุท้าย UAT-06 "เปิดใช้งานข้อรายข้อ/version lock ยังไม่มีหน้าจอ" — **เก่า** (Wave G P2 มี `/admin/question-banks/{id}` แล้ว · version lock ออกแบบใหม่เป็น snapshot — USER-MANUAL 1.3.0 §2.5)
2. อ้างชุด e2e "34/34" + integration 173 — ปัจจุบัน e2e **42** · integration **326**
3. UAT.md กำหนด runtime dev :3000 — รอบ execute จริงใช้ **prod-build :3001**
4. (รายการช่องว่าง 5 ฟีเจอร์ — คือวัตถุของ WO นี้เอง)
5. (exam_review_mode ข้อ (ข) ข้างบน)

**(ง) กติกา verdict/หลักฐานที่สเปกต้องใช้สืบทอด — §5 คัดตรง:** "นิยาม verdict ต่อขั้น: ผ่าน = หน้าจอตรง 'ผลที่คาดหวัง' ครบทุกอนุประโยค และมีหลักฐาน · ไม่ผ่าน = สิ่งที่เห็นจริงต่างจากคาดหวัง · N/A = ทำไม่ได้จากสภาพแวดล้อม — ไม่นับเป็นความล้มเหลวของแอป" · severity (ก กั้นธุรกิจหลัก / ข ทางเลือกยังมี / ค ภาพ/ข้อความ) · หลักฐาน: `.omc/artifacts/uat/${RUN_ID}/<สคริปต์>/step-<เลข>.png` · บันทึกรัน `run-log.md` · แถวรับมอบ "owner-delegated team acceptance (2026-10-13 autonomy directive)"

**(จ) เงื่อนไขเริ่ม execute (สืบทอดจากหัวเอกสาร UAT-EXECUTION-PLAN):** CTO merge การแก้ e2e-04 + battery r38+ ผ่านบน production runtime · CTO ปล่อยคิวเครื่อง · runtime = `http://localhost:3001` · บัญชี seed `uat.*@ltc.local` (รหัสเดียวจาก `UAT_DEMO_PASSWORD` · `bash scripts/uat-seed.sh` idempotent — รันซ้ำ = รีเซ็ตรหัสทุกบัญชีเป็นค่า env) · MFA: ระบบแสดง secret เป็นข้อความที่ `/my/security/enroll` — tester คำนวณ TOTP เองได้ · เก็บ secret ที่ `mfa/<บัญชี>.md` ห้าม commit

### 2.3 พื้นผิวจริงของ 5 ฟีเจอร์ (ตรวจกับ tree แล้ว 2026-10-13 — ให้สเปกอ้าง path จริงเหล่านี้)

| # | ฟีเจอร์ | เส้นทางหน้าจอ | ไฟล์จริง (อ่านอ้าง — ห้ามแก้) |
| --- | --- | --- | --- |
| F1 | ลืมรหัสผ่าน | `/forgot-password` → อีเมลรีเซ็ต (ตรวจที่ Mailpit :8025 / `GET /api/v1/messages`) → ลิงก์ → `/reset-password` | `src/app/(auth)/forgot-password/page.tsx` · `forgot-password-form.tsx` · `src/app/(auth)/reset-password/` (มี `reset-password-client.tsx` · `actions.ts`) |
| F2 | เปลี่ยนรหัสผ่าน | `/my/security` ปุ่ม "เปลี่ยนรหัสผ่าน" (page.tsx:308) — **มี step-up**: "การกระทำนี้ต้องยืนยันตัวตนสองชั้นภายใน 15 นาทีล่าสุด กรุณาออกจากระบบและเข้าสู่ระบบใหม่ แล้วลองอีกครั้ง" (page.tsx:70) — สเปกต้องกำหนด: ล็อกอินสองขั้นสด ๆ ก่อนทำขั้นนี้ | `src/app/(learner)/my/security/page.tsx` · `src/app/(learner)/my/security/password/actions.ts` |
| F3 | ออกจากระบบทุกเครื่อง | `/my/security` — ปุ่ม logout-all (คำอธิบาย: "ใช้เมื่อสงสัยว่ามีผู้อื่นเข้าใช้บัญชีของท่าน — ระบบจะยกเลิกการเข้าสู่ระบบทุกเครื่องรวมถึงเครื่องนี้" page.tsx:318) — พิสูจน์ 2 browser contexts: context B ตายด้วย | `src/app/(learner)/my/security/password/logout-all-button.tsx` · API `src/app/api/v1/auth/logout-all/route.ts` |
| F4 | โมดัล "+ เพิ่มกติกา version ใหม่" (รวม exam_review_mode = `after_final_attempt`/`never`) | `/admin/assessments` — โมดัลกติกา version ใหม่ | `src/components/admin/AssessmentRulesVersionModal.tsx` · schema `src/lib/schemas/v1/admin-exam.ts` (+ ทดสอบ `admin-exam.test.ts`) · API `src/app/api/v1/admin/assessments/[id]/rules/route.ts` |
| F5 | หน้ารายละเอียดคลังข้อสอบ | `/admin/question-banks/{id}` — ตารางข้อทั้งหมด **ไม่แสดงเฉลยในตาราง** · ปุ่ม "แก้ไข"/"เปลี่ยนสถานะ" ต่อข้อ (ตรง UAT-06 X-1) | `src/app/(admin)/admin/question-banks/[id]/page.tsx` · `bank-detail.server.ts` · `bank-detail.view.ts` · `EditQuestionModal.tsx` · `StatusConfirm.tsx` |

### 2.4 EXACT file list (WO-2 แตะเท่านี้)

| ไฟล์ | การกระทำ | เช็คกลาง |
| --- | --- | --- |
| `docs/07-results/UAT-09-SPECS-DRAFT.md` | **สร้างใหม่ (ไฟล์เดียวจบ)** | dir `docs/07-results/` มีอยู่ (SECURITY-REMEDIATION · SYSTEM-TEST · UAT · VA-PENTEST) · ยังไม่มีไฟล์ UAT-09* |

### 2.5 โครงสเปกที่กำหนด (PM เขียนตามโครงนี้)

- หัวเอกสาร: สถานะ DRAFT · runtime :3001 · เงื่อนไขเริ่ม (§2.2 จ) · ผู้รัน tester agent · **ผลนับเป็น verdict เสริม นอก 53 ขั้นบังคับของรอบหลัก** (A-4)
- 4 กลุ่มสคริปต์: **UAT-09A** ลืมรหัสผ่าน→รีเซ็ต (F1 · ใช้ Mailpit API ดึงลิงก์ · รีเซ็ตแล้วล็อกอินด้วยรหัสใหม่ + รหัสเก่าต้องถูกปฏิเสธ) · **UAT-09B** เปลี่ยนรหัสผ่าน + logout-all (F2+F3 · step-up MFA สด · 2 contexts · หลัง logout-all ต้อง login ใหม่ได้) · **UAT-09C** โมดัลกติกา version ใหม่ + exam_review_mode ทั้งสองค่า (F4 · บัญชี staff:exam · เปิดโมดัล ตรวจช่องครบ กด**ยกเลิก** ไม่บันทึกจริง — ทำนอง UAT-06 ขั้น 2b) · **UAT-09D** หน้ารายละเอียดคลัง (F5 · ตรวจตารางไม่เห็นเฉลย · เปิด EditQuestionModal แล้วปิดโดยไม่เปลี่ยนอะไร — ไม่กระทบข้อมูลของรอบหลัก)
- ทุกขั้นเขียนเป็น **Gherkin ไทย (Given/When/Then)** สไตล์ WAVE-J §5 + ตาราง click-level (ป้ายปุ่ม/เส้นทางจาก §2.3 + USER-MANUAL 1.3.0 `docs/08-manuals/USER-MANUAL.md`) + คอลัมน์หลักฐาน (step-XX.png) + แถว verdict
- การจัดลำดับกับข้อมูลรอบหลัก (**สำคัญ**): F1/F2 เปลี่ยนรหัสของบัญชี demo — ต้องรัน **หลังจบ UAT-01..08 ทั้งรอบ (P8)** หรือ รันแล้ว **re-seed** (`scripts/uat-seed.sh` idempotent = รีเซ็ตรหัสกลับเป็นค่า env) ก่อนกลับเข้าสคริปต์อื่น — สเปกต้องเขียนกฎนี้ไว้หน้าเอกสาร
- หมายเหตุธง stale (§2.2 ค) ทั้ง 5 ข้อ พร้อมวิธีแก้ผ่าน DCR **ตอน execute** (ไม่ใช่ตอนนี้)

### 2.6 ขั้นตอนแบบ test-first

1. สร้าง worktree (§0.1) · อ่านหน้าจอจริงของ 5 ฟีเจอร์ตามไฟล์ §2.3 (read-only) จดป้ายปุ่ม/ข้อความไทยที่แสดงจริง — สเปกห้ามเดาข้อความ UI
2. เขียน Gherkin scenario ทุกขั้น **ก่อน** เขียนตาราง click-level/หลักฐาน (test-first: สเปกนี้คือชุดเทสของรอบ execute)
3. เช็คครบแต่ละ scenario: มี Given/When/Then ครบ · มีคอลัมน์หลักฐาน · มีแถว verdict · อ้าง path จริงจาก §2.3 · กฎลำดับ P8/re-seed อยู่ครบ
4. Self-review กับ Gherkin checklist ของ PM: ทุก "Then" ตรวจได้จากหน้าจอ/ไฟล์หลักฐาน · ไม่มีขั้นที่ต้อง "วิเคราะห์" ตอน execute
5. Commit ลง branch · รายงาน PM-flow: อัปเดตแถว board (ผ่าน PM เท่านั้น) — WO จบที่การมีสเปกพร้อมรัน

### 2.7 DoD

**Worktree-local (จบงาน WO-2):**
- [ ] `docs/07-results/UAT-09-SPECS-DRAFT.md` ครบ 4 กลุ่มสคริปต์ (A–D) · Gherkin ครบทุกขั้น · อ้าง path/ป้ายปุ่มจริงตาม §2.3
- [ ] มีกฎลำดับ (P8 หลังรอบหลัก / re-seed remediation) + หมายเหตุธง stale 5 ข้อพร้อมทางแก้ผ่าน DCR ตอน execute
- [ ] ศูนย์ไฟล์อื่นถูกแตะ (`git -C D:/LTC-w2 diff --stat develop` = 1 ไฟล์) · ศูนย์โค้ด/สคริปต์/docker

**Post-close (deferred · CTO-gated):**
- [ ] tester agent execute UAT-09A–D บน :3001 หลัง UAT รอบหลักจบ (หรือตามกฎ re-seed ของสเปก) · verdict + หลักฐานครบ
- [ ] ธง stale ที่ยืนยันจริงจากการ execute → เปิด DCR แก้ UAT.md 1.0.2 (อัปเดตเลขทุนทดสอบ/runtime/เพิ่มอ้าง UAT-09) — ผ่าน gate Brief §9
- [ ] แถวรับมอบ owner-delegated team acceptance ของ UAT-09 บันทึกในรายงานรอบ

### 2.8 Out-of-scope fences

- ห้ามแก้ `docs/07-results/UAT.md` (ทั้งไฟล์ — แก้ผ่าน DCR ตอน execute เท่านั้น) · ห้ามแก้ USER-MANUAL
- ห้ามเขียน/แก้โค้ดเทสใด ๆ (Playwright script เป็นของตั๋ว execute ไม่ใช่สเปก) · ห้ามแตะ `tests/`, `src/`, `scripts/`, `docker/`, `.env*`, `package.json`
- ห้ามขยายเป็นสเปกฟีเจอร์อื่นนอก 5 ชิ้นของ §7 ข้อ 4–5 (เช่น อีเมลจริง/PDF ฟอนต์สวย = §6 มนุษย์ อยู่นอกเรื่อง)
- ห้าม execute อะไรเดี๋ยวนี้ (แม้แต่เปิด Mailpit)

### 2.9 ASSUMPTION (CTO confirm)

- **A-4**: UAT-09 = verdict เสริม (supplementary) — ไม่รวมเข้าตัวเลข 53 ขั้นบังคับของรอบหลัก · แถวรับมอบแยกต่างหากในตาราง §5 · CTO ยืนยันการนับนี้ตอน gate
- **A-6b (เล็กน้อย)**: บัญชีที่ใช้ทดสอบ F1/F2 = บัญชี demo ชุดเดิม (uat.citizen / uat.staff.exam) + การ re-seed เป็นทางกู้ — ไม่ขอเพิ่มบัญชี seed ใหม่ (การเพิ่ม = แตะ `scripts/uat-seed.sh` = ออกนอก fence)

---

## WO-3 · Lane J-UPGRADE-PREP (P2) — pre-stage next@16.3.5 ใน worktree (ตาม DCR-NEXT-UPGRADE-1635)

### 3.1 ตัวตนงาน

| | |
| --- | --- |
| Lane / Task id | J-UPGRADE-PREP (DCR-NEXT-UPGRADE-1635-DRAFT · backlog BL-005) |
| ผู้รับงาน | **main worker GLM-5.3** |
| Branch / Worktree | `feat/sprint2-j-upgrade-next-1635` · `D:/LTC-w3` (สร้างด้วยคำสั่ง §0.1 · DCR §4.1: "branch ใหม่… ห้ามยุบรวมกับ feature อื่น (เปลี่ยนทีละตัวแปร)") |
| ปัญหา | npm-audit ของ next ปัจจุบัน รับแบบ accept-with-expiry **2026-10-15** (D29 · postcss ≤8.5.22 high ผ่าน build chain ของ next) — ต้องอัปเกรดเป็น 16.3.5 · แต่การ execute เต็มสาย (integration/e2e/battery) ถูกกั้นไว้ "หลัง UAT ผ่าน" ตามชี้ขาด gate r1 (PROJECT-STATE:740) — งานที่ทำได้เดี๋ยวนี้คือ **pre-stage ให้พร้อม**: branch + bump + config + บันไดชั้นต้นแบบ worktree-local |
| User story | ในฐานะทีม ฉันต้องการ branch ที่ bump next@16.3.5 พร้อมงานบ้านทั้งหมดที่ไม่แตะ docker/DB เสร็จล่วงหน้า เพื่อให้รอบ execute เต็มสายหลัง CTO วินิจฉัยลำดับ (§9.2 R6) เหลือเพียง run บันไดขั้น 5–7 |

### 3.2 สัญญาสังเกตสำคัญ: ข้อยกเว้นต่อ constraint (b) — ต้องเข้าใจก่อนลงมือ

Lane charter (CTO) สั่งชัด: "branch + the dependency bumps + config/eslint changes" — งานนี้**จำเป็น**ต้องแก้ `package.json`/`package-lock.json`/(มีเงื่อนไข)`eslint.config.mjs` ซึ่งขัดกับ constraint (b) ของ Sprint 2 โดยตรง · ข้อยกเว้นนี้ **ผูกกับการแก้ใน branch ของ worktree `D:/LTC-w3` เท่านั้น** (main tree และ develop ไม่ถูกแตะจนกว่า merge หลัง CTO GO) — สถานะ: **A-5 รอ CTO ยืนยัน** · ถ้า CTO ไม่รับข้อยกเว้น = งานนี้เหลือเพียง "เตรียมคำสั่ง bump เป็นเอกสาร" แล้วหยุด

### 3.3 สัญญาเวอร์ชัน (verbatim จาก DCR §4 ข้อ 3 + §2 — ตรวจกับ package.json จริงแล้วทุกบรรทัดตรง)

**Bump (ครั้งเดียวจบ อย่าไล่ทีละรุ่น):**

| แพ็กเกจ | จาก (จริงใน tree) | เป็น | ตำแหน่ง |
| --- | --- | --- | --- |
| `next` | `^15.5.25` | `16.3.5` — **lockfile ผูก exact 16.3.5** | package.json:23 |
| `eslint-config-next` | `^15.5.25` | `16.3.5` — ขยับ **พร้อมกัน** ห้ามห่างเวอร์ชันกับ next | package.json:43 |
| `@types/react` | `^19.2.18` | ล่าสุดของสาย **19.2** (bump คู่กับ React ตามคู่มือ) | package.json:40 |
| `@types/react-dom` | `^19.2.0` | ล่าสุดของสาย **19.2** | package.json:41 |
| `react` / `react-dom` | `^19.2.0` | **คงเดิม** (ผ่านเงื่อนไข 16 แล้ว) | package.json:27-28 |
| `@types/node` | `^24.0.0` | **คงเดิม** (ผ่าน ≥20.9) | package.json:37 |
| `typescript` `^5.9.3` · `eslint` `^9.30.0` | — | **คงเดิม** (ผ่านเงื่อนไขของ 16 ทั้งคู่) | package.json:48 · :42 |

- คำสั่งติดตั้ง: `npm install` ปกติ — **ห้าม `--force` / `--legacy-peer-deps`** · "ถ้าชน peer ให้หยุดและรายงาน" (R5: repo อยู่ eslint 9.30 + @types/react 19.2.18 แล้ว — เงื่อนไขเข้าทาง)
- `engines.node`: `>=20` (package.json:7) → `>=20.9` — **รอคำวินิจฉัย CTO ข้อ §9.3** (A-6): เขียนไว้ใน branch ได้เป็น commit เดี่ยว `engines: >=20.9` เพื่อให้ revert เดี่ยวได้ · ห้ามปล่อยเป็นค่า `>=20` เดิมเมื่อ merge (Next 16 ขั้นต่ำ 20.9 — PROD-CHECKLIST "Node 20" เดิมตีความแคบเป็น 20.9+ เท่านั้น)
- **Docker dev image ไม่ต้องแตะ**: เป็น `node:22-alpine` อยู่แล้ว (docker/Dockerfile.dev:4) — และ `docker/` อยู่ในเขตห้ามของ Sprint 2 อยู่แล้ว (ตรงกันโดยบังเอิญ)

**Config ที่อนุญาตให้แก่ (มีเงื่อนไข):**

| ไฟล์ | กฎ |
| --- | --- |
| `next.config.ts` | **ไม่ต้องแก้** (§3.4: ทุก key ที่ 16 ลบ/เปลี่ยนไม่มีอยู่ในไฟล์ · securityHeaders/headers() เป็น API ที่ยังอยู่) — ห้ามแตะ |
| `eslint.config.mjs:81` | คง FlatCompat("next/core-web-vitals","next/typescript") ไว้ก่อน — สลับเป็น import `@next/eslint-plugin-next` ตรง ๆ ใน flat config ได้ **เฉพาะถ้า** `eslint .` แดงเพราะ plugin รุ่น flat-default · แก้เฉพาะจุดนี้เท่านั้น (custom rule ห้าม NEXT_PUBLIC_*SERVICE_ROLE* ที่ :77-88 ต้องยังทำงาน) |
| `src/middleware.ts` | **ห้ามแตะเด็ดขาด** — ไม่เปลี่ยนเป็น proxy.ts ในรอบนี้ (§3.2 คำตัดสินหลักของ DCR: middleware deprecated แต่ยังทำงานใน 16.x · ชั้น CSP nonce + CSRF + session rotation เป็น security-critical · ตั๋วตามแยก) · dev/build จะขึ้น deprecation warning — **ห้าม silence จดไว้ใน log รอบ upgrade** |
| codemod | **ห้ามรัน** `@next/codemod upgrade` (จะ "ช่วย" แปลง middleware→proxy ซึ่งขัด non-goal · bump ด้วยมือเพื่อคุม diff) |
| `cacheComponents`/`reactCompiler`/PPR | **ห้ามเปิด** ("not enabled merely to complete the upgrade") |

**พื้นผิวที่ DCR ยืนยันแล้วว่าไม่ต้องแก้โค้ด (§3.1/§3.5 — repo เขียน async ครบ):** `await cookies()` (src/lib/supabase/ssr.ts:88,166 · src/app/(auth)/actions.ts:224 · mfa-actions.ts:60) · `await headers()` (actions.ts:182 · reset-password/actions.ts:58 · credit-rules/page.tsx:98 · credits/page.tsx:94 · bank-detail.server.ts:67) · `params: Promise<…>` ใน 59 ไฟล์ route.ts ใต้ src/app/api/v1/** · `searchParams: Promise<…>` ทุกหน้า admin/auth · ไม่มี next/image · ไม่มี next/font · ไม่มี next/cache · ไม่มี parallel slots · Tailwind v4 ผ่าน `@tailwindcss/postcss` (ต้องพิสูจน์ด้วย build จริง)

**ความเสี่ยงที่ต้องเฝ้า (§7 ย่อ):** R1 build Turbopack ครั้งแรก (Tailwind v4/pdf-lib+qrcode · ทางถอยฉุกเฉิน `next build --webpack` เฉพาะ contingency) · R3 prefetch/routing rewrite → middleware ทำงานถี่ขึ้น (วัดจริงที่ battery ขั้น 7 — post-close) · R5 peer conflict (ห้าม legacy-peer-deps · ชน = หยุดรายงาน) · R6 กำแพงเวลา 2026-10-15 ทับช่วง "หลัง UAT" (เรื่องลำดับเป็นของ CTO — WO นี้ไม่ตัดสิน)

**Rollback (§6 คัดตรง):** "หนึ่ง merge commit ของงานอัปเกรด → `git revert` ตัวเดียวจบ + restore package-lock.json จาก commit ก่อน bump (lockfile คือตัวกัน drift ของ transitive deps)" · ไม่มี migration ข้อมูล/schema/infra · ถ้า rollback ต้องแจ้ง PM/CTO ต่ออายุ acceptance เป็นหน้าที่ของงาน

### 3.4 EXACT file list (WO-3 แตะเท่านี้ — ใน `D:/LTC-w3`)

| ไฟล์ | การกระทำ | เช็คกลาง |
| --- | --- | --- |
| `package.json` | แก้ (bump 4 แพ็กเกจ + engines.node) | ตรวจแล้ว: บรรทัด 7 · 23 · 40 · 41 · 43 ตรงตาม §3.3 |
| `package-lock.json` | แก้ (ผล `npm install` — lock ต้องผูก next exact 16.3.5) | tracked ใน git (ตรวจแล้ว) |
| `eslint.config.mjs` | แก้ **เฉพาะเมื่อ** `eslint .` แดงเพราะ flat-default (บันทึกเหตุไว้ในรายงาน) | อยู่ root · :81 FlatCompat · :77-88 custom rule |

- **ห้ามแตะ/ห้าม commit**: `src/**` ใด ๆ (แม้แต่ middleware.ts) · `tests/**` · `docker/**` · `docker-compose.yml` · `.env*` · `scripts/**` · `next.config.ts` · `next-env.d.ts` (untracked — จะถูก next regenerate ใน worktree เอง · ห้าม git add) · `tsconfig.tsbuildinfo`/`.next/` (build artifacts — ไม่ commit)

### 3.5 บันไดทดสอบ §5 ของ DCR — แยก worktree-local กับ deferred ชัดเจน

| ขั้น (ตาม DCR §5) | สิทธิ์ใน Sprint 2 | หมายเหตุ |
| --- | --- | --- |
| 0. ปักพฤติกรรมเดิมก่อน bump (§4.2 RED gate): ยืนยัน `src/middleware.test.ts` + suite ของ ssr.ts/cookies.ts มีอยู่และ**เขียวบน 15.5.25** | **worktree-local — ทำ** | `npm run test` ก่อน bump · บันทึกผลเขียวเป็น baseline (นี่คือ TDD ของ upgrade: เทส pin สัญญาเดิมต้องยังเขียวหลัง bump; แดง = API drift รายตัว) |
| 1. Unit RED gate: `npm run test` บน 16.3.5 | **worktree-local — ทำ** | เคสแดงต้องอธิบายได้ว่า API drift รายตัว — **"ห้ามแก้เทสให้ 'ผ่านเพราะง้อผล'"** · แดงและแก้ไม่ได้ไม่ใช้ --force = หยุดรายงาน CTO (การแก้ src/เทสจริง = ตั๋ว execute หลัง gate ไม่ใช่งาน prep) |
| 2. Typecheck: `npm run typecheck` | **worktree-local — ทำ** | 0 error — ยืนยัน typegen รุ่น 16 ไม่ขัด explicit `Promise` types |
| 3. Lint: `npm run lint` | **worktree-local — ทำ** | 0 error · custom rule ยังทำงาน · ใช้กฎ eslint.config.mjs มีเงื่อนไขของ §3.3 |
| 4. Build + proof: `next build` (Turbopack) + `scripts/prod-build-proof.mjs` | **ครึ่ง**: build = worktree-local **ทำ** (จด deprecation warning ของ middleware ตามกฎ · ยืนยัน `.next/BUILD_ID` เกิดใน worktree · ไม่มี metric size/First Load JS = ปกติ) · **proof script = deferred** (สคริปต์อ่าน `/app/.next/BUILD_ID` จาก container — ต้องรันใน docker = รอ post-close) | ทางถอยฉุกเฉิน `next build --webpack` เฉพาะ contingency ตาม R1 · จดเหตุ |
| 5. Integration: `npm run test:integration` เต็มบน dev stack :3000 (log `.omc/artifacts/`) | **deferred — post-close (CTO-gated)** | ต้อง docker dev stack |
| 6. Probe ห้าทิศ + e2e บน :3001 (`E2E_BASE_URL` ชี้ app-prod · e2e-04 CSRF/origin + ชุด logout/session PB-1) | **deferred — post-close (CTO-gated)** | ต้อง docker prod profile — เป็นของ close-ladder ตอนนี้ |
| 7. Battery rerun + D90 restart ("D90 เริ่มนับใหม่ 1/3" ตามชี้ขาด gate r1 · anchor ชุดใหม่) | **deferred — post-close (CTO-gated + รอคำวินิจฉัยลำดับ §9.2 R6)** | "งานนี้ทำ 'หลัง UAT ผ่าน' และ 'ก่อน deploy จริงทุกรูปแบบ'" (§8) |

หมายเหตุสภาพแวดล้อม worktree: `npm install`/`npm run test` ใน worktree เป็นงาน worktree-local ไม่แตะ docker/DB (unit 2,722 เทสรันได้บน runner ไร้ DB ตาม ci.yml gate 3 — เป็นหลักฐานว่าไร้ DB) · ถ้า suite ต้องการ env จริง: สร้าง `.env` ใน worktree จาก `.env.example` (untracked · **ห้าม commit ห้ามคัดลอกค่าจริงจาก main tree**) · จำเป็นต้องมีเครือข่ายถึง npm registry

### 3.6 ขั้นตอนแบบ test-first (ลำดับบังคับ)

1. สร้าง worktree (§0.1) · ตรวจ `git -C D:/LTC-w3 status` สะอาด · บันทึก SHA ตั้งต้น
2. **ก่อน bump**: `npm install` (lock เดิม) → `npm run test` — บันทึกผลเขียว (baseline ขั้น 0) — ถ้าแดงอยู่แล้วบน 15.5.25 = สภาพแวดล้อม worktree มีปัญหา หยุดแก้ env ก่อน (ห้ามแตะตัวเทส)
3. Bump ตามตาราง §3.3 (แก้ package.json ด้วยมือ — ไม่ใช้ codemod) → `npm install` (ห้าม force flags) · ถ้า peer conflict = **หยุด** รายงาน CTO (R5)
4. ไล่บันได worktree-local ตามลำดับ: unit → typecheck → lint (ถ้าแดงเพราะ flat-default → ใช้สิทธิ์แก้ eslint.config.mjs ตามเงื่อนไข) → build (จด warning + ยืนยัน BUILD_ID)
5. (เมื่อ CTO วินิจฉัย §9.3 แล้ว) commit `engines.node >= 20.9` เป็น commit เดี่ยว · จัด commits: (a) baseline log/หมายเหตุ (b) bump+lock (c) eslint มีเงื่อนไข (d) engines — แยกให้ revert เดี่ยวได้ตาม §6
6. เขียนรายงานใน commit message / ไฟล์โน้ตใน branch: ผลขั้น 0–4 · คำเตือนที่เจอ · เคสแดงใด ๆ พร้อมคำอธิบาย API drift · รายการ deferred 5–7 ที่รอคิว
7. **หยุดที่นี่** — ห้ามต่อขั้น 5–7 · ห้าม merge · ห้ามเปิด PR · push branch ได้ (A-9)

### 3.7 DoD

**Worktree-local (จบงาน WO-3):**
- [ ] branch `feat/sprint2-j-upgrade-next-1635` มี: bump 4 แพ็กเกจตรง §3.3 + lock ผูก next 16.3.5 exact + (มีเงื่อนไข) eslint.config.mjs + (รอ A-6) engines `>=20.9` — และ**ไม่มีไฟล์อื่นนอก §3.4** (`git -C D:/LTC-w3 diff --stat develop` ยืนยัน)
- [ ] บันไดขั้น 0–4 ครบตาม §3.5: baseline เขียวก่อน bump · unit/typecheck/lint/build ผ่านบน 16.3.5 (หรือมีรายงาน API drift ที่อธิบายได้ พร้อมหยุดตามกฎ)
- [ ] บันทึก deprecation warning ของ middleware ไว้ (ห้าม silence) · ไม่มี `--force`/`--legacy-peer-deps` ใน history
- [ ] ศูนย์การรัน docker/DB · ศูนย์การแตะ src/tests/scripts/docker/.env*

**Post-close (deferred · CTO-gated):**
- [ ] **P-1**: CTO วินิจฉัย §9 (ทั้งสี่ข้อ: middleware คงเดิม / นโยบายเวลา R6 / engines >=20.9 / เกณฑ์ D90 anchor ชุดใหม่) → DCR จาก DRAFT → APPROVED
- [ ] **P-2**: CTO วินิจฉัยลำดับ "หลัง UAT" (gate r1 · PROJECT-STATE:740/753) หรือเร่ง (ทางเลือก ข ของ R6) — จังหวะ execute ขั้น 5–7 เป็นไปตามคำวินิจฉัยนี้เท่านั้น
- [ ] **P-3**: rebase branch ลง develop หลัง close drained (แก้ conflict lockfile ถ้ามี) → บันไดขั้น 5–7: integration เต็ม → probe+e2e :3001 → battery + D90 1/3 (anchor ชุดใหม่) → merge · ปิด BL-005 · อัปเดต DCR/PROJECT-STATE
- [ ] ตั๋วตามแยก (ไม่ใช่ WO นี้): ศึกษา middleware→proxy บน Node runtime หลัง 16.3.5 นิ่ง (§3.2)

### 3.8 Out-of-scope fences

- ห้ามแก้ `src/middleware.ts`/เปลี่ยนชื่อเป็น proxy · ห้าม codemod · ห้ามเปิด cacheComponents/reactCompiler/PPR · ห้ามแก้ business logic ใต้ `src/app/**`, `src/lib/**`
- ห้ามแก้เทสใด ๆ ให้ผ่าน ("ห้ามแก้เทสให้ผ่านเพราะง้อผล" §5.1) · การแก้ src/เทสจริงเพราะ API drift = ตั๋ว execute หลัง gate
- ห้ามรันขั้น 5–7 (docker/DB/battery) · ห้าม merge/PR · ห้ามอัปเดต PROJECT-STATE/backlog จากเลนนี้ (PM ทำตอน gate)
- ห้ามตัดสินเรื่องเวลา/ลำดับ R6 เอง · ห้ามต่ออายุ acceptance 2026-10-15 เอง (เป็นหน้าที่ PM/CTO ตาม §6)

### 3.9 ASSUMPTION (CTO confirm)

- **A-5**: ข้อยกเว้น constraint (b) สำหรับ `package.json`/`package-lock.json`/`eslint.config.mjs` — ผูกกับ worktree branch เท่านั้น (§3.2)
- **A-6**: `engines.node >=20.9` พร้อมทิศทาง OQ-11 = Node 22.x ทั้งสาย (CI=UAT:3001=prod) — รอคำวินิจฉัย §9.3
- **A-7**: การ execute ขั้น 5–7 + D90 restart รอคำวินิจฉัยลำดับหลัง UAT ของ CTO (§8/§9.2) · ถ้า CTO สั่งเร่ง (ทางเลือก ข) prep ชุดนี้ merge ได้ทันที — งาน prep เหมือนกันทุกกรณี
- **A-8**: ฐาน branch = `develop`@`65fbac9` (ก่อน merge ของ close) · ต้อง rebase หลัง close drained ก่อน CTO review (ขั้น P-3) — lockfile conflict บริหารตอนนั้น
- **A-9** (ทุกเลน): push branch ขึ้น remote ได้ (git transport ใช้ได้ตาม retro #7) แต่**ห้ามเปิด PR** จนกว่า CTO gate ผ่าน

---

## 9. ASSUMPTION Register (สรุปรวม — สำหรับ CTO gate ครั้งเดียว)

| # | เลน | สมมติฐาน | ผลถ้า CTOไม่ยืนยัน |
| --- | --- | --- | --- |
| A-1 | J-CI | lane charter ของ CTO = คำรับรองเบื้องต้นของ owner สำหรับค่าใช้จ่าย runner (retro #3 สิทธิ์ owner) — workflow เปิดเป็น `workflow_dispatch` อย่างเดียวจนกว่า owner ยืนยัน | DCR/YAML เขียนได้อยู่ · แต่ merge+trigger จริงหยุดรอ |
| A-2 | J-CI | integration บน runner ใช้ localhost `TEST_*` env ได้ครบไม่ต้องมี secret จริง | ถ้า harness ต้องการอย่างอื่น → ปรับ DCR ก่อน merge |
| A-3 | J-CI (+เชื่อม WO-3) | Node 22 สำหรับ workflow ใหม่ (ตรง ci.yml ปัจจุบัน + ทิศ OQ-11) | รอ OQ-11 ปิด — ไม่บล็อกการเขียน DCR (ระบุเป็นตัวแปร) |
| A-4 | J-UAT09 | UAT-09 = verdict เสริม นอก 53 ขั้นบังคับของรอบหลัก · แถวรับมอบแยก | ตัวเลขรวมรอบหลักไม่เปลี่ยนไม่ว่ากรณี — แค่รูปแบบตารางรายงาน |
| A-5 | J-UPGRADE-PREP | ข้อยกเว้น constraint (b): แก้ package.json/package-lock.json/eslint.config.mjs ได้ใน worktree branch เท่านั้น | เลนเหลือเพียงเอกสารคำสั่ง bump (ไม่ลงมือ) — เสียเวลา lead สำคัญ |
| A-6 | J-UPGRADE-PREP | engines `>=20.9` + Node 22 ทั้งสาย (รอ §9.3) | commit engines ถูก revert เดี่ยวได้ (ออกแบบไว้แล้ว) |
| A-7 | J-UPGRADE-PREP | execute ขั้น 5–7 รอคำวินิจฉัยลำดับ "หลัง UAT" (§8) — prep ไม่ขึ้นกับผลการวินิจฉัย | ไม่มีผลต่องาน prep |
| A-8 | J-UPGRADE-PREP | ฐาน develop@65fbac9 + rebase หลัง close drained | เป็นค่าเริ่มต้นที่ถูกต้องอยู่แล้วตามสถาปัตยกรรมขนาน |
| A-9 | ทุกเลน | push branch ได้ · ห้าม PR/merge ก่อน gate | — |

## 10. ความขัดกันของเอกสารต้นทางที่พบ (DCR-style — **แจ้งอย่างเดียว ไม่แก้**)

| # | จุดขัด | รายละเอียด | ผลต่อ Sprint 2 |
| --- | --- | --- | --- |
| C-1 | directive เอง vs lane charter | owner constraint (b) "ศูนย์ไฟล์ใน package.json" ขัดกับ J-UPGRADE-PREP charter "dependency bumps + config/eslint changes" โดยเนื้อแท้ | บริหารด้วย A-5 (worktree-scoped exception) — ต้องมีคำรับรอง CTO จึงชอบธรรม |
| C-2 | WAVE-J-PLAN-DRAFT ภายใน | §3.1 T-3 วางอัปเกรด next@16.3.5 เป็นงาน "ปิดวันนี้ 2026-10-13" ขณะที่ §4 (คำถาม 1) ยังถาม CTO ว่าจะทำ T-3 วันนี้ไหม · และ DCR-NEXT-UPGRADE §8 + ชี้ขาด gate r1 (PROJECT-STATE:740) ฟันเป็น "หลัง UAT ผ่าน" — แผนหลักยังเก็บทั้งสองลำดับไว้โดยไม่กระทบคำชี้ขาด | A-7 รอคำวินิจฉัยเดียวจาก CTO (R6 ทางเลือก ก/ข) — WO-3 ออกแบบให้ทนทานต่อทั้งสองทาง |
| C-3 | WAVE-J §0 ข้อ 1 vs §4 คำถาม 2 | เงื่อนไข LAUNCH-COMPLETE ข้อ 1 อยาก D90 3/3 "ตามเกณฑ์ verdict wavei-r3" แต่คำถาม 2 เสนอเริ่มนับ D90 ใหม่หลังอัป next — ยังไม่มีการเลือก | ไม่บล็อก prep · เป็นเงื่อนไขของขั้น P-2/P-3 |
| C-4 | เวอร์ชัน PROD-CHECKLIST ลอย | WAVE-J header อ้าง 1.0.2 · DCR-PROD-DEPLOY อ้าง 1.0.3 ("ทุกข้ออ้างไฟล์:บรรทัดตรวจแล้ว") | J-CI/J-UPGRADE อ้างแบบไม่ผูกเวอร์ชัน · ให้ CTO ฟันเวอร์ชัน plan-of-record ตอน gate |
| C-5 | Node สามค่า | PROD-CHECKLIST §4 "Node 20" · ci.yml จริง `node-version: 22` · engines `>=20` — OQ-11 (+ DCR-NEXT-UPGRADE §8) เสนอ 22 ทั้งสาย + engines 20.9+ | A-3/A-6 ขอคำวินิจฉัยเดียวปิดทั้งสาย |
| C-6 | ตัวเลขทุนทดสอบใน UAT.md | UAT.md ท้ายเล่มอ้าง e2e 34/34 + integration 173 · ปัจจุบัน 42/326 (WAVE-J §1) — ลงทะเบียน stale ไว้แล้วใน UAT-EXECUTION-PLAN §7.2 | WO-2 บันทึกธงนี้ · แก้จริงผ่าน DCR ตอน execute |
| C-7 | อ้าง file:line ใน DCR-PROD-DEPLOY ขัดตัวเอง (เล็กน้อย) | email-dispatch อ้าง route.ts:86-90 (§1 แถว 8) แต่ §2.2 อ้าง route.ts:85-88 | ไม่กระทบ WO ใด — จดไว้ให้เจ้าของเอกสาร (devops) ตรวจตอนทำ permanent |

---

*ท้ายเอกสาร — เขียนโดย PM · 2026-10-13 · ทุกอ้างอิง file:line ตรวจกับ working tree จริง (develop@65fbac9) ก่อนเขียนแล้ว · สถานะทั้งหมดเป็น DRAFT รอ CTO gate ตามธรรมนีย์ D70/D71 — ห้ามเริ่ม execute ส่วน deferred ก่อนคำประกาศ close drained*

---

## 11. CTO GATE (ลงมติ 2026-10-14 · CTO seat = orchestrating session)

**ASSUMPTION rulings:**

| # | คำวินิจฉัย |
|---|-----------|
| A-1 | **ยืนยัน** — lane charter ของ CTO = คำรับรองเบื้องต้นทางเทคนิค; trigger จริง (PR/push) ห้ามเปิดจนกว่า owner ให้สัตยาบันค่าใช้จ่าย runner · `workflow_dispatch` อย่างเดียวตามแผน |
| A-2 | **ยืนยัน** — binding: ตรวจกับ `vitest.integration.config.ts` จริงระหว่างเขียน DCR · ถ้าต้องการอย่างอื่น = หยุดรายงาน · ห้ามค่าจริง/canonical ใดใน YAML/DCR เด็ดขาด |
| A-3 | **ยืนยัน** — Node 22 (ผูกกับคำวินิจฉัย OQ-11: 22 ทุกชั้น) |
| A-4 | **ยืนยัน** — UAT-09 = verdict เสริม · 53 ขั้นบังคับของรอบหลักคงเดิม |
| A-5 | **ยืนยัน** — ข้อยกเว้น constraint (b) ผูก worktree branch `D:/LTC-w3` เท่านั้น · เจตนาของ constraint คือปกป้อง main tree + close-ladder — worktree แยกไม่กระทบ |
| A-6 | **วินิจฉัย §9.3 ตอนนี้**: `engines >=20.9` commit เดี่ยว revert ได้ · Node 22 ทั้งสาย (CI=UAT:3001=prod) ตาม OQ-11 |
| A-7 | **วินิจฉัย R6 ทางเลือก ก**: execute ขั้น 5–7 **หลัง UAT ผ่าน ก่อน deploy จริง** (ตามชี้ขาด gate r1 เดิม) · prep เดินเลย |
| A-8 | **ยืนยัน** — ฐาน develop@65fbac9 · rebase หลัง close drained โดยคำสั่ง CTO |
| A-9 | **ยืนยัน** — push branch ได้ · ห้าม PR/merge ก่อน gate |

**Contradiction dispositions:** C-1 ปิดด้วย A-5 · C-2/C-3 ปิดด้วยคำวินิจฉัย A-7 + D90-restart-post-upgrade (ชี้ขาตุลาการไปแล้ว PROJECT-STATE) · **C-4: plan-of-record = PROD-CHECKLIST 1.0.3** (ฉบับตรวจ file:line แล้ว) · C-5 ปิดด้วย OQ-11+A-6 · C-6/C-7 คงไว้แก่ DCR-at-execution ตามข้อเสนอ PM

**Parallel plan:** ยืนยันตาราง §0.2 — ศูนย์ไฟล์ซ้อนทุกคู่ · ลำดับ merge หลัง close drained: **WO-2 → WO-1 → WO-3** (WO-3 รอ P-2/P-3 ของตัวเอง)

**สั่งปล่อยงาน:** WO-1 → devops worker (Flash) · WO-2 → PM authoring · WO-3 → main worker (GLM-5.3) — ทั้งสามเริ่มได้ทันที (worktree-local เท่านั้น)

**Post-QA rulings (2026-10-14 · ทั้งสามเลน QA APPROVE):**
- **WO-3 P2 (next 16.0.0–16.3.7 critical advisory ใน prod scope — pin 16.3.5 อยู่ในช่วง):** วินิจฉัย **pin bump ไปรุ่นที่แก้ (≥16.3.8) ที่ execute lane P-3** — ทำก่อน battery D90-restart ไม่กี่นาที (bump คู่ next+eslint-config-next lockstep + ladder worktree-local รอบเดียว) เพื่อให้ D90 นับใหม่บน runtime ปลอด audit — **ไม่ใช้ accept-with-expiry** (เลนนี้เกิดมาเพื่อปิดกรณีแบบนั้น ห้ามสร้างซ้ำทันที) · ผูกเป็นเงื่อนไข binding ของ P-3
- WO-3 P3: `@eslint/eslintrc` ตายหลังถอด FlatCompat — เก็บใน execute lane · nodemailer(moderate)/sharp(high, transitive ผ่าน next/og ที่ไม่ใช้งาน)/source-map-js(high, transitive) — จด disposition ในรายงานปิดสปรินต์ (sharp/source-map = non-applicable-at-runtime with evidence; nodemailer = จดไว้กับ deploy lane ที่ prod สลับ resend)
- P3 ของ WO-1/WO-2 พับตอน merge ตามที่ QA ระบุ

*— CTO (orchestrating session) · 2026-10-14*
