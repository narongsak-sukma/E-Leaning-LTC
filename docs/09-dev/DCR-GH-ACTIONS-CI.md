# DCR GitHub Actions CI — serial integration ladder บน runner (Sprint 2 · WO-1 · Lane J-CI)

| | |
| --- | --- |
| สถานะ | **DRAFT — รอ CTO gate** (implementation-in-waiting: trigger `workflow_dispatch` อย่างเดียวตาม A-1 · ห้ามเปิด trigger จริง/merge จนกว่า CTO GO + owner ให้สัตยาบันค่าใช้จ่าย runner) |
| ผู้เขียน | devops worker (WO-1) · 2026-10-14 · worktree `D:/LTC-w1` branch `feat/sprint2-j-ci` จาก `develop@65fbac9` |
| ที่มา | TEAM-ENHANCEMENT-RETRO §2 แถว 3 ("top efficiency item" · คอขวดอันดับ 1) + DCR-PROD-DEPLOY-DRAFT §5.1 (สาย CI) + backlog BL-015 (กฎ no-overlap) + CTO gate 2026-10-14 (A-1/A-2/A-3 ยืนยัน) |
| ไฟล์ใน scope | `docs/09-dev/DCR-GH-ACTIONS-CI.md` (ไฟล์นี้ · ใหม่) · `.github/workflows/ci-integration.yml` (ใหม่) — อื่นศูนย์ไฟล์ |
| หลักฐานลำดับเขียน (test-first) | commit แรกของไฟล์นี้มีเฉพาะ **Acceptance criteria (Gherkin)** — YAML เขียนทีหลังและถูกตรวจกับ Gherkin ทีละข้อ (trace ที่ §10) · history ของ branch เป็นพยาน |

---

## 1. ปัญหา

บันไดตรวจรับ (integration full-suite + battery) รอเครื่อง local เครื่องเดียว ~3.5–4.5 ชม./รอบ merge (retro §1 วัดจริง: full-suite 35 ไฟล์ 2189–2461 วิ · battery 30–60+ นาที) · ชนกับงานภายนอก (โปรเซสอื่นเคยดัน CPU 100% จน suite แดง) · เครื่องสำรองช้ากว่า 3–4 เท่าและเคยก่อคลัสเตอร์ล้มของ BL-015 (H1) — ย้าย suite ยาวขึ้น GitHub Actions runner = **ไม่แย่งคิวเครื่อง + ไม่โดนงานภายนอก + รันคู่ขนานกับงานทีม** แม้ runner 2 คอร์จะไม่เร็วกว่าต่อรอบ

ขอบเขตของ WO นี้ = **Phase 1 เท่านั้น**: workflow `ci-integration.yml` สำหรับ integration full-suite แบบอนุกรมบน runner-hosted compose · อยู่ในสถานะ implementation-in-waiting (trigger มือ) จนกว่า owner ให้สัตยาบันค่าใช้จ่าย (A-1) — battery/e2e เป็น Phase 2 (§7) · deploy เป็น Phase 3 (นอก scope · DCR-PROD-DEPLOY §5.1)

---

## 2. Grounding ที่อ่านจริง (read-only · ณ develop@65fbac9)

