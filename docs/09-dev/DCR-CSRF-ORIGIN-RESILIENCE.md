# DCR CSRF origin resilience — เทียบ Origin กับ Host ของ browser แทน nextUrl.origin (Wave I เฟส 3 ต่อเนื่อง [#94])

Filing: คำสั่งสอบสวนจาก verdict ก่อนหน้า (PROJECT-STATE ~L730-731) — e2e-04 ล้ม 403 ที่ `enrollCourse` (spec:79, deterministic ~430ms ทั้งสอง attempts) บน :3001 อย่างเดียว · คิวที่วางไว้: "รัน probe สามทิศ → ดู body `reason` ใน trace.zip → แก้ตามหลักฐาน (ไม่ใช่ patch ข้าม CSRF)" · คำสั่ง standing ของ product owner (2026-10-13): design-first + consensus ก่อนแตะโค้ด — DCR นี้เป็นเอกสารหลักของการเปลี่ยนแปลง

## 1) ผลการสอบสวน — หลักฐานก่อนข้อเสนอ (evidence-first)

สิ่งแวดล้อม: เครื่องใหม่ (เครื่องเก่าที่เจอ 403 ตายไปแล้ว · `.omc/artifacts` เปล่า · trace.zip เดิมสูญ — อ่าน `reason` จาก trace เดิมไม่ได้) · develop `65fbac9` · Docker engine 29.8.2 · `ltc-prod-app` healthy บน :3001 · **ยืนยันก่อน probe ว่า build ที่รันอยู่เป็นรหัสก่อนแก้**: `grep -c requestBrowserOrigin /app/.next/server/middleware.js` = 0

### 1.1) probe ห้าทิศ (`.omc/artifacts/probe-df11-three-direction-prefix.log` — POST enroll ไม่มี session, แยกด้วยสถานะ: 403 ERR-RBAC-001 reason=csrf_origin_mismatch = CSRF ปฏิเสธ · 401 ERR-AUTH-001 = CSRF ผ่านไปถึง auth)

| ทิศ | เป้าหมาย | Origin ที่ส่ง | ผล | วางสาย |
|---|---|---|---|---|
| A same-origin (ตามคิว) | :3001 | `http://localhost:3001` | **401 AUTH-001** | CSRF **ผ่าน** — ตรงข้ามอาการเดิม |
| B internal-origin | :3001 | `http://localhost:3000` | **403 `csrf_origin_mismatch`** | CSRF ปฏิเสธถูกต้อง — พิสูจน์ว่าฝั่งเซิร์ฟเวอร์เชื่อ origin ภายนอก (3001) ไม่ใช่ 3000 |
| C dev control | :3000 | `http://localhost:3000` | 401 AUTH-001 | ผ่านตาม r37 |
| D loopback | :3001 (ผ่าน 127.0.0.1) | `http://127.0.0.1:3001` | 401 AUTH-001 | ผ่าน |
| E IPv6 | :3001 (ผ่าน [::1]) | `http://[::1]:3001` | 401 AUTH-001 | ผ่าน |

### 1.2) e2e-04 isolated บน build ก่อนแก้ · :3001

`E2E_BASE_URL=http://localhost:3001 npx playwright test e2e/e2e-04-catalog-enroll.spec.ts` → **3/3 passed (21.9s รอบแรก · 6.9s รอบยืนยัน)** รวมเทสลงทะเบียน 201/200 (`e2e04-isolated-3001-prefix-pass.log`)

### 1.3) ข้อสรุปการสอบสวน

