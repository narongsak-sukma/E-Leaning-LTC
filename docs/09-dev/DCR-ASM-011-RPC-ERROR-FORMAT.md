# DCR ASM-011 — รูป error ของ attempt RPC ตระกูล session mismatch (Wave I เฟส 2)

Filing: verdict r22 ข้อ (2) "Family B DCR ASM-011 ×4" + อนุมัติเปิดเฟสใน verdict wavei-r2 ("อนุญาตให้ r35 เป็น battery แรกที่นับ D90 และเปิดเฟส 2 Family B DCR ASM-011 ×4 ตาม D71 พร้อม gate ของตัวเอง") · รูปแบบเดียวกับ DCR 22023 (Wave H) ที่ผ่าน closing gate แล้ว

## ข้อบกพร่อง

จุดยก error 4 จุดของ attempt RPC ใช้รูปข้อความ `(ASM-011 — ERR-RBAC-001)` ปิดท้าย ซึ่ง**ไม่ตรง** `TRAILING_CODE_RE` ของ `parseRpcErrorCode` (`src/lib/api/rpc-errors.ts:25` — regex บังคับให้ `ERR-` ติดหลังวงเล็บเปิดทันที) → parser คืน `undefined` → ผู้บริโภค BFF ตกไป `ERR-SYS-002` **503 opaque** ทั้งที่เป็นการปฏิเสธถาวรที่ต้องตอบ **403 ERR-RBAC-001**:

- จุด raise (ข้อความเดียวกันเป๊ะทั้งสี่): `supabase/migrations/0011_functions.sql:709` (`save_answer`) · `0011:793` (`submit_attempt`) · `0019_wave_d_batch.sql:282` (สำเนา redefine ของ `save_answer`) · `0020_auto_submit.sql:187` (สำเนา redefine ของ `submit_attempt` — **นิยามสุดท้ายที่รันจริงบน DB** เพราะ last-wins)
- ผู้บริโภค: `src/app/api/v1/attempts/[id]/submit/route.ts:99-103` · `src/app/api/v1/attempts/[id]/answers/route.ts:73-75` — สองจุดนี้ `code === undefined` → `new AppError("ERR-SYS-002")` · **ไม่มี retry loop** (ต่างจากกรณี 22023 ที่ retry 3 ครั้งก่อน 503 — ที่นี่ตอบ 503 ทันที)
- ผลต่อผู้ใช้: ผู้เรียนอุปกรณ์ที่สอง (session ใหม่จาก login ครั้งที่สอง) ส่งคำตอบ/ส่งข้อสอบเจอ "ระบบขัดข้องชั่วคราว" แทน "session ไม่ตรง" และ audit/monitor เห็น 5xx ปลอม

เทสปัจจุบันทำให้มองไม่เห็นรู: route unit tests ป้อนข้อความสังเคราะห์ `คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001)` ซึ่ง parser ผ่านอยู่แล้ว — ผ่านทั้งที่ DB จริงไม่เคยส่งรูปนั้น · integration (d8) ตรวจ `toContain("ERR-RBAC-001")` แบบ substring จึงผ่านแม้ parser ไม่รับ

## การแก้ (แก้ที่แหล่งยก error — บัญญัติของ DCR 22023)

1. **แก้ 4 จุดในไฟล์ migration ต้นทาง** (in-place เหมือน 22023 แก้ 0008/0019/0025/0032) จาก:
   ```sql
   raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ASM-011 — ERR-RBAC-001)';
   ```
   เป็น:
   ```sql
   raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ERR-RBAC-001|session_mismatch)';
   ```
   - ไม่แตะ parser (`rpc-errors.ts` รับรูป `(CODE|tag)` อยู่แล้ว) · ไม่แตะทะเบียน (`src/lib/errors.ts:27` มี `ERR-RBAC-001` → httpStatus 403 อยู่แล้ว) · ไม่แตะ BFF routes
   - เหตุผลที่ไม่เขียน migration ใหม่แทรก: fence ทิศ ก อ่านจากไฟล์ และ 22023 ตั้งบรรทัดฐาน "แก้ที่แหล่ง" + replay ด้วย reset-db (dev DB สร้างใหม่จาก migrations ทั้งหมด — 0020 last-wins คือนิยามที่รันจริง)
2. **ตัด exception ของ fence** `tests/integration/dcr-22023-error-format.test.ts` — ลบ `LEGACY_ASM011` + การยกเว้นทั้งหมด ให้ ทิศ ก บังคับ `malformed === []` เฉย ๆ (ตามคำสั่งที่เขียนไว้ในตัว fence เอง: "น้อยลง = ถูกแก้แล้วให้ตัดรายการยกเว้น")
3. **พลิกเทส route unit ให้ pin ของจริง**: submit `route.test.ts` (case "session ไม่ตรงของ attempt") + answers `route.test.ts` (case "session ไม่ตรงของ attempt (ASM-011)") — เปลี่ยน message ในตาราง case เป็นข้อความใหม่เป๊ะที่ DB จะส่งจริง พร้อม reason · คง case opaque (ไม่มี code ท้ายข้อความ → 503 ERR-SYS-002) ไว้ป้องกันการถอย
4. **เพิ่ม assertion parse ฝั่ง integration**: ใน `tests/integration/d8-exam-cert-flow.test.ts` สามจุดปฏิเสธที่มีอยู่ (:425 `p_session_id` ไม่ตรง · :455 claim อุปกรณ์ 2 · :466 submit claim อุปกรณ์ 2) เพิ่มการเช็ค `parseRpcErrorCodeDetailed({ message })` = `{ code: "ERR-RBAC-001", reason: "session_mismatch" }` — พิสูจน์ว่าข้อความจาก DB จริง (หลัง replay) parser รับ ไม่ใช่แค่ substring

