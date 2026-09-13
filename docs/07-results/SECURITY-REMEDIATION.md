# Security Remediation Log & Accepted-Risk Register — LTC E-Learning (Wave F)

|          |                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| เวอร์ชัน | 1.1.0 — เพิ่ม §2.5 gate r2 (G1-G5 · migration 0046 · แก้ครบทั้ง 5) + battery สดรอบใหม่ที่ถูก anchor กับ commit จริง (ปิด G5) · ฉบับแรก 1.0.0: gate r1 (F1-F10) · incident e2e document-viewer · accepted-risk register ของ npm audit (ตัดสินตาม D29) · การตัดสิน V2.5.3/V2.2.3 ของ VA-PENTEST 1.1.0 |
| วันที่    | 2026-09-13                                                                                                                    |
| อ้างอิง  | VA-PENTEST.md 1.1.0 §3.4/§5.3 · `.omc/artifacts/gate-f-p0-r1-output.md` · `.omc/artifacts/gate-f-p0-r2-output.md` (คำวินิจฉัย codex FAIL ทั้งคู่) · `.omc/artifacts/npm-audit-2026-09-13.json` · `.omc/artifacts/battery-phase0/` · `.omc/artifacts/probe-g2-csp.txt` |
| ขอบเขต  | สิ่งที่เอกสารนี้ทำ: (1) ตาราง finding → fix → evidence ของ gate r1 (§2) และ gate r2 (§2.5) ทุกตัว (2) accepted-risk register ที่มีวันหมดอายุจริงตามเงื่อนไข D29 (3) การตัดสิน design decision ที่ VA-PENTEST อ้างถึง · สิ่งที่เอกสารนี้ไม่ทำ: ไม่ใช่รายงานผลตรวจ (นั่นคือ VA-PENTEST.md) และไม่ใช่แผน pentest ภายนอก (VA-PENTEST §5) |

---

## 1. สรุปผู้บริหาร

- **codex gate r1 (Wave F Phase 1) = FAIL** — พบ 10 findings (1 CRITICAL · 2 HIGH · 6 MED · 1 LOW) ทั้งหมดเกี่ยวกับชุด MFA/โค้ดสำรอง การเปลี่ยนอีเมล CSP และ consents (§2)
- **codex gate r2 (ตรวจซ้ำหลังแก้ r1) = FAIL** — พบ 5 findings (2 HIGH · 3 MED) บน fix batch รอบแรก (G1 stash re-host · G2 CSP nonce เดี้ยงบน static pages · G3 consume fail-open · G4 invalidate lock-free · G5 evidence anchor ขาด) — แก้ครบทั้ง 5 ใน §2.5 ด้วย migration `0046` + BFF/middleware/pages
- **แก้ครบทั้ง 10 ภายในวันเดียว** ผ่าน migration `0045_gate_r1_security_fixes.sql` + แก้ BFF/middleware 5 ไฟล์ + เพิ่มเทส (integration dcr14 เคส e + unit mfa/middleware/email-change/config) — ทุกแถวมี evidence ใน §2
- **battery สดลำดับเดียวหลังแก้ r2 ผ่านครบ** (unit 170/2,363 · tsc 0 · eslint 0 · build RC=0 — static เหลือเฉพาะ `/_not-found` · integration 20/173 · e2e **34/34 · 11.1 นาที · `E2E-EXIT=0`** — 33 first-attempt + 1 flaky ผ่าน retry เคส e2e-15 ฟอร์มใบอนุญาต เดิมเคสเดียวกับรอบ r1) — battery รอบ r1 (integration 20/171 · e2e 34/34 · 10.9 นาที) ตกเป็นงานอ้างอิงเทียบ แต่ถูกบันทึกว่า "รันบน working tree สกปรก" (รากของ G5) — ตัวเลขที่เป็นหลักฐานปิด gate คือรอบ r2 เท่านั้น
- **npm audit (1 high · 3 moderate) ตัดสินตาม mentor D29 = accept-with-expiry** — register พร้อมเงื่อนไขเปิดใหม่และตั๋วอัปเกรดอยู่ที่ §4 · เป้า M5 "0 High/Critical ก่อน go-live" ยังบังคับอยู่ — สถานะนี้คือ "ยอมรับชั่วคราวพร้อมวันครบกำหนด" ไม่ใช่การยกเว้นเป้า
- การตัดสิน V2.5.3 (อายุโค้ดสำรอง) และ V2.2.3 (ERR-AUTH-003 registry debt) ของ VA-PENTEST 1.1.0 บันทึกเหตุผลเต็มที่ §5-§6

