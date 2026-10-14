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

## 5. การออกแบบ (เติมหลัง YAML — ระหว่างเขียน)

<!-- WO-1 ขั้น 5: จะเติม section นี้ให้ครบทุกหัวข้อ §1.3 หลัง YAML ผ่าน parse + checklist -->

## 10. ตาราง trace Gherkin → YAML (เติมหลัง YAML — ระหว่างเขียน)

<!-- WO-1 ขั้น 4: แนบผล parse + checklist ที่นี่ -->

## 11. ความเสี่ยง/ข้อจำกัด (เติมหลัง YAML — ระหว่างเขียน)

<!-- ระหว่างเขียนตามขั้น 1.5 — หัวข้อถูกจองไว้ให้ครบโครงตั้งแต่ commit แรก -->
