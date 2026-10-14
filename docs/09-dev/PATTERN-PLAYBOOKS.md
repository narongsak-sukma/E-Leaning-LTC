# PATTERN-PLAYBOOKS — playbook ชั้นเร็วสำหรับคลาส micro-DCR ที่ซ้ำ (measured-ceiling bumps · host-portability spawns · stale-state hygiene)

| | |
| --- | --- |
| สถานะ | **PROPOSAL — รอ owner ratify ที่ sprint close** (สิทธิ์อนุมัติ: **owner** (กระบวนการ) · TEAM-ENHANCEMENT-RETRO §2 แถว 1) — **ก่อน ratify เอกสารนี้เป็นข้อมูลอ้างอิง ไม่ใช่อำนาจ** · การใช้จริงห้ามเกิดก่อนสถานะเปลี่ยนเป็น ACTIVE |
| ผู้เขียน | devops worker (Flash) · ตาม WO-1 Sprint 3 (lane P-PLAYBOOK · charter ของ owner) · 2026-10-14 |
| ที่มา | TEAM-ENHANCEMENT-RETRO §2 แถว 1 — "**Playbook ชั้นเร็วสำหรับคลาสเปลี่ยนแปลงที่ซ้ำ** — budget-with-measurement · docker-start/portability-bypass · การซ่อม provisioning ใต้อำนาจ delegated: กำหนดแบบแผนล่วงหน้าใน charter ว่าคลาสเหล่านี้ CTO ออกได้เอง + บันทึกพิสูจน์หลังทำ (post-hoc audit) แทนรอ consent ก่อน" · หลักฐานที่หนุน (คัดตรงจาก retro): "สามรอบที่ถามแคบ+มีเกณฑ์พิสูจน์ (teardown-guard · amendment-1 · round-2 ของ MFA) จบรอบเดียว · object จริงเกิดจากขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์สเท่านั้น" · Impact สูง (ตัด round-trip 2–4 รอบ/สปรินต์) · Effort ต่ำ (เขียน charter เพิ่ม 1 หน้า) |
| ฐานหลักฐาน | consent trail ที่นับได้จากเอกสารจริงของคืน 2026-10-13/14 — **9 รอบ consent หลัก + 2 จุดค้นพบกลางทางที่ขอ ruling** (รายการเต็มที่ §0.1 — เอกสารนี้อ้างรายการ trail ที่นับได้ ไม่อ้างเลขรวมลอย ๆ) |
| ขอบเขต | doc-only · ครอบเฉพาะ **สามคลาส**ตาม lane charter (§1–§3) · playbook ไม่ใช่ใบอนุญาตข้าม gate ของงานนอกสามคลาส (fences ที่ §7) · ห้ามครอบงาน `src/**` / compose / image / digest / global testTimeout |

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
| **PB-1** · measured-ceiling bumps | ครบ 5 ชิ้น: two-strike · exact-timeout zeros · family-ratio scale · sibling scan · แถว baseline ตอน merge | ปรับ**ตัวเลขเวลาเท่านั้น** (timeout/budget/deadline ต่อเคส) — assertion/invariant/fence คงเดิมทุกบรรทัด | ทุกอย่างที่แตะ semantics · global testTimeout · `src/**` · compose/image | บังคับบันทึกแถว ceiling ตอน merge — "ห้ามขยับอีกโดยไม่มีการวัดใหม่" |
| **PB-2** · host-portability spawns | ชันสูตรชี้ชั้น host จาก log/error จริง + แก้ array-form ไม่ผ่าน shell + loud-fail ครบ | ซ่อม spawn/execution ตามแบบแผน pin ไว้ (execPath+bin · inspect template · docker start ตรง) — พฤติกรรมคงเดิม | การแก้ที่เปลี่ยนความหมายเทส · ลด assertion · compose/image/digest | บันทึกรายการจุดแก้ (ไฟล์:บรรทัด) + แบบแผนที่ใช้ ตอน merge |
| **PB-3** · stale-state hygiene | หลักฐาน ledger/log ชี้ state ค้างข้ามรัน + เคลียร์ผ่านกลไกที่มีอยู่ + ตัวเทสไม่ถูกแตะ | เก็บกวาด/จำลองกันชน (audit/truncate · RUN_ID guard · detached launcher) — แก้ที่ขั้นตอน ไม่แก้เทส | การแก้ตัวเทส/harness · ledger semantics · การปิดอาการซ้ำ (two-strike) | บันทึกแถวสุขลักษณะ (run_ids + วิธี + ผล audit + intent) ตอน merge |

