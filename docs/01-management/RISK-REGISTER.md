# RISK REGISTER — ระบบ LTC E-Learning

**เวอร์ชัน 0.1.0-draft · 2026-09-08 · LTC E-Learning**

|          |                                                   |
| -------- | ------------------------------------------------- |
| เจ้าของเอกสาร | worker-1 (Wave A) — lead รับผิดชอบดูแลรวม      |
| อ้างอิง   | `00-baseline/PROJECT-BRIEF.md` §2, §7, §8, §10 · `01-management/PROJECT-PLAN.md` §8 |
| สถานะ    | draft — รอ CTO gate (Milestone M1)                |
| รอบทบทวน | ต้นทุก wave + ทุก milestone gate M1–M5            |

## สารบัญ

1. [วิธีให้คะแนนและเกณฑ์ระดับ](#1-วิธีให้คะแนนและเกณฑ์ระดับ)
2. [ทะเบียนความเสี่ยง — คะแนน](#2-ทะเบียนความเสี่ยง--คะแนน)
3. [ทะเบียนความเสี่ยง — แผนรับมือ](#3-ทะเบียนความเสี่ยง--แผนรับมือ)
4. [Risk Heat Map](#4-risk-heat-map)
5. [Top-5 ความเสี่ยงที่ต้องจับตา](#5-top-5-ความเสี่ยงที่ต้องจับตา)
6. [ความเสี่ยงเชื่อมกับ Wave และ Milestone](#6-ความเสี่ยงเชื่อมกับ-wave-และ-milestone)
7. [กระบวนการบริหารความเสี่ยง](#7-กระบวนการบริหารความเสี่ยง)
8. [ประวัติการเปลี่ยนแปลง](#8-ประวัติการเปลี่ยนแปลง)

---

## 1. วิธีให้คะแนนและเกณฑ์ระดับ

- **โอกาสเกิด (P)** 1–5: 1 = หายากมาก (< 5%) … 5 = เกิดแน่ถ้าไม่ป้องกัน (> 70%)
- **ผลกระทบ (I)** 1–5: 1 = เบ็ดเตล็ด … 5 = กระทบภารกิจหลัก/กฎหมาย/ความเชื่อมั่นสาธารณะ
- **คะแนน = P × I**

ตัวอย่างการแปลงระดับผลกระทบ (ใช้เป็นเกณฑ์ร่วมเพื่อให้คะแนนตรงกัน):

| ระดับ I | ตัวอย่างเกณฑ์                                                                               |
| ------- | -------------------------------------------------------------------------------------------- |
| 5       | กระทบภารกิจหลัก (สอบ/ประกาศนียบัตร/credit) ผิดกฎหมาย PDPA หรือความเชื่อมั่นสาธารณะ / ข้อมูลสูญถาวร |
| 4       | ฟีเจอร์หลักใช้ไม่ได้ชั่วคราว / ความลับข้อมูลผู้ใช้บางส่วน / ส่งมอบเลื่อนข้าม milestone       |
| 3       | ฟีเจอร์รองเสียหาย / ต้นทุนเกินประมาณ / ต้องทำงานซ้ำในขอบเขตรับได้                               |
| 2       | รบกวนการทำงาน/UX เล็กน้อย แก้ได้ใน wave เดียวกัน                                               |
| 1       | เบ็ดเตล็ด แทบไม่มีใครสังเกต                                                                  |

| คะแนน | ระดับ      | นโยบาย                                                  |
| ----- | ---------- | --------------------------------------------------------- |
| 15–25 | วิกฤต 🔴   | ต้องมีแผนลด + contingency ก่อนเริ่ม wave ที่เกี่ยวข้อง + escalation ถึง CTO |
| 10–14 | สูง 🟠     | มีแผนลด + owner ติดตามทุก milestone                       |
| 5–9   | ปานกลาง 🟡 | มีแผนลด + ตรวจในรอบทบทวน wave                             |
| 1–4   | ต่ำ 🟢     | จดไว้ ทบทวนเมื่อสถานการณ์เปลี่ยน                           |

## 2. ทะเบียนความเสี่ยง — คะแนน

| ID   | หมวด        | คำอธิบายความเสี่ยง                                                               | โอกาส (P) | ผลกระทบ (I) | คะแนน | ระดับ      |
| ---- | ----------- | ---------------------------------------------------------------------------------- | --------- | ----------- | ----- | ---------- |
| R-01 | Security    | ช่องโหว่ OWASP Top 10 (injection, broken access control, SSRF) ใน API/BFF           | 3         | 5           | 15    | วิกฤต 🔴   |
| R-02 | Security    | Account takeover ผู้ใช้ (credential stuffing, รหัสผ่านอ่อน, session hijack)          | 3         | 5           | 15    | วิกฤต 🔴   |
| R-03 | Security    | การทุจริตในการสอบ (cheating) เกินระดับ proctoring ที่ยอมรับ — ทำให้ประกาศนียบัตรไม่น่าเชื่อถือ | 4  | 4           | 16    | วิกฤต 🔴   |
| R-04 | PDPA/กฎหมาย  | Cross-border data transfer ผิดเงื่อนไข PDPA (Supabase region นอกไทย)                | 3         | 4           | 12    | สูง 🟠     |
| R-05 | PDPA/กฎหมาย  | log รั่ว PII (เลขบัตรประชาชน/เลขที่ใบอนุญาต/email) ผิดข้อบังคับ brief §8          | 3         | 4           | 12    | สูง 🟠     |
| R-06 | PDPA/กฎหมาย  | ไม่ครบภาระ data subject rights (เข้าถึง/แก้ไข/ลบ/retention) และ consent                | 3         | 3           | 9     | ปานกลาง 🟡 |
| R-07 | Vendor      | Vendor lock-in Supabase (Auth/Postgres/Storage ผูกเป็นหลัก) ย้ายตัวยาก/ราคาเปลี่ยน  | 2         | 3           | 6     | ปานกลาง 🟡 |
| R-08 | Vendor      | Lock-in Cloudflare R2/Stream — วิดีโอสะสมอยู่ฝั่งเดียว ย้าย/ค่า egress แพง             | 2         | 3           | 6     | ปานกลาง 🟡 |
| R-09 | Vendor      | Lock-in Vercel (serverless constraints, ราคา scale ตาม usage)                       | 2         | 2           | 4     | ต่ำ 🟢     |
| R-10 | Performance | ช่วงสอบ peak ผู้เข้าสอบพร้อมกัน 5,000+ ทำให้ระบบล่าช้า/ล่ม กระทบความน่าเชื่อถือการสอบ | 3  | 4           | 12    | สูง 🟠     |
| R-11 | Performance | วิดีโอ 10,000 sessions พร้อมกัน — bandwidth/CDN cost และ startup latency เกินเป้า     | 2         | 4           | 8     | ปานกลาง 🟡 |
| R-12 | Content     | เนื้อหากฎหมายผิดพลาด/ล้าสมัยเผยแพร่สู่สาธารณะ — ความเสียหายชื่อเสียงสภาฯ           | 2         | 5           | 10    | สูง 🟠     |
| R-13 | Content/Media| วิดีโอขนาดใหญ่/ความยาวเกิน spec — ต้นทุน storage พอง, encode ช้า, UX แย่ (Q6 ไม่ยืนยัน) | 3  | 3           | 9     | ปานกลาง 🟡 |
| R-14 | Data        | Data loss ถาวร (DB corruption, ลบผิด, ไม่มี backup ทดสอบแล้ว) — credit/ผลสอบหาย      | 2         | 5           | 10    | สูง 🟠     |
| R-15 | Identity    | ยืนยันตัวตนทนายผิดพลาด — ผูกเลขที่ใบอนุญาตผิดคน/ปลอม (workflow Q3 ไม่ยืนยัน)        | 3         | 4           | 12    | สูง 🟠     |
| R-16 | Credit      | คำนวณ/บันทึก credit ผิด (กฎ Q1 ไม่ยืนยัน, ledger bug) — กระทบสิทธิ์ต่อใบอนุญาตทนาย  | 2         | 5           | 10    | สูง 🟠     |
| R-17 | Team/Process| ทีม AI/model ทำงานยาวต่อเนื่อง — context loss, drift จากแผน, งานซ้ำ/ขัดแย้งกัน       | 4         | 3           | 12    | สูง 🟠     |
| R-18 | Scope       | Q1–Q6 ยังไม่ยืนยัน → สเปค/credit/สอบ/proctoring เปลี่ยนช้างาน ทำใหม่กระจาย            | 4         | 4           | 16    | วิกฤต 🔴   |
| R-19 | Budget      | ค่า cloud service (Vercel/Supabase/Cloudflare) สูงกว่าประมาณ — งบไม่พอ/ถูกตัด        | 3         | 3           | 9     | ปานกลาง 🟡 |
| R-20 | External    | Supabase Cloud outage / degradation ระยะยาว (prod ผูกบริการเดียว)                    | 2         | 4           | 8     | ปานกลาง 🟡 |
| R-21 | External    | Email แจ้งเตือนส่งไม่ถึง/ตกไป spam — ผู้ใช้พลาด deadline/ผลสอบสำคัญ                   | 3         | 2           | 6     | ปานกลาง 🟡 |
| R-22 | Security    | Audit log มีช่องโหว่ (จุดที่ไม่บันทึก/ถูกแก้-ลบได้) — การกำกับดูแล/สืบสวนไม่ได้      | 2         | 5           | 10    | สูง 🟠     |
| R-23 | Schedule    | Wave F พบ High/Critical จาก VA/pentest → ต้อง remediate ยาว ส่งมอบเลื่อน              | 3         | 4           | 12    | สูง 🟠     |
| R-24 | Compliance  | เนื้อหาสาธารณะไม่ถึง WCAG 2.1 AA (contrast, keyboard, screen reader)                 | 3         | 3           | 9     | ปานกลาง 🟡 |
| R-25 | Security    | RLS misconfiguration หรือ service key รั่วฝั่ง client — ข้อมูลผู้ใช้รั่วทั้งตาราง      | 2         | 5           | 10    | สูง 🟠     |
| R-26 | Security    | ประกาศนียบัตรปลอม/verify ถูก brute-force — ทำลายความน่าเชื่อถือของเอกสารรับรอง        | 2         | 4           | 8     | ปานกลาง 🟡 |

## 3. ทะเบียนความเสี่ยง — แผนรับมือ

| ID   | แผนลดความเสี่ยง (Mitigation)                                                                                                | Contingency (ถ้าเกิดแล้ว)                                                  | Owner      | Trigger ตรวจจับ                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| R-01 | zod validate ทุก input; parameterized query เท่านั้น; ASVS L2 checklist ตั้งแต่ design; OWASP ZAP + manual review ทุก wave F | Hotfix + rotate secrets + แจ้งผู้ว่าจ้าง + post-mortem + DCR              | worker-4   | ZAP/VA พบ High+; พบ query ที่ไม่ parameterized ใน review                |
| R-02 | Rate limit + lockout policy; บังคับรหัสผ่านแข็งแรง; session timeout; MFA สำหรับ staff/super_admin ทุกระดับ                  | ปิดบัญชีชั่วคราว + force reset + ตรวจ audit log รายบัญชี                 | worker-4   | จำนวน login ล้มเหลว/ชั่วโมง > threshold; รายงานผู้ใช้เรื่องบัญชีถูกแปลก |
| R-03 | ออกแบบ exam engine รองรับ proctoring หลายระดับ (config ตาม Q4); สุ่มข้อสอบจาก question bank; บันทึก event การสอบทั้งหมด       | ยกเลิกผลสอบเฉพาะเคส + สอบใหม่ + ประกาศนโยบาย + เปิด proctoring ระดับสูงขึ้น | worker-4 + CTO | pattern คะแนนผิดปกติ, รายงานทุจริต, สถิติ pass rate ผิดปกติต่อรอบ |
| R-04 | เลือก region SG/JP ใกล้ไทย; ทำ data map + SCC/มาตรการข้ามพรมแดนตาม PDPA; รอคำยืนยัน Q5                                     | ย้าย region/ทำ data processor ใหม่ตามคำแนะนำกฎหมาย + DCR deployment       | lead       | คำตอบ Q5 ชี้ขัดกับ arch ปัจจุบัน                                       |
| R-05 | linter/rule ห้าม PII ใน log; review โค้ด logging ทุก merge; ใช้ user_id อ้างอิงแทน                                            | ลบ/retention ตัด log; ประเมินภาระแจ้งเจ้าของข้อมูลตาม PDPA                 | worker-4   | grep PII pattern ใน log sample ประจำ wave; secrets scan จับ pattern     |
| R-06 | เขียน data inventory + retention policy ตั้งแต่ SRS; consent flow ในการสมัคร; export/delete สำหรับเจ้าของข้อมูล             | เพิ่ม workflow สิทธิ์ค้างใน wave ถัดไป + DPO สภาฯ review                 | worker-2   | gap review ต่อ milestone; ข้อร้องเรียนสิทธิ์ผู้ใช้                       |
| R-07 | ใช้มาตรฐาน (Postgres, SQL migrations, Auth interface) ไม่ใช้ feature เฉพาะเจาะจงเกินจำเป็น; abstraction ที่ storage/media     | แผน migration ออก (pg_dump + แทนที่ Auth layer) — ประเมินต้นทุนไว้ล่วงหน้า | worker-3   | pricing/SLA เปลี่ยนแปลงใหญ่; feature deprecation ที่ใช้อยู่              |
| R-08 | storage abstraction เป็นชั้นกลาง (dev=Supabase, prod=R2/Stream); เก็บไฟล์ต้นฉบับแยก; ต่อรอง egress cap                      | ย้ายไป provider อื่นผ่าน abstraction โดยไม่แก้ business logic             | worker-3   | ค่า egress/เดือนเกินงบประมาณ 2 เท่า                                    |
| R-09 | คุม usage (serverless timeout, ISR); monitor ค่าใช้จ่ายรายเดือน                                                                | ย้าย host (self-host / ผู้ให้บริการอื่น) ตาม container parity            | worker-3   | ค่าใช้จ่าย/เดือนเกินพรีดิกชัน 1.5 เท่า                                  |
| R-10 | ออกแบบ exam submission เป็น async + queue; k6 load test 5k พร้อมกันตั้งแต่ Wave D; auto-save คำตอบ; กระจายช่วงเวลาสอบ       | เลื่อนรอบสอบ + ชดเชยสิทธิ์ผู้เข้าสอบ + post-mortem + capacity เพิ่ม       | worker-1 + lead | P95 latency สอบ > เกณฑ์ TEST-PLAN ใน load test; error rate > 1% ช่วงสอบ |
| R-11 | CDN + adaptive bitrate; จำกัดความละเอียดตาม Q6 default; วัด cost ต่อ view ตั้งแต่ Wave C                        | ลดความละเอียดชั่วคราว + cache หน้า static + เพิ่ม CDN quota              | worker-3   | p95 video startup > 3 s; ค่า bandwidth ผิดปกติ                           |
| R-12 | workflow อนุมัติเนื้อหาโดยเจ้าหน้าที่ก่อนเผยแพร่ (brief §3); ระบุ SME ทบทวน (QP-3); version เนื้อหา + ผู้อนุมัติใน audit | ถอนเนื้อหาทันที + แก้ไข + ประกาศแก้ไขต่อผู้เรียน                        | worker-5 + lead | review log ไม่มีผู้อนุมัติ; รายงานข้อผิดพลาดเนื้อหา                     |
| R-13 | กำหนด spec วิดีโอ default (≤ 60 นาที, ≤ 1080p) + validate ตอน upload; transcode pipeline        | บีบอัด/ตัดเป็นช่วง; จำกัดชั่วคราวตามปริมาณ; ยืนยัน Q6 ให้เร็ว            | worker-3   | ขนาดไฟล์เฉลี่ย/บทเรียนเกิน spec; ค่า storageโตเกินประมาณ                |
| R-14 | backup อัตโนมัติรายวัน + PITR; ทดสอบ restore จริงทุก milestone; credit ledger append-only; DB privileges ห้ามลบ             | restore จาก PITR + กระทบวิเคราะห์ RTO/RPO + แจ้งผู้ว่าจ้าง             | worker-3   | restore drill ล้มเหลว; ตรวจพบ job backup ไม่รันติดต่อกัน > 24 ชม.     |
| R-15 | ออกแบบ verification workflow หลายขั้น + เจ้าหน้าที่อนุมัติ + audit; duplicate license number ตรวจตอนผูก; รอคำตอบ Q3          | ระงับสถานะทนาย + ตรวจย้อน audit + แก้ไข mapping + แจ้งผู้เกี่ยวข้อง     | worker-2 + CTO | พบเลขที่ใบอนุญาตซ้ำ/รูปแบบไม่ตรง; รายงานการอนุมัติที่น่าสงสัย          |
| R-16 | credit rules config-driven + unit test ครอบคลุมทุกกฎ; ledger append-only + ผลรวมตรวจสอบย้อนได้ (reconciliation รายรอบ)         | freeze การออกประกาศนียบัตร + คำนวณใหม่จาก ledger + แจ้งผู้ได้รับผลกระทบ | worker-1   | reconciliation ผลรวมไม่ตรง; พบ negative/ทวิน credit ใน ledger           |
| R-17 | PROJECT-STATE.md เป็น second brain ทุก session ต้องอ่าน; task ID + ownership ชัดเจน; wave สั้น + commit บ่อย; lead review ทุกงาน | lead รับงานค้าง + respawn worker + ตรวจ cross-doc consistency ใหม่       | lead       | wave board มี task เกิน deadline; พบข้อขัดแย้งข้ามเอกสาร               |
| R-18 | ทุก config ทำ parameter + default + flag "รอยืนยัน Q#" (D3); ตั้ง deadline คำตอบ Q1–Q6 ก่อนสิ้น Wave C; DCR ทันทีที่ได้คำตอบ    | ประเมินผลกระทบ + แก้ config/เอกสารตาม DCR + ปรับ schedule                 | lead       | เข้า W10 แล้ว Q1–Q6 ยังไม่มีคำตอบ; คำตอบขัดกับ default ที่ใช้อยู่       |
| R-19 | ประมาณการค่าใช้จ่ายรายเดือนต่อ wave + ตั้ง budget alert; usage monitoring ตั้งแต่ Wave B; ใช้ tier ฟรีใน dev ให้สุด            | ลด resource (ความละเอียดวิดีโอ, retention log) + เจรจางบเพิ่มกับผู้ว่าจ้าง | lead       | ค่าใช้จ่ายจริง/เดือน > ประมาณการ 1.5 เท่า; budget alert แตะ 80%          |
| R-20 | ออกแบบตาม managed SLA; แผน rollback/maintenance window; ติดตาม status page ของ vendor                                      | ใช้ maintenance page + ชดเชยเวลาสอบ/กิจกรรมที่เสียหาย + แจ้งผู้ใช้      | worker-3   | vendor status incident; uptime metric < 99.9% รายเดือน                  |
| R-21 | ใช้ provider ที่มี delivery record ดี + SPF/DKIM; สำรองช่องทางแจ้งเตือนในระบบ (in-app)                                        | ส่งซ้ำ/แจ้งในระบบ + ประกาศหน้าเว็บ + ขยายเวลาถ้ากระทบสิทธิ์ผู้ใช้        | worker-4   | bounce rate > 5%; ผู้ใช้รายงานไม่ได้รับอีเมลจำนวนมาก                   |
| R-22 | บังคับ append-only ด้วย DB privileges + RLS (D6); ไม่มี API แก้/ลบ; ทดสอบพยายาม UPDATE/DELETE ใน integration test           | สืบสวนจาก DB log + ปิดช่องทางที่ทำให้เกิด + แจ้ง CTO ทันที               | worker-4   | พบ row ที่ถูกแก้/หายใน audit; integration test update/delete ผ่านโดยไม่ควร |
| R-23 | security ฝังตั้งแต่ design (shift-left) + codex gate ทุก merge ที่เกี่ยวกับ auth/security/data; ทดสอบ security ระหว่าง wave ไม่รอ F | ขยาย Wave F + remediation ตาม VA-PENTEST.md + ประกาศเลื่อนส่งมอบ      | lead       | จำนวน High+ ที่พบระหว่าง wave > 3; codex gate ตีกลับติดกัน > 2 ครั้ง    |
| R-24 | accessibility checklist ใน design system ตั้งแต่ Wave A; ทดสอบ keyboard/screen reader ใน E2E; contrast ตามเกณฑ์ AA             | แก้ไขเฉพาะจุดที่ถูก flag + ประกาศแผนปรับปรุง (ถ้าเล็กน้อย)              | worker-5   | ผล accessibility audit; E2E keyboard-nav  fail                          |
| R-25 | RLS บังคับทุกตาราง + integration test ทดสอบ policy ทุกข้อ; service key ใช้เฉพาะ server-side; secrets scan + review ทุก merge    | เพิกถือ key ทันที + ปิดช่อง + ประเมินการรั่วไหลข้อมูล + แจ้งตาม PDPA    | worker-4   | secrets scan จับ key ใน repo; test RLS บายพาส; key ปรากฏใน client bundle |
| R-26 | certificate มีรหัสอ้างอิง + QR + verify endpoint rate limit; ไม่เปิด PII เกินจำเป็น; ตรวจ pattern verify ผิดปกติ              | เพิ่ม rate limit/block + invalidate รูปแบบรหัสเดิม + ประกาศช่องทางตรวจสอบ | worker-4   | จำนวน verify request ผิดปกติ/IP; พบ certificate ปลอมถูกใช้จริง         |

## 4. Risk Heat Map

แกนโอกาส (แถว) × ผลกระทบ (คอลัมน์) — แสดง ID ความเสี่ยงที่ตำแหน่งคะแนน

| โอกาส \ ผลกระทบ | 1 น้อยมาก            | 2 น้อย        | 3 ปานกลาง             | 4 มาก                    | 5 ร้ายแรงมาก            |
| --------------- | --------------------- | ------------- | ---------------------- | ------------------------- | ------------------------ |
| **5 แทบจะแน่นอน** | —                     | —             | —                       | —                          | —                         |
| **4 สูง**        | —                     | —             | R-17                   | **R-03, R-18**             | —                         |
| **3 ปานกลาง**    | —                     | R-21          | R-06, R-13, R-19, R-24  | R-04, R-05, R-10, R-15, R-23 | **R-01, R-02**            |
| **2 ต่ำ**        | R-09                  | —             | R-07, R-08              | R-11, R-20, R-26           | R-12, R-14, R-16, R-22, R-25 |
| **1 หายาก**      | —                     | —             | —                       | —                          | —                         |

สรุปตามระดับ: วิกฤต 4 รายการ (R-01, R-02, R-03, R-18) · สูง 10 รายการ · ปานกลาง 11 รายการ · ต่ำ 1 รายการ — รวม 26 รายการ

## 5. Top-5 ความเสี่ยงที่ต้องจับตา

| อันดับ | ID   | คะแนน | เหตุผลที่ต้องจับตาก่อน                                                                    | จุดตัดสินครั้งถัดไป       |
| ------ | ---- | ----- | ------------------------------------------------------------------------------------------ | -------------------------- |
| 1      | R-03 | 16    | ความน่าเชื่อถือของประกาศนียบัตร = หัวใจภารกิจต่อใบอนุญาตว่าความ; ผูกกับ Q4 ที่ยังไม่ตอบ    | Design exam engine (Wave D เริ่มก่อนจบ) |
| 2      | R-18 | 16    | Q1–Q6 ค้าง = ความเสี่ยง rework กว้างสุด แต่ควบคุมได้ด้วย config-driven + default            | Deadline ก่อนสิ้น Wave C   |
| 3      | R-01 | 15    | ระบบมีข้อมูลส่วนบุคคล + ข้อมูลอาชีพทนาย — ช่องโหว่ web กระทบ PDPA พร้อมกัน                | CTO gate M1 (design) และทุก codex gate |
| 4      | R-02 | 15    | ทนาย/เจ้าหน้าที่เป็นเป้าหมาย takeover ค่าสูง; MFA ยังจำกัดเฉพาะ admin ตาม brief              | Wave B (auth scaffold)     |
| 5      | R-10 | 12    | สอบพร้อมกัน 5,000 คนเป็น peak ที่กำหนดไว้ชัด (brief §7) — ล้มช่วงสอบ = ความเสียหายสาธารณะ | k6 load test ต้น Wave D    |

## 6. ความเสี่ยงเชื่อมกับ Wave และ Milestone

ความเสี่ยงแต่ละรายการ "ตื่นตัว" ในช่วงเวลาที่งานของ wave นั้นกระทบมันโดยตรง — gate ของแต่ละ milestone จะตรวจ trigger ของความเสี่ยงที่ระบุในคอลัมน์ "ตรวจที่ gate"

| Wave | ความเสี่ยงที่ active หลัก                                             | ตรวจที่ gate                                                                 |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| A    | R-17, R-18 (+ ทุกรายการตอนประเมินเบื้องต้น)                              | M1: แผนรับมือครบทุกรายการสูง/วิกฤต + owner ชัดเจน                               |
| B    | R-02, R-05, R-19, R-25 (auth scaffold, CI/secrets, งบ cloud เริ่มใช้)     | จบ B: secrets scan ใน CI ทำงานจริง + backup job รันแล้ว + budget alert ตั้งแล้ว |
| C    | R-11, R-12, R-13, R-16 (เนื้อหา/วิดีโอ/progress/credit เริ่มนับ)          | M2: คำตอบ Q1–Q6 ถึงมือ (R-18 ต้องปิด) — ไม่งั้นใช้ default และบันทึก DCR รอ    |
| D    | R-03, R-10, R-15, R-26 (exam engine, load, ยืนยันทนาย, certificate)       | M3: k6 ผ่าน profile สอบ 5k + exam anti-cheat ตามระดับ Q4 ที่ตกลง               |
| E    | R-06, R-16, R-24 (PDPA workflow, credit รอบต่ออายุ, accessibility)        | M4: reconciliation ยอด credit ตรง + รายงาน export ถูกต้อง                      |
| F    | R-01, R-04, R-22, R-23 (VA/pentest, residency, audit, remediation)        | M5: ASVS L2 ผ่าน + 0 High/Critical ค้าง + restore drill ผ่าน + UAT sign-off    |

ข้อสังเกต: ความเสี่ยงระดับวิกฤตทั้ง 4 (R-01, R-02, R-03, R-18) มีจุดตัดสินก่อน Wave D ทั้งหมด — คือ mitigation ต้องเริ่มตั้งแต่เอกสาร/ออกแบบ (shift-left) ไม่ใช่รอถึง Wave F

## 7. กระบวนการบริหารความเสี่ยง

1. **ระบุ/เพิ่ม:** ทุก worker สามารถเสนอความเสี่ยงใหม่ผ่าน lead — เพิ่มแบบ append + ให้คะแนน + กำหนด owner (เอกสารนี้ bump minor version)
2. **ทบทวน:** ต้นทุก wave + ทุก milestone gate — lead ตรวจ trigger ของความเสี่ยงระดับสูง/วิกฤตทั้งหมด
3. **Escalation:** คะแนน ≥ 15 หรือ trigger ถูกแตะ → รายงาน CTO ภายใน milestone ถัดไป พร้อมข้อเสนอแก้ไข
4. **ปิดความเสี่ยง:** ทำเครื่องหมาย closed + เหตุผลเมื่อ mitigation ถูกพิสูจน์แล้ว (เช่น load test ผ่าน) — ห้ามลบแถว (คงไว้เพื่อการตรวจสอบย้อนหลัง)
5. **เชื่อมโยง:** Test Plan อ้างความเสี่ยงในการออกแบบเคสทดสอบ (security/performance test ครอบคลุม R-01, R-02, R-10, R-22, R-25, R-26 โดยตรง)

## 8. ประวัติการเปลี่ยนแปลง

| เวอร์ชัน | วันที่    | การเปลี่ยนแปลง                                                      |
| -------- | ---------- | --------------------------------------------------------------------- |
| 0.1.0-draft | 2026-09-08 | สร้างชุดแรก: 26 ความเสี่ยง + heat map + Top-5 + กระบวนการ + mapping ต่อ wave (worker-1, Wave A) |