| ไฟล์ | ข้อเท็จจริงที่ใช้ออกแบบ |
| --- | --- |
| `.github/workflows/ci.yml` | รูปแบบที่ต้องสืบทอด: `permissions: contents: read` · `defaults.run.shell: bash` · checkout pin `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2) · `setup-node@v4` + `node-version: 22` + `cache: npm` · env placeholder `ci-placeholder*` · `timeout-minutes: 20` · concurrency `ci-${{ github.event_name }}-${{ github.ref }}` + cancel — **workflow ใหม่ไม่แตะ concurrency นี้เลย** |
| `package.json:16` | `test:integration` = `vitest run --config vitest.integration.config.ts` |
| `vitest.integration.config.ts` | include เฉพาะ `tests/integration/**/*.test.ts` · **`fileParallelism: false`** (อนุกรมระดับไฟล์ — ใน config จริง ไม่ต้องทำใน YAML) · `testTimeout` 30 วิ · `hookTimeout` 60 วิ · env chain: shell → `.env` → `.env.example` · **บรรทัด 15: ไม่มี `TEST_DATABASE_URL` = skip ทั้งชุด (describe.skipIf) แล้วเขียว** ← ที่มาของ silent-skip guard (AC-6) |
| `tests/integration/` | 34 ไฟล์ `.test.ts` ณ develop@65fbac9 (retro วัดไว้ 35 — เลน close อาจเพิ่ม/ลด · workflow นับจาก include ของ config ไม่ hardcode) · ค้น env ที่ใช้จริง: `TEST_DATABASE_URL` (41 จุด) · `TEST_USER_PASSWORD` (helpers.ts:23 → TEST_PASSWORD) · `TEST_APP_URL` (default `http://localhost:3000`) · `TEST_MAILPIT_URL` (default `http://localhost:8025`) · `TEST_SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY` · `TEST_REQUIRE_APP` (=1 → app ไม่พร้อม = **fail** ไม่ skip — 19 จุด `requireAppOrSkip`) · `TEST_IP` เป็น constant ในไฟล์เทส ไม่ใช่ env |
| `docker-compose.yml` | dev stack default-profile: `db auth rest storage imgproxy kong mailpit app mailer db-migrate` · `app-prod` อยู่ profile `prod` (ไม่โดน) · db เปิด host port `${POSTGRES_HOST_PORT:-5432}` (`.env.example` ตั้ง 54322) · kong :8000 · mailpit :8025 · app :3000 (healthcheck `/api/health`) · db-migrate one-shot idempotent (migrations + seed ทุกครั้ง) |
| `.env.example` | กลุ่ม TEST_* ครบ: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres` · `TEST_SUPABASE_URL=http://localhost:8000` · anon/service role key = **JWT dev placeholder ทางการของ local** (ไฟล์หัวเอกสารยืนยัน "ไม่มี secret จริง") · `TEST_USER_PASSWORD=Integration#2026` (GoTrue min 12) · `POSTGRES_HOST_PORT=54322` |
| `docker/kong/kong.yml` | kong route `storage-v1 → http://storage:5000` — เทสที่ยิง storage ผ่าน kong จึงต้องมี `storage` + `imgproxy` ขึ้นด้วย |
| `docker/db/migrate.sh` | one-shot: ตั้งรหัส service roles → apply `supabase/migrations/*.sql` เรียงชื่อไฟล์ → seed `supabase/seed.sql` · idempotent ทั้งหมด · exit code ตามผล apply |
| `tests/integration/d8-exam-cert-flow.test.ts`, `dcr12-p5r1-hardening.test.ts` | ยิง `/storage/v1/...` จริงผ่าน kong → ยืนยันว่าต้องมี storage service |
| retro §1 + §2 แถว 3 | ตัวเลข ground truth ของ budget (§6) · สิทธิ์อนุมัติ: owner (ค่าใช้จ่าย) + CTO (เทคนิค) |
| backlog BL-015 | กฎบทเรียน: "ห้ามรันสวีทซ้อน + long run ใช้ detached launcher เท่านั้น" (local) — แปลเป็น concurrency เดี่ยวบน runner (§5.3) · บทเรียน H1 (เครื่องช้าทำ race window เพี้ยน) กลายเป็นความเสี่ยงที่ต้องเฝ้าบน runner (§8) |
| DCR-PROD-DEPLOY-DRAFT §1 แถว 2 + §5.1 | §1 แถว 2: ค่า canonical ของ prod (VA-PENTEST V14.2.x) ห้ามใช้ — ที่นี่ใช้ได้เฉพาะ placeholder local เท่านั้น · §5.1: โครงสาย CI "integration (ใหม่): ปั้น service db/auth/rest/kong ด้วย compose บน runner → TEST_DATABASE_URL ชี้ localhost → npm run test:integration" |

---

## 3. ผลตรวจ ASSUMPTION A-2 กับ harness จริง (CTO ruling: ตรวจขณะเขียน DCR · ถ้าเกิน localhost TEST_* = หยุดรายงาน)

**ผล: A-2 ยืนยันได้ — ไม่ต้อง STOP** · harness ต้องการ env ครบชุดต่อไปนี้ ทุกตัวชี้ localhost-of-runner หรือเป็นค่า placeholder local ทางการจาก `.env.example` (ไม่มี secret จริงใด · ไม่มีค่า canonical V14.2.x ใด):

| env | ค่าบน runner | ที่มา/เหตุผล |
| --- | --- | --- |
| `TEST_DATABASE_URL` | `postgresql://postgres:postgres@localhost:54322/postgres` | .env.example · พอร์ต 54322 ตรง `POSTGRES_HOST_PORT` ของ compose |
| `TEST_SUPABASE_URL` | `http://localhost:8000` | kong ของ dev stack |
| `TEST_SUPABASE_ANON_KEY` | JWT dev placeholder จาก `.env.example` | ค่าทางการของ local (ไม่ใช่ canonical prod) |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | JWT dev placeholder จาก `.env.example` | ค่าทางการของ local |
| `TEST_USER_PASSWORD` | `Integration#2026` | .env.example (GoTrue `GOTRUE_PASSWORD_MIN_LENGTH: 12`) |
| `TEST_APP_URL` | `http://localhost:3000` | ชี้ชัด (default เดิมเท่ากัน) — app container ของ dev stack |
| `TEST_MAILPIT_URL` | `http://localhost:8025` | ชี้ชัด (default เดิมเท่ากัน) — dcr15/dcr16 อ่านอีเมลจาก Mailpit API |
| `TEST_REQUIRE_APP` | `1` | **ตั้งเองตาม semantics ของเทส (battery §2.4)** — app ไม่พร้อม = ล้มทันที ห้าม skip เงียบ · CI ปั้น app เองจึงรับผิดชอบได้ |

