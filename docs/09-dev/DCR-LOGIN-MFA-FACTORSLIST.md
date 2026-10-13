# DCR login-mfa-factorslist (ฉบับแก้หลัง qa objection รอบ 1): เลี่ยงพฤติกรรม session ในหน่วยความจำของ SDK ที่จุดตรวจ factor ด้วย getUser(jwt) overload + บันทึก error ที่เคยถูกกลืน

Filing: ปิดคลัสเตอร์ B ที่เปิดค้างของ BL-015 · 2026-10-13 (ฉบับแรกถูก qa ค้าน 5 ข้อ — ทั้งหมดพับเข้าฉบับนี้ พร้อมการแก้กลไกตามหลักฐานใหม่ที่ qa ชี้) · ขอบเขต: **src/app/(auth)/actions.ts จุดเดียว + แก้ mock ตำแหน่งเดียวของ src/app/(auth)/actions.login-rate-limit.test.ts (อนุญาตเป็นการเฉพาะตาม qa blocker 5) — ไม่แตะ fence/คุกกามีอื่น · ไม่แตะ middleware/config**

## Severity (pm ยกระดับ — P0)

จุดตายอยู่ "ก่อน" การแยกสาย factor — `mfa.listFactors()` ถูกเรียกทุกการล็อกอินแบบฟอร์ม ไม่ว่าผู้ใช้จะมี factor หรือไม่ → **ทุกการล็อกอินผ่านฟอร์มบน stack นี้ตายหมด** (เฉพาะเคสที่ตายก่อนถึง listFactors เช่นรหัสผ่านผิดจึงเห็น error ตามปกติ) — บั๊กนี้บล็อก full-suite 35/35 · battery r38 (e2e สาย login) · UAT PF-1..PF-5 ทั้งกระบวนการ

## กลไกตามหลักฐาน (แก้ถูกต้องตามข้อค้นพบของ qa — ฉบับแรกเข้าใจผิดบางจุด)

- **listFactors ของ SDK ไม่ได้เรียก GET /auth/v1/factors เลย**: `_listFactors()` (GoTrueClient.js:5010-5038) เรียก `this.getUser()` **แบบไม่มี argument** แล้วมาปั้นรายการ factor จาก `user.factors ของคำตอบ /auth/v1/user` — สายไฟจริงที่เห็นตลอด (grant 200 → getUser 200 → "ไม่มี factors egress") อธิบายได้ครบ: getUser แบบไม่มี jwt ต้องผ่าน `initializePromise` + lock + อ่าน session ในหน่วยความมความจำ (GoTrueClient.js:2677-2691) — ใน Next runtime มันหาไม่เจอ/ล้ม → error กลับมาโดยไม่มี network → action กลืน error เงียบ ๆ → 303 ERR-SYS-001
- **เส้นทาง /auth/v1/factors (แบบ REST ตรงตามที่ฉบับแรกเสนอ) ถูกถอดออก**: หลักฐานใน repo เอง (probe จริง) — tests/integration/dcr14-mfa.test.ts:495 จดว่า GET /auth/v1/factors ระดับ user คืน **405** ใน GoTrue build นี้ · src/lib/auth/mfa.ts:18-20 เอ่ยถึงข้อจำกัดตระกูลเดียวกัน (ชี้เจาะ: ข้อความนั้นบันทึก 405 ของ admin factors route — ไม่ใช่ user-level GET โดยตรง แต่ยืนยันโลก 405 ของเส้นตระกูล factors ตาม probe จริง)· probe สดของ qa (ไม่มี bearer) ได้ 401 (route มีอยู่) — สอง artifact ขัดกันและ **ไม่มีใครวัดคำตอบแบบมี bearer เลย** = ไม่ decision-grade สำหรับประตู auth ที่ fail-closed → ห้ามใช้โดยไม่มี probe ใหม่บันทึกลง DCR
- **การแยกส่วนที่ยืนยันแล้ว (จากฉบับแรก — ยังเก็บไว้)**: ลำดับเดียวกันเป๊ะใน bare-node ใน container เดียวกัน (SDK/env/user เดียวกัน รวม factor verified) **ผ่าน** — ความตายจำเพาะต่อการรันในกระบวนการ Next (dev :3000 และ prod build :3001 ล้มเหมือนกัน — reproduce นอก suite 426ms/156ms ด้วย probe user + verified TOTP factor) · ซอร์สนิ่งตั้งแต่ wave-G (f4b92a1) · lockfile นิ่งตั้งแต่ 1f93cdb (ยุค battery เขียวบนเครื่องเดิม) — ตัวแปรที่เข้ามาใหม่ = เครื่อง+image สร้างใหม่ 2026-10-13: node:22-alpine **tag-pin ลอยตัว** (node 22.23.3 + undici 6.28.1) + gotrue:v2.164.0 pull ใหม่ (คำตอบ enroll 410KB จาก SVG QR 4225 rect — ตระกูล BL-015 H2) — **node:22-alpine เข้ารายการ pin ของ DCR-PROD-DEPLOY OQ เพิ่ม**