- **สมมติฐาน D-f-11 ตามตัวอักษร ("nextUrl.origin คืน :3000 หลัง port-map ทำให้ same-origin โดน 403") ถูกหักล้างบนสภาพแวดล้อมปัจจุบัน** — probe A/B/D/E + e2e-04 3/3 พิสูจน์ว่า Next 15.5.25 + Docker 29.8.2 + compose `3001:3000` ทำให้ `request.nextUrl.origin` เป็น `http://localhost:3001` ถูกต้อง (B ปฏิเสธ origin 3000 = เชื่อ 3001)
- อาการ 403 เดิมของเครื่องเก่า (2026-09-16) **ทำซ้ำไม่ได้** ด้วย commit เดิม + build ก่อนแก้บนเครื่องนี้ · สาเหตุแท้จริงพิสูจน์ไม่ได้อีก (หลักฐาน trace สูญพร้อมเครื่อง) — กลไกที่เข้ากับหลักฐานทั้งหมดและระบุไว้เป็น **สมมติฐานไม่ยืนยัน (D-f-12)**: ชั้น port-forward ของ Docker เครื่องเก่าเขียนทับ/ตัดพอร์ตออกจาก Host header ที่ app เห็น → nextUrl.origin เพี้ยน → same-origin พิสูจน์ไม่ได้ → 403 deterministic · สังเกตว่าเครื่องเก่ามีปัญหา environment สะสมหลายชั้นอยู่แล้ว (CRLF tree · .env CRON_SECRET · role passwords · engine ตายกลางงาน)
- โค้ด Next 15.5.25 ที่เกี่ยว: `runMiddleware` ประกอบ URL จาก `initProtocol://fetchHostname:port` (next-server.ts) แต่ runtime ที่วัดได้บนเครื่องนี้ให้ค่าตรง Host ภายนอก — เอกสารนี้ยึด **ผลวัดจริง** เป็นหลัก (ห้ามอ้าง source-reading เพียงลำพัง)

## 2) ทางเลือก (options)

| | รายละเอียด | คำตัดสิน |
|---|---|---|
| **A ปิดงานไม่แก้โค้ด** | บันทึกผลสอบสวน + รัน battery r38 บนโค้ดเดิม | ตัวเลือกนี้สมเหตุสมผลที่สุด**เฉพาะ**ถ้ามองปัญหาเป็น "bug เดียวบนเครื่องตาย" — แต่ทิ้งช่องเปิด: ความจริงของ CSRF ยังผูกกับวิธีประกอบ URL ภายในของ Next ซึ่งเครื่องเก่าพิสูจน์แล้วว่าเพี้ยนได้ใน wild แบบ deterministic |
| **B (เลือก) เทียบ Origin กับ origin จาก Host/x-forwarded ของ browser** | `requestBrowserOrigin()`: x-forwarded-host → host → fallback nextUrl.origin · scheme จาก x-forwarded-proto → nextUrl.protocol | ตัดทั้ง class: ความจริงฝั่ง origin มาจาก header ที่ **browser เป็นเจ้าของเอง** (Host) หรือ **platform proxy ที่เชื่อถือได้เขียนทับ** (x-forwarded-* บน Vercel/Cloudflare — สอดคล้อง phase deploy ถัดไป) · แนวทางมาตรฐานเดียวกับ Django (Origin vs request host) · fallback กลับ nextUrl.origin เมื่อไม่มี header = พฤติกรรมเดิมทุกประการ |
| C ตั้ง PORT=3001 ใน container + map 3001:3001 | ทำให้ internal/external port ตรงกัน | ปฏิเสธ — coupling การ deploy เข้าโค้ดสภาพแวดล้อม ไม่แก้เคส proxy จริง (Cloudflare/Vercel) และไม่มี test coverage อะไรเลย |
| D `experimental.trustHostHeader` | ให้ Next ใช้ Host header สร้าง initURL | ปฏิเสธ — experimental กระทบวงกว้างกว่า CSRF และ branch นั้น hardcode `https://` เสียด้วย |

เหตุผลเลือก B โดยตรง: (1) เครื่องเก่าคือหลักฐาน empirical ว่า class ของปัญหา ("nextUrl เพี้ยนตามสภาพแวดล้อม") เกิดจริงและหายาก-เจอตอนเสียที่สุด (deterministic 403 บน production runtime อย่างเดียว) (2) phase ถัดไปจะวิ่งเบื้องหลัง Vercel/Cloudflare ที่ x-forwarded-* เป็นความจริงฝั่ง origin อยู่แล้ว — B คือ parity ที่ต้องทำนั่นอยู่ (อ้าง docs/09-dev/WAVE-J-PLAN-DRAFT.md §2.3/J-P3/J-P4 และ docs/09-dev/DCR-PROD-DEPLOY-DRAFT.md ตาม PM condition: cross-ref ทั้งสอง) (3) ต้นทุนจำกัด: ฟังก์ชันเดียว + เทส 5 เซ็ต + rollback ง่าย