**ข้อค้นพบเชิง scope (บันทึกแจ้ง CTO — ไม่ใช่เงื่อนไข STOP เพราะไม่เกิน localhost/placeholder):** สเก็ตช์ของ DCR-PROD-DEPLOY §5.1 เขียนไว้ "ปั้น service db/auth/rest/kong" — ตรวจกับเทสจริงแล้ว **ไม่พอ**: (1) 19 จุด `requireAppOrSkip` ใน 9 ไฟล์ BFF ต้องการ app ที่ `localhost:3000` — ถ้า app ไม่ขึ้น เคสพวกนี้ **skip เงียบแล้ว suite ยังเขียว** (2) dcr15/dcr16 ต้องการ Mailpit (`:8025`) (3) d8-exam-cert-flow/dcr12 ยิง `/storage/v1` ผ่าน kong ต้องการ `storage` + `imgproxy` จึงปั้น **default-profile ครบชุด** (db auth rest storage imgproxy kong mailpit app db-migrate) และกัน skip เงียบด้วย `TEST_REQUIRE_APP=1` + silent-skip guard ของ AC-6 — ส่วน `mailer` (curl loop ปลุก cron) ไม่จำเป็นต่อเทสแต่มากับ `docker compose up` default อยู่แล้วโดยไม่รบกวน (CRON_SECRET ว่าง = รอ config ตาม compose จริง)

---

## 4. Acceptance criteria (Gherkin) — **เขียนก่อน YAML ทุกบรรทัด** (commit แรกของไฟล์นี้ = พยานลำดับ)

```gherkin
# ภาษา: อ้าง config/โค้ดจริงตาม §2 · ทุก Then ตรวจได้จาก log/summary ของ GitHub Actions

Feature: serial integration ladder บน GitHub Actions runner (.github/workflows/ci-integration.yml)
  ในฐานะทีมพัฒนา ฉันต้องการให้ integration full-suite รันบน runner แบบอนุกรม
  เพื่อไม่แย่งคิวเครื่อง local และตัดเหตุ suite แดงจากงานภายนอก

  # ---- (a) ข้อบังคับ WO §1.5.2 ข้อ a — ครบทุกไฟล์ อนุกรม เขียว ----
  Scenario: workflow รัน integration ครบทุกไฟล์แบบอนุกรมและเขียว
    Given runner ได้โค้ดของ branch ที่ถูก dispatch พร้อม docker engine
    When ผู้ใช้ trigger workflow ด้วย workflow_dispatch
    Then job ปั้น dev stack default-profile ครบ (db auth rest storage imgproxy kong mailpit app db-migrate)
    And db-migrate (migrations + seed) จบด้วย exit 0 ก่อนเทสเริ่ม
    And app ตอบ health 200 ที่ TEST_APP_URL ก่อนเทสเริ่ม
    And job รัน "npm run test:integration" ซึ่ง include ทุกไฟล์ tests/integration/**/*.test.ts
    And การรันเป็นแบบอนุกรมระดับไฟล์ (fileParallelism: false จาก vitest.integration.config.ts)
    And เมื่อ job เขียว ต้องมีรายงานใน step summary ว่า "N passed" โดย N > 0 พร้อมจำนวนไฟล์ที่รัน

  # ---- (b) ข้อบังคับ WO §1.5.2 ข้อ b — concurrency แบบคิว ----
  Scenario: รอบใหม่ที่เข้ามาขณะมีรอบกำลังรัน = เข้าคิว ไม่ cancel
    Given มีรอบของ workflow นี้กำลังรันอยู่บน runner หนึ่งรอบ
    When มีการ trigger รอบใหม่ของ workflow เดียวกัน
    Then รอบใหม่ต้องอยู่สถานะ queued (concurrency group เดียวทั้ง workflow)
    And รอบที่กำลังรันต้องไม่ถูกยกเลิก (cancel-in-progress: false)
    And กลไกนี้ต้องไม่กระทบ concurrency ของ ci.yml เดิมในทุกกรณี

  # ---- (c) ข้อบังคับ WO §1.5.2 ข้อ c — ศูนย์ secret จริง ----
  Scenario: ไม่มี secret จริงใดใน log/artifact
    Given workflow นี้ไม่อ้าง `secrets.*` ใดเลยแม้แต่ตัวเดียว
    And env ทั้งหมดของ job เป็นค่า localhost หรือ placeholder local ทางการจาก .env.example ตามตาราง §3
    When รอบใด ๆ รันบน runner
    Then แม้ log จะพิมพ์ค่า env ออกมาครบทุกตัว ก็ไม่มีค่ารั่วที่เป็นความลับจริง (ทุกค่าเป็นค่า dev public อยู่แล้ว)
    And ไม่มีการ upload artifact ใดใน workflow ชุดนี้ (Phase 1 — log ของ run เป็นหลักฐานพอ)

  # ---- (d) ข้อบังคับ WO §1.5.2 ข้อ d — trigger มือเท่านั้น ----
  Scenario: trigger เริ่มต้น = workflow_dispatch เท่านั้น
    Given ไฟล์ .github/workflows/ci-integration.yml ในสถานะที่ WO-1 ส่งมอบ
    When พิจารณา key "on:" ของไฟล์
    Then ต้องมีเพียง "workflow_dispatch" ตัวเดียว
    And ต้องไม่มี pull_request / push / schedule ใด ๆ (A-1 — ห้ามเปิดจนกว่า CTO สั่งหลัง owner ให้สัตยาบัน)

  # ---- (e) ข้อบังคับ WO §1.5.2 ข้อ e — fail ต้องชี้ไฟล์แดง ----
  Scenario: งาน fail = summary บอกไฟล์/ชุดที่แดง
    Given รอบ integration กำลังรันอยู่
    When มีไฟล์เทสใดล้ม (หรือ step ใดของ job ล้ม)
    Then step summary ต้องแสดงรายชื่อไฟล์ .test.ts ที่แดงแบบ unique (sort แล้ว)
    And job ต้องจบด้วย exit code ไม่เป็นศูนย์

  # ---- เสริมจากข้อเท็จจริงของ harness (§2/§3) — กันเขียวลอย ----
  Scenario: silent-skip guard — "0 passed" ถือว่าล้มแม้ exit 0
    Given vitest.integration.config.ts skip ทั้งชุดเมื่อไม่มี TEST_DATABASE_URL (บรรทัด 15)
    When รอบ integration จบด้วย exit 0 แต่ summary รายงาน 0 passed (หรือไม่พบบรรทัดสรุป passed)
    Then step ต้องตัดสินเป็น fail ด้วยข้อความ ::error ที่ชี้เหตุ silent-skip
    And job ต้องจบด้วย exit code ไม่เป็นศูนย์

  Scenario: app ล้มกลางรอบ = fail ไม่ใช่ skip
    Given job ตั้ง TEST_REQUIRE_APP=1 (semantics battery §2.4 ของเทสเอง)
    When app ไม่ตอบที่ TEST_APP_URL ขณะเคส BFF กำลังรัน
    Then เคสเหล่านั้นต้อง fail ตาม requireAppOrSkip ไม่ใช่ skip
    And ผลลัพธ์ปรากฏเป็นไฟล์แดงใน summary ตาม Scenario (e)

  Scenario: teardown ของ stack ทำงานไม่ว่าผลรอบจะเป็นอะไร
    Given รอบ integration จบไม่ว่าเขียวหรือแดง
    Then stack ถูกลบด้วย docker compose down -v --remove-orphans ใน step ที่มี if: always()
```