---

## 2. Gate r1 — finding → fix → evidence (ทั้ง 10 ตัว)

คำวินิจฉัยเดิม: `.omc/artifacts/gate-f-p0-r1-output.md` (codex · static review ที่ HEAD `f7a39a8`) · การแก้ทั้งหมดอยู่ใน working tree `feat/wave-f` (fix batch นี้ + เทส) · แถว "evidence" อ้างเทสที่ผ่านจริงใน battery สด 2026-09-13

| # | ความรุนแรง/เรื่อง (สรุปจากคำวินิจฉัย) | การแก้ | Evidence |
| --- | --- | --- | --- |
| F1 | **CRITICAL** — RPC `mfa_backup_codes_replace` ตรวจแค่ `auth.uid()`+มี factor verified ไม่ตรวจ aal2 → ผู้ถือ session aal1 (รู้รหัสผ่าน) ปั๊มชุดโค้ดเองแล้วใช้โค้ดนั้น mint aal2 ได้ | **บังคับ aal2 ที่ตัว RPC** — `0045` §2: `mfa_backup_codes_replace` และ §4: `mfa_backup_codes_invalidate` อ่าน `request.jwt.claims->>'aal'` ต้องเป็น `aal2` ไม่งั้น RAISE (JWT aal1 ยิง PostgREST ตรงก็ถูก) · ชั้น BFF recent-MFA ≤15 นาที ยังอยู่คู่กัน | integration dcr14 **เคส b** (regenerate aal1=403 → aal2 ได้ 8 โค้ด no-store → status ไม่มีโค้ด → consume valid → ซ้ำ invalid) · เคส d (ปิด MFA: aal1 = 403 ERR-AUTH-004) — ผ่านใน battery สด (integration 20/171 ALL PASS) |
| F2 | **HIGH** — pending cookie `ltc_mfa_pending` เดิมบรรจุ access/refresh token จริง → ผู้ควบคุม HTTP client ประกอบ session ใช้งานได้ก่อนยืนยัน MFA | **cookie เก็บ uuid v4 ของ stash เท่านั้น** — คู่ token เข้ารหัส **AES-256-GCM** (env `LTC_MFA_PENDING_KEY` · base64 32 ไบต์) เก็บตาราง `mfa_pending_stash` (0045 §5) อายุ 300 วิ/single-use ตัดสินที่ DB · `mfa_pending_stash_create/take/consume` (take = peek สำหรับพิมพ์ผิดลองใหม่ · consume = ตายจริงเมื่อ verify สำเร็จก่อนออก session) | unit `src/lib/auth/mfa.test.ts:147` (parsePendingStashCookie รับ uuid v4 เท่านั้น fail-closed) · `:159` (encrypt/decrypt ตรงกัน · ค่าเพี้ยน/คีย์ผิด = null — GCM ตรวจแก้ไข) · `:181` (decodePendingStashKey รับ base64 32 ไบต์เท่านั้น) · integration dcr14 **เคส c** (login สองขั้น: pending cookie ไม่มี session → ผิด = invalid ลองใหม่ได้ → ถูก = session aal2 + pending ถูกล้าง) |
| F3 | **HIGH** — email change เรียก `updateUser` (GoTrue) ก่อน audit RPC เสมอ → เมื่อ RPC ปฏิเสธ คำขอ+ลิงก์ยืนยันเกิดแล้ว (mutation เกิดก่อน guard) | **สลับลำดับ — RPC audit ก่อน updateUser เสมอ** (`src/lib/auth/email-change.ts`) ให้ guard aal2/role ที่ DB ตัดสินก่อนเกิด mutation · อีเมลซ้ำถูก audit ด้วยก่อนตอบ masked (anti-enumeration คงเดิม) | unit `src/lib/auth/email-change.test.ts:240` ("normal path: order verify -> audit -> update") · `:251` (wrong password → updateUser+audit never called) · hash-shape เคส 211/39/45 |
| F4 | **MED** — เส้นทาง consume โค้ดสำรองไม่จำกัดความพยายาม — ยิง RPC ตรง brute-force ได้ไม่จำกัด | **ตาราง `mfa_backup_attempts` + lockout ใน RPC** (0045 §1, §3): ผิดครบ **5 ครั้ง = ล็อก 15 นาที** คืน `{valid:false, locked:true}` · โค้ดถูกก็ถูกกันขณะล็อก · ผิด→ถูก = รีเซ็ตนับใหม่ · รูปร่างไม่ใช่ `xxxx-xxxx` = ไม่นับ fail | integration dcr14 **เคส e** ("consume lockout (gate r1 F4): ผิด 2 ครั้ง→ถูก = รีเซ็ต · ผิด 5 ครั้ง = ล็อก · โค้ดถูกก็ถูกกันขณะล็อก") — ผ่านใน battery สด |
| F5 | **MED** — อายุ pending 300 วิไม่ถูกบังคับฝั่ง server · เส้นทาง expired ไม่ล้าง cookie | บังคับที่ stash ของ F2: `expires_at` ที่ DB (create ใส่ now()+300s · take/consume ตรวจ deadline และสถานะ used) — replay หลัง 5 นาที = แถวตาย | กลไกเดียวกับ evidence F2 (stash deadline เป็นคอลัมน์ของตาราง `mfa_pending_stash` 0045 §5 · ตรวจใน take/consume) + dcr14 เคส c ที่ pending ถูกล้างหลังสำเร็จ |
| F6 | **MED** — replace แบบ DELETE→INSERT ไม่มี serialization → concurrent regenerate อาจเหลือโค้ดสองชุดใช้ได้ | **`pg_advisory_xact_lock(hashtext('mfa_backup_codes:'\|\|user))`** ใน replace (0045 §2) และ `mfa_backup_consume:` ใน consume (§3 — กันนับ fail คร่อมกันด้วย) | โค้ด 0045:91, 125 · พฤติกรรม replace/invalidate/consume ถูก pin รวมใน dcr14 เคส b/d/e · advisory lock ต่อผู้ใช้เป็นแบบแผนเดียวกับ `ltc:account:roles:{user_id}` ที่ผ่าน DCR-12 เคส c มาแล้ว |
| F7 | **MED** — trigger `audit_email_change_confirmed` กลืนทุก exception (RAISE WARNING แล้วปล่อย commit) → หลักฐานเหตุการณ์ identity เปลี่ยนหายเงียบได้ถาวร | **fail-closed** — 0045 §6 ตัด handler กลืน: exception ใน trigger ให้ rollback การเปลี่ยนอีเมลทั้งรายการ (เหตุการณ์ความปลอดภัยห้ามหลุดโดยไม่มี event) | โค้ด 0045 §6 (คอมเมนต์ "ห้ามกลืน exception") · เส้นทาง request→audit ที่ BFF ถูก pin ที่ email-change.test.ts:240/251 · เหตุการณ์ CONFIRMED เกิดอัตโนมัติจาก trigger 0044 เดิม (VA-PENTEST V7.2.x) |
| F8 | **MED** — CSP prod มี `script-src 'unsafe-inline'` ไม่มี nonce/hash → ไม่หยุด inline payload เมื่อเกิด HTML injection | **middleware ออก nonce ต่อ request** (`src/middleware.ts` — `generateCspNonce` = btoa(crypto.randomUUID()) · ตั้ง header ทั้ง request+response เพื่อให้ Next nonce inline bootstrap): prod = `script-src 'self' 'nonce-…' 'strict-dynamic'` **ไม่มี unsafe-inline/eval** · dev เพิ่ม `'unsafe-eval'` (React Refresh) · `style-src 'unsafe-inline'` คงไว้โดยเจตนา (inline styles ของ Next/Tailwind — จดข้อจำกัดไว้ที่ VA-PENTEST §5.2 ข้อ 6) · CSP ย้ายออกจาก next.config.ts (header ซ้ำ = browser ใช้ตัวแรก) | unit `src/middleware.test.ts:237` (prod ไม่มี unsafe-inline/eval + มี nonce+strict-dynamic) · `:250` (dev +unsafe-eval) · `:260` (nonce ยาวพอ ไม่ซ้ำ) · `:267` (ทุก response มี CSP nonce เปลี่ยนทุก request) · `:280` (response ปฏิเสธ CSRF ก็มี CSP) · **live proof บน dev stack 2026-09-13**: `curl -I localhost:3000/login` ตอบ `script-src 'self' 'nonce-…' 'strict-dynamic' 'unsafe-eval'` (dev) |
| F9 | **MED** — หน้า callback อีเมลเปลี่ยนทิ้ง access/refresh token ค้างใน URL fragment/address bar/history | `src/app/(auth)/email-change/callback/page.tsx:73` — อ่าน fragment แล้ว `window.history.replaceState(null, "", pathname)` **ทันที** (ไม่เพิ่มประวัติ) | โค้ด `callback/page.tsx:70-73` (คอมเมนต์อธิบายเหตุผล) · API-SPEC 1.2.9 แถว 129 pin พฤติกรรม |
| F10 | **LOW** — trigger `consents_from_signup` dedupe กับแถวเดิมเท่านั้น — คีย์ซ้ำสองตัวใน array เดียวถูก INSERT ได้ทั้งคู่ | **`distinct on (item->>'key')`** ใน 0045 §7 เลือกตัวแรกต่อคีย์ก่อนตรวจซ้ำแถวเดิม | โค้ด 0045 §7 · พฤติกรรม consent รวมอยู่ใน integration ที่ผ่าน battery สด (20/171) |

