# Wave J — Deploy & Go-Live Plan (ร่างแผนทางสู่ LAUNCH-COMPLETE)

> **DRAFT — รอ CTO review** · เอกสารนี้ยังไม่ใช่ plan-of-record จนกว่า CTO อนุมัติผ่าน design-first gate ตามธรรมนียม D70/D71 (doc-first · codex gate ต่อเฟส · คำวินิจฉัยทุกข้อลง PROJECT-STATE.md ก่อน execute)
>
> เจ้าของเอกสาร: **PM** (วางแผน/จัดคิว/เกณฑ์) · วันที่ร่าง 2026-10-13 · อ้างอิง `PROJECT-STATE.md` ณ Wave I เฟส 3 (entry สุดท้าย 2026-09-16 · e2e-04 403 บน production-build · D90 0/3) และ `docs/09-deploy/PROD-CHECKLIST.md` 1.0.2 (D-f-13 · ทุกช่องยัง `[ ]`)

---

## 0. นิยาม "LAUNCH-COMPLETE" ของ Wave J

ระบบเดินบน **Vercel (frontend) + Supabase Cloud (backend) + Cloudflare (DNS/WAF/Turnstile/Access)** ด้วยค่าจริงทั้งหมด ผ่านครบ 4 เงื่อนไข:

1. **Wave I ปิด** — e2e-04 403 แก้ตามหลักฐาน (ไม่ใช่ patch ข้าม CSRF) · battery r38+ ผ่าน 13/13 บน production runtime · **D90 = 3/3** ตามเกณฑ์ verdict wavei-r3 ข้อ (1)
2. **PROD-CHECKLIST ทุกหมวด [x]** — §2 Supabase Cloud · §3 อีเมลจริง · §4 Vercel · §5 Cloudflare (รวมคำวินิจฉัย COOP/COEP/CORP) · §6 backup/restore · §7 การวัดค้าง
3. **เงื่อนไขบังคับภายนอกครบ** — external pentest เกณฑ์ 0 High/Critical (§9) · UAT sign-off มนุษย์ (UAT.md §4) · ตารางลงนาม go-live ครบทุกแถว (§11)
4. **ความเสี่ยงรับไว้ไม่ล่วงอายุ** — npm-audit next@16.3.5 หมดอายุ **2026-10-15** (เหลือ 2 วัน นับจากวันร่าง) ต้องปิดก่อนวันหมดอายุ

สิ่งที่ **ไม่ใช่** scope Wave J: ฟีเจอร์ใหม่ทั้งหมด · OTP ทางโทรศัพท์ (ปิดใน v1 ตาม D-f-8 §8) · CDN provider อื่นนอกจาก supabase_storage (§4 M4) · COOP/COEP ที่ต้องเปิดใช้ Turnstile/Access ฟีเจอร์เพิ่มนอกตาราง §5

---

## 1. จุดยืนปัจจุบัน (as-of 2026-10-13)

| พื้นที่ | สถานะ | หลักฐาน/จุดยึด |
| --- | --- | --- |
| Waves A–H | ✅ ปิดครบ | PROJECT-STATE Wave Board · develop ผ่าน gate ทุกเฟส |
| Wave I เฟส 1–2 | ✅ ปิด (foundation + ASM-011) | gate wavei-r1/r2/r3 |
| Wave I เฟส 3 (production-build e2e) | 🔄 เปิด — โค้ด/เอกสาร/two-way ครบ แต่ **e2e-04 ติด 403** ที่ `enrollCourse` (spec:79) deterministic · battery r38 ยังไม่รัน · **D90 0/3** | DCR-PROD-BUILD-E2E · สมมติฐาน D-f-11: `isCsrfAllowed` `src/middleware.ts:83-97` เทียบ Origin `localhost:3001` กับ `nextUrl.origin` ที่อาจคืน `:3000` หลัง port-map · probe สามทิศยังไม่ได้รัน |
| หนี้คู่มือ v1.1 (AUTH-004/005/010 · ASM-012(S) · LRN-009) | ✅ ปิดหมดโดย Wave G (D71→D88) — ไม่มีค้าง | SYSTEM-TEST §5.3 census |
| ทุนทดสอบ | unit **2,722** · IT **326** (34 ไฟล์) · e2e **42** (prod-build smoke รวม) | battery r37 · prod3 logs |
| หนี้ที่ยังเปิด (ทะเบียน) | ดู §2.2 ข้างล่าง | SYSTEM-TEST §5.2 · PROD-CHECKLIST §7/§10 |
| สภาพแวดล้อม | dev รัน 100% ใน Docker local · **ไม่มีบัญชี cloud ใดถูกสร้าง** · repo ไม่มี `vercel.json` (จุดนี้ PROD-CHECKLIST §4 บอกตรง ๆ ว่าต้องสร้างตอน deploy) | docker-compose.yml · PROD-CHECKLIST 1.0.2 |

