# Audit Log Design — LTC E-Learning

|          |                                                 |
| -------- | ----------------------------------------------- |
| เวอร์ชัน | 0.1.0 — Wave A (deliverable 10)                 |
| วันที่    | 2026-09-08                                      |
| อ้างอิง  | PROJECT-BRIEF.md §5 (โดเมน 8), §8 (security), กฎ CTO D6 · RBAC-DESIGN.md · API-SPECIFICATION.md |

---

## 1. หลักการ (binding)

1. **Append-only สัมบูรณ์** — ห้าม UPDATE/DELETE ทุกกรณี ทุกบทบาท รวมถึง super_admin; บังคับด้วย 3 ชั้น: DB privileges (REVOKE) + trigger กัน + ไม่มี API write path (มีแค่ `GET /admin/audit-logs`)
2. **บันทึก 5W** — ใคร (actor), ทำอะไร (event_type + payload), กับอะไร (entity), เมื่อไร (occurred_at), จากไหน (request_id, session, ip_hash)
3. **ไม่เก็บ PII โดยตรง** — อ้างคนด้วย `actor_id` (uuid) เท่านั้น; ห้ามใส่ email/เลขบัตรประชาชน/เลขที่ใบอนุญาต ลง payload (BRIEF §8) — ถ้า payload จำเป็นต้องอ้าง ใช้ entity_id
4. **เขียนโดย BFF เท่านั้น** — ผ่าน `service_role`; client/anon เขียนไม่ได้ (RLS §5)
5. **เก็บก่อนตอบ** — event ระดับ WARN/CRITICAL ต้องเขียน audit สำเร็จก่อนส่ง response กลับ (fail-closed); ระดับ INFO อนุญัติให้เขียนแบบ async ได้ (กัน latency ตอนเรียน) แต่ต้องมี retry + dead-letter
6. **Tamper-evidence แบบ lightweight** — hash-chain ทุกแถว (§3.2) ไม่ใช้ external blockchain

---

## 2. Event Catalog

ระดับ: `INFO` (เกิดบ่อย ใช้สถิติ) · `NOTICE` (สำคัญ ตรวจสอบย้อนหลัง) · `WARN` (ผิดปกติ ควรดู) · `CRITICAL` (แจ้งเตือนทันที §6.3)
"PDPA" = ความเกี่ยวข้องกับการคุ้มครองข้อมูลส่วนบุคคล (สนับสนุน record-keeping ตาม BRIEF §8)

### 2.1 Authentication & Session

| event_type | Actor ที่เป็นไปได้ | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| AUTH_REGISTER | guest | method(email/phone), user_agent | INFO | สร้างบันทึกการจัดเก็บข้อมูลสมาชิกใหม่ |
| AUTH_LOGIN_OK | ทุกบทบาท | session_id, mfa_used, ip_hash | INFO | การเข้าถึงระบบของเจ้าของข้อมูล |
| AUTH_LOGIN_FAIL | guest/ผู้ใช้ | สาเหตุ(รหัสผิด/MFA ผิด), ip_hash | NOTICE | ช่วยตรวจการเข้าถึงโดยไม่ได้รับอนุญาต |
| AUTH_LOGOUT | ทุกบทบาท | session_id, สาเหตุ(user/forced) | INFO | — |
| AUTH_MFA_ENROLLED | ทุกบทบาท | device_hint (ไม่เก็บ secret) | NOTICE | — |
| AUTH_MFA_DISABLED | ทุกบทบาท | ผู้ดำเนินการ, เหตุผล | WARN | ลดมาตรการรักษาความปลอดภัย |
| AUTH_PASSWORD_RESET_REQUEST | guest | ip_hash (ไม่บอกว่ามีบัญชี) | NOTICE | — |
| AUTH_PASSWORD_RESET_DONE | ทุกบทบาท | ip_hash | NOTICE | การเปลี่ยนข้อมูลยืนยันตัวตน |
| AUTH_LOCKOUT | ระบบ | จำนวนครั้งที่พลาด, ip_hash | WARN | — |
| AUTH_SESSION_REVOKE | ระบบ/super_admin | session_id, สาเหตุ (role เปลี่ยน/ถอนบทบาท) | NOTICE | — |

### 2.2 บทบาท / ผู้ใช้ / ใบอนุญาต

