# DCR test-harness portability — แก้ 3 จุดที่ integration suite ล้มบนเครื่องใหม่ (ไม่ใช่ regression ของโค้ดผลิต)

Filing: หลัง GO ของ DCR-CSRF-ORIGIN-RESILIENCE · gate integration (§5 ข้อ 3) ล้ม deterministic 27 ไฟล์ / 9 เทส / 219 skip ซ้ำเป๊ะสองรอบ (`.omc/artifacts/it-rerun-after-fix.log`) · ชันสูตรแยกทีละ error แล้วพบว่า**ไม่มีสาเหตุใดเกี่ยวกับ CSRF fix** (unit 2735/2735 · tsc/lint/build ผ่าน · probe หกทิศ + e2e-04 บน :3001 ผ่าน)

## หลักฐาน-สาเหตุ (แยกสามก้อน)

1. **weak_password 422** — `TEST_USER_PASSWORD=Integration#2026` ใน `.env` (ไม่มี quote) โดน **Vite `loadEnv` (ที่ vitest.integration.config.ts ใช้) ตัด inline `#`** → runtime เห็น `Integration` (10 ตัวอักษร) < GOTRUE_PASSWORD_MIN_LENGTH=12 → signup ล้ม · e2e ไม่โดนเพราะ loader ของ e2e/helpers/env.ts เขียนเองไม่ตัด `#` · ยืนยันด้วย curl ตรงที่ kong: signup ด้วยรหัสเต็ม 16 ตัวผ่าน
2. **ENOENT mkdir `D:\tmp\ltc-it-lock`** — 4 ไฟล์ (dcr16/wave-g-logout-all/wave-g-login-ratelimit/wave-g-auth005) hardcode `LOCK_DIR="/tmp/ltc-it-lock"` · Node บน Windows resolve `/tmp` เป็น `<drive>:\tmp` = `D:\tmp` ซึ่งไม่มี → mkdir (แบบไม่ recursive) ล้ม · เครื่องเก่ามี `/tmp` ที่ใช้ได้จริง
3. **`exec: "sh": executable file not found` ใน container rest** — `postgrestPoolAcquisitionBoundMs` (tests/integration/test-io.ts:573-579) อ่าน env ผ่าน `docker compose exec -T rest sh -c "printenv | grep …"` · image `postgrest/postgrest:v12.2.3` ที่ pull วันนี้**ไม่มี shell** (แม้แต่ printenv ตรง ๆ — OCI exec ล้ม rc=127) — tag เดิมกับที่เคยตรวจจริง 2026-09-15 แต่ content ของ tag เปลี่ยน (image drift ของ upstream) · กระทบ M1 settleScenario 6+ เทส

## ทางแก้

| จุด | แก้ | ชนิด |
|---|---|---|
| 1 | `.env`: ใส่ double-quote รอบค่า — `TEST_USER_PASSWORD="Integration#2026"` (Vite ถอด quote ให้เอง · loader ของ e2e ก็ถอด quote — สองฝั่งได้ค่าเต็ม) | environment (ไม่แตะ repo) |
| 2 | สร้าง `D:\tmp` บนเครื่อง | environment (ไม่แตะ repo) · **follow-up ticket**: เปลี่ยน LOCK_DIR เป็น `os.tmpdir()` (code) เพื่อเครื่องใหม่ไม่ต้อง magic นี้ |
| 3 **[แก้ตาม qa round-1 ทั้งสามข้อ + เงื่อนไข pm]** | `test-io.ts`: เปลี่ยนการอ่าน env ของ rest จาก `exec sh printenv` → **`docker inspect` Config.Env** — array-form spawn ตามแบบแผนในไฟล์ (`spawn("docker", ["inspect", "--format", TEMPLATE, "ltc-dev-rest"])` รูปแบบ test-io.ts:597 — ไม่ผ่าน shell ไม่มี quoting drift) · **TEMPLATE ต้องเป็น `{{range .Config.Env}}{{println .}}{{end}}` เท่านั้น ห้าม bare `{{.}}`** (qa พิสูจน์แล้ว: รูปไม่มี separator ตอบ rc=0 กับบรรทัดเดียวเบี้ยว จน PGRST_DB_POOL* จริงนับได้ 0 = ผ่านเงียบในเคส fail-closed) · **ครบเงื่อนไข loud-fail**: inspect rc≠0/spawn error → throw (slice stderr ตามแบบแผน :372) · stdout ว่าง/whitespace → throw (ห้ามตีความเป็น 0) · ทุกบรรทัดไม่ว่างต้อง match `KEY=VALUE` ไม่งั้น throw · tripwire: ต้องเห็น `PGRST_DB_URI` ในผลที่อ่านได้ (อ่านผิดตัว/ผิด container = จับได้ทันที) · นับ `PGRST_DB_POOL*` >0 → throw · **มีเพียง "อ่านครบถูกต้อง + นับได้ 0" เท่านั้นที่คืน 10_000 — นี่คือ green path เดิม (test-io.ts:593 คืน 10_000 · docstring 556-559) ต้องคงไว้** (บันทึกชี้แจง: review-ask รอบแรกของ cto เขียน "zero → throw" ผิด — ถ้าทำตามจะทำ M1 settle พังทั้งชุด · เกณฑ์ของ qa ในแถวนี้เป็น authoritative) | **code (test-infra เท่านั้น)** |