### 1.1 สิ่งที่ยังต้อง full gate เสมอ — รายการร่วมของทุกคลาส (คัดตรงจาก lane charter §(ค))

ทุกคลาส fast-track ได้เฉพาะในขอบเขตของตัวเอง — สิ่งต่อไปนี้ต้องเดิน DCR เต็มพร้อม pm+qa consent **เสมอ ไม่มีข้อยกเว้น**:

1. การแตะ `src/**`
2. การแก้ assertion/invariant/fence semantics (ไม่ใช่แค่ตัวเลขเวลา)
3. การลดหรืองด assertion ใด ๆ ("ไม่แตะลด assertion ใด ๆ" — DCR-TEST-HARNESS-PORTABILITY ขอบเขตคงที่)
4. การแตะ `docker-compose.yml`/image/digest (คำถามของ DCR-PROD-DEPLOY)
5. การเปลี่ยน global testTimeout ของ config
6. ขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์ส — ตามหลักฐานของ retro ว่า "object จริงเกิดจากขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์สเท่านั้น"

## 2. §PB-1 · คลาส 1 — measured-ceiling bumps (ปรับเพดานเวลาของเทสตามการวัด)

ขอบเขตคลาส: ปรับเพดานเวลา (timeout/budget/deadline) ของเทสตามการวัด — **ตัวเลขเวลาเท่านั้น assertion/invariant คงเดิม**

### (ก) Trigger evidence required — ครบทั้งห้าชิ้นก่อนขอ fast-track

1. **two-run measurement (two-strike)** — สองรอบวัด จากสอง log จริง ไม่ใช่ความรู้สึก — ต้นแบบ: rr-dcr9 ล้ม 6 เคส (2,3,4,5,7,9) "ที่ 30000ms พอดีหมด ไม่มี assertion fail เดียว" + strike ก่อนหน้า rb3-dcr9 (เคส 1 ล้ม 30s พอดีในหน้าต่างเดียวกัน) — `DCR-SUITE-STABILITY-R2.md` §หลักฐาน ข้อ 3
2. **exact-timeout zeros** — ค่าล้ม = ค่า timeout พอดี (30000ms / 300,022ms) **และ zero assertion failures in the failing set** — ต้นแบบ BR Amendment 1: "rr เขียว 288,703ms = 96.2% ของเพดาน 300s · rr2 แดงที่ 300,022ms พอดี — ไร้ assertion fail ทั้งสามรอบ" (`DCR-BARRIER-REBASELINE.md` Amendment 1)
3. **family-ratio scale** — อัตราที่ขออยู่ในสเกลของครอบครัวที่ GO ไปแล้ว: ×2.5 ตามแบบแผน (dcr9 30→75 · probe 5→30 — `DCR-BARRIER-REBASELINE.md` §ทางแก้) หรืออัตราที่อธิบายได้เทียบเวลาจบจริง (2.08× ของ 288.7s ที่วัดจริง — R2 Amendment 1 · เหตุผลที่จดไว้: "เพดานเป็นความอดทน (patience bound) — เครื่องเร็วจบเท่าไรก็จบเท่านั้น ไม่มีต้นทุนเมื่อไม่โดน")
4. **sibling utilization scan** — สแกนเทสพี่น้องในไฟล์เดียวกันว่ายืนได้สบาย — ต้นแบบ one-liner: "max non-subject = waveh-r8 ที่ 57.3% ของ 120s" (R2 Amendment 1 pm CONSENT — ผู้วิจารณ์ยืนยัน sibling scan เอง)
5. **recorded baseline row** — หน้าที่บังคับตอน merge (รายละเอียดที่ (ง)) — binding pm ของ R2 ฉันทามติสมบูรณ์ + Amendment 1 · ต่อเนื่องเป็นตาราง baseline ceiling รวมของ barrier suite (`DCR-BARRIER-REBASELINE.md` แผนพิสูจน์ข้อ 3)

