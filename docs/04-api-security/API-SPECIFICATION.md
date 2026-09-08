# API Specification — LTC E-Learning (REST `/api/v1`)

|          |                                                    |
| -------- | -------------------------------------------------- |
| เวอร์ชัน | 0.2.0 — Wave A (deliverable 8) แก้ตาม A6 review: B-10, B-11, B-12, B-13, M-03, M-04 |
| วันที่    | 2026-09-08                                         |
| อ้างอิง  | PROJECT-BRIEF.md §5 (โดเมน), §6 (stack), §8 (security) · RBAC-DESIGN.md · AUDIT-LOG-DESIGN.md · SRS.md (Appendix A) |
| ขอบเขต  | Next.js Route Handlers ภายใต้ `/api/v1/*` (BFF) — Server Actions ที่ไม่ใช่ REST อยู่นอกเอกสารนี้ |

---

## 1. หลักการทั่วไป (binding)

1. **JSON เท่านั้น** — request/response เป็น `application/json; charset=utf-8` (ยกเว้นไฟล์ media ที่เสิร์ฟผ่าน Storage/CDN โดยตรง ไม่ผ่าน `/api/v1`)
2. **Authentication ผ่าน session (Supabase Auth)** — httpOnly cookie ที่ออกให้โดย BFF; frontend ไม่ถือ Supabase key ใด ๆ การเรียก Supabase ฝั่ง server ใช้ `service_role` เฉพาะใน BFF (บังคับตาม BRIEF §8)
3. **Authorization ตรวจที่ BFF ทุก request** — middleware `requirePermission()` ตรวจ permission (ไม่ใช่ตรวจ "ชื่อบทบาท" ตรง ๆ) ก่อนเข้า handler — คู่ขนานกับ RLS ที่ DB (defense in depth)
4. **zod validate ทุก input และ output** — query string, path params, body ผ่าน zod; response ขาออก validate ด้วย zod schema ก่อนส่ง (ป้องกัน PII/ฟิลด์รั่ว)
5. **Error envelope มาตรฐาน** — ทุก error ใช้รูปแบบเดียว `{ "error": { "code", "message", "details?" } }` โดย `message` เป็นภาษาไทยเสมอ (i18n-ready ตาม BRIEF §9.3)
6. **Pagination แบบ cursor-based** — ไม่ใช้ offset บนชุดข้อมูลใหญ่ (audit log, notifications, รายงาน)
7. **Versioning ที่ path** — `/api/v1`; breaking change = เปิด `/api/v1` เดิมคู่กับ `/api/v2` พร้อม header `Deprecation` + `Sunset` (ระยะเปลี่ยน ≥ 90 วัน, config)
8. **Idempotency-Key บังคับสำหรับ submit ข้อสอบ** — header `Idempotency-Key: <uuid>` ที่ client สร้าง; BFF เก็บผลลัพธ์ 24 ชม. (config) ต่อ (user, endpoint) — ยิงซ้ำได้โดยไม่สร้าง attempt ใหม่
9. **Rate limit ต่อ endpoint group** — ค่าเดียวต่อ endpoint ใช้ทุก environment (ดู §5) อ้างผ่าน config key ห้าม hardcode (BRIEF §6)
10. **ห้าม log PII ใน request/response** — email, เลขบัตรประชาชน, เลขที่ใบอนุญาต ห้ามปรากฏใน log/error `details` (BRIEF §8) — อ้างด้วย `user_id` เสมอ

### 1.1 Conventions

- **Method ใช้:** `GET` (อ่าน), `POST` (สร้าง/การกระทำ), `PATCH` (แก้บางฟิลด์), `PUT` (แทนที่ทั้งชุด — ใช้เฉพาะ `/me/license`), `DELETE` ใช้น้อยมาก (soft-delete เป็นหลัก)
- **Status codes:** `200` สำเร็จ · `201` สร้างใหม่ · `204` สำเร็จไม่มี body (ใช้เฉพาะ mark-read) · `400` validation · `401` ไม่ได้ login/session หมด · `403` ไม่มีสิทธิ์ · `404` ไม่พบ/ไม่เปิดเผยการมีอยู่ · `409` conflict/idempotency mismatch · `422` business rule · `429` rate limit · `500/503` ระบบ
- **เวลา:** ISO 8601 UTC (`2026-09-08T10:00:00Z`)
- **ID:** **UUID v4** ทุกตาราง (ตัดสินแล้ว M-04) — เหตุผล: เป็นค่า default ของ `gen_random_uuid()` บน PostgreSQL 15/Supabase, ไม่เปิดเผยลำดับการสร้าง (ต่างจาก v7/serial), รองรับทุก client; งานที่ต้องการ sort ใช้ cursor `(created_at, id)` แทน
- **ภาษา error:** ไทยหลัก อังกฤษรอง (เตรียม next-intl-style key)