---

## 2. Inventory งานทั้งหมดก่อน launch

### 2.1 ปิด Wave I (P0 — critical path ของ CTO วันนี้)

| # | งาน | เกณฑ์ผ่าน | เจ้าของ |
| --- | --- | --- | --- |
| I-1 | probe สามทิศ (same-origin :3001 / cross-origin :3000 / dev control) + อ่าน `reason` ใน trace.zip → แก้ตามหลักฐาน | e2e-04 ผ่าน 3/3 บน production-build โดยไม่อ่อน CSRF (cross-origin ยังถูกปฏิเสธ) | cto + dev-backend |
| I-2 | battery **r38** บน production runtime (`make up-prod` + `scripts/battery-prod.sh`) | 13/13 stages ผ่าน · evidence ตาม EVIDENCE-PRESERVATION E1/E2 | cto |
| I-3 | **D90 สะสมใหม่ 3/3** — battery PASS 3 รอบติดต่อเนื่อง + identity ก่อน–หลัง + timestamped logs ครบทั้งหน้าต่าง | 3/3 ตามเกณฑ์ verdict wavei-r3 ข้อ (1) | cto |
| I-4 | closing gate Wave I + ปิด wave ใน PROJECT-STATE | gate PASS · Wave Board อัปเดต | cto |

### 2.2 หนี้/รับค้างที่ต้องปิดก่อน/ระหว่าง go-live (scan จากทะเบียน)

| # | รายการ | วันหมดอายุ/จังหวะ | จุดยึด |
| --- | --- | --- | --- |
| D-1 | **npm audit** postcss ≤8.5.22 (high ผ่าน build chain ของ next) + 3 moderate — ปิดด้วยอัปเกรด `next@16.3.5` + battery เต็มหลังอัป | **2026-10-15 — เหลือ 2 วัน → P0** | PROD-CHECKLIST §10 · SECURITY-REMEDIATION §4 (accept-with-expiry ตาม D29) |
| D-2 | PERF-001..008 วัดบน staging/prod ด้วย k6 (100k ผู้ใช้ · 10k เรียนพร้อมกัน · 5k สอบพร้อมกัน · p95 ≤ 500ms · LCP ≤ 2.5s) — dev เครื่องเดียววัดไม่ได้ | หลังมี staging จริง | SYSTEM-TEST §5.2 · PROD-CHECKLIST §7 |
| D-3 | USA-002 viewport 360–1920 · ACC-001..004 (axe/keyboard) · OPE-001 structured log จริงบน platform · MAINT-002 parity สาม environment | staging | SYSTEM-TEST §5.2 · PROD-CHECKLIST §7 |
| D-4 | คำวินิจฉัย **COOP/COEP/CORP** ตาม topology จริง (ทางเลือก ก/ข + ทดสอบวิดีโอ/PDF จริงทุกเบราว์เซอร์เป้าหมาย) — มีช่องจดการตัดสินเว้นไว้ | หลังรู้โดเมน/storage topology | PROD-CHECKLIST §5 (จาก ZAP baseline D-f-10) |
| D-5 | External pentest (จ้างภายนอก ตาม ToR VA-PENTEST §5 บน staging config ตรง prod) — **เงื่อนไขบังคับ** เกณฑ์ 0 High/Critical | ก่อน go-live | PROD-CHECKLIST §9 · D-f-10 |
| D-6 | UAT sign-off มนุษย์ 8 persona (ช่องเว้นว่างโดยตั้งใจ — เราไม่อ้าง sign-off ที่ไม่มีมนุษย์) + ตารางลงนาม §11 | ก่อนเปิดจริง | UAT.md §4 · PROD-CHECKLIST §11 |
| D-7 | SEC-005 ยกระดับ: rate limit in-memory ต่อ instance → บน Vercel หลาย instance เพดานจริง = เพดาน × จำนวน instance — ต้องย้ายเก็บร่วม (เช่น Upstash Redis) หรือให้ Cloudflare เป็นตัวคุมหลัก | ก่อนเปิดรับปริมาณจริง | PROD-CHECKLIST §5 · `src/lib/rate-limit.ts:44-53` |
| D-8 | OTP ทางโทรศัพท์ — ปิดใน v1 ถาวรตาม D-f-8 (เพียงยืนยันสถานะ ไม่มีงาน) | — | PROD-CHECKLIST §8 |

