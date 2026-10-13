# DCR PROD-DEPLOY — การออกแบบการขึ้น production (Vercel + Supabase Cloud + Cloudflare)

> **สถานะ: DRAFT — รอ CTO review** · เอกสารนี้เป็นงานออกแบบพร้อมเข้า **design-first consensus
> gate ก่อนการ implement ใด ๆ** (กฎ Brief §9 / แบบแผน D71 doc-first) — ยังห้ามสร้างไฟล์
> infra/โค้ดตามเอกสารนี้จนกว่าจะได้ verdict จาก gate · ปิดงานออกแบบ **BL-003** (Cloudflare
> security layer design) ในตัว

|          |                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| เวอร์ชัน | 0.1.0 (DRAFT)                                                                                                                  |
| วันที่    | 2026-10-13                                                                                                                    |
| เจ้าของ  | devops (ร่าง) — รอ CTO review + ทีม consensus                                                                                  |
| ที่มา     | สถาปัตยกรรมเป้าหมายที่ product owner ตัดสิน: **Frontend → Vercel · Backend → Supabase Cloud · Security/edge → Cloudflare (DNS/proxy · WAF · Turnstile · Access) — security tooling รวมศูนย์ที่ Cloudflare** · ปิด BL-003 (docs/backlog.md) |
| อ้างอิง   | ARCHITECTURE.md §4–§5.5 · `docs/09-deploy/PROD-CHECKLIST.md` 1.0.3 (ทุกข้ออ้างไฟล์:บรรทัดตรวจแล้ว) · `docs/09-dev/SECRETS-PROVISIONING.md` 1.1.0 · `docs/09-dev/DCR-PROD-BUILD-E2E.md` (Wave I เฟส 3) · `.env.example` · `docker-compose.yml` · `src/lib/config.ts` · `src/lib/rate-limit.ts` · `.github/workflows/ci.yml` · SDS §5.3/§7/§8 · VA-PENTEST §3.5/§5 · SYSTEM-TEST §5.2 |
| ขอบเขต   | การออกแบบ deployment ของ staging/prod เท่านั้น — **ไม่ใช่** dev stack (dev = 100% local Docker ตาม Brief §6 คงเดิม) · ไม่แตะโค้ด/infra จนกว่า gate ผ่าน |

---

## 0. หลักการกลาง (สืบทอดจาก Brief §6 + PROD-CHECKLIST §1)

1. **โค้ดชุดเดียว ต่างกันเฉพาะ env vars** — ห้าม branch โค้ด/business logic ตาม environment · ค่า prod ทั้งหมดเข้าผ่าน env vars ของ platform ห้าม commit ลง repo ทุกกรณี
2. **fail-fast ที่ boot** — `APP_ENV=prod` เปิดสวิตช์บังคับ 3 ค่า: `CURSOR_HMAC_SECRET` (config.ts:130 · PB-9) · `IP_HASH_SALT` (config.ts:139 · PB-13) · `LTC_MFA_PENDING_KEY` (config.ts:148 · Wave F gate r1) — ขาด = bootstrap throw + `/api/health` 503
3. **กฎก้าวหน้าอย่างเดียว (forward-only) ของ migration บนระบบที่ขึ้นแล้ว** — ชุด migration ที่ push ขึ้น staging/prod แล้วถือเป็น immutable · การแก้ของเก่าแบบ in-place (แบบแผน DCR-22023/DCR-ASM-011) เป็นสิทธิ์ของ dev-replay เท่านั้น (dev DB สร้างใหม่จาก replay ทั้งหมด) — บน staging/prod ทุกการแก้หลัง deploy = **ไฟล์ migration ใหม่หมายเลขถัดไปเสมอ**
4. **ความปลอดภัยรวมศูนย์ที่ Cloudflare** — แต่ "ศูนย์" หมายถึงเครื่องมือชนิด edge (WAF/Turnstile/Access/rate-limit ขอบเขต) · การคุมสิทธิ์จริง (RBAC/RLS/session) ยังเป็นของแอป+DB ทุกชั้น (defense in depth — ไม่ย้ายความรับผิดออกจากโค้ด)

---

## 1. Service mapping: docker-compose (dev) → prod

ทุกบรรทัดอ้างบรรทัดจริงของ `docker-compose.yml` (parité map)