หมายเหตุ: codex ที่ปิดท้ายคำวินิจฉัย r1 ให้อัปเดต artifact ให้ตรง commit (unit 8 failed/eslint 3 errors ของ run เก่า) — ปิดแล้วด้วย battery สด (VA-PENTEST 1.1.0 §3.1 หมายเหตุ 1)

---

## 2.5 Gate r2 — finding → fix → evidence (G1-G5 ทั้ง 5 ตัว)

คำวินิจฉัยเดิม: `.omc/artifacts/gate-f-p0-r2-output.md` (codex FAIL · 2 HIGH + 3 MED บน fix batch รอบ r1) · การแก้ = migration `0046_gate_r2_security_fixes.sql` + `src/lib/auth/mfa.ts` + `src/app/(auth)/actions.ts` + `src/app/(auth)/mfa-actions.ts` + หน้า force-dynamic 7 หน้า + เทสใหม่ — ทั้งหมดอยู่ใน fix batch รอบนี้ (commit เดียวกับเอกสารนี้) และผ่าน battery สดลำดับเดียว (unit 170/2,363 · tsc 0 · eslint 0 · build RC=0 · integration 20/173 · e2e **34/34** (11.1 นาที · `E2E-EXIT=0`))

| # | ความรุนแรง/เรื่อง (สรุปจากคำวินิจฉัย) | การแก้ | Evidence |
| --- | --- | --- | --- |
| G1 | **HIGH** — `mfa_pending_stash_take` คืน ciphertext ดิบ: ผู้ขโมย uuid เรียก take แล้วนำ ciphertext ไป `stash_create` เป็นแถวของตัวเอง (TTL หมุนใหม่ + รอดการ consume ของเจ้าของ) → ใช้ login สองขั้นต่อได้ | **AAD ผูก ciphertext กับเจ้าของแถว+deadline** — `0046` §G1a: `mfa_pending_stash_create(p_payload, p_expires_at)` ตรวจกรอบ `> now()` และ `≤ now()+305 วิ` (ต่ออายุหน้าต่างโจมตีไม่ได้) เก็บ as-is · §G1b: `take` คืน jsonb `{payload, user_id, expires_at}` ของแถวจริง · ฝั่งแอป (`mfa.ts`): `pendingStashAad(userId, deadlineSec)` = `${userId}:${deadlineUnixSec}` ใส่ `cipher.setAAD()` ตอนเข้ารหัส · `take` ประกอบ AAD จาก `user_id`+`expires_at` ของแถวก่อนถอด — user_id มาจาก `auth.uid()` ที่ create (ปลอมไม่ได้) → สำเนา re-host GCM auth ไม่ผ่าน = ถอดไม่ได้ | unit `mfa.test.ts` ("AAD (userId:deadlineSec) — เจ้าของแถวหรือ deadline เพี้ยนถอดไม่ได้ (pin G1)" — คนอื่น/deadline+1 วิ/ว่าง = null) · integration dcr14 **เคส f1** end-to-end ผ่าน app จริง: ขโมย uuid จาก Set-Cookie → attacker take ได้ ciphertext จริง → create แถวใหม่ในชื่อตัวเองผ่านกรอบของ RPC → ยื่นผ่าน `/login/verify` = `state=expired` ไม่มี session · **เคส f2 (1)** กรอบ `p_expires_at` (อดีต / +400 วิ = `ERR-VAL-001`) |
| G2 | **HIGH** — CSP nonce ของ middleware เดี้ยงบนหน้าที่ Next prerender เป็น static: HTML ไม่มี nonce → prod `script-src 'nonce-…' 'strict-dynamic'` บล็อก inline bootstrap → ไม่มี hydration (รวมถึง replaceState เคลียร์ token ของ F9) | **บังคับ dynamic rendering เฉพาะจุด** — `export const dynamic = "force-dynamic"` ที่ 6 หน้า RSC shell (`/my/license`, `/my/notification-settings`, `/my/notifications`, `/my/privacy`, `/my/profile`, `/verify`) + แกะ `/email-change/callback` เป็น server shell (force-dynamic) + client component แยกไฟล์ (`src/components/auth/email-change-callback-client.tsx` — ตัวสินค้าเดิมทุกประการ รวม F9) · `/_not-found` เหลือ static เป็นข้อจำกัดที่ยอมรับ (ไม่มี client island ของเรา — bootstrap ของ Next เอง) | build สด: prerender-manifest เหลือเฉพาะ `/_not-found` (ก่อนแก้ 8 หน้า static) · **probe production server จริง** `.omc/artifacts/probe-g2-csp.txt` (`next start` :3001 — ทุกหน้า 200 + header `script-src 'nonce-…' 'strict-dynamic'` + nonce อยู่ใน HTML + เปลี่ยนทุก request) · e2e ที่แตะหน้าเหล่านี้ผ่าน browser จริง (e2e-11 `/verify` · e2e-14/15 `/my/*`) |
| G3 | **MED** — `consumePendingMfaTokens` fail-open (คืนโมฆะทุกกรณีที่ไม่ใช่สำเร็จ — caller ปล่อยออก session) + UPDATE ไม่ตรวจ deadline ณ consume (take ผ่านตอนยังมีชีวิต → verify ช้า → consume หลัง deadline ผ่านอยู่) | **fail-closed สองชั้น** — `0046` §G3a: UPDATE เพิ่ม `and expires_at > now()` · ฝั่งแอป: `consumePendingMfaTokens` คืน **boolean** (true เฉพาะ `data === true`) และ **throw `ERR-SYS-001` เมื่อ RPC ผิดพลาด** (client ฉีดได้เพื่อ unit test) · caller (`mfa-actions.ts`) gate การออก session: consume false → เคลียร์ cookie + `state=expired` · RPC ล้ม → `loginErrorUrl` (ERR-SYS-001) — "ไม่ consume สำเร็จเต็มรูปแบบ = ไม่มี session" | unit `mfa.test.ts` ("consumePendingMfaTokens — true เฉพาะ RPC ยืนยัน · false/throw fail-closed (pin G3)": stub true/false/รูปเพี้ยนไม่ยิง RPC/error → throw `ERR-SYS-001`) · integration dcr14 **เคส f2 (2)** ดัน `expires_at` เป็นอดีตด้วย psql → consume = false · **(3)** consume สำเร็จ true → ยิงซ้ำ false (single-use) |
| G4 | **MED** — `mfa_backup_codes_invalidate` (ขั้นปิด MFA) ไม่ถือ advisory lock + replace ตรวจ factor-verified **นอก** lock → invalidate วิ่งสอดแทรกระหว่าง "ตรวจ factor" กับ "INSERT ชุดใหม่" ได้ = เหลือโค้ดใช้ได้บนบัญชีที่ปิด MFA ไปแล้ว | **lock เดียวครอบทั้งคู่ + ตรวจ factor ใต้ lock** — `0046` §G4b: invalidate ถือ `pg_advisory_xact_lock(hashtext('mfa_backup_codes:'\|\|user))` (คีย์เดียวกับ replace) · §G4a: replace ย้ายการตรวจ factor-verified มาอยู่หลัง `perform pg_advisory_xact_lock` — invalidate/replace serialize เต็มรูปแบบ ทุกลำดับการจบจบด้วย "ไม่มีโค้ดใช้ได้หลังปิด MFA" | integration dcr14 **เคส f2 (4)** โครงสร้างตรง DB: `pg_get_functiondef` ของ invalidate/replace มี lock คีย์ `mfa_backup_codes:` ทั้งคู่ + ใน replace ตำแหน่ง lock มาก่อนการอ้าง `mfa_factors` (ตรวจ factor ใต้ lock) — race จริงไม่ deterministic ในเทส จึง pin โครงสร้าง + อาศัย semantic ของ PG advisory xact lock |
| G5 | **MED** — evidence anchor ขาด: dcr14 เคส e (+62/−4) ไม่เคยถูก commit และ battery r1 รันบน working tree สกปรก — ตัวเลขที่อ้างใน 1.0.0 ไม่ผูกกับ commit ใด | **ปิดด้วยกระบวนการ** — fix batch r2 นี้ commit ทุกไฟล์ (เคส e+f รวมอยู่ใน commit เดียวกับ 0046) · battery สดรอบใหม่รัน **ก่อน commit บน tree ที่จะ commit ทั้งหมด** แล้วเอกสารนี้ + VA-PENTEST §3.1 อ้างตัวเลขรอบใหม่เท่านั้น (รอบ r1 เก็บไว้เป็นเทียบ) | battery สดรอบ r2: unit 170/2,363 · tsc 0 · eslint 0 · build RC=0 (static เหลือ `/_not-found`) · integration 20/173 (เพิ่ม f1/f2) · **e2e 34/34** (33 first-attempt + 1 flaky ผ่าน retry — e2e-15 ฟอร์มใบอนุญาต เคสเดียวกับที่ผ่าน retry มาแล้วในรอบ r1 · 11.1 นาที · `E2E-EXIT=0` — e2e-11 `/verify` · e2e-14/15 `/my/*` ผ่าน browser จริง = พยาน hydration ของ G2) · gitleaks staged ผ่านทุก commit ของ batch |

