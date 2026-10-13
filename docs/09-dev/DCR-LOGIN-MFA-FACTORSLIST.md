# DCR login-mfa-factorslist: listFactors ใน loginAction พึ่ง session ในหน่วยความจำของ SDK แล้วตายเงียบใน Next runtime — เปลี่ยนเป็น REST ตรงด้วย token ที่ถืออยู่ + บันทึก error ที่เคยถูกกลืน

Filing: ปิดคลัสเตอร์ B ที่เปิดค้างของ BL-015 ("rl-MFA ERR-SYS-001 deterministic · dcr14 ผ่าน isolated") · 2026-10-13 ~17:5xZ · ขอบเขต: **src/app/(auth)/actions.ts จุดเดียว (แขนขา factors-check ของขั้น password) — ไม่แตะ fence/คุกกามีอื่น · ไม่แตะ middleware/config · ไม่แตะเทส**

## หลักฐาน (decision-grade — วัดจากระบบจริงทั้งหมด · log ที่ .omc/artifacts/it-iso2-* + kong access log)

1. **อาการเดียวกันเป๊ะสี่จุดสองรันไทม์ และ reproduce ได้นอก suite**: full-suite (16:22-17:03Z) ล้ม 4 เทส — dcr14 เคส c/f1 (`expected '/login?error=ERR-SYS-001' to be '/login/verify'`) + เคส d (`staffAal2.length=0` — aal2 mint ตายเพราะ flow เดียวกัน) + wave-g-login-ratelimit MFA · isolated คืนนี้ทั้งสองไฟล์ก็แดง (it-iso2-dcr14 58s · it-iso2-rl 89s) — **dcr14 พลิกจาก isolated-เขียว (เช้า) เป็น isolated-แดง (คืน)** · **ขับฟอร์ม login จริงด้วยมือ (parse action id จาก GET /login → multipart POST) กับ probe user + TOTP factor verified: ล้มบน :3000 dev (303→ERR-SYS-001 ใน 426ms) และ :3001 production build เหมือนกันเป๊ะ (156ms)** — เป็นบั๊กของ product บน production runtime ไม่ใช่ของ dev runtime
2. **หลักฐานสายไฟ (Kong access log — จับซ้ำได้หลายครั้ง 17:01-17:22Z)**: ขั้น password ของ action = `POST /auth/v1/token?grant_type=password` **200** (2274-2390 bytes — session กลับมาครบ) → `GET /auth/v1/user` 200 (middleware) → **`GET /auth/v1/factors` ไม่เคยออกจาก container เลย** (grep ทั้งหน้าต่าง = 0 แถว) → action ตอบ 303 ERR-SYS-001 โดยไม่มี error ไหนถูก log ฝั่ง server — คือ `auth.auth.mfa.listFactors()` คืน error โดยไม่ยิง network (ตายใน SDK ระหว่าง `_useSession` หา session ในหน่วยความจำไม่เจอ) แล้ว action กลืน error นั้นเงียบ ๆ (ช่องว่าง observability)
3. **การแยกส่วนพิสูจน์ว่า "ใน Next runtime" เป็นตัวแปร**: สคริปต์ bare-node ใน container เดียวกัน (`docker compose exec app node`) ใช้ @supabase/supabase-js 2.116.0 + env เดียวกัน + user เดียวกัน (factor verified) รัน **ลำดับเดียวกันเป๊ะ** createStandaloneAuthClient → signInWithPassword → mfa.listFactors = **ผ่าน** (listFactors 9ms · error null · เห็น egress ที่ kong) — ความตายเกิดเฉพาะเมื่อรันในกระบวนการ Next (dev และ prod build ล้มเหมือนกัน → ไม่ใช่ hot-reload/watcher)
4. **ซอร์สนิ่ง**: actions.ts ไม่เปลี่ยนตั้งแต่ wave-G (f4b92a1) · แก้ CSRF (26e533d) แตะ middleware/config เท่านั้น และ grant ผ่าน = url/key ถูก · lockfile ไม่เปลี่ยนตั้งแต่ 1f93cdb (ยุคที่ battery r36/r37 เขียวบนเครื่องเดิม) — ตัวแปรที่เข้ามาใหม่คือ **เครื่อง+image สร้างใหม่หมด 2026-10-13**: `node:22-alpine` เป็น **tag-pin ลอยตัว** (วันนี้ได้ node 22.23.3 + undici 6.28.1) และ gotrue:v2.164.0 pull ใหม่ — ตระกูลเดียวกับ BL-015 H2 (image drift) · **สังเกตเพื่อนร่วมตระกูล**: คำตอบ enroll factor ของ gotrue ใหม่ = **410KB** เพราะ `totp.qr_code` เป็น SVG ทำ rect ทุกช่อง (4225 rect) — ยก digest-pin ค้างอยู่ที่ OQ ของ DCR-PROD-DEPLOY-DRAFT อยู่แล้ว (เพิ่มเติม: node:22-alpine ควรอยู่ในรายการ pin ด้วย)

## ทางแก้ (2 จุด)

