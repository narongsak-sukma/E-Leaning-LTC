# Production Checklist — LTC E-Learning (Wave F Phase 4 · D-f-13)

|          |                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| เวอร์ชัน | 1.0.0 — ฉบับแรก: รายการตรวจ/ตั้งค่าก่อนเปิดระบบจริงบน cloud (Cloudflare + Vercel + Supabase Cloud) — **ทุกบรรทัดตรวจกับ compose/config จริงของ repo แล้ว (อ้าง `ไฟล์:บรรทัด`)** · พับธงเก่าที่ค้างมาตั้งแต่ wave ก่อน: PGRST aggregates (§2.3) · RESEND/EMAIL_PROVIDER (§3) · MAILER_AUTOCONFIRM (§2.2) · SUPABASE_PUBLIC_URL (§2.4) · backup/restore (§6) |
| วันที่    | 2026-09-13                                                                                                                    |
| อ้างอิง  | SDS §7 (env vars) · `.env.example` · `docker-compose.yml` · `src/lib/config.ts` · VA-PENTEST 1.3.0 (§3.5 COOP/COEP/CORP · §5 external pentest · V14.2.x ค่าลับ placeholder) · SYSTEM-TEST 1.0.1 (§5.2 สิ่งที่ส่งต่อ prod) · SECURITY-REMEDIATION §4 (npm audit accept-with-expiry) · `.omc/plans/wave-f-plan.md` (D-f-8 · D-f-13) |
| ขอบเขต  | สภาพแวดล้อม production/staging ของ สภาทนายความฯ — ไม่ใช่ dev stack (dev = 100% local Docker ตาม Brief) · ใช้เป็น checkbox เดินตรวจทีละข้อก่อน go-live · ผู้ลงนามปิดท้าย §11 |

---

## 1. สรุปผู้บริหาร

- โค้ดชุดเดียวกับ dev ต่างกันเฉพาะค่า environment (Brief §6 — ห้าม hardcode) · ค่า prod ทั้งหมดเข้าผ่าน env vars ของ platform (Vercel/Supabase Cloud) **ห้าม commit ลง repo ทุกกรณี**
- มี **3 ค่าที่ระบบปฏิเสธการบูตถ้าไม่ตั้งใน prod** (fail-fast ที่ `src/lib/config.ts` — ตรวจเมื่อ `APP_ENV=prod`): `CURSOR_HMAC_SECRET` (config.ts:130 · PB-9) · `IP_HASH_SALT` (config.ts:139 · PB-13) · `LTC_MFA_PENDING_KEY` (config.ts:148 · gate r1 F2/F5) — ตั้งตามวิธีใน `docs/09-dev/SECRETS-PROVISIONING.md`
- สิ่งที่ dev ตั้ง "หลวมกว่า" โดยตั้งใจและ prod ต้องตรวจย้อน: ค่า placeholder canonical ของ Supabase local (JWT/anon/service key — V14.2.x ของ VA-PENTEST) · `GOTRUE_RATE_LIMIT_EMAIL_SENT=1000` (dev สูงเพราะ integration suite — docker-compose.yml:66-69) · `GOTRUE_URI_ALLOW_LIST` ชี้ localhost (docker-compose.yml:55)
- สิ่งที่ dev ตั้ง "เข้มกว่า/ถูกต้องแล้ว" และ prod ต้อง**คงไว้**: `GOTRUE_MAILER_AUTOCONFIRM=false` (docker-compose.yml:64) · `GOTRUE_PASSWORD_MIN_LENGTH=12` (:65) · `GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated` (:62 · PB-6) · PGRST aggregates เปิด (§2.3)
- งานที่จ้างภายนอกและ**เงื่อนไขบังคับก่อน go-live**: external pentest (VA-PENTEST §5 — เกณฑ์ 0 High/Critical เปิดค้าง)

---

## 2. Supabase Cloud (ฐานข้อมูล · Auth · Storage)

### 2.1 โครงสร้าง/ค่าลับ