---

## 3. Incident ระหว่าง battery สด — e2e 4 เคสตายจาก DocumentViewer ไม่ refresh outline (ไม่ใช่ช่องโหว่ความปลอดภัย)

บันทึกไว้ที่นี่เพราะเป็นงานแก้ที่เกิดใน fix batch เดียวกันและถูกใช้เป็นเงื่อนไขก่อนปิด battery:

1. **อาการ**: e2e ตาย 4 เคส (e2e-07/10/11) ที่ helper เดียวกัน `completeDocumentViaUi` (`e2e/d9-helpers.ts:347-360`) — คลิก "อ่านจบแล้ว" แล้วรอป้าย "เรียนจบแล้ว" ของ outline 15 วิ ไม่ปรากฏ
2. **ต้นเหตุ (ของแอป ไม่ใช่เทส)**: หน้า learn เป็น Server Component ล้วน · `DocumentViewer` POST `/progress` สำเร็จ 200 (RPC `record_lesson_progress` ตัดสิน document = **completed ทันที** ที่ 0011) แต่ไม่เคยสั่ง refresh — ป้ายที่ server render ไว้ไม่มีทางอัปเดตในหน้าเดิม · รอบ 34/34 ของ 1.0.0 ผ่านมาได้เพราะ webpack HMR ใน dev กระตุ้น RSC refetch โดยบังเอิญ (trace: POST แล้วมีแต่ webpack-hmr ไม่มี navigation) — **การตัดสินว่า fix batch gate r1 เป็นสาเหตุถูกหักล้างด้วยการทดลอง stash A/B** (รันเทสเดียวกันโดน stash middleware+next.config ออก — ยังตาย)
3. **การแก้**: `src/components/learner/document-viewer.tsx` — `router.refresh()` หลัง attestation สำเร็จ (แบบแผนเดียวกับ mutation ของหน้า admin ทั้งหมด)
4. **Evidence**: e2e-07 ผ่าน first-attempt · e2e-10+11 ผ่าน 4/4 first-attempt · รอบเต็มใหม่ = **34/34 เขียว (33 first-attempt + 1 flaky ผ่าน retry — เคส e2e-15 ฟอร์มใบอนุญาต ไม่เกี่ยวกับการแก้นี้ · 10.9 นาที · `E2E_RC=0`)** ท้าย `.omc/artifacts/battery-phase0/e2e.txt` (VA-PENTEST §3.1)
5. **ขอบเขตที่จดไว้ไม่แก้ใน wave นี้**: VideoPlayer/QuizPanel มีช่องว่าง live-update แนวเดียวกันแต่ไม่มี assertion ที่ตายจากมัน — เปิดเป็นงานตามสำหรับ wave ถัดไป