หมายเหตุ: หนี้ AUTH-004/005/010 · ASM-012 · LRN-009 ที่เคยขึ้นทะเบียน **ปิดหมดแล้วใน Wave G** — scan ซ้ำวันนี้ยืนยันไม่มีค้าง

### 2.3 Workstream การ deploy จริง (พึ่งพัน/ลำดับ)

ลำดับบังคับ (ตรง PROD-CHECKLIST §11): **Supabase Cloud → อีเมล (Resend+Auth SMTP) → Vercel env → Cloudflare → smoke staging → วัด/backup drill → pentest/UAT → เปิดจริง**

| WS | งาน | พึ่งพัน | สิ่งที่ทำล่วงหน้าได้ (ไม่ต้องรอบัญชี) |
| --- | --- | --- | --- |
| J-1 **Supabase Cloud** | สร้างโปรเจกต์จริง (ห้ามใช้ค่า placeholder canonical ของ local — V14.2.x) · run migrations 46 ไฟล์ + ตรวจ `_dev.migrations` ledger ครบ 46 แถว · สร้าง buckets 4 ใบ (media/license-evidence/pdpa-exports/certificates) · Auth settings (ปิด autoconfirm · รหัส ≥12 · Site URL จริง · email rate อนุรักษ์) · PGRST aggregates พิสูจน์ด้วย curl `select=id.count()` = 200 · PITR/scheduled backups | บัญชี Supabase ของ สภาฯ | สคริปต์ replay-migrations + ตรวจผล (probe) + seed ข้อมูลอ้างอิง (ไม่ใช่ seed-uat) — เขียน/ทดสอบบน local ได้ |
| J-2 **อีเมลจริง** | Resend: โดเมน verify DKIM/SPF + `EMAIL_FROM` ทางการ · Auth SMTP ขอ Supabase ตั้งแยก · ทดสอบส่งจริง 1 ฉบับถึงกล่องจริง | บัญชี Resend + ควบคุม DNS | ทดสอบเทมเพลตไทยครบแล้วบน Mailpit (dev) — เหลือแค่ของจริง |
| J-3 **Vercel** | `vercel.json` (สร้างใหม่ — repo ยังไม่มี) + CRON_SECRET + schedule 2 jobs (`email-dispatch` 1–5 นาที · `pdpa-export` 5–15 นาที) พิสูจน์ 200 · env บังคับ: `PUBLIC_BASE_URL` · `APP_ENV=prod` · `CERT_PUBLIC_BASE_URL` · `MEDIA_PROVIDER=supabase_storage` · สามค่า fail-fast (`CURSOR_HMAC_SECRET`/`IP_HASH_SALT`/`LTC_MFA_PENDING_KEY` ตาม SECRETS-PROVISIONING §3–4) · Node 20 · region ใกล้ไทย | บัญชี Vercel + token | **เขียน `vercel.json` + สคริปต์พิสูจน์ cron ได้วันนี้** (deploy จริงค่อยรอ) |
| J-4 **Cloudflare** | zone จริง + DNS ชี้ Vercel · TLS/HSTS ยืนยัน · WAF/rate limit 10 กลุ่มตาม `rate-limit.ts:44-53` อย่างน้อย `/api/v1/auth/*` + `/api/v1/me/mfa/*` · คำวินิจฉัย COOP/COEP/CORP (D-4) · Bot/flood โหมดอนุรักษ์ (ไม่บล็อกผู้ใช้จริง) · แผน Turnstile/Access ตาม ADR (BL-003) | ควบคุม DNS โดเมนจริง | **ADR/แผนกฎ + IaC draft (ruleset เป็นโค้ด) ได้วันนี้** |
| J-5 **การวัด/monitoring** | PERF-001..008 ด้วย k6 · USA/ACC/OPE/MAINT (D-2/D-3) | staging พร้อม (J-1..J-4) | เขียนสคริปต์ k6 + checklist การวัดได้ก่อน |
| J-6 **backup/restore** | PITR เปิด · สำรอง buckets 4 ใบแยกจาก DB · **ซ้อม restore จริง 1 ครั้ง** (ล็อกอิน/หลักสูตร/ใบประกาศ PDF/วิดีโอ/`/verify/<code>`) | J-1 | เขียน runbook drill ได้ก่อน |