**ข้อควรระวังที่บันทึกไว้ตรง ๆ**: ถ้าสาเหตุเครื่องเก่าคือ Host ถูกเขียนทับเป็น :3000 จริง (D-f-12) ตัวเลือก B ก็**ไม่**ช่วยเคสนั้น (Origin :3001 ยังไม่ตรง Host :3000) — B ไม่ใช่ "ตัวแก้ bug เครื่องเก่า" แต่คือ hardening ให้ CSRF อ้างความจริงจากแหล่งที่ถูกต้องตามสถาปัตยกรรมเป้าหมาย และมีเทส lock พฤติกรรมไว้

## 3) การออกแบบ (B)

`src/middleware.ts` — เพิ่ม helper ส่วนตัว `requestBrowserOrigin(request)`:

**[แก้ไขตาม qa round-1 finding 1+2]** แบบ trust สองชั้น:

0. **ธง trust** — env `CSRF_TRUST_PROXY_HEADERS` (zod boolean ผ่าน `src/lib/config.ts` · **default false**) เปิดเฉพาะ env ที่หน้า app มี platform proxy จริง (Vercel/Cloudflare เขียนทับ x-forwarded-* ก่อนถึง app เสมอ) · dev/local/UAT = ปิด
1. host ฐานเทียบ: **flag ปิด (default)** → ใช้ `host` header เท่านั้น (browser เป็นเจ้าของ — forbidden header แก้ไม่ได้จาก JS) · **flag เปิด** → `x-forwarded-host` ชนะ `host`
2. comma-list (proxy chain append) → เอา **ตัวสุดท้าย** (ค่าที่ hop ที่เชื่อถือได้ใกล้เราสุดเขียนทับไว้) — แก้จากร่างแรกที่เอาตัวแรก (qa finding 2: ค่าปลอมถูก append ไว้หน้าสุด)
3. scheme: **flag เปิด** → `x-forwarded-proto` (comma-list → ตัวสุดท้าย) ไม่งั้น `nextUrl.protocol` · **flag ปิด** → `nextUrl.protocol` เท่านั้น (ไม่อ่าน x-forwarded-proto เลย)
4. ไม่มี host ทั้งสองชั้น / ค่าว่าง / parse ไม่ได้ → **fallback `request.nextUrl.origin`** (พฤติกรรมเดิม — มักลงที่ปฏิเสธ = fail-closed)

`isCsrfAllowed` เปลี่ยน **จุดเทียบเดียว**: `new URL(origin).origin === request.nextUrl.origin` → `=== requestBrowserOrigin(request)` · ทุก branch อื่น (Sec-Fetch-Site / fail-closed / ขอบเขต /api/v1 เท่านั้น) **ไม่แตะ** · `.env.example` เพิ่ม `CSRF_TRUST_PROXY_HEADERS` default ปิดพร้อมคำอธิบาย

## 4) พิสูจน์ว่าไม่ใช่ CSRF bypass