- [ ] **สร้างโปรเจกต์ใหม่ ห้ามใช้ค่า placeholder ของ local dev ทุกชนิด** — JWT secret / anon key / service key ของ `.env.example` และ `docker/kong/kong.yml` เป็นค่า canonical สาธารณะของ Supabase local (ref `0000…` — VA-PENTEST V14.2.x จดคำเตือนไว้แล้ว) · prod ต้องเป็นค่าที่ platform ออกให้เท่านั้น
- [ ] **Run migrations ครบทั้ง 46 ไฟล์** (`supabase/migrations/0001…0046`) ตามลำดับ — โครงสร้าง/RLS/RPC/trigger ทั้งหมดของระบบอยู่ที่นี่ (SDS §6 · MAINT-003) · ตรวจจบด้วย `_dev.migrations` ledger ครบ 46 แถว + `select count(*) from pg_tables where schemaname='public'` ตรงตาม DATA-DICTIONARY
- [ ] **สร้าง buckets สองใบ**: `media` (วิดีโอ/PDF ใบประกาศ — private) และ `license-evidence` (ไฟล์แนบใบอนุญาต — private) ตามชื่อที่โค้ดใช้จริง (`docker/volumes/storage` ของ dev + API-SPEC §3.2)
- [ ] `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` ตั้งบน Vercel เป็นค่าของโปรเจกต์จริง · `SUPABASE_DB_POOLER_URL` ใช้ pooler ของ cloud (`.env.example:43` รูปแบบ)

### 2.2 Auth (GoTrue บน cloud)

- [ ] **"Confirm email" เปิดอยู่** = `GOTRUE_MAILER_AUTOCONFIRM=false` สมมูล — dev ตั้ง false ไว้แล้ว (docker-compose.yml:64) · **บน Supabase Cloud หลายแผนค่า default คือยืนยันอัตโนมัติ** ต้องเข้า Auth → Settings ปิด manual confirm ไม่งั้นสมัครได้โดยไม่ยืนยันอีเมล (ขัด AUTH-001)
- [ ] **รหัสผ่านขั้นต่ำ 12** — Auth settings ของ cloud ตั้ง ≥ 12 ให้ตรง `GOTRUE_PASSWORD_MIN_LENGTH=12` (docker-compose.yml:65 · VA-PENTEST V2.1.1)
- [ ] **Site URL / Redirect URLs** เป็นโดเมนจริงของระบบเท่านั้น (สมมูล `GOTRUE_URI_ALLOW_LIST` ที่ dev ชี้ `http://localhost:3000/**` — docker-compose.yml:55)
- [ ] **อีเมล rate limit กลับเป็นค่าอนุรักษ์** — dev ตั้ง `GOTRUE_RATE_LIMIT_EMAIL_SENT=1000` เพราะ integration suite สร้างผู้ใช้จริงหลายสิบรายต่อรอบ (คอมเมนต์ docker-compose.yml:66-69) · prod ปล่อยตาม default ของ platform/แผน (เช่น ~30 ฉบับ/ชม.) แล้วเทียบกับปริมาณผู้สมัครที่คาด ถ้าต่ำไปให้อัปเกรดแผน ไม่ใช่ปล่อยสูง
- [ ] Leaked password protection / การตั้งค่า MFA (TOTP) ของ cloud เปิดตาม default — ระบบเราผูก TOTP ผ่าน `/auth/v1/factors*` (probe จริงจาก gate p3-r1 B3 — docker-compose.yml:79-84)

### 2.3 PostgREST (สืบเนื่อง MAJOR-1 ของ gate p1-r1 — ธงเก่า)

- [ ] **เปิด db aggregates บน cloud** — หน้า monitoring/statistics ของเจ้าหน้าที่ใช้ `id.count()` / `score_pct.avg()` ผ่าน user-JWT client จริง (คอมเมนต์ docker-compose.yml:105-108) · dev ตั้ง `PGRST_DB_AGGREGATES_ENABLED: "true"` · **บน cloud ตรวจด้วยคำสั่งเดียวกันตามคอมเมนต์**: `curl "$SUPABASE_URL/rest/v1/courses?select=id.count()" -H "apikey: $ANON"` ต้องได้ 200 (ถ้า 400 `PGRST123` = ต้องเปิด setting db-aggregates ของโปรเจกต์)
- [ ] `PGRST_API_MAX_ROWS` สมมูล — ตรวจว่าแถวสูงสุดต่อ request ของ cloud ≥ 1000 (dev ตั้ง 1000 · docker-compose.yml:104)

### 2.4 ค่าที่ "ไม่ต้องตั้ง" ใน prod (กันตั้งเกิน)

