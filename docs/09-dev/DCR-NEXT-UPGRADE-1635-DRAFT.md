# DCR-NEXT-UPGRADE-1635 — อัปเกรด Next.js 15.5.25 → 16.3.5

| | |
|---|---|
| สถานะ | **DRAFT — รอ CTO review** (ยังไม่อนุมัติ implement · ห้ามแตะโค้ดก่อน GO) |
| ผู้เขียน | dev-frontend (2026-10-13) |
| ประเภท | dependency upgrade + battery rerun · **DOC-ONLY** รอบนี้ (เครื่องเงียบไว้ให้ serial test runs) |
| เหตุผลเร่งด่วน | npm-audit ของ next รุ่นปัจจุบัน ยอมรับแบบ `accept-with-expiry 2026-10-15 (D29)` (PROJECT-STATE:194) — **หมดอายุ 2026-10-15** ต้องอัปเกรดเป็น 16.3.5 + rerun battery ภายในกรอบ |
| การชี้ขาดที่บันทึกไว้ | design gate r1: "r38 ไม่นับ D90 1/3 — next@16.3.5 อัปเกรดหลัง UAT แล้วนับใหม่ … CTO เห็นด้วย" (PROJECT-STATE:740) และลำดับถัดไป "battery r38 (proof-of-health · D90 นับใหม่หลัง next@16.3.5 ตามชี้ขาด)" (PROJECT-STATE:753) |
| ขอบเขตอ้างอิง | DCR-PROD-DEPLOY-DRAFT (OQ-11 Node pin) · DCR-PROD-BUILD-E2E (proof บน :3001) · SDS §5.1/§5.4 (cookie/CSRF) · gate r1 F8 (CSP nonce) |

---

## §1 ขอบเขตและ non-goals

**ทำ:** bump `next` + `eslint-config-next` + `@types/react*` เท่านั้น · ปรับ config/สคริปต์เฉพาะจุดที่ Next 16 บังคับ · rerun บันไดทดสอบเต็มสาย

**ห้าม (non-goals — เป็นการเปลี่ยนพฤติกรรมเกิน scope ของ "อัปเกรดเฉพาะบังคับ"):**
1. **ไม่เปลี่ยน `src/middleware.ts` → `proxy.ts` ในรอบนี้** — middleware.ts ถูก deprecate ใน 16 แต่ยังทำงาน (ดู §3.2) · ชั้นนี้เป็น security-critical (CSP nonce + CSRF + session rotation) และเคยอ่อนไหวต่อสภาพแวดล้อม runtime (สมมติฐาน D-f-12 — middleware.ts:76-101) · การย้าย runtime ต้องเป็น ticket แยกหลัง 16.3.5 นิ่ง
2. **ไม่เปิด `cacheComponents` / `reactCompiler` / PPR** — คู่มือทางการเตือน "React Compiler and Cache Components are not enabled merely to complete the upgrade"
3. ไม่แตะ business logic ใต้ `src/app/**`, `src/lib/**` — พื้นที่นั้นเป็น async API ครบแล้ว (§3.1)
4. ไม่รัน codemod `@next/codemod upgrade` — repo conform กับ 16 อยู่แล้วเกือบทั้งหมด, codemod จะ "ช่วย" แปลง middleware→proxy ซึ่งขัด non-goal 1 · bump ด้วยมือเพื่อคุม diff

---

## §2 สภาพ repo ปัจจุบัน (grounding)