## ทางแก้ (2 จุด — ตามคำสั่ง pivot ภายใต้อำนาจ delegated + คำแนะนำของ qa เอง)

| จุด | แก้ | ไฟล์:บรรทัด |
|---|---|---|
| 1 | **Pivot: ใช้ `auth.auth.getUser(session.access_token)` — overload ที่รับ jwt ตรง ๆ** (GoTrueClient.js:2673-2675: `if (jwt) return await this._getUser(jwt)` — **ไม่แตะ initializePromise/lock/หน่วยความจำเลย = รอดพ้นคลาสพฤติกรรมที่พิสูจน์แล้วว่าตาย โดยการก่อสร้าง**) · อ่าน `data.user.factors` — **อาร์เรย์เดียวกับที่ `_listFactors` ของ SDK ปั้นผลลัพธ์ให้ `firstVerifiedTotpFactor` อยู่แล้ว** (SDK วน user.factors ตัวเดียวกัน :5024) · error/ผิดรูป = ERR-SYS-001 ตามกติกาเดิม · **กติการูปร่าง (qa blocker 4): `user` ไม่ใช่ object = bad_body → ERR-SYS-001 · `user.factors` เป็น undefined/null = "ไม่มี factor" ตามปกติของผู้ใช้ไร้ factor (ห้าม ERR-SYS-001 ไม่งั้น P0 ทุก login ตายซ้ำ) → เข้าสาย setSession เดิม · `user.factors` truthy แต่ไม่ใช่ array = bad_body → ERR-SYS-001 ก่อนถึง firstVerifiedTotpFactor เสมอ (ห้าม TypeError รั่วไป 500 digest)** | src/app/(auth)/actions.ts:201-206 |
| 2 | **log line เดียวสำหรับคลาส error ที่เคยถูกกลืน** (qa blocker 3): `createLogger(getConfig().logLevel)` ตามแบบแผน src/lib/auth/logout-all.ts:22 · คำศัพท์ msg เป็น enum ตายตัว `fetch_error \| non_2xx \| bad_body \| timeout` · ฟิลด์ status = รหัส HTTP ตัวเลข · **ห้าม interpolate error.message/error-object/URL (allowlist SDS §6.2)** — บันทึกก่อน redirect ทาง ERR-SYS-001 ทุกทางออก | จุดเดียวกัน |

- **เหตุผลที่ไม่มี AbortSignal ใหม่ (qa blocker 2 — บันทึบความคิดตามคำสั่ง)**: getUser(jwt) ไม่นำ fetch ดิบเข้ามาใหม่ — คำขอ network อยู่ใน SDK ภายใต้ global fetch ของ runtime เหมือนเดิม (เส้นทางเดียวกับ signInWithPassword ที่ทำงานอยู่จริง) · ทางออก fail-closed ระดับ action (catch ทุก rejection → ERR-SYS-001 + log) ครอบการค้างของ network อยู่แล้ว · ข้อกำหนด `AbortSignal.timeout(<ค่าที่ตั้งชื่อ>)` + `timeout` ในคำศัพท์ log เก็บไว้เป็นเงื่อนไข **เฉพาะ variant REST ดิบ** ซึ่งถูกถอดออกจากขอบเขตแล้ว