### 1.2 Pagination (cursor-based)

Request: `?limit=20&cursor=<opaque-base64>`
Response wrapper ทุก list endpoint:

```json
{ "data": [ ... ], "page": { "nextCursor": "b3BhcXVl...", "hasMore": true } }
```

- `limit` สูงสุดต่อ endpoint กำหนดใน zod (default 20, max 100)
- cursor เข้ารหัสจาก (sort_key, id) — ผู้ใช้แกะ/ปลอมไม่ได้ (signed)

### 1.3 Error envelope

```json
{
  "error": {
    "code": "ERR-ASM-004",
    "message": "หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม",
    "details": { "attemptId": "uuid", "endedAt": "2026-09-08T10:00:00Z" }
  }
}
```

---

## 2. Error codes กลาง (ทุก endpoint ใช้ร่วม)

รหัสนำหน้าตามโดเมน `ERR-<DOMAIN>-<NNN>`; ข้อความไทยที่นี่คือ default ต้องเหมือนกันทุกจุดที่ใช้รหัสเดียวกัน (single source อยู่ที่ `lib/errors.ts` ในอนาคต)

| Code | HTTP | ข้อความ (ไทย) | เงื่อนไข |
| --- | --- | --- | --- |
| ERR-AUTH-001 | 401 | ต้องเข้าสู่ระบบก่อนใช้บริการนี้ | ไม่มี session / session หมดอายุ |
| ERR-AUTH-002 | 401 | อีเมลหรือรหัสผ่านไม่ถูกต้อง | login พลาด (ไม่บอกว่าฟิลด์ไหนผิด) |
| ERR-AUTH-003 | 423 | บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ภายหลัง | lockout หลังพลาด N ครั้ง (§5) |
| ERR-AUTH-004 | 403 | กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ | staff/super_admin ยังไม่ผ่าน MFA |
| ERR-AUTH-005 | 400 | ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุ | reset token invalid/expired |
| ERR-RBAC-001 | 403 | คุณไม่มีสิทธิ์ดำเนินการนี้ | ผ่าน auth แต่ไม่มี permission |
| ERR-VAL-001 | 400 | ข้อมูลที่ส่งมาไม่ถูกต้อง | zod ไม่ผ่าน, `details` มี field/path |
| ERR-VAL-002 | 400 | รูปแบบ Idempotency-Key ไม่ถูกต้อง | ไม่ใช่ UUID |
| ERR-NF-001 | 404 | ไม่พบข้อมูลที่ต้องการ | generic (ไม่เปิดเผยการมีอยู่) |
| ERR-RATE-001 | 429 | มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่ | พร้อม header `Retry-After` |
| ERR-IDM-001 | 409 | คำขอนี้ถูกประมวลผลแล้ว (Idempotency-Key ซ้ำแต่ body ต่าง) | key reuse + body mismatch |
| ERR-SYS-001 | 500 | เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่ | ไม่ leak stack |
| ERR-SYS-002 | 503 | ระบบไม่พร้อมให้บริการชั่วคราว | maintenance/DB down |
| ERR-PRF-001 | 422 | เลขที่ใบอนุญาตนี้ถูกผูกกับบัญชีอื่นแล้ว | license bind conflict |
| ERR-PRF-002 | 422 | เลขที่ใบอนุญาตไม่ผ่านการตรวจสอบรูปแบบ | รูปแบบไม่ตรง config |
| ERR-CRS-001 | 404 | ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่ | guest เห็นเฉพาะ published |
| ERR-ENR-001 | 409 | คุณลงทะเบียนหลักสูตรนี้แล้ว | duplicate enroll |
| ERR-ENR-002 | 422 | หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว | audience = lawyer-verified |
| ERR-LRN-001 | 403 | ต้องลงทะเบียนหลักสูตรก่อนเรียน | ไม่มี enrollment |
| ERR-LRN-002 | 422 | ยังเรียนบทก่อนหน้าไม่ครบตามเงื่อนไข | prerequisite |
| ERR-ASM-001 | 422 | คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว | max attempts (config Q2) |
| ERR-ASM-002 | 409 | มีการสอบที่ยังไม่จบอยู่แล้ว | active attempt exists |
| ERR-ASM-003 | 404 | ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว | window ปิด |
| ERR-ASM-004 | 422 | หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม | timeout |
| ERR-ASM-005 | 422 | บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว | attempt submitted |
| ERR-ASM-006 | 403 | คุณไม่ใช่เจ้าของรอบการสอบนี้ | attempt ของคนอื่น |
| ERR-CERT-001 | 404 | ไม่พบประกาศนียบัตรจากรหัสอ้างอิงนี้ | public verify (เฉพาะรหัสไม่มีจริง) |
| ERR-CERT-002 | 410 | ประกาศนียบัตรนี้ถูกลบออกจากระบบตามนโยบายการเก็บรักษาข้อมูล | retention purge — ใบที่ถูกเพิกถอน/แทนที่ **ไม่ใช่ 410** แต่ตอบ 200 + `status=revoked/superseded` (CRT-004) |
| ERR-CRD-001 | 422 | กฎเครดิตนี้มีผลใช้งานแล้ว แก้ไขต้องสร้างฉบับใหม่ | immutable active rule |
| ERR-CRD-002 | 422 | การปรับ credit ต้องระบุเหตุผล | reason required |
| ERR-ADM-001 | 403 | การกระทำนี้ต้องใช้สิทธิ์เจ้าหน้าที่ระดับสูงขึ้น | staff sub-role ไม่พอ |

