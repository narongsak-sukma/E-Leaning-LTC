# DEV-SETUP — คู่มือติดตั้งและรัน dev ด้วย Docker (100% local)

|          |                                                              |
| -------- | ------------------------------------------------------------ |
| เวอร์ชัน | 1.0.0 (Wave B — B-03)                                        |
| วันที่    | 2026-09-09                                                   |
| เจ้าของ  | worker-b3                                                     |
| อ้างอิงบังคับ | PROJECT-BRIEF §6 (dev = 100% local Docker) · ARCHITECTURE §4 · SDS §7 (env สองชั้น) |

> หลักการ: **โค้ดชุดเดียว** รันได้ทั้ง local Docker (dev) และ cloud (prod) —
> ต่างกันเฉพาะ **environment variables** (brief §6) ไม่มีการแก้โค้ด/แยก branch ตาม environment

## 1. Prerequisites

| ต้องมี | เวอร์ชันที่ใช้พิสูจน์ | ตรวจ |
| ------ | --------------------- | ---- |
| Docker Desktop (หรือ Engine + compose plugin) | Docker 29.2.0 / Compose v5.0.2 (ที่พิสูจน์) | `docker --version && docker compose version` |
| พอร์ตว่าง | — | 3000 (แอป) · 8000 (Supabase) · DB (default 5432 ปรับได้ด้วย POSTGRES_HOST_PORT — ตั้ง 54322 ถ้าเครื่องคุณมี Postgres อื่น) · 8025 + 1025 (Mailpit) |

ไม่ต้องติดตั้ง Node/npm/Postgres บนเครื่องเลย — ทุกอย่างรันใน Docker ตาม brief §6
(ตารางที่ใช้ทดสอบ: macOS + Docker Desktop 29.2.0 / Compose v5.0.2 — OS อื่นใช้ได้เหมือนกัน)

## 2. เริ่มใช้งานใน 3 คำสั่ง

```bash
cp .env.example .env   # ครั้งแรกครั้งเดียว (ค่า default รันได้ทันที ไม่ต้องแก้อะไร)
make dev               # up + follow logs ของแอป
```

สถานะ/หยุด:
```bash
make ps                # ดูสถานะ + health
make down              # หยุด (เก็บ volume ข้อมูลไว้)
make reset-db          # ล้าง DB dev ทิ้ง (ลบ volume) แล้ว up ใหม่ + apply migrations ใหม่
```

`make dev` จะรัน `docker compose up -d --build` แล้วตาม log ของแอป — ใช้ Ctrl-C ออกจาก log (container ยังรันต่อ)

## 3. Services และพอร์ต

| Service | URL (มุมมอง host) | พอร์ต | หน้าที่ |
| ------- | ------------------ | ----- | ------- |
| app (Next.js dev) | http://localhost:3000 | 3000 | แอปหลัก + `/api/v1/*` (BFF) |
| kong (Supabase gateway) | http://localhost:8000 | 8000 | ประตูเดียวของ Supabase local — `SUPABASE_URL` ชี้ที่นี่ |
| db (PostgreSQL 15) | `localhost:${POSTGRES_HOST_PORT:-5432}` (psql) | ${POSTGRES_HOST_PORT:-5432} (ค่าใน .env.example = 54322) | ฐานข้อมูล + RLS (migrations จาก `supabase/migrations`) |
| mailpit (UI) | http://localhost:8025 | 8025 | ดูอีเมล dev ที่จับได้ |
| mailpit (SMTP) | `localhost:1025` | 1025 | SMTP จับอีเมล (gotrue ส่งเมลมาที่นี่) |
| rest (PostgREST) | ผ่าน kong `/rest/v1` | (ภายใน) | Data API |
| auth (GoTrue) | ผ่าน kong `/auth/v1` | (ภายใน) | Auth/JWT |
| storage (Storage API) | ผ่าน kong `/storage/v1` | ภายใน | ไฟล์/วิดีโอ (MEDIA_PROVIDER=supabase_storage) |
| imgproxy | — | ภายใน | ย่อ/ตัดรูปให้ Storage API |

healthcheck ที่ทำได้จริงใน-container: db (`pg_isready`) · kong (`kong health` — image ไม่มี curl) ·
mailpit (`wget` หน้า UI) · app (`wget /api/v1/health` โดยมี fallback `/` กันตอน route อยู่ระหว่างแก้) —
ส่วน auth/rest/storage/imgproxy เป็น image ที่ไม่มี shell/probe tool (ตรวจแล้ว: ไม่มี curl/wget) จึงไม่ตั้ง
healthcheck ปลอม แต่ใช้ `depends_on: db: service_healthy` + restart policy + ตรวจปลายทางจริงผ่าน kong