| # | compose service (dev) | หน้าที่ | prod equivalent | ความเสี่ยง parity ที่ต้องจัดการ |
|---|------------------------|---------|-----------------|-------------------------------|
| 1 | `app` (:3000 · next dev) + `app-prod` (:3001 · Wave I) | Next.js แอป | **Vercel** (Next.js · region SG/HK — OQ-10) | ตัวนับ rate limit เป็น in-memory **ต่อ instance** — เพดานจริง = เพดาน × จำนวน instance ที่รับ request (PROD-CHECKLIST §5) · NODE_ENV=production อัตโนมัติ → secure cookie ได้ผลเอง (cookies.ts:32) · Node runtime ต้อง pin ให้ตรง CI (OQ-11) |
| 2 | `db` (supabase/postgres 15.8.1) | PostgreSQL + roles + extensions | **Supabase Cloud** (PostgreSQL ตามแผนที่เลือก) | pg_cron/pgcrypto ฯลฯ ต้องเปิดได้ (migration สร้างเอง — §2.1) · timezone ของ cron ต่างกันได้ (§2.3) · **ห้ามใช้ placeholder JWT/anon/service key ของ local** (ค่า canonical สาธารณะ — VA-PENTEST V14.2.x) |
| 3 | `auth` (GoTrue v2.164.0) | อีเมล/รหัสผ่าน + TOTP MFA | **Supabase Cloud Auth** (GoTrue ของแพลตฟอร์ม) | autoconfirm หลายแผน default = **เปิด** ต้องปิดเป็น manual บน dashboard (AUTH-001) · SMTP ของ Auth ตั้งแยกจาก Resend ของแอป · email rate limit กลับค่าอนุรักษ์ (dev=1000 เพราะ integration — compose:66-69) · Site URL/Redirect URLs ต้องเป็นโดเมนจริง (สมมูล compose:55) · password min 12 (compose:65) · MFA TOTP เปิด default อยู่แล้ว (compose:79-84) |
| 4 | `rest` (PostgREST v12.2.3) | REST บน schema public | **Supabase Cloud API** (PostgREST ของแพลตฟอร์ม) | **ต้องเปิด db aggregates บน cloud** — หน้า monitoring/statistics ใช้ `id.count()`/`score_pct.avg()` ผ่าน user-JWT จริง (compose:105-108 · MAJOR-1 เดิม) ตรวจด้วย `curl "$SUPABASE_URL/rest/v1/courses?select=id.count()"` ต้อง 200 ไม่ใช่ 400 PGRST123 · `API_MAX_ROWS` ≥ 1000 (compose:104) · PGRST_LOG_LEVEL info เป็นของ dev-only (compose:119-124 evidence fence — cloud ไม่มี) |
| 5 | `storage` (storage-api · **backend = file บน volume** · compose:129-152) + `imgproxy` | ไฟล์สื่อ/ไฟล์แนบ | **Supabase Storage** (object store ของ cloud) + image transform ในตัวแพลตฟอร์ม | ต้องสร้าง bucket ครบ **4 ใบ**: `media` · `license-evidence` · `pdpa-exports` · `certificates` (ชื่อตรง migration/โค้ด — ขาดใบใด = งานนั้นล้มตอนอัปโหลด) · imgproxy เป็น dev-only ไม่ต้องมี equivalent · ตัวเลือก provider อื่น (r2/stream) ดู §1.1 |
| 6 | `kong` (gateway :8000 + `docker/kong/kong.yml`) | ประตูเดียวของ Supabase local | **API endpoint ของ Supabase Cloud** (`https://<ref>.supabase.co`) — ไม่ต้อง config เอง | kong.yml = dev เท่านั้น (ค่า canonical สาธารณะ — ห้ามใช้ค่าจากไฟล์นี้ใน prod) · `SUPABASE_PUBLIC_URL` **ไม่ต้องตั้ง**ใน prod โดเมนเดียว (config.ts:180-185 ตาม gate p5-r2) |
| 7 | `mailpit` (:8025/:1025) | จับอีเมล dev | **Resend** (แอป) + **Auth SMTP ของ Supabase** (อีเมลยืนยันของ GoTrue — สองทางแยกกัน) | `EMAIL_PROVIDER=resend` ขาดค่าใด = boot fail ที่ superRefine (config.ts:121-124) · โดเมนผู้ส่งต้อง verify DKIM/SPF กับ Resend · ต้องพิสูจน์ส่งถึงกล่องจริง (สมัคร 1 ฉบับ) |
| 8 | `mailer` (curl loop 30 วิ · compose:322-355) | ปลุก background worker 2 ตัวผ่าน HTTP | **Vercel Cron** (GET + `Authorization: Bearer <CRON_SECRET>` — route รองรับแล้ว email-dispatch/route.ts:86-90) | **repo ยังไม่มี `vercel.json`** — ต้องสร้างตอน implement (OQ-13) · CRON_SECRET ไม่ตั้ง = endpoint ตอบ 404 เงียบ (อีเมลไม่ส่ง ไม่มี error) · ตารางเวลาแนะนำตาม PROD-CHECKLIST §4 (email 1–5 นาที · pdpa-export 5–15 นาที) |
| 9 | `db-migrate` (one-shot · `docker/db/migrate.sh` · ledger `_dev.migrations`) | apply migrations + seed | **`supabase db push`** (ledger ของ supabase CLI) — หรือทางเลือก B ดู OQ-5 | ledger คนละชุดกับ dev (`_dev.migrations` = dev-only ตามหัว migrate.sh) · seed.sql/seed-uat.sql **ห้ามรันอัตโนมัติบน prod** (dev รัน seed ทุก up — นิสัยที่ต้องตัด) · การตรวจ "ครบ 46 ไฟล์" ต้องปรับไปตรวจตาม ledger ที่เลือก (OQ-5) |

### 1.1 ตัวเลือก storage provider (OQ-6 — เปิดคำถามไว้ให้ CTO ตัดสิน)

- **as-built v1 รองรับ `MEDIA_PROVIDER=supabase_storage` เท่านั้น** — `resolveLessonMediaUrl` (learning.server.ts:210-222) คืน `null` เมื่อ provider ≠ supabase_storage → บทเรียนวิดีโอแสดง placeholder แทนเครื่องเล่น · ค่า `r2`/`stream` มีใน config schema (config.ts:100-113) แต่**ยังไม่มีเส้นทาง CDN/อัปโหลดจริง** (หนี้ทะเบียน SYSTEM-TEST §5.2)
- เป้าหมาย "security tooling รวมศูนย์ที่ Cloudflare" **ไม่ได้บังคับ**ให้สื่ออยู่บน Cloudflare — R2/Stream เป็นทางเลือกอนาคต (ลด egress/รวม CDN) แต่ต้อง implement upload path + CSP/COEP ใหม่ · **ข้อเสนอ devops: v1 = supabase_storage** แล้วทบทวนหลัง go-live เมื่อมีตัวเลขปริมาณจริง

### 1.2 สิ่งที่ "หายไป" ใน prod โดย design (ไม่ใช่ความเสี่ยง)

- `PGRST_LOG_LEVEL: info` access-log fence (compose:119-124) — กลไก evidence ของ dev battery เท่านั้น · `NODE_OPTIONS`/CHOKIDAR/WATCHPACK (compose:240-254) · `POSTGRES_HOST_PORT` · `TEST_*` ทั้งชุด · `UAT_DEMO_PASSWORD` · `SUPABASE_JWT_SECRET` (ใช้โดย compose services เท่านั้น — cloud จัดการเอง)

---

## 2. งานพื้นหลัง/cron: mapping ฉบับ as-built

**สำคัญ — แบบแผนสองชั้น** (ไม่ใช่ย้ายทุกอย่างไป Vercel Cron):

### 2.1 ชั้นใน DB: pg_cron 8 งาน — **คงเป็น pg_cron บน Supabase Cloud**

migration สร้าง extension + schedule เอง (upsert ตาม jobname) — Supabase Cloud รองรับ pg_cron (บันทึกไว้ใน 0020:21-23 "dev/prod ใช้สิ่งเดียวกันตามหลัก 100% local ↔ 100% cloud"):

| jobname | รอบ | ที่มา | หน้าที่ |
|---|---|---|---|
| `ltc-auto-close-attempts` | ทุก 1 นาที | 0020_auto_submit.sql:251-252 | ปิด attempt พ้น grace + auto-submit |
| `ltc-cert-auto-issue` | ทุก 2 นาที | 0026:366-367 (redefine 0027:357-359) | ออกใบประกาศอัตโนมัติ (SRS AC ≤5 นาที) |
| `ltc-cert-bulk-step` | ทุก 1 นาที | 0027:363-364 | ปลุก bulk issue job ที่ยังไม่จบ |
| `ltc-credit-accrual` | ทุก 1 นาที | 0031_credit_bank.sql:832-833 | สะสมหน่วยกิต |
| `ltc-notification-dispatch` | ทุก 1 นาที | 0034_notifications.sql:1592-1593 | กระจาย notification + เขียน email_outbox |
| `ltc-renewal-reminder` | รายวัน 03:17 | 0034:1594-1595 | สแกนรอบต่ออายุ |
| `ltc-email-outbox-purge` | รายวัน 04:19 | 0034:1596-1597 | ล้าง outbox 90 วัน |
| `ltc-purge-retention` | รายวัน 04:23 | 0040_retention_purge.sql:111-112 | retention purge (บทบาท `purge_role` ไม่ใช่ service_role) |

