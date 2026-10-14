# DCR-FORGOT-STATIC-CSP — /forgot-password เป็น static prerender เดียวของแอป → CSP nonce บล็อก hydration ทั้งหน้าบน production build

- **วันที่เปิด**: 2026-10-15 (พบจาก battery r42 · e2e-19-password-red:83 ล้มทั้งสองพยายาม)
- **สถานะ**: รอ pm+qa (รอบร่วมผ่าน bridge)
- **ขอบเขต**: src/app/(auth)/forgot-password/page.tsz หนึ่งบรรทัด (+comment) · ไม่แตะ middleware/CSP/config/เทส

## 1. หลักฐานสี่ทาง (อิสระต่อกัน)

1. **ตาราง route ของ build r42**: `/forgot-password` เป็น **○ (static prerender) เพียงหน้าเดียวของทั้งแอป** — ทุก route อื่นเป็น ƒ (dynamic) — ตรงกับ "หน้าเดียวที่ตาย" พอดี
2. **HTML ที่เสิร์ฟจริงบน :3001**: `/forgot-password` ส่ง `<script src>` **ไร้ nonce ทุกแท็ก** · `/login` ส่งแท็กเดียวกันพร้อม `nonce="<per-request>"` ครบ — static HTML ถูกอบตอน build (ไม่มี request = ไม่มี nonce)
3. **กลไก middleware (src/middleware.ts:58-75, 186-193)**: nonce สุ่มใหม่ทุก request ใส่ CSP `script-src 'self' 'nonce-…' 'strict-dynamic'` — **ตามสเปก CSP การมี 'strict-dynamic' ทำให้ browser เมิน host allowlist ('self') ทั้งหมด** → script ที่ไม่มี nonce ถูกบล็อกหมด (fallback 'self' เหลือไว้สำหรับ browser โบราณเท่านั้น) · คอมเมนต์ของ middleware เอง (":188-189 ห้าม cache HTML ที่บรรจุ nonce") เขียนสมมติฐานไว้ว่าทุกหน้า render ต่อ request — static prerender คือการทำลายสมมติฐานนั้นโดยไม่มีใครเห็น
4. **Probe จำลองซ้ำได้ (deterministic)**: `probe-forgot.mjs` (Playwright ตรง :3001) — console เต็มไปด้วย CSP violation ทุก chunk (webpack/main-app/page) · ฟอร์มไม่ hydrate → คลิก submit กลายเป็น **native GET** → URL กลายเป็น `/forgot-password?email=…` → `#forgot-notice` ไม่เกิด (count=0) — ตรงกับ error-context ของ e2e-19 ทั้ง r41/r42 (element not found + snapshot เป็นฟอร์มเปล่า)

**หลักฐานยืนยันว่าตัว API ไม่เกี่ยว**: `POST /api/v1/auth/password-reset/request` ตอบ 200 + ข้อความถูกต้องใน 33ms บน :3001 และ 1.7s บน :3000 (curl สองพอร์ต) — ปัญหาอยู่ที่ชั้น hydration ของหน้าเว็บเท่านั้น

## 2. ผลกระทบต่อผู้ใช้ (P1)

บน **ทุก production build** (Vercel รวมอยู่): ผู้ใช้เข้าหน้าลืมรหัสผ่าน → ฟอร์มตาย (ไม่มี JS) → กดปุ่มแล้วหน้า reload เฉยๆ → **ไม่มีอีเมลตั้งรหัสผ่านใหม่ถูกส่งเลย** — ผู้ใช้ล็อกตัวเองออกจากระบบถาวรโดยไม่มีทางกลับ · dev (:3000 = next dev render ต่อ request) **ไม่เห็นอาการนี้เลย** — ค้นพบได้เฉพาะด้วย production-build e2e (เฟส 3 ทำงานตามเหตุผลที่ออกแบบ — ตัวที่ 4 ของคลาสนี้หลัง e2e-04 403 · MFA factors · และครั้งนี้)

## 3. ทางแก้ (หนึ่งบรรทัด · blast radius ตรงเป๊ะ)

```ts
export const dynamic = "force-dynamic";
```

ใน `src/app/(auth)/forgot-password/page.tsx` พร้อม comment อ้าง DCR นี้ — หน้า render ต่อ request → Next ปัก nonce ให้ทุก script tag เหมือน /login · **ข้อมูลของหน้าคือค่าคงที่เดียว (PASSWORD_RESET_REQUEST_MESSAGE)** — ไม่มีสิ่งใดสูญเสียจากการยกเลิก prerender · ขอบเขตการเปลี่ยน = หน้าเดียวที่พยานหลักฐานชี้ = ตรงตามหลัก surgical

## 4. ทางเลือกที่ตัดออก (บันทึกเป็น OQ ของ DCR-PROD-DEPLOY)

- **บริโภค x-nonce ใน root layout** (ทุก route กลายเป็น dynamic โดยโครงสร้าง) — แก้ปิด "คลาส" ทั้งหมด (หน้า static ในอนาคตกลับมาเป็นได้) แต่ blast radius เกินหลักฐาน · ยกเป็น OQ ของ DCR-PROD-DEPLOY-DRAFT
- **ตัวเฝ้าระวังระดับ build/CI**: assert "ศูนย์ route ○ เมื่อ nonce CSP ใช้งาน" ใน stage build ของ battery/CI — **อนุมัติเป็น follow-up ticket นอก wave นี้** (คำวินิจฉัย CTO)

## 5. แผนทดสอบ

1. rebuild app-prod (คง PROD_RATE_LIMIT_* 60/60 ตาม runbook echo) → probe-forgot.mjs บน :3001 ต้องได้ **noticeCount=1 + ไร้ CSP violation**
2. สุขลักษณ์ ledger (แถว r42) → battery r43 detached → **13/13** (e2e-19 เขียวร่วมกับทุกตัวที่เขียวใน r42)
3. tsc/eslint สะอาด

## 6. ฉันทามติ + GO (รอ)

- รอ pm (impact P1 · ทางแก้หนึ่งบรรทัด · ทางเลือกที่ตัด) + qa (หลักฐานสี่ทาง · แผนทดสอบ) ผ่าน bridge รอบร่วม