## Test-first (RED มีอยู่แล้ว — ระบุครบตาม qa blocker 5)

1. **RED inventory (ปัจจุบัน deterministic)**: (ก) integration — dcr14-mfa เคส c/f1 (ERR-SYS-001 แทน /login/verify) + เคส d (staffAal2 ว่าง — ตามาจาก flow เดียวกัน) + wave-g-login-ratelimit เคส MFA สองขั้น (ข) **unit — src/app/(auth)/actions.login-rate-limit.test.ts:65-81 mock อยู่บน seam เดียวกับที่เปลี่ยน (`mfa.listFactors`) และเคส :234-288 ผูกรูป mock นั้น — ต้องแก้พร้อมกัน** ไม่งั้น unit แตกเอง
2. **สิ่งที่อนุญาตในไฟล์ unit (แคบสุด)**: re-point mock จาก listFactors เป็น **global-fetch stub คุมด้วย host จำลอง `supabase.test.local`** — ครอบ token grant + GET /user (คืน user พร้อม factors สามรูป: ไร้ factors / มี verified totp / factors ไม่ใช่ array) ให้ SDK จริงวิ่งบน fetch ต้ม — เทสย่อยเดิม (:234-288) คงความหมายทุกเคส · **implement + mock re-point + log line = commit เดียว (pm blocker 1)**
3. หลังแก้: dcr14 **7/7** + wave-g-login-ratelimit เขียวแบบ isolated → full-suite 35 ไฟล์ 35/35 + stack-integrity → qa gate → battery r38 → merge --no-ff + RISK ACCEPTANCE + baseline ceiling table
4. **ขั้นที่สอง (stage-2) src/app/(auth)/mfa-actions.ts:81 — pm non-blocking**: ผูกกับประตูเดียวกัน (dcr14 7/7 isolated) — ถ้ายังแดงหลังแก้จุดนี้แล้ว เปิด **P1b addendum** แยกต่างหาก ไม่ยืด DCR นี้

## ทางเลือกอื่นที่พิจารณาแล้ว (ฉบับแรก + เพิ่มจากรอบ objection)

- **REST ตรง GET /auth/v1/factors**: ถอด — endpoint ไม่ถูกวัด (405 ใน probe ของ repo เอง vs 401 ของ qa — ขัดกัน) และ SDK ก็ไม่ได้ใช้เส้นนี้ (qa material finding)
- **REST ตรง GET /auth/v1/user ด้วย bearer**: ทำได้ (เส้น+รูปพิสูจน์แล้วโดยการทำงานจริงของ SDK) แต่ต้องพิสูจน์ wire contract เพิ่มเอง — getUser(jwt) ได้ของเดียวกันผ่าน SDK ที่ repo ใช้อยู่แล้ว โดยไม่เพิ่มชั้น fetch ใหม่ → เลือก overload
- **`auth.auth.setSession(session)` ก่อน listFactors**: พึ่ง state ของ SDK ต่อ + ผลข้างเคียง storage/refresh ที่ไม่ต้องการใน action ไร้ cookie
- **อัปเดก @supabase/supabase-js**: กว้างเกินจุด ต้องทดสอบสาย auth ใหม่ทั้งหมด
- **แก้ที่ image (pin digest ย้อน)**: ถูกทางระยะยาว (ยกไป DCR-PROD-DEPLOY OQ แล้ว รวม node:22-alpine) แต่ไม่ถอดสภาพ "SDK ตายเงียบใน runtime หนึ่ง" — โค้ดต้องทน runtime drift ที่ประตู auth

## บทเรียนกระบวนการ (คงจากฉบับแรก)