- `SUPABASE_PUBLIC_URL` — **prod โดเมนเดียวไม่ต้องตั้ง** (ธงเก่าตาม D-f-13): ค่านี้มีไว้เฉพาะเมื่อผู้รับอีเมลเปิด URL ของ gateway ไม่ได้ (dev: `http://kong:8000` เปิดจากนอก container ไม่ได้ — email worker เขียนทับ protocol+host ของ signed URL ด้วยค่านี้ · config.ts:180-185) · ไม่ตั้ง = ใช้ `SUPABASE_URL` ตรง ๆ ซึ่งถูกต้องเมื่อ cloud URL เป็นสาธารณะ
- `SMTP_HOST/PORT` ของ Mailpit — dev เท่านั้น (docker-compose.yml:70-71) · prod ใช้ `EMAIL_PROVIDER=resend` ตาม §3

---

## 3. อีเมลจริง (Resend — ธงเก่าตาม D-f-13)

- [ ] `EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` ตั้งครบ — ขาดอย่างใดอย่างหนึ่งแล้วเลือก resend = **boot fail** ที่ superRefine (config.ts:121-124)
- [ ] **โดเมนผู้ส่ง verify กับ Resend แล้ว** (DKIM/SPF) — อีเมลระบบมี: ยืนยันอีเมลสมัคร · ยืนยันเปลี่ยนอีเมลสองลิงก์ · แจ้งผลสอบ · แจ้งออก/เพิกถอนใบประกาศ · ใกล้หมดรอบต่ออายุ (เทมเพลตไทยทั้งหมด — ทดสอบบน dev ผ่าน Mailpit :8025 ครบแล้ว · prod ต้องส่งถึงกล่องจริง)
- [ ] **ทดสอบส่งจริงหลังตั้งค่า**: สมัครบัญชีใหม่ 1 ฉบับ ต้องได้อีเมลยืนยันจากโดเมนจริง (ไม่ใช่แค่ console log — `EMAIL_PROVIDER=console` คือ dev เท่านั้น)
- [ ] ผู้ส่งแสดงชื่อทางการ เช่น "สภาทนายความแห่งประเทศไทย ระบบ E-Learning" (dev ใช้ `LTC E-Learning (dev)` — docker-compose.yml:73 เทียบรูปแบบ)

## 4. Vercel (แอป Next.js)