**ความเสี่ยง parity ของชั้นนี้:**
- (ก) **timezone** — รอบรายวัน 03:17/04:19/04:23 คำนวณตาม timezone ของ DB (dev image vs cloud อาจต่างกัน — cloud default UTC) → หน้าต่างงานเลื่อน 7 ชม.ได้ · **ต้องตรวจ `show timezone;` + `select jobname, schedule from cron.job;` หลัง db push แล้วตัดสิน** (แก้ด้วย ALTER DATABASE ... SET timezone เป็น env ทะเบียน ไม่ใช่แก้ migration) — จดการตัดสินที่ PROD-CHECKLIST §5
- (ข) **สิทธิ์** — `cron.schedule` ต้องรันด้วยบทบาทที่มีสิทธิ์ (dev รันเป็น supabase_admin · cloud `db push` รันเป็นบทบาทของ CLI) — ต้องพิสูจน์หลัง push ว่า `cron.job` มีครบ 8 แถว ไม่ใช่ assumption
- (ค) `ltc-cert-auto-issue`/`ltc-cert-bulk-step` **อัปโหลด PDF ขึ้น bucket `certificates` + สร้าง QR จาก `CERT_PUBLIC_BASE_URL`** → ถ้า bucket/ตัวแปรขาด งานออกใบประกาศล้มทั้งเส้นทาง (fail-closed ERR-SYS-002 ที่ pdf.ts:104-106)

### 2.2 ชั้นแอป: HTTP worker 2 งาน — mailer container (dev) → **Vercel Cron** (prod)

| endpoint | dev (mailer · compose:348-351) | prod (Vercel Cron) | หมายเหตุ |
|---|---|---|---|
| `/api/internal/jobs/email-dispatch` | POST + `x-cron-secret` ทุก 30 วิ | **GET** + `Authorization: Bearer <CRON_SECRET>` (รูปทรงที่ Vercel ส่งให้อัตโนมัติ — gate r1 B1 · route.ts:86-90) | ส่งอีเมลค้างคิวผ่าน Resend · ไม่ตั้ง CRON_SECRET = 404 เงียบ |
| `/api/internal/jobs/pdpa-export` | โดน loop เดียวกัน | GET + Bearer เช่นกัน (route.ts:85-88) | ทำคำขอส่งออก PDPA → อัปโหลด bucket `pdpa-exports` |

**ข้อสังเกตเชิงบวก:** Vercel Cron inject header จากค่า env `CRON_SECRET` ของโปรเจกต์เอง — การหมุนค่าจึงเปลี่ยนทั้งสองฝั่งพร้อมกันในรอบเดียว (ไม่มีปัญหา two-sided rotation) · แต่ schedule ต้องประกาศใน `vercel.json` (**ไฟล์ยังไม่มีใน repo — สร้างตอน implement ตาม OQ-13**)

### 2.3 คำอธิบายที่ต้องแก้ในเอกสาร (doc-only)

ARCHITECTURE.md §5 ไดอะแกรมเขียน "Vercel Cron: auto-submit + email worker" — **as-built จริง: auto-submit เป็น pg_cron ใน DB (0020) ไม่ใช่ Vercel Cron** · Vercel Cron รับเฉพาะ 2 endpoint ใน §2.2 · เมื่อ DCR นี้ผ่าน gate ให้แก้ไดอะแกรมให้ตรง as-built (งานแก้เอกสาร ไม่ใช่โค้ด)

---

## 3. Env/secrets matrix: `.env.example` → prod

สัญลักษณ์คอลัมน์ "prod ตั้งที่": **V** = Vercel Environment Variables (server) · **SC** = Supabase Cloud (dashboard/config) · **CF** = Cloudflare · ✖ = ห้ามตั้งใน prod

### 3.1 แอป + Supabase

| ตัวแปร | prod ตั้งที่ | ค่า/ข้อกำหนด |
|---|---|---|
| `PUBLIC_BASE_URL` | V | `https://<โดเมนจริง>` — **บังคับทุก environment** (requiredString config.ts:33) — origin ของลิงก์ในอีเมล/redirect |
| `CERT_PUBLIC_BASE_URL` | V | `https://<โดเมนจริง>` — ลืมตั้ง = ออกใบประกาศ PDF ล้ม fail-closed (pdf.ts:104-106) |
| `APP_ENV` | V | `prod` (staging ก็ใช้ `prod` — แยก environment ด้วย URL/key) — เปิด fail-fast 3 ค่า |
| `LOG_LEVEL` | V | `info` (prod default ตาม SDS §6.2) |
| `SUPABASE_URL` | V | `https://<ref>.supabase.co` ของโปรเจกต์จริง |
| `SUPABASE_PUBLIC_URL` | ✖ | **ไม่ตั้ง** — prod โดเมนเดียว cloud URL สาธารณะอยู่แล้ว (config.ts:180-185) |
| `SUPABASE_ANON_KEY` | V | ค่าของโปรเจกต์จริง (ห้ามใช้ placeholder ของ local) |
| `SUPABASE_SERVICE_ROLE_KEY` | V | server-only (ไม่มี NEXT_PUBLIC_ นำหน้า — SDS §5.1 + lint rule `ltc/no-public-service-role`) |
| `SUPABASE_DB_POOLER_URL` | V | pooler **transaction mode** ของ cloud (SDS §8 — ทุกการเชื่อมผ่าน pooler · connection ยาวห้าม · ฝังรหัสผ่าน DB → หมุนรหัสผ่าน = อัปเดตค่านี้ + redeploy) |
| `SUPABASE_JWT_SECRET` | ✖ | ใช้โดย compose services เท่านั้น — cloud จัดการเอง |

### 3.2 สื่อ + อีเมล + cron