### 2.4 Go-live checklist วินาทีสุดท้าย (secrets/DNS/monitoring)

- ค่าลับจริงครบทุกตัวบน Vercel env ของ production และตรวจไม่รั่วไป client (ไม่มี `NEXT_PUBLIC_` นำหน้า service key) · **ห้าม commit ค่าใดลง repo** (PROD-CHECKLIST §1)
- โดเมนจริง resolve ผ่าน Cloudflare → Vercel · certificate สมบูรณ์ · HSTS ตอบกลับจริง (V9.1.1)
- smoke 7 เส้นทางบน staging ที่ config ตรง prod: สมัคร(อีเมลถึงกล่องจริง)/เรียน/สอบ/ใบประกาศ/verify/วิดีโอ/ส่งออก PDPA
- cron 2 jobs ตอบ 200 · อีเมลเดินจริง · ล็อก structured log มี request_id (OPE-001)
- ตารางผู้ลงนาม §11 ครบทุกแถว (บุคคล สภาทนายความฯ เท่านั้น) · UAT §4 sign-off ครบ 8 persona · pentest 0 High/Critical

---

## 3. TODAY vs LATER

### 3.1 ปิด **วันนี้ (2026-10-13)** ได้ — ไม่ติดภายนอกทั้งหมด

| # | งาน | เจ้าของ | เกณฑ์จบวัน |
| --- | --- | --- | --- |
| T-1 | ปิด 403 e2e-04: probe 3 ทิศ → อ่าน `reason` → แก้ตามหลักฐาน → e2e-04 3/3 บน production-build | cto + dev-backend (กำลังดำเนินการ — PM ไม่แตะ) | e2e-04 ผ่านบน 3001 |
| T-2 | battery r38 + เริ่มนับ D90 ใหม่ (ถ้าเวลาเอื้อ 3 รอบติด ≈ 2 ชม.+) | cto | ≥ 1/3 สะสม |
| T-3 | **อัปเกรด `next@16.3.5` ปิด npm-audit ก่อนอายุ 2026-10-15** + battery เต็มหลังอัป | cto + dev-backend | audit 0 high · battery ผ่าน |
| T-4 | เขียน `vercel.json` + cron schedule + สคริปต์พิสูจน์ CRON_SECRET (404 เงียบ ↔ 200) — **code-ready ไม่ deploy** | dev-backend | ไฟล์ + test ผ่าน local |
| T-5 | สคริปต์ replay-migrations 46 ไฟล์ + probe ตรวจผล (ledger 46 · buckets 4 · PGRST aggregates) ทดสอมบน local docker ให้เสร็จ | devops | สคริปต์รันผ่าน local |
| T-6 | **ADR Cloudflare security layer** (BL-003): WAF 10 กลุ่ม · Turnstile จุดติดตั้ง · Access คุมพื้นที่ staff · คำวินิจฉัย COOP/COEP/CORP ทางเลือก ก/ข | cto | ADR draft เสร็จ (ผูก BL-003) |
| T-7 | สคริปต์ k6 PERF-001..008 + runbook การวัด (ทดสอบโครงร่างบน dev แบบ load ต่ำ) | dev-backend | สคริปต์รันได้ |
| T-8 | **ร่าง Wave J นี้** ส่ง CTO review + backlog ใหม่ | pm | CTO ได้รับร่าง (เอกสารฉบับนี้) |

### 3.2 **LATER — ต้องรอ product owner** (external blockers — ของจริงที่ทีมสร้างเองไม่ได้)

