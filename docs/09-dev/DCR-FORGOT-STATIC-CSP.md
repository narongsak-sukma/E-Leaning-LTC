# DCR-FORGOT-STATIC-CSP — /forgot-password เป็น static prerender เดียวของแอป → CSP nonce บล็อก hydration ทั้งหน้าบน production build

- **วันที่เปิด**: 2026-10-15 (พบจาก battery r42 · e2e-19-password-reset:83 ล้มทั้งสองพยายาม)
- **สถานะ**: รอ pm+qa รอบ 2 (รอบแรก OBJECTION ทั้งคู่ พับครบห้าข้อ)
- **ขอบเขต**: หนึ่งบรรทัด (+comment) ต่อคนละหน้า: src/app/(auth)/forgot-password/page.tsx + src/app/(auth)/reset-password/page.tsx · ไม่แตะ middleware/CSP/config/เทส

## 1. หลักฐานสี่ทาง (อิสระต่อกัน)

1. **ตาราง route ของ build r42 (แก้ไขตาม qa-1)**: ○ (static prerender) สาม route — `/_not-found` (จัดให้เองของ Next ไม่มีฟอร์มโตตอบ) + หน้า user-facing สองหน้า: /forgot-password และ /reset-password — ทุก route อื่นเป็น ƒ (dynamic) · ตรงกับหน้า user-facing ที่ตายทั้งสองหน้าพอดี
2. **HTML ที่เสิร์ฟจริงบน :3001**: `/forgot-password` และ `/reset-password` ส่ง `<script src>` **ไร้ nonce ทุกแท็ก (grep nonce= ได้ 0)** · `/login` ส่งแท็กเดียวกันพร้อม `nonce="<per-request>"` ครบ — static HTML ถูกอบตอน build (ไม่มี request = ไม่มี nonce) · **ขั้นตอน 2 ของ journey ตายหนักกว่า (pm-1/qa-1)**: ResetPasswordClient render ฟอร์มเฉพาะใน useEffect (reset-password-client.tsx:64,83,201) → static render ไม่มี JS = #password ไม่เคยออกมา—เลย — ผู้ใช้ติดตายทั้งที่คลิกลิ้งอีเมลรับเหล่าแล้ว
3. **กลไก middleware (src/middleware.ts:58-75, 186-193)**: nonce สุ่มใหม่ทุก request ใส่ CSP `script-src 'self' 'nonce-…' 'strict-dynamic'` — **ตามสเปก CSP การมี 'strict-dynamic' ทำให้ browser เมิน host allowlist ('self') ทั้งหมด** → script ที่ไม่มี nonce ถูกบล็อกหมด (fallback 'self' เหลือไว้สำหรับ browser โบราณเท่านั้น) · คอมเมนต์ของ middleware เอง (":188-189 ห้าม cache HTML ที่บรรจุ nonce") เขียนสมมติฐานไว้ว่าทุกหน้า render ต่อ request — static prerender คือการทำลายสมมติฐานนั้นโดยไม่มีใครเห็น
4. **Probe จำลองซ้ำได้ (deterministic)**: `probe-forgot.mjs` (Playwright ตรง :3001) — console เต็มไปด้วย CSP violation ทุก chunk (webpack/main-app/page) · ฟอร์มไม่ hydrate → คลิก submit กลายเป็น **native GET** → URL กลายเป็น `/forgot-password?email=…` → `#forgot-notice` ไม่เกิด (count=0) — ตรงกับ error-context ของ e2e-19 ทั้ง r41/r42 (element not found + snapshot เป็นฟอร์มเปล่า)

**หลักฐานยืนยันว่าตัว API ไม่เกี่ยว**: `POST /api/v1/auth/password-reset/request` ตอบ 200 + ข้อความถูกต้องใน 33ms บน :3001 และ 1.7s บน :3000 (curl สองพอร์ต) — ปัญหาอยู่ที่ชั้น hydration ของหน้าเว็บเท่านั้น

## 2. ผลกระทบต่อผู้ใช้ (Critical เทียบเท่า ตาม TEST-PLAN §7:332-337 · pm-2)

บน **ทุก production build** (Vercel รวมอยู่): ผู้ใช้เข้าหน้าลืมรหัสผ่าน → ฟอร์มตาย (ไม่มี JS) → กดปุ่มแล้วหน้า reload เฉยๆ → **ไม่มีอีเมลตั้งรหัสผ่านใหม่ถูกส่งเลย** — ผู้ใช้ล็อกตัวเองออกจากระบบถาวรโดยไม่มีทางกลับ — **ไม่มี workaround**: forgot/reset เป็นเส้นทางกู้รหัสเดียว และไม่มีการ reset ของ admin — ตามเกณฑ์กำหนด TEST-PLAN §7:332-337 = **Critical เทียบเท่า · deploy-blocking สำหรับ DCR-PROD-DEPLOY (pm-2)** · dev (:3000 = next dev render ต่อ request) **ไม่เห็นอาการนี้เลย** — ค้นพบได้เฉพาะด้วย production-build e2e (เฟส 3 ทำงานตามเหตุผลที่ออกแบบ — ตัวที่ 4 ของคลาสนี้หลัง e2e-04 403 · MFA factors · และครั้งนี้)

