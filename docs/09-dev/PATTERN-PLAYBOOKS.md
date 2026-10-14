# PATTERN-PLAYBOOKS — playbook ชั้นเร็วสำหรับคลาส micro-DCR ที่ซ้ำ (measured-ceiling bumps · host-portability spawns · stale-state hygiene)

| | |
| --- | --- |
| สถานะ | **PROPOSAL — รอ owner ratify ที่ sprint close** (สิทธิ์อนุมัติ: **owner** (กระบวนการ) · TEAM-ENHANCEMENT-RETRO §2 แถว 1) — **ก่อน ratify เอกสารนี้เป็นข้อมูลอ้างอิง ไม่ใช่อำนาจ** · การใช้จริงห้ามเกิดก่อนสถานะเปลี่ยนเป็น ACTIVE |
| ผู้เขียน | devops worker (Flash) · ตาม WO-1 Sprint 3 (lane P-PLAYBOOK · charter ของ owner) · 2026-10-14 |
| ที่มา | TEAM-ENHANCEMENT-RETRO §2 แถว 1 — "**Playbook ชั้นเร็วสำหรับคลาสเปลี่ยนแปลงที่ซ้ำ** — budget-with-measurement · docker-start/portability-bypass · การซ่อม provisioning ใต้อำนาจ delegated: กำหนดแบบแผนล่วงหน้าใน charter ว่าคลาสเหล่านี้ CTO ออกได้เอง + บันทึกพิสูจน์หลังทำ (post-hoc audit) แทนรอ consent ก่อน" · หลักฐานที่หนุน (คัดตรงจาก retro): "สามรอบที่ถามแคบ+มีเกณฑ์พิสูจน์ (teardown-guard · amendment-1 · round-2 ของ MFA) จบรอบเดียว · object จริงเกิดจากขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์สเท่านั้น" · Impact สูง (ตัด round-trip 2–4 รอบ/สปรินต์) · Effort ต่ำ (เขียน charter เพิ่ม 1 หน้า) |
| ฐานหลักฐาน | consent trail ที่นับได้จากเอกสารจริงของคืน 2026-10-13/14 — **9 รอบ consent หลัก + 2 จุดค้นพบกลางทางที่ขอ ruling** (รายการเต็มที่ §0.1 — เอกสารนี้อ้างรายการ trail ที่นับได้ ไม่อ้างเลขรวมลอย ๆ) |
| ขอบเขต | doc-only · ครอบเฉพาะ **สามคลาส**ตาม lane charter (§1–§3) · playbook ไม่ใช่ใบอนุญาตข้าม gate ของงานนอกสามคลาส (fences ที่ §6) · ห้ามครอบงาน `src/**` / compose / image / digest / global testTimeout |

## 0. นิยามคำ

- **micro-DCR** — การเปลี่ยนแปลงขอบเขตแคบที่เคยผ่าน DCR เต็มรูปมาแล้วอย่างน้อยหนึ่งครั้งในรูปเดียวกัน: แก้ตามแบบแผนที่พิสูจน์แล้ว จุดเดียว/ตัวเลขเดียว ไม่แตะ semantics ใด (assertion/invariant/fence)
- **fast-track** — การที่ CTO ออก GO เองโดยไม่รอ pm+qa consent เต็มรูป ตามแบบแผนที่ playbook กำหนดไว้ล่วงหน้า เมื่อหลักฐาน trigger ครบทุกชิ้นตามคลาส
- **post-hoc audit** — บันทึกพิสูจน์หลังทำ: หลักฐานก่อน/หลัง + เกณฑ์พิสูจน์ที่ตรวจได้ (greppable/log จริง) บันทึกตามธรรมเนียม DCR/PROJECT-STATE — **การใช้ fast-track ครั้งแรกของแต่ละคลาสต้องมี post-hoc audit และยังอยู่ใต้อำนาจ CTO ถอนหากหลักฐานไม่ครบ** (แนะให้ pm/qa ดู 1 รอบก่อนถือว่า playbook proven)
- **baseline ceiling** — แถวเพดานเวลาต่อเทสที่บังคับบันทึกตอน merge (ชื่อเทส + ตำแหน่ง file:line + ค่าวัดทุกรอบ + one-liner sibling scan) — ห้ามขยับอีกโดยไม่มีการวัดใหม่