| event_type | Actor | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| ROLE_GRANT | super_admin, staff:registrar(บางส่วน) | target_user_id, role, reason, sod_exception | CRITICAL | การกำหนดสิทธิ์เข้าถึงข้อมูลบุคคล |
| ROLE_REVOKE | super_admin, staff:registrar(lawyer) | target_user_id, role, reason | CRITICAL | เช่นเดียวกัน |
| USER_CREATE | super_admin | target_user_id, บทบาทเริ่มต้น | NOTICE | การจัดเก็บข้อมูลสมาชิก/เจ้าหน้าที่ |
| USER_UPDATE | staff:registrar, super_admin | target_user_id, ฟิลด์ที่เปลี่ยน (ชื่อฟิลด์เท่านั้น ไม่ใส่ค่า PII เดิม/ใหม่) | NOTICE | สิทธิ์แก้ไขข้อมูลส่วนบุคคล |
| USER_DISABLE | super_admin | target_user_id, reason | WARN | จำกัดการเข้าถึง |
| LICENSE_BIND | citizen, lawyer | target_user_id, license_hash (hash เท่านั้น), สถานะ=pending | NOTICE | ข้อมูลส่วนบุคคล (วิชาชีพ) |
| LICENSE_VERIFY | staff:registrar | target_user_id, ผล(อนุมัติ/ปฏิเสธ), หลักฐานอ้างอิง | NOTICE | การยืนยันข้อมูลส่วนบุคคล |

### 2.3 เนื้อหา / การเรียน

| event_type | Actor | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| COURSE_CREATE | instructor, staff:content | course_id, title | INFO | — |
| COURSE_UPDATE | instructor(เจ้าของ), staff:content | course_id, ส่วนที่แก้ | INFO | — |
| COURSE_PUBLISH | staff:content, super_admin | course_id, ผู้อนุมัติ ≠ ผู้สร้าง (SoD ผ่าน) | NOTICE | — |
| COURSE_UNPUBLISH | staff:content | course_id, reason | NOTICE | — |
| COURSE_ARCHIVE | staff:content | course_id, reason | NOTICE | — |
| QB_QUESTION_CREATE | instructor, staff:exam | question_bank_id, จำนวนข้อ | INFO | — |
| QB_QUESTION_UPDATE | instructor, staff:exam | question_id, version | INFO | — |
| ENROLL_CREATE | citizen, lawyer | course_id, user_id | INFO | — |
| LESSON_COMPLETED | ระบบ (trigger จาก progress) | lesson_id, user_id | INFO | — |
| QUIZ_SUBMIT | citizen, lawyer | lesson_id, user_id, คะแนน | INFO | — |

หมายเหตุ: **ไม่บันทึก** ทุก event `POST /lessons/{id}/progress` (ปริมาณสูงเกินคุณค่า) — เก็บเฉพาะ LESSON_COMPLETED เป็นหลักฐานความคืบหน้า

### 2.4 การสอบ / ประกาศนียบัตร

| event_type | Actor | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| ASSESSMENT_CONFIG_CHANGE | staff:exam, super_admin | assessment_id, ฟิลด์กติกาที่แก้, version | NOTICE | — |
| EXAM_ATTEMPT_START | citizen, lawyer | attempt_id, assessment_id, deadline_at | NOTICE | — |
| EXAM_SUBMIT | citizen, lawyer | attempt_id, จำนวนข้อที่ตอบ, submit_at vs deadline, idempotency_key | NOTICE | — |
| EXAM_TIME_LIMIT_EXCEED | ระบบ | attempt_id, ความล่าช้า (วินาที) | WARN | — |
| EXAM_GRADE_OVERRIDE | staff:exam | attempt_id, คะแนนเดิม→ใหม่, reason | WARN | ผลกระทบต่อสิทธิ์ของบุคคล |
| CERT_ISSUE | staff:registrar | certificate_id, code, attempt_id, ผู้ออก | CRITICAL | การสร้างเอกสารเกี่ยวกับบุคคล |
| CERT_REVOKE | staff:registrar | certificate_id, reason | CRITICAL | เช่นเดียวกัน |
| CERT_VERIFY_PUBLIC | guest | code ที่ค้น, ip_hash, ผล(พบ/ไม่พบ) | INFO | บันทึกการเข้าถึงข้อมูลบุคคลแบบสาธารณะ (จำกัดฟิลด์) |

### 2.5 Credit Bank

