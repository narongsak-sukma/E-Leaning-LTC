# Secrets Provisioning — Staging / Production

> เอกสารนี้คือคู่มือจัดค่า secret ของ environment จริง (staging/prod ตาม PROJECT-BRIEF §6
> — แยกด้วย env vars เท่านั้น) · dev local ใช้ placeholder จาก `.env.example` ทั้งหมด
> ไม่ต้องอ่านเอกสารนี้ก็รันได้

|          |                     |
| -------- | ------------------- |
| สถานะ    | 1.0.0 (2026-09-11)  |
|ที่มา     | PB-9 (C-1 flag → C-5 ใช้งานจริง) + SDS §7.1 "ตรวจครบตอน boot" |
| หลักการ  | secret จริงอยู่ที่ platform env เท่านั้น (Vercel/Supabase) — ห้ามลง repo/ลง log/ลง .env ที่ถูก track (binding rules) |

## 1. หลักการกลาง

1. **fail fast ตอน boot** — `src/lib/config.ts` ตรวจครบทุกค่าบังคับก่อนรับ request
   (SDS §7.1); ค่าที่ผิดนโยบายของ prod จะทำให้แอปไม่ start (ไม่ใช่แค่เตือน)
2. **ห้าม reuse** — หนึ่ง secret = หนึ่งวัตถุประสงค์; โดยเฉพาะ `CURSOR_HMAC_SECRET`
   ห้ามใช้ค่าเดียวกับ service key ในทุก environment จริง
3. **หมุนเป็นชุด มีผลข้างเคียงที่รู้ทัน** — ดูคอลัมน์ "ผลข้างเคียงการหมุน" ก่อนหมุนทุกครั้ง
4. dev placeholder (JWT `0000…`, `super-secret-jwt…`) อยู่ใน gitleaks allowlist
   โดยเจาะจง signature — ค่าจริงที่หลุดเข้า repo จะถูกจับเป็น leak เสมอ

## 2. ตาราง secret ของ staging/prod

| Env var | ที่มาของค่า | เก็บที่ไหน | ผลข้างเคียงการหมุน |
| --- | --- | --- | --- |
| `CURSOR_HMAC_SECRET` | **generate เอง** — `openssl rand -base64 32` | Vercel env (server) | cursor ที่ออกก่อนหมุนใช้ไม่ได้ทันที (listing ตอบ 400 `ERR-VAL-001` — ผู้ใช้เริ่มหน้าใหม่ได้ตามปกติ) แต่ **ห้ามหมุนกลางช่วงสอบ** |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase platform (Project Settings → API) | Vercel env + อ้างอิงโดย compose ไม่ได้ใน prod | หมุน service key ที่ Supabase → อัปเดต Vercel env ให้ตรงกันในรอบเดียว |
| `SUPABASE_DB_POOLER_URL` | Supabase pooler (transaction mode — SDS §8) | Vercel env | เปลี่ยนตาม project/region เท่านั้น |
| `R2_*` (เมื่อ `MEDIA_PROVIDER=r2`) | Cloudflare R2 | Vercel env | rotate = คู่ Access Key/Secret พร้อมกัน |
| `STREAM_SIGNING_*` (เมื่อ `MEDIA_PROVIDER=stream`) | Cloudflare Stream | Vercel env | URL เซ็นก่อนหน้าตายตาม TTL เดิม |
| `SMTP_USER` / `SMTP_PASSWORD` หรือ `RESEND_API_KEY` (เมื่อเปิดส่งอีเมลจริง) | ผู้ให้บริการอีเมล (Wave F) | Vercel env | อีเมลค้างส่งช่วงหมุน — ตรวจ outbox หลังหมุน |
| `NEXT_PUBLIC_*` ทั้งหมด | — | — | **ไม่มี secret ชนิดนี้ในระบบ** — lint rule `ltc/no-public-service-role` + config ban บังคับ (SDS §5.1) |

**ห้ามตั้งใน staging/prod เด็ดขาด:** `TEST_*` ทั้งชุด (ใช้เฉพาะ dev/test harness —
รวม `TEST_USER_PASSWORD`) และ `APP_ENV` ต้องเป็น `prod` (staging ก็ใช้ `prod` —
แยก environment ด้วย URL/key ไม่ใช่ค่า enum)

## 3. `CURSOR_HMAC_SECRET` — ขั้นตอนจัดค่า (PB-9)

ทำไมต้องแยก: dev ที่ไม่ตั้งจะ fallback ใช้ `SUPABASE_SERVICE_ROLE_KEY` เป็น PRF
ของ signed cursor (`lib/api/pagination`) — HMAC เป็น one-way PRF จึงไม่รั่วค่าออก
นอกกระบวนการ แต่ผูกความปลอดภัยของ cursor ไว้กับอายุ/การหมุนของ service key
(prod หมุน service key เมื่อไร cursor ทั้งระบบ invalid พร้อมกันโดยไม่ตั้งใจ)

ขั้นตอน (staging/prod ทุกครั้งที่ตั้งระบบใหม่):

1. generate: `openssl rand -base64 32` (≥ 32 bytes entropy)
2. ตั้งเป็น env ของ platform (Vercel → Project → Settings → Environment Variables)
   โดยไม่ผ่านไฟล์ใด ๆ ใน repo
3. deploy — config ตรวจให้: `APP_ENV=prod` และไม่มี `CURSOR_HMAC_SECRET`
   → **แอปไม่ start** พร้อม issue ระบุชื่อ key (superRefine ใน `src/lib/config.ts`)
4. ตรวจผล: `/api/health` ตอบ 200 และ listing ที่มี cursor (เช่น `/api/v1/courses`)
   ส่ง cursor ต่อได้ตามปกติ

การหมุนภายหลัง: ทำข้อ 1–2 ซ้ำได้ทุกเมื่อ (ไม่มี downtime) — เฉพาะช่วงสอบ
(assessment window) ให้เลี่ยงตามคอลัมน์ผลข้างเคียง

## 4. สิ่งที่บังคับโดยกลไก (ไม่ใช่แค่เอกสาร)

| กลไก | ที่ไหน |
| --- | --- |
| prod ไม่ตั้ง `CURSOR_HMAC_SECRET` → ไม่ start | `src/lib/config.ts` (superRefine PB-9) + `src/lib/config.test.ts` |
| service key ขึ้นต้น `NEXT_PUBLIC_` → ไม่ start | `loadConfig` (`PUBLIC_SERVICE_ROLE_BAN`) + eslint rule `ltc/no-public-service-role` |
| provider ไม่ครบค่าประกอบ → ไม่ start | `envSchemaWithRules` (R2/stream/smtp/resend) |
| secret หลุดเข้า repo → CI ว่าจับ | gitleaks 5 ด่าน (ci.yml) + allowlist เฉพาะ dev placeholder signature |

## 5. คำถามค้าง (ไม่บล็อกการใช้งาน)

- Q5 (region ของ Supabase/Vercel) ยังรอยืนยันกับสภาทนายความ — กระทบตำแหน่งที่
  secret ถูกเก็บ (region ของ platform env) ไม่กระทบวิธีจัดค่าในเอกสารนี้