| ตัวแปร | prod ตั้งที่ | ค่า/ข้อกำหนด |
|---|---|---|
| `MEDIA_PROVIDER` | V | `supabase_storage` (v1 — §1.1/OQ-6) |
| `MEDIA_SIGNED_URL_TTL_SEC` | V | default 900 วิ (สูงสุด 86,400 — config.ts:55) |
| `R2_*` (5 ค่า) / `STREAM_*` (2 ค่า) | ✖ (v1) | ไม่ตั้งจนกว่าจะมีเส้นทางจริง (OQ-6) |
| `EMAIL_PROVIDER` | V | `resend` — ขาดค่าคู่ = boot fail (config.ts:121-124) |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD` | ✖ | dev Mailpit เท่านั้น — อีเมลยืนยันของ GoTrue บน cloud ตั้งผ่าน **SC → Auth → SMTP Settings** (แยกจาก Resend ของแอป — gate p4-r1 M5) |
| `EMAIL_FROM` | V | ชื่อทางการ เช่น "สภาทนายความแห่งประเทศไทย ระบบ E-Learning" + โดเมนที่ verify กับ Resend แล้ว |
| `RESEND_API_KEY` | V | ของบัญชี Resend จริง |
| `CRON_SECRET` | V | `openssl rand -hex 32` · ตั้งแล้ว Vercel Cron ใช้ค่าเดียวกันทั้งผู้ส่ง/ผู้ตรวจ |

### 3.3 Rate limit / session / lockout / การเรียน (canonical ชุดเดียวทุก environment)

| กลุ่มตัวแปร | prod ตั้งที่ | หมายเหตุ |
|---|---|---|
| `RATE_LIMIT_AUTH_PER_MIN` (10) · `EXAM` (60) · `VERIFY` (120) · `READ` (120) · `LEARN_WRITE` (120) · `STAFF_WRITE` (60) · `MFA` (10) · `EXPORT_PER_HOUR` (10) · `DEFAULT` (120) | V | ค่า default canonical ตาม API-SPEC §5 — ตั้งชัดเพื่อกัน surprise · **กลุ่ม `OTP_PER_HOUR` (3) กับ `PWD_RESET_PER_HOUR` (5) มี default ในโค้ด (config.ts:69-70) แต่ไม่อยู่ใน `.env.example`** — ถ้าต้องการ override ให้ตั้งชื่อ `RATE_LIMIT_OTP_PER_HOUR`/`RATE_LIMIT_PWD_RESET_PER_HOUR` |
| `SESSION_ADMIN_IDLE_MINUTES` (15) · `SESSION_ADMIN_ABSOLUTE_HOURS` (8) · `SESSION_LEARNER_IDLE_MINUTES` (60) | V | คงค่า default |
| `LOGIN_LOCKOUT_ATTEMPTS` (5) · `WINDOW_MINUTES` (15) · `DURATION_MINUTES` (15) | V | คงค่า default |
| `VIDEO_HEARTBEAT_SEC` (15) · `VIDEO_COMPLETE_PCT` (80) · `DOC_MIN_DWELL_SEC` (30) · `EXAM_AUTOSAVE_SECONDS` (15) · `EXAM_DISCONNECT_GRACE_MINUTES` (5) | V | คงค่า default (VIDEO_COMPLETE_PCT รอยืนยัน Q6 เดิม) |

### 3.4 Secret บังคับของ prod (fail-fast) + การหมุน

| ตัวแปร | สร้างด้วย | ผลข้างเคียงการหมุน (SECRETS-PROVISIONING §2) |
|---|---|---|
| `CURSOR_HMAC_SECRET` | `openssl rand -base64 32` | cursor เก่าตายทันที (400 ERR-VAL-001 — ผู้ใช้เริ่มหน้าใหม่ได้) · **ห้ามหมุนกลางช่วงสอบ** · หมุน = generate → ตั้ง env → **redeploy ทุกครั้ง** (ไม่มี hot reload) |
| `IP_HASH_SALT` | `openssl rand -base64 32` | digest เปลี่ยนค่าทันที แถว append-only เก่าจับคู่ข้ามรอบไม่ได้ (ยอมรับได้ — ใช้ทางสถิติ) · ไม่มี downtime · ไม่ต้องเลี่ยงช่วงสอบ |
| `LTC_MFA_PENDING_KEY` | `openssl rand -base64 32` | stash ที่เข้ารหัสด้วยคีย์เก่าอ่านไม่ได้ — login สองขั้นที่ค้างระหว่างหมุนต้องเริ่มใหม่ · หมุนตอน traffic ต่ำ |

**นโยบายหมุนเชิงระบบ (ข้อเสนอ):** service key ของ Supabase หมุนเป็นคู่กับ env ของ Vercel ในรอบเดียว · DB password (ฝังใน pooler URL) หมุนที่ Supabase → อัปเดต Vercel env → redeploy · `RESEND_API_KEY` — อีเมลค้างส่งช่วงหมุน ตรวจ outbox หลังจบ · ทุกการหมุนบันทึกเหตุการณ์+เวลาใน log ของ สภาทนายความฯ (ไม่ใช่ใน repo)

### 3.5 ห้ามตั้งใน staging/prod เด็ดขาด

- `TEST_DATABASE_URL` · `TEST_SUPABASE_URL` · `TEST_SUPABASE_ANON_KEY` · `TEST_SUPABASE_SERVICE_ROLE_KEY` · `TEST_USER_PASSWORD` — dev/test harness เท่านั้น
- `UAT_DEMO_PASSWORD` — เครื่องสาธิตเท่านั้น
- `POSTGRES_PASSWORD` · `POSTGRES_HOST_PORT` — compose เท่านั้น
- NEXT_PUBLIC_ ใด ๆ ที่มี SERVICE_ROLE ในชื่อ — `loadConfig` ปฏิเสธทันที (`PUBLIC_SERVICE_ROLE_BAN`) · แอปเป็น BFF ทั้งหมด (ไม่มี `createBrowserClient` — ssr.ts:5) ค่า NEXT_PUBLIC_* ที่ CI ตั้งเป็น placeholder ตอน build เท่านั้น ไม่ต้องตั้งบน Vercel

### 3.6 ค่าที่อยู่บนแพลตฟอร์ม (ไม่ใช่ env ของแอป)

| ที่ | รายการ |
|---|---|
| **Supabase (SC)** | ปิด autoconfirm · SMTP ของ Auth · password min 12 · Leaked password protection · Site URL/Redirect URLs โดเมนจริง · email rate limit ค่า default ของแผน (~30/ชม. — เทียบปริมาณผู้สมัคร ถ้าต่ำให้อัปเกรดแผน ไม่ใช่ปล่อยสูง) · **เปิด setting db-aggregates** (§1 แถว 4) · API max rows ≥ 1000 · bucket 4 ใบ (private) · PITR/scheduled backups |
| **Cloudflare (CF)** | DNS zone + proxy · TLS · WAF rules (§4.2) · Turnstile widget keys (site key → ใช้ในหน้าจอ · secret → Vercel env — ชื่อตัวแปรใหม่ เสนอ `TURNSTILE_SECRET_KEY`) · Access policy (ถ้าเลือกใช้ §4.4) · rate limiting rules |
| **Vercel** | region · Node version (OQ-11) · `vercel.json` crons (OQ-13) · domain assignment · log drain (OPE-001) |

---

## 4. Cloudflare security design (ปิด BL-003)

BL-003 ระบุ deliverable เป็น "ADR in docs/adr/ — which protections run where" — DCR นี้ทำหน้าที่นั้น (ตาราง §4.5) · เมื่อ consensus แล้วจะย้าย/อ้างเป็น ADR ได้ตามที่ BL-003 ขอ

### 4.1 Zone/DNS หน้า Vercel

- โดเมนหลัก CNAME → `cname.vercel-dns.com` · สถานะ **proxied (orange cloud)** เพื่อให้ WAF/Turnstile/Access ทำงาน · staging ใช้ subdomain แยก (เช่น `staging.<โดเมน>`) ตามแบบแผน ARCHITECTURE §5.5
- **TLS: Full (strict)** (ใบรับรอง origin ของ Vercel เป็น CA สาธารณะ — ใช้ได้) · Min TLS 1.2 · **HSTS: ปล่อยจากแอปอย่างเดียว** (next.config.ts:24 max-age 180 วัน) — **ไม่เปิด HSTS ที่ Cloudflare ซ้ำ** (header ซ้ำ = พฤติกรรมไม่คาดเดา ทำนองเดียวกับบทเรียน CSP ซ้ำ gate r1 F8)
- **ความเสี่ยง IP trust ที่ต้องตัดสินก่อนเปิด proxy (OQ-1):** `getClientIp` อ่าน **ค่าแรก** ของ `x-forwarded-for` แล้ว `x-real-ip` (rate-limit.ts:172-179 · SDS §5.3) — เมื่อมี Cloudflare อยู่หน้า Vercel client ปลอมได้ฝัง XFF ด้านหน้าสายโซ่ (CF append ค่าจริงต่อท้าย) ค่าแรกจึงอาจเป็นของปลอม → ตัวนับ rate limit ต่อ IP (โดยเฉพาะ PUBLIC_READ ที่คีย์จาก IP ดิบ) ถูกหลอกแยกถังได้ · **ทางเลือก:** (ก) แก้โค้ดให้อ่าน `CF-Connecting-IP` เมื่อมี (แก้ + SDS §5.3 + เทส — งานหลัง gate) หรือ (ข) DNS-only ไม่ proxy (เสีย WAF/Turnstile ทางเข้า) · **ข้อเสนอ devops: (ก)** พร้อม probe พิสูจน์จริง (curl ฝัง XFF ปลอมผ่าน CF แล้วดูคีย์ที่ rate limitter ใช้)

### 4.2 WAF baseline (ข้อเสนอเริ่มต้น)

1. **Managed rules**: Cloudflare Managed Ruleset + OWASP Core Ruleset (sensitivity medium) ทำงานบน `/api/*` และหน้าเว็บ · สั่ง Log ก่อน Block 1 สัปดาห์แรกของ staging เพื่อจับ false positive (ฟอร์มไทย/เนื้อหา JSON ยาว)
2. **Custom rules:**
   - `/api/internal/*` — **จำกัดการเข้าถึงจากขอบเขต** (OQ-9): endpoint ตรวจ Bearer CRON_SECRET อยู่แล้ว (fail-closed 404) แต่ควรบล็อก/ท้าทายที่ edge ด้วย — ข้อควรระวัง: **Vercel Cron ยิง production domain ผ่าน DNS ปกติ** ถ้าโดเมน proxied ผ่าน CF กฎห้ามบล็อก cron ของ Vercel เอง (ทางแก้: allowlist ตาม ASN ของ Vercel หรือยอมให้ผ่านเพราะชั้น Bearer เป็นตัวคุมจริง — ตัดสินที่ OQ-9)
   - บล็อก method/path ที่ระบบไม่ใช้ต่อ endpoint (เช่น non-GET บน `/verify/*` สาธารณะ) — ทำเป็นรายการหลังสำรวจ API-SPEC
3. **Bot Fight Mode**: โหมดอนุรักษ์ — ต้องทดสอบว่าไม่บล็อก Playwright/e2e ของ staging (PROD-CHECKLIST §5)
4. **ความพึ่งพาแผน:** managed rules/จำนวน custom rules/rate limiting rules ของ free tier จำกัด — **ตัดสินแผน (Pro/Business) ตาม OQ-2 ก่อน implement**

### 4.3 Turnstile — ตำแหน่งและการต่อ (ข้อเสนอ: 3 จุด)

| จุด | หน้าจอ/endpoint | เหตุผล | ข้อควรระวัง |
|---|---|---|---|
| สมัคร | `/(auth)/register` + action ฝั่ง server | กัน bot สร้างบัญชี (ค่าใช้จ่ายอีเมล/ความสะอาดข้อมูล) | ต้อง verify ฝั่ง server (siteverify + secret + remoteip) ก่อนดำเนินการ — ไม่เชื่อ client |
| ล็อกอิน (ขั้น 1) | `/(auth)/login` | คุม credential stuffing เสริม lockout 5 ครั้ง/15 นาที + AUTH 10/นาที | login สองขั้น: ตรวจ token ที่ขั้น 1 พอ (ขั้น MFA มี rate limit MFA + TOTP อยู่แล้ว) |
| ส่งข้อสอบ | `POST /api/v1/attempts/[id]/submit` | กัน submit อัตโนมัติจากสคริปต์ | token อายุสั้น (~300 วิ) ต้อง issue ตอนกดส่ง · **auto-submit ของ pg_cron เป็นเส้นทาง server ไม่ผ่าน Turnstile** (by design) · ป้องกันเบรก e2e: staging ใช้ test keys (always-pass) ของ Turnstile |

**ข้อจำกัดเชิงโค้ดที่ต้องรู้ก่อน (งานหลัง gate ทั้งหมด):** แอปยังไม่มีโค้ด Turnstile ใด ๆ · CSP ของระบบเป็น nonce + strict-dynamic (next.config.ts:15-20 หมายเหตุ) — script ของ Turnstile ต้องรับ nonce จากหน้า + เพิ่ม `frame-src https://challenges.cloudflare.com` (และ `connect-src` สำหรับ siteverify ทำฝั่ง server ไม่กระทบ) · ตัวแปรใหม่: `TURNSTILE_SITE_KEY` (ใช้ในหน้าจอ) + `TURNSTILE_SECRET_KEY` (server · Vercel env · fail-closed ถ้าเปิดใช้แต่ขาดค่า — ให้กำหนดใน DCR implementation)

### 4.4 Cloudflare Access สำหรับพื้นที่เจ้าหน้าที่ (evaluate — OQ-4)

- ขอบเขตที่เป็นไปได้: path `/admin*` (หน้า) + `/api/v1/admin/*` (BFF) — คุมที่ edge ด้วย policy อีกชั้น **เหนือ** RBAC ของแอป (defense in depth — ไม่แทนกันได้)
- ข้อดี: ปิดพื้นผิวโจมตี admin จากอินเทอร์เน็ตทั้งหมดก่อนถึงแอป · ข้อเสีย/ต้นทุน: (1) ต้องมี IdP (One-Time PIN อีเมล หรือตัวตนอื่นของ สภาทนายความฯ) (2) e2e/pentest ต้องมี service token (`CF-Access-Client-Id/Secret`) — เทสต้องรับ env ใหม่ (3) cookie session สองชั้น (Access + แอป) UX เจ้าหน้าที่เพิ่มขั้น
- **ข้อเสนอ devops: เปิดบน staging ก่อน (ระหว่าง pentest §9 ของ PROD-CHECKLIST) · ตัดสินเปิด prod หลังเห็นผล pentest** · free tier รองรับผู้ใช้ ≤ 50 — เกินต้องพิจารณาแผน

### 4.5 Rate limiting สองชั้น — ใครคุมอะไร (ตาราง "which protections run where" ของ BL-003)

ตัวนับของแอปเป็น **in-memory ต่อ instance** — บน Vercel หลาย instance ทำให้เพดานจริง = เพดาน × จำนวน instance ที่รับ request นั้น (PROD-CHECKLIST §5 Wave G P1) · การออกแบบจึงเป็นสองชั้นเสมอ:

| ชั้น | คุมอะไร | ข้อจำกัด |
|---|---|---|
| **Cloudflare (per-IP หยาบ)** | กลุ่มที่โจมตีจาก IP เดียวได้จริง: `AUTH` 10/นาที · `MFA` 10/นาที · `PWD_RESET` 5/ชม. · `OTP` 3/ชม. (ปิดอยู่ v1 — ใช้เตรียมอนาคต) · `PUBLIC_READ/VERIFY` 120/นาที | คีย์ได้แค่ IP (ไม่เห็น email/user ใน body) · จำนวน rules ขึ้นกับแผน |
| **แอป (แม่นต่อ identity)** | ทั้ง 10 กลุ่มตามตาราง canonical `rate-limit.ts:44-53` (คีย์รอง email/user/destination ต่อไป) + lockout บัญชี | เพดานคูณจำนวน instance — **ยอมรับได้ช่วงเปิดตัว (instance น้อย) · ก่อน scale จริงต้องย้ายเก็บร่วม (เช่น Upstash Redis) หรือให้ CF เป็นตัวคุมหลักกลุ่ม per-IP** (OQ-2) |

กฎเกณฑ์: **CF = ประตูแรก per-IP · แอป = ความแม่นต่อตัวตน + ทุกกรณีที่ CF มองไม่เห็น** · ห้ามปล่อยกลุ่มใดให้ "CF เท่านั้น" โดยไม่มีชั้นแอปคอยหลัง

### 4.6 COOP/COEP/CORP (ค้างจาก VA-PENTEST §3.5 — ยกมาให้ตัดสินพร้อมกัน)

- `Cross-Origin-Opener-Policy: same-origin` — ใส่ได้เลย
- `Cross-Origin-Embedder-Policy: require-corp` — **ขัดกับสื่อ cross-origin ผ่าน signed URL ของ Supabase Storage** (แอปกับ storage ต่างโดเมน) · ทางเลือก: (ก) ไม่ใส่ COEP (ยอมรับความเสี่ยง Spectre-class ต่ำ — ZAP จัด Low) หรือ (ข) ใส่พร้อม CORP header ที่ storage endpoint + credentialless แล้วทดสอบเล่นวิดีโอ+เปิด PDF จริงทุกเบราว์เซอร์เป้าหมาย · **ผูกกับ OQ-7** (โดเมนของ storage)

---

## 5. Deploy pipeline design

### 5.1 GitHub Actions — ขยายจาก ci.yml ปัจจุบัน (5 ด่าน → เต็มสายถึง deploy)

ci.yml ปัจจุบัน: lint → typecheck → unit → build → gitleaks (ทุก PR เข้า develop/main) · สาย deploy เพิ่ม:

```
PR (ci.yml เดิม + ด่านใหม่)
  ├─ lint → tsc → unit → build → gitleaks          (มีอยู่แล้ว)
  ├─ integration (ใหม่): ปั้น service db/auth/rest/kong ด้วย compose บน runner
  │   → TEST_DATABASE_URL ชี้ localhost → npm run test:integration
  └─ (ไม่รัน e2e บน PR — หนักเกิน ทำที่ staging)

merge → develop (staging)
  └─ deploy-staging: supabase db push --linked (staging ref) → Vercel deploy (สาย staging)
      → smoke e2e บน staging URL: สมัคร/เรียน/สอบ/ใบประกาศ/verify/อีเมลจริง
      → PERF วัดตาม PROD-CHECKLIST §7 (k6 — งานหลัง staging พร้อม)

merge → main หรือ tag (prod)
  └─ deploy-prod (manual environment approval — ปุ่มของ CTO):
      gate 5 ด่านรันซ้ำบน main → supabase db push (prod ref) → Vercel deploy prod
      → post-deploy probe: /api/health 200 · aggregates curl 200 · cron.job 8 แถว
        · bucket 4 ใบ · Turnstile siteverify 200 · สมัครจริง 1 ฉบับ (อีเมลถึงกล่อง)
```

หลักการ: **ลำดับ migration ก่อน app เสมอ** (schema ใหม่รองรับโค้ดใหม่ — expand/contract ดู §5.3) · token ที่ต้องมีใน GitHub secrets: `SUPABASE_ACCESS_TOKEN` + DB connection ของ staging/prod · `VERCEL_TOKEN` + org/project id (OQ-13)

### 5.2 Migration strategy (forward-only)

1. **ตัวรัน migration บน cloud: `supabase db push`** (ข้อเสนอ) — ledger ของ supabase CLI (ตาราง `supabase_migrations.schema.migrations`) แยกจาก `_dev.migrations` ของ dev (migrate.sh:6 ระบุชัดว่า dev-only) · **การตรวจ "ครบ 46 ไฟล์" ของ PROD-CHECKLIST §2.1 ต้องปรับเป็นตรวจตาม ledger ที่เลือก** — จุดนี้ต้องตัดสิน (OQ-5) เพราะทางเลือก B คือ port สคริปต์ migrate.sh รันผ่าน psql session pooler เพื่อคง ledger เดิม (ได้ parity แต่เสียการดูแลของ CLI)
2. **กฎห้ามแก้ของเก่าบนระบบขึ้นแล้ว** — ชุดที่ push แล้ว immutable · งานแก้ = ไฟล์ใหม่หมายเลขถัดไป (ต่างจาก dev ที่อนุญาต in-place + replay — แบบแผน DCR-ASM-011 ใช้ไม่ได้บน prod)
3. **db push gating**: รันเฉพาะใน workflow deploy ที่ผ่าน gate ครบ · prod ต้องกด approve มือ · ถ้า push ค้างละแม่น (ไฟล์ใหม่พังกลางทาง) — ไฟล์นั้นต้องถูก fix ด้วยไฟล์ถัดไป ไม่ใช่แก้ตัวเดิม
4. **seed**: staging รัน `seed-uat.sql` ครั้งเดียวตามคำสั่ง (บัญชี pentest ตาม PROD-CHECKLIST §9) · **prod ไม่รัน seed ใด ๆ อัตโนมัติ** (OQ-12)
5. ตรวจหลัง push: จำนวนตารางตาม DATA-DICTIONARY · `cron.job` ครบ 8 แถว (§2.1 ข) · timezone (§2.1 ก)

### 5.3 ความเข้ากันได้กับ rollback (expand/contract)

- **โค้ด/แอป**: Vercel instant rollback ไป deployment ก่อนหน้าได้ทันที (env ถูก inject ต่อ deployment — rollback กลับค่า env ตอน deployment นั้นสร้างด้วย)
- **ฐานข้อมูล**: ไม่มี down-migration (กฎหน้า) → ทุก migration ต้องเขียนแบบ **expand** (เพิ่ม column/tabel/index ก่อน) ไม่แตะของเก่าจนกว่าโค้ดเก่าเลิกใช้ — เพื่อให้ "app เก่า + schema ใหม่" ยังรันได้ระหว่าง rollback · contract (ลบของเก่า) ทำภายหลังเป็น migration แยกเมื่อ deployment เก่าหมดอายุแล้ว
- **ขั้นตอน rollback (ร่าง):** (1) Vercel rollback deployment ก่อนหน้า (2) ตรวจ `/api/health` + smoke (3) ถ้าพังที่ชั้นข้อมูล = ไม่ rollback DB — **แก้หน้า (roll forward)** ด้วย migration/โค้ดใหม่ (4) บันทึกเหตุการณ์ตามกระบวนการ incident ของ สภาทนายความฯ

### 5.4 Vercel project config (ร่าง — สร้างจริงหลัง gate)

- โปรเจกต์เดียว 2 environment: Production (โดเมนหลัก) · staging แยกตาม OQ-13 (อีก project หรือ branch environment พร้อมโดเมน `staging.*`)
- `vercel.json` (ไฟล์ใหม่ใน repo): crons 2 รายการ — `email-dispatch` ทุก `*/5` นาที (เริ่มอนุรักษ์ · ปรับได้ 1–5) · `pdpa-export` ทุก `*/15` นาที (ปรับได้ 5–15) · **หมายเหตุแผน: cron ถี่กว่า 1 ครั้ง/วันต้องการ Vercel Pro** (จุดพึ่งพาแผน — บันทึกใน §7)
- framework preset Next.js · Node 22.x pin ให้ตรง CI (OQ-11 — engines ของ repo คือ `>=20` · PROD-CHECKLIST §4 เขียน Node 20 · CI ใช้ 22 — ต้อง nail ให้ตรงกันทั้งสาย)
- region: Singapore (hkg ทางเลือก) — OQ-10 · log drain เปิดเพื่อ OPE-001 (structured log ตาม SYSTEM-TEST §5.2)
- `SUPABASE_SERVICE_ROLE_KEY` ตั้งเฉพาะชั้น server (ไม่มี NEXT_PUBLIC_ = ไม่รั่วไป client — SDS §5.1)

---

## 6. OPEN QUESTIONS — รายการตัดสินใจสำหรับ CTO (decision list)

| # | คำถาม | ข้อเสนอ devops | ผลกระทบถ้าไม่ตัดสิน |
|---|---|---|---|
| OQ-1 | เปิด Cloudflare proxy (orange cloud) หรือไม่ + แก้ `getClientIp` ให้อ่าน `CF-Connecting-IP` (โค้ด+SDS §5.3+เทส) | เปิด proxy + แก้โค้ดก่อน deploy (พร้อม probe พิสูจน์) | rate limit per-IP ถูกหลอกแยกถังได้ตั้งแต่วันแรก (SEC-005 ย่ำ) |
| OQ-2 | ขอบเขต CF rate limiting (กลุ่มใดบ้าง) + แผน Cloudflare ที่จำเป็น (Pro เพื่อ managed WAF/หลาย rules?) + กลยุทธ์ instance-scaling (ยอมรับเพดานคูณช่วงเปิดตัว → Upstash Redis ภายหลัง?) | CF คุม 4 กลุ่ม per-IP หยาบ (AUTH/MFA/PWD_RESET/VERIFY) · แอปคุมต่อ identity ทุกกลุ่ม · วาง Upstash ไว้ในผัง post-go-live | งบ/แผนไม่นิ่ง กฎไม่รู้ว่าจะใส่ได้จริงหรือเปล่า |
| OQ-3 | ขอบเขต Turnstile v1: 3 จุด (สมัคร/ล็อกอิน/ส่งข้อสอบ) หรือลดเหลือ 2 (ตัดส่งข้อสอบ) · โหมด managed/invisible | เริ่ม 3 จุดพร้อม staging ใช้ test keys · ตัดส่งข้อสอบออกได้ถ้า pentest เห็นว่าต้นทุน UX สูง | งานโค้ด Turnstile (CSP+verify+env) ไม่รู้ขอบเขต |
| OQ-4 | Cloudflare Access สำหรับ `/admin*`: เปิด prod หรือ staging-only ก่อน · IdP อะไร (OTP อีเมล?) · จัด service token ให้ e2e/pentest อย่างไร | staging ก่อน ตัดสิน prod หลัง pentest | พื้นผิว admin เปิดหน้ากว้างตั้งแต่วันแรก |
| OQ-5 | ตัวรัน migration บน cloud: `supabase db push` (ledger CLI) หรือ port `migrate.sh`/`_dev.migrations` ผ่าน psql | db push + ปรับวิธีตรวจ "ครบทุกไฟล์" ไปอ่าน ledger CLI | ขั้นตอนตรวจของ PROD-CHECKLIST §2.1 ใช้ไม่ได้ตรง ๆ |
| OQ-6 | MEDIA_PROVIDER v1 = `supabase_storage` (as-built) โดยรอ R2/Stream ไว้หลัง go-live — ยืนยันรับ | ใช่ (ตาม §1.1) | เสี่ยงเลือกค่าที่โค้ดไม่รองรับ → บทเรียนวิดีโอพังเงียบ |
| OQ-7 | โดเมนของ storage: ใช้ `https://<ref>.supabase.co` ตรง ๆ หรือทำ custom domain (เช่น `storage.<โดเมน>`) proxy ผ่าน CF | ใช้ supabase.co ตรง ๆ v1 (น้อย moving part) — custom domain ไว้คู่กับรอบทบทวน R2 | ผูกกับ COOP/COEP/CORP (§4.6) ที่ยังไม่ตัดสิน |
| OQ-8 | COOP/COEP/CORP verdict (ก ไม่ใส่ COEP vs ข ใส่พร้อม CORP+credentialless แล้วทดสอบจริง) | (ก) ช่วง v1 — จดตามแบบฟอร์ม PROD-CHECKLIST §5 | ค้างจาก VA-PENTEST — ห้ามปล่อยข้าม go-live |
| OQ-9 | การบล็อก `/api/internal/*` ที่ edge เมื่อ Vercel Cron เดินผ่านโดเมน prod เอง | ไม่บล็อกที่ edge ช่วง v1 (ชั้น Bearer CRON_SECRET คุมจริง + 404 เงียบ) · พิจารณา allowlist ASN ภายหลัง | cron อาจโดนกฎ CF ตัดโดยไม่ตั้งใจ = อีเมล/PDPA หยุดเดินเงียบ |
| OQ-10 | region ของ Vercel + Supabase (Q5 เดิม — PDPA cross-border) | SG ทั้งคู่ ใกล้กันใกล้ไทย | latency + ข้อกฎหมายข้อมูลไม่นิ่ง |
| OQ-11 | Node runtime บน Vercel: 20 หรือ 22 | 22 ให้ตรง CI (engines >=20 รองรับ) — แก้ PROD-CHECKLIST ให้ตรง | build/runtime คนละเวอร์ชัน = พฤติกรรมต่างกันได้ |
| OQ-12 | seed policy: staging = seed-uat ครั้งเดียวต่อการสร้างใหม่ · prod = ไม่มี seed — ใครอนุมัติ | ตามที่เสนอ · CTO อนุมัติเป็นลายลักษณ์อักษรใน verdict | ข้อมูล demo ปนเข้า prod ได้ |
| OQ-13 | รูปทรง staging: Vercel project แยก + Supabase project แยก (ข้อเสนอ) หรือ Vercel branch environment + Supabase branch · ตาราง cron ใน `vercel.json` (email `*/5` · pdpa `*/15`) | project แยก (ง่ายกว่า ตรวจง่ายกว่า — สอดคล้อง ARCHITECTURE §5.5 "ปลายทาง cloud อีกชุด") | staging อาจแชร์ state กับ prod โดยไม่ตั้งใจ |
| OQ-14 | ยอมรับนโยบาย rollback (§5.3: app rollback ได้ · DB roll-forward เท่านั้น + วินัย expand/contract) | ยอมรับตามร่าง | ตอนเหตุการณ์จริงจะตัดสินใจช้าเพราะไม่มีข้อตกลงไว้ |