---

## 3. Endpoints ตามโดเมน

สัญลักษณ์บทบาท: ระบุ explicit ตาม BRIEF §4 — `guest`(ไม่ auth), `citizen`, `lawyer`, `instructor`, `staff:viewer`, `staff:content`, `staff:exam`, `staff:registrar`, `super_admin`; "เจ้าของทรัพยากร" = owner. การ map บทบาท→permission อยู่ใน RBAC-DESIGN.md §2.

### 3.1 Auth (โดเมน Identity)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| POST | /auth/register | สมัครสมาชิก (email+รหัสผ่าน หรือ เบอร์มือถือ) | guest | 201 + ส่งอีเมลยืนยัน | VAL-001, RATE-001 |
| POST | /auth/login | เข้าสู่ระบบ (สร้าง session) | guest | 200 + `Set-Cookie` httpOnly | AUTH-002/003/004, RATE-001 |
| POST | /auth/logout | ออกจากระบบ (ทำลาย session) | ทุกบทบาทที่ login แล้ว | 204 | AUTH-001 |
| POST | /auth/mfa/enroll | เริ่มผูก MFA (สร้าง secret/QR) | ทุกบทบาท | 200 | AUTH-001 |
| POST | /auth/mfa/verify | ยืนยันรหัส TOTP เพื่อเปิดใช้ MFA | ทุกบทบาท | 200 | VAL-001 |
| POST | /auth/mfa/disable | ปิด MFA (staff ต้องมี super_admin อนุมัติ — นอก v1 ให้ block) | ทุกบทบาท | 200 | RBAC-001 |
| POST | /auth/password-reset/request | ขอลิงก์รีเซ็ตรหัสผ่าน (ตอบเหมือนกันทุกกรณี) | guest | 202 เสมอ | RATE-001 |
| POST | /auth/password-reset/confirm | ตั้งรหัสผ่านใหม่จาก token | guest | 200 | AUTH-005 |
| POST | /auth/verify | ยืนยันอีเมลจาก token (เปิดใช้บัญชี) | guest | 200 | AUTH-005 |
| POST | /auth/change-password | เปลี่ยนรหัสผ่าน (login อยู่ + รหัสเดิม) — audit `AUTH_PASSWORD_CHANGE` | ทุกบทบาทที่ login แล้ว | 200 | AUTH-002 |
| POST | /auth/otp/request | ขอ OTP ไปอีเมล/เบอร์มือถือ | guest | 202 (ไม่เปิดเผยว่ามีบัญชี) | RATE-001 |
| POST | /auth/otp/verify | ยืนยัน OTP (ช่วย login หรือผูกเบอร์) | guest | 200 | AUTH-002, RATE-001 |
| POST | /auth/logout-all | ออกจากระบบทุกอุปกรณ์ (revoke ทุก session) | ทุกบทบาทที่ login แล้ว | 204 | AUTH-001 |
| GET | /auth/mfa/backups | ขอ backup codes ชุดใหม่ (ชุดเก่าใช้ไม่ได้ทันที — ครั้งเดียวต่อการ enrolled) | ทุกบทบาทที่ login + MFA แล้ว | 200 | RBAC-001 |

หมายเหตุ: login สำเร็จ/ล้มเหลว → audit `AUTH_LOGIN_OK/FAIL` เสมอ (AUDIT-LOG-DESIGN.md)

### 3.2 Profile & License (โดเมน Identity & License)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /me | ข้อมูลโปรไฟล์ตัวเอง + บทบาทของตัวเอง | citizen, lawyer, instructor, staff:*, super_admin | 200 | AUTH-001 |
| PATCH | /me | แก้โปรไฟล์ (ชื่อ, เบอร์, ภาษา) — ฟิลด์ sensitive แยก endpoint | ทุกบทบาทที่ login แล้ว | 200 | VAL-001 |
| PUT | /me/license | ผูก/แทนที่เลขที่ใบอนุญาตว่าความ (ส่งเรื่องขอยืนยัน) | citizen, lawyer | 202 (รอเจ้าหน้าที่ตรวจ) | PRF-001/002 |
| GET | /me/credits | ยอด credit คงเหลือแยกตามรอบต่ออายุ | lawyer | 200 | AUTH-001 |
| GET | /me/transcript | transcript รายวิชา/ผลสอบ/credit ที่สะสม | citizen, lawyer | 200 | AUTH-001 |