---

## 5. การออกแบบ (ครบทุกหัวข้อ §1.3 ของ lane charter)

### 5.1 ด่านไหนขึ้น runner ด่านไหนอยู่ local — ตาราง "อะไรรันบนไหน"

| ด่าน/ชุด | ที่รัน | เจ้าของไฟล์ | หมายเหตุ |
| --- | --- | --- | --- |
| lint · typecheck · unit test · build · gitleaks | **runner อยู่แล้ว** (`ci.yml` — pull_request/push/workflow_dispatch) | `.github/workflows/ci.yml` (ห้ามแก้ใน WO นี้) | คงเดิมทุกอย่าง — concurrency ของ ci.yml ไม่ถูกแตะ |
| integration full-suite (อนุกรม) | **runner ใหม่** (`ci-integration.yml` — `workflow_dispatch` เท่านั้น Phase 1) | `.github/workflows/ci-integration.yml` (ใหม่) | ปั้น dev stack บน runner-hosted compose — รายละเอียด §5.2 |
| mirror ท้องถิ่นของ 5 gates | local | `scripts/ci-local.sh` (อ่านอย่างเดียว) | ไม่เปลี่ยน — ยังเป็น pre-push ชั้นแรก |
| battery (e2e 13 stages + identity) | **local ต่อไป** จนกว่า Phase 2 | close-ladder (เครื่องเป็นเจ้าของ) | ออกแบบไว้แล้วใน §7 แต่**ยังไม่สร้างไฟล์**ใน WO นี้ |
| UAT/probe ห้าทิศ | local | close-ladder / PM | นอก scope |

ผลที่ต้องการของ retro #3 ตอบครบด้วยตารางนี้: suite ยาวที่ขึ้น runner แล้ว**ไม่แย่งคิวเครื่อง** · **ไม่โดนงานภายนอก**ของเครื่อง (คนละเครื่องกัน) · **รันคู่ขนานกับงานทีม**ได้ (dispatch ได้ทุกเมื่อ — คิวอนุกรมเฉพาะกัน runner เอง ตาม §5.3)

### 5.2 วิธีปั้น stack บน runner (ตรวจกับ `vitest.integration.config.ts` + `docker-compose.yml` + `.env.example` จริง)

รายการ service ที่ harness ต้องการ — **default-profile ครบ 9 ตัว** (เหตุผลรายตัวจากการอ่านเทสจริง §2/§3):

| service | ทำไมต้องมี |
| --- | --- |
| `db` | `TEST_DATABASE_URL` 41 จุด · compose healthcheck `pg_isready` |
| `auth` (GoTrue) | signup/login จริงของ helpers.ts (rate-limit email 1000/ชม. จาก compose อยู่แล้ว) |
| `rest` (PostgREST) | `/rest/v1` ผ่าน kong · aggregates เปิดแล้วใน compose |
| `storage` | d8-exam-cert-flow:1054 · dcr12:201/209 ยิง `/storage/v1/...` ผ่าน kong (kong.yml:61-98 route มาที่นี่) |
| `imgproxy` | dependency ของ storage (compose:146) |
| `kong` | ประตูเดียว `TEST_SUPABASE_URL=http://localhost:8000` · healthcheck `kong health` |
| `mailpit` | dcr15/dcr16 อ่านอีเมลจาก `TEST_MAILPIT_URL=http://localhost:8025` · GoTrue SMTP ยิงมาที่นี่ |
| `app` | 19 จุด `requireAppOrSkip` ใน 9 ไฟล์ BFF (TEST_APP_URL default :3000) — ไม่มี app = skip เงียบ |
| `db-migrate` | migrations + seed idempotent — ต้องจบก่อนเทส (seed ขาด = integration ที่อ้าง seed ตายทั้งชุด ตาม migrate.sh comment) |

