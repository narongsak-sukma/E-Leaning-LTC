# DCR-PROD-DEPLOY — OQ RULINGS (CTO seat · 2026-10-14)

> คำวินิจฉัยของ CTO บนคำถามเปิด OQ-1..14 ของ DCR-PROD-DEPLOY-DRAFT.md (+ OQ ที่สะสมระหว่างทาง)
> สถานะ: ผูกมัดสำหรับการวางแผน Wave J — รายการที่ติดป้าย [sec-confirm] รอการยืนยันด้านความปลอดภัยจาก QA ตอน Wave-J kickoff
> กติกาอ้างอิง: trust-boundary doctrine (จาก DCR-CSRF-ORIGIN-RESILIENCE) · forward-only law · fail-closed law · ค่าที่วัดได้จริงบนเครื่องสำรอง

| OQ | คำถาม | คำวินิจฉัย |
|----|-------|-----------|
| 1 | CF proxy + getClientIp | **เปิด proxy · CF-Connecting-IP เป็นลำดับแรกเมื่อเข้าผ่าน CF** (fallback XFF เฉพาะทางตรง/dev) — สอดคล้อง trust-boundary doctrine: เชื่อสัญญาณเฉพาะที่แพลตฟอร์มรับประกัน [sec-confirm] |
| 2 | CF rate-limit ขอบเขต | **ชั้นแอปยังเป็นหลัก** (per-instance ที่รู้แล้ว — จดเป็นหนี้ที่ยอมรับ) + CF rate-limiting เสริมเฉพาะ auth endpoints; ตัดสิน plan tier เมื่อมีบัญชีจริง (owner); Upstash เมื่อวัดได้ว่า multi-instance ล้มจริง |
| 3 | Turnstile ขอบเขต | **3 จุด** (signup/login/exam-submit) แบบ managed · ตรวจทาง server-side fail-closed [sec-confirm] |
| 4 | CF Access บน /admin* | **staging-first** (day-one บน staging · prod หลัง UAT-09 admin flows ผ่าน) · IdP = email OTP ระยะแรก (ไม่ผูก IdP ภายนอก) · e2e service token สำหรับ test agent |
| 5 | Migration runner | **supabase db push** (CLI ledger) — migrate.sh เหลือ dev-only; forward-only คงเดิม |
| 6 | MEDIA_PROVIDER v1 | **supabase_storage** (ทางเดียวที่ as-built — ห้ามเปิด r2/stream ที่ไม่เคยทดสอบตอน launch) |
| 7 | Storage domain | **CF-proxied custom domain** (รวมศูนย์ความปลอดภัย + ซ่อน origin) |
| 8 | COOP/COEP/CORP | **COOP same-origin + CORP same-origin · COEP require-corp ปิด** v1 (เปิดแล้วตัด cross-origin signed URLs — จด tradeoff; ทบทวนเมื่อมี feature ที่ต้องการ COEP จริง) [sec-confirm] |
| 9 | Edge-block /api/internal/* | **บล็อกภายนอกที่ CF** — cron ของ Vercel ยิงภายในแพลตฟอร์ม ไม่ผ่าน edge |
| 10 | Regions | **region เดียวใกล้ TH (Singapore)** รอ PDPA sign-off (owner item) |
| 11 | Node runtime | **pin 22 ทุกชั้น** (CI 22 แล้ว · container 22-alpine) — แถว PROD-CHECKLIST "20" แก้ผ่าน DCR เอกสาร; ปิดก่อน battery rerun ถัดไปตามข้อเสนอ upgrade DCR (D90 นับบน runtime เทียบเท่า prod) |
| 12 | Seed policy | **staging = uat-seed ครั้งเดียวต่อ reset · prod = ไม่มีเลยตลอดกาล** |
| 13 | Staging shape | **Vercel + Supabase โครงการแยก** (สะท้อน profile split dev/prod ของ compose) |
| 14 | Rollback | **ยอมรับ**: app ย้อนผ่าน Vercel ทันที · DB ไปหน้าเดียว (forward-only) · เขียนใน go-live runbook |

## OQ ที่สะสมระหว่างวางแผน (จากเซสชัน 2026-10-13/14)

| ที่มา | คำถาม | คำวินิจฉัย |
|------|-------|-----------|
| BL-015 H2 + MFA discovery | digest-pin รายการ image | postgrest ตรึงใน compose แล้ว; **node:22-alpine/gotrue/kong/storage-api ตรึง digest ใน dev-compose ด้วย** (dev parity เท่านั้น — prod Supabase เป็น managed); จดไว้ใน work order J-UPGRADE-PREP ให้พร้อม |
| MFA provisioning gap | .env pre-flight | **บังคับ**: startup checklist เทียบ .env กับรายการ "dev ต้องตั้งด้วย" (LTC_MFA_PENDING_KEY ไม่มี fallback) — config.ts fail-fast มีแล้วรายตัว แต่ชั้น checklist ต้องเห็น "key ที่ comment ไว้ทั้งหมด" ก่อน boot |
| Retro | GitHub API 401 | token ปัจจุบันใช้ git ได้แต่ API 401 — owner ต้องออก token ขอบเขต repo:read (หรือ fine-grained) สำหรับ issue-mining; ไม่บล็อก |
| Upgrade DCR §9 | ลำดับ upgrade | **หลัง UAT ก่อน deploy จริง** (ตามแผนเดิม) — audit deadline 2026-10-15 ทำให้ J-UPGRADE-PREP เป็น P2 ที่ต้องพร้อมแต่ไม่แซงคิว UAT |

— ลงยี่ห้อ: CTO (orchestrating session) · ผ่านหลักฐานของ DCR-PROD-DEPLOY-DRAFT + เซสชันวันที่ 13-14/10 · ผูก Wave-J kickoff