PDPA endpoints (สิทธิของเจ้าของข้อมูล — วางใต้ `/profile/*` ตามที่ SRS/RTM อ้าง แยกจาก `/me/*` ที่เป็นข้อมูลสด):

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /profile/export | ขอส่งออกข้อมูลของตัวเอง (data portability — สร้าง job ส่งไฟล์ให้ตัวเอง) | ทุกบทบาทที่ login แล้ว | 202 (job) | RATE-001 |
| POST | /profile/delete | ขอลบบัญชี/ข้อมูลส่วนบุคคล (ตาม retention ที่กฎบังคับ — ผลสอบ/audit เก็บต่อ) | ทุกบทบาทที่ login แล้ว | 202 (รอยืนยันซ้ำทางอีเมล) | RATE-001 |
| GET | /profile/consents | ดูประวัติ consent ที่ให้ไว้ | ทุกบทบาทที่ login แล้ว | 200 | AUTH-001 |
| PATCH | /profile/consents | ให้/ถอน consent (เช่น รับข่าวสาร) | ทุกบทบาทที่ login แล้ว | 200 | VAL-001 |

### 3.3 Catalog & Enrollment (โดเมน 2)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /categories | รายการหมวดหลักสูตร (tree) | guest | 200 | RATE-001 |
| GET | /courses | ค้นหา/กรองหลักสูตร (หน้า catalog) — guest เห็นเฉพาะ `published` | guest | 200 + pagination | RATE-001 |
| GET | /courses/{id} | รายละเอียดหลักสูตร + โครงสร้างโมดูล (สถานะ draft มองเห็นเฉพาะเจ้าของ/staff:content) | guest, citizen, lawyer, instructor, staff:content | 200 | CRS-001 |
| POST | /courses/{id}/enroll | ลงทะเบียนเรียน | citizen, lawyer | 201 | ENR-001/002, RATE-001 |
| GET | /me/enrollments | รายการที่เรียน/ลงทะเบียนไว้ | citizen, lawyer | 200 + pagination | AUTH-001 |

### 3.4 Learning & Progress (โดเมน 3)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /courses/{id}/progress | สรุปความคืบหน้าของตัวเองในหลักสูตร (% ต่อโมดูล) | เจ้าของ enrollment | 200 | LRN-001 |
| POST | /lessons/{id}/progress | บันทึกความคืบหน้าบทเรียน (วิดีโอตำแหน่ง, อ่านจบ) | เจ้าของ enrollment | 200 | LRN-001/002 |
| POST | /lessons/{id}/quiz/submit | ส่งแบบทดสอบย่อย (ได้เฉลยทันที — ไม่นับ credit) | เจ้าของ enrollment | 200 (คะแนน+เฉลย) | LRN-001/002 |

### 3.5 Assessment (โดเมน 4 — การสอบ)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /assessments/{id} | อ่านข้อมูลการสอบ + กติกา (เวลา จำนวนครั้ง เกณฑ์ผ่าน) — **read-only เสมอ ไม่สร้าง attempt** (B-10) | citizen, lawyer, instructor, staff:exam | 200 | ASM-003, NF-001 |
| POST | /assessments/{id}/attempts | **เริ่มสอบ**: ตรวจเงื่อนไข → สร้าง attempt + ส่งข้อสอบ (สุ่มแล้ว) โดยไม่มีเฉลย | citizen, lawyer (ที่ผ่านเงื่อนไขจบหลักสูตร) | 201 attempt + ชุดข้อ + `serverTime` + `deadlineAt` | ASM-001/002/003 |
| GET | /me/attempts | ประวัติการสอบของตัวเองทุกหลักสูตร | citizen, lawyer | 200 + pagination | AUTH-001 |
| POST | /attempts/{id}/answers | บันทึกคำตอบทีละข้อ (autosave — เรียกบ่อย, idempotent ต่อ question) | เจ้าของ attempt | 200 (savedAt) | ASM-004/005/006 |
| POST | /attempts/{id}/submit | ส่งข้อสอบ — **ต้องมี `Idempotency-Key`**; ตรวจคะแนน server-side ทั้งหมด | เจ้าของ attempt | 200 (status=grading) หรือ ซ้ำ → คืนผลเดิม | ASM-004/005/006, VAL-002, IDM-001 |
| GET | /attempts/{id}/result | ผลสอบ + เฉลย (เปิดตาม config หลังสูตร) + credit ที่ได้ | เจ้าของ attempt | 200 | ASM-006, NF-001 |