- **[แก้ไขตาม qa round-1 finding 1 — ประโยคต้นฉบับถูกแทน]** จุดที่ร่างแรกผิด: X-Forwarded-Host/X-Forwarded-Proto **ไม่ใช่ forbidden header** — JS ของหน้า cross-site ตั้งค่า header เหล่านี้ใน fetch เองได้ · ร่างแรกที่เชื่อ x-forwarded-* เสมอจึงเปิดช่อง browser-forgery ใน topology ไร้ proxy จริง — แก้ด้วย trust สองชั้นตาม §3: flag ปิด (default) = ไม่อ่าน x-forwarded-* เลย
- **โหมดตรง (flag ปิด — dev/local/UAT)**: ฐานเทียบคือ `host` header ที่ browser ตั้งตาม URL และ**แก้ไม่ได้จาก JS** (forbidden header จริง) · `Origin` ก็ browser เป็นเจ้าของ → เทียบสอง header ที่ browser เป็นเจ้าของทั้งคู่ = พิสูจน์ same-origin ของ browser อย่างเคร่งครัด (แนว Django CSRF: Origin vs request host)
- **โหมด proxy (flag เปิด — เฉพาะ env deploy)**: x-forwarded-* ถูก platform proxy เขียนทับก่อนถึง app เสมอ (Vercel/Cloudflare) — client ปลอมไปก็ถูกทับ · ธงนี้ตั้งเฉพาะ env นั้น ไม่มีทางหลุดมาใน .env ของ dev · ใน topology docker ปัจจุบัน browser ตรง = Host ตรง
- cross-origin ทุกรูปแบบยังถูกปฏิเสธในทุกโหมด: คนละ host / คนละ scheme / **คนละพอร์ต** (3000 ≠ 3001) / XFH ปลอมเมื่อ flag ปิด — เทสล็อกครบ (แผน §5)
- client ที่ปลอม header เองได้ (curl) **ผ่านกฎเดิมมาตลอดแล้ว** (ส่ง `Origin` ตรง nextUrl.origin หรือ `Sec-Fetch-Site: same-origin`) — กลุ่มนี้ไม่ใช่ของ CSRF แต่เป็นของ auth/RLS · B ไม่ขยายช่องใหม่ให้ใครที่ผ่านไม่ได้อยู่แล้ว
- **หมายเหตุความสม่ำเสมอของ trust story (qa ติดตาม — non-blocking)**: `clientIpFrom` ของ rate limit (`src/lib/rate-limit.ts` ~L171-180) เชื่อ x-forwarded-for ตัวแรกโดยไม่มีธง — รับรู้เป็น follow-up เดียวกับ OQ-1 ของ DCR-PROD-DEPLOY-DRAFT (CF-Connecting-IP) ไม่ขยายขอบเขต DCR นี้

## 5) แผนทดสอบ

1. **unit (ก่อนโค้ด — RED ก่อน)** **[แก้ไขตาม qa round-1 finding 3 — 5 → 8 เทส]**: 8 เทสใหม่ใน `src/middleware.test.ts` — (1) port-map: nextUrl :3000 + Origin/Host :3001 → ต้องผ่าน (2) Origin คนละ host จาก Host → 403 (3) Origin คนละพอร์ต → 403 (4) ไม่มี Host → fallback เดิม (5) flag เปิด: x-forwarded-host/proto ของ platform proxy → ผ่าน (6) **browser-forgery: flag ปิด (default) + Origin/XFH/XFP ปลอมทั้งชุด → 403** · flag เปิด = พฤติกรรมตามธงที่ document ไว้ (7) **comma ordering: XFH `evil.com, ltc.example.com` → ตัวสุดท้ายชนะ** (8) **XFH ว่าง → fallback ตามลำดับ** · รันบนต้นไม้ก่อนแก้: เทสเชิงบวกใหม่ล้ม (RED พิสูจน์) · หลังแก้: ชุดเต็มเขียว (เดิมไม่มีอะไรแตก)
2. tsc / lint / build — rc=0 ทุกตัว
3. integration บน dev :3000 (`npm run test:integration`) — ชุดส่ง `Origin: TEST_APP_URL` ต้องเขียวทั้งเดิม
4. probe ห้าทิศรันซ้ำบน :3001 หลังแก้ — A/D/E ยัง 401 · B ยัง 403 (พฤติกรรมภายนอกไม่เปลี่ยนบนสภาพแวดล้อมที่ถูกต้องอยู่แล้ว) **+ ทิศ F [qa เพิ่ม]: Origin same-origin + XFH ปลอม + flag ปิด → ต้อง 403**
5. e2e-04 isolated บน :3001 หลังแก้ → 3/3
6. **battery r38** ผ่าน `scripts/battery-prod.sh` 13/13 — **[ชี้ขาดตามคำแนะ PM รับ]** r38 = proof-of-health ของ hardening + production runtime แต่**ไม่นับสะสม D90 รอบ 1/3**: next@16.3.5 (npm-audit หมดอายุ 2026-10-15) จะอัปเกรดหลัง UAT → runtime identity เปลี่ยน = เริ่มนับ D90 ใหม่หลัง re-battery ตามแบบแผน "identity เปลี่ยน = เริ่มนับใหม่" (เกณฑ์ verdict r21)

## 6) ความเสี่ยง / rollback