## 3. ทางแก้ (หนึ่งบรรทัด · blast radius ตรงเป๊ะ)

```ts
export const dynamic = "force-dynamic";
```

ทั้งสองหน้า (`src/app/(auth)/forgot-password/page.tsx` + `src/app/(auth)/reset-password/page.tsx`) พร้อม comment อ้าง DCR นี้ — หน้า render ต่อ request → Next ปัก nonce ให้ทุก script tag เหมือน /login · **ข้อมูลของหน้าคือค่าคงที่เดียว (PASSWORD_RESET_REQUEST_MESSAGE)** — ไม่มีสิ่งใดสูญเสียจากการยกเลิก prerender · ขอบเขตการเปลี่ยน = หน้าเดียวที่พยานหลักฐานชี้ = ตรงตามหลัก surgical

## 4. ทางเลือกที่ตัดออก (บันทึกเป็น OQ ของ DCR-PROD-DEPLOY)

- **บริโภค x-nonce ใน root layout** (ทุก route กลายเป็น dynamic โดยโครงสร้าง) — แก้ปิด "คลาส" ทั้งหมด (หน้า static ในอนาคตกลับมาเป็นได้) แต่ blast radius เกินหลักฐาน · ยกเป็น OQ ของ DCR-PROD-DEPLOY-DRAFT
- **ตัวเฝ้าระวังระดับ build/CI**: assert **"ศูนย์ ○ ในบรรทับที่ user-facing"** โดย allowlist `/_not-found` อย่างชัดเจน (คำเดิม = แดงตั้งแต่แรกเพราะถูกจัด — pm ชี้) ใน stage build ของ battery/CI — **อนุมัติเป็น follow-up ticket นอก wave นี้** (คำวินิจฉัย CTO)

## 5. แผนทดสอบ

1. rebuild app-prod (คง PROD_RATE_LIMIT_* 60/60 ตาม runbook echo) → **probe พิสูจน์กลไกทั้งสองหน้า (qa-2)**: (a) script nonce อย่างน้อย 1 ใน HTML ที่เสิร์ฟ (b) **nonce นั้น == nonce ใน CSP header ของ response** (อ่าน response header + page.evaluate) (c) ศูนย์ CSP violation ใน console (d) ฟอร์มทำงาน: forgot = noticeCount=1 · reset = #password เกิดจริง (เอง useEffect รัน) · **เก็บ probe JSON ลง .omc/artifacts/ เป็นหลักฐานองค์ประกอบ**
2. สุขลักษณ์ ledger (แถว r42) → battery r43 detached → **13/13** (e2e-19 เขียวร่วมกับทุกตัวที่เขียวใน r42)
3. tsc/eslint สะอาด

## 6. ฉันทามติ + GO (รอ)

- รอ pm (impact P1 · ทางแก้หนึ่งบรรทัด · ทางเลือกที่ตัด) + qa (หลักฐานสี่ทาง · แผนทดสอบ) ผ่าน bridge รอบร่วม

## 7. บันทึกเพิ่ม (qa ชี้)

- **ขั้นตอน 4-5 ของ e2e-19 (:109-116)** — reset-password UI + ล็อกอินด้วยรหัสใหม่ **ไม่เคยรันบน production build เลย** (ทุกรอบก่อนหน้าตายก่อนถึงขั้นนั้น) — **r43 = การพิสูจน์จริงครั้งแรก** ของทั้งลำดับ

## 8. การแก้ไขรอบ 1 (pm+qa OBJECTION พับครบห้าข้อ · 2026-10-15)

- **pm-1 + qa-1**: ขยายขอบเขตไป reset-password (ตรวจองค์ประกอบเอง: ○ + nonce=0 + ResetPasswordClient ฟอร์มใน useEffect เท่านั้น — ไม่ขยาย r43 จะได้แค่เดินหน้าตายที่ #password) · แก้หลักฐานขา 1 เป็น "สาม ○ สอง user-facing" (qa-1) · ระดับ Critical เทียบเท่า + deploy-blocking (pm-2) · probe พิสูจน์กลไก nonce==header ทั้งสองหน้า + ศูนย์ violation + เก็บ JSON (qa-2) · คำ phrasing ตัวเฝ้าระวัง user-facing + allowlist /_not-found (pm)

## 9. ฉันทามติ + GO (สมบูรณ์ · 2026-10-15)

- **pm**: OBJECTION รอบ 1 ปิดด้วยการขยายขอบเขต (§8) — สถานะ CONSENT
- **qa round-2 CONSENT**: ตรวจปิดครบทั้งห้าด้วยการอ่านโค้ดจริง (ประตู useEffect :64 · กิ่งฟอร์ม · ทั้งสองหน้ายังไม่มี `export const dynamic` ในวันนี้) — nits สองข้อพับในคอมมิตแก้ (cite :64,83,201 · แก้คำ "อย่างน้อย")
- **GO (CTO)**: ฉันทามติครบ → สอง one-liner + probe กลไก + rebuild 60/60 → r43 → merge ladder