## 4. แนวทาง Supabase local ที่เลือก + เหตุผล

**เลือก (ข) — ใช้ images หลักของ Supabase เอง (postgres + gotrue + postgrest + storage + kong)**
ใน docker-compose.yml โดยตรง ไม่ใช้แนวทาง (ก) "ติดตั้ง supabase CLI แล้ว `supabase start` ภายใน container"

| | (ก) supabase CLI ใน container | **(ข) images หลักเอง (ที่เลือก)** |
| - | ----------------------------- | -------------------------------- |
| การเริ่ม | CLI ต้องมี `supabase/config.toml` + คุม Docker จากภายใน container (mount docker.sock) | หมดปัญหา — compose คุมทุก service ตรง ๆ |
| config ไหนเป็นเจ้าของ | config.toml = ไฟล์ใน supabase/** (นอกขอบเขตไฟล์ B-03) | ทุกอย่างอยู่ในไฟล์ของ B-03 (compose + docker/kong/kong.yml + .env.example) |
| ความสเถียร | CLI คุมพอร์ต/container เอง เสี่ยง conflict กับ compose | พอร์ต/volume/network กำหนดชัดเจนในไฟล์เดียว |
| รัน migrations | CLI จัดการ | docker/db/migrate.sh (psql + ตาราง track `_dev.migrations`) |
| Studio UI | มี | ไม่มี (ตัดเพื่อความเบา) — ใช้ `make psql` แทน |

เหตุผลย่อ: (ก) ต้อง mount `/var/run/docker.sock` + config.toml ที่อยู่นอกขอบเขตไฟล์ของ task นี้
พร้อมจัดการพอร์ตให้ตรงกับ compose — ซับซ้อน/เสี่ยง และ CLI จะจัดการ container ที่ compose ไม่รู้จัก
(ข) ใช้ images หลักชุดเดียวกับ self-hosting ทางการของ supabase (supabase/docker) — เสถียร โปร่งใส
ควบคุมได้ และตรงกับ ARCHITECTURE §4 (Kong :8000 + PG :5432) พอดี

**เวอร์ชัน images (pin ไว้ใน docker-compose.yml):** supabase/postgres 15.8.1.060 · gotrue v2.164.0 ·
postgrest v12.2.3 · storage-api v1.0.6 · kong 2.8.1 · imgproxy v3.8.0 · mailpit v1.22 · node 22-alpine
(ทุก tag พิสูจน์ว่ามีจริงใน registry ด้วย `docker manifest inspect` ทั้ง 9 ตัว)

## 5. Migrations (supabase/migrations)

- `make dev`/`make up` รัน service `db-migrate` (one-shot) ที่ apply `supabase/migrations/*.sql`
  เรียงตามชื่อไฟล์ ใช้ `psql -1` (transaction ต่อไฟล์) + ตาราง track `_dev.migrations`
- ไฟล์ใหม่ → apply เฉพาะไฟล์ใหม่; ไฟล์เดิม → skip
- เขียน migration ใหม่: สร้างไฟล์ `supabase/migrations/0004_xxx.sql` แล้วรัน `make migrate`
- `make reset-db` = ล้างทั้งหมด (down -v) แล้ว apply ตั้งแต่ต้น — ใช้เมื่อ migration เปลี่ยนไฟล์เก่า
- ตาราง track อยู่ใน schema `_dev` (เจตนา dev-only) — ถ้าโปรเจกต์สลับไปใช้ supabase CLI ภายหลัง
  ให้ `make reset-db` ก่อนใช้ CLI (ตาราง CLI คือ `supabase_migrations.schema_migrations`)
- ก่อน apply migrations สคริปต์ตั้งรหัสผ่านให้ service roles (supabase_auth_admin / authenticator /
  supabase_storage_admin) ด้วย user `supabase_admin` (superuser ของ image) — image supabase/postgres
  สร้าง role เหล่านี้แบบไม่มีรหัสผ่าน และ supautils บล็อก non-superuser จากการแก้ reserved roles

## 6. Supabase keys และ kong.yml (ต้องตรงกัน)

- `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` ใน .env = JWT (HS256) ที่ sign ด้วย `SUPABASE_JWT_SECRET`
- Kong ตรวจ header `apikey` กับ consumer keys ใน `docker/kong/kong.yml` — ถ้าเปลี่ยน JWT secret
  ต้อง regenerate สอง JWT แล้วแก้ **สองที่พร้อมกัน**: .env + docker/kong/kong.yml
- ลำดับ: คีย์ทั้งสองต่างกันแค่ claim `role` (anon vs service_role) — service_role = bypass RLS
  server เท่านั้น ห้ามออกไป browser (brief §8)

## 7. มุมมอง URL: .env (host) vs ภายใน container

- .env.example เขียนจาก **มุมมอง host/browser**: `SUPABASE_URL=http://localhost:8000`, `SMTP_HOST=localhost`
- ภาชนะแอปอยู่ใน compose network → compose ตั้ง **override** ให้ภายใน container:
  `SUPABASE_URL=http://kong:8000`, `SMTP_HOST=mailpit` (ดู service `app` ใน docker-compose.yml)
- นัยสำคัญ: worker-b1 จะคืน absolute URL ให้ browser (เช่น signed URL ของสื่อ) ควร prefix ด้วย
  URL มุมมอง host (PUBLIC_BASE_URL / CERT_PUBLIC_BASE_URL) ไม่ใช่ SUPABASE_URL ฝั่ง server

## 8. make targets

| target | ทำอะไร |
| ------ | ------ |
| `make dev` | up -d --build + ตาม log ของ app (Ctrl-C = ออกจาก log ไม่หยุด container) |
| `make up` | สร้าง/เริ่ม stack ทั้งหมด + apply migrations |
| `make down` | หยุด stack (เก็บ volume) |
| `make logs` | ตาม log ทุก service |
| `make ps` | สถานะ + health ของทุก container |
| `make lint` / `make test` | รัน lint/test ภายใน container แอป (ไม่ต้องมี node บนเครื่อง) |
| `make psql` | เข้า psql ของ DB local (user postgres) |
| `make migrate` | apply migration ใหม่โดยไม่ restart แอป |
| `make reset-db` | ล้าง DB dev ทั้งหมด (down -v) + up ใหม่ |

## 9. การเชื่อมต่อของแอป (worker-b1) ที่ต้องรู้

| ต้องการ | ใช้ env | ค่าใน dev (ใน container แอป) |
| ------- | ------- | ---------------------------- |
| Supabase (auth/rest/storage) | `SUPABASE_URL` | `http://kong:8000` (compose override แล้ว) |
| anon key | `SUPABASE_ANON_KEY` | จาก .env (JWT role=anon) |
| service_role (jobs/SECURITY DEFINER เท่านั้น) | `SUPABASE_SERVICE_ROLE_KEY` | จาก .env — server เท่านั้น |
| ส่งอีเมล | `EMAIL_PROVIDER=console` (default) | log ลง stdout; ถ้า `smtp` → `SMTP_HOST=mailpit:1025` |
| signed URL ให้ browser | PUBLIC_BASE_URL / CERT_PUBLIC_BASE_URL | `http://localhost:3000` |

## 10. Troubleshooting

| อาการ | สาเหตุที่พบบ่อย / วิธีแก้ |
| ----- | -------------------------- |
| `make up` บอก "ยังไม่มี .env" | ยังไม่ได้รัน `cp .env.example .env` |
| พอร์ต 5432 ชนกับ Postgres อื่น | ตั้ง `POSTGRES_HOST_PORT=54322` ใน .env (แล้วแก้ `SUPABASE_DB_POOLER_URL` ให้ตรง) — พอร์ตอื่นชน: แก้ mapping ฝั่งซ้ายใน docker-compose.yml |
| app unhealthy | `docker compose logs app` — ถ้า `npm run dev` ล้มเหลวให้ดู error แรก; hot reload ใช้ polling (CHOKIDAR_USEPOLLING) บน macOS/Windows |
| `db-migrate` exited(1) | `docker compose logs db-migrate` → แก้ SQL → `make reset-db` (ถ้าแก้ไฟล์เก่า) หรือ `make migrate` (ไฟล์ใหม่) |
| Kong 503 | ตรวจ `docker compose logs auth rest storage` — kong รอตาม depends_on แต่ไม่รู้ว่า upstream พร้อม (ไม่มี healthcheck ได้) |
| อีเมลไม่ถึง Mailpit | `EMAIL_PROVIDER=smtp` ต้องตั้งใน .env + ตรวจ `docker compose logs mailpit`; gotrue เมล recovery ส่งเข้า Mailpit ตลอด (GOTRUE_SMTP_HOST=mailpit) |
| ลืมรหัสผ่านบัญชี dev | gotrue autoconfirm เปิด — สมัครแล้วเข้าได้ทันที; เมล reset ดูที่ Mailpit :8025 |
| DB ข้อมูลเพี้ยนจากทดลอง | `make reset-db` |
| Docker ไม่ขึ้น | เปิด Docker Desktop รอ daemon พร้อม (`docker info`) |
| แอปขึ้น ERR-VAL-001 boot fail | ขาด env — เทียบกับ .env.example (config module fail fast ตาม SDS §7.1) |

## 11. ขอบเขตและข้อจำกัดที่รู้ตัว

- **scheduler (ARCHITECTURE §4)**: ARCH §4 มีบล็อก "scheduler (cron) container" เพื่อ parity กับ
  Vercel Cron — ยังไม่รวมใน compose ตอนนี้ เพราะยังไม่มี endpoint job จริงใน API-SPECIFICATION
  ที่จะเรียก (ห้ามเดา path) จะเพิ่ม service เมื่อ worker-b1 ส่งมอบ endpoint แล้ว (เหมาะกับ Wave C)
- auth/rest/storage ไม่มี healthcheck ของตัวเอง (image ไม่มี shell tool) — ระบบตรวจผ่าน kong แทน
- **ไม่มี Supabase Studio** (ตัดเพื่อความเบา) — ใช้ `make psql` + Mailpit UI แทน
- อีเมล dev: `EMAIL_PROVIDER=console` = แอปเขียนอีเมลลง log เท่านั้น (SDS §7.2 dev default);
  Mailpit จับเมลของ Supabase Auth (gotrue) และรองรับการสลับเป็น `EMAIL_PROVIDER=smtp` ได้ทันที
- พอร์ต auth/rest/storage ไม่ publish ออก host (เข้าผ่าน kong เท่านั้น) — ลดจุดเสี่ยง + ตรง ARCH §4
- **prod**: โค้ดชุดเดียวกัน — สลับ env vars ตาม SDS §7.2 (SUPABASE_URL → Supabase Cloud,
  MEDIA_PROVIDER=r2/stream, EMAIL_PROVIDER=resend/smtp) ดู ARCHITECTURE §8 ตารางสลับ env vars

## 12. การตรวจพิสูจน์ (evidence — no fake completion)

รันจริงบนเครื่อง dev (Docker 29.2.0 / Compose v5.0.2, 2026-09-09):

| การตรวจ | ผล |
| ------- | --- |
| `docker --version && docker compose version` | Docker 29.2.0 · Compose v5.0.2 (daemon ขึ้น — exit 0) |
| `docker manifest inspect` 9 image tags | exit 0 ทุกตัว (ทุก tag มีจริงใน registry) |
| `docker compose config -q` | exit 0 |
| `docker compose up -d --build` | exit 0 — app image build สำเร็จ (npm install ใน image) |
| `docker compose ps` (หลัง up) | 8/8 services Up — db/kong/mailpit/app healthy · auth/rest/storage/imgproxy Up |
| ผ่าน Kong + apikey | `/auth/v1/health` 200 · `/rest/v1/` 200 · `/storage/v1/status` 200 · ไม่ส่ง apikey = 401 |
| Mailpit UI `:8025` | 200 |
| App `http://localhost:3000/` | 200 (Next.js dev ready ใน ~1.2s) · `make lint` exit 0 · `make test` exit 0 (28/28) |
| cold cycle `down` → `up` | down exit 0 (ps = 0 container) · up exit 0 · 8/8 Up + endpoints 200 ซ้ำ |
| `make psql` | SELECT current_user/version สำเร็จ (PostgreSQL 15.8) |

**Known issues ตอนส่งมอบ (ไม่ใช่ของไฟล์ชุดนี้):**
- `supabase/migrations/0002_helpers.sql:11` อ้าง `public.role_assignments` ที่สร้างใน `0003_identity.sql:23`
  → `db-migrate` exit 1 ที่ไฟล์ 0002 (ตาราง track จด 0001 แล้ว) — แก้ที่ supabase/** (worker-b2) แล้ว
  รัน `make migrate` ต่อ ไม่ต้อง reset (ไม่ block การรัน stack — auth/rest ใช้งานได้)

## 13. แผนที่ env vars: dev (ไฟล์นี้) → prod (สลับเฉพาะ env — SDS §7.2)

| กลุ่ม | dev (Docker local) | prod (cloud) |
| ----- | ------------------ | ------------ |
| แอป | PUBLIC_BASE_URL=http://localhost:3000 | https://<โดเมนจริง> |
| Supabase | SUPABASE_URL=http://localhost:8000 (kong) | https://<project>.supabase.co + keys ของ project |
| สื่อ | MEDIA_PROVIDER=supabase_storage | MEDIA_PROVIDER=r2\|stream + คีย์ R2/Stream |
| อีเมล | EMAIL_PROVIDER=console (หรือ smtp→Mailpit) | EMAIL_PROVIDER=resend/smtp + คีย์ |
| WAF/rate limit | Next middleware in-memory | Cloudflare + middleware ชั้นใน |
| Cron | (ยังไม่มี service — §11) | Vercel Cron (endpoint เดียวกันทุก env) |

