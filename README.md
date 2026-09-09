# ระบบฝึกอบรมออนไลน์ สภาทนายความแห่งประเทศไทย

แอปเดียวจบ (single Next.js app) สำหรับหลักสูตรออนไลน์ การสอบ
และธนาคารหน่วยกิต (Credit Bank) ของสภาทนายความแห่งประเทศไทย

## การติดตั้งและใช้งาน

```bash
npm install
npm run dev       # รัน dev server บน http://localhost:3000
```

## คำสั่งหลัก

| คำสั่ง | หน้าที่ |
| --- | --- |
| `npm run dev` | รัน dev server |
| `npm run build` | สร้าง production build |
| `npm run lint` | ตรวจ lint (ESLint) |
| `npm run typecheck` | ตรวจ type (next typegen + tsc --noEmit) |
| `npm run test` | รัน unit test (Vitest) |

## โครงสร้างโค้ด

```
src/
  app/                 # Next.js App Router (หน้าเว็บ + /api/v1/*)
    api/health/        # GET /api/health — health probe (นอก /api/v1 ตาม API-SPEC §3.10)
  lib/                 # shared kernel
    config.ts          # env schema + default + fail-fast (SDS §7)
    errors.ts          # ทะเบียน error code กลาง (API-SPEC §2)
    logger.ts          # structured JSON log + PII filter (SDS §6)
    rbac.ts            # permission matrix + requirePermission (RBAC-DESIGN §2)
    supabase/          # client.ts (user JWT) + server.ts (service role)
  app/globals.css      # Tailwind v4 theme — สี/ฟอนต์ตาม DESIGN-SYSTEM §10
```

## สภาพแวดล้อม (env)

คัดลอก `.env.example` (จัดเตรียมโดยงานด้าน Docker/infra)
แล้วกรอกค่าบังคับ: `PUBLIC_BASE_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
ระบบจะ fail fast ตอน boot ถ้าขาดหรือค่าไม่ถูกต้อง (SDS §7.1)

## สถานะงาน

ดูความคืบหน้ารวมได้ที่ `PROJECT-STATE.md`
