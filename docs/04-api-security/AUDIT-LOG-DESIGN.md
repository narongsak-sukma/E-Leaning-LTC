# Audit Log Design — LTC E-Learning

|          |                                                 |
| -------- | ----------------------------------------------- |
| เวอร์ชัน | 1.0.0 — ผ่าน CTO gate (codex รอบ 5: PASS — D17) · แก้ตาม D11–D16 · baseline สำหรับ Wave B |
| วันที่    | 2026-09-09                                      |
| อ้างอิง  | PROJECT-BRIEF.md §5 (โดเมน 8), §8 (security), กฎ CTO D6 · RBAC-DESIGN.md (§3.1 canonical helpers) · API-SPECIFICATION.md · SRS.md (AUD-001–005) |

---

## 1. หลักการ (binding)

1. **Append-only สัมบูรณ์** — ห้าม UPDATE/DELETE/**TRUNCATE** ทุกกรณี ทุกบทบาท รวมถึง super_admin (D11-7); บังคับด้วย 3 ชั้น: DB privileges (REVOKE ครบ 3 คำสั่ง) + trigger กัน + ไม่มี API write path (มีแค่ `GET /admin/audit-logs`)
2. **บันทึก 5W** — ใคร (`actor_user_id` + snapshot `actor_roles`), ทำอะไร (`action` + `context`), กับอะไร (`entity_type` + `entity_id`), เมื่อไร (`occurred_at`), จากไหน (`request_id`, `ip_hash`) — ชื่อคอลัมน์ตาม DATA-DICTIONARY.md §3.8 เป็น canonical (D11-6)
3. **ไม่เก็บ PII โดยตรง** — อ้างคนด้วย `actor_user_id` (uuid) เท่านั้น; ห้ามใส่ email/เลขบัตรประชาชน/เลขที่ใบอนุญาต ลง `context`/`before`/`after` (BRIEF §8) — ถ้าจำเป็นต้องอ้าง ใช้ `entity_id`
4. **เขียนผ่าน `append_audit_event()` เท่านั้น (D11-8 + D12-8)** — function แบบ SECURITY DEFINER (owner = `app_owner`); EXECUTE ตาม contract เดียวของ §4 (**revoke จาก PUBLIC/anon ก่อน** แล้ว grant authenticated+service_role — D15-N1); **ห้าม direct INSERT แม้จาก `service_role`** (DD §4.4 REVOKE INSERT); client/anon เขียนไม่ได้ (RLS §4)
5. **Atomic กับ business mutation (D11-8)** — event ที่บันทึกการเปลี่ยนแปลงข้อมูลจริงต้องเขียน audit ใน **transaction เดียวกัน** กับ mutation — ถ้า audit ล้มเหลว = rollback ทั้งรายการ (fail-closed); event ที่ไม่ได้คู่กับ mutation (เช่น AUDIT_READ, PII_ACCESS, RATE_LIMIT_HIT, CERT_VERIFY_PUBLIC) อนุญาต async ได้ (กัน latency) แต่ต้องมี retry + dead-letter
6. **Tamper-evidence แบบ lightweight** — hash-chain ทุกแถว (§3.3) ไม่ใช้ external blockchain

---

## 2. Event Catalog

ระดับ: `INFO` (เกิดบ่อย ใช้สถิติ) · `NOTICE` (สำคัญ ตรวจสอบย้อนหลัง) · `WARN` (ผิดปกติ ควรดู) · `CRITICAL` (แจ้งเตือนทันที §6.3)
"PDPA" = ความเกี่ยวข้องกับการคุ้มครองข้อมูลส่วนบุคคล (สนับสนุน record-keeping ตาม BRIEF §8)
**ศัพท์↔คอลัมน์จริง (D11-6)** — ชื่อ event ใน catalog §2 (เช่น `AUTH_LOGIN_OK`) = ค่าของคอลัมน์ **`action`**; คอลัมน์ "หัวข้อหลักใน context" = เนื้อหาที่เขียนลง **`context` (jsonb)** (ส่วน diff ข้อมูลเขียนลง `before`/`after` — mask PII ก่อนเขียน ตาม DD §4.5); **DATA-DICTIONARY.md §3.8 เป็น canonical ของโครงสร้างตารางเสมอ**

### 2.1 Authentication & Session

| event_type | Actor ที่เป็นไปได้ | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| AUTH_REGISTER | guest | method(email/phone), user_agent | INFO | สร้างบันทึกการจัดเก็บข้อมูลสมาชิกใหม่ |
| AUTH_LOGIN_OK | ทุกบทบาท | session_id, mfa_used, ip_hash | INFO | การเข้าถึงระบบของเจ้าของข้อมูล |
| AUTH_LOGIN_FAIL | guest/ผู้ใช้ | สาเหตุ(รหัสผิด/MFA ผิด), ip_hash | NOTICE | ช่วยตรวจการเข้าถึงโดยไม่ได้รับอนุญาต |
| AUTH_LOGOUT | ทุกบทบาท | session_id, สาเหตุ(user/forced) | INFO | — |
| AUTH_MFA_ENROLLED | ทุกบทบาท | device_hint (ไม่เก็บ secret) | NOTICE | — |
| AUTH_MFA_DISABLED | ทุกบทบาท | ผู้ดำเนินการ, เหตุผล | WARN | ลดมาตรการรักษาความปลอดภัย |
| AUTH_MFA_BACKUPS_REGENERATED | ทุกบทบาท (MFA แล้ว) | จำนวนโค้ดชุดใหม่ (count), recent_mfa (boolean), user_agent, ip_hash | NOTICE | — (ไม่เก็บโค้ด) |
| AUTH_PASSWORD_RESET_REQUEST | guest | ip_hash (ไม่บอกว่ามีบัญชี) | NOTICE | — |
| AUTH_PASSWORD_RESET_DONE | ทุกบทบาท | ip_hash | NOTICE | การเปลี่ยนข้อมูลยืนยันตัวตน |
| AUTH_PASSWORD_CHANGE | ทุกบทบาท (login อยู่) | ผ่านทาง (ตัวเอง/reset), session_id | NOTICE | การเปลี่ยนข้อมูลยืนยันตัวตน (เติมตาม AUTH-005) |
| AUTH_LOCKOUT | ระบบ | จำนวนครั้งที่พลาด, ip_hash | WARN | — |
| AUTH_SESSION_REVOKE | ระบบ/super_admin | session_id, สาเหตุ (role เปลี่ยน/ถอนบทบาท) | NOTICE | — |

### 2.2 บทบาท / ผู้ใช้ / ใบอนุญาต

| action (ชื่อ event) | Actor | หัวข้อหลักใน context (jsonb) | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| ROLE_GRANT | super_admin, staff:registrar(บางส่วน) | target_user_id, role, reason, sod_exception | CRITICAL | การกำหนดสิทธิ์เข้าถึงข้อมูลบุคคล |
| ROLE_REVOKE | super_admin, staff:registrar(lawyer) | target_user_id, role, reason | CRITICAL | เช่นเดียวกัน |
| USER_CREATE | super_admin | target_user_id, บทบาทเริ่มต้น | NOTICE | การจัดเก็บข้อมูลสมาชิก/เจ้าหน้าที่ |
| USER_UPDATE | staff:registrar, super_admin | target_user_id, ฟิลด์ที่เปลี่ยน (ชื่อฟิลด์เท่านั้น ไม่ใส่ค่า PII เดิม/ใหม่) | NOTICE | สิทธิ์แก้ไขข้อมูลส่วนบุคคล |
| USER_DISABLE | super_admin | target_user_id, reason | WARN | จำกัดการเข้าถึง |
| LICENSE_BIND | citizen, lawyer | target_user_id, license_hash (hash เท่านั้น), สถานะ=pending | NOTICE | ข้อมูลส่วนบุคคล (วิชาชีพ) |
| LICENSE_VERIFY | staff:registrar | target_user_id, ผล(อนุมัติ/ปฏิเสธ), หลักฐานอ้างอิง | NOTICE | การยืนยันข้อมูลส่วนบุคคล |

### 2.3 เนื้อหา / การเรียน

| action (ชื่อ event) | Actor | หัวข้อหลักใน context (jsonb) | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| COURSE_CREATE | instructor, staff:content | course_id, title | INFO | — |
| COURSE_UPDATE | instructor(เจ้าของ), staff:content | course_id, ส่วนที่แก้ | INFO | — |
| COURSE_PUBLISH | staff:content, super_admin | course_id, ผู้อนุมัติ ≠ ผู้สร้าง (SoD ผ่าน) | NOTICE | — |
| COURSE_UNPUBLISH | staff:content | course_id, reason | NOTICE | — |
| COURSE_ARCHIVE | staff:content | course_id, reason | NOTICE | — |
| QB_QUESTION_CREATE | instructor, staff:exam | bank_id (FK question_banks.id — DD §3.4), จำนวนข้อ | INFO | — |
| QB_QUESTION_UPDATE | instructor, staff:exam | question_id, version | INFO | — |
| QB_QUESTION_DELETE | staff:exam, super_admin | question_id, เหตุผล, จำนวนชุดข้อสอบที่อ้างอยู่ (เติมตาม ASM-001) | NOTICE | — |
| ENROLL_CREATE | citizen, lawyer | course_id, user_id | INFO | — |
| LESSON_COMPLETED | ระบบ (trigger จาก progress) | lesson_id, user_id | INFO | — |
| QUIZ_SUBMIT | citizen, lawyer | lesson_id, user_id, คะแนน | INFO | — |

หมายเหตุ: **ไม่บันทึก** ทุก event `POST /lessons/{id}/progress` (ปริมาณสูงเกินคุณค่า) — เก็บเฉพาะ LESSON_COMPLETED เป็นหลักฐานความคืบหน้า

### 2.4 การสอบ / ประกาศนียบัตร

| action (ชื่อ event) | Actor | หัวข้อหลักใน context (jsonb) | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| ASSESSMENT_CONFIG_CHANGE | staff:exam, super_admin | assessment_id, ฟิลด์กติกาที่แก้, version | NOTICE | — |
| EXAM_ATTEMPT_START | citizen, lawyer | attempt_id, assessment_id, deadline_at | NOTICE | — |
| EXAM_SUBMIT | citizen, lawyer | attempt_id, จำนวนข้อที่ตอบ, submit_at vs deadline, idempotency_key | NOTICE | — |
| EXAM_TIME_LIMIT_EXCEED | ระบบ | attempt_id, ความล่าช้า (วินาที) | WARN | — |
| EXAM_SESSION_TAKEOVER | ระบบ (D12-21: ASM-011) | attempt_id, session_id เดิม→ใหม่, สาเหตุ (disconnect นานเกิน `exam_disconnect_grace_minutes` + lease_expires_at ครบ), ip_hash | WARN | — |
| EXAM_GRADE_OVERRIDE | staff:exam | attempt_id, คะแนนเดิม→ใหม่, reason | WARN | ผลกระทบต่อสิทธิ์ของบุคคล |
| CERT_ISSUE | staff:registrar | certificate_id, code, attempt_id, ผู้ออก | CRITICAL | การสร้างเอกสารเกี่ยวกับบุคคล |
| CERT_REVOKE | staff:registrar | certificate_id, reason | CRITICAL | เช่นเดียวกัน |
| CERT_REISSUE | staff:registrar | certificate_id เดิม → ใหม่, เหตุผล (ใบเดิมกลายเป็น superseded — เติมตาม CRT-007) | CRITICAL | เช่นเดียวกัน |
| CERT_VERIFY_PUBLIC | guest | code ที่ค้น, ip_hash, ผล(พบ/ไม่พบ) | INFO | บันทึกการเข้าถึงข้อมูลบุคคลแบบสาธารณะ (จำกัดฟิลด์) |

### 2.5 Credit Bank

| action (ชื่อ event) | Actor | หัวข้อหลักใน context (jsonb) | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| CREDIT_RULE_CREATE | staff:registrar, super_admin | rule_id, ค่ากฎ, effective_from | NOTICE | — |
| CREDIT_RULE_UPDATE | staff:registrar(draft), super_admin | rule_id, version | NOTICE | — |
| CREDIT_ACCRUAL | ระบบ — **เกิดตอนตรวจผ่าน (grading TX) ไม่ใช่ตอนออก cert** (D12-14) | ledger_id, user_id, จำนวน, rule_id, `source_type='assessment_attempt'`, attempt_id, เกณฑ์ตัดสินตามวันที่ผ่าน | NOTICE | คุณวุฒิของบุคคล |
| CREDIT_ADJUST | staff:registrar, super_admin | ledger_id, user_id, delta, reason, evidence | CRITICAL | การแก้ไขข้อมูลสิทธิ์โดยบุคคล |

### 2.6 การเข้าถึงข้อมูล / ระบบ

| action (ชื่อ event) | Actor | หัวข้อหลักใน context (jsonb) | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| PII_ACCESS | staff ทุกระดับ, super_admin | endpoint, target_user_id, จุดประสงค์(รายงาน/แก้ไข/ยืนยัน) | WARN | **หัวใจของ PDPA** — บันทึกการเข้าถึงข้อมูลส่วนบุคคล |
| ADMIN_EXPORT | staff ตามสิทธิ์ | report_type, จำนวนแถว, ตัวกรอง (ไม่ใส่ค่ากรองที่เป็น PII) | WARN | การเปิดเผยข้อมูลออกนอกระบบ |
| RATE_LIMIT_HIT | ระบบ | group, endpoint, ip_hash/user_id | WARN | — |
| NOTIFICATION_BULK_SEND | staff:registrar, super_admin | เทมเพลต, จำนวนผู้รับ, กลุ่มเป้าหมาย | NOTICE | การใช้ข้อมูลเพื่อการติดต่อ |
| AUDIT_READ | staff:viewer, super_admin | ตัวกรอง, จำนวนแถว | NOTICE | การเข้าถึงบันทึกตรวจสอบเอง |
| AUDIT_EXPORT | super_admin | ช่วงเวลา, จำนวนแถว, รูปแบบ | CRITICAL | ส่งออกบันทึกที่มีข้อมูลบุคคล |
| AUDIT_CHAIN_VERIFY | ระบบ (cron) | ผล (ok/broken ที่ id ใด), anchor ที่ใช้ | NOTICE (broken=CRITICAL) | พิสูจน์ความถูกต้องของบันทึก |

รวม **51 event types** (นับจากตาราง §2.1–2.6 — เพิ่ม AUTH_PASSWORD_CHANGE, QB_QUESTION_DELETE, CERT_REISSUE ตาม A6 review B-14; AUTH_MFA_BACKUPS_REGENERATED ตาม D11-12; EXAM_SESSION_TAKEOVER ตาม D12-21)

---

## 3. โครงสร้างข้อมูล

### 3.1 ตาราง `audit_logs` — โครงสร้าง canonical อยู่ที่ DATA-DICTIONARY.md §3.8 (D11-6)

เอกสารนี้ไม่นิยาม DDL ของตัวเองอีกต่อไป — คอลัมน์/index/RLS ยึด DD §3.8 เป็น canonical; จะเพิ่ม/แก้สคีมาทำผ่าน DCR ที่ DD เท่านั้น

| ศัพท์ในเอกสารนี้ | คอลัมน์จริง (DD §3.8 — canonical) |
| --- | --- |
| ชื่อ event ใน catalog §2 (เช่น `AUTH_LOGIN_OK`) | `action` (text NOT NULL) |
| actor | `actor_user_id` (uuid, NULL = ระบบ/ไม่ระบุตัวตน) + `actor_roles` (text[] snapshot) |
| entity | `entity_type` (text) + `entity_id` (uuid NULL) |
| payload | `context` (jsonb) + `before`/`after` (jsonb — mask PII ก่อนเขียน ตาม DD §4.5) |
| บริบทคำขอ | `occurred_at`, `request_id`, `ip_hash`, `user_agent` |

คอลัมน์ chain `prev_hash`/`row_hash` (§3.3) เป็นส่วนของ chain design นี้ — ต้องเพิ่มใน DD §3.8 ผ่าน DCR พร้อมตาราง `audit_chain_anchors` (D11-6)

### 3.2 Payload schema ราย event (zod — validate ก่อนเขียน, D11-9)

`context` ของแต่ละ event ใช้ **schema เฉพาะของ event นั้น (strict)** — ไม่มี schema กลางแบบ free-form; ฟรีเท็กซ์ (`reason`, `rejected_reason`) ต้องผ่าน `FreeText` เสมอ:

```typescript
// sanitize ฟรีเท็กซ์ — ใช้กับทุกฟรีเท็กซ์ฟิลด์ (reason, rejected_reason ฯลฯ) (D11-9 + D12-3 BLOCKER F9 + D13-F1)
// ตรวจ 2 รูปแบบแยกกัน (D13-F1): กฎตัวเลขตรวจบน normalized (ตัด whitespace/ขีด/จุด — กันหลุดด้วยการคั่น)
//   ส่วนอีเมลตรวจบนรูปที่ **คง "." ไว้** — regex อีเมลต้องเจอจุดของ domain จริง การ strip จุดก่อนตรวจทำให้อีเมลรอดทุกกฎ
const normalizeForDigits = (s: string) => s.replace(/[\s\-–—_.]/g, "");
const collapseForEmail = (s: string) => s.replace(/[\s\-–—]+/g, "");   // ตัดช่องว่าง/ขีดคั่น แต่คง "." ของ domain

const PII_RULES: Array<[RegExp, string, "digits" | "email"]> = [
  [/\d{13}/, "thai_national_id", "digits"],            // ตรวจก่อนเสมอ (สตริง 13 หลักจะกลืน license 6–9 หลัก)
  [/(?:\+66|66|0)\d{8,9}/, "phone", "digits"],         // 0XXXXXXXXX / +66XXXXXXXXX
  [/[\w.+-]+@[\w-]+\.[\w.]{2,}/, "email", "email"],    // บนข้อความที่คง "." — ไม่ strip จุด (D13-F1)
  [/\d{6,9}/, "license_no", "digits"],                 // หลังตัดขีด/ช่องว่าง — เลข 6–9 หลักตามรูปแบบใบอนุญาต
];

const FreeText = z.string()
  .transform((s) => s.trim().replace(/\s+/g, " "))      // sanitize ผิว: trim + ยุบช่องว่าง
  .pipe(z.string().max(500))                            // จำกัดความยาว
  .refine((v) => !PII_RULES.some(([re, , mode]) =>
      re.test(mode === "digits" ? normalizeForDigits(v) : collapseForEmail(v))),
    { message: "ฟรีเท็กซ์ห้ามมีรูปแบบ email / เบอร์โทร / เลขบัตร 13 หลัก / เลขใบอนุญาต 6–9 หลัก" });
// นโยบายเมื่อตรวจพบ (D12-3): BFF **ปฏิเสธ** (400 ERR-VAL-001 — ไม่เขียน raw ลง audit เด็ดขาด);
// กรณี event async ที่ต้องเขียนได้ต่อ (ไม่คู่ mutation, §1.5) → แทนที่ส่วนที่ตรวจพบด้วย `[redacted:<kind>]`
// และ mark `sanitized=true` ใน context — ห้ามเก็บค่าดิบทั้งสองกรณี

// ตัวอย่าง schema ราย event (strict) — ประกาศให้ครบทุก event ก่อน migration (Wave B)
const AUTH_LOGIN_OK = z.object({
  session_id: z.string().uuid(),
  mfa_used: z.boolean(),
}).strict();

const ROLE_GRANT = z.object({
  target_user_id: z.string().uuid(),
  role: z.enum(["citizen","lawyer","instructor","staff:viewer","staff:content",
                "staff:exam","staff:registrar","super_admin"]),
  reason: FreeText,                    // บังคับ — บันทึกเหตุผลของการมอบบทบาท
  sod_exception: z.boolean().default(false),
}).strict();

const CERT_REVOKE = z.object({
  certificate_id: z.string().uuid(),
  reason: FreeText,                    // บังคับ — เหตุผลการเพิกถอน
}).strict();

// D12-3 (BLOCKER F9): filters = **typed allowlist .strict()** — ห้าม field อื่นนอกชุดนี้
const AUDIT_READ = z.object({
  filters: z.object({
    actor_id: z.string().uuid().optional(),        // = คอลัมน์ actor_user_id (DD §3.8)
    action: z.enum([...]).optional(),              // enum รายการ action ที่มีจริงใน catalog §2 (เช่น AUTH_LOGIN_OK, ROLE_GRANT, CERT_ISSUE, CREDIT_ACCRUAL, EXAM_SESSION_TAKEOVER ฯลฯ)
    entity_type: z.enum([...]).optional(),         // ชื่อ entity ที่ใช้จริง (course, lesson, question_bank, question, assessment, attempt, certificate, credit_rule, credit_ledger, user, role, audit_log)
    entity_id: z.string().uuid().optional(),
    occurred_from: z.string().datetime().optional(),
    occurred_to: z.string().datetime().optional(),
  }).strict(),                                     // .strict() = ห้าม field อื่น (ปิดช่อง exfil ผ่าน filters)
  row_count: z.number().int().min(0),
}).strict();
```

กติกา (D11-9):

- ค่า PII เดิม-ใหม่เขียนลง `before`/`after` เป็น "ชื่อฟิลด์ที่เปลี่ยน" เท่านั้น (ไม่เก็บค่า) ตาม DD §4.5
- กรณี input ผ่าน schema ไม่ได้ → **ไม่เก็บ raw** — เก็บเฉพาะ `{ field, reason_code: "invalid_input", length, sha256_prefix8 }` (hash + ความยาวเท่านั้น)
- ทุก event ต้องมี schema ของตัวเอง — ไม่มี fallback ที่รับทุกอย่าง; เพิ่ม event ใหม่ = เพิ่ม schema คู่กัน (DCR)

### 3.3 Hash-chain (tamper-evidence แบบ lightweight)

```
row_hash = sha256( prev_hash
                 || id || occurred_at
                 || action || actor_user_id || canonical_json(actor_roles)
                 || entity_type || entity_id
                 || canonical_json(before) || canonical_json(after)   -- D12-7: hash ครบทุก evidentiary field
                 || canonical_json(context)
                 || ip_hash || user_agent || request_id )
```

- **ลำดับการไล่สาย (traversal): `(occurred_at, id)`** (D12-7) — prev_hash ของแถวแรกของสาย = anchor วันก่อนหน้า (`audit_chain_anchors.last_row_hash`); สายแรกของระบบ (genesis) ใช้ prev_hash = 40 ค่า 0; การไล่ตรวจเรียงตาม (occurred_at, id) เสมอ ไม่ใช้แค่ id (กันเวลา clock skew ข้าม node)

- การแทรก **serialize ด้วย `pg_advisory_xact_lock(hashtag)` ในฟังก์ชัน `append_audit_event()`** (SECURITY DEFINER — เขียนในนามเจ้าของ function จึงไม่ต้องมีสิทธิ์ direct INSERT สำหรับ caller, D11-8) — กัน chain แตกจาก concurrent write
- **ลำดับสาย = ลำดับ append เสมอ (D13-F3)**: ภายใต้ lock ฟังก์ชันอ่านแถวสุดท้ายของสายแล้วกำหนด `occurred_at = greatest(now(), prev.occurred_at + 1 microsecond)` — เพราะ `now()` คงที่ตลอด TX เดียวและ `id` เป็น UUID v4 สุ่ม (เรียงไม่ได้) การบังคับให้ `occurred_at` **strictly increasing** เป็นเงื่อนไขเดียวที่ทำให้ traversal `(occurred_at, id)` ตรงกับลำดับ append เป๊ะ (ไม่เกิด tie ที่ต้องใช้ id ตัดสิน) — verifier จึงไม่แจ้ง chain แตกเท็จจากหลาย event ใน TX เดียวกัน; เวลาเกิดเหตุจริงที่ต้องการความละเอียดสูงกว่านั้นเก็บแยกใน `context` ได้; anchor ปิดวันอ้างแถวสุดท้ายตามลำดับเดียวกันนี้
- **Anchor รายวัน**: cron job เก็บ `(day, last_id, last_row_hash)` ลงตาราง **`audit_chain_anchors`** (ตารางใหม่ที่ DATA-DICTIONARY.md เพิ่มให้ตาม D11-6 — append-only เช่นกัน) — anchor ใช้เทียบ/สืบสายต่อ
- **ตรวจสาย**: cron รายชั่วโมง ตรวจ 1,000 แถวล่าสุด; รายวัน ตรวจทั้งวันก่อนหน้า → เจอ mismatch = event `AUDIT_CHAIN_VERIFY` ระดับ CRITICAL + แจ้ง super_admin ทันที
- ข้อจำกัดที่ยอมรับ: ป้องกันการแก้แอบ (แก้แล้ว row_hash ไม่ตรงเดิม สายขาดและถูกจับได้) แต่ผู้ที่ลบ "ทั้งเส้น + สร้าง chain ใหม่" พร้อม anchor ปลอมตรวจไม่ได้ 100% — บรรเทาด้วยสิทธิ์ DB แคบ (§4) + anchor export ออกนอก DB เดือนละครั้ง (เก็บที่ object storage เขียนครั้งเดียว)

---

## 4. การบังคับ append-only (3 ชั้น)

```sql
-- ชั้น 1: DB privileges (D11-7 + D12-8) — ครบทั้ง UPDATE/DELETE/TRUNCATE + INSERT ตรง DD §4.4
revoke update, delete, truncate on public.audit_logs
  from anon, authenticated, service_role;
revoke insert on public.audit_logs from anon, authenticated, service_role; -- D12-8: เขียนผ่าน append_audit_event() เป็น path เดียว
grant select on public.audit_logs to authenticated; -- อ่านผ่าน RLS

-- D13-F4 + D15-N1: contract เดียวของการเขียน audit (ปิดความขัดแย้ง AUDIT↔DD↔flow):
--   INSERT ตรงถูกถอนจากทุก role (ด้านบน) — EXECUTE บน append_audit_event() คือสิทธิ์เดียวที่ caller ต้องมี
--   (SECURITY DEFINER เปลี่ยนแค่ privilege ของเนื้อในฟังก์ชัน ไม่ข้ามการตรวจ EXECUTE — ผู้เรียกต้องถูก grant จริง)
--   PG15 ให้ EXECUTE แก่ PUBLIC โดย default บน function ใหม่ → ต้อง revoke ก่อน grant ใน TX เดียวกัน (D15-N1)
revoke execute on function public.append_audit_event(text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  from public, anon;               -- ตัดสิทธิ์ default ของ PUBLIC — เหลือเฉพาะสอง role ด้านล่างเรียกได้ (D15-N1)
grant execute on function public.append_audit_event(text, text, text, jsonb, jsonb, jsonb, jsonb, text, text, text)
  to authenticated, service_role;  -- authenticated = BFF เรียก RPC ด้วย user JWT (§6.2 — เฉพาะ event class ข); service_role = jobs + write paths
-- ฟังก์ชันตรวจเองภายในทุกครั้งก่อนเขียน: actor ต้อง valid (auth.uid() ของ session นั้น / job token),
-- payload ต้องผ่าน schema ราย event (§3.2), chain sequence ภายใต้ advisory lock (§3.3) — ไม่ผ่าน = RAISE/rollback ทั้ง TX
--
-- D15-N1 (ความจริงของ event ไม่ใช่แค่ลำดับ): hash-chain รับรอง "ลำดับ" ไม่รับรอง "ความจริง" — แบ่ง path ตาม class ของ event:
--   (ก) event ที่คู่ business mutation (ROLE_GRANT, CERT_ISSUE/REVOKE/REISSUE, CREDIT_ADJUST, EXAM_GRADE_OVERRIDE, USER_* ฯลฯ)
--       เขียนได้จาก server path เท่านั้น: ภายใน SECURITY DEFINER write functions (DD §4.7 — ตรวจสิทธิ์ใน TX จริงแล้ว
--       derive actor/roles/ผลลัพธ์จาก server ไม่รับจาก payload ของ caller) หรือ BFF service_role call (key ไม่ออกจาก server)
--       — user-JWT generic RPC เรียก class นี้ไม่ได้ (allowlist ด้านล่างตัด)
--   (ข) event ที่ไม่คู่ mutation เชิงสังเกต/ระบบ (CERT_VERIFY_PUBLIC, AUDIT_READ, RATE_LIMIT_HIT, PII_ACCESS, AUTH_*)
--       เรียก RPC ด้วย user JWT ได้ ตาม allowlist ราย event ที่นิยามในฟังก์ชัน; actor derive จาก auth.uid() ของ session
--       และ request_id/ip_hash มาจาก middleware header เท่านั้น — ฟิลด์อ้างตัวตนใน payload ถูก override ฝั่ง server เสมอ
--       R5-m1 (ผูก producer ราย event — ไม่ใช่ wildcard): AUTH_* ทั้งชุด = **BFF เท่านั้น** (trusted server) ในฐานะผู้บันทึก
--       "ผลที่สังเกตได้" ของ Supabase Auth/คำขอที่ผ่าน BFF ไปแล้ว — ครบทุก event ของ §2.1 (AUTH_REGISTER/LOGIN_OK/LOGIN_FAIL/
--       LOGOUT/MFA_ENROLLED/MFA_DISABLED/MFA_BACKUPS_REGENERATED/PASSWORD_RESET_REQUEST/PASSWORD_RESET_DONE/PASSWORD_CHANGE/
--       LOCKOUT/SESSION_REVOKE); การเปลี่ยนสถานะจริงของบัญชี (เช่น MFA ในระบบ Auth) เกิดที่ Supabase Auth ก่อน แล้ว BFF
--       จึงบันทึกผลตามลำดับ — ไม่ใช่ mutation ใน DB ของแอป จึงไม่ต้อง atomic กับ TX ธุรกิจ (ตาม §1.5 async + retry)

-- ชั้น 2: trigger บล็อกแม้ superuser/owner (ยกเว้น migration ที่ drop trigger อย่างชัดเจน)
create or replace function public.prevent_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs: append-only — UPDATE/DELETE/TRUNCATE ถูกห้าม (BRIEF §8, D6, D11-7)';
end $$;
create trigger trg_audit_immutable_rows
  before update or delete on public.audit_logs
  for each row execute function public.prevent_audit_mutation();
create trigger trg_audit_immutable_truncate
  before truncate on public.audit_logs
  for each statement execute function public.prevent_audit_mutation(); -- row trigger ไม่ยิงบน TRUNCATE

-- ชั้น 3: RLS — อ่านตามบทบาท; เขียนไม่มี path ใด ๆ (D11-8)
-- ใช้ canonical helper set จาก RBAC-DESIGN.md §3.1 (B-02): my_roles() / has_any_role() / is_staff()
create policy audit_read_admin on public.audit_logs for select to authenticated
  using (public.has_any_role(array['staff:viewer','super_admin']));
create policy audit_read_self on public.audit_logs for select to authenticated
  using (actor_user_id = auth.uid()); -- ชื่อคอลัมน์ตาม DD §3.8 (D11-6)
```

- **ชั้นที่ 4 โดยการออกแบบ API**: ไม่มี route แก้/ลบ audit เลย (ทดสอบ T14/T16 ใน RBAC-DESIGN.md §6)
- การอ่านของตัวเอง (`audit_read_self`) = สิทธิ์ "ดู activity ของตัวเอง" สนับสนุนสิทธิ์เข้าถึงข้อมูลของเจ้าของข้อมูลตาม PDPA
- ทุกการอ่านของ staff → event `AUDIT_READ` (สังเกต activity ที่ใช้ดู activity)

---

## 5. Retention & Export — canonical อยู่ที่ DATA-DICTIONARY.md §4.6 (D12-18)

นโยบาย retention ประกาศที่เดียว (DD §4.6) — เอกสารนี้**ไม่ประกาศค่าซ้ำ**; สาระสำคัญที่ผูกกับกลไกของเอกสารนี้:

- audit_logs = 5 ปี · security_events = 1 ปี · audit_chain_anchors = ถาวร (ค่าตาม DD §4.6 — config `audit_retention_years=5`)
- **purge ใช้ `purge_role`** (บทบาทเฉพาะ — ไม่ใช่ service_role ของแอป, D12-18) ทำงาน**หลัง export สำเร็จ** (export-then-purge) + audit ทุกครั้ง (CRITICAL)
- learning records ที่ถูก certificate อ้างอิง = **anonymize ไม่ลบ** (ตาม DD §4.6 — D12-18)
- Export: `super_admin` ผ่านเส้นทางที่ CTO อนุมัติแยกต่างหาก (เช่น คำขอเป็นลายลักษณ์อักษร) → CSV/JSON, บันทึก `AUDIT_EXPORT` (CRITICAL), rate limit กลุ่ม EXPORT (API-SPECIFICATION.md §5)
- การเข้าถึงของเจ้าของข้อมูล: ผู้ใช้ดู activity ตัวเองผ่าน `audit_read_self` (§4 — ไม่ต้องรอเจ้าหน้าที่)

---

## 6. การแจ้งเตือน event อันตราย

### 6.1 กฎการแจ้ง (ประเมินที่ BFF หลังเขียน audit สำเร็จ)

| เงื่อนไข | ผู้รับแจ้งเตือน | ช่องทาง |
| --- | --- | --- |
| event ระดับ CRITICAL (ROLE_GRANT, CERT_ISSUE/REVOKE, CREDIT_ADJUST, AUDIT_EXPORT) | super_admin ทุกบัญชี | notification ในระบบ + อีเมลทันที |
| AUTH_LOGIN_FAIL ≥ 20/ชม. จาก ip_hash เดียว | super_admin | สรุปรายชั่วโมง |
| AUTH_LOCKOUT ของบัญชี staff | super_admin + เจ้าของบัญชี | ทันที |
| AUDIT_CHAIN_VERIFY = broken | super_admin + ช่องทางเตือนภัย (เช่น webhook ภายนอกที่ config) | ทันที — ต้องสอบสวนก่อนทำอย่างอื่น |
| EXAM_TIME_LIMIT_EXCEED > 60 วินาที ต่อ attempt | staff:exam | สรุปรายวัน |

### 6.2 การตรวจสอบไหล (สรุป)

1. BFF handler → เขียน audit **ภายใน transaction เดียวกับ business mutation** (D11-8): event ที่คู่ mutation (class ก) ถูกเขียนใน write path/business function ที่ตรวจสิทธิ์แล้ว ซึ่ง derive actor/roles/ผลลัพธ์จาก server (D15-N1(ก)); event ที่ไม่คู่ mutation (class ข) เรียก RPC ตรงด้วย user JWT ได้ตาม allowlist (§4) — ทั้งสอง path validate `context` ด้วย schema ราย event (§3.2) + คำนวณ chain
2. **Atomic (D11-8)**: mutation + audit commit พร้อมกัน — ถ้า audit ล้มเหลว = rollback ทั้งรายการ (fail-closed; response = ERR-SYS-002 สำหรับ action อันตราย); event ที่ไม่คู่กับ mutation ยกเว้นได้ตาม §1.5
3. cron: anchor รายวัน (เขียน `audit_chain_anchors`) + verify รายชั่วโมง/รายวัน + สรุปแจ้งเตือน
4. retention job (เมื่อเปิดใช้) ทำงานหลัง export เท่านั้น

---

## 7. Mapping: ความต้องการ SRS (AUD-001–AUD-005) — มุมมองแบบคุณสมบัติของระบบ

ความต้องการ audit ของ SRS ไม่ได้แบ่งตามหมวด event แต่เป็น **คุณสมบัติ 5 ข้อของระบบ audit โดยรวม** — การ map จึงเป็นแบบ property-based ไม่ใช่การจัดกลุ่ม event เข้าหมวด

**AUD-001 — บันทึก audit ทุก action สำคัญ (coverage mandate):** event ทั้ง **51 ชนิดใน catalog §2 (§2.1–§2.6)** ตอบโจทย์นี้ร่วมกันทั้งหมด — ไม่มี event ใดออกนอก mandate และไม่มี action สำคัญใด (ตามนิยาม §2) ที่ไร้ event รองรับ; การเพิ่ม action สำคัญใหม่ = เพิ่ม event type ใน catalog โดยอ้าง AUD-001 ผ่าน DCR

**AUD-002…AUD-005 — คุณสมบัติระดับระบบ พิสูจน์ที่กลไก (ไม่ใช่ที่ตัว event):**

| REQ | ความต้องการ (SRS) | พิสูจน์/บังคับที่ไหน |
| --- | --- | --- |
| AUD-002 | บังคับ append-only (คุณสมบัติของ storage) | §4 สามชั้น: (1) `REVOKE UPDATE, DELETE, TRUNCATE` (D11-7) (2) trigger `prevent_audit_mutation()` บล็อกแม้ owner/superuser (row + statement TRUNCATE trigger) (3) RLS — เขียนผ่าน `append_audit_event()` SECURITY DEFINER เท่านั้น (D11-8) + ไม่มี write API เลย (RBAC-DESIGN.md §6 T14/T16) |
| AUD-003 | ค้นหา/กรอง audit โดยเจ้าหน้าที่ | §3.1 ดัชนีตาม DD §3.8: `(action, occurred_at)` / `(actor_user_id, occurred_at)` / `(entity_type, entity_id, occurred_at)` + `GET /api/v1/admin/audit-logs` (API-SPECIFICATION.md §3.8 — pagination + filter) สิทธิ์ staff:viewer/super_admin ตาม RLS §4 — ทุกการอ่านของ staff เกิด event `AUDIT_READ` |
| AUD-004 | ไม่บรรจุ PII ใน payload (กติกาต่อทุก event) | §3.2 กติกา payload: schema ราย event (strict) + `FreeText` sanitize (ความยาวจำกัด + ห้ามรูปแบบ email/เบอร์โทร/เลขบัตร, D11-9) + input ผิดเก็บเฉพาะ hash/ความยาว + เก็บเฉพาะ "ชื่อฟิลด์ที่เปลี่ยน" ไม่ใช่ค่าเดิม/ใหม่ + §3.1 อ้างคนด้วย `actor_user_id` (uuid, ตาม DD §3.8), `ip_hash` ไม่เก็บ IP ตรง + คอลัมน์ PDPA กำกับทุก event ใน §2 |
| AUD-005 | retention ≥ 5 ปี | §5 นโยบาย retention: default 5 ปี (config `AUDIT_RETENTION_YEARS`, ตาม SRS Appendix A), v1 ไม่มีการลบอัตโนมัติจนกว่าจะมีมติ, ก่อนลบต้อง export สำเนา (export-then-purge + CRITICAL event) |

กฎ (คงเดิมจาก B-14): **ห้ามตั้งรหัส AUD-006+ เพิ่มเอง** — ความต้องการใหม่ต้องไปเพิ่มที่ SRS ผ่าน DCR ก่อน แล้วจึงขยาย catalog §2 หรือกลไกในตารางนี้

---

## 8. เปิดประเด็น

| ประเด็น | สถานะ |
| --- | --- |
| ระยะเก็บ audit ที่สภาฯ ต้องการจริง (5 ปี ที่เสนอ) | รอยืนยันกับ policy สภาฯ + PDPA retention |
| แจ้งเตือน CRITICAL ออกอีเมลภายนอก ผ่าน provider ใด | ผูกกับระบบ notification โดเมน 6 — ตัดสิน Wave C |
| ปริมาณ LESSON_COMPLETED/QUIZ_SUBMIT ที่ระดับ 100,000 ผู้ใช้ อาจต้อง sampling เพิ่ม | วัดจริงช่วง load test แล้ว DCR |
| ชื่อ entity_type ต้องตรงกับ DATA-DICTIONARY.md (worker-3) | ประสานก่อน Wave A gate |