- **ชั้นวัดโกหก — ตรวจด้วยคำสั่งตรงก่อนเชื่อผล**: stack-integrity check ใน launcher (ผ่าน cmd.exe /c) ถูกตัดคำจน psql/docker ps พัง → สรุปผิดว่า stack เสีย ทั้งที่ตรวจตรง ๆ แล้วสะอาด — ครั้งหน้า check ใน launcher ต้อง spawn array-form ไม่ผ่าน cmd.exe /c
- **อ่านซอร์สของ dependency ก่อนสรุป wire contract**: ฉบับแรกอ้าง listFactors→GET /factors จากเอกสาร/ความเข้าใจ แต่ SDK จริง derive จาก /user — qa จับได้เพราะอ่าน GoTrueClient.js ตรง ๆ (บทเรียน: หลักฐาน wire ต้องมาจากซอร์สติดตั้มจริงหรือ capture ไม่ใช่ความจำ)
- repro นอก suite + bare-node แยกตัวแปร = แบบแผนมาตรฐานสำหรับบั๊ก "ตายเงียบ"

## ฉันทามติ + GO

- **pm CONSENT (ผ่าน bridge · 2026-10-13)**: แนวทาง + การคืนสถานะ acceptance รับรอง + ปลดบล็อก UAT PF-5 · ยกระดับ severity เป็น P0 (fail-close ยิงก่อนการแยกสาย factor = ทุก login ตาย) · blocker: implement + test ต้อง commit เดียว · non-blocking: stage-2 src/app/(auth)/mfa-actions.ts:81 ผูกประตู dcr14-7/7-isolated (P1b ถ้ายังแดง) + node:22-alpine เข้ารายการ pin ของ deploy DCR
- **qa OBJECTION รอบ 1 (5 blockers — พับครบในฉบับนี้)**: (1) pivot กลไก + ลบคำอ้างรูป response ของ /factors + แ
ลบคำอ้างรูป response ของ /factors + แก้คำอธิบาย root cause (2) เงื่อนไข AbortSignal เฉพาะ variant REST (บันทึกเหตุผลไว้แล้วในหัวข้อทางแก้) (3) log line: createLogger(getConfig().logLevel) + enum msg ตายตัว + status ตัวเลข + ห้าม interpolate ตาม SDS §6.2 (4) shape-guard ครบสามทิศ รวม "factors หาย = ผู้ใช้ไร้ factor ตามปกติ" กัน P0 ซ้ำ (5) อนุญาตแก้ mock ของ actions.login-rate-limit.test.ts แคบสุด (global-fetch stub ที่ supabase.test.local) + ระบุไฟล์นี้ใน RED inventory

- **qa round-2 CONSENT (ผ่าน bridge · 2026-10-13)**: ปิดครบทั้งห้า blockers พร้อมเทียบซอร์ส SDK ยืนยันเอง (ทาง no-lock ของ getUser(jwt) · คำอธิบาย root-cause ฉบับแก้ · shape-guard สามทิศ โดยชี้ว่าความหมาย "ผู้ใช้ไร้ factor" สอดคล้องกับการ modeling `user?.factors ?? []` ของ SDK เอง · ข้อกำหนด log ที่ pin · ขอบเขต mock re-point ที่แคบลง) · nits สองข้อพับแล้วในฉบับนี้ (คำอธิบาย mfa.ts:18-20 = admin route · path เต็มของ stage-2)
- **GO (CTO · 2026-10-13)**: ฉันตามติครบ pm + qa รอบ 2 → GO ทั้งสองจุด + mock re-point ตามขอบเขตที่อนุญาต · implement สามส่วน commit เดียว → isolated dcr14 7/7 (stage-2 src/app/(auth)/mfa-actions.ts:81 ผูกประตูนี้ — P1b ถ้ายังแดง) + rl + unit → full-suite 35/35 → qa gate → battery r38 → merge + records → UAT (PF-5 จะเป็นหลักฐาน end-user ของแก้นี้ด้วย)
- **รอ qa round-2 confirm ของ P1/P2 ฉบับแก้นี้** (pm consent ยืนอยู่ — ขอบเขตแนวทางคืนสถานะไม่เปลี่ยน) → GO (CTO) → implement สามส่วนใน commit เดียว (action fix + mock re-point + log line) → isolated dcr14 7/7 + rl → full-suite 35/35 → qa gate → battery r38 → merge --no-ff + RISK ACCEPTANCE + baseline ceiling table → UAT

