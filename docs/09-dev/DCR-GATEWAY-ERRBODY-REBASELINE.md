# DCR gateway-error-body re-baseline + timing budgets หลัง postgrest image drift (BL-015 ข้อสรุปข้อ A/B)

Filing: BL-015 (two-strike) · 2026-10-13 · ขอบเขตแคบ: **test-infra + 1 บรรทัด compose เท่านั้น — ไม่แตะ `src/` ใด ๆ ไม่แตะลด assertion ความหมาย**

## หลักฐาน-สาเหตุ (สองก้อน — แยกกันชัด)

1. **postgrest image drift (H2 — deterministic พิสูจน์แล้ว)**: image `postgrest/postgrest:v12.2.3` ที่ pull ใหม่ 2026-10-13 (เครื่องสำรอง) **relay ร่าง error ของ P0002 เต็มรูปแก่ caller** — probe สด (`.omc/artifacts/probe-p0002-kong.mjs` / `probe-p0002-direct.mjs`):
   - ผ่าน Kong :8000 → `500 application/json {"code":"P0002","details":null,"hint":null,"message":"… (ERR-NF-001|job_not_processing)"}`
   - ตรงที่ rest:3000 (ข้าม Kong จากใน app container) → **เหมือนเป๊ะ** → ตัวเปลี่ยนคือ PostgREST เอง Kong เป็น pass-through สองยุค
   - พฤติกรรมเก่าที่เทส pin ไว้ (ตรวจจริง 2026-09-15 · บทเรียน dcr10 §"P0002" · dcr11:363-366): P0002 → 500 ทึบ "Something went wrong" **ไม่มี CLF line ของ rest** → พิสูจน์ terminal ได้ทางเดียว = error block ของ db
   - พฤติกรรมใหม่: body JSON ทะลุ + **มี CLF line** (request จบปกติ) → (ก) เทสท์ assert `json` เป็น null ล้ม 5 จุด (ข) เทสท์ pin evidenceLeg `db-error-block` ล้ม 2 จุด (settle ผ่านขา `clf-nonce-line` แทน — ถูกต้องตามความจริงใหม่)
   - ผลกระทบความปลอดภัย: message มีแท็ก envelope (ERR-NF-001|…) มองเห็นได้ที่ผิว **direct-gateway ซึ่งต้องมี apikey/service key อยู่แล้ว** · พื้นที่ user-facing ทั้งหมดผ่าน BFF ของแอป (error-wrapping + parseRpcErrorCodeDetailed — โค้ดไม่เปลี่ยน) · P0001 message ทะลุมาตลอดแม้สแตกเก่า (บทเรียน dcr10:1232-1236) — drift แค่ขยายแพตเทิร์นเดิมไปยัง P0002 · **ไม่มีข้อมูลผู้ใช้รั่ว (RLS ปกติ)**
   - digest เก่าเรียกคืนไม่ได้ (เครื่องเดิมตาย ไม่มีบันทึก digest) → "pin กลับ" ไม่มีทางเลือก — ทางออกคือ re-baseline เทสตามความจริงใหม่ + freeze ด้วย digest ปัจจุบัน
2. **เครื่องสำรองช้า 3-4 เท่า (H1 — วัดแล้ว)**: psql side-channel 1.0-1.4s/ครั้ง · docker inspect ~0.5s · ต่อไฟล์ dcr10 419-452s · wave-h-audit 543-549s (สแตกเดิม battery IT ทั้งชุดจบในสเกลเดียวกัน) → budget ที่ออกแบบบนเครื่องเก่ากลายเป็นขอบชิด:
   - bff `appReachable` probe `AbortSignal.timeout(5_000)` (wave-g-qb-bank-detail.test.ts:475) → โดนที่ล้ม = **25 เทส skip** → ไม่มีใคร bump version ของ Q_ACTIVE → เทส revoke "expected '1' to be '3'" ล้มตาม (deterministic ทั้ง in-suite และ isolated — ตรวจแล้วสองบริบทเหมือนกันเป๊ะ 26|1|25)
   - timeout ของเทส lock/คิวหนัก: dcr10 เคส 10 (60s) · เคส 13/14 (30s) — in-suite ล้ม 1 isolated ล้ม 3 (marginal แกว่ง) · dcr9 เคส 12 (45s) in-suite ล้ม (isolated รอบแรกถูก contamination จาก orphan vitest ของรันซ้อน — ต้อง rerun สะอาดก่อนเป็นหลักฐานสุดท้าย)

