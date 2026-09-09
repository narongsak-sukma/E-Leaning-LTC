<!-- LTC E-Learning — PR template [B-04] · ยึด merge gates ตาม PROJECT-PLAN §3/§4 + TEST-PLAN §3.4 -->

## Task ID

- **[B-xx]** <ชื่อ task> — เช่น `[B-04] CI 5 ด่าน: lint + tsc + test + build + secrets scan`

## สรุปการเปลี่ยนแปลง

<!-- 1–5 bullet อธิบายว่าเปลี่ยนอะไร เพราะอะไร -->

-

## ประเภทการเปลี่ยนแปลง (เลือกหนึ่งขึ้นไป)

- [ ] โค้ดทั่วไป (UI / ทั่วไปที่ไม่แตะ security)
- [ ] **auth/security/data** — แตะ `supabase/**` / RBAC / session / secrets / env / migration
  → ต้องผ่าน **codex gate** ก่อน merge (PROBE-PASS เท่านั้น — PROJECT-PLAN §3)

## หลักฐาน merge gates ครบ 5 ด่าน (evidence — no fake completion)

> รัน `bash scripts/ci-local.sh` ก่อนเปิด PR เสมอ — ใส่ exit code จริง ห้ามเดา

| ด่าน | คำสั่ง | Exit code | หมายเหตุ |
| ---- | ------ | --------- | -------- |
| 1/5 lint | `npm run lint` | | |
| 2/5 typecheck | `npm run typecheck` | | |
| 3/5 test | `npm run test` | | tests passed: ____ |
| 4/5 build | `npm run build` | 0 | |
| 5/5 secrets | `bash scripts/ci-local.sh` (gitleaks) | | สะอาด / ข้าม (ไม่มี gitleaks บนเครื่อง — ยืนยันจาก CI) |

- [ ] รัน `bash scripts/ci-local.sh` ผ่านก่อนเปิด PR แล้ว
- [ ] CI บน GitHub Actions เขียวครบ 5 ด่าน (ถ้า gate 5 ข้ามบนเครื่อง ให้ CI เป็นตัวยืนยัน)

## codex gate (กรอกเฉพาะแตะ auth/security/data — ถ้าไม่แตะให้เลือกข้อแรก)

- [ ] ไม่แตะ auth/security/data → ข้ามได้
- [ ] แตะ → codex gate ผ่านแล้ว: verdict **PASS** รอบที่ ____ (บันทึกใน PROJECT-STATE.md Decision Log)

## เช็คลิสต์ก่อนส่ง

- [ ] ไม่มี debug code ตกค้าง (`console.log` / `debugger` / `TODO` / `HACK`)
- [ ] ไม่มี secret/ค่าจริงในโค้ด — `SUPABASE_SERVICE_ROLE_KEY` เป็น server-only, ห้าม `NEXT_PUBLIC_` นำหน้า secret (SDS §5.1)
- [ ] ไม่มี PII ใน log (brief §8)
- [ ] อัปเดตเอกสารที่เกี่ยวข้องก่อนถ้ามีปัญหาเอกสาร (ผ่าน DCR — ไม่แก้โค้ดพร้อมแก้เอกสารเอง)
- [ ] เปลี่ยนแปลงแค่ไฟล์ใน ownership ของ task ตัวเอง