### (ข) Fast-track criteria

ครบทั้งห้าชิ้น → **CTO ออกได้เองโดยไม่ต้องรอ pm+qa consent เต็มรูป** ภายใต้เงื่อนไขที่ playbook ผูกไว้:

- แก้จุดเดียว (ตัวเลขเวลา) ไม่แตะอย่างอื่น — ต้นแบบ R2 Amendment 1: "แก้หนึ่งบรรทัด → isolated waveh → full-suite 35 ไฟล์"
- ไม่แตะเคสที่ผ่านอยู่แล้วเพราะมี headroom — ต้นแบบ R2 จุด 2: "ไม่แต่เคส 8,10,11,13 (ผ่านที่ 5.7-13.2s มี headroom)"
- watchpoint ที่ประกาศล่วงหน้าเมื่อการแก้เป็นการบวกเข้าตรง ๆ ของเพดาน — ต้นแบบ watchpoint จุด 16 ของ BR: "ทางเลือกที่ตัดสินด้วยการวัด ประกาศไว้ก่อน — ห้ามตัดสินด้วยการเดา"
- บันทึก post-hoc audit หลังรอบพิสูจน์จบ (ธรรมนีย์ §7)

### (ค) What still needs full gate

รายการร่วมทั้งเจ็ดข้อของ §1.1 + กรณีเฉพาะคลาสนี้:

- **global testTimeout ของ config** (จำแยกจาก per-test timeout) — ต้นแบบ R2 จุด 2: "global testTimeout 30_000 ของ config ไม่ขยับ (ไฟล์อื่น 34 ไฟล์ผ่านที่เพดานนี้มาแล้วทั้งคืน)"
- watchpoint ที่ผลรอบพิสูจน์ไม่ตรงเลขคณิตที่ประกาศไว้ → ยกรอบเป็นการค้นพบตามหลักฐาน ไม่ใช่เดิน fast-track ต่อ — ต้นแบบ BR รอบพิสูจน์ #1: วัดได้ 36,825ms ไม่ใช่เลขคณิต ~20.2s ที่ qa ทำนาย → "ยกรอบเป็นการค้นพบ 1 ตามหลักฐาน ไม่ใช่การเดา" (กลายเป็น BR Amendment 1 ผ่าน ruling)

### (ง) Ceiling/baseline-table duty

ตอน merge บันทึกแถว baseline ceiling ใน PROJECT-STATE ครบ **ชื่อเทส + ตำแหน่ง (file:line เช่น :1582) + ค่าวัดทุกรอบ + one-liner sibling scan** และคงคำ binding ไว้: **"ห้ามขยับอีกโดยไม่มีการวัดใหม่"** (binding pm ของ R2 ฉันทามติสมบูรณ์ + Amendment 1) — หลักคำสอนต้นทาง: "budget = เพดาน ขยับได้ด้วยการวัดใหม่เท่านั้น" ของ `DCR-GATEWAY-ERRBODY-REBASELINE` (อ้างผ่าน R2 filing) · ต่อเนื่องเป็นตาราง baseline ceiling รวมของ barrier suite (`DCR-BARRIER-REBASELINE.md` แผนพิสูจน์ข้อ 3)

**บรรทัดอ้างอิง**: `DCR-SUITE-STABILITY-R2.md` จุด 2 + Amendment 1 · `DCR-BARRIER-REBASELINE.md` §ทางแก้ (อัตรา ×2.5) + Amendment 1 + รอบพิสูจน์ #1 · `DCR-GATEWAY-ERRBODY-REBASELINE` (หลักคำสอน — อ้างผ่าน R2 filing)

## 3. §PB-2 · คลาส 2 — host-portability spawns (npx / sh / compose-start)

ขอบเขตคลาส: ซ่อม spawn/execution ที่พังเพราะพอร์ตตะวิลลิตี้ของ host — พฤติกรรมธุรกิจของเทสคงเดิมทุกอย่าง