---

## 7. สิ่งที่ผู้ใช้ (สภาทนายความฯ / product owner) ต้องจัดให้ — external blockers

1. **โดเมนจริง + สิทธิคุม DNS** — ชื่อโดเมนหลัก (apex/www) + subdomain staging · ตัดสินชื่อเพื่อตั้ง `PUBLIC_BASE_URL`/`CERT_PUBLIC_BASE_URL`/Site URL/Resend sender
2. **บัญชี Cloudflare** + zone ของโดเมน (โอน/สมัคร) · สิทธิ์สร้าง Turnstile widgets + Access policy · การเลือกแผน (OQ-2)
3. **บัญชี Vercel** (team/org) + สิทธิ์เชื่อม GitHub repo และสร้าง project · **แผน Pro อย่างน้อย** สำหรับ cron ถี่กว่า 1 ครั้ง/วัน (2 งานของ §2.2)
4. **บัญชี Supabase Cloud** + สร้าง org/project 2 โปรเจกต์ (staging/prod ตาม OQ-13) · เลือกแผนที่รองรับ **PITR/scheduled backups** (PROD-CHECKLIST §6) · ยืนยัน region (OQ-10)
5. **บัญชี Resend** + **verify โดเมนผู้ส่ง (DKIM/SPF — ต้องแก้ DNS จริง)** + ออก API key · ตัดสินผู้ส่งที่แสดง (ชื่อทางการ)
6. **API tokens สำหรับ pipeline**: `SUPABASE_ACCESS_TOKEN` (CLI/CI) · `VERCEL_TOKEN` + org/project id · เก็บใน GitHub secrets (ผู้ใช้หรือ CTO ออกให้)
7. **ผู้ใช้/รายชื่อเจ้าหน้าที่สำหรับ Cloudflare Access** (ถ้า OQ-4 เลือกใช้) + นโยบายอีเมลองค์กรที่จะใช้รับ OTP
8. **ความยินยอมด้านข้อมูล**: ยืนยัน region/ residency ตาม PDPA (OQ-10) กับผู้รับผิดชอบข้อมูลของ สภาทนายความฯ
9. **งบแผนรายเดือน** (Cloudflare/Vercel/Supabase/Resend รวมกัน) + เจ้าของการจ่าย
10. **หน้าต่างเวลา go-live** + ผู้ลงนามตามตาราง §11 ของ PROD-CHECKLIST · จ้าง external pentest (เงื่อนไขบังคับก่อน go-live — VA-PENTEST §5)