Flow สอบ (sequence): `GET /assessments/{id}` อ่านกติกาก่อนได้ (read-only) → `POST /assessments/{id}/attempts` ตรวจสิทธิ์/จำนวนครั้ง/หน้าต่างสอบ → สร้าง attempt (`started_at`, `deadline_at = now + duration`) → client จับเวลาจาก `serverTime` ไม่ใช่นาฬิกาตัวเอง → autosave ทุกข้อ → `submit` (idempotent) → server ตรวจ → ถ้าผ่านเกณฑ์ → งานเบื้องหลังสร้างรายการรอออกประกาศนียบัตร (registrar ออกภายหลัง — separation of duties)

### 3.6 Certificate (โดเมน 4)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /certificates/{code} | **ตรวจสอบสาธารณะ** ไม่ต้อง auth — `{code}` ยอมรับทั้ง `cert_no` (พิมพ์มือ, D10) และ `verify_code` (จาก QR, nanoid — D10) — ตอบ **200 เสมอ** (CRT-004) ด้วย 4 ฟิลด์เท่านั้น: `{code, course_title, issued_at, status}` โดย `status ∈ valid \| revoked \| superseded` — **ไม่มีชื่อเจ้าของ** (ชื่อ-นามสกุลอยู่บน PDF ที่เจ้าของ/registrar ดาวน์โหลดเท่านั้น) | guest | 200 เสมอ | RATE-001 (410 ERR-CERT-002 เฉพาะใบที่ถูกลบตาม retention) |
| GET | /me/certificates | ประกาศนียบัตรของตัวเอง (พร้อมลิงก์ PDF) | citizen, lawyer | 200 + pagination | AUTH-001 |
| GET | /certificates/{id}/pdf | ดาวน์โหลด PDF ตัวจริง (id = uuid ต้อง auth — ต่างจาก public verify ที่ใช้ code) | เจ้าของใบรับรอง, staff:registrar, super_admin | 200 `application/pdf` | NF-001, RBAC-001 |
| POST | /admin/certificates | ออกประกาศนียบัติรายใบ (จาก attempt ที่ผ่านเกณฑ์) — audit `CERT_ISSUE` | staff:registrar, super_admin | 201 | RBAC-001, VAL-001 |
| POST | /admin/certificates/bulk | ออกเป็นชุด (รอบเดียวกัน) — 202 job + สรุปผลทาง notification | staff:registrar, super_admin | 202 (job) | RBAC-001 |
| POST | /admin/certificates/{id}/revoke | เพิกถอน (บังคับ reason) — audit `CERT_REVOKE` | staff:registrar, super_admin | 200 | RBAC-001, VAL-001 |
| POST | /admin/certificates/{id}/reissue | ออกใหม่แทนใบเดิม (ใบเดิมเปลี่ยน status=superseded) — CRT-007, audit `CERT_REISSUE` | staff:registrar, super_admin | 201 (ใบใหม่) | RBAC-001 |

### 3.7 Credit Bank — เจ้าหน้าที่ (โดเมน 5)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /credit-rules | รายการกฎเครดิต (มี version/สถานะ) | staff:registrar, staff:viewer, super_admin | 200 + pagination | RBAC-001 |
| POST | /credit-rules | สร้างกฎใหม่ (config-driven, อ้าง Q1) | staff:registrar, super_admin | 201 | CRD-001, VAL-001 |
| PATCH | /credit-rules/{id} | แก้กฎ (เฉพาะฉบับ draft; ฉบับ active สร้างใหม่แทน) | staff:registrar, super_admin | 200 | CRD-001 |
| GET | /users/{id}/credits | ยอด credit ของผู้ใช้รายคนตามรอบ (เข้าถึง PII → audit `PII_ACCESS`) | staff:registrar, staff:viewer, super_admin | 200 | RBAC-001 |
| POST | /credit-adjustments | ปรับ credit มือ (+/−) **ต้องมี reason + สร้าง audit + แจ้งเตือน super_admin** | staff:registrar, super_admin | 201 | CRD-002, RBAC-001 |