---

## 4. Accepted-Risk Register — npm audit (ตัดสินตาม mentor D29 · 2026-09-13)

**การตัดสิน: accept-with-expiry** (คำปรึกษา codex ผ่าน D29 — "major critical decision use codex for mentor") · เหตุผลหลัก: **ไม่มี CSS/ไฟล์ที่ผู้ใช้ควบคุมถึง PostCSS ในกระบวน build ของแอป** — CSS ทั้งหมดมาจาก Tailwind/Next toolchain เอง (ข้อยกเว้นตาม ASVS 14.2.1) · ช่องโหว่ทั้งชุดโดนผ่าน build chain ไม่ใช่ runtime ของแอป · การอัปเกรด `next` ข้าม major กลาง wave มีความเสี่ยงต่อความถูกต้องของ release สูงกว่าความเสี่ยงที่ยอมรับชั่วคราวนี้

### 4.1 รายการที่ยอมรับ (ทั้งหมดจาก `npm audit --omit=dev` + dev ที่เกี่ยวเนื่อง)

| # | แพ็กเกจ/ช่วงที่โดน | Advisory (GHSA) | เส้นทางจริงใน repo | ความรุนแรง | เหตุผลที่ยอมรับได้ |
| --- | --- | --- | --- | --- | --- |
| R1 | postcss `<=8.5.22` | **GHSA-qx2v-qp2m-jg93** (XSS via unescaped `</style>` in CSS stringify) | `next@15.5.25 → postcss@8.4.31` (**เฉพาะสำเนาซ้อนใต้ next** — สำเนา top-level ผ่าน `@tailwindcss/postcss@4.3.3` เป็น 8.5.28 > 8.5.22 ไม่อยู่ช่วงโดน) | high | ต้องมี CSS ที่ผู้โจมตีควบคุมเข้า stringify — แอปไม่มีจุดรับ CSS ภายนอก/จากผู้ใช้ (ทั้งหมดจาก toolchain) |
| R2 | postcss `<=8.5.22` | **GHSA-6g55-p6wh-862q** (arbitrary file read via sourceMappingURL) | เส้นทางเดียวกับ R1 | high (ชุดเดียวกับ R1) | ต้องมี source map ที่โจมตีวางไว้ — build ใช้แหล่งเดียวคือ repo เอง (CI + dev ของทีม) |
| R3 | postcss `<=8.5.22` | **GHSA-fxqj-rqcc-2cmp** (incomplete fix ของ 6g55 — attacker-controlled CSS) | เส้นทางเดียวกับ R1 | high (ชุดเดียวกับ R1) | เงื่อนไขเดียวกับ R1 — ไม่มี attacker-controlled CSS ถึงมือ PostCSS |
| R4 | postcss `<=8.5.22` | **GHSA-r28c-9q8g-f849** (path traversal in previous source map auto-loading) | เส้นทางเดียวกับ R1 | high (ชุดเดียวกับ R1) | เงื่อนไขเดียวกับ R2 — ไม่มี source map ภายนอกใน build |
| R5 | next `9.3.4-canary.0 – 16.3.0-preview.10` | (ส่งต่อจากชุด postcss R1-R4) | `next@15.5.25` (direct prod dep) | moderate | ครอบโดยการตัดสิน R1-R4 + ตั๋วอัปเกรด §4.3 |
| R6 | vitest / @vitest/mocker `2.1.0 – 4.1.10` | **GHSA-82fw-gwwq-j7x9** (path traversal/arbitrary file read via mocker) | `vitest@3.2.7 → @vitest/mocker@3.2.7` (**dev dependency เท่านั้น** — ไม่อยู่ใน dependency สดของ runtime) | moderate | dev-only · ไม่รันโค้ดทดสอบที่ผู้ใช้ควบคุม — ชุดทดสอบของ repo เอง |