## ทางแก้ (ทั้งหมด test-infra + compose 1 บรรทัด)

| จุด | แก้ | ไฟล์:บรรทัด |
|---|---|---|
| 1 | re-baseline การตรวจ body 5 จุด: เดิม `expect(json).toBeNull()` → ใหม่ `expect(json?.code).toBe("P0002")` + คง `status 500` (เจตนา "ไม่กลายเป็น 200 เงียบ" อยู่ครบ) + คง snapshot แถวงานไม่เปลี่ยน + ลบ assert `text` ไม่มี "ERR-"/"job_not_processing" (จริงใหม่คือมี — ยอมรับที่ผิว direct-gateway ตามหลักฐานข้อ 1) | wave-h-battery-audit-guards:1323 · :1894 · dcr11-pdpa:377 · :455 · dcr12-p5r1:605 |
| 2 | evidence-leg pins 2 จุด: `db-error-block` → `clf-nonce-line` (CLF line มีจริงทุก dispatch แล้ว — ขาหลักฐานที่ settle ผ่านจริง) | wave-h-battery-audit-guards (r8 :1919 + r2 error-block test) |
| 3 | timing budgets: probe 5s→30s · testTimeout เคส lock/คิวหนัก ×2.5 (60→150 · 30→75 · 45→110) พร้อม comment เหตุผล "เครื่องสำรอง 3-4 เท่า (BL-015)" | wave-g-qb-bank-detail:475 · dcr10 เคส 10/13/14 · dcr9 เคส 12 |
| 4 | freeze พื้นฐานใหม่: compose `postgrest/postgrest:v12.2.3` → `postgrest/postgrest@sha256:729bf65c733b73f5b52777f0e4b853f22ed73aa67a22d38269d289779b0a8401` (digest ปัจจุบันที่ probe แล้ว) — กัน drift ซ้ำ · kong/gotrue ฯลฯ แยกเป็น OQ ของ DCR-PROD-DEPLOY ตามบทเรียนเดิม | docker-compose.yml:101 |

ขอบเขตคงที่: ไม่แตะ `src/` · ไม่เปลี่ยน fence/settle logic ใน helpers/test-io (เกินขอบเขต — ถ้า qa เห็นว่าจำเป็นให้ยกเป็นคำถาม) · ไม่แต่ลดการตรวจสอบใดนอกจากที่ระบุ

## แผนทดสอบ

1. isolated ไฟล์ที่แก้ (wave-h-battery-audit-guards · dcr11-pdpa · dcr12-p5r1 · wave-g-qb-bank-detail · dcr9 · dcr10) เขียวทั้งหมด
2. full-suite integration (detached launcher — กัน kill 60 น.) เขียวทั้งชุด + เก็บ log ที่ `.omc/artifacts/` (เงื่อนไข binding ปิด residual r5-M1)
3. หลัง merge: battery r38 ตามแผนเดิม

## คำถามที่ยังเปิด (ไม่บล็อก DCR นี้ — อยู่ใน BL-015)

- rl-MFA (wave-g-login-ratelimit เคส 3): ERR-SYS-001 แทน /login/verify — deterministic isolated (13:35 สะอาด) แต่ dcr14-mfa ผ่าน isolated — สาเหตุยังไม่ระบุ (wire trace: action หยุดหลัง password grant ไม่มี listFactors/stash ออกไป Kong)
- dcr14-mfa in-suite ล้ม (ERR-SYS-001 ตระกูลเดียวกัน) แต่ isolated ผ่าน — รอผลของข้อบนก่อนตัดสิน
- dcr9 เคส 12 isolated สะอาด (รอ 1 รันหลังปิดรันซ้อนทุกตัว)