| จุด | แก้ | ไฟล์:บรรทัด |
|---|---|---|
| 1 | **เลิกพึ่ง session ในหน่วยความจำของ SDK ตรงจุดตรวจ factor**: หลัง `signInWithPassword` คืน session (ถือ access_token อยู่ในมือแล้ว) — เรียก **REST ตรง** `GET {SUPABASE_URL}/auth/v1/factors` พร้อม `Authorization: Bearer session.access_token` + `apikey: <anon>` แล้วจับ firstVerifiedTotpFactor จาก response เดิม (id/factor_type/status จาก GoTrue — รูปเดียวกับที่ SDK คืน) · **semantics fail-closed คงเดิมทุกตัวอักษร**: fetch โยน / non-2xx / parse ไม่ได้ = 303 ERR-SYS-001 เหมือนเดิม · ใช้ url/key จาก getConfig() ทางเดียวกับ createStandaloneAuthClient (ผิวเดียวกัน ไม่เพิ่มช่อง env) | src/app/(auth)/actions.ts:201-206 (แขนขา listFactors ของ loginAction) |
| 2 | **บันทึก error ที่เคยถูกกลืน**: บรรทัด structured log เดียวฝั่ง server เมื่อออกจากทาง ERR-SYS-001 (ชนิดความล้มเหลว + ขั้นที่ตาย) — คลาส "ตายเงียบไม่มีใครเห็น" นี้กินเวลาสอบสวนหลายชั่วโมงเพราะ action ไม่บอกอะไรเลย | จุดเดียวกัน (ก่อน redirect ทาง error) |

## Test-first (RED มีอยู่แล้ว — ไม่ต้องเขียนเทสใหม่)

1. **RED ปัจจุบัน (deterministic)**: dcr14 เคส c/f1 + เคส d (ตามา) + wave-g-login-ratelimit MFA — ล้มทั้ง isolated และ in-suite ด้วย signature เดียวกัน
2. หลังแก้: isolated ทั้งสองไฟล์ต้องเขียว (dcr14 7/7 · rl ครบ) — พิสูจน์ทั้งทางแก้และไม่ถอยหลัง
3. full-suite 35 ไฟล์ detached → ต้อง 35/35 + stack-integrity (cron 8 + mailer Up + app health) ตาม binding เดิม → qa gate → battery r38 → merge --no-ff + RISK ACCEPTANCE + baseline ceiling table
4. (ทางเลือกตรวจเสริม ถ้า qa ขอ) e2e battery-prod บน :3001 เป็นตัวพิสูจน์ production runtime อยู่แล้วตามลำดับปกติ

## ทางเลือกอื่นที่พิจารณาแล้ว (เหตุผลที่ไม่เลือก)

- **`auth.auth.setSession(session)` ก่อน listFactors**: พึ่ง SDK ต่อ (แค่ย้าย state) · setSession มีผลข้างเคียงกับ storage/refresh ที่ไม่ต้องการใน action ไร้ cookie · ยังผูกกับพฤติกรรมภายใน SDK ที่พิสูจน์แล้วว่าเปราะใน runtime นี้ · REST ตรงตัดการพึ่งพานั้นทั้งหมดโดยใช้ของที่มีอยู่แล้วในมือ (access_token)
- **อัปเดก @supabase/supabase-js**: เดิมพันกับพฤติกรรม SDK เวอร์ชันอื่นที่ต้องทดสอบใหม่ทั้งสาย auth — กว้างเกินจุด และ lockfile นิ่งเป็นหลักคำสอนของเครื่องนี้
- **แก้ที่ image (pin node:22-alone digest ย้อนกลับ)**: ถูกทางระยะยาว (ยกไป DCR-PROD-DEPLOY OQ แล้ว) แต่ไม่ถอดสภาพ "SDK ตายเงียบใน runtime หนึ่ง" ได้ — โค้ดควรทนทานต่อ runtime drift ที่จุด fail-closed สำคัญของ authentication โดยไม่พึ่ง state ในหน่วยความจำ

## บทเรียนกระบวนการ (บันทึกตามข้อความ coordinator)

- **ชั้นวัดโกหก — ต้องตรวจสอบด้วยคำสั่งตรงเสมอก่อนเชื่อผล**: stack-integrity check ที่ฝังใน launcher (cmd.exe /c ครอบ docker exec psql "select ..." และ docker ps --format มี space) ถูก cmd.exe ตัดคำจน psql ได้ SQL หักกลาง ("unterminated quoted identifier") และ docker ps ปฏิเสธ format → สรุป cronOk=false/mailerUp=false ทั้งที่ stack จริงสะอาด (ตรวจซ้ำด้วย compose exec ตรง ๆ = cron 8/8 + mailer Up + app healthy) — ครั้งหน้าคำสั่ง check ใน launcher ต้อง spawn แบบ array-form ไม่ผ่าน cmd.exe /c รอบสอง
- สอบสวนคลัสเตอร์นี้เร็วขึ้นมากเพราะ (1) ขับ surface จริงเองนอก suite (repro ในมือ) (2) สคริปต์ bare-node แยกตัวแปร "ใน Next" ออกจาก "SDK/env" — แบบแผนนี้ควรจดไว้ใช้กับบั๊ก "ตายเงียบ" รอบหน้า

## ฉันทามติ + GO (รอ)

- รอ **pm** (scope + แนวทาง: REST ตรงที่จุดเดียว พอรับไหม หรือชี้ทางเลือกอื่น) + **qa** (testability: fail-closed ครบทุกทิศของ REST ใหม่ + รูป log line) ผ่าน bridge