### 4.2 เงื่อนไขเปิดรายการใหม่ (reopen — เจอเงื่อนไขใดเงื่อนไขหนึ่ง = ยกเลิกการยอมรับทันที)

1. แอปเริ่มรับ **CSS จากภายนอก/ผู้ใช้** ไม่ว่าทางใด (อัปโหลด, import จาก URL, ธีมผู้ใช้)
2. มีการ **parse CSS ตอน runtime** ของแอป (ไม่ใช่ build เท่านั้น)
3. **trust boundary เปลี่ยน** — เช่น เปิดให้บุคคลภายนอก contribute ไฟล์ต้นทาง/asset เข้า build pipeline
4. **advisory ใหม่** ที่ทำให้เงื่อนไข "ไม่มี attacker-controlled CSS" ไม่พอ หรือกระทบ runtime

### 4.3 การกำกับดูแล (owner + expiry + ตั๋ว)

| รายการ | ค่า |
| --- | --- |
| เจ้าของ (owner) | Lead (PM) ของ wave — ตามลำดับการทำงานปัจจุบัน |
| **วันหมดอายุการยอมรับ (expiry)** | **2026-10-15** (หลังคลื่นงาน Wave F ปิดและหน้าต่างอัปเกรดถัดไป — ห้ามเลยวันนี้โดยไม่มีการตัดสินใหม่เป็นลายลักษณ์อักษร) |
| ตั๋วอัปเกรด | `next@16.3.5` (fixAvailable จริงจาก npm audit · semver-major) — เปิดเป็นงานหลักหลังปิด Wave F: อัปเกรด → รัน battery เต็ม → ปิด R1-R5 · ระหว่างรอ: `npm audit` ทุก PR + CI ตรวจวันหมดอายุของ register นี้ (เลย = fail) |
| ตั๋ว dev-deps | `vitest@4.x` ตามจังหวะอัปเกรด toolchain เดียวกับ next (ปิด R6) |