| # | สิ่งที่ต้องขอ | ใช้กับ | ปลดล็อกงาน |
| --- | --- | --- | --- |
| E-1 | **บัญชี Vercel + token** (ทีม/สิทธิ์ deploy ของ org สภาฯ) | WS J-3 | deploy staging จริง · cron จริง |
| E-2 | **โปรเจกต์ Supabase Cloud** (แผนที่รองรับ PITR + ค่า platform-issued จริง: anon/service key · JWT secret — ห้ามใช้ค่า local canonical V14.2.x) | WS J-1 | migrations/buckets/Auth จริง · backup drill |
| E-3 | **Cloudflare zone + สิทธิ์คุม DNS ของโดเมนจริง** (และการตัดสินโดเมน production) | WS J-4 | WAF · DNS cutover · COOP/COEP/CORP จบตาม topology จริง |
| E-4 | **บัญชี Resend + API key จริง + โดเมนผู้ส่ง** (DKIM/SPF) — และ Auth SMTP ขอ Supabase ตั้งครั้งแรกต้องมีเจ้าของบัญชี | WS J-2 | อีเมลธุรกิจจริง (ผลสอบ/ใบประกาศ/ต่ออายุ) + อีเมลยืนยันของ GoTrue |
| E-5 | **การตัดสินของเจ้าของระบบ**: จังหวะ cron (แนะนำ 1–5 นาที / 5–15 นาที) · ทางเลือก COOP/COEP (ก/ข) · แผน Supabase (อีเมล rate) · วัน go-live + ผู้ลงนาม | ทุก WS | ปิดช่องจดการตัดสินทุกจุดใน PROD-CHECKLIST |
| E-6 | **ความร่วมมือมนุษย์**: UAT sign-off 8 persona · จ้าง external pentest (งบ+ผู้ทดสอบ ตาม ToR VA-PENTEST §5) · ตารางลงนาม §11 | §9/UAT | เงื่อนไขบังคับ go-live ทั้งสอง |

หมายเหตุ: `CURSOR_HMAC_SECRET`/`IP_HASH_SALT`/`LTC_MFA_PENDING_KEY`/`CRON_SECRET` ทีมสร้างเองได้ตาม SECRETS-PROVISIONING §3–4 (ไม่ใช่ external blocker — แต่การเก็บรักษา/ส่งมอบเป็นของ สภาฯ ตาม §6 backup secrets)

---

## 4. โครงสร้าง Wave J ที่เสนอ (เฟส · เจ้าของ · gate)

ธรรมนียร: doc-first (D71) · gate ต่อเฟสโดย CTO · ห้ามเริ่ม ticket ที่ไม่มี acceptance criteria · แตะละเฟสให้เล็กพอส่งมอบเดี่ยว

| เฟส | ชื่อ | งาน | เจ้าของ | Gate (เกณฑ์ PASS) | การพึ่งพัน |
| --- | --- | --- | --- | --- | --- |
| **J-P0** | ปิด Wave I + ปิดอายุ npm-audit | T-1..T-3 (I-1..I-4 + D-1) | cto (lead) + dev-backend | e2e-04 ผ่าน · D90 3/3 · audit ปิดก่อน 2026-10-15 · closing gate Wave I PASS | ไม่ติดภายนอก — **เริ่มได้ทันที** |
| **J-P1** | deploy assets พร้อมลงเรือ | T-4..T-7: `vercel.json`+cron proof · replay-migrations+probe · ADR Cloudflare (BL-003) · k6 scripts | dev-backend · devops · cto (ADR) · pm (เกณฑ์) | ทุกชิ้น code-ready + ทดสอบ local ผ่าน · **gate รีวิวร่างแผน Wave J นี้ก่อน execute ใด ๆ** | ไม่ติดภายนอก — ทำขนาน J-P0 ได้ |
| **J-P2** | Supabase Cloud bootstrap | WS J-1 + runbook backup | devops + cto gate | migrations ledger 46/46 · buckets 4/4 · auth settings ตรง §2.2 · PGRST curl 200 · PITR เปิด | **E-2** |
| **J-P3** | Vercel staging deploy | WS J-3 + smoke 7 เส้นทาง | dev-backend + devops | staging ขึ้น · env fail-fast ครบ · cron 200 · smoke ผ่าน · MAINT-002 parity | E-1 (+J-P2) |
| **J-P4** | Cloudflare + DNS cutover | WS J-4 + ตัดสิน COOP/COEP/CORP (D-4) + WAF 10 กลุ่ม + ทดสอบไม่บล็อกผู้ใช้จริง | devops + cto | TLS/HSTS จริง · rate limit ขอบเขตทำงาน · คำวินิจฉัยจดใน PROD-CHECKLIST §5 | E-3 · E-5 (+J-P3) |
| **J-P5** | วัด + hardening ตามตัวเลขจริง | WS J-5 + D-2/D-3 + SEC-005 ยกระดับ (D-7 ถ้าเปิดรับปริมาณจริง) | dev-backend + tester | PERF 8/8 มีตัวเลขอ้างได้ · USA/ACC/OPE/MAINT ปิด | J-P4 |
| **J-P6** | เงื่อนไขบังคับภายนอก + go-live | D-5 pentest · D-6 UAT sign-off · restore drill (WS J-6) · ตารางลงนาม §11 | pm (ประสาน) + cto (gate สุดท้าย) | PROD-CHECKLIST [x] ทุกหมวด · 0 High/Critical · sign-off ครบ | E-6 · มนุษย์ สภาฯ |