---

## 8. สิ่งที่ DCR นี้ไม่ทำ / ขั้นถัดไป

- **ไม่ implement อะไร** — ไม่สร้าง `vercel.json` · ไม่แตะ compose/CI/โค้ด · ไม่ตั้งค่าแพลตฟอร์มใด จนกว่า consensus gate ผ่าน (Brief §9)
- หลัง verdict: (1) อัปเดตเอกสารนี้เป็นฉบับถาวร + แก้ไดอะแกรม ARCHITECTURE §5 ให้ตรง as-built (§2.3) + ย้ายตาราง §4.5 ไป ADR ตามที่ BL-003 ขอ (2) เปิดงาน implement ตามลำดับ OQ ที่ตัดสินแล้ว (3) เดิน PROD-CHECKLIST 1.0.3 เป็นแบบฟอร์มตรวจจริงตอน deploy — DCR นี้ออกแบบ "ทำอย่างไร" · PROD-CHECKLIST เป็น "ตรวจอะไร"
- ขอบเขตที่ตัดออกไว้ (ส่งต่อ): PERF-001..008 วัดจริง (PROD-CHECKLIST §7) · external pentest (§9) · OTP SMS (§8 — ปิดใน v1) · Upstash Redis สำหรับ rate limit ร่วม (OQ-2 ภายหลัง) · R2/Stream (OQ-6 ภายหลัง)