### 4.4 เงื่อนไข override ฉุกเฉิน (แยกจากการยอมรับนี้)

กรณีจำเป็นต้อง pin `postcss@8.5.23` (เวอร์ชันแก้ชุด R1-R4) ก่อนอัปเกรด next ได้ **เฉพาะเป็น PR แยก** พร้อม: (1) pin แบบ **exact 8.5.23** ไม่ใช่ range (2) **พิสูจน์ว่า Next โหลดสำเนา override จริง** (npm ls + build ที่ใช้ 8.5.23 ของ next) (3) `npm audit` เขียวเพียงอย่างเดียว **ไม่เพียงพอ** — ต้องแนบหลักฐานการโหลดจริงด้วย

---

## 5. การตัดสิน V2.5.3 — อายุของชุดโค้ดสำรอง (design decision ที่ยอมรับ)

- **คำถามของ ASVS V2.5.3**: lookup secret ควรมีวันหมดอายุตามตัว — as-built ไม่มีอายุต่อชุด (ตายเมื่อ regenerate/invalidate/unenroll เท่านั้น)
- **การตัดสิน: ยอมรับเป็น design decision** เพราะ: (1) การออกชุดใหม่อยู่ใต้ **recent-MFA ≤15 นาที + aal2 ที่ RPC** (0045 F1 — JWT aal1 ยิงตรงก็ถูกปฏิเสธ) (2) การออกชุดใหม่/ปิด MFA **ฆ่าชุดเก่าทันทีแบบ atomic** (3) consume มี lockout 5 ผิด/15 นาที (F4) — brute-force ชุดเก่าไม่มีทางไร้จำกัด (4) ผู้ถือโค้ด = ผู้ผ่าน MFA enrollment มาแล้วเท่านั้น
- **ความเสี่ยงคงเหลือ**: ชุดโค้ดที่ไม่ถูกแตะอยู่ได้ไม่มีกำหนด — จึงยังแนะนำให้ external pentest โจมตีสมมติฐานนี้จริง (VA-PENTEST §5.3)
- **เงื่อนไขพิจารณาใหม่**: ถ้ามีโจทย์ compliance ที่บังคับ expiry ต่อ credential ทั้งประเภท ให้เปิด DCR เพิ่ม `expires_at` ที่ตารางโค้ดสำรอง

