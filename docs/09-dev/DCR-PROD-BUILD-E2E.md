# DCR production-build e2e — battery บน production runtime (Wave I เฟส 3)

Filing: verdict wavei-r3 (2026-09-16) — "PASS เฉพาะเฟส 2 ASM-011 — **อนุญาตเปิดเฟส 3 production-build e2e เป็นพาหะวัด D90**" พร้อมเงื่อนไข verbatim: "(1) **D90 คง 0/3**; r36/r37 ยังคง FAIL เริ่มสะสมใหม่บน production runtime พร้อม identity ก่อน–หลังและ timestamped logs ครบทั้งหน้าต่าง ต้องผ่าน battery ทั้ง 13 stages สามรอบติดต่อกันตามเกณฑ์เดิม (2) เฟส 3 ต้อง **doc-first D71 และมี gate ของตัวเอง** รักษา coverage, assertions และ audit เดิม พร้อมตรวจว่า browser ใช้ production build จริง หาก e2e-05/e2e-10 ล้มซ้ำต้องสอบสวนต่อ" · ที่มาเพิ่ม: คอมเมนต์ rollback D90 ใน `docker-compose.yml` จบด้วย "+ เปิด DCR production-build e2e" · verdict r22 ข้อ (3)

## ปัญหาที่เฟสนี้ตัด

battery e2e บน `next dev` ล้มสุ่มตำแหน่ง (r36 e2e-05 → r37 e2e-10) ในหน้าต่างที่ log มี marker `Server is approaching the used memory threshold, restarting...` และ webpack TypeError bursts — **สถานะสาเหตุคงเป็นสมมติฐานตาม D-f-11** (gate wavei-r3: "correlation และการสลับเทสที่ล้มยังตัด regression ไม่ได้") · production runtime ไม่มี dev-mode memory-check self-restart และไม่มี module registry ที่ถูกฉีกกลาง request — ตัดตัวแปรนี้ออกจากการวัด D90 และ**ถ้า e2e-05/e2e-10 ยังล้มบน production build = สอบสวนต่อตามคำสั่ง gate** (ไม่ใช่ environment อีกแล้ว)

## การออกแบบ

### 1) compose service `app-prod` (profile `prod` — ไม่ขึ้นกับ `make up` ปกติ)

- image เดียวกับ dev (`docker/Dockerfile.dev`) แต่ **override command** เป็น `sh -c "npm run build && npm start"` — build production ใน container เอง (NEXT_PUBLIC_* ฝังตอน build ด้วย env_file เดียวกับ dev จึงตรงค่า) แล้ว `next start`
- **`next start` ปฏิเสธการรันเมื่อไม่มี production build** — service ที่ตอบ health 200 ได้ = ต้องกำลังเสิร์ฟ production build จริง (หลักฐานชั้นที่ 1 ของเงื่อนไข "browser ใช้ production build จริง")
- พอร์ต host **3001** → container 3000 (dev ยังครอง 3000 — integration ไม่กระทบ: `tests/integration` ผูก dev app ตาม hardcode เดิม)
- volume: `.:/app` + `node_modules` (แชร์ภาพ image เดียวกัน) + **`next_cache_prod:/app/.next` แยกจาก `next_cache` ของ dev เด็ดขาด** (รูปแบบ build dev/prod ต่างกัน — แชร์แล้วทับกัน)
- env: เหมือน app ทุกตัว (env_file .env · `SUPABASE_URL=http://kong:8000` · `SMTP_HOST=mailpit` · pooler) ยกเว้น `NODE_ENV=production` และ**ไม่ใส่** CHOKIDAR/WATCHPACK (prod ไม่ watch) และไม่กำหนด NODE_OPTIONS (ไม่มี dev memory-check ให้ต้องระวัง)
- `docker compose down` (ไม่สน profile) ทำลาย app-prod ด้วย → ทางเข้าที่ทำลายต้อง dump ก่อน (ดูข้อ 3)
- mailer ยังยิง `http://app:3000` (dev) เหมือนเดิม — ไม่แตะ

### 2) battery — env-driven ไม่แตะลำดับ 13 stages

`scripts/battery-run.mjs` อ่าน env สามตัว (default = พฤติกรรมเดิมเป๊ะ ย้อนหลังเข้ากันหมด):

| env | default | พฤติกรรม |
|---|---|---|
| `E2E_BASE_URL` | `http://127.0.0.1:3000` | health gate poll **origin เดียวกับที่ e2e จะใช้** (เดิม hardcode 3000 — ตอนนี้ derive) · ส่งผ่านถึง playwright (baseURL + webServer.url reuse) และ e2e helpers (APP_ORIGIN) เพราะ spawnChild ส่งต่อ process.env |
| `HEAP_CONTAINER` | `ltc-dev-app` | heap-start/heap-end ส่ง `--container` ให้ sampler → คู่ identity E1 ของ D90 ผูกกับ **container ที่ e2e วัดจริง** |
| `E2E_REQUIRE_PROD` | (ไม่ตั้ง) | `"1"` = หลัง health 200 ต้องผ่าน `scripts/prod-build-proof.mjs` ก่อน — ไม่ผ่าน = stage health ล้ม = battery หยุดก่อน e2e (ต่อของ gate waveh-r1 M4 "ห้ามปล่อย e2e ตอน app ไม่พร้อม") |

ตัวตั้งค่าครบชุด: `scripts/battery-prod.sh` — export สามตัว (3001 · ltc-prod-app · 1) แล้ว `exec node scripts/battery-run.mjs "$@"`