ลำดับ command ที่ workflow ใช้ (ทั้งหมด `docker compose` ตรง ๆ — ไม่ผ่าน Makefile เพื่อคุมความหมายเชิง CI):

1. `cp .env.example .env` — compose interpolation ต้องมี `POSTGRES_PASSWORD`/`SUPABASE_JWT_SECRET`/anon+service key — **ค่า placeholder local ทางการเท่านั้น** (ไฟล์ .env ที่เกิดบน runner ไม่ใช่การแก้ไฟล์ใน repo — เกิดใน workspace ของ run แล้วหายไปกับ run)
2. `docker compose up -d --wait db auth rest storage imgproxy kong mailpit` — `--wait` ผูกกับ healthcheck ที่ compose มีอยู่จริง
3. `docker compose run --rm db-migrate` — foreground, exit code ของ migration = exit ของ step (ลำดับ **"migration ก่อน app เสมอ"** สืบทอดจาก DCR-PROD-DEPLOY)
4. `docker compose up -d --wait app` + poll `GET $TEST_APP_URL/api/health` ทุก 5 วิ นานสุด 300 วิ (evidence ของ AC (a)) — ไม่ผ่าน = dump `docker compose logs app` แล้ว fail
5. `npm run test:integration` (หัวใจ ladder — §5.5 คือ step ใน YAML)
6. teardown `docker compose down -v --remove-orphans` (`if: always()`)

env รูปแบบที่ job ตั้งให้ vitest (ฝั่ง host) = ตาราง §3 ทั้งแปดตัว — ทุกค่าชี้ localhost-of-runner (`:54322/:8000/:3000/:8025` ตรง host-port mapping ของ compose เพราะ `.env.example` ตั้ง `POSTGRES_HOST_PORT=54322` ไว้แล้ว)

### 5.3 Concurrency guards (หัวข้อ §1.3 ข้อ 5)

- บน runner: `concurrency.group: serial-ladder` (string คงที่ — ข้าม branch ด้วย) + `cancel-in-progress: false` → รอบใหม่ **เข้าคิว ไม่ cancel** (AC (b)) — แปลตรงจาก BL-015 "ห้ามรันสวีทซ้อน" ให้เป็นกลไกของ runner
- ไม่ทำลาย ci.yml: กลุ่มของ ci.yml คือ `ci-${{ github.event_name }}-${{ github.ref }}` — คนละชื่อ ไม่มีทางแชร์คิว/ยกเลิกกันโดยกลไก concurrency
- กับ battery ของ CTO บนเครื่อง local: **คนละเครื่อง — ไม่เกี่ยวกันโดยสิ่งปลูกสร้าง** (runner เป็น VM ของ GitHub ไม่แชร์ CPU/ดิสก์/docker daemon กับเครื่องใด) — นี่คือจุดขายของ lane นี้ตาม retro #3 และถูกระบุไว้ชัดตาม charter §1.3 ข้อ 5

### 5.4 Secrets matrix (หัวข้อ §1.3 ข้อ 3)

| Phase | secret ที่ต้องตั้งใน GitHub | รายการ |
| --- | --- | --- |
| **Phase 1 (WO นี้)** | **ไม่มีเลย — เป้าหมาย "zero secrets" สำเร็จ** | workflow ไม่อ้าง `secrets.*` แม้แต่ตัวเดียว (checkout ใช้ implicit token ของ GHA เอง) · env ทั้งหมด = localhost + placeholder local ทางการ (ตาราง §3) · ตรวจแล้ว: `vitest.integration.config.ts` ต้องการเฉพาะ `TEST_*` — ยืนยัน A-2 แล้ว (ไม่ต้อง STOP) |
| Phase 2+ (battery/e2e บน runner) | ยังไม่ต้องมี (เทสชี้ localhost ของ runner เช่นกัน) | เฉพาะถ้าต้องการ artifact upload ด้วย token อื่น — ยังไม่ใช่ตอนนี้ |
| Phase 3 (deploy — **นอก scope WO นี้**) | ของสาย deploy ตาม DCR-PROD-DEPLOY §5.1/OQ-13 | `SUPABASE_ACCESS_TOKEN` + DB connection ของ staging/prod · `VERCEL_TOKEN` + org/project id — บันทึกส่งต่อเท่านั้น |

กันหลง: ค่า canonical ของ prod (VA-PENTEST V14.2.x) **ห้าม**เข้า GitHub secrets หรือ YAML นี้เด็ดขาด (กฎ DCR-PROD-DEPLOY §1 แถว 2) — สิ่งที่อยู่ใน YAML คือ JWT dev placeholder สาธารณะของ `.env.example` ซึ่ง sign ด้วย dev JWT secret และใช้ได้เฉพาะ stack local เท่านั้น

### 5.5 Cache strategy (หัวข้อ §1.3 ข้อ 4 — พร้อมเหตุผลเชิงนาที)