### (ก) Trigger evidence required — ชันสูตรต้องชี้ชั้น host จาก log/error จริง และรูปแบบต้องตรงรูปที่ซ้ำแล้ว

1. **spawn npx ตายบน Windows (ENOENT)** — แก้แบบ `process.execPath` + ชี้ bin ตรง (`node_modules/vitest/vitest.mjs`) — **array-form spawn เสมอ ไม่ผ่าน shell** (ไม่มีพื้นผิว quoting) · binding สามข้อของ Addendum 3: (ก) argv เริ่มที่ `"run"` ห้ามเหลือคำ `vitest` หลงเหลือ (ข) `FORCE_COLOR:"0"` เป็น load-bearing ของ stdout-assertion ห้ามแตะ (ค) รอบพิสูจน์ต้องเห็น **child markers ใน output จริง** ไม่ใช่แค่ RC เขียว (`DCR-TEST-HARNESS-PORTABILITY.md` Addendum 3 · `tests/barrier-proof/barrier-harness.ts:638` — อ่านอ้าง ห้ามแตะ) · ทางเลือกที่ปฏิเสธไว้: `{shell:true}` — "ใช้ได้แต่เพิ่มพื้นผิว parsing ของ args โดยไม่จำเป็น"
2. **`exec sh` ใน container ที่ image ไม่มี shell (image drift)** — ต้นเหตุที่พิสูจน์แล้ว: `postgrest/postgrest:v12.2.3` tag เดิมกับที่ตรวจจริง 2026-09-15 แต่ content ของ tag เปลี่ยน (pull ใหม่ 2026-10-13 ไม่มี shell แม้ printenv ตรง ๆ → rc=127) — เปลี่ยนเป็น `docker inspect --format` **array-form spawn** · **TEMPLATE ต้องเป็น `{{range .Config.Env}}{{println .}}{{end}}` เท่านั้น ห้าม bare `{{.}}`** (bare = rc=0 กับบรรทัดเดียวเบี้ยว → นับได้ 0 แบบผ่านเงียบในเคส fail-closed) · loud-fail guards ครบ: rc≠0/spawn error → throw (slice stderr ตามแบบแผน :372) · stdout ว่าง/whitespace → throw (ห้ามตีความเป็น 0) · ทุกบรรทัดไม่ว่างต้อง match `KEY=VALUE` ไม่งั้น throw · tripwire: ต้องเห็นคีย์ที่รู้จัก (`PGRST_DB_URI`) ในผลที่อ่านได้ · **validated-zero (อ่านครบถูกต้อง + นับได้ 0) คืน green path เดิม** (`test-io.ts:593` คืน 10_000 · docstring 556-559) — **ห้ามตีความ zero เป็น throw** (เกณฑ์ของ qa เป็น authoritative — review-ask รอบแรกของ cto เขียน "zero → throw" ผิด ถ้าทำตามจะทำ M1 settle พังทั้งชุด) (THP จุด 3 แถว `[แก้ตาม qa round-1 ทั้งสามข้อ + เงื่อนไข pm]`)
3. **`docker compose start <svc>` ประเมิน depends_on ใหม่จนล้ม** — เปลี่ยนเป็น `docker start <container_name>` ตรง (ต้นแบบ: startMailer ล้ม 7 จุด → `docker start ltc-dev-mailer` — R2 จุด 1 · ปิดกล่อง: restart app → healthy 0.33s → คำสั่งเดิมสำเร็จทันที = "ตัวขวางคือการประเมิน dependency ไม่ใช่ตัว mailer") · **deadline completion**: ทุกจุดต้องมี deadline (60s) + warning fail-loud greppable คงไว้ครบ — เกณฑ์พิสูจน์: `grep "startMailer ล้ม"` = ศูนย์แถว (binding pm ของ R2 ข้อ 2)
4. **บทเรียนข้ามชั้น**: "ชั้นวัดของ launcher โกหก (cmd.exe /c ตัดคำ SQL) — ครั้งหน้าต้อง spawn array-form" (`PROJECT-STATE.md:804`) · `exec` ผ่าน shell โดยไม่จำเป็นคือหนี้เทคนิคทุกจุดที่เจอ