## Mid-work discovery หลัง implement (บันทึกตาม governance ก่อนซ่อม — หลักฐานตัดสิน)

- **ตัวจริงของคลัสเตอร์ B พบตอน verify รอบแรก**: หลังลง pivot แล้ว dcr14/rl ยังแดงที่เคสเดิม · kong รอบใหม่เห็น grant 200 + **GET /user สองครั้ง** (อันที่สอง = getUser(jwt) ของโค้ดใหม่ — ทางพิเนียวทำงานจริง) แต่ไร้ RPC stash และไร้ log → ทางออกที่เหลือมีที่เดียว: `stashPendingMfaTokens` คืน null **ก่อนถึง RPC** · ไล่ตาม mfa.ts:351-358: `getConfig().mfaPendingKey === null` → **`.env` ของเครื่องนี้ไม่ได้ตั้ง `LTC_MFA_PENDING_KEY`** (บรรทัด 148 คอมเมนต์อยู่ — template .env เองจดเตือนไว้ "ไม่ตั้ง = login บัญชี MFA ตอบ ERR-SYS-001 fail-closed" = อาการเป๊ะ) — ช่องว่าง provisioning ตอนสร้าง .env บนเครื่องสำรอง
- **ทำไมสายไฟก่อน ๆ อ่านผิด**: รอยก่อนหน้า (เช้า) เห็น "grant 200 → GET /user → เงียบ" และตีความ GET /user นั้นเป็นของ middleware + listFactors ตายก่อน egress — ความจริง GET /user ตัวนั้นคือ getUser ที่ listFactors เรียก (SDK derive จาก /user ตามที่ qa ชี้) **ผ่านสำเร็จ** แล้ว flow ไปตายที่ stash เพราะไม่มีคีย์ — ทางออกไม่เคยมีเสียงเพราะสาขานั้นไม่มี log (ปิดแล้วด้วยคำศัพท์ `stash_unavailable` เพิ่มใน enum จุด 2 — เป็นคำที่จะตั้งชื่อบั๊กนี้ในบรรทัดเดียวถ้ามีมาแต่แรก)
- **สรุปบทบาทของสิ่งที่ลงไปแล้ว**: (1) การซ่อมตัวจริง = **provisioning repair ใต้อำนาจ delegated** — สร้างคีย์ `openssl rand -base64 32` เทียบเท่า ใส่ .env (ไฟล์เครื่อง ไม่ commit) + recreate ทั้ง app และ app-prod (env_file อ่านตอน create) → probe จริงกลับมา **303 /login/verify + ตั้ง ltc_mfa_pending** ทันที (2) pivot getUser(jwt) **คงไว้** — ทำงานจริง (เห็น egress ครบ) และตัดการพึ่ง state ในหน่วยความจำของ SDK ณ ประตู auth ตามที่ GO ไป (3) log lines ทั้งสี่ทางออก (classify-default · session-null · getUser/shape · stash-null) ครอบคลาส "ตายเงียบ" ครบทุกทางแล้ว — มันคือชิ้นที่ขาดไม่ได้ของการไล่ครั้งนี้
- **การ์ดที่ยังเปิด**: สาย stage-2 (mfa-actions.ts:81) ผูกประตู dcr14-7/7-isolated ตามเดิม (ตอนนี้คีย์ตั้งแล้ว ควรกลับมา) · OQ ยกไป DCR-PROD-DEPLOY: **ตรวจ-burn-in ว่า .env ของเครื่องใหม่ครบทุกค่าที่ "dev ก็ต้องตั้ง"** (CURSOR_HMAC_SECRET/IP_HASH_SALT มี fallback · LTC_MFA_PENDING_KEY ไม่มี) — ควรมี pre-flight grep ใน DEV-SETUP/PROD-CHECKLIST