| event_type | Actor | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| CREDIT_RULE_CREATE | staff:registrar, super_admin | rule_id, ค่ากฎ, effective_from | NOTICE | — |
| CREDIT_RULE_UPDATE | staff:registrar(draft), super_admin | rule_id, version | NOTICE | — |
| CREDIT_GRANT | ระบบ (หลังสอบผ่าน) | ledger_id, user_id, จำนวน, rule_id, attempt_id | NOTICE | คุณวุฒิของบุคคล |
| CREDIT_ADJUST | staff:registrar, super_admin | ledger_id, user_id, delta, reason, evidence | CRITICAL | การแก้ไขข้อมูลสิทธิ์โดยบุคคล |

### 2.6 การเข้าถึงข้อมูล / ระบบ

| event_type | Actor | Payload หลัก | ระดับ | PDPA |
| --- | --- | --- | --- | --- |
| PII_ACCESS | staff ทุกระดับ, super_admin | endpoint, target_user_id, จุดประสงค์(รายงาน/แก้ไข/ยืนยัน) | WARN | **หัวใจของ PDPA** — บันทึกการเข้าถึงข้อมูลส่วนบุคคล |
| ADMIN_EXPORT | staff ตามสิทธิ์ | report_type, จำนวนแถว, ตัวกรอง (ไม่ใส่ค่ากรองที่เป็น PII) | WARN | การเปิดเผยข้อมูลออกนอกระบบ |
| RATE_LIMIT_HIT | ระบบ | group, endpoint, ip_hash/user_id | WARN | — |
| NOTIFICATION_BULK_SEND | staff:registrar, super_admin | เทมเพลต, จำนวนผู้รับ, กลุ่มเป้าหมาย | NOTICE | การใช้ข้อมูลเพื่อการติดต่อ |
| AUDIT_READ | staff:viewer, super_admin | ตัวกรอง, จำนวนแถว | NOTICE | การเข้าถึงบันทึกตรวจสอบเอง |
| AUDIT_EXPORT | super_admin | ช่วงเวลา, จำนวนแถว, รูปแบบ | CRITICAL | ส่งออกบันทึกที่มีข้อมูลบุคคล |
| AUDIT_CHAIN_VERIFY | ระบบ (cron) | ผล (ok/broken ที่ id ใด), anchor ที่ใช้ | NOTICE (broken=CRITICAL) | พิสูจน์ความถูกต้องของบันทึก |

รวม **46 event types** (นับจากตาราง §2.1–2.6)

---

## 3. โครงสร้างข้อมูล

### 3.1 ตาราง `audit_logs`

```sql
create table public.audit_logs (
  id           uuid primary key default gen_random_uuid(),
  occurred_at  timestamptz not null default now(),
  event_type   text not null,              -- ตาม catalog §2 (enum check constraint)
  actor_id     uuid,                       -- null = ระบบ/anonymous
  actor_roles  text[] not null default '{}',
  entity_type  text not null,              -- 'user' | 'course' | 'attempt' | 'certificate' | 'credit_ledger' | 'audit_log' | ...
  entity_id    text,                       -- uuid หรือ business key (เช่น cert code)
  request_id   text,                       -- สัมพันธ์กับ log แอปพลิเคชัน
  session_id   text,
  ip_hash      text,                       -- sha256(ip + daily_salt) ไม่เก็บ IP ตรง ๆ
  user_agent   text,
  payload      jsonb not null default '{}',
  prev_hash    text not null,
  row_hash     text not null
);
create index on public.audit_logs (occurred_at desc);
create index on public.audit_logs (event_type, occurred_at desc);
create index on public.audit_logs (actor_id, occurred_at desc);
create index on public.audit_logs (entity_type, entity_id);
alter table public.audit_logs enable row level security;
```

### 3.2 JSON payload schema (zod — validate ก่อนเขียน)

```typescript
const AuditPayload = z.object({
  reason: z.string().max(500).optional(),     // บังคับสำหรับ CRITICAL/WARN
  metadata: z.record(z.unknown()).default({}),// รายละเอียด event-specific
}).strict()
  .refine((p) => !JSON.stringify(p).match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/),
           { message: "ห้ามใส่ email ใน audit payload" }); // ป้องกัน PII หลุด
```

กติกา metadata ต่อ event อยู่ใน catalog §2; ค่า PII เดิม-ใหม่เก็บเป็น "ฟิลด์ที่เปลี่ยน" เท่านั้น (ไม่เก็บค่า)

