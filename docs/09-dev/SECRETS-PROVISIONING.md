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

1. **fail fast ตั้งแต่ boot** — `src/lib/config.ts` ตรวจครบทุกค่าบังคับก่อนรับ
   request (SDS §7.1); ค่าที่ผิดนโยบายของ prod ทำให้ bootstrap throw
   (instrumentation) + `/api/health` 503 + call site พังทุกทาง (ไม่ใช่แค่เตือน)
2. **ห้าม reuse** — หนึ่ง secret = หนึ่งวัตถุประสงค์; โดยเฉพาะ `CURSOR_HMAC_SECRET`
   ห้ามใช้ค่าเดียวกับ service key ในทุก environment จริง
3. **หมุนเป็นชุด มีผลข้างเคียงที่รู้ทัน** — ดูคอลัมน์ "ผลข้างเคียงการหมุน" ก่อนหมุนทุกครั้ง
4. **gitleaks มีขอบเขตที่ต้องรู้** — allowlist ข้าม "ทั้งไฟล์" ที่เป็นเอกสาร/ตัวอย่าง
   (`docs/`, `.env.example`, `docker/kong/kong.yml`) และข้าม "เฉพาะบรรทัด" ที่มี
   signature ของ JWT placeholder dev มาตรฐานของ Supabase สองค่า — ดังนั้นค่าจริง
   ในโค้ด/ไฟล์อื่นถูกจับตามปกติ แต่การเอาค่าจริงใส่ไฟล์กลุ่มแรกจะไม่ถูกจับ
   (เลี่ยงโดยวินัย: ห้ามใส่ค่าจริงในเอกสาร/`.env.example` เป็นอันขาด)

## 2. ตาราง secret ของ staging/prod

| Env var | ที่มาของค่า | เก็บที่ไหน | ผลข้างเคียงการหมุน |
| --- | --- | --- | --- |
| `CURSOR_HMAC_SECRET` | **generate เอง** — `openssl rand -base64 32` | Vercel env (server) | cursor ที่ออกก่อนหมุนใช้ไม่ได้ทันที (listing ตอบ 400 `ERR-VAL-001` — ผู้ใช้เริ่มหน้าใหม่ได้ตามปกติ) แต่ **ห้ามหมุนกลางช่วงสอบ** |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase platform (Project Settings → API) | Vercel env + อ้างอิงโดย compose ไม่ได้ใน prod | หมุน service key ที่ Supabase → อัปเดต Vercel env ให้ตรงกันในรอบเดียว |
| `SUPABASE_DB_POOLER_URL` | Supabase pooler (transaction mode — SDS §8) | Vercel env | เปลี่ยนตาม project/region เท่านั้น |
| `R2_*` (เมื่อ `MEDIA_PROVIDER=r2`) | Cloudflare R2 | Vercel env | rotate = คู่ Access Key/Secret พร้อมกัน |
| `STREAM_ACCOUNT_ID` + `STREAM_CLIENT_SECRET` (เมื่อ `MEDIA_PROVIDER=stream`) | Cloudflare Stream — **ต้องครบทั้ง 2 ค่า** ตาม config schema | Vercel env | URL เซ็นก่อนหน้าตายตาม TTL เดิม |
| `SMTP_USER` / `SMTP_PASSWORD` หรือ `RESEND_API_KEY` (เมื่อเปิดส่งอีเมลจริง) | ผู้ให้บริการอีเมล (Wave F) | Vercel env | อีเมลค้างส่งช่วงหมุน — ตรวจ outbox หลังหมุน |
| `NEXT_PUBLIC_*` ที่มี `SERVICE_ROLE` ในชื่อ | — | — | **ห้ามใช้โดยกลไกจริง** — `loadConfig` ปฏิเสธทันที (`PUBLIC_SERVICE_ROLE_BAN`) + lint rule `ltc/no-public-service-role` (SDS §5.1) · หมายเหตุ: กลไกบังคับด้วยชื่อตรงเฉพาะกลุ่ม SERVICE_ROLE — secret ชนิดอื่นไม่ควรมีใน `NEXT_PUBLIC_*` เป็นวินัย (ฝั่ง client อ่าน env ไม่ได้อยู่แล้วเพราะทุก secret ถูกอ่านผ่าน server-only modules) |

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
3. deploy ใหม่ — env ของ Vercel มีผลเฉพาะ deployment ที่สร้างหลังตั้งค่า
   (deployment เดิมยังถือค่าเก่าตามที่ถูก inject ไว้ตอนสร้าง)
4. ตรวจว่าบังคับจริง — ถ้า `APP_ENV=prod` และไม่มี `CURSOR_HMAC_SECRET`:
   - `instrumentation.register` (src/instrumentation.ts) throw `ConfigError`
     ตอน server bootstrap — Next.js รุ่นที่ใช้งานอาจกลืน error นี้ได้ จึงมีชั้นสำรอง:
   - `/api/health` ตอบ **503** + `status:"error"` (getConfig พัง = readiness พัง —
     uptime check จับได้ทันที)
   - และทุก handler ที่ใช้ config ก็ fail-closed อยู่ดี (getConfig throw ที่ call site)
5. ตรวจผลบน deployment ที่ตั้งค่าครบ: `/api/health` ตอบ 200 และ listing ที่มี
   cursor (เช่น `/api/v1/courses`) ส่ง cursor ต่อได้ตามปกติ

การหมุนภายหลัง: ทำข้อ 1–3 ซ้ำ (generate → ตั้ง env → **deploy ใหม่ทุกครั้ง** —
config ถูก cache ต่อ runtime แล้วแต่ละ deployment ถือ env ของตัวเอง ไม่มี hot
reload) แล้วพิสูจน์ว่าคีย์เก่าตายแล้ว: cursor ที่ sign ด้วยคีย์เก่าต้องได้ 400
`ERR-VAL-001` (`bad_signature`) บน deployment ใหม่ — ไม่มี downtime เพราะผู้ใช้
เริ่มหน้าใหม่ได้ตามปกติ — เฉพาะช่วงสอบ (assessment window) ให้เลี่ยงตามคอลัมน์
ผลข้างเคียง

## 4. สิ่งที่บังคับโดยกลไก (ไม่ใช่แค่เอกสาร)

| กลไก | ที่ไหน |
| --- | --- |
| prod ไม่ตั้ง `CURSOR_HMAC_SECRET` → bootstrap throw + health 503 + call site พังหมด | `src/lib/config.ts` (superRefine PB-9) + `src/instrumentation.ts` (register) + `/api/health` (readiness) — tests: `config.test.ts` / `instrumentation.test.ts` / `health/route.test.ts` |
| service key ขึ้นต้น `NEXT_PUBLIC_` → ไม่ start | `loadConfig` (`PUBLIC_SERVICE_ROLE_BAN`) + eslint rule `ltc/no-public-service-role` |
| provider ไม่ครบค่าประกอบ → ไม่ start | `envSchemaWithRules` (R2/stream/smtp/resend) |
| secret หลุดเข้า repo → CI จับ (ยกเว้นไฟล์เอกสาร/ตัวอย่างที่ allowlist — ดู §1.4) | gitleaks 5 ด่าน (ci.yml) |

## 5. คำถามค้าง (ไม่บล็อกการใช้งาน)

- Q5 (region ของ Supabase/Vercel) ยังรอยืนยันกับสภาทนายความ — กระทบตำแหน่งที่
  secret ถูกเก็บ (region ของ platform env) ไม่กระทบวิธีจัดค่าในเอกสารนี้