### 3.8 Admin (โดเมน 7)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /admin/users | ค้นหา/กรองผู้ใช้ (audit `PII_ACCESS`) | staff:viewer, staff:registrar, super_admin | 200 + pagination | RBAC-001 |
| POST | /admin/users | สร้างบัญชีเจ้าหน้าที่ (บังคับ MFA ตั้งแต่วันแรก) | super_admin | 201 | RBAC-001 |
| PATCH | /admin/users/{id} | แก้ข้อมูล/ปิดใช้งานบัญชี (soft-disable) | staff:registrar (ข้อมูลสมาชิก), super_admin (ทุกกรณี) | 200 | RBAC-001 |
| GET | /admin/roles | รายการบทบาท + คำอธิบายสิทธิ์ | staff:viewer, super_admin | 200 | RBAC-001 |
| POST | /admin/users/{id}/roles | มอบบทบาท (ทุกครั้ง → audit `ROLE_GRANT`) | super_admin; staff:registrar ได้เฉพาะ `lawyer` หลังยืนยันใบอนุญาต | 201 | RBAC-001 |
| DELETE | /admin/users/{id}/roles | ถอนบทบาท (audit `ROLE_REVOKE`) | เช่นเดียวกับด้านบน | 204 | RBAC-001 |
| GET | /admin/courses | ทุกหลักสูตรทุกสถานะ | staff:viewer, staff:content, super_admin | 200 | RBAC-001 |
| PATCH | /admin/courses/{id} | เปลี่ยนสถานะเผยแพร่ (publish/unpublish → audit `COURSE_PUBLISH`) | staff:content, super_admin | 200 | RBAC-001 |
| GET | /admin/question-banks | ภาพรวมธนาคารข้อสอบ | staff:exam, staff:viewer, super_admin | 200 | RBAC-001 |
| POST | /admin/question-banks | สร้างคลัง/นำเข้าข้อสอบ | instructor, staff:exam | 201 | RBAC-001, VAL-001 |
| PATCH | /admin/question-banks/{id}/questions/{qid} | แก้ข้อสอบ (version ใหม่ — ข้อที่ใช้แล้วอ่านอย่างเดียว) | instructor (เจ้าของ), staff:exam | 200 | RBAC-001 |
| GET | /admin/assessments | ชุดข้อสอบ/กติกาทุกชุด | staff:exam, staff:viewer, super_admin | 200 | RBAC-001 |
| POST | /admin/assessments | สร้างชุดข้อสอบ (กติกา: เวลา สุ่ม จำนวนครั้ง เกณฑ์ผ่าน — Q2) | staff:exam, super_admin | 201 | RBAC-001, VAL-001 |
| GET | /admin/reports/enrollments | รายงานการลงทะเบียน/การเรียน | staff:viewer, super_admin | 200 | RBAC-001 |
| GET | /admin/reports/assessments | รายงานผลสอบ | staff:exam, staff:viewer, super_admin | 200 | RBAC-001 |
| GET | /admin/reports/credits | รายงาน credit ตามรอบ | staff:registrar, staff:viewer, super_admin | 200 | RBAC-001 |
| GET | /admin/reports/{type}/export | ส่งออก CSV/JSON (audit `ADMIN_EXPORT`) — สูงสุดตาม §5 | staff:viewer, staff:registrar, super_admin (ตาม report) | 200 `text/csv` หรือ JSON | RBAC-001, RATE-001 |
| GET | /admin/audit-logs | อ่าน audit log (pagination + filter) — **อ่านอย่างเดียว ไม่มี endpoint แก้/ลบ** (BRIEF §8, D6) | staff:viewer, super_admin | 200 + pagination | RBAC-001 |
| GET | /admin/license-applications | รายการคำขอผูกเลขที่ใบอนุญาต (รอตรวจ/ตัดสินแล้ว) | staff:registrar, super_admin | 200 + pagination | RBAC-001 |
| PATCH | /admin/license-applications/{id} | ตัดสินคำขอ (อนุมัติ/ปฏิเสธ) — audit `LICENSE_VERIFY` + อนุมัติแล้วมอบบทบาท `lawyer` อัตโนมัติ (audit `ROLE_GRANT`) | staff:registrar, super_admin | 200 | RBAC-001, VAL-001 |
| GET | /admin/categories | หมวดหลักสูตรทุกสถานะ | staff:content, staff:viewer, super_admin | 200 | RBAC-001 |
| POST | /admin/categories | สร้างหมวด | staff:content, super_admin | 201 | RBAC-001, VAL-001 |
| PATCH | /admin/categories/{id} | แก้ชื่อ/เลิกใช้หมวด (มีหลักสูตรอ้างอยู่ห้ามลบ) | staff:content, super_admin | 200 | RBAC-001 |
| GET | /admin/exams/monitoring | มอนิเตอร์ attempt ที่กำลังสอบ (จำนวน/ค้างเกินเวลา/แยกตามหลักสูตร) | staff:exam, super_admin | 200 | RBAC-001 |
| GET | /admin/exams/statistics | สถิติผลสอบรวม (ผ่าน/ตก/คะแนนเฉลี่ย ต่อชุดข้อสอบ) | staff:exam, staff:viewer, super_admin | 200 | RBAC-001 |
| GET | /admin/dashboard | ตัวเลขสรุปหน้าแรก admin (แสดงตามสิทธิ์ของบทบาทที่ถือ) | staff:viewer, staff:content, staff:exam, staff:registrar, super_admin | 200 | RBAC-001 |