ขอบเขตคงที่: ไม่แตะ `src/` · ไม่แต่ลด assertion ใด ๆ · ไม่แต่ compose/image (การ pin digest ของ postgrest แยกเป็นคำถามของ DCR-PROD-DEPLOY ที่กำลัง draft)

## แผนทดสอบ

1. หลังแก้ 1+2 (env): rerun integration → ก้อน weak_password + lock ต้องหาย (27 ไฟล์ลดเหลือเฉพาะก้อน rest-no-sh)
2. หลังแก้ 3 (code): rerun อีกรอบ → M1 settleScenario ต้องกลับเขียว · ถ้าเหลือ "D1 opaque response" (r5 M1) ชันสูตรต่อแยกตามหลักฐาน
3. สรุปใน PROJECT-STATE + battery r38 คือ proof รวม

## ฉันทามติ + GO

- **รอบ 1 (ผ่าน bridge · 2026-10-13)**: pm **CONSENT** — scope split ถูกต้อง (env/machine repair อยู่ใต้อำนาจ delegated · code fix ผ่าน gate — ยืนยันว่า test-io.ts ไม่ถูกแตะก่อน GO) · กระทบ acceptance: ไม่มี (ซ่อมเครื่องวัดของ ladder ข้อ 3) · **กติกาปิด residual r5 M1 (binding)**: (a) ปิดด้วยเหตุ suite-pollution ได้**เฉพาะ**เมื่อ rerun หลังแก้เขียว**ทั้งชุด** + เก็บ log เป็นหลักฐาน (b) **two-strike rule**: ถ้า "D1 opaque" หรือ assertion ในตระกูล M1 settle ล้มซ้ำแม้แต่ครั้งเดียวหลัง harness fix (ทุกรัน รวม battery) = เปิด ticket สอบสวนแยกทันที ห้ามจัดเป็น flake อีก · non-blocking (binding เหมือน CSRF notes): เทสทิศลบของ inspect path (บรรทัดเบี้ยว/ไม่ผ่าน KEY=VALUE → throw) · follow-up os.tmpdir() ต้องมี Gherkin AC ใน backlog ตอน GO · บันทึกบทเรียน image-drift ของ postgrest ใน PROJECT-STATE
- qa: **OBJECTION รอบ 1 (doc-level — mechanism รับ + ความเทียมเท่าของหลักฐานพิสูจน์จริง)** — 3 amendments แก้แถวตารางข้อ 3: (1) pin template + ห้าม bare `{{.}}` (2) enumerate loud-fail guards ครบ (3) ชี้ข้อผิดพลาดเชิงความหมายของ review-ask เดิม — validated-zero คือ green path เดิม ต้องคืน 10_000 — แก้ครบในแถวตารางแล้ว (marker `[แก้ตาม qa round-1 ทั้งสามข้อ + เงื่อนไข pm]`)
- **รอบ 2 (ผ่าน bridge · 2026-10-13)**: qa **CONSENT** — ตรวจแถวตารางข้อ 3 ฉบับแก้ ปิดครบทั้งสาม amendments: (1) template ถูก pin เป็น `{{range .Config.Env}}{{println .}}{{end}}` + ห้าม bare `{{.}}` (2) loud-fail guards ครบหกทิศตามที่ enumerate (3) ยืนยัน validated-complete-read-with-count-0 คืน 10_000 = green path เดิม ต้องคงไว้ — ไม่ทำตามข้อความ "zero → throw" ที่ review-ask รอบแรกเขียนผิด
- **GO (CTO · 2026-10-13)**: ฉันทามติครบ (pm CONSENT รอบ 1 + qa CONSENT รอบ 2) → **GO ทั้งสามจุดตาม §ทางแก้** — จุด 1+2 (env/machine — delegated authority) เสร็จก่อน GO แล้ว · จุด 3 (code: test-io.ts) implement ตามแถวตาราง `[แก้ตาม qa round-1 ทั้งสามข้อ + เงื่อนไข pm]` แบบคำต่อคำ · เงื่อนไขประกอบ GO ครบตามรอบ 1: unit test ทิศลบของ inspect path · follow-up os.tmpdir() + Gherkin AC ใน `docs/backlog.md` · บทเรียน image-drift ของ postgrest ใน PROJECT-STATE (digest-pin แยกเป็น OQ ของ DCR-PROD-DEPLOY) · GO บันทึกที่ PROJECT-STATE event log พร้อมรายการนี้