### (ข) Fast-track criteria

ชันสูตรชี้ชั้น host + แก้ array-form ไม่ผ่าน shell ตามแบบแผนข้อ 1–3 คำต่อคำ (template pin · loud-fail ทุกทิศ · validated-zero คืน green path เดิม) + พฤติกรรม (args/config/env BARRIER_CHILD/RUN_ID/timeout/exit-code) ไม่เปลี่ยน → **CTO ออกได้เองโดยไม่ต้องรอ pm+qa consent เต็มรูป** ภายใต้เงื่อนไขพิสูจน์: รอบพิสูจน์ต้องเห็น **ผลข้างจริงของ spawn ใหม่** — child markers ใน output จริง (ต้นแบบ: "ไฟล์ barrier ที่เคยตายทั้งตระกูล 8e/8e2 เขียวแบบ isolated — เห็น child spawn จริง") · warning fail-loud ที่ greppable ต้องเป็นศูนย์แถว (`grep "startMailer ล้ม"` = 0) · ไม่มีอะไรถูก mask + บันทึก post-hoc audit หลังรอบพิสูจน์จบ

### (ค) What still needs full gate

รายการร่วมทั้งเจ็ดข้อของ §1.1 + กรณีเฉพาะคลาสนี้:

- การแก้ที่ต้องเปลี่ยน contract ของ harness ร่วมที่ spawn เรียกใช้ — ต้นแบบ: การแก้ end() ของ `tests/integration/test-io.ts` "ต้อง consent เพราะแตะ harness ร่วมของ 35 ไฟล์" (BR การค้นพบ 1 → Amendment 1)
- การ pin digest ของ image — "แยกเป็นคำถามของ DCR-PROD-DEPLOY ที่กำลัง draft" (THP ขอบเขตคงที่: ไม่แต่ compose/image)

### (ง) Ceiling/baseline-table duty

คลาสนี้ไม่มีเพดานเวลาที่เกี่ยว — หน้าที่ตารางคือ: บันทึก**รายการจุดแก้ (ไฟล์:บรรทัด ครบทุกจุด)** + **แบบแผนที่ใช้** ลง DCR/PROJECT-STATE ตอน merge เพื่อให้จุดถัดไปของคลาสเดียวกันชี้ playbook ได้ — ต้นแบบ: R2 จุด 1 ระบุจุดแก้ 15 จุดครบทั้งตาราง · ถ้าเจอ image-drift ใหม่ บันทึกบทเรียนตามเงื่อนไข pm รอบ 1 ของ THP ("บันทึกบทเรียน image-drift ของ postgrest ใน PROJECT-STATE")

**บรรทัดอ้างอิง**: `DCR-TEST-HARNESS-PORTABILITY.md` จุด 3 + Addendum 3 · `DCR-SUITE-STABILITY-R2.md` จุด 1 · `PROJECT-STATE.md:804`

## 4. §PB-3 · คลาส 3 — stale-state hygiene

ขอบเขตคลาส: เก็บกวาด state ค้างข้ามรันให้สะอาดก่อน/ระหว่างรัน (ledger/RUN_ID/launcher hygiene) — **แก้ที่ขั้นตอน ไม่แก้ตัวเทส**

### (ก) Trigger evidence required — รูปแบบข้อบกพร่องที่ซ้ำ + กฎ