### 3.9 Notifications (โดเมน 6)

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /me/notifications | แจ้งเตือนในระบบของตัวเอง (unreadFirst + pagination) | ทุกบทบาทที่ login แล้ว | 200 | AUTH-001 |
| POST | /me/notifications/{id}/read | ทำเครื่องหมายอ่านแล้ว (idempotent) | เจ้าของ notification | 204 (ซ้ำก็ 204) | NF-001 |
| GET | /me/notification-settings | ตั้งค่าช่องทาง/ประเภทแจ้งเตือนของตัวเอง | ทุกบทบาทที่ login แล้ว | 200 | AUTH-001 |
| PATCH | /me/notification-settings | แก้การตั้งค่าแจ้งเตือน (in-app/email ต่อประเภท) | ทุกบทบาทที่ login แล้ว | 200 | VAL-001 |

### 3.10 System

| Method | Path | คำอธิบาย | บทบาท | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| GET | /api/health | liveness/readiness probe — **อยู่นอก prefix `/api/v1`** เพื่อไม่ผูกกับ version; ตอบ `{ status, db, time }` ไม่มีข้อมูลอื่น | guest | 200 | — (503 เมื่อ DB ไม่พร้อม) |

---

## 4. ตัวอย่าง Zod schemas (TypeScript — วางที่ `lib/schemas/v1/*.ts`)

```typescript
import { z } from "zod";

// 1) สมัครสมาชิก
export const RegisterRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),           // นโยบายรหัสผ่านเป็น config
  displayName: z.string().min(2).max(100),
  phone: z.string().regex(/^0\d{8,9}$/).optional(), // ไทย
  acceptConsent: z.literal(true),                    // PDPA consent บังคับ
});

// 2) เข้าสู่ระบบ
export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),      // มี MFA ต้องใส่
});

// 3) ผูกเลขที่ใบอนุญาต
export const LicenseBindRequest = z.object({
  licenseNumber: z.string().regex(/^\d{6,9}$/),      // รูปแบบจริงรอยืนยัน Q3
  issuedYear: z.number().int().min(2500).max(2600).optional(),
});

// 4) ลงทะเบียนหลักสูตร (path param)
export const EnrollParams = z.object({ courseId: z.string().uuid() });

// 5) บันทึกความคืบหน้าบทเรียน
export const LessonProgressRequest = z.object({
  positionSeconds: z.number().int().min(0).optional(), // วิดีโอ
  completed: z.boolean().optional(),
  documentRead: z.boolean().optional(),
}).refine((v) => v.positionSeconds !== undefined || v.completed !== undefined
             || v.documentRead !== undefined, { message: "ต้องส่งความคืบหน้าอย่างน้อยหนึ่งรายการ" });

// 6) ส่งแบบทดสอบย่อย
export const QuizSubmitRequest = z.object({
  answers: z.array(z.object({
    questionId: z.string().uuid(),
    choiceIds: z.array(z.string().uuid()).min(1).max(10),
  })).min(1).max(100),
});

// 7) บันทึกคำตอบสอบทีละข้อ
export const AnswerSaveRequest = z.object({
  questionId: z.string().uuid(),
  choiceIds: z.array(z.string().uuid()).min(1).max(10),
  clientSavedAt: z.string().datetime(),               // เทียบ deadline ที่ server เท่านั้น
});

// 8) ส่งข้อสอบ (Idempotency-Key อยู่ header ไม่ใช่ body)
export const AttemptSubmitRequest = z.object({
  unansweredQuestionIds: z.array(z.string().uuid()).max(500).default([]),
}).strict();

// 9) สร้างกฎเครดิต — mirror schema จริงของตาราง credit_rules ตาม DATA-DICTIONARY.md (M-03)
export const CreditRuleCreateRequest = z.object({
  code: z.string().regex(/^[A-Z0-9_]{3,32}$/),
  courseId: z.string().uuid().nullable(),          // FK courses.id (null = ใช้กับทุกหลักสูตรในหมวด)
  credits: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/)
    .refine((v) => parseFloat(v) > 0),             // numeric(6,2) ค่าเป็นบวกเท่านั้น
  validDays: z.number().int().min(1).max(3650),    // อายุ credit เป็น "วัน" (ไม่ใช่ปี)
  renewalCycle: z.enum(["LAWYER_STANDARD"]).default("LAWYER_STANDARD"), // รอ Q1
  effectiveFrom: z.string().date(),
});

// 10) ปรับ credit มือ
export const CreditAdjustmentRequest = z.object({
  userId: z.string().uuid(),
  renewalCycleId: z.string().uuid(),
  delta: z.number().int().refine((v) => v !== 0, { message: "delta ต้องไม่เป็น 0" }),
  reason: z.string().min(10).max(500),                // บังคับเหตุผล (ERR-CRD-002)
  evidenceUrl: z.string().url().optional(),
});

// 11) มอบบทบาท
export const RoleGrantRequest = z.object({
  role: z.enum(["citizen","lawyer","instructor","staff:viewer","staff:content",
                "staff:exam","staff:registrar","super_admin"]),
  reason: z.string().min(10).max(500),
});

// 12) Pagination กลาง (query ทุก list endpoint)
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
}).strict();

// 13) Response: ผลตรวจสาธารณะของประกาศนียบัตร (CRT-004) — 4 ฟิลด์เท่านั้น ไม่มีชื่อเจ้าของ
export const CertificatePublicView = z.object({
  code: z.string(),
  courseTitle: z.string(),
  issuedAt: z.string().datetime(),
  status: z.enum(["valid", "revoked", "superseded"]),
});

// 14) Error envelope ขาออก (validate ทุก error response)
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string().regex(/^ERR-[A-Z]+-\d{3}$/),
    message: z.string(),               // ไทย
    details: z.unknown().optional(),
  }),
});
```