### 3.3 Hash-chain (tamper-evidence แบบ lightweight)

```
row_hash = sha256( prev_hash || id || occurred_at || event_type
                 || actor_id || entity_type || entity_id || canonical_json(payload) )
```

- การแทรก **serialize ด้วย `pg_advisory_xact_lock(hashtag)` ในฟังก์ชัน `append_audit_event()`** (security definer, เรียกโดย service_role) — กัน chain แตกจาก concurrent write
- **Anchor รายวัน**: cron job เก็บ `(day, last_id, last_row_hash)` ลงตาราง `audit_chain_anchors` (append-only เช่นกัน) — anchor ใช้เทียบ/สืบสายต่อ
- **ตรวจสาย**: cron รายชั่วโมง ตรวจ 1,000 แถวล่าสุด; รายวัน ตรวจทั้งวันก่อนหน้า → เจอ mismatch = event `AUDIT_CHAIN_VERIFY` ระดับ CRITICAL + แจ้ง super_admin ทันที
- ข้อจำกัดที่ยอมรับ: ป้องกันการแก้แอบ (แก้แล้ว row_hash ไม่ตรงเดิม สายขาดและถูกจับได้) แต่ผู้ที่ลบ "ทั้งเส้น + สร้าง chain ใหม่" พร้อม anchor ปลอมตรวจไม่ได้ 100% — บรรเทาด้วยสิทธิ์ DB แคบ (§4) + anchor export ออกนอก DB เดือนละครั้ง (เก็บที่ object storage เขียนครั้งเดียว)

---

## 4. การบังคับ append-only (3 ชั้น)

```sql
-- ชั้น 1: DB privileges — เอาสิทธิ์ update/delete ออกจากทุก role ที่ app ใช้
revoke update, delete, truncate on public.audit_logs
  from authenticated, anon, service_role;
grant insert, select on public.audit_logs to service_role;   -- BFF เท่านั้น
-- service_role ยังพอมีสิทธิ์เป็นเจ้าของตาราง → จึงต้องมีชั้น 2

-- ชั้น 2: trigger บล็อกแม้ superuser/owner (ยกเว้น migration ที่ drop trigger อย่างชัดเจน)
create or replace function public.prevent_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs: append-only — UPDATE/DELETE ถูกห้าม (BRIEF §8, D6)';
end $$;
create trigger trg_audit_immutable
  before update or delete on public.audit_logs
  for each row execute function public.prevent_audit_mutation();

-- ชั้น 3: RLS — อ่านตามบทบาท (insert ผ่าน security-definer function เท่านั้น)
create policy audit_read_admin on public.audit_logs for select to authenticated
  using (public.my_roles() && array['staff:viewer','super_admin']);
create policy audit_read_self on public.audit_logs for select to authenticated
  using (actor_id = auth.uid());
```

- **ชั้นที่ 4 โดยการออกแบบ API**: ไม่มี route แก้/ลบ audit เลย (ทดสอบ T14/T16 ใน RBAC-DESIGN.md §6)
- การอ่านของตัวเอง (`audit_read_self`) = สิทธิ์ "ดู activity ของตัวเอง" สนับสนุนสิทธิ์เข้าถึงข้อมูลของเจ้าของข้อมูลตาม PDPA
- ทุกการอ่านของ staff → event `AUDIT_READ` (สังเกต activity ที่ใช้ดู activity)

---

## 5. Retention & Export

| หัวข้อ | นโยบาย default (config) |
| --- | --- |
| Retention | เก็บ 5 ปี (config `AUDIT_RETENTION_YEARS`, รอยืนยันกับนโยบายสภาฯ + PDPA data retention) — **v1 ไม่มีการลบอัตโนมัติ** จนกว่าจะมีมติเป็นลายลักษณ์อักษร |
| การลบเมื่อครบกำหนด | ทำเป็น batch รายปี โดย super_admin ร้องขอ + CRITICAL event + export สำเนาก่อนลบ (export-then-purge) |
| พื้นที่จัดเก็บ | ตารางหลัก + ย้ายแถวเก่ากว่า 1 ปี ไป partition เย็น/ตารางเก็บถาวร (ทำเมื่อปริมาณมากพอ — วางแผนไว้ก่อน) |
| Export | `super_admin` ผ่านเส้นทางที่ CTO อนุมัติแยกต่างหาก (เช่น คำขอเป็นลายลักษณ์อักษร) → CSV/JSON, บันทึก `AUDIT_EXPORT` (CRITICAL), rate limit กลุ่ม EXPORT |
| การเข้าถึงของเจ้าของข้อมูล | ผู้ใช้ทั่วไปขอดู activity ตัวเองผ่าน `audit_read_self` (ไม่ต้องรอเจ้าหน้าที่) |

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