## Addendum 3 — childRun ของ barrier-harness: spawn("npx") ตายบน Windows (ENOENT) · เปลี่ยนเป็น process.execPath + vitest.mjs ตรง (2026-10-14)

- **หลักฐาน (battery r38 คืนนี้)**: stage barrier-proof ล้มด้วย `spawn npx ENOENT` **9 จุด** — เฉพาะตระกูลที่ spawn vitest ลูกผ่าน `childRun` (8d-2 · 8e-1/2/3 · 8e2-1/2 · 8g-1/2/3 · 8h-1) · ทุกเทส barrier ที่ไม่ spawn ลูก **เขียวหมด** (8e3 · 8f ทั้ง 6 · 8h h3-h5b · 8p) = ไม่ใช่ regression ของโค้ดเทสแต่เป็นพอร์ตตะวิลลิตี้ล้วน — คลาสเดียวกับที่แก้ที่ wrapper แล้ว (battery-run.mjs + window-owner-proof.mjs ใน commit ก่อนหน้า) แต่จุดนี้เป็น spawn ของ "ไฟล์เทสเอง" ผ่าน harness กลาง
- **แก้ (จุดเดียว)**: tests/barrier-proof/barrier-harness.ts:638 — `spawn("npx", args)` → `spawn(process.execPath, [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), ...args-without-"vitest"]` — **ตัดการพึ่ง npx ทั้งหมด**: ไม่มีพื้นผิว shell/quoting · node รัน vitest.mjs ตรง · พฤติกรรม (args/config/env BARRIER_CHILD/RUN_ID/timeout/exit-code ตรงเป๊ะ) ไม่เปลี่ยน · ตรวจ node_modules/vitest/vitest.mjs มีจริงแล้ว
- **ทางเลือกที่ปฏิเสธ**: `{shell:true}` แบบ wrapper — ใช้ได้แต่เพิ่มพื้นผิว parsing ของ args (รายการไฟล์จาก caller) โดยไม่จำเป็น · execPath+bin ชนะทุกด้านเมื่อ bin ชั่วตัว
- **แผนพิสูจน์**: ไฟล์ barrier ที่เคยตายทั้งตระกูล 8e/8e2 เขียวแบบ isolated (เห็น child spawn จริง — marker ของ child ปรากฏ) → relaunch battery r38 → 13/13
- **รอ**: pm (scope จุดเดียว + กลไก) + qa (testability) — fast round ตามคำสั่ง coordinator

- **pm CONSENT + qa CONSENT (fast round ผ่าน bridge · 2026-10-14)**: สมมูลตรวจผ่านห่วง .bin shim ทั้งเก้า · contract ทั้งหมดอยู่ระดับ spawn-argument · พฤติกรรม kill ดีขึ้น (SIGKILL โดนตัว vitest ตรง ๆ) · **เงื่อนไข binding สามข้อ**: (1) แก้ args ที่ :633 พร้อมกัน — ตัดคำเลือก `"vitest"` นำหน้าออกให้ argv เริ่มที่ `"run"` (ห้ามเหลือคำ vitest หลงเหลือใน argv) (2) `FORCE_COLOR:"0"` ที่ :640 เป็นของ load-bearing ของ assertion stdout-contains — ห้ามแตะ (3) รอบพิสูจน์ต้องเห็น **child markers ใน output จริง** (ข้อความ marker ของ 8e/8e2 ไม่ใช่แค่ RC เขียว) ก่อน relaunch battery → **GO (CTO · 2026-10-14)** ตามแผนพิสูจน์ของ addendum นี้