## 0.1 Consent trail ที่นับได้ (รายการ — ไม่อ้างเลขรวมลอย)

**9 รอบ consent หลัก** (นับได้จากเอกสารต้นทางจริง):

| # | รอบ | ผล |
| --- | --- | --- |
| 1 | DCR-SUITE-STABILITY-R2 (base · startMailer 15 จุด + dcr9 30→75s) — pm CONSENT + qa CONSENT (bridge · 2026-10-13) | GO (CTO) |
| 2 | R2 Amendment 1 (waveh-r7 M1.1-1 300s→600s) — pm CONSENT + qa CONSENT (bridge · 2026-10-13) | GO (CTO) |
| 3 | DCR-BARRIER-REBASELINE (base · 21 จุด) — pm CONSENT + qa CONSENT (bridge · 2026-10-14) | GO ทั้ง 21 จุด (CTO) |
| 4 | BR Amendment 1 (end() แข่ง close กับ kill+grace) — pm CONSENT + qa CONSENT (binding 4 ข้อ) | GO ผ่าน bridge |
| 5 | BR Amendment 2 (mm จัดหมวด (a)/(b) ด้วยหลักฐาน) — pm CONSENT + qa CONSENT (binding พับครบ) | GO ผ่าน bridge |
| 6 | BR Amendment 3 (wrapper 8o(ก) รับหลักฐานฝั่ง A สองแหล่ง) — pm CONSENT + qa CONSENT + pm fold-ins | GO ผ่าน bridge |
| 7 | DCR-TEST-HARNESS-PORTABILITY รอบ 1 — pm CONSENT + qa OBJECTION (3 amendments) (2026-10-13) | แก้แถวตารางข้อ 3 ครบ |
| 8 | THP รอบ 2 — qa CONSENT (ปิดครบสาม amendments) (2026-10-13) | GO ทั้งสามจุด (CTO) |
| 9 | THP Addendum 3 (childRun spawn npx ENOENT → execPath+vitest.mjs) — pm CONSENT + qa CONSENT fast round (2026-10-14) | GO (CTO) |