## 6. การตัดสิน V2.2.3 — ERR-AUTH-003 เป็นหนี้ทะเบียน (documented registry debt)

- **ข้อเท็จจริง (grep ทั้ง repo 2026-09-13)**: รหัส `ERR-AUTH-003` (423 บัญชีถูกล็อกชั่วคราว) มีอยู่ที่ทะเบียน (`src/lib/errors.ts`) + เทสทะเบียน (`src/lib/errors.test.ts`) เท่านั้น — **ไม่มี runtime caller จริง** ณ wave นี้
- **การตัดสิน**: ไม่ถือเป็นช่องโหว่ที่ "ยังไม่ทำงาน" แต่บันทึกเป็น **หนี้ทะเบียน** — การชดเชยที่บังคับจริง 3 ชั้น: GoTrue rate limit ในตัว (over_request_rate_limit → 429) · BFF AUTH 10/นาที ต่อ IP+อีเมล · lockout นับครั้งจริงเฉพาะโค้ดสำรอง (consume 5 ผิด/15 นาที — 0045 F4)
- **เงื่อนไขปิดหนี้**: เมื่อมีเส้นทางใดจะ emit ERR-AUTH-003 จริง ต้องผ่าน DCR + เทส pin พฤติกรรม lockout นั้น (นับครั้ง/หน้าต่าง/การปลดล็อก) ก่อนใช้รหัสนี้ที่ runtime

---

*ท้ายเอกสาร — ทุกตัวเลข/evidence อ้าง artifact จริงใน `.omc/artifacts/` หรือ `file:line` ที่อ่านจริงบน `feat/wave-f` วันที่ 2026-09-13 · เอกสารนี้เป็นแหล่งรวมเหตุผลการตัดสินความปลอดภัยของ wave ที่ VA-PENTEST.md อ้างถึง — เมื่อเงื่อนไข reopen (§4.2) หรือเงื่อนไขพิจารณาใหม่ (§5-§6) ถูกกระทบ ต้องอัปเดตเอกสารนี้พร้อมวันที่*