| cache | สถานะ | นาทีที่ประหยัดได้จริง | เหตุผล/เงื่อนไข |
| --- | --- | --- | --- |
| npm (setup-node `cache: npm`) | **ใช้แล้วใน YAML** (รูปเดียวกับ ci.yml) | ~1–1.5 นาที/รอบ | มีของ ci.yml มาก่อน — ใช้ key เดียวกันฟรี |
| `.next/cache` | **N/A Phase 1** | — | workflow นี้ไม่ build บน host (app = next dev ใน container) · หมายเหตุ: หลัง WO-3 อัป Turbopack ความเข้ากันของ cache ต้องพิสูจน์ใหม่ — ผูกกับ WO-3 แล้ว |
| docker layer ของ image `app` (npm ci ใน Dockerfile.dev) | ยังไม่ทำ — future work (§12) | ~2–4 นาที/รอบ | ต้องใช้ buildx + `cache-from/to: type=gha` — เพิ่มความซับซ้อนครั้งแรก ไม่คุ้มตอนพิสูจน์ smoke · ทำเมื่อรอบนิ่งแล้ว |
| Playwright `~/.cache/ms-playwright` | **Phase 2 เท่านั้น** (ci-battery.yml) | ~30 วิ–1 นาที/รอบ | key ตามเวอร์ชัน `@playwright/test` (package.json:36) — ยังไม่มี browser ใน workflow นี้ |

### 5.6 แผน phase (PM เสนอ — CTO ตัดสิน; ตาม charter §1.3 ข้อ 6)

- **Phase 1 (งาน WO นี้ — เสร็จใน branch นี้):** `ci-integration.yml` — integration full-suite อนุกรมบน runner-hosted compose · **trigger = `workflow_dispatch` อย่างเดียว** (A-1) จนกว่า CTO จะสั่งเปิด `pull_request` หลัง smoke แรกเขียว + owner ให้สัตยาบันค่าใช้จ่าย
- **Phase 2 (post-close · CTO-gated — ออกแบบไว้ ยังไม่สร้างไฟล์):** `ci-battery.yml` — battery บน runner: `docker compose --profile prod up -d --wait app-prod` (:3001) → env trio ตาม DCR-PROD-BUILD-E2E (`E2E_BASE_URL=http://localhost:3001` · `HEAP_CONTAINER=ltc-prod-app` · `E2E_REQUIRE_PROD=1` + `scripts/prod-build-proof.mjs`) → `bash scripts/battery-prod.sh` · Playwright cache ตาม §5.5 · เรื่อง artifact/หลักฐาน E2E และ D90 จะต้องมี DCR ของตัวเอง (ผูกกับ EVIDENCE-PRESERVATION ที่อยู่เครื่อง local — runner ต้องออกแบบการเก็บ evidence ใหม่) — ไฟล์นี้ถูกสร้างเมื่อ CTO สั่งเท่านั้น
- **Phase 3 (นอก scope):** สาย deploy-staging/deploy-prod — ของ DCR-PROD-DEPLOY §5.1 รอบ implement · WO นี้อ้างส่งต่อได้ถึงเท่านั้น (§5.4)

### 5.7 Node version pin (หัวข้อ §1.3 ข้อ 7 — A-3)

`node-version: 22` บน host (setup-node) — ตรง ci.yml ปัจจุบันและคำวินิจฉัย OQ-11 (Node 22 ทุกชั้น) · ฝั่ง container ของ `app` ใช้ image `node:22-alpine` จาก `docker/Dockerfile.dev:3` อยู่แล้ว — สองชั้นเป็น 22 ตรงกันโดยไม่แตะ docker/ แม้แต่บรรทัดเดียว

---

## 6. Budget นาทีโดยประมาณ (จาก ground truth retro §1 — ตัวเลขวัดบนเครื่องหลัก)

| ขั้น (บน runner) | ประมาณ | ฐานวัดจริง/ที่มา |
| --- | --- | --- |
| checkout + setup-node + npm ci | 1–3 นาที | ci.yml ใช้รูปเดียวกัน |
| pull images ครบ stack (ครั้งแรก) | 3–6 นาที | 8 images รวม supabase/postgres (~2.5GB) |
| stack up --wait + db-migrate + app health | 2–5 นาที | healthcheck ของ compose จริง (db 30s start period · app 60s) |
| integration full-suite (อนุกรม) | **40 นาที–2 ชม.** | local: 2189–2461 วิ (~36–41 นาที) — สมมติ runner ช้ากว่า ≤3× (บทเรียน BL-015 H1: เครื่องช้า 3–4× มีผลจริง) |
| teardown | <1 นาที | down -v |
| **รวมคาดหวัง / เพดาน** | **~50 นาที–2.5 ชม. / 120 นาที (timeout ของ job)** | `timeout-minutes: 120` — ถ้าชนเพดาน = runner ช้าเกินสมมติฐาน → รายงาน CTO พิจารณาแยก job ต่อชุด (charter แนะนำไว้แล้ว) |

แยกจาก ci.yml ทุกนาที: workflow นี้ไม่รัน lint/typecheck/unit/build/gitleaks ซ้ำ (เป็นของ ci.yml อยู่แล้ว) — จ่ายเฉพาะ integration

---

## 7. หน้าตา Phase 2 (บันทึกออกแบบ — **ยังไม่สร้างไฟล์ใด** ตาม fence WO-1)