| พื้นผิว | ค่าปัจจุบัน | ที่อยู่ |
|---|---|---|
| next | `^15.5.25` | package.json:23 |
| eslint-config-next | `^15.5.25` | package.json:43 |
| react / react-dom | `^19.2.0` | package.json:27-28 |
| @types/react / @types/react-dom | `^19.2.18` / `^19.2.0` | package.json:40-41 |
| typescript | `^5.9.3` (≥5.1 ที่ 16 ต้องการ — ผ่าน) | package.json:48 |
| eslint | `^9.30.0` (eslint-config-next@16 ต้องการ ESLint 9 — ผ่าน) | package.json:42 |
| engines.node | `>=20` | package.json:7 |
| Docker dev image | `node:22-alpine` | docker/Dockerfile.dev:4 |
| next.config | ไม่มี webpack / experimental / images / runtimeConfig / amp / eslint keys เลย | next.config.ts:27-40 |
| middleware | edge runtime · nonce CSP + CSRF + Supabase session rotation · matcher ครบทุกหน้า | src/middleware.ts:181, 350-355 |
| instrumentation | register() ตรวจ config ตอน boot ฝั่ง nodejs | src/instrumentation.ts:16-21 |
| app router surface | 158 segment dirs ใต้ src/app (รวม root = 159) · **47 page.tsx · 75 route.ts · 4 layout.tsx** | src/app/** |
| scripts | `next dev` / `next build` / `next start` ล้วน (ไม่มี flag --turbopack/--webpack) | package.json:10-12 |
| typecheck | `next typegen && tsc --noEmit` (typegen เข้าตั้งแต่ 15.5 — ยังอยู่ใน 16) | package.json:14 |
| lint | `eslint .` + flat config ผ่าน FlatCompat("next/core-web-vitals","next/typescript") + custom rule ห้าม NEXT_PUBLIC_*SERVICE_ROLE* | package.json:13 · eslint.config.mjs:8, 77-88 |
| proof/เทส | prod-build-proof อ่าน `/app/.next/BUILD_ID` จาก container · e2e playwright ฐาน :3000 (E2E_BASE_URL เปลี่ยนได้) · ชุด battery รันกับ app-prod :3001 | scripts/prod-build-proof.mjs:86-87 · playwright.config.ts:72 · DCR-PROD-DEPLOY-DRAFT:34 |

---

## §3 วิเคราะห์ delta 15.5 → 16.3 ชี้รายพื้นผิว

ที่มา: คู่มือทางการ "How to upgrade to version 16" + release notes "Next.js 16" (nextjs.org · ดึง 2026-10-13)

### 3.1 Async Request APIs — เข้าเงื่อนไขอยู่แล้ว **(ไม่ต้องแก้โค้ด)**

16 ตัด sync access ของ `cookies()/headers()/draftMode()` และ `params`/`searchParams` แบบถาวร (15 เป็นช่วง compatibility) — **repo นี้เขียน async ครบทุกจุดตั้งแต่ Wave ก่อน:**

- `await cookies()` — src/lib/supabase/ssr.ts:88, 166 · src/app/(auth)/actions.ts:224 · src/app/(auth)/mfa-actions.ts:60 · src/app/(auth)/login/verify/page.tsx (ผ่าน import :10)
- `await headers()` — src/app/(auth)/actions.ts:182 · src/app/(auth)/reset-password/actions.ts:58 · src/app/(admin)/admin/credit-rules/page.tsx:98 · src/app/(admin)/admin/credits/page.tsx:94 · src/app/(admin)/admin/question-banks/[id]/bank-detail.server.ts:67
- `params: Promise<…>` ใน **59 ไฟล์ route.ts** ใต้ src/app/api/v1/** (เช่น src/app/api/v1/admin/courses/[id]/route.ts)
- `searchParams: Promise<…>` + `await` ในทุกหน้า admin/auth ที่ใช้ (เช่น credit-rules/page.tsx:76-80 · courses/page.tsx:61-65 · register/page.tsx:15,52 · login/page.tsx:14,51)

### 3.2 `middleware` → `proxy` — **ไม่ทำในรอบนี้ (ตัดสินใจหลักของ DCR)**

ข้อเท็จจริงจากคู่มือ: `middleware.ts` **deprecated แต่ยังใช้ได้ใน 16.x** (removal เป็น "future version") · `proxy.ts` (ชื่อไฟล์ + ชื่อ export `proxy`) รัน **nodejs runtime เท่านั้น ห้าม edge** · คู่มือเตือนตรง ๆ: *"Edge middleware is not blindly renamed to proxy"* และจะมีคำแนะนำ edge เพิ่มใน minor ถัด ๆ ไป

การตัดสินของ DCR นี้: **คง `src/middleware.ts` (export `middleware` ที่ :181, `config.matcher` ที่ :350-355) ไว้ทั้งรอบอัปเกรด** เพราะ
1. ชั้นนี้ถือครบ 3 หน้าที่วิกฤต: CSP nonce ต่อ request (middleware.ts:43-45, 190-193) · CSRF fail-closed (middleware.ts:164-207) · Supabase session rotation LEAD 180 วิ แบบเจ้าของเดียว PB-1 (middleware.ts:288-302) — ทุกหน้าที่พิสูจน์ผ่าน gate/battery มาแล้วบน edge runtime
2. การย้ายไป proxy = เปลี่ยน runtime ของชั้นดังกล่าวพร้อมกันกับการอัปเกรด framework — ผิดหลัก "เปลี่ยนทีละตัวแปร" และชนกับประวัติ D-f-12 (nextUrl.origin เพี้ยนตามสภาพแวดล้อม :3001 — middleware.ts:76-101)
3. ผลข้างเคียงที่ยอมรับได้: dev/build จะขึ้น **deprecation warning** ของ middleware — ห้าม silence, จดไว้ใน log รอบ upgrade เพื่อยืนยันว่ารู้ตัว

**ตั๋วตาม (follow-up แยก ไม่ใช่ DCR นี้):** ศึกษา rename → proxy + พิสูจน์พฤติกรรมบน Node runtime (host header / x-forwarded-* ของ `requestBrowserOrigin` middleware.ts:102-152, `btoa`/`crypto.randomUUID` middleware.ts:43-45 — ทั้งคู่มีใน Node 20.9+ แต่ต้อง probe จริง) · จังหวะ: หลัง battery ของ 16.3.5 ผ่านและหลัง Next ประกาศแนวทาง edge/proxy เพิ่มใน minor

### 3.3 Turbopack เป็น default ทั้ง dev และ build — **ผลกระทบใหญ่สุดของรอบนี้**

- scripts ของ repo (package.json:10-11) ไม่มี flag bundler และ next.config.ts:27-40 **ไม่มี `webpack` key** → สลับเป็น Turbopack ได้สะอาดตามเงื่อนไขคู่มือ (build จะ fail เฉพาะเมื่อเจอ webpack config — เราไม่มี)
- ไม่มี babel config (ตรวจแล้ว: ไม่มี .babelrc/babel.config.*) → Turbopack ไม่ลาก Babel
- Tailwind v4 ผ่าน `@tailwindcss/postcss` — ต้องพิสูจน์ด้วย build จริง + ตรวจ CSS จริงบน :3001 (ไม่เคย build โปรดักชันด้วย Turbopack มาก่อน — ดูตารางความเสี่ยง R1)
- โครงสร้าง output เปลี่ยน: dev เขียน `.next/dev` แยกจาก build + มี lockfile กัน instance ซ้อน — `.dockerignore` มี `.next` อยู่แล้ว (docker/Dockerfile.dev.dockerignore:6) · **จุดตรวจ**: scripts/prod-build-proof.mjs:86-87 อ่าน `/app/.next/BUILD_ID` — production build ยังเขียน path เดิม ต้องยืนยันใน proof รอบใหม่
- `next build` ไม่รัน lint อีกต่อไป — repo แยก lint อยู่แล้ว (`eslint .` package.json:13) → ไม่ต้องแก้

### 3.4 next.config.ts — **ไม่ต้องแก้**

ทุก key ที่ 16 ลบ/เปลี่ยน (`amp`, `eslint`, `serverRuntimeConfig`, `publicRuntimeConfig`, `devIndicators.*`, `experimental.turbopack/dynamicIO/useCache/ppr`) ไม่ปรากฏใน next.config.ts:27-40 · securityHeaders (:18-25) กับ `headers()` (:31-39) เป็น API ที่ยังอยู่

### 3.5 พื้นผิวที่ **ไม่ได้รับผล** (ตรวจแล้ว ระบุชัดเพื่อตัดข้อสงสัยตอน gate)

| การเปลี่ยนแปลงใน 16 | เหตุผลที่ repo ไม่กระทบ |
|---|---|
| next/image: `qualities`/`minimumCacheTTL`/`imageSizes`/`localPatterns.search`/`maximumRedirects`/`dangerouslyAllowLocalIP` | ไม่มี import `next/image` แม้แต่ไฟล์เดียวใน src (grep ทั้ง repo) · matcher ที่ตัด `_next/image` (middleware.ts:353) ยังเป็น inert ตามเดิม · ไม่มี `images` config |
| `next/font` | ใช้ `<link>` แทน next/font ตั้งใจไว้แล้ว (src/app/layout.tsx:17) |
| Metadata image routes (`opengraph-image`/`icon`/`apple-icon`) + `sitemap` id แบบ Promise | ไม่มีไฟล์เหล่านี้ใน src/app (find ทั้ง tree) |
| Parallel routes ต้องมี `default.js` | ไม่มี slot แบบ `@` ใด ๆ (route groups เป็น `(admin)/(auth)/(learner)/(public)` ซึ่งไม่ใช่ parallel slots) |
| `revalidateTag` สอง argument / `updateTag` / `refresh` / `cacheLife`/`cacheTag` | ไม่มี import `next/cache` ใน src (grep ทั้ง repo) — BFF นี้ไม่ใช้ ISR/tag cache |
| `draftMode()` | ไม่มีการใช้ |
| AMP, `next lint`, `unstable_rootParams`, `devIndicators` | ไม่มีการใช้ · AMP ไม่เคยมีใน App Router ของ repo |
| `scroll-behavior: smooth` override | globals.css ไม่มี scroll-behavior (grep) |
| instrumentation / `register()` | API stable ไม่เปลี่ยน — src/instrumentation.ts:16-21 ใช้งานได้ตามเดิม (`NEXT_RUNTIME === "nodejs"` ยังความหมายเดิม) |
| cookie policy ของเรา | hardenedCookieOptions (src/lib/supabase/cookies.ts:26-34) และการ set ผ่าน `response.cookies.set` / `request.cookies.set` (middleware.ts:317-332) เป็น API ของ NextResponse/NextRequest ที่ 16 คงรูปแบบเดิม |
| `unstable_rethrow` (src/app/(learner)/my/security/actions.ts:20, 219) | ไม่อยู่ในชุดที่ 16 ลบ/stabilize (ที่ stabilize คือ cacheLife/cacheTag เท่านั้น) → คงเดิม |
| React 19.2 | repo ใช้ `^19.2.0` อยู่แล้ว (package.json:27-28) |
| Route handler `context.params` เป็น Promise | เป็นรูปแบบปัจจุบันของ repo อยู่แล้ว (§3.1) |

### 3.6 พฤติกรรมเปลี่ยนแบบไม่ต้องแก้โค้ด แต่ต้อง "เห็นผลจริง" ใน battery

- **Enhanced routing/prefetch rewrite** (layout dedup + incremental prefetch) — จำนวน prefetch request ต่อ navigation อาจเพิ่ม (แต่ขนาดรวมลด) · แต่ละ prefetch วิ่งผ่าน middleware → session refresh path ทำงานบ่อยขึ้นได้ → ต้องดู quota/network บน BFF จริงใน battery (จุดเสี่ยง R3)
- build output ตัด metric `size`/`First Load JS` — ไม่กระทบ proof (proof วัดจาก BUILD_ID + Cache-Control immutable — prod-build-proof.mjs:66, 86-87)
- คำเตือน deprecation ของ middleware (§3.2) + terminal output ใหม่ทั้งหมด

---

## §4 แผนอัปเกรด (เรียงลำดับทำจริง — หลัง CTO GO และ "หลัง UAT ผ่าน" ตาม §8)

1. **สาขางาน:** branch ใหม่จากจุดหลัง merge ของงานปัจจุบัน · ห้ามยุบรวมกับ feature อื่น (เปลี่ยนทีละตัวแปร)
2. **ปักพฤติกรรมเดิมด้วยเทสก่อน bump (RED gate ของ §5 ข้อ 1):** ยืนยัน suite ที่ pin พื้นผิว next/server มีอยู่และเขียวบน 15.5.25 — src/middleware.test.ts (NextRequest/NextResponse + matcher regex :361) และ suite ของ ssr.ts/cookies.ts — ถ้าจุดใดยังไม่มีเทส pin พฤติกรรมที่ 16 อาจทำให้เข้าใจผิด ให้เขียนเพิ่มก่อน (นี่คือ RED-first: เทสที่ pin สัญญาเดิมต้องยังเขียวหลัง bump, ถ้าแดง = API drift จริง)
3. **Bump dependency (ครั้งเดียวจบ อย่าไล่ทีละรุ่น):**
   - `next: ^15.5.25 → 16.3.5` (package.json:23) — lockfile ผูก exact 16.3.5
   - `eslint-config-next: ^15.5.25 → 16.3.5` (package.json:43) — ขยับ **พร้อมกัน** ห้ามห่างเวอร์ชันกับ next
   - `@types/react` / `@types/react-dom` ขึ้นล่าสุดของสาย 19.2 (package.json:40-41 — คู่มือระบุให้ bump คู่กับ React)
   - react/react-dom คง `^19.2.0` (ผ่านเงื่อนไข 16 แล้ว) · `@types/node` คง `^24` (ผ่าน ≥20.9)
   - `npm install` ปกติ (ไม่ใช้ --force/--legacy-peer-deps — ถ้าชน peer ให้หยุดและรายงาน ดู §7 R5)
4. **ตรวจ config ซ้ำ:** next.config.ts ไม่ต้องแก้ (§3.4) · eslint.config.mjs:81 คง FlatCompat ไว้ก่อน — รัน `eslint .` ถ้า plugin รุ่น flat-default ขัด ให้สลับเป็น import `@next/eslint-plugin-next` ตรง ๆ ใน flat config (แก้เฉพาะจุดนี้ อนุญาต)
5. **Build ครั้งแรกด้วย Turbopack** (`next build`) — คาดหมาย: deprecation warning ของ middleware (บันทึกไว้), ไม่มี metric size/First Load JS · ตามด้วย prod-build-proof.mjs เพื่อยืนยัน BUILD_ID/Cache-Control ยังผ่าน (§3.3)
6. **เดินบันไดทดสอบเต็มสาย** ตาม §5 — ห้ามข้ามขั้น
7. **ปิดงาน:** บันทึกผลลง PROJECT-STATE + อัปเดต DCR นี้จาก DRAFT → APPROVED (โดย CTO) พร้อมหลักฐานรอบ

## §5 บันไดทดสอบ (เรียงตามลำดับ · ขั้นไหนแดง = หยุด ไม้ต่อ)

| ขั้น | อะไร | เกณฑ์ผ่าน |
|---|---|---|
| 1. Unit RED gate | vitest ทั้งชุด (`npm run test`) บน 16.3.5 — โดยเฉพาะ middleware.test.ts, ssr/cookies suite, guard tests | ชุดที่ pin สัญญาเดิมต้องเขียวทั้งหมด; เคสที่แดงต้องอธิบายได้ว่าเป็น API drift รายตัว (แก้เฉพาะจุด + บันทึกเหตุผล) — ห้ามแก้เทสให้ "ผ่านเพราะง้อผล" |
| 2. Typecheck | `npm run typecheck` (`next typegen && tsc --noEmit`) | 0 error — ยืนยันว่า typegen รุ่น 16 ไม่ขัด explicit `Promise` types ของ repo (§3.1) |
| 3. Lint | `eslint .` | 0 error — ผ่าน eslint-config-next@16 + custom rule ยังทำงาน (eslint.config.mjs:17-75) |
| 4. Build + proof | `next build` (Turbopack) + `scripts/prod-build-proof.mjs` | BUILD_ID อ่านได้ · chunk มี immutable · ไม่มี webpack fallback |
| 5. Integration | `npm run test:integration` เต็มบน dev stack :3000 (เก็บ log `.omc/artifacts/` ตามกติกา residual) | เขียวทั้งชุด |
| 6. Probe + e2e บน :3001 | probe ห้าทิศ + e2e (E2E_BASE_URL ชี้ app-prod :3001 — แนวเดียวกับ DCR-PROD-BUILD-E2E) — โดยเฉพาาะ e2e-04 (CSRF/origin — พื้นที่ D-f-12) และชุด logout/session (PB-1) | ผ่านครบ + ไม่มี restart ผิดปกติของ container |
| 7. Battery rerun + D90 restart ตามชี้ขาด | battery เต็มกับ production build 16.3.5 บน :3001 (สคริปต์ชุด battery-prod.sh / battery-run.mjs) | ผลต้องถูกนับเป็น **"D90 เริ่มนับใหม่ 1/3"** ตามชี้ขาด gate r1 (PROJECT-STATE:740, 753) — ไม่ใช่รอบต่อเนื่องของตัวเลขเดิม · หลักฐาน sampler + RestartCount แนบรอบนี้เป็น anchor ชุดใหม่ |

## §6 Rollback

- หนึ่ง merge commit ของงานอัปเกรด → `git revert` ตัวเดียวจบ + restore package-lock.json จาก commit ก่อน bump (lockfile คือตัวกัน drift ของ transitive deps)
- ไม่มี migration ของ data/schema/infra — rollback จึงสะอาด · container app-prod รัน image เดิมจนกว่าจะ rebuild
- เงื่อนไข trigger rollback: ขั้น 1-6 ใดแดงโดยแก้ไม่ได้ในรอบ · หรือ battery เจอพฤติกรรม session/CSRF เบี่ยงจาก baseline ที่ D-f-12/PB-1 ปิดไว้
- **ข้อจำกัด rollback:** วันหมดอายุ npm-audit (2026-10-15) ไม่ขยายเอง — ถ้าต้อง rollback ต้องแจ้ง PM/CTO ต่ออายุ acceptance เป็นหน้าที่ของงาน (§8)

## §7 ตารางความเสี่ยง

| # | ความเสี่ยง | โอกาส/ผล | เหตุผลเชิง repo | มาตรการ |
|---|---|---|---|---|
| R1 | **Build โปรดักชันด้วย Turbopack ครั้งแรก** — Tailwind v4 (PostCSS) / pdf-lib+qrcode ฝั่ง server / chunk immutable ต่างจากเดิม | กลาง / สูง | ไม่เคย build รุ่นนี้ด้วย Turbopack · prod-build-proof.mjs:86-87 ผูกกับ `.next/BUILD_ID` | ขั้น 4 ของ §5 เป็นด่านบังคับ · ทางถอยฉุกเฉิน `next build --webpack` (ใช้เป็น contingency เท่านั้น ไม่ใช่คำตอบยาว — webpack เป็นเส้นทางที่ถูก deprecate) |
| R2 | **Deprecation ของ middleware + แรงดันให้ย้าย proxy/Node runtime** บนชั้น security-critical (CSP/CSRF/session rotation) | สูง (เชิงเวลา) / สูง | middleware.ts:181, 350-355 · ประวัติ D-f-12 (ความอ่อนไหวต่อ runtime จริง :3001) | DCR นี้ fix ไว้: ไม่ย้ายในรอบนี้ (§3.2) · แยกตั๋วพิสูจน์บน Node runtime · คู่มือจะมีแนวทาง edge เพิ่มใน minor — รอก่อนตัดสิน |
| R3 | **Prefetch/routing rewrite เปลี่ยนจังหวะ request** → middleware ทำงานถี่ขึ้น (getSession/refresh) กระทบ quota/network บน BFF และจังหวะ rotation PB-1 | กลาง / กลาง-สูง | ทุก prefetch วิ่งผ่าน matcher ครบหน้า (middleware.ts:350-355) · rotation เป็นเจ้าของเดียว LEAD 180 วิ (middleware.ts:288-302) | battery ขั้น 7 วัดผลจริง · จับ RestartCount + error ชุด auth ใน log รอบนั้น · ถ้าเบี่ยง = rollback และเปิด OQ ใหม่ |
| R4 | React App Router รุ่น 16 ใช้ React canary เหนือ 19.2 | ต่ำ / กลาง | คู่มือระบุ App Router ใช้ canary ล่าสุด · repo มี client components + RTL/jsdom | ขั้น 1 (unit/RTL) + ขั้น 5-6 ครอบ · ห้ามเปิด reactCompiler ทางลัด |
| R5 | Peer dependency conflict ตอน install (eslint-config-next ↔ eslint 9 / @types สาย 19.2) | ต่ำ-กลาง / ต่ำ | repo อยู่ eslint 9.30 + @types/react 19.2.18 แล้ว (package.json:40-43) — เงื่อนไขเข้าทาง | ห้าม --legacy-peer-deps · ชนจริง = หยุดรายงาน CTO (จุดเสี่ยง dep สรุปในรายงานท้าย DCR) |
| R6 | กำแพงเวลา — วันหมดอายุ audit 2026-10-15 มาก่อน/ทับช่วง UAT | กลาง / กลาง | ลำดับที่บังคับคือ "อัปเกรดหลัง UAT" (PROJECT-STATE:740) แต่ audit หมดอายุ 2026-10-15 (PROJECT-STATE:194) | §8 — ให้ CTO/PM ตัดสินลำดับความคืบหน้า (ตัวเลือกอยู่ใน §9) |

## §8 ลำดับเวลาและการไขว้กับ DCR-PROD-DEPLOY

**คำสั่งคงที่: งานนี้ทำ "หลัง UAT ผ่าน" และ "ก่อน deploy จริงทุกรูปแบบ"** — ตามชี้ขาด gate r1 (PROJECT-STATE:740: "next@16.3.5 อัปเกรดหลัง UAT แล้วนับใหม่") และลำดับที่บันทึก (PROJECT-STATE:753: battery r38 proof-of-health → merge → UAT → [จุดของ DCR นี้]) โดยหลังอัปเกรด:

1. battery rerun = **D90 เริ่มนับใหม่ (1/3)** ด้วยหลักฐาน anchor ชุดใหม่ (container ID/RestartCount/sampler — แบบเดียวกับเกณฑ์ D90 เดิม แต่เริ่มนับจากศูนย์หลัง identity ของ build เปลี่ยน)
2. จบ 24 ชม. ติดตามตามเกณฑ์ D90 → ผ่านแล้วจึงกลับเข้าเส้นทาง deploy ของ DCR-PROD-DEPLOY-DRAFT

**OQ-11 (Node runtime บน Vercel: 20 หรือ 22) — ไขว้ตรงกับงานนี้:**
- Next 16 ขึ้นขั้นต่ำเป็น **Node 20.9** (จากเดิม 18+) — engines ของ repo `>=20` (package.json:7) กว้างเกินความจริงของ 16 · dev image เป็น node:22-alpine อยู่แล้ว (docker/Dockerfile.dev:4)
- ทิศทางเดิมของ OQ-11 เขียนไว้ว่า "22 ให้ตรง CI (engines >=20 รองรับ) — แก้ PROD-CHECKLIST ให้ตรง" (DCR-PROD-DEPLOY-DRAFT:280, ตาราง OQ :280) · **งานนี้ทำให้ข้อ 20 แคบลง**: ถ้าจะ pin Node 20 จริง ต้องเขียนเป็น `20.9+` เท่านั้น ไม่งั้น prod build จะไม่รองรับโดย Next
- **ข้อเสนอของ DCR นี้:** ปิด OQ-11 เป็น **Node 22.x ทั้งสาย (CI = UAT :3001 = prod) ก่อน battery rerun ของอัปเกรด** เพื่อให้หลักฐาน battery/D90 ใหม่ถูกเก็บบน runtime เดียวกับที่จะ deploy จริง (หลักการ build/runtime ต้องรู้จักกัน — เชิงอรรถเดิมของ OQ-11: "build/runtime คนละเวอร์ชัน = พฤติกรรมต่างกันได้") · พร้อมตั้ง engines เป็น `>=20.9` ใน commit เดียวกับ bump
- รายการ OQ อื่นของ DCR-PROD-DEPLOY (OQ-10 region, OQ-13 crons, OQ-15 image digest) ไม่ได้รับผลจากอัปเกรดนี้ — คงสถานะเดิม

## §9 คำถามเปิด ให้ CTO ตัดสินตอน review

1. **ยืนยันการคง middleware.ts (§3.2)** — เห็นด้วยไหมว่าไม่ย้าย proxy ในรอบนี้ และยอมรับ deprecation warning ระหว่างนี้ (ตั๋วตามแยก)
2. **ความขัดกันเชิงเวลา R6** — ถ้า UAT ยังไม่จบก่อน 2026-10-15: (ก) ขอขยาย accept-with-expiry อีกช่วง (ระบุวัน) หรือ (ข) เร่งลำดับให้อัปเกรดทันหลัง UAT เส้นเดิม — ทางใดเป็นนโยบาย
3. **อนุมัติ engines.node → `>=20.9`** ใน commit bump (ผลข้างเครื่องของขั้นต่ำใหม่) และยืนยันทิศ OQ-11 = Node 22.x ทั้งสาย
4. **เกณฑ์ D90 รอบใหม่** — นับ 1/3 จาก battery หลังอัปเกรดตามชี้ขาด ยืนยันว่า anchor/หลักฐานชุดเดิม (เกณฑ์ 3 ข้อของ gate r21) ใช้ซ้ำได้ทั้งชุดโดยไม่ต้องแก้เกณฑ์

---

*ที่มาที่อ้าง: คู่มือทางการ nextjs.org "How to upgrade to version 16" + "Next.js 16" release blog (ดึง 2026-10-13) · ทุก file:line ในเอกสารอ่านจาก working tree ณ วันที่เขียน · เอกสารนี้ DOC-ONLY — ยังไม่มีการแก้ dependency/config ใด ๆ ทั้งสิ้น*