- [ ] `APP_ENV=prod` — ค่านี้เป็นตัวเปิดสวิตช์ตรวจทั้งชุด (fail-fast 3 ค่า §1 · secure cookie เฉพาะ prod — `src/lib/supabase/cookies.ts:33-37`) · ห้ามลืม ไม่งั้นระบบเดินด้วยค่า dev-grade
- [ ] `CURSOR_HMAC_SECRET` / `IP_HASH_SALT` / `LTC_MFA_PENDING_KEY` — สามค่าบังคับของ prod (config.ts:130/139/148 · วิธีเจาะจง `docs/09-dev/SECRETS-PROVISIONING.md`)
- [ ] `CERT_PUBLIC_BASE_URL=https://<โดเมนจริง>` — ตัวสร้าง QR บนใบประกาศนียบัตร (`.env.example:21-22`) · ลืมตั้ง = QR ชี้ localhost
- [ ] `MEDIA_PROVIDER` — prod เลือก `r2` (Cloudflare R2 + ครบ `R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET` — config.ts:100-106) หรือคง `supabase_storage` (ใช้ bucket `media` ของ §2.1) · `stream` ได้เช่นกัน (config.ts:107-113) — **ตัดสินครั้งเดียวตอนตั้ง แล้วทดสอบเล่นวิดีโอจริง** (signed URL 7 วัน — VA-PENTEST V12.5.1)
- [ ] Node.js 20 (engine ของ repo) · region ใกล้ผู้ใช้ไทย (เช่น Singapore/Hong Kong — latency ส่งต่อ PERF)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` ตั้งเฉพาะ environment ของ server (Vercel ไม่มี NEXT_PUBLIC_ นำหน้า = ไม่รั่วไป client) — กฎเดียวกับ SDS §5.1

## 5. Cloudflare / ขอบเขตเครือข่าย

- [ ] **TLS + HSTS ยืนยันบนโดเมนจริง** — โค้ดส่ง HSTS ทุก env อยู่แล้ว (next.config.ts:46) แต่ต้องยืนยันว่า certificate/โดเมนเสร็จ (V9.1.1 ส่งต่อจาก VA-PENTEST)
- [ ] **WAF/rate limit ระดับขอบเขต** — dev ใช้ in-memory (SEC-005 "ผ่านบางส่วน" ของ SYSTEM-TEST) · prod ต้องมีกฎที่ Cloudflare คุมกลุ่มเดียวกับ API-SPEC §5 (AUTH 10/นาที · MFA 10/นาที · OTP 3/ชม. ฯลฯ — ตาราง 10 กลุ่ม canonical ที่ `src/lib/rate-limit.ts:44-53`) — อย่างน้อยคุม `/api/v1/auth/*` และ `/api/v1/me/mfa/*`
- [ ] **คำวินิจฉัย COOP/COEP/CORP ตาม topology จริง** (ของใหม่จาก ZAP baseline — VA-PENTEST §3.5): `Cross-Origin-Opener-Policy: same-origin` ใส่ได้เลย · `Cross-Origin-Embedder-Policy: require-corp` **ขัดกับการโหลดสื่อ cross-origin ผ่าน signed URL ของ Supabase Storage** — ถ้าแอปกับ storage ต่างโดเมน การใส่ COEP require-corp จะทำให้วิดีโอ/PDF โหลดไม่ขึ้น · ทางเลือก: (ก) ไม่ใส่ COEP (ยอมรับความเสี่ยง Spectre-class ต่ำ — สอดคล้องการประเมินของ ZAP ที่จัด Low) หรือ (ข) ใส่พร้อม `Cross-Origin-Resource-Policy` header ที่ storage endpoint + credentialless mode แล้ว**ทดสอบเล่นวิดีโอ+เปิด PDF จริงทุกเบราว์เซอร์เป้าหมาย** · จดการตัดสินไว้ที่ไฟล์นี้เมื่อตัดสินแล้ว: ________
- [ ] Bot/flood protection ของ Cloudflare เปิดเป็นโหมดอนุรักษ์ (ทดสอบว่าไม่บล็อก Playwright/ผู้ใช้จริง)

## 6. สำรอง/กู้คืน (ธงเก่าตาม D-f-13)

- [ ] **PITR หรือ scheduled backups ของ Supabase เปิด** (แผนที่รองรับ) — ครอบทั้งฐานข้อมูล
- [ ] **สำรองสื่อของ bucket สองใบ** — Storage เป็น object store แยกจาก DB: export ประจำ (หรือเปิด versioning) ไม่งั้นเสียไฟล์วิดีโอ/ใบประกาศ PDF แม้ DB กู้คืนได้
- [ ] **ซ้อม restore จริง 1 ครั้งก่อน go-live** (ไม่ใช่แค่ "มี backup") — สร้างโปรเจกต์ซ้อม → restore → ยืนยัน: ล็อกอินได้ · หลักสูตร/บทเรียนครบ · เปิดใบประกาศ PDF ได้ · เล่นวิดีโอได้ · ตรวจ `/verify/<code>` กับใบที่ออกก่อน backup ผ่าน
- [ ] สำรอง secrets ของ platform แยกตามกระบวนการของ สภาทนายความฯ (Vercel/Supabase/Resend/Cloudflare แต่ละเจ้ามีวิธี recover ของตน) — ไม่เก็บใน repo

## 7. การวัดที่ค้างจาก SYSTEM-TEST §5.2 (PERF ทั้งกลุ่ม + ของที่ส่งต่อ prod)

- [ ] **PERF-001..008 วัดบน staging/prod ที่ config ตรงจริง** — เครื่องมือ k6 ตาม SDS (สถานการณ์ 100k ผู้ใช้ · 10k เรียนพร้อมกัน · 5k สอบพร้อมกัน · p95 ≤ 500ms · LCP ≤ 2.5s) — SYSTEM-TEST §5.2 จดไว้ตรง ๆ ว่า dev stack เครื่องเดียววัดไม่ได้ ไม่มีตัวเลขให้อ้างจนกว่าจะวัด
- [ ] **USA-002 เมทริกซ์ viewport 360–1920 + ACC-001..004 (axe/keyboard)** — เครื่องมือเฉพาะ · เปิดเป็นงานหลัง deploy staging
- [ ] **OPE-001 ตรวจ structured log จริงบน platform** (request_id v4 มีโครง — ดูตัวอย่างจาก Vercel log)
- [ ] **MAINT-002 parity สาม environment** (local dev / staging / prod ทำงานเหมือนกัน) — drill ตอน staging พร้อม

## 8. OTP ทางโทรศัพท์ (ย่อหน้าตาม D-f-8 — สถานะ: ปิดใน v1)

AUTH-003 (SRS) ตัดสิน**คงปิด** OTP ทาง SMS ใน v1 — โค้ดมี config รองรับพร้อม (`src/lib/config.ts:212,265` · กลุ่ม rate limit OTP 3/ชม. ที่ `src/lib/rate-limit.ts:45`) แต่**ไม่มีเส้นทางเปิดใช้จริง** (VA-PENTEST §1.2 ข้อ 3) · ถ้า สภาทนายความฯ ต้องการเปิดในอนาคต ต้องครบชุดก่อน: (1) ผู้ให้บริการ SMS ไทย + ค่าใช้จ่าย/สัญญา (2) เปิด phone provider ของ GoTrue + SMS rate limit ของ platform (3) หน้าจอยืนยันเบอร์ + PDPA consent หมายเลขโทรศัพท์ (ข้อมูลส่วนบุคคลชนิดใหม่ — ต้องเข้า DATA-DICTIONARY/consent) (4) ผ่าน DCR + เทส I/E ตามกฎ Brief §9 — **อย่าเปิดด้วยการตั้ง env เพียงอย่างเดียว**

## 9. External pentest (งานจ้าง — เงื่อนไขบังคับก่อน go-live)

- [ ] จัดจ้างบุคคลที่สามตามขอบเขตที่เตรียมไว้ใน **VA-PENTEST §5** (business logic การสอบ · MFA/login สองขั้น · เปลี่ยนอีเมลสองลิงก์ · enumeration · PDPA/signed URL · gateway/headers · dependency) บน **staging ที่ config ตรง prod** — self-VA ของทีมไม่แทน (D-f-10)
- [ ] เกณฑ์ยอมรับ: **0 High/Critical เปิดค้าง** ณ วัน go-live · Medium ต้องมีแผนแก้/เหตุผลเลื่อนเป็นลายลักษณ์อักษร (แนว SECURITY-REMEDIATION)
- [ ] ส่งมอบ input ให้ผู้ทดสอบ: URL staging + บัญชีตามบทบาทจาก seed-uat (UAT.md §1) + API-SPECIFICATION 1.2.8 + RBAC-DESIGN §2 + VA-PENTEST §2

## 10. ความเสี่ยงที่รับไว้มีวันหมดอายุ (ต้องตามจัดการ)

| รายการ | วันหมดอายุ | การปิด |
| --- | --- | --- |
| npm audit: postcss ≤8.5.22 (high · ผ่าน build chain ของ next) + 3 moderate | **2026-10-15** (ตัดสิน accept-with-expiry ตาม D29 — SECURITY-REMEDIATION §4) | อัปเกรด `next@16.3.5` (semver-major — ตั๋วเปิดแล้ว ทดสอบ battery เต็มหลังอัป) |
| เงื่อนไขเปิดใหม่ก่อนวันหมดอายุ | — | external CSS/ไฟล์ที่ผู้ใช้ควบคุมถึง PostCSS · runtime parsing · เปลี่ยน trust boundary · advisory ใหม่ → ทบทวนทันที (override pin `postcss@8.5.23` เป็น PR แยกพร้อมพิสูจน์ Next โหลดสำเนา override จริง) |

## 11. ลำดับ go-live + ผู้ลงนาม

ลำดับแนะนำ: §2 Supabase (โครงสร้าง+auth) → §3 อีเมล → §4 Vercel env → §5 Cloudflare → ทดสอบ smoke บน staging (สมัคร/เรียน/สอบ/ใบประกาษ/verify/อีเมลจริง) → §6 ซ้อม restore → §7 วัด PERF → §9 pentest ภายนอก → แก้ตามผล → เปิดจริง

| ขั้น | ผู้ตรวจ (ชื่อ-ตำแหน่ง สภาทนายความฯ) | วันที่ | หมายเหตุ |
| --- | --- | --- | --- |
| §2 Supabase | | | |
| §3 อีเมล | | | |
| §4 Vercel | | | |
| §5 Cloudflare (รวมคำวินิจฉัย COOP/COEP/CORP) | | | |
| §6 restore drill ผ่าน | | | |
| §7 PERF วัดแล้ว (แนบเลข) | | | |
| §9 pentest ภายนอกผ่านเกณฑ์ | | | |
| **อนุมัติเปิดระบบจริง** | | | |

---

*ท้ายเอกสาร — D-f-13 ฉบับนี้เขียนโดย lead (PM) · ทุกข้ออ้าง `ไฟล์:บรรทัด` ตรวจกับ working tree `feat/wave-f` จริง (หลัง `085e2dc`) · ค่าที่ "ไม่ต้องตั้ง" ระบุชัดเพื่อกันการตั้งเกินจำเป็น · การเปลี่ยนแปลงผ่าน DCR ตามกฎ Brief §9*