- ไฟล์เป้าหมาย: `.github/workflows/ci-battery.yml` (ชื่อไม่ชน ci.yml/ci-integration.yml) · trigger `workflow_dispatch` เช่นกัน
- โครง: compose `--profile prod` (app-prod :3001 ตาม DCR-PROD-BUILD-E2E) → proof (`scripts/prod-build-proof.mjs` — อ่าน BUILD_ID จาก container) → `bash scripts/battery-prod.sh` (env trio) → เก็บ log แบบ timestamped
- cache: Playwright browser ตาม §5.5 · ประเด็นที่ต้อง DCR ของตัวเอง: evidence E2E (dump ทำลาย · timestamped logs) เดิมผูกกับเครื่อง local — runner ต้องออกแบบการเก็บคืนมาเป็น artifact ให้ได้คุณภาพเดียวกันก่อนถึงจะนับ battery บน runner ได้
- D90: การนับ/ยกเลิก anchor เป็นอำนาจ CTO (ตามชี้ขาด gate r1 + คำวินิจฉัย A-7 ของ Sprint 2) — workflow นี้ไม่ตัดสินเอง

---

## 8. ความเสี่ยง/ข้อจำกัด

| # | ความเสี่ยง | การรับมือที่ออกแบบไว้ |
| --- | --- | --- |
| R1 | runner 2 คอร์ช้ากว่าเครื่องหลัก → race window เพี้ยนแบบคลัสเตอร์ B/C/D ของ BL-015 (H1 พิสูจน์แล้วว่าเครื่องช้ามีผลจริง) | trigger มือเท่านั้น — รอบแรก ๆ CTO ตัดสิน verdict เอง · **ห้ามตัดสินเป็น flake** ตามกติกา two-strike ของ BL-015 · `testTimeout` 30 วิ/`hookTimeout` 60 วิ เป็นค่าของ config จริง (อยู่นอกเขตแก้ของ WO นี้ — ถ้าต้องปรับ = ตั๋วแยกผ่าน gate) |
| R2 | image drift: compose อ้าง tag ลอย (kong:2.8.1 ฯลฯ) — runner pull ได้ digest ใหม่กว่าเครื่อง local | นี่คือของ DCR-GATEWAY-ERRBODY-REBASELINE (BL-015 ข้อสรุป A=H2 สั่ง pin digest) — workflow นี้อ้าง compose เดิม ไม่ pin เอง (ห้ามแก้ docker-compose.yml) · บันทึกส่งต่อ |
| R3 | `docker compose` v2 semantics (`--wait`, `run --rm`) ต่างเวอร์ชันเล็กน้อยตาม runner image | ใช้ flag มาตรฐาน v2 · smoke แรก (post-close) เป็นผู้พิสูจน์ — ถ้าต้องปรับ = แก้เฉพาะ workflow นี้ ไม่กระทบ repo อื่น |
| R4 | หน่วยความจำ: app container ตั้ง heap 4096 (compose:254) + stack รวม ~3-4 GB | ต้องการ runner ≥8 GB ว่าง — ubuntu-latest มีเพียงพอตาม spec สาธารณะ · smoke แรกยืนยันจริง |
| R5 | port ชนบน runner (54322/8000/8025/3000/5432) | runner สดไม่มี service ครองพอร์ตเหล่านี้ — ไม่มีมาตรการเพิ่ม |
| R6 | เขียวลอยจาก silent-skip (config skip ทั้งชุดเมื่อไม่มี TEST_DATABASE_URL) | ออกแบบกันไว้ 2 ชั้น: `TEST_REQUIRE_APP=1` (app ไม่พร้อม = fail) + silent-skip guard ตรวจ "0 passed" (AC เสริมข้อ 1) |

---

## 9. สิ่งที่ "ไม่" เปลี่ยน (fence ของ WO-1)