**คำถามที่ขอคำตัดสิน CTO (จุดยืนของร่างนี้):**

1. อนุมัติโครงสร้าง 6 เฟส + การทำ J-P0/J-P1 ขนานวันนี้หรือไม่ (โดยเฉพาะ T-3 อัป next@16.3.5 ก่อน 2026-10-15 — เสี่ยงต่อเนื่องจาก battery ต้องรันใหม่หลังอัป)
2. D90 3/3 จะนับรวมรอบที่รันก่อนอัป next หรือต้องเริ่มใหม่หลังอัป (PM เสนอ: **เริ่มใหม่หลังอัป** เพราะ runtime เปลี่ยน — สอดคล้องจารีต "identity เปลี่ยน = เริ่มนับใหม่")
3. SEC-005 (D-7) จะเป็นเงื่อนไข go-live หรือ fast-follow หลังเปิด (PM เสนอ: Cloudflare เป็นตัวคุมหลัก ณ วันเปิด + ตั๋ว Upstash เป็น fast-follow — ตัดสินตามปริมาณผู้ใช้จริงที่คาด)

---

## 5. Acceptance criteria หลัก (Gherkin — สัญญาของ QA/Playwright)

**AC-WJ-0 (ปิด Wave I):**
```gherkin
Given production runtime บน docker profile prod (:3001) กำลังเดิน
When รัน battery-prod ครบ 13 stages ติดต่อเนื่อง 3 รอบ โดยไม่ restart กลางรอบ
Then ทั้ง 3 รอบ PASS 13/13 และ e2e-04 ผ่าน และ cross-origin request ยังได้รับ 403 ตาม CSRF policy
```

**AC-WJ-1 (vercel.json + cron):**
```gherkin
Given staging บน Vercel ตั้ง CRON_SECRET แล้ว
When GET /api/internal/jobs/email-dispatch โดยไม่มี header Authorization
Then ตอบ 404 เงียบ ไม่มี error ใด ๆ
When ยิงด้วย Bearer <CRON_SECRET> ตาม schedule
Then ตอบ 200 และอีเมลค้างคิวถูกจัดส่งจริง (พิสูจน์ที่กล่องจริง)
```

**AC-WJ-2 (Supabase Cloud):**
```gherkin
Given โปรเจกต์ Supabase Cloud จริงถูกสร้างด้วยค่า platform-issued เท่านั้น
When รันสคริปต์ replay-migrations
Then ledger _dev.migrations มีครบ 46 แถว และ buckets 4 ใบ private ครบ และ curl "select=id.count()" ตอบ 200
And สมัครบัญชีใหม่ 1 ฉบับ ได้รับอีเมลยืนยันจากโดเมนจริง (autoconfirm ปิด)
```

**AC-WJ-4 (Cloudflare):**
```gherkin
Given DNS โดเมนจริงชี้ผ่าน Cloudflare ไป Vercel
When ยิง /api/v1/auth/* เกินเพดานกลุ่ม AUTH (10/นาที)
Then ถูกจำกัดที่ขอบเขต Cloudflare ก่อนถึงแอป
And ผู้ใช้จริง/Playwright ไม่ถูก Bot rule บล็อก และวิดีโอ/PDF เล่นได้จริงตามคำวินิจฉัย COOP/COEP ที่จดไว้
```

**AC-WJ-6 (go-live):**
```gherkin
Given PROD-CHECKLIST ทุกหมวด [x] และ pentest 0 High/Critical และ restore drill ผ่าน 1 ครั้ง
When ผู้ลงนาม สภาทนายความฯ ลงนามครบทุกแถวของ §11
Then ระบบเปิดใช้จริงที่โดเมน production และ Wave J ปิดใน PROJECT-STATE
```

---

*ท้ายเอกสาร — ร่างโดย PM (2026-10-13) · ทุกจุดยึดอ้างไฟล์จริงตาม PROD-CHECKLIST 1.0.2 / SYSTEM-TEST / UAT.md / VA-PENTEST · **DRAFT — รอ CTO review**: ยังห้าม spawn งาน J-P1..J-P6 ใด ก่อน verdict* · ตั๋วที่เกี่ยวข้อง: `docs/backlog.md` BL-004–BL-012