1. BFF handler → เรียก `appendAudit(event)` (พร้อม zod payload + คำนวณ chain)
2. ระดับ WARN/CRITICAL → บล็อก response จน audit สำเร็จ (fail-closed: ถ้า audit ล่ม ให้ fail request ด้วย ERR-SYS-002 สำหรับ action อันตราย)
3. cron: anchor รายวัน + verify รายชั่วโมง/รายวัน + สรุปแจ้งเตือน
4. retention job (เมื่อเปิดใช้) ทำงานหลัง export เท่านั้น

---

## 7. Mapping: AUD requirement ↔ event types

รหัส AUD ด้านล่างคือ "ความต้องการด้าน audit" ที่ใช้อ้างจาก SRS/RTM (worker-2) — หาก SRS ใช้รหัสอื่น ยื่น DCR ปรับตารางนี้

| REQ | ความต้องการ (จาก BRIEF) | Event types ที่ตอบโจทย์ |
| --- | --- | --- |
| AUD-01 | บันทึกการ login ทุกครั้ง (สำเร็จ+ล้มเหลว) | AUTH_LOGIN_OK, AUTH_LOGIN_FAIL, AUTH_LOGOUT |
| AUD-02 | บันทึกการเปลี่ยนแปลงบทบาท | ROLE_GRANT, ROLE_REVOKE |
| AUD-03 | บันทึกการเปลี่ยนสถานะเนื้อหา | COURSE_PUBLISH/UNPUBLISH/ARCHIVE |
| AUD-04 | บันทึกการสอบครบวงจร | EXAM_ATTEMPT_START, EXAM_SUBMIT, EXAM_TIME_LIMIT_EXCEED, EXAM_GRADE_OVERRIDE |
| AUD-05 | บันทึกการออก/เพิกถอนประกาศนียบัตร | CERT_ISSUE, CERT_REVOKE, CERT_VERIFY_PUBLIC |
| AUD-06 | บันทึกการปรับ credit (ทุกกรณี) | CREDIT_GRANT, CREDIT_ADJUST, CREDIT_RULE_CREATE/UPDATE |
| AUD-07 | บันทึกการเข้าถึงข้อมูลส่วนบุคคล | PII_ACCESS (หลัก), CERT_VERIFY_PUBLIC, AUDIT_READ |
| AUD-08 | บันทึกการส่งออกข้อมูล | ADMIN_EXPORT, AUDIT_EXPORT |
| AUD-09 | audit ต้อง append-only + ตรวจ tamper ได้ | AUDIT_CHAIN_VERIFY (+ กลไก §4) |
| AUD-10 | บันทึกการล็อกบัญชี/ความพยายามเข้าถึงผิดปกติ | AUTH_LOCKOUT, RATE_LIMIT_HIT |
| AUD-11 | บันทึกการแก้ profile/ผูก-ยืนยันใบอนุญาต | USER_UPDATE, LICENSE_BIND, LICENSE_VERIFY |
| AUD-12 | บันทึกการอ่าน audit เอง | AUDIT_READ |

---

## 8. เปิดประเด็น

| ประเด็น | สถานะ |
| --- | --- |
| ระยะเก็บ audit ที่สภาฯ ต้องการจริง (5 ปี ที่เสนอ) | รอยืนยันกับ policy สภาฯ + PDPA retention |
| แจ้งเตือน CRITICAL ออกอีเมลภายนอก ผ่าน provider ใด | ผูกกับระบบ notification โดเมน 6 — ตัดสิน Wave C |
| ปริมาณ LESSON_COMPLETED/QUIZ_SUBMIT ที่ระดับ 100,000 ผู้ใช้ อาจต้อง sampling เพิ่ม | วัดจริงช่วง load test แล้ว DCR |
| ชื่อ entity_type ต้องตรงกับ DATA-DICTIONARY.md (worker-3) | ประสานก่อน Wave A gate |