1. **RUN_ID collisions ข้ามรัน** — ledger append-only + `ledgerRead` อ่านทุกแถวของ run_id → รันใหม่ที่ใช้ RUN_ID เดียวกับรันก่อน (ที่ตายกลางทางแต่เขียนแถวไปแล้ว) จะเห็นแถวของรันก่อนปนเปื้อน — หลักฐานต้นแบบ: 8f f2 ล้มที่แถว `cleanup-start ts=23:37:34.93` ซึ่งเป็นแถวของ **battery r38 รอบสอง 06:36** (ตายที่ child spawn แต่ 8e3/8f ซึ่งไม่ใช้ลูกได้รันและเขียนแถวไปแล้ว) · f3/f4a = cascade (`DCR-BARRIER-REBASELINE.md` §การค้นพบกลางทาง) · รูปพอร์ตตะวิลลิตี้ที่เคยเห็น: launcher ไม่ตั้ง RUN_ID → 'adhoc' ชนกับของเก่า แถวค้างบล็อก attempt ใหม่ (PROJECT-STATE ตอน battery r38 ครั้งแรก)
2. **ledger pre-run audit/truncate** — battery มีกันชน `assertLedgerFresh` อยู่แล้ว (`scripts/battery-run.mjs:134-150` — check-and-fail + ทางเคลียร์ที่ชอบ: audit `--truncate` / เคลียร์มือตาม limitation 5) — **กฎ: launcher ใดก็ตามที่ตั้ง RUN_ID เอง ต้องจำลองกันชนนี้** (สุขลักษณะข้อ 0 ของ BR แผนพิสูจน์: audit ledger ก่อน clean-run) · แนวทาง binding: **"ไม่แก้เทส 8f แม้แต่บรรทัดเดียว — แก้ที่ขั้นตอน"**
3. **two-strike rule** — อาการที่เคยปิดด้วยเหตุ suite-pollution ห้ามจัดเป็น flake อีก: ล้มซ้ำแม้ครั้งเดียวหลัง fix = เปิด ticket สอบสวนแยกทันที (binding pm รอบ 1 ของ THP — ต้นแบบที่ทำงานจริง: "D1 opaque" ล้มซ้ำหลัง harness fix → เปิด BL-015 สอบสวนแยกทันที)
4. **no-overlap + detached launcher** — "ห้ามรันสวีทซ้อนเด็ดขาด" + ทุก long run ใช้ detached launcher เท่านั้น (`PROJECT-STATE.md:771` — cmd ตาย vitest รอด → cross-cleanup ลบ user กันเอง ("user_not_found" 403) · background task ของ session โดน kill ที่ ~60 น.)

### (ข) Fast-track criteria

อาการแดงถูกชี้ด้วยหลักฐาน ledger/log จริงว่าเป็นแถว/state ของรันก่อนปนเปื้อน + ทางเคลียร์ผ่านกลไกที่มีอยู่ (audit `--truncate` / เคลียร์มือ + จด intent ใน PROJECT-STATE) + ตัวเทสไม่ถูกแตะแม้บรรทัดเดียว + launcher ที่ตั้ง RUN_ID เองจำลองกันชน `assertLedgerFresh` ครบ → **CTO ออกได้เองโดยไม่ต้องรอ pm+qa consent เต็มรูป** ภายใต้เงื่อนไขพิสูจน์: รอบรันถัดไปต้องตัดสินจากแถวของรอบตัวเองเท่านั้น (ตรวจด้วย audit ก่อนรัน = ไม่มีแถวค้าง) + บันทึก post-hoc audit หลังรอบพิสูจน์จบ

### (ค) What still needs full gate

รายการร่วมทั้งเจ็ดข้อของ §1.1 + กรณีเฉพาะคลาสนี้:

- การแก้ที่ลามถึงตัวเทส/harness แทนที่จะแก้ที่ขั้นตอน — ต้นแบบ: "ไม่แก้เทส 8f แม้แต่บรรทัดเดียว — แก้ที่ขั้นตอน" (การแก้ assertion ของ 8f ต้อง consent เต็มรูปเสมอ)
- การแก้ ledger/harness semantics ของ `test-io.ts` / `barrier-harness.ts`
- การปิดอาการซ้ำด้วยเหตุ stale-state/suite-pollution — two-strike ห้าม (ต้องเปิด ticket สอบสวนแยก ไม่ใช่ playbook)

### (ง) Ceiling/baseline-table duty