- `.github/workflows/ci.yml` ทั้งไฟล์ — ทุกบรรทัดคงเดิม (implementation-in-waiting หมายถึงไฟล์ใหม่เท่านั้น)
- ไม่แตะ `tests/` · `src/` · `docker/` · `docker-compose.yml` · `.env*` · `scripts/` · `Makefile` — ศูนย์ไฟล์
- ไม่ author สาย deploy · ไม่เปิด trigger อัตโนมัติใด · ไม่มีค่าจริง/canonical ในไฟล์ที่ส่งมอบ
- ไม่ implement sharding หลาย compose project (retro #8 — "ทำ #3 แล้วค่อยว่า") — บันทึกเป็น future work §12

---

## 10. ตาราง trace Gherkin → YAML + หลักฐาน validation

### 10.1 trace ทีละ Scenario (§4 ของเอกสารนี้ → บรรทัดของ `.github/workflows/ci-integration.yml`)

| Scenario | จุดพิสูจน์ใน YAML |
| --- | --- |
| (a) ครบทุกไฟล์ อนุกรม เขียว | step "Start dev stack core" (9 services ตาม §5.2) → step "Apply migrations + seed" (`docker compose run --rm db-migrate` — exit code เป็น exit ของ step) → step "Start app + รอ health 200" (poll `$TEST_APP_URL/api/health` 300 วิ) → step "Integration full-suite" รัน `npm run test:integration` (include ทุกไฟล์จาก config จริง · `fileParallelism: false` อยู่ใน `vitest.integration.config.ts` โดยไม่ต้องตั้งใน YAML) · summary รายงาน "N passed" + บรรทัด "Test Files" |
| (b) เข้าคิว ไม่ cancel | `concurrency.group: serial-ladder` + `cancel-in-progress: false` |
| (c) ศูนย์ secret จริง | ไฟล์ไม่มี `secrets.*` เลย (regex ตรวจ = 0 จุด — checklist ข้อ 10) · env job = ตาราง §3 ครบทุกตัว · ไม่มี step upload artifact |
| (d) trigger = workflow_dispatch เท่านั้น | `on:` มี key เดียว `workflow_dispatch` (parsed: `{"workflow_dispatch": null}` — checklist ข้อ 2/13) |
| (e) fail บอกไฟล์แดง | block `if [ "$status" -ne 0 ]` → `grep FAIL` ดึง `tests/integration/*.test.ts` unique+sort → เขียนลง `$GITHUB_STEP_SUMMARY` · `exit "$status"` ≠ 0 |
| เสริม 1: silent-skip guard | block `n=... if [ -z "$n" ] || [ "$n" -eq 0 ]` → `::error::...silent-skip guard...` + status=1 |
| เสริม 2: app ล้ม = fail ไม่ skip | `TEST_REQUIRE_APP: "1"` ใน job env (semantics จาก `requireAppOrSkip` ของเทสเอง) |
| เสริม 3: teardown always | step "Teardown stack" มี `if: always()` + `down -v --remove-orphans` |

### 10.2 หลักฐาน validation (ขั้น §1.5.4 · เครื่องนี้ไม่มี actionlint/yamllint/yq — ตรวจแล้ว)

1. **Parse ด้วย worktree-local npx js-yaml** (เครื่องมือ: js-yaml 5.4.3 บน node v24.20.0 · คำสั่ง `npx --yes js-yaml .github/workflows/ci-integration.yml`):
   - `ci-integration.yml` → **exit 0, stderr ว่าง** · parsed แสดงโครงตรงตามออกแบบ: `on: {workflow_dispatch: null}` · `permissions: {contents: read}` · `concurrency: {group: serial-ladder, cancel-in-progress: false}` · `defaults.run.shell: bash` · job `integration` (ubuntu-latest, timeout 120) · 9 steps มี `name` ครบทุก step
   - `ci.yml` (parity เทียบ) → **exit 0**
2. **รีวิวเชิงโครงสร้างตาม checklist §1.5.4 ข้อ (2)** — ตรวจอัตโนมัติบนผล parse + regex บน raw file: **17/17 PASS**
   (`on:` มี · `on: = workflow_dispatch อย่างเดียว` · `permissions:` · `concurrency:` group+no-cancel · `defaults:` bash · jobs มี · `timeout-minutes` ทุก job = 120 · `runs-on` ทุก job · ทุก step (9) มี `name` · ไม่มี `secrets.*` ใน raw · checkout pin full SHA 40 หลักเดิม · setup-node v4 + node 22 + cache npm · ไม่มี pull_request/push/schedule · `TEST_REQUIRE_APP=1` · env เป็น localhost/placeholder · teardown `if: always()` · timeout ≥ 120)
3. ข้อจำกัดที่ยอมรับ: js-yaml parse ได้ "syntax + โครง" เท่านั้น ไม่ใช่ schema ของ GitHub Actions (actionlint ไม่มีบนเครื่อง) — ชั้นพิสูจน์ถัดไปคือ smoke run แรกจริงบน runner (post-close · CTO-gated) ตาม DoD ฝั่ง deferred

---

## 11. ลำดับดำเนินงาน (จริง · ตาม test-first ของ WO-1 §1.5)

1. สร้าง worktree `D:/LTC-w1` จาก `develop@65fbac9` (คำสั่ง §0.1) · อ่าน grounding §2 ทั้งหมด (read-only) — เจอข้อเท็จจริง 19 จุด `requireAppOrSkip` + mailpit + storage → ปรับรายการ service เป็น 9 ตัว
2. ตรวจ A-2 กับ `vitest.integration.config.ts` + เทสจริง → **ยืนยัน** (§3) — ไม่ต้อง STOP
3. **เขียน DCR ส่วน Acceptance criteria (Gherkin) ก่อน** → commit `4d99e52` (YAML ยังไม่มีอยู่ใน tree ณ commit นี้ — history เป็นพยาน)
4. เขียน `.github/workflows/ci-integration.yml` ตาม Gherkin
5. validate: parse + checklist (§10.2) — ผ่านทั้งสองชั้น
6. เติม DCR ครบ §5–§12 + แนบหลักฐาน (commit ถัดไป)
7. รายงานผู้สั่ง — รอ CTO gate (merge/trigger จริง = deferred)

## 12. Future work (บันทึก — ไม่ใช่งาน WO นี้)

- sharding หลาย compose project บน runner (retro #8: "ทำ #3 แล้วค่อยว่า") — ห้าม implement จนกว่า retro #3 ปิดจริง
- docker build cache (`cache-from/to: type=gha`) ของ image app — ประหยัด ~2–4 นาที/รอบ เมื่อรอบนิ่งแล้ว
- digest pinning ของ images — ของ DCR-GATEWAY-ERRBODY-REBASELINE (BL-015/A=H2)
- artifact policy ของ evidence (log timestamped / screenshots) เมื่อ Phase 2 มา — ต้องมี DCR ของตัวเอง
- เปิด trigger `pull_request` เมื่อ smoke นิ่ง + owner สัตยาบัน (ตาม §5.1 ของ DCR-PROD-DEPLOY)