## Two-way proof [[regression-test-two-way-proof]]

- **ทิศสกปรก (fence)**: คืนข้อความ em-dash ที่จุดใดจุดหนึ่ง → fence ทิศ ก (ที่ตัด exception แล้ว) ต้องล้มพร้อม file:line
- **ทิศสกปรก (BFF)**: ป้อนข้อความเก่า `(ASM-011 — ERR-RBAC-001)` ให้ route → ต้องได้ 503 ERR-SYS-002 (case opaque ครอบอยู่แล้ว — ห้ามลบ)
- **ทิศสกปรก (live)**: ก่อน `make reset-db` ฟังก์ชันเดิมบน DB ยังยก em-dash → d8 assertion parse ใหม่ต้องล้ม (บันทึก probe ก่อน replay เป็นหลักฐาน) — หลัง reset-db (replay migration ที่แก้) ผ่านทุกด้าน
- **ทิศสะอาด**: ทุกชั้นผ่าน — fence strict · route 403 · d8 parse เป๊ะ (ผลจริงของ battery เต็ม r36/r37 อยู่ท้ายเอกสาร)

## ลำดับดำเนินงาน (D-f-7: integration กับ e2e ไม่ชนกัน · E2: dump ก่อนทำลาย)

1. แก้ 4 จุด + fence + route tests + d8 assertions (code ทั้งหมดใน commit เดียว หลัง battery r35 จบเท่านั้น — ไม่แตะต้อง tree ระหว่าง battery ที่กำลังนับ D90)
2. รัน unit + fence (pure ทิศ ก/ข) บน tree ใหม่
3. probe live ทิศสกปรก (ก่อน reset-db) บันทึกผล 503/unparseable
4. `make reset-db` (E2 dump-before-down ครอบอยู่อัตโนมัติ)
5. integration ทั้งชุด → health 200 → e2e (ตามลำดับบัญญัติ)
6. battery r36 เต็ม (แผนเดิมคือ D90 รอบ 2/3 บน container เดิม `7be3fd8e1316…` — ผลจริง: container เปลี่ยนจาก `make reset-db` ของขั้น 4 และ r36 ล้มที่ stage e2e ดู "ผลการดำเนินงานจริง" ท้ายเอกสาร)
7. gate เฟส 2 (wavei-r3) พร้อมหลักฐานทั้งหมด

## ผลการดำเนินงานจริง (บันทึกหลัง gate wavei-r3 — แทนความคาดหมายเดิมข้างบน)

- **ชั้นต่าง ๆ ตามแผน (ขั้น 1–5) ผ่านครบ**: fence ทิศ ก strict 3/3 (`asm011-fence-r1.log` · `malformed === []` ไม่มี exception เหลือ) · BFF route 46/46 รวม dirty pins รูปเก่า → 503 opaque · live probe ก่อน reset-db = 3 failed | 30 passed (ล้มเฉพาะ parse assertions ใหม่ = รูที่เทสเดิมมองไม่เห็น) · `make reset-db` ครอบ E2 (dump 4739/4739 แถว timestamp ก่อน `down -v`) · live หลัง replay 33/33 + `pg_proc` ยืนยันข้อความใหม่ · IT เต็ม 34 ไฟล์ 326/326 · health 200 · e2e เดี่ยว 41 ผ่าน + 1 flaky
- **battery เต็ม (ขั้น 6) ไม่เป็นไปตามความคาดหมาย**: r36 FAIL 10/13 (e2e-05 ล้มทั้งสองพยายาม) · r37 FAIL 10/13 (e2e-10 ล้มทั้งสองพยายาม ล้มต่างจุด: assertion หลังคลิกยืนยันเพิกถอน · retry ล้มที่ `page.goto /login` timeout 300s) — ทุก stage ก่อน e2e เขียวครบทั้งสองรอบ (r37: unit 2722/2722 · IT 326/326 · health 200) · ใน log app จริงมี marker `Server is approaching the used memory threshold, restarting...` และ webpack TypeError bursts ในหน้าต่าง e2e ทั้งสองรอบ — **สถานะสาเหตุคงเป็นสมมติฐานตาม D-f-11** (gate wavei-r3 วินิจฉัย: correlation และการสลับเทสที่ล้มยังตัด regression ไม่ได้)
- **D90 = 0/3**: r35 (PASS 13/13) เป็นโมฆะเพราะ container เปลี่ยนจาก reset-db (เกณฑ์ข้อ 3) · r36/r37 FAIL — เริ่มสะสมใหม่บน production runtime ตามเงื่อนไข verdict
- **gate wavei-r3 (2026-09-16): PASS เฉพาะงาน ASM-011** — "แก้ข้อความครบ 4 จุด ตัด exception ของ fence และเพิ่ม positive/negative route tests ถูกขอบเขต … เพียงพอให้ปิดงาน ASM-011 โดยยอมรับข้อยกเว้น battery เต็มใน gate นี้อย่างชัดเจน" · อนุญาตเปิดเฟส 3 production-build e2e เป็นพาหะวัด D90 · หาก e2e-05/e2e-10 ล้มซ้ำบน production build ต้องสอบสวนต่อ