**+ การค้นพบกลางทางที่ขอ ruling CTO 2 จุด** (บันทึกก่อนแก้ตาม governance · รอบพิสูจน์ #1 ของ BR · 2026-10-14): (1) การค้นพบ 1 — 8i kill fallback ของ end() พังที่ชั้น host (Docker Desktop ถือ exec stream) · (2) การค้นพบ 2 — 8o/mm classifier ทาง (a)/(b) เป็น race ที่ขึ้นกับความเร็วเครื่อง — ทั้งสองจุดถูกตัดสินด้วย ruling แล้วกลายเป็น BR Amendment 1/2

หมายเหตุ: charter ของ Sprint 3 ใช้เฟรม "11 review rounds" — เอกสารนี้อ้าง **รายการ trail ที่นับได้**ข้างบนเท่านั้น (disposition C-2 ตาม gate ruling A-2)

## 1. ตารางสารบัญคลาส

| คลาส | trigger evidence | สิ่งที่ fast-track ได้ | สิ่งที่ยังต้อง full gate | หน้าที่ baseline-table |
| --- | --- | --- | --- | --- |
| §1 · measured-ceiling bumps | ครบ 5 ชิ้น: two-strike · exact-timeout zeros · family-ratio scale · sibling scan · แถว baseline ตอน merge | ปรับ**ตัวเลขเวลาเท่านั้น** (timeout/budget/deadline ต่อเคส) — assertion/invariant/fence คงเดิมทุกบรรทัด | ทุกอย่างที่แตะ semantics · global testTimeout · `src/**` · compose/image | บังคับบันทึกแถว ceiling ตอน merge — "ห้ามขยับอีกโดยไม่มีการวัดใหม่" |
| §2 · host-portability spawns | ชันสูตรชี้ชั้น host จาก log/error จริง + แก้ array-form ไม่ผ่าน shell + loud-fail ครบ | ซ่อม spawn/execution ตามแบบแผน pin ไว้ (execPath+bin · inspect template · docker start ตรง) — พฤติกรรมคงเดิม | การแก้ที่เปลี่ยนความหมายเทส · ลด assertion · compose/image/digest | บันทึกรายการจุดแก้ (ไฟล์:บรรทัด) + แบบแผนที่ใช้ ตอน merge |
| §3 · stale-state hygiene | หลักฐาน ledger/log ชี้ state ค้างข้ามรัน + เคลียร์ผ่านกลไกที่มีอยู่ + ตัวเทสไม่ถูกแตะ | เก็บกวาด/จำลองกันชน (audit/truncate · RUN_ID guard · detached launcher) — แก้ที่ขั้นตอน ไม่แก้เทส | การแก้ตัวเทส/harness · ledger semantics · การปิดอาการซ้ำ (two-strike) | บันทึกแถวสุขลักษณะ (run_ids + วิธี + ผล audit + intent) ตอน merge |

## 2. §PB-1 · คลาส 1 — measured-ceiling bumps (ปรับเพดานเวลาของเทสตามการวัด)

> **test-first** — เนื้อความครบสี่หน้าที่ (trigger evidence required · fast-track criteria · what still needs full gate · ceiling/baseline-table duty) เขียนหลัง Gherkin AC ถูก commit แล้ว (§4 · Feature PB-1) ตามลำดับที่ WO-1 §1.5 กำหนด

## 3. §PB-2 · คลาส 2 — host-portability spawns (npx / sh / compose-start)

> **test-first** — เนื้อความครบสี่หน้าที่เขียนหลัง Gherkin AC ถูก commit แล้ว (§4 · Feature PB-2)

## 4. §PB-AC · Gherkin acceptance criteria ต่อคลาส (เขียนก่อนเนื้อความ — test-first · แบบแผน WAVE-J §5)

```gherkin
Feature: PB-1 measured-ceiling bump — เกณฑ์ fast-track (PROPOSAL)
  Background:
    Given การเปลี่ยนแปลงอยู่ในคลาส "ปรับเพดานเวลาของเทส" (ตัวเลขเวลาเท่านั้น — assertion/invariant/fence คงเดิมทุกบรรทัด)

  Scenario: หลักฐานครบทั้งห้าชิ้น — CTO ออกได้เองตาม playbook
    Given มีการวัดสองรอบ (two-strike) จาก log จริงสองรอบที่ล้มที่ค่า timeout พอดี
    And ชุดที่ล้มมี zero assertion failures
    And อัตราที่ขออยู่ใน family-ratio scale (×2.5 ตามแบบแผน หรืออัตราที่อธิบายได้เทียบเวลาจบจริง)
    And มี sibling utilization scan ของไฟล์เดียวกัน (ระบุ % สูงสุดของ non-subject)
    When เสนอปรับเพดานโดยอ้าง playbook คลาสนี้
    Then CTO ออกได้เองโดยไม่ต้องรอ pm+qa consent เต็มรูป
    And ต้องบันทึกแถว baseline ceiling ตอน merge (ชื่อเทส+ตำแหน่ง+ค่าวัดทุกรอบ+one-liner sibling scan)
    And ต้องบันทึก post-hoc audit หลังรอบพิสูจน์จบ

  Scenario: ขาดหลักฐานข้อใดข้อหนึ่ง — กลับไป full gate
    Given หลักฐานข้อใดข้อหนึ่งในห้าชิ้นขาดหาย (เช่น มีเพียงรอบเดียว หรือมี assertion fail ปน)
    When เสนอปรับเพดาน
    Then ต้องเดิน DCR พร้อม pm+qa consent ตามปกติ (playbook ไม่มีอำนาจในกรณีนี้)

  Scenario: แตะเกินตัวเลขเวลา — full gate เสมอ
    Given การแก้ลามถึง assertion/invariant/fence semantics หรือ global testTimeout ของ config หรือ src/**/compose/image
    When เสนอการเปลี่ยนแปลง
    Then playbook คลาสนี้ไม่มีอำนาจ — ต้องเดิน DCR เต็มเสมอ
```

```gherkin
Feature: PB-2 host-portability spawn — เกณฑ์ fast-track (PROPOSAL)
  Background:
    Given การเปลี่ยนแปลงอยู่ในคลาส "ซ่อม spawn/execution ที่พังเพราะพอร์ตตะวิลลิตี้ของ host" (npx/sh/compose-start — พฤติกรรมธุรกิจของเทสคงเดิม)

  Scenario: หลักฐานครบ — CTO ออกได้เองตาม playbook
    Given ชันสูตรชี้ชั้น host เป็นต้นเหตุจาก log/error จริง (spawn npx ENOENT · rc=127 shell ไม่มีใน image · compose ประเมิน depends_on ใหม่)
    And การแก้เป็น array-form spawn ไม่ผ่าน shell ทุกจุด (process.execPath+bin ตรง · docker inspect --format ตาม template ที่ pin · docker start <container_name> ตรง)
    And ครบ loud-fail guards ที่ playbook กำหนด (rc≠0 → throw · stdout ว่าง → throw · ทุกบรรทัด match KEY=VALUE · tripwire เห็นคีย์ที่รู้จัก · validated-zero คืน green path เดิม)
    And ไม่มี assertion/invariant ใดถูกแตะหรือลด
    When เสนอแก้โดยอ้าง playbook คลาสนี้
    Then CTO ออกได้เองโดยไม่ต้องรอ pm+qa consent เต็มรูป
    And รอบพิสูจน์ต้องเห็นผลข้างจริงของ spawn ใหม่ (child markers ใน output จริง ไม่ใช่แค่ RC เขียว · warning fail-loud เป็นศูนย์แถว)
    And ต้องบันทึก post-hoc audit หลังรอบพิสูจน์จบ

  Scenario: ขาดหลักฐานข้อใดข้อหนึ่ง — กลับไป full gate
    Given ข้อใดข้อหนึ่งขาดหาย (เช่น ชันสูตรไม่ได้ชี้ชั้น host · แก้ผ่าน shell/quoting · ขาด loud-fail ทิศใดทิศหนึ่ง)
    When เสนอแก้
    Then ต้องเดิน DCR พร้อม pm+qa consent ตามปกติ (playbook ไม่มีอำนาจในกรณีนี้)

  Scenario: แตะความหมายของเทสแทนชั้น host — full gate เสมอ
    Given การแก้ลามถึง assertion/invariant/fence semantics หรือแตะ src/**/compose/image/digest
    When เสนอการเปลี่ยนแปลง
    Then playbook คลาสนี้ไม่มีอำนาจ — ต้องเดิน DCR เต็มเสมอ
```

```gherkin
Feature: PB-3 stale-state hygiene — เกณฑ์ fast-track (PROPOSAL)
  Background:
    Given การเปลี่ยนแปลงอยู่ในคลาส "เก็บกวาด state ค้างข้ามรันให้สะอาดก่อน/ระหว่างรัน" (ledger/RUN_ID/launcher hygiene — แก้ที่ขั้นตอน ไม่แก้ตัวเทส)

  Scenario: หลักฐานครบ — CTO ออกได้เองตาม playbook
    Given อาการแดงถูกชี้ด้วยหลักฐาน ledger/log จริงว่าเป็นแถว/state ของรันก่อนปนเปื้อน (เช่น แถวของ run_id เดียวกันจากรันที่ตายกลางทาง)
    And ทางเคลียร์ใช้กลไกกันชนที่มีอยู่จริง (audit --truncate / เคลียร์มือตาม limitation ที่จด intent)
    And ตัวเทสไม่ถูกแตะแม้บรรทัดเดียว
    And launcher ที่ตั้ง RUN_ID เองจำลองกันชน assertLedgerFresh ครบ
    When เสนอเก็บกวาดโดยอ้าง playbook คลาสนี้
    Then CTO ออกได้เองโดยไม่ต้องรอ pm+qa consent เต็มรูป
    And รอบรันถัดไปต้องตัดสินจากแถวของรอบตัวเองเท่านั้น (ตรวจด้วย audit ก่อนรัน = ไม่มีแถวค้าง)
    And ต้องบันทึก post-hoc audit หลังรอบพิสูจน์จบ

  Scenario: ล้มซ้ำหลังเคลียร์ — two-strike ห้ามจัดเป็น flake
    Given อาการเดิมเคยปิดด้วยเหตุ suite-pollution/stale-state มาแล้ว
    When ล้มซ้ำแม้ครั้งเดียวหลังเคลียร์/fix
    Then ห้ามจัดเป็น flake — เปิด ticket สอบสวนแยกทันที (playbook ไม่มีอำนาจปิดซ้ำ)

  Scenario: ขาดหลักฐานว่าเป็น stale-state — กลับไป full gate
    Given ไม่มีหลักฐาน ledger/log รองรับว่าแถวปนเปื้อนข้ามรัน หรือการแก้ต้องลามถึงตัวเทส
    When เสนอเก็บกวาด
    Then ต้องเดิน DCR พร้อม pm+qa consent ตามปกติ (playbook ไม่มีอำนาจในกรณีนี้)
```

## 5. §PB-LOG · ตาราง "ครั้งที่ใช้แล้ว" (ว่างไว้ — เติมเมื่อ ratify แล้วมีการใช้จริง)

| วันที่ | คลาส | ผู้ออก | หลักฐานที่แนบ | post-hoc audit ผล |
| --- | --- | --- | --- | --- |
| | | | | |

## 6. §PB-FENCE · Fences + การอ้างอิงกลับ

- playbook นี้**ไม่ใช่ใบอนุญาตข้าม gate ของงานนอกสามคลาส** — งานใดที่ไม่เข้าคลาส §1–§3 เดิน DCR เต็มตาม governance (TEAM.md · Governance — design first)
- ห้ามใช้ playbook เพื่อ: แตะ `src/**` · แตะ `docker-compose.yml`/image/digest (คำถามของ DCR-PROD-DEPLOY) · เปลี่ยน global testTimeout ของ config · ลดหรืองด assertion ใด ๆ ("ไม่แตะลด assertion ใด ๆ" — DCR-TEST-HARNESS-PORTABILITY ขอบเขตคงที่) · แก้ assertion/invariant/fence semantics · ขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์ส (หลักฐานของ retro: object จริงเกิดจากกรณีนี้เท่านั้น)
- คลาสที่สี่ (เช่น environment-hardening bundle ของ retro §2 แถว 2) ไม่อยู่ใน playbook นี้ — เป็นตั๋ว CTO คนละเรื่อง
- **ธรรมนีย์ PROPOSAL**: การใช้ fast-track ครั้งแรกของแต่ละคลาสต้องมีบันทึก post-hoc audit และยังอยู่ใต้อำนาจ CTO ถอนหากหลักฐานไม่ครบ — เจตนาของ playbook คือให้ micro-DCR จบในรอบเดียวโดยสิ่งที่วัดได้ยังถูกกันด้วยเกณฑ์พิสูจน์ที่เข้มเท่าเดิมทุกประการ
- การอ้างอิงกลับ: `docs/09-dev/TEAM-ENHANCEMENT-RETRO.md` (§2 แถว 1 — ข้อเสนอต้นทาง · §1 หลักฐาน "ถามแคบจบรอบเดียว") · `docs/backlog.md` (BL-014 — follow-up os.tmpdir · BL-015 — two-strike origin) · `PROJECT-STATE.md` (แถวบทเรียนของคืน 2026-10-13/14) · DCR ต้นทางที่ playbook อ้างอิง (R2/R2-A1 · BR และ Amendments · THP/THP Addendum 3) — **playbook อ้างอิงเท่านั้น ไม่แก้ต้นฉบับ**

---

*ท้ายเอกสาร — สถานะ **PROPOSAL — รอ owner ratify ที่ sprint close (สิทธิ์อนุมัติ: owner · retro §2 แถว 1)** · ก่อน ratify = เอกสารอ้างอิง ไม่ใช่อำนาจ · เขียนโดย devops worker (Flash) · 2026-10-14 · ทุกตัวเลข/ข้อความ binding คัดตรงจากเอกสารต้นทางพร้อมอ้าง §/file:line · ฐาน branch `develop`@`65fbac9` (rebase หลัง close drained ตามคำสั่ง CTO)*