บันทึกแถวสุขลักษณะลง PROJECT-STATE ตอน merge: **run_ids ที่เคลียร์ + วิธีเคลียร์ + ผล audit + intent** (ตาม limitation 5: "เคลียร์มือตาม limitation 5 จด intent ใน PROJECT-STATE") · ถ้าการเคลียร์ไปพร้อมกับการวัดเพดานใหม่ = บันทึกแถว baseline ceiling ตาม §2(ง) ด้วย (ต้นแบบ: BR แผนพิสูจน์ข้อ 0 ทำคู่กับข้อ 1 ที่ "เก็บเวลาจบแต่ละไฟล์เป็น baseline ceiling รอบใหม่")

**บรรทัดอ้างอิง**: `DCR-BARRIER-REBASELINE.md` §การค้นพบกลางทาง + แผนพิสูจน์ข้อ 0 · `DCR-TEST-HARNESS-PORTABILITY.md` รอบ 1 (binding pm) · `PROJECT-STATE.md:771`

## 5. §PB-AC · Gherkin acceptance criteria ต่อคลาส (เขียนก่อนเนื้อความ — test-first · แบบแผน WAVE-J §5)

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

## 6. §PB-LOG · ตาราง "ครั้งที่ใช้แล้ว" (ว่างไว้ — เติมเมื่อ ratify แล้วมีการใช้จริง)

| วันที่ | คลาส | ผู้ออก | หลักฐานที่แนบ | post-hoc audit ผล |
| --- | --- | --- | --- | --- |
| | | | | |

## 7. §PB-FENCE · Fences + การอ้างอิงกลับ

- playbook นี้**ไม่ใช่ใบอนุญาตข้าม gate ของงานนอกสามคลาส** — งานใดที่ไม่เข้าคลาส PB-1/PB-2/PB-3 เดิน DCR เต็มตาม governance (TEAM.md · Governance — design first)
- ห้ามใช้ playbook เพื่อ: แตะ `src/**` · แตะ `docker-compose.yml`/image/digest (คำถามของ DCR-PROD-DEPLOY) · เปลี่ยน global testTimeout ของ config · ลดหรืองด assertion ใด ๆ ("ไม่แตะลด assertion ใด ๆ" — DCR-TEST-HARNESS-PORTABILITY ขอบเขตคงที่) · แก้ assertion/invariant/fence semantics · ขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์ส (หลักฐานของ retro: object จริงเกิดจากกรณีนี้เท่านั้น)
- คลาสที่สี่ (เช่น environment-hardening bundle ของ retro §2 แถว 2) ไม่อยู่ใน playbook นี้ — เป็นตั๋ว CTO คนละเรื่อง
- **ธรรมนีย์ PROPOSAL**: การใช้ fast-track ครั้งแรกของแต่ละคลาสต้องมีบันทึก post-hoc audit และยังอยู่ใต้อำนาจ CTO ถอนหากหลักฐานไม่ครบ — เจตนาของ playbook คือให้ micro-DCR จบในรอบเดียวโดยสิ่งที่วัดได้ยังถูกกันด้วยเกณฑ์พิสูจน์ที่เข้มเท่าเดิมทุกประการ
- การอ้างอิงกลับ: `docs/09-dev/TEAM-ENHANCEMENT-RETRO.md` (§2 แถว 1 — ข้อเสนอต้นทาง · §1 หลักฐาน "ถามแคบจบรอบเดียว") · `docs/backlog.md` (BL-014 — follow-up os.tmpdir · BL-015 — two-strike origin) · `PROJECT-STATE.md` (แถวบทเรียนของคืน 2026-10-13/14) · DCR ต้นทางที่ playbook อ้างอิง (R2/R2-A1 · BR และ Amendments · THP/THP Addendum 3) — **playbook อ้างอิงเท่านั้น ไม่แก้ต้นฉบับ**

---

*ท้ายเอกสาร — สถานะ **PROPOSAL — รอ owner ratify ที่ sprint close (สิทธิ์อนุมัติ: owner · retro §2 แถว 1)** · ก่อน ratify = เอกสารอ้างอิง ไม่ใช่อำนาจ · เขียนโดย devops worker (Flash) · 2026-10-14 · ทุกตัวเลข/ข้อความ binding คัดตรงจากเอกสารต้นทางพร้อมอ้าง §/file:line · ฐาน branch `develop`@`65fbac9` (rebase หลัง close drained ตามคำสั่ง CTO)*