### 3) E2 evidence preservation ครอบทางเข้าใหม่

- `make up-prod` = dump `ltc-prod-app` → `docker compose --profile prod up -d --build app-prod`
- `make down-prod` = dump `ltc-prod-app` → `docker compose --profile prod rm -f -s app-prod`
- `make down` / `make reset-db` ทำลายทุก container รวม app-prod → **dump ทั้งสอง container ก่อน** (dump ของที่ไม่มี = exit 0 ผ่านได้ตามสัญญา exit-code ของสคริปต์)
- อัปเดตตาราง/รายการทางเข้าใน `docs/09-dev/EVIDENCE-PRESERVATION.md` E2

### 4) หลักฐาน "browser ใช้ production build จริง" (เงื่อนไข verdict)

`scripts/prod-build-proof.mjs` — รันโดย stage health เมื่อ `E2E_REQUIRE_PROD=1` (นับเป็น stage ที่ 8 ตามปกติ ไม่เพิ่ม stage):

1. **probe ฝั่ง HTTP ผ่านมุมมอง browser**: GET `/login` → ดึง URL chunk แรก `/_next/static/chunks/*.js` จาก HTML → GET chunk → ต้องได้ `Cache-Control` มี `immutable` (สัญญาณเฉพาะ production — dev เสิร์ฟ chunk โดยไม่ใส่ immutable)
2. **probe ตัว container**: `docker inspect ltc-prod-app` Config.Cmd ต้องมี `npm start` + State.Running · `docker exec ltc-prod-app cat /app/.next/BUILD_ID` พิมพ์ BUILD_ID ลง log ประจำรอบ
3. (ชั้นที่ 0 จากธรรมชาติของ `next start`: ไม่มี production build = container ตายตั้งแต่ boot — health 200 ไม่เกิด)

Two-way [[regression-test-two-way-proof]]: ชี้ proof ไป **dev (3000) ต้องล้ม** (chunk ไม่มี immutable) · ชี้ไป **prod (3001) ต้องผ่าน** — บันทึกทั้งสองทิศเป็นไฟล์หลักฐาน

### 5) D90 บน production runtime (เงื่อนไข verdict ข้อ 1)

- คู่ heap-start/end ให้ identity (container_id เต็ม + StartedAt + RestartCount) ของ `ltc-prod-app` อัตโนมัติ
- timestamped logs ครบหน้าต่าง: dump ก่อนทำลายทุกทางเข้า (ข้อ 3) + dump หลังจบรอบเมื่อสอบสวน
- **ระหว่างสามรอบ: ห้าม reset-db/down/down-prod/แตะ tree** (กติกาเดิม) · หาก container เปลี่ยน/หลักฐานขาด = เริ่มนับใหม่ตามเกณฑ์ verbatim
- 13 stages ครบทุกรอบ · r36/r37 คง FAIL ในสถิตะ (ไม่ถูกลบล้าง)

## สิ่งที่ "ไม่" เปลี่ยน

- ลำดับ/จำนวน 13 stages · coverage/assertions ของ unit+tsc+lint+build+integration+audit+e2e ทั้งหมดเดิม · ledger guard + audit ทุกตัว · integration ยังรันบน dev stack (เหมือนเดิมทุกบรรทัด)
- e2e specs ไม่แก้ (เปลี่ยนแค่ origin ที่วิ่งไปหา) — ถ้า spec ใดล้มเฉพาะบน production build นั่นคือสัญญาณของจริงที่ต้องสอบสวน (เงื่อนไข verdict: e2e-05/e2e-10 ล้มซ้ำ = สอบสวนต่อ)

## ความเสี่ยง/ข้อจำกัด

- build ใน container ตอน `up-prod` ครั้งแรกกินเวลา/หน่วยความจำชั่วคราว (ครั้งถัดไป `.next/cache` ใน `next_cache_prod` ช่วยได้) — ระหว่าง build มี dev+kong แชร์ VM 7.748GiB อยู่ · ถ้า OOM บันทึกแล้วพิจารณา (เช่น build ตอน dev หลับ) — อย่าเงียบ
- source bind-mount หมายถึง build จับตอน `up-prod` เท่านั้น — แก้โค้ดแล้วต้อง `make down-prod && make up-prod` (หรือรอ boot ใหม่) จึงเห็นผล ไม่มี HMR — โดย design

## ลำดับดำเนินงาน

1. เอกสารนี้ (commit ก่อนแตะโค้ด — D71)
2. โค้ด: compose `app-prod` + volume `next_cache_prod` · Makefile up-prod/down-prod + down/reset-db dump สอง container · battery env สามตัว + health รวม prod-proof · `scripts/prod-build-proof.mjs` · `scripts/battery-prod.sh` · EVIDENCE-PRESERVATION E2
3. two-way: proof บน dev ต้องล้ม → บน prod ต้องผ่าน · battery `--stages health` บน origin ผิดต้องล้ม · sampler `--container ltc-prod-app` ได้ identity ถูกตัว
4. `make up-prod` → รอ health · e2e ชุดย่อหรือเต็มสัมผัสครั้งแรกบน 3001
5. **battery r38 = D90 รอบ 1/3 ใหม่บน production runtime** (ผ่าน = 1/3 · ล้ม = สอบสวนตามเงื่อนไข verdict)
6. สะสม 2/3 · 3/3 → gate wavei-r4 (gate ของเฟส 3) พร้อมหลักฐานทั้งหมด