---

*ท้ายเอกสาร — ร่างโดย devops 13 ตุลาคม 2026 · ทุกข้ออ้าง `ไฟล์:บรรทัด` ตรวจกับ working tree จริงของ repo · การเปลี่ยนแปลงเชิงสถาปัตยกรรมต้องผ่าน gate ตามกฎ Brief §9 · **DRAFT — รอ CTO review***


## 9. OQ เพิ่มภายหลัง (carry-over จาก BL-015 · DCR-GATEWAY-ERRBODY-REBASELINE · 2026-10-13)

- **OQ-15 (image drift / digest-pin)**: บทเรียน postgrest:v12.2.3 — tag เดิม content เปลี่ยนทาง upstream โดยไม่มีใครแตะ repo (pull ใหม่ 2026-10-13 relay error body ต่างจากที่ตรวจ 2026-09-15) — dev ปัจจุบัน pin postgrest ด้วย digest แล้ว (DCR-GATEWAY-ERRBODY-REBASELINE จุด 4) · **คำถาม**: ชุด Supabase Cloud ฝั่ง prod คุมเวอร์ชัน PostgREST/GoTrue/Kong อย่างไรให้ทีมรู้ล่วงหน้าเมื่อพฤติกรรม error-response เปลี่ยน (managed platform อัปเกรดเอง) + ควรตรวจ digest ของ kong/gotrue/storage-api ใน compose dev ด้วยหรือไม่ (ตอนนี้ยัง tag-based)
- **OQ-16 (anon key ที่ผิว gateway)**: ผิว direct-gateway (/rest/v1) ของ Kong dev ยอมรับ **anon key** (kong.yml:47-50 · consumers :98-100) — error message ของ RPC (รวมแท็ก envelope ERR-*) มองเห็นได้ด้วย anon key หลัง postgrest ใหม่ · **คำถาม**: prod gateway (Supabase Cloud) ต้องไม่ยอมรับ anon key ในที่ที่ DB grants ห้ามอยู่แล้วหรือไม่ — ทบทวนร่วมกับแผน WAF/Access ของ Cloudflare (§4) ว่าจะบังผิว /rest/v1 โดยตรงหรือเปิดเฉพาะที่แอปใช้