- ความเสี่ยงหลัก: พฤติกรรม CSRF เปลี่ยนใน topology ที่ Host/x-forwarded หลอกได้และเดิม nextUrl เพี้ยน "พอดี" ให้ผ่าน/ไม่ผ่าน — ชดเชยด้วยเทสล็อกทั้งสามทิศ + probe + e2e + battery เต็ม
- rollback **[แก้ไขตาม qa round-2 note 2]**: revert commit เดียว — แตะ `src/middleware.ts` + `src/middleware.test.ts` + `src/lib/config.ts` (schema+AppConfig+toConfig) + `.env.example` — ไม่แตะ schema/RLS/API contract/compose

## 7) ฉันทามติ (design gate — ตาม standing order 2026-10-13)

**รอบ 1 (2026-10-13 · ผ่าน bridge)**:
- pm (scope/acceptance): **CONSENT มีเงื่อนไข** — (ก) ภาษาปิดงาน = "403 เดิมปิดแบบ non-reproducible + hardening เป็น defense-in-depth" ห้ามเขียนว่า B แก้ bug เดิม (ข) ยอมรับการแทน trace.zip ที่สูญด้วย probe ห้าทิศ + e2e-04 isolated pre-fix (ค) §5 ladder = acceptance contract · PM formalize Gherkin AC ใน backlog ตอน GO (ง) PM อัปเดตแถว BL-000/BL-002 ตอน GO (จ) เพิ่ม CSRF-under-real-proxy sanity ใน staging gate J-P3
- qa (testability/security): **OBJECTION รอบ 1 — 3 findings ยอมรับทั้งหมดตามคำสั่ง command** — (1) §4 ร่างแรกเปิดช่อง browser-forgery ผ่าน x-forwarded-* (ไม่ใช่ forbidden header) → แก้เป็น trust สองชั้นตาม §3 (2) comma-list ต้องเอาตัวสุดท้ายไม่ใช่ตัวแรก (3) เพิ่มเทส 6-8 + probe ทิศ F — แก้ครบในฉบับนี้ (marker `[แก้ไขตาม qa round-1 ...]`) · qa ยืนยัน fallback fail-closed ตามร่าง + option B ยังคุ้มทำเมื่อมีธงกำกับ
- ชี้ขาด CTO (บันทึก): การแก้ตาม qa เพิ่ม config surface (env 1 ตัว) ไม่ใช่การขยาย scope — pm consent ยืนต่อ · D90: เห็นด้วย PM — r38 ไม่นับสะสม นับใหม่หลัง next@16.3.5 + re-battery
- **รอบ 2 (2026-10-13 · ผ่าน bridge)**: qa **CONSENT** — ยืนยันทั้งสาม findings ปิดครบ (trust สองชั้น · host-only เมื่อปิดธง · comma เอาตัวสุดท้าย · เทส 8 + probe F) และตรวจ fail-closed ซ้ำทุก failure mode ใหม่ (default ปิด · host หาย = พฤติกรรมวันนี้เป๊ะ · xfp ขาด → ปฏิเสธทั้งหมด · URL parse ตก catch เดิม → false)
- **GO (CTO · 2026-10-13)**: ฉันทามติครบ (pm รอบ 1 ยืนต่อ + qa รอบ 2) → **GO สำหรับ option B** ตาม §3 ที่แก้แล้ว · qa ฝาก **ข้อกำหนดการ implement 5 ข้อ (binding)**: (1) zod ของ `CSRF_TRUST_PROXY_HEADERS` ใช้ `z.enum(["true","false"]).default("false").transform(...)` **ห้าม** `z.coerce.boolean()` (coerce ทุก string ที่ไม่ว่างเป็น true รวมถึง "false" — เปิด permissive mode เงียบ ๆ) ต้อง pin ไว้ในโค้ด (2) §6 รายชื่อไฟล์ rollback ถูกต้อง: `src/middleware.ts` + `src/middleware.test.ts` + `src/lib/config.ts` (schema+AppConfig+toConfig) + `.env.example` (3) เทส (8) empty-XFH ต้องระบุ flag=ON ให้ชัด (ปิดอยู่ไม่อ่าน XFH อยู่แล้ว) (4) normalize สองฝั่งด้วย `new URL(...).origin` ก่อนเทียบ (default-port elision เช่น :443 · IPv6 วงเล็บ) · fallback อยู่ใน try/catch · เพิ่มเคส parity ของ port-elision (5) เพิ่มแถว `CSRF_TRUST_PROXY_HEADERS` ในตาราง env SDS §7.2