---

## 5. Rate limit matrix

Key การนับ: guest = `ip + route-group`; login แล้ว = `user_id + route-group`. บังคับ 2 ชั้น: **Cloudflare WAF/rate rule (prod) + Next.js middleware (dev/สำรอง prod)** — **ค่าเดียวต่อ endpoint ใช้ทุก environment** (B-13) ปรับได้ที่ config key ใน `config/rate-limit.ts` (อ่านจาก env) ห้าม hardcode (BRIEF §6)

| Group | ใช้กับ (ตัวอย่าง) | หน้าต่าง | Default | Config key | เกิน → |
| --- | --- | --- | --- | --- | --- |
| AUTH | /auth/login, /auth/register, /auth/otp/* | 1 นาที | **10/min** (SRS Appendix A) | `RATE_LIMIT_AUTH_PER_MIN` | 429 + Retry-After |
| PWD_RESET | /auth/password-reset/* | 1 ชั่วโมง | 5/h | `RATE_LIMIT_PWD_RESET_PER_HOUR` | 429 |
| MFA | /auth/mfa/* | 1 นาที | 10/min | `RATE_LIMIT_MFA_PER_MIN` | 429 |
| PUBLIC_READ | /categories, /courses, /certificates/{code} | 1 นาที | 120/min | `RATE_LIMIT_PUBLIC_READ_PER_MIN` | 429 |
| READ | /me*, /profile/* | 1 นาที | 120/min | `RATE_LIMIT_READ_PER_MIN` | 429 |
| LEARN_WRITE | /lessons/*/progress, /lessons/*/quiz/submit | 1 นาที | 120/min | `RATE_LIMIT_LEARN_WRITE_PER_MIN` | 429 |
| EXAM | /assessments/*/attempts, /attempts/* | 1 นาที | 60/min | `RATE_LIMIT_EXAM_PER_MIN` | 429 (log WARN) |
| STAFF_WRITE | /admin/*, /credit-* | 1 นาที | 60/min | `RATE_LIMIT_STAFF_WRITE_PER_MIN` | 429 (audit) |
| EXPORT | /admin/reports/*/export, /profile/export | 1 ชั่วโมง | 10/h | `RATE_LIMIT_EXPORT_PER_HOUR` | 429 |

- ค่า EXAM 60/min ต่อคน รองรับเป้า 5,000 คนสอบพร้อมกัน (BRIEF §7) — สูงกว่าอัตรา autosave ที่ client ส่ง (throttle ที่ client 10 วินาที/ข้อ)
- 429 ทุกครั้ง → audit `RATE_LIMIT_HIT` (ระดับ WARN) เมื่อเป็นกลุ่ม STAFF_WRITE/EXAM

---

## 6. เปิดประเด็น (โยง Open Questions)

| ประเด็น | ผลกระทบ | สถานะ |
| --- | --- | --- |
| รูปแบบเลขที่ใบอนุญาตจริง | `LicenseBindRequest` regex | รอยืนยัน Q3 |
| จำนวนครั้งสอบ/เกณฑ์ผ่าน | ใช้ config ต่อ assessment ไม่กำหนดที่ API | รอยืนยัน Q2 |
| Proctoring อาจเพิ่ม endpoint (เช่น /attempts/{id}/events) | จะเป็น `/api/v1` additive — non-breaking | รอยืนยัน Q4 |
| รอบต่ออายุ+จำนวน credit | `CreditRuleCreateRequest.renewalCycle` enum | รอยืนยัน Q1 |

> เอกสารนี้เป็น part ของชุด `04-api-security/` — บทบาท↔permission ที่คอลัมน์ "บทบาท" อ้างถึง นิยามเต็มอยู่ที่ RBAC-DESIGN.md; event ที่กล่าวถึง (เช่น `COURSE_PUBLISH`) นิยามอยู่ที่ AUDIT-LOG-DESIGN.md
