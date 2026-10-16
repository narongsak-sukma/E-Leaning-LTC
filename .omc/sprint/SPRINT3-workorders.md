# SPRINT 3 — Work Orders (เอกสารสั่งงานรายเลน · ขนานกับ close-ladder ที่ยังบินของ Sprint 1–2)

| | |
| --- | --- |
| สถานะ | **DRAFT — รอ CTO gate** (สั่งงานได้เฉพาะงานเตรียมใน worktree ของตัวเอง · รอ CTO ตรวจ ASSUMPTION register §9 ก่อน release เต็ม — ธรรมนีย์เดียวกับ SPRINT2-workorders §0/§11) |
| ผู้เขียน | PM · 2026-10-14 · ตาม owner charter ของ Sprint 3 (CTO กำหนดสองเลน: P-PLAYBOOK (P1) → P-UAT09SPEC (P2)) |
| ข้อจำกัดแข็ง (สืบทอดจาก owner directive) | close-ladder (**Amendment 3 → barrier clean-run #4 → battery r38 → merge → UAT**) **กำลังบิน และเป็นเจ้าของ** main tree (`D:/Lawer-E-Learning` · branch `feat/wave-i-e2e04-403`@`d0ab35d`) · docker stacks · DB · และ**ไฟล์ที่มีอยู่ทั้งหมดใต้ `tests/integration/` + `tests/barrier-proof/`** — ทุก work order ของ Sprint 3 ต้อง (ก) อยู่ใน git worktree ของตัวเอง (`D:/LTC-w4` / `D:/LTC-w5` — แตกจาก `develop`) (ข) เลนเอกสารแตะเฉพาะ **ไฟล์เอกสารใหม่ + เอกสารมีอยู่ที่ถูก named เพียงตัวเดียว** (`docs/TEAM.md` ของ P-PLAYBOOK) · เลน Playwright แตะ **เฉพาะไฟล์ใหม่ใต้ `tests/e2e/` เท่านั้น** (ศูนย์ overlap กับการแก้ของ close-ladder — ยืนยันด้วย git) (ค) **ห้ามรันอะไรที่แตะ docker/DB ทั้งหมด** — ผ่าน validation ระดับ authoring ใน worktree เท่านั้น (ง) ห้าม PR/merge ก่อน gate · push branch ขึ้น remote ได้ |
| เอกสารนี้ self-contained | คนงานไม่ต้องเปิดอ่านเอกสารต้นทางยาว ๆ — สัญญา/เวอร์ชัน/คำสั่งที่จำเป็นคัดมาให้ครบในแต่ละ WO แล้ว (ต้นทาง: DCR-SUITE-STABILITY-R2 (+ Amendment 1) · DCR-BARRIER-REBASELINE (+ Amendments 1–3) · DCR-TEST-HARNESS-PORTABILITY (+ Addendum 3) · TEAM-ENHANCEMENT-RETRO §2 แถว 1 · PROJECT-STATE lessons · UAT-09-SPECS-DRAFT (branch `docs/sprint2-j-uat09-specs`) · e2e/*.spec.ts และ helpers จริง — ตรวจคำนวณกับ working tree จริงแล้วทุกอ้างอิง file:line/§) |

---

## 0. SPRINT 3 Board

| Lane | WO | Branch | Worktree (absolute) | ผู้รับผิดชอบ | Priority | สถานะ | Deliverables (ไฟล์ที่สร้าง/แก้ — ใน worktree เท่านั้น) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **P-PLAYBOOK** — Pattern playbooks สำหรับคลาส micro-DCR ที่ซ้ำ (doc-only · PROPOSAL) | WO-1 | `docs/sprint3-p-pattern-playbooks` | `D:/LTC-w4` | **normal worker Flash** | **P1** | todo | `docs/09-dev/PATTERN-PLAYBOOKS.md` (ใหม่) · `docs/TEAM.md` (แก้ — เพิ่ม section เดียวอ้างอิง playbook) |
| **P-UAT09SPEC** — Playwright e2e specs ของ UAT-09A–D (21 scenarios · authoring เท่านั้น) | WO-2 | `feat/sprint3-p-uat09-specs` | `D:/LTC-w5` | **main worker GLM-5.3** | P2 | todo | `tests/e2e/uat09/fixtures.ts` + `uat-09a..09d*.spec.ts` รวม **5 ไฟล์ใหม่ใต้ `tests/e2e/` เท่านั้น** |

### 0.1 คำสั่งสร้าง worktree (ผู้รับงานรันเองจาก main tree — ครั้งเดียวต่อเลน)

```bash
# WO-1 (P-PLAYBOOK):
git worktree add D:/LTC-w4 -b docs/sprint3-p-pattern-playbooks develop
# WO-2 (P-UAT09SPEC):
git worktree add D:/LTC-w5 -b feat/sprint3-p-uat09-specs develop
```

- ทั้งสองเลนแตกจาก `develop` (ปัจจุบัน `65fbac9` — จุดก่อน merge ของ close-ladder เหมือน Sprint 2 ทุกประการ) — **เจตนา**: ไม่หยิบงานที่ยังไม่ merge ของ close-ladder (รวม Amendment 3 ที่เพิ่ง GO) มาปน
- ห้ามสลับ branch ใน main tree `D:/Lawer-E-Learning` (ปัจจุบัน checkout `feat/wave-i-e2e04-403` — ของ close-ladder · working tree สะอาด ตรวจ 2026-10-14) · ห้าม `git worktree remove/prune` ของเลนอื่น (LTC-w1/w2/w3 ของ Sprint 2 ยังอยู่)
- ผลตรวจจริง ณ วันเขียน: มี worktree อยู่แล้ว 4 (main + w1 + w2 + w3) · **ยังไม่มี** `D:/LTC-w4|w5` · **ยังไม่มี** ไดเรกทอรี `tests/e2e/` · **ยังไม่มี** `docs/09-dev/PATTERN-PLAYBOOKS.md` — ทั้งสองเลนจึงเป็น "สร้างใหม่ทั้งหมด" ไม่มีการสู้กับไฟล์เดิม

### 0.2 คำแถลงความปลอดภัยขนาน (parallel-safety — ไฟล์ที่แต่ละเลน "แตะ" ไม่ซ้อนกันเลย)

| ไฟล์/กลุ่มไฟล์ | WO-1 (P-PLAYBOOK) | WO-2 (P-UAT09SPEC) | close-ladder (บินอยู่) |
| --- | --- | --- | --- |
| `docs/09-dev/PATTERN-PLAYBOOKS.md` (ใหม่) | **เขียน** | — | — |
| `docs/TEAM.md` (มีอยู่ · 67 บรรทัด) | **แก้ — เพิ่ม section เดียวท้ายเอกสาร** | — | — |
| `tests/e2e/**` (ใหม่ทั้งไดเรกทอรี · 5 ไฟล์) | — | **เขียน** | — |
| `tests/integration/**` · `tests/barrier-proof/**` (มีอยู่ทั้งหมด) | อ่านอย่างเดียว (**ห้ามแก้**) | อ่านอย่างเดียว (**ห้ามแก้** — import ข้ามไม่มีด้วย) | **เจ้าของ** (Amendment 3 แตะ `tests/barrier-proof/w8o-guard-attempt-loop.test.ts` อยู่ขณะนี้) |
| `e2e/**` (สเปก Playwright เดิม) | — | อ่านอย่างเดียว + **import ได้** (ห้ามแก้) | — |
| `src/` · `docker/` · `docker-compose.yml` · `.env*` · `scripts/` · `package.json` · `playwright.config.ts` · `Makefile` | ศูนย์ไฟล์ | ศูนย์ไฟล์ | เจ้าของพื้นที่นี้ |
| `PROJECT-STATE.md` · `docs/backlog.md` | ห้ามแตะ (PM อัปเดตเองตอน gate) | ห้ามแตะ | เจ้าของ |

สรุป: **ไม่มีคู่ใดที่ไฟล์ที่แกะ/สร้างร่วมกันและ** — WO-1 อยู่ใน `docs/` · WO-2 อยู่ใน `tests/e2e/` (ไดเรกทอรีใหม่) · close-ladder อยู่ใน `tests/integration|barrier-proof` + `src` + stack — ความเสี่ยง conflict ที่เหลือคือจุดเดียว: **การ merge ทั้งสอง branch เข้า develop ต้องรอหลัง close drained + คำสั่ง CTO** (ฐานร่วม `65fbac9` ทั้งคู่ → rebase ตรงไปตรงมา)

### 0.3 กฎคิวหลัง close (queue-behind-close — ความจริงเรื่องลำดับ · ทุกเลนผูกกฎเดียวกัน)

งานที่ทำได้ **เดี๋ยวนี้**: สร้าง worktree · เขียนเอกสาร/specs/commit ใน branch ตัวเอง · push branch ขึ้น remote (ห้ามเปิด PR) · ผ่าน validation ที่ไม่แตะ docker/DB (doc self-review / `npm install` + `tsc`/`eslint` ใน worktree)

งานที่**คิวอยู่หลัง close** (ทั้งหมด post-close/owner-gated — จดไว้เพื่อความซื่อสัตย์ ห้ามเลื่อนเข้ามาทำล่วงหน้า):

1. **UAT-09 execution** — รัน specs ของ WO-2 จริงบน `:3001` โดย tester agent (ต้องรอ close drained + กฎ P8/re-seed ของสเปก + การต่อสาย config — ดู A-4)
2. **WO-3 execute lane ของ Sprint 2** (P-1→P-3) — รวม **pin `next` ≥ 16.3.8** (binding ของ P-3 ตาม post-QA rulings 2026-10-14) + งาน lint/audit ที่ CTO สั่งเก็บไว้ที่ execute lane (ถอด FlatCompat/@eslint/eslintrc aftermath + disposition nodemailer/sharp/source-map-js) + rebase หลัง close drained
3. **BL-014** — LOCK_DIR ใช้ `os.tmpdir()` (แตะ `tests/integration/` 4 ไฟล์ = พื้นที่ของ close-ladder → คิวหลัง close เท่านั้น)
4. **Deploy execution** — สาย implement ของ DCR-PROD-DEPLOY-DRAFT (Vercel/Supabase/Cloudflare · หลัง UAT ผ่านตามชี้ขาด gate r1)
5. (ต่อเนื่องจาก Sprint 2) เปิด trigger จริงของ `ci-integration.yml` · Phase 2 battery-on-runner — ตามเงื่อนไข owner/CTO ของ WO-1 Sprint 2

ทุก WO มี DoD แยกเป็น **worktree-local** (ทำได้เลย) กับ **deferred/post-close (CTO-gated)** — ห้ามเบลอทั้งสองส่วน

---

## WO-1 · Lane P-PLAYBOOK (P1) — Pattern Playbooks ของคลาส micro-DCR ที่ซ้ำ (doc-only · PROPOSAL · รอ owner ratify)

### 1.1 ตัวตนงาน

| | |
| --- | --- |
| Lane / Task id | P-PLAYBOOK (TEAM-ENHANCEMENT-RETRO §2 แถว 1 — ข้อเสนออันดับ 1 ตาม impact/effort · สืบทอดจากหลักฐาน consent trail ของคืน 2026-10-13/14) |
| ผู้รับงาน | **normal worker Flash** |
| Branch / Worktree | `docs/sprint3-p-pattern-playbooks` · `D:/LTC-w4` (สร้างด้วยคำสั่ง §0.1) |
| ปัญหา | ไมโคร-DCR ที่ถูกต้องแต่ซ้ำคลาสเดิม (ปรับเพดานเวลาตามการวัด · ซ่อม portability ของ spawn · เก็บกวาด stale state) ต้องเดิน full consent round (pm+qa+GO) ทุกครั้ง ทั้งที่หลักฐานสามรอบที่ผ่านมา (teardown-guard · amendment-1 · round-2 ของ MFA) พิสูจน์แล้วว่ารอบที่ "ถามแคบ + มีเกณฑ์พิสูจน์" จบรอบเดียว — ความซื้อ overhead 2–4 round-trip/สปรินต์ |
| User story | ในฐานะทีม ฉันต้องมี pattern playbooks ที่ owner/CTO ให้สัตยาบันล่วงหน้า ระบุว่าคลาสการเปลี่ยนแปลงใด "CTO ออกได้เอง + บันทึกพิสูจน์หลังทำ (post-hoc audit)" เพื่อให้ micro-DCR ที่ซ้ำจบในรอบเดียว โดยสิ่งที่วัดได้ยังถูกกันด้วยเกณฑ์พิสูจน์ที่เข้มเท่าเดิมทุกประการ |
| สถานะเอกสาร | **PROPOSAL** — การเปลี่ยนกระบวนการเป็นสิทธิ์ owner (retro §2 แถว 1 ระบุ "สิทธิ์อนุมัติ: **owner** (กระบวนการ)") → ratify ที่ sprint close เท่านั้น · ก่อน ratify = เอกสารอ้างอิง ไม่ใช่อำนาจ |

### 1.2 สัญญา (verbatim จากต้นทาง — ห้ามตีความเอง)

**(ก) ข้อเสนอต้นทาง — TEAM-ENHANCEMENT-RETRO §2 แถว 1 คัดตรง:**

> "**Playbook ชั้นเร็วสำหรับคลาสเปลี่ยนแปลงที่ซ้ำ** — budget-with-measurement · docker-start/portability-bypass · การซ่อม provisioning ใต้อำนาจ delegated: กำหนดแบบแผนล่วงหน้าใน charter ว่าคลาสเหล่านี้ CTO ออกได้เอง + บันทึกพิสูจน์หลังทำ (post-hoc audit) แทนรอ consent ก่อน" — หลักฐานที่หนุน: "สามรอบที่ถามแคบ+มีเกณฑ์พิสูจน์ (teardown-guard · amendment-1 · round-2 ของ MFA) จบรอบเดียว · object จริงเกิดจากขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์สเท่านั้น" · Impact สูง (ตัด round-trip 2–4 รอบ/สปรินต์) · Effort ต่ำ (เขียน charter เพิ่ม 1 หน้า) · **สิทธิ์อนุมัติ: owner (กระบวนการ)**

**(ข) คลาสที่ต้องเข้ารหัส (3 คลาส ตาม lane charter) — พร้อมหลักฐาน/บรรทัดอ้างอิงที่ playbook ต้องนำไปแปะ:**

**คลาส 1 · measured-ceiling bumps** (ปรับเพดานเวลาของเทสตามการวัด — ตัวเลขเวลาเท่านั้น assertion/invariant คงเดิม):

- หลักฐานที่ต้องมีครบก่อน fast-track ("trigger evidence"):
  1. **two-run measurement (two-strike)** — สองรอบวัด จากสอง log จริง ไม่ใช่ความรู้สึก (ต้นแบบ: rr-dcr9 ล้ม 6 เคส "ที่ 30000ms พอดีหมด ไม่มี assertion fail เดียว" + rb3-dcr9 ก่อนหน้า — DCR-SUITE-STABILITY-R2 §หลักฐาน ข้อ 3)
  2. **exact-timeout zeros** — ค่าล้ม = ค่า timeout พอดี (30000ms/300_022ms) **และ zero assertion failures in the failing set** (ต้นแบบ: BR Amendment 1 — "rr เขียว 288,703ms = 96.2% ของเพดาน 300s · rr2 แดงที่ 300,022ms พอดี — ไร้ assertion fail ทั้งสามรอบ")
  3. **family-ratio scale** — อัตราที่ขอต้องอยู่ในสเกลของครอบครัวที่ GO ไปแล้ว: ×2.5 ตามแบบแผน (dcr9 30→75 · probe 5→30 — DCR-BARRIER-REBASELINE §ทางแก้) หรืออัตราที่อธิบายได้เทียบเวลาจบจริง (2.08× ของ 288.7s วัดจริง — R2 Amendment 1)
  4. **sibling utilization scan** — สแกนเทสพี่น้องในไฟล์เดียวกันว่ายืนได้สบาย (ต้นแบบ one-liner: "max non-subject = waveh-r8 ที่ 57.3% ของ 120s" — R2 Amendment 1 pm CONSENT)
  5. **recorded baseline row** — หน้าที่บังคับตอน merge: บันทึกแถว baseline ceiling ใน PROJECT-STATE ครบ "ชื่อเทส+ตำแหน่ง (:1582) + ค่าวัดสามรอบ + one-liner sibling scan" และ "ห้ามขยับอีกโดยไม่มีการวัดใหม่" (binding pm ของ R2 ฉันทามติสมบูรณ์ + Amendment 1 · ต่อเนื่องเป็นตาราง baseline ceiling รวมของ barrier suite — BR แผนพิสูจน์ข้อ 3)
- บรรทัดอ้างอิงต้นแบบ (precedents ที่ต้อง cite ใน playbook): `DCR-SUITE-STABILITY-R2.md` จุด 2 + Amendment 1 · `DCR-BARRIER-REBASELINE.md` §ทางแก้ (อัตรา ×2.5) · `DCR-GATEWAY-ERRBODY-REBASELINE` (หลักคำสอน "budget = เพดาน ขยับได้ด้วยการวัดใหม่เท่านั้น" — อ้างผ่าน R2 filing)

**คลาส 2 · host-portability spawns** (npx/sh/compose-start class):

- รูปแบบข้อบกพร่องที่ซ้ำ + กฎ fast-track:
  1. **spawn npx ตายบน Windows (ENOENT)** — แก้แบบ `process.execPath` + ชี้ bin ตรง (`node_modules/vitest/vitest.mjs`) — **array-form spawn เสมอ ไม่ผ่าน shell** (ไม่มีพื้นผิว quoting) · binding สามข้อของ Addendum 3: (ก) argv เริ่มที่ `"run"` ห้ามเหลือคำ `vitest` หลงเหลือ (ข) `FORCE_COLOR:"0"` เป็น load-bearing ของ stdout-assertion ห้ามแตะ (ค) รอบพิสูจน์ต้องเห็น **child markers ใน output จริง** ไม่ใช่แค่ RC เขียว (DCR-TEST-HARNESS-PORTABILITY Addendum 3 · `tests/barrier-proof/barrier-harness.ts:638` — อ่านอ้าง ห้ามแตะ)
  2. **`exec sh` ใน container ที่ image ไม่มี shell (image drift)** — เปลี่ยนเป็น `docker inspect --format` array-form · **TEMPLATE ต้องเป็น `{{range .Config.Env}}{{println .}}{{end}}` เท่านั้น ห้าม bare `{{.}}`** · loud-fail guards ครบ (rc≠0 → throw · stdout ว่าง → throw · ทุกบรรทัดต้อง match `KEY=VALUE` · tripwire เห็นคีย์ที่รู้จัก · **validated-zero คืน green path เดิม** — ห้ามตีความ zero เป็น throw) (THP จุด 3 แถว `[แก้ตาม qa round-1 ทั้งสามข้อ]`)
  3. **`docker compose start <svc>` ประเมิน depends_on ใหม่จนล้ม** — เปลี่ยนเป็น `docker start <container_name>` ตรง (ต้นแบบ: startMailer ล้ม 7 จุด → `docker start ltc-dev-mailer` — R2 จุด 1) · **deadline completion**: ทุกจุดต้องมี deadline (60s) + warning fail-loud greppable (`grep "startMailer ล้ม"` = 0 คือเกณฑ์พิสูจน์) คงไว้ครบ
  4. บทเรียนข้ามชั้น: "ชั้นวัดของ launcher โกหก (cmd.exe /c ตัดคำ SQL) — ครั้งหน้าต้อง spawn array-form" (PROJECT-STATE:804) · `exec` ผ่าน shell โดยไม่จำเป็นคือหนี้เทคนิคทุกจุดที่เจอ
- บรรทัดอ้างอิง: `DCR-TEST-HARNESS-PORTABILITY.md` จุด 3 + Addendum 3 · `DCR-SUITE-STABILITY-R2.md` จุด 1 · PROJECT-STATE:804

**คลาส 3 · stale-state hygiene**:

- รูปแบบข้อบกพร่องที่ซ้ำ + กฎ:
  1. **RUN_ID collisions ข้ามรัน** — ledger append-only + `ledgerRead` อ่านทุกแถวของ run_id → รันใหม่ที่ใช้ RUN_ID เดียวกับรันก่อน (ที่ตายกลางทางแต่เขียนแถวไปแล้ว) จะเห็นแถวของรันก่อนปนเปื้อน (หลักฐาน: 8f f2 ล้มที่แถว `cleanup-start ts=23:37:34.93` ของ **battery r38 รอบสอง 06:36** ที่ตายที่ child spawn แต่ 8e3/8f เขียนแถวไปแล้ว · f3/f4a = cascade — DCR-BARRIER-REBASELINE §การค้นพบกลางทาง)
  2. **ledger pre-run audit/truncate** — battery มีกันชน `assertLedgerFresh` อยู่แล้ว (`scripts/battery-run.mjs:134-150` — check-and-fail + ทางเคลียร์: audit `--truncate` / เคลียร์มือ) — กฎ: **launcher ใดก็ตามที่ตั้ง RUN_ID เอง ต้องจำลองกันชนนี้** (สุขลักษณ์ข้อ 0 ของ BR: audit ledger ก่อน clean-run · "ไม่แก้เทส 8f แม้แต่บรรทัดเดียว — แก้ที่ขั้นตอน")
  3. **two-strike rule** — อาการที่เคยปิดด้วยเหตุ suite-pollution ห้ามจัดเป็น flake อีก: ล้มซ้ำแม้ครั้งเดียวหลัง fix = เปิด ticket สอบสวนแยกทันที (binding pm รอบ 1 ของ THP)
  4. **no-overlap + detached launcher** — "ห้ามรันสวีทซ้อนเด็ดขาด" + ทุก long run ใช้ detached launcher เท่านั้น (PROJECT-STATE:771 — cmd ตาย vitest รอด → cross-cleanup ลบ user กันเอง)
- บรรทัดอ้างอิง: `DCR-BARRIER-REBASELINE.md` §การค้นพบกลางทาง + แผนพิสูจน์ข้อ 0 · `DCR-TEST-HARNESS-PORTABILITY.md` รอบ 1 (binding pm) · PROJECT-STATE:771

**(ค) สิ่งที่ยังต้อง full gate เสมอ (เขียนชัดในทุก playbook):** การแตะ `src/**` · การแก้ assertion/invariant/fence semantics (ไม่ใช่แค่ตัวเลขเวลา) · การลดหรืองด assertion ใด ๆ ("ไม่แตะลด assertion ใด ๆ" — THP ขอบเขตคงที่) · การแตะ `docker-compose.yml`/image/digest (คำถามของ DCR-PROD-DEPLOY) · การเปลี่ยน global testTimeout ของ config · ขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์ส — ตามหลักฐานของ retro ว่า "object จริงเกิดจากขอบเขตกว้าง/คำอ้างที่ไม่ตรงซอร์สเท่านั้น"

**(ง) ธรรมนีย์ PROPOSAL:** หัวเอกสารต้องระบุ "PROPOSAL — รอ owner ratify ที่ sprint close (สิทธิ์อนุมัติ: owner · retro §2 แถว 1)" และทุกคลาสปิดท้ายด้วยหน้าที่ post-hoc audit: **การใช้ fast-track ครั้งแรกของแต่ละคลาสต้องมีบันทึกพิสูจน์หลังทำ และยังอยู่ใต้อำนาจ CTO ถอนหากหลักฐานไม่ครบ**

### 1.3 โครงเอกสารที่กำหนด (worker เขียนตามโครงนี้ — ภาษาไทย · สไตล์ repo เดียวกับ DCR 09-dev)

1. หัวเอกสาร: ชื่อ `PATTERN-PLAYBOOKS` · สถานะ PROPOSAL · ผู้เขียน/วันที่ · แหล่งกำเนิด (retro §2 แถว 1 + consent trail ที่ย่อยมา) · นิยามคำ (micro-DCR · fast-track · post-hoc audit · baseline ceiling)
2. ตารางสารบัญคลาส (3 แถว: คลาส · trigger evidence · สิ่งที่ fast-track ได้ · สิ่งที่ยังต้อง full gate · หน้าที่ baseline-table)
3. หนึ่ง section ต่อหนึ่งคลาส ครบสี่หน้าที่: (ก) trigger evidence required (ข) fast-track criteria (ค) what still needs full gate (ง) ceiling/baseline-table duty — พร้อมบรรทัดอ้างอิง §1.2(ข) ทุกประเด็น
4. **Gherkin acceptance criteria ต่อคลาส** (เขียนก่อนเนื้อความ — test-first · แบบแผน WAVE-J §5) — อย่างน้อย 2 scenario ต่อคลาส: "ครบหลักฐาน → fast-track + post-hoc audit" และ "ขาดหลักฐานข้อใดข้อหนึ่ง → กลับ full gate" (ตัวอย่างคลาส 1 อยู่ที่ §1.5 ข้อ 2 ของ WO นี้ — ใช้เป็นจุดตั้งต้นได้)
5. ตาราง "ครั้งที่ใช้แล้ว" (ว่างไว้ — จะเติมเมื่อ ratify แล้วมีการใช้จริง · คอลัมน์: วันที่ · คลาส · ผู้ออก · หลักฐานที่แนบ · post-hoc audit ผล)
6. ท้ายเอกสาร: fences (playbook ไม่ใช่ใบอนุญาตข้าม gate ของงานนอกสามคลาส) + การอ้างอิงกลับไป retro/backlog

### 1.4 EXACT file list (WO-1 แตะเท่านี้ — ใน `D:/LTC-w4`)

| ไฟล์ (path จริงใน tree) | การกระทำ | เช็คกลาง |
| --- | --- | --- |
| `docs/09-dev/PATTERN-PLAYBOOKS.md` | **สร้างใหม่** | ยังไม่มีใน tree (ตรวจแล้ว 2026-10-14 · dir `docs/09-dev/` มี DCR อื่น 17 แฟ้ม) |
| `docs/TEAM.md` | **แก้ — เพิ่ม 1 section เดียวท้ายเอกสาร** (อ้าง PATTERN-PLAYBOOKS + สถานะ PROPOSAL รอ owner ratify) | มีอยู่จริง 67 บรรทัด (In-House Dev Team Charter) · ห้ามแตะ section อื่นแม้บรรทัดเดียว · diff ต้องเป็น purely-additive |

- **อ่านได้ (grounding ห้ามแก้)**: `docs/09-dev/DCR-SUITE-STABILITY-R2.md` · `docs/09-dev/DCR-BARRIER-REBASELINE.md` · `docs/09-dev/DCR-TEST-HARNESS-PORTABILITY.md` · `docs/09-dev/TEAM-ENHANCEMENT-RETRO.md` (§2) · `PROJECT-STATE.md` (แถว lessons ที่ :751 · :762 · :771 · :804 · :813) · `docs/backlog.md` (BL-014/BL-015)
- **ห้ามแก้**: ทุก DCR ต้นทาง (playbook อ้างอิง ไม่แก้ต้นฉบับ) · `docs/backlog.md` · `PROJECT-STATE.md`

### 1.5 ขั้นตอนแบบ test-first (ทำตามลำดับ — เอกสารคือชิ้นงานหลัก)

1. สร้าง worktree (§0.1) · อ่านไฟล์ grounding §1.4 พร้อมจด: หลักฐาน/อัตรา/binding ของแต่ละคลาสตาม §1.2(ข) — ห้ามเรียบเรียงจากความจำ ต้อง copy ตัวเลข/ข้อความ binding จากต้นฉบับพร้อมอ้าง §/file:line
2. **เขียน Gherkin AC ของทั้ง 3 คลาสก่อนเขียนเนื้อความ** (commit แรก = โครง + Gherkin อย่างเดียว — ให้ history ยืนยันลำดับ test-first ได้เหมือน WO-2 ของ Sprint 2) — จุดตั้งต้นคลาส 1:

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
```

3. เขียนเนื้อความตามโครง §1.3 ให้ครบทั้งสามคลาส — ทุกตัวเลข/กฎ copy จาก §1.2(ข) พร้อมอ้างอิงกลับต้นฉบับ (เช่น "ตาม binding ของ R2 Amendment 1")
4. Self-review checklist: ทุกคลาสมีครบ 4 หน้าที่ (trigger/fast-track/full-gate/baseline-duty) · ทุก Gherkin "Then" ตรวจได้จากหลักฐานที่ระบุชื่อ · สถานะ PROPOSILITY ปรากฏที่หัวเอกสาร + ท้ายเอกสาร
5. เพิ่ม section เดียวใน `docs/TEAM.md` ท้ายเอกสาร (2–6 บรรทัด): มี playbook อยู่ที่ path · สถานะ PROPOSAL รอ owner ratify · ใช้ได้เมื่อ ratify แล้วเท่านั้น
6. ตรวจ overlap: `git -C D:/LTC-w4 diff --stat develop` ต้องได้ **2 ไฟล์เท่านั้น** (1 ใหม่ + TEAM.md) · ศูนย์ไฟล์อื่น
7. Commit ลง branch (แยก commit: โครง+Gherkin ก่อน · เนื้อความ · TEAM.md) · push branch ได้ — **ห้ามเปิด PR** · รายงานกลับตาม §1.6 worktree-local DoD

### 1.6 DoD

**Worktree-local (เสร็จได้เลย — สิ้นสุดงาน WO-1):**
- [ ] `docs/09-dev/PATTERN-PLAYBOOKS.md` ครบทั้ง 3 คลาส × 4 หน้าที่ + Gherkin AC อยู่ก่อนเนื้อความ (มี history ยืนยันลำดับ) + สถานะ PROPOSAL ที่หัว/ท้าย + อ้างอิงต้นฉบับครบตาม §1.2(ข)
- [ ] `docs/TEAM.md` เพิ่ม section เดียว purely-additive (diff ไม่มีบรรทัดเดิมถูกลบ/แก้)
- [ ] `git -C D:/LTC-w4 diff --stat develop` = 2 ไฟล์เท่านั้น · ศูนย์การรัน docker/DB · ศูนย์การแตะ tests/src/scripts

**Deferred (owner/CTO-gated):**
- [ ] **owner ratify ที่ sprint close** (สิทธิ์ owner ตาม retro §2 แถว 1) → สถานะ PROPOSAL → ACTIVE · PM บันทึกใน PROJECT-STATE + backlog
- [ ] การใช้จริงครั้งแรกของแต่ละคลาส = หนึ่งรอบ post-hoc audit ก่อนถือว่า playbook proven (ครั้งแรกยังแนะ pm/qa ดู 1 รอบ)
- [ ] เมื่อ ratify แล้ว: CTO พิจารณาเชื่อม playbook เข้า charter/dispatch mechanics ของทีม (ส่วนของ owner charter รอบถัดไป — นอก WO นี้)

### 1.7 Out-of-scope fences (ห้ามทำเด็ดขาด)

- ห้ามเปลี่ยนสถานะเอกสารเป็น ACTIVE/ratified เอง — owner เท่านั้น
- ห้ามเพิ่มคลาสที่สี่นอกสามคลาสของ charter (เช่น environment-hardening bundle ของ retro แถว 2 = ตั๋วของ CTO คนละเรื่อง) · ห้ามเขียนให้ playbook ครอบงาน `src/**`/compose/image/digest
- ห้ามแตะ DCR ต้นทาง/retro/backlog/PROJECT-STATE ใด ๆ (รวมการ "ช่วยแก้" ตัวเลขที่ดูเพี้ยน — จดเป็นหมายเหตุส่ง PM แทน)
- ห้ามรันอะไรที่แตะ docker/DB · ห้ามเปิด PR/merge

### 1.8 ASSUMPTION (CTO confirm)

- **A-1**: charter อ้าง "TEAM-ENHANCEMENT-RETRO #2" — PM ตีความเป็น **§2 ของ retro (ตารางข้อเสนอ)** ซึ่ง **แถว 1** คือข้อเสนอ Playbook (ตรงวัตถุประสงค์เลน) · แถว 2 จริง ๆ คือ Environment-hardening bundle (คนละเรื่อง) — ถ้า CTO ตั้งใจแถว 2 ต้องสั่งแก้ scope ก่อนปล่อยงาน
- **A-2**: ตัวเลข "11 review rounds" เป็นเฟรมของ charter — trail ที่ PM นับได้จากเอกสารจริง = **9 รอบ consent หลัก** (R2 base + R2-A1 · BR base + BR-A1/A2/A3 · THP รอบ 1 + รอบ 2 + Addendum 3) + การค้นพบกลางทางที่ขอ ruling 2 จุดของ BR (proof #1) ≈ 11 — playbook ให้อ้าง**รายการ trail ที่นับได้** ไม่อ้างตัวเลขรวมลอย ๆ
- **A-3**: การแตะ `docs/TEAM.md` (เอกสารมีอยู่) เป็นข้อยกเว้นเดียวของ constraint (b) ตาม lane charter ("the one named existing doc") · ขอบเขต = เพิ่ม section เดียวท้ายเอกสาร purely-additive

---

## WO-2 · Lane P-UAT09SPEC (P2) — Playwright e2e specs ของ UAT-09A–D (authoring ใน worktree · execution เป็นของ post-close)

### 2.1 ตัวตนงาน

| | |
| --- | --- |
| Lane / Task id | P-UAT09SPEC (ต่อเนื่อง Lane J-UAT09 ของ Sprint 2: สเปกผ่านแล้ว → รอบถัดมาคือโค้ดสเปก) |
| ผู้รับงาน | **main worker GLM-5.3** (ผู้รัน: tester agent — post-close เท่านั้น) |
| Branch / Worktree | `feat/sprint3-p-uat09-specs` · `D:/LTC-w5` (สร้างด้วยคำสั่ง §0.1) |
| ปัญหา | `docs/07-results/UAT-09-SPECS-DRAFT.md` (branch `docs/sprint2-j-uat09-specs` · worktree `D:/LTC-w2` มีอยู่) นิยาม 21 scenarios/36 ขั้นครบสี่กลุ่ม 09A–D แต่ยังเป็น Gherkin บนกระดาษ — ต้องแปลงเป็น specs Playwright จริงเพื่อให้ tester agent รันได้ทันทีหลัง close drained โดยไม่ต้องวิเคราะห์อะไรตอน execute ("ไม่มีการวิเคราะห์ค้างอยู่ตอน execute") |
| User story | ในฐานะ PM/tester ฉันต้องมีชุด specs Playwright ใต้ `tests/e2e/` ที่ map 21/21 scenarios ของ UAT-09 พร้อม fixtures (บัญชี seed · TOTP self-compute · Mailpit · หลักฐาน step-NN.png) เพื่อให้ execution หลัง close เหลือเพียง "ต่อสาย config + กดรันตามกฎ P8/re-seed" |

### 2.2 สัญญา (verbatim จาก UAT-09-SPECS-DRAFT.md — ห้ามตีความเอง)

**ที่มาของไฟล์**: อ่านจาก `D:/LTC-w2/docs/07-results/UAT-09-SPECS-DRAFT.md` (363 บรรทัด · branch `docs/sprint2-j-uat09-specs`@`b01f435`) หรือจาก `origin/docs/sprint2-j-uat09-specs` — **อ่านอย่างเดียว ห้ามแก้ไฟล์นี้**

**(ก) นิยามสี่กลุ่ม (§3.1–§3.4 คัดตรง — ชื่อ section + ขอบเขต):**

> - **§3.1 กลุ่ม UAT-09A — ลืมรหัสผ่าน → รีเซ็ตผ่านอีเมล (F1 · บัญชี `uat.citizen@ltc.local`)** — scenarios A-1..A-6 (หน้าแสดงครบ+validate อีเมล · anti-enumeration ข้อความเดียวกัน · อีเมลไม่มีในระบบ [ทางเลือก — N/A ได้ถ้าชน rate limit] · ลิงก์จาก Mailpit พาถึงฟอร์ม + token ไม่ค้าง address bar · ตรวจความยาว/ตรงกันของรหัส · ตั้งรหัสสำเร็จ — รหัสเก่าถูกปฏิเสธ รหัสใหม่เข้าได้)
> - **§3.2 กลุ่ม UAT-09B — เปลี่ยนรหัสผ่าน + ออกจากระบบทุกเครื่อง (F2+F3 · บัญชี `uat.staff.exam@ltc.local`)** — scenarios B-1..B-5 (ล็อกอินสองขั้นสด + หน้า security ครบสามส่วน · รหัสปัจจุบันผิด · นโยบาย/ยืนยันไม่ตรง [ทางเลือกอย่างน้อย 1 กรณี] · เปลี่ยนสำเร็จเซสชันคงอยู่+รหัสเก่าตาย · logout-all ทุก context ตายจริง แล้วกลับมาล็อกอินได้)
> - **§3.3 กลุ่ม UAT-09C — โมดัล "+ เพิ่มกติกา version ใหม่" + exam_review_mode (F4 · `/admin/assessments` · อ่านอย่างเดียว — กดยกเลิก ไม่บันทึกจริง)** — scenarios C-1..C-5 (เปิดโมดัลจากปุ่มเดียวระดับหน้า · เลือก EXAM-UAT-201 แล้ว prefill · ฟอร์มครบ 10 รายการรวม "การเปิดเฉลยหลังสอบ" · สองค่า after_final_attempt/never สลับได้ · ยกเลิกไม่สร้าง version ใหม่)
> - **§3.4 กลุ่ม UAT-09D — หน้ารายละเอียดคลังข้อสอบ (F5 · `/admin/question-banks/{id}` · อ่านอย่างเดียว — เปิดโมดัลแก้ไขแล้วปิดโดยไม่แก้)** — scenarios D-1..D-5 (ข้อมูลหัวคลังครบ · ตารางไม่เผยเฉลย · ป้ายสถานะ+ปุ่มตามสถานะจริง · EditQuestionModal โหลดครบ · ยกเลิกไม่บัง version+1)

- ตัวเลข ground truth: **21 scenarios (6+5+5+5) · 36 ขั้น click-level (12+12+6+6)** — ตาราง §4 ของสเปกคือรายละเอียดระดับปุ่ม/หลักฐานประกอบ (step-NN.png ต่อขั้น)

**(ข) กฎลำดับการรัน (§0 คัดตรง — specs ต้องพกกฎนี้ไปด้วย):**

> 1. "**เงื่อนไขเริ่ม 09 ทั้งรอบ**: รอบหลัก UAT-01..08 **จบทั้งรอบแล้ว (P8)** — หรือถ้าถูกสั่งให้รันก่อนรอบหลักจบ ต้องไม่กลับเข้าสคริปต์รอบหลักที่ยังไม่ได้รันโดยไม่ re-seed ก่อน"
> 2. "**ลำดับที่กำหนด**: `P8 เสร็จ → 09A → re-seed → 09C → 09D → 09B → re-seed (คืนฐานส่งมอบ)`" (เหตุผลในสเปก: 09A เปลี่ยนรหัส citizen → re-seed คืนค่าก่อนแตะบัญชีอื่น · 09C/09D อ่านอย่างเดียวจึงวางก่อน 09B ได้ปลอดภัย · 09B จบด้วย logout-all + รหัสใหม่ → re-seed ปิดท้าย)
> 3. "คำสั่ง re-seed: `bash scripts/uat-seed.sh` (idempotent — รันซ้ำ = ตั้งรหัสผ่านทุกบัญชีกลับเป็นค่า `UAT_DEMO_PASSWORD`) · หลัง re-seed **MFA factor ของบัญชีเจ้าหน้าที่ยังอยู่เดิม**"
> 4. ห้าม: ห้ามเริ่ม 09A/09B เมื่อมีสคริปต์อื่นค้างอยู่กลางทาง · ห้ามข้ามขั้น re-seed ที่กำหนด · ห้ามแก้ `scripts/uat-seed.sh`
> 5. "ถ้ารหัสเพี้ยนระหว่างรัน … ทางกู้เดียว = re-seed แล้วเริ่มสคริปต์นั้นใหม่ — จดเหตุลง run-log.md"

**(ค) เงื่อนไข runtime/บัญชี (§1 + หัวเอกสาร คัดตรง):** runtime `http://localhost:3001` (prod-build) · Mailpit `http://localhost:8025` (`GET /api/v1/messages`) · บัญชี `uat.citizen@ltc.local` (09A) · `uat.staff.exam@ltc.local` (09B/09C/09D) รหัสเดียวจาก `UAT_DEMO_PASSWORD` · MFA: secret แสดงเป็นข้อความที่ `/my/security/enroll` — คำนวณ TOTP เองได้ · เก็บ secret ที่ `mfa/<บัญชี>.md` **ห้าม commit** (ตามแบบแผน UAT-EXECUTION-PLAN §2/§3: path จริง = `.omc/artifacts/uat/${RUN_ID}/mfa/<บัญชี>.md` — `.omc/` ถูก gitignore อยู่แล้ว) · หลักฐาน `${RUN_ID}/uat-09x/step-NN.png` จับก่อนไปขั้นถัดไปเสมอ

**(ง) สิ่งที่สืบทอดให้ specs เป็นเงื่อนไขพฤติกรรม (§6 X-1..X-3 ของสเปก):** 09B **ไม่คาดหวังการ์ด need-mfa บนเส้นทางเปลี่ยนรหัสผ่าน** (re-auth = ช่อง "รหัสผ่านปัจจุบัน") — เห็นการ์ดนั้น = fail พร้อมจด "สิ่งที่เห็นจริง" · 09C ปุ่มเปิดโมดัลเป็น**ปุ่มเดียวระดับหน้า** แล้วเลือกชุดในโมดัล · 09D ปุ่มสถานะเป็นป้ายไดนามิก "เปิดใช้งาน"/"ปลดจากการใช้งาน" (ไม่ใช่คำว่า "เปลี่ยนสถานะ")

**(จ) fences ของรอบเสริม (§7):** 09C ห้ามกด "บันทึกกติกา version ใหม่" · 09D ห้ามกด "บันทึกการแก้ไข" และห้ามยืนยันเปลี่ยนสถานะข้อ · ไม่เพิ่มบัญชี seed ใหม่ · ข้อมูลของรอบหลักต้องไม่ถูกกระทบ

### 2.3 แบบบ้านที่ specs ต้องเลียนแบบ (อ่านจาก tree จริงแล้ว — ห้ามแก้ต้นฉบับ)

| แบบแผน | แหล่งจริง (อ่านอ้าง) |
| --- | --- |
| โครง spec: หัวคอมเมนต์ไทย (ขอบเขต+สัญญา+ธง "ห้ามรันตอนนี้") · `test.describe` ชื่อไทย · cleanup ใน before/afterAll | `e2e/e2e-17-password-change.spec.ts` · `e2e/e2e-20-question-bank-admin.spec.ts` (หัวไฟล์) |
| **TOTP self-compute** (RFC 6238 · HMAC-SHA1 · 6 หลัก · ช่วง 30 วิ · base32 decode เอง) | `e2e/d9-helpers.ts:370` (`totpNow`) · ใช้ผ่าน `loginViaForm(page, email, { totpSecret })` ที่ `e2e/helpers/session.ts` (กรอก `#code` + ปุ่ม "ยืนยันตัวตน") |
| login ผ่านฟอร์มจริง — **เตือน**: `loginViaForm` ผูก `TEST_PASSWORD` ของ `e2e/helpers/env.ts` — UAT-09 ใช้ `UAT_DEMO_PASSWORD` → fixtures ต้องมี login ของตัวเองที่ parameterize รหัส (มิเรอร์รูป `loginWithPassword` ของ e2e-17) | `e2e/helpers/session.ts` · `e2e/e2e-17-password-change.spec.ts:47-57` |
| Mailpit poll ลิงก์ recovery (poll 1 วิ · ห้าม token หลุดลง log/error ทุกชนิด) | `e2e/e2e-19-password-reset.spec.ts:51-70` (`recoveryMailId` · `MAILPIT_ORIGIN` = `E2E_MAILPIT_URL` ?? :8025) |
| สอง context = สองเครื่อง (browser.newContext แยก cookie jar) | `e2e/e2e-18-logout-all.spec.ts:36-40` |
| env loader ฝั่ง worker (อ่าน `.env` เอง · ห้าม log ค่า secret) | `e2e/helpers/env.ts` (รูป `TEST_USER_PASSWORD`/`E2E_BASE_URL` — uat09 เพิ่ม `UAT_DEMO_PASSWORD`/`RUN_ID`/`E2E_MAILPIT_URL` ใน fixtures ของตัวเอง) |
| ชื่อไฟล์ kebab-case + `.spec.ts` | `e2e/e2e-NN-*.spec.ts` ทั้ง dir |

### 2.4 EXACT file list (WO-2 แตะเท่านี้ — ใน `D:/LTC-w5` · ทั้งหมด **ใหม่** ใต้ `tests/e2e/`)

| ไฟล์ (สร้างใหม่) | เนื้อหา | เช็คกลาง |
| --- | --- | --- |
| `tests/e2e/uat09/fixtures.ts` | fixtures กลาง: อ่าน `UAT_DEMO_PASSWORD`/`RUN_ID`/`E2E_BASE_URL`(:3001)/`E2E_MAILPIT_URL` · โหลด MFA secret จาก `.omc/artifacts/uat/${RUN_ID}/mfa/<บัญชี>.md` (fail-loud พร้อมวิธีเตรียม) · `totpNow` (มิเรอร์ d9-helpers:370 หรือ import — A-6) · login แบบ parameterize รหัส+TOTP · Mailpit poll · ตัวช่วยจับภาพ `step-NN.png` ไป `.omc/artifacts/uat/${RUN_ID}/uat-09<x>/` ตาม §4 ของสเปก | ไดเรกทอรี `tests/e2e/` ยังไม่มีใน tree (ตรวจแล้ว) — สร้างใหม่ทั้งชั้น |
| `tests/e2e/uat09/uat-09a-password-reset.spec.ts` | scenarios A-1..A-6 (§3.1 + ตาราง §4 09A 12 ขั้น) | ชื่อไฟล์ kebab ตามแบบบ้าน |
| `tests/e2e/uat09/uat-09b-password-change-logout-all.spec.ts` | scenarios B-1..B-5 (§3.2 + 12 ขั้น · สอง context) | 〃 |
| `tests/e2e/uat09/uat-09c-assessment-rules-modal.spec.ts` | scenarios C-1..C-5 (§3.3 + 6 ขั้น · อ่านอย่างเดียว) | 〃 |
| `tests/e2e/uat09/uat-09d-question-bank-detail.spec.ts` | scenarios D-1..D-5 (§3.4 + 6 ขั้น · อ่านอย่างเดียว) | 〃 |

- **ห้ามแก้/ห้ามสร้างนอกรายการนี้**: `playwright.config.ts` (testDir ยังเป็น `./e2e` — การต่อสายเป็นของ execute lane · A-4) · `e2e/**` · `tests/integration/**` · `tests/barrier-proof/**` · `package.json` · `tsconfig.json` · `eslint.config.mjs` · ไฟล์ config ใหม่ใดที่ root
- ตรวจแล้ว: root `tsconfig.json` include `**/*.ts` → ไฟล์ใหม่**ถูกตรวจโดย `npx tsc --noEmit` อยู่แล้วโดยไม่ต้องแต้อ config · vitest สามชุด include ไม่ชน (`src/**` / `tests/integration/**` / `tests/barrier-proof/**`) — ไฟล์ `.spec.ts` ใต้ `tests/e2e/` ไม่โดนหยิบของใครเลย

### 2.5 ขั้นตอนแบบ test-first (ลำดับบังคับ — scenario trace ก่อนโค้ด)

1. สร้าง worktree (§0.1) · `npm install` ใน worktree (node_modules ไม่ตาม worktree มา — ใช้ network อย่างเดียว ไม่แตะ docker/DB)
2. **เขียนตาราง scenario-to-spec trace ก่อนเขียนโค้ด** (นี่คือ "เทสของเทส" ของงานนี้): 21 แถว — คอลัมน์ scenario (A-1..D-5) · §ref ของสเปก · ไฟล์ spec ปลายทาง · ชื่อ `test()` ที่จะใช้ · ขั้น step-NN ที่ครอบ — commit เป็นไฟล์โน้ตชั่วคราวหรือใน commit message ก็ได้ แต่ต้องมีอยู่ก่อน spec แรกถูกเขียน (ประกอบเข้ารายงานส่ง PM — §2.6)
3. เขียน `fixtures.ts` ก่อน (ทุก spec พึ่งมัน) — ครบตาม §2.4 แถวแรก · ห้าม log รหัสผ่าน/token/TOTP secret ลง output หรือ error message ทุกชนิด (แบบแผน MAJOR-1 ของบ้าน)
4. เขียน 4 specs ตาม trace — ทุก test ตั้งชื่อฝัง scenario id (เช่น `test("A-1 หน้าลืมรหัสผ่านแสดงครบ...")`) · ทุกขั้นที่สเปกกำหนดหลักฐาน เรียกตัวช่วยจับภาพ **ก่อน** ไปขั้นถัดไป · ป้ายปุ่ม/ข้อความไทย copy จากสเปก §3/§4 เท่านั้น (ห้ามเดา — สเปกอ้างโค้ด as-built ไว้แล้ว)
5. เขียน ordering notes ลงหัว `fixtures.ts` (คอมเมนต์): ลำดับ §0 ข้อ 2 + กฎ P8/re-seed + "ห้ามรัน 09A/09B พร้อมสคริปต์อื่น" + สถานะ "ห้ามรันตอนนี้ — post-close เท่านั้น" (แบบแผน e2e-19/e2e-18 หัวไฟล์) · specs ออกแบบให้รันอนุกรมภายในกลุ่ม (1 worker semantics) — การบังคับ serial ข้ามไฟล์เป็นของ config ตอน execute
6. ผ่านชุดตรวจ worktree-local: (1) `npx tsc --noEmit` จาก root ของ worktree — **0 error** (ครอบไฟล์ใหม่อัตโนมัติตาม include `**/*.ts`) (2) specs parse = ข้อ (1) ผ่านแล้วถือว่า parse (3) เสริม (แนะนำ): `npx eslint tests/e2e` — 0 error
7. ตรวจ overlap: `git -C D:/LTC-w5 diff --stat develop` ต้องได้ **5 ไฟล์ ใหม่ทั้งหมด ใต้ tests/e2e/ เท่านั้น** — ยืนยันศูนย์ overlap กับ close-ladder (เทียบกับรายการไฟล์ที่ close-ladder แตะ: `tests/barrier-proof/w8o-guard-attempt-loop.test.ts` ฯลฯ)
8. Commit ลง branch (fixtures → specs รายกลุ่ม) · push branch ได้ — **ห้ามเปิด PR** · รายงานกลับพร้อม trace table 21/21

### 2.6 DoD

**Worktree-local (เสร็จได้เลย — สิ้นสุดงาน WO-2):**
- [ ] 5 ไฟล์ใหม่ใต้ `tests/e2e/` ครบตาม §2.4 · 21/21 scenarios มี test รับ (trace table แนบรายงาน) · 36 ขั้นมีหลักฐาน step-NN mapping
- [ ] `npx tsc --noEmit` ใน worktree = **0 error** · (แนะนำ) eslint 0 error
- [ ] ordering notes (P8 → 09A → re-seed → 09C → 09D → 09B → re-seed + กฎ §0 ข้อ 1/3/4/5) อยู่ในหัว fixtures · สถานะ "ห้ามรันตอนนี้" ทุกไฟล์
- [ ] `git -C D:/LTC-w5 diff --stat develop` = 5 ไฟล์ ใหม่ ใต้ tests/e2e/ เท่านั้น · ศูนย์ stack runs (ไม่มี `npx playwright test` จริง · ไม่มี `make`/docker/DB ใด ๆ)

**Deferred (post-close · CTO-gated — execution เป็นตั๋วของ tester agent):**
- [ ] **ต่อสาย config**: `playwright.config.ts` ปัจจุบัน testDir `./e2e` ไม่เห็น `tests/e2e/` — execute lane เลือกวิธี (ขยาย testDir / config แยก `playwright.uat09.config.ts` ใหม่ / CLI config) — A-4
- [ ] รันจริงบน `:3001` หลัง close drained + กฎ P8/re-seed ของสเปก §0 → verdict + หลักฐานครบ · ผล = verdict เสริมตาม A-4 ของ Sprint 2 (53 ขั้นบังคับของรอบหลักคงเดิม)
- [ ] ธง stale S-1..S-5 / X-1..X-3 ที่ยืนยันจริงจากการ execute → เปิด DCR แก้ UAT.md ผ่าน gate Brief §9 (ตามทะเบียนไว้ในสเปก §5-§6)

### 2.7 Out-of-scope fences (ห้ามทำเด็ดขาด)

- ห้ามแก้ไฟล์ใดที่มีอยู่ (โดยเฉพาะ `e2e/**` · `tests/integration/**` · `tests/barrier-proof/**` ของ close-ladder · `playwright.config.ts` · `scripts/uat-seed.sh` · `docs/07-results/UAT-09-SPECS-DRAFT.md` — พบข้อความ UI ต่างจากสเปก = จดส่ง PM ตามกฎ §4 ของสเปก ห้ามแก้เอง)
- ห้ามรันอะไรที่แตะ stack: ไม่มี `npx playwright test` (จะพยายามต่อ webServer/dev) · ไม่มี docker/DB/`make` · ไม่มีการเรียก Mailpit จริง
- ห้าม hardcode รหัสผ่านจริง/TOTP secret/ค่า canonical ใด ลง specs (อ่านจาก env/ไฟล์ secret เท่านั้น · ห้าม commit ไฟล์ secret)
- ห้ามขยายเป็นฟีเจอร์อื่นนอก 21 scenarios · ห้ามเพิ่มบัญชี seed ใหม่ (A-6b ของ Sprint 2) · ห้ามเบลอ execution เข้ามาทำล่วงหน้า

### 2.8 ASSUMPTION (CTO confirm)

- **A-4**: specs ใต้ `tests/e2e/` **จะไม่ถูกเลือกโดย config ปัจจุบัน** (testDir `./e2e`) — โดยเจตนาของ constraint (ศูนย์แต้มสัมผัสไฟล์เดิม) · การต่อสายเป็นของ execute lane post-close (ดู deferred DoD) — CTO ยืนยันแนวทางที่จะใช้ตอนนั้น
- **A-5**: fixtures อ่าน `UAT_DEMO_PASSWORD` จาก env ของเครื่องสาธิต + MFA secret จาก `.omc/artifacts/uat/${RUN_ID}/mfa/<บัญชี>.md` (ตามแบบแผน UAT-EXECUTION-PLAN · gitignored) — ถ้าไม่มีไฟล์ secret ตอน execute = fail-loud พร้อมคำแนะนำขั้นเตรียม (ลงทะเบียนผ่าน `/my/security/enroll` — ขั้นเตรียม ไม่ใช่ขั้นตรวจ ตาม Background ของ 09B)
- **A-6**: มิเรอร์โค้ดแบบบ้านใน fixtures (totpNow/login แบบ parameterize รหัส) อนุญาต — เหตุผลเดียวกับที่ `d9-helpers.ts` เคยมิเรอร์ id/SQL จาก helpers-d8 (ข้อจำกัด loader) · ทางเลือก import จาก `e2e/d9-helpers.ts` ได้ถ้าไม่ลาก dependency ที่ไม่จำเป็น — worker เลือกเองแล้วจดเหตุผลลงหัว fixtures
- **A-7**: ฐาน branch = `develop`@`65fbac9` (ก่อน merge ของ close-ladder — เหมือน Sprint 2) · rebase หลัง close drained โดยคำสั่ง CTO (สืบทอด ruling A-8 ของ Sprint 2)
- **A-9** (ทั้งสองเลน): push branch ขึ้น remote ได้ แต่ห้ามเปิด PR/merge จนกว่า CTO gate ผ่าน (สืบทอด ruling A-9 ของ Sprint 2)

---

## 9. ASSUMPTION Register (สรุปรวม — สำหรับ CTO gate ครั้งเดียว)

| # | เลน | สมมติฐาน | ผลถ้า CTO ไม่ยืนยัน |
| --- | --- | --- | --- |
| A-1 | P-PLAYBOOK | charter "RETRO #2" = §2 ของ retro · ข้อเสนอ Playbook = **แถว 1** (แถว 2 คือ env-hardening คนละเรื่อง) | ถ้า CTO ตั้งใจแถว 2 = สั่งแก้ scope ก่อนปล่อยงาน (ตอนนี้เขียนตามแถว 1 ซึ่งตรงวัตถุประสงค์ "encode pattern playbooks") |
| A-2 | P-PLAYBOOK | ตัวเลข "11 review rounds" เป็นเฟรม charter · trail ตรวจได้จริง = 9 รอบ consent หลัก + 2 จุดค้นพบกลางทาง — playbook อ้างรายการ trail ไม่อ้างเลขรวม | ไม่มีผลต่อเนื้อหา — แค่รูปการอ้าง |
| A-3 | P-PLAYBOOK | ข้อยกเว้น constraint (b): แตะ `docs/TEAM.md` (เพิ่ม section เดียว purely-additive) + สร้าง `docs/09-dev/PATTERN-PLAYBOOKS.md` | เลนเหลือเพียง playbook เดี่ยว (ไม่มี section ใน TEAM.md) — เหมาะสมถือความเสี่ยงต่ำอยู่ดี |
| A-4 | P-UAT09SPEC | specs ใต้ `tests/e2e/` ไม่ถูก config ปัจจุบันเลือก (testDir `./e2e`) — authoring เท่านั้น · ต่อสายที่ execute lane | ถ้า CTO อยากให้รันได้ทันทีตอน merge = ต้องอนุมัติแตะ config (ตั๋วแยก post-close อยู่แล้ว) |
| A-5 | P-UAT09SPEC | บัญชี/รหัส/TOTP มาจาก `UAT_DEMO_PASSWORD` + ไฟล์ secret ใต้ `.omc/artifacts/uat/${RUN_ID}/mfa/` — ศูนย์ค่าจริงใน repo | ต้องเปลี่ยนรูป provisioning ก่อน execute — ไม่บล็อก authoring |
| A-6 | P-UAT09SPEC | มิเรอร์แบบบ้านใน fixtures ได้ (มี precedent d9-helpers) · import จาก `e2e/**` ได้แบบ read-only | ถ้า CTO บังคับ import-only = ปรับ fixtures (ผลกระทบเล็ก — โครง specs ไม่เปลี่ยน) |
| A-7 | ทั้งสอง | ฐาน develop@65fbac9 + rebase หลัง close drained ตามคำสั่ง CTO | ค่าเริ่มต้นถูกต้องตามสถาปัตยกรรมขนานอยู่แล้ว |
| A-8 | P-UAT09SPEC | root tsconfig include `**/*.ts` ครอบ tests/e2e → `npx tsc --noEmit` เพียงพอเป็นช่องทางตรวจ (vitest สามชุดไม่ชน — ตรวจแล้ว) | ถ้าอยากได้ scoped check เพิ่ม (แบบ tsconfig.d9-check.json) = สร้างไฟล์นั้นใต้ tests/e2e/ ได้ (ยังอยู่ใน fence) |
| A-9 | ทั้งสอง | push branch ได้ · ห้าม PR/merge ก่อน gate | — |

## 10. ความขัดกันของเอกสารต้นทางที่พบ (DCR-style — **แจ้งอย่างเดียว ไม่แก้**)

| # | จุดขัด | รายละเอียด | ผลต่อ Sprint 3 |
| --- | --- | --- | --- |
| C-1 | จำนวน scenarios ของ UAT-09 | charter บอก **21** · commit แรกของสเปก (bb3f5ec) พูด "20 scenarios" · ฉบับสุดท้ายจริง = **21** (A:6 + B:5 + C:5 + D:5) | ฉบับสุดท้ายชนะ — trace table 21/21 · ไม่กระทบงาน (จดไว้ให้ประวัติศาสตร์ชัด) |
| C-2 | "11 review rounds" | charter ใช้เลข 11 · trail ที่นับได้จากเอกสาร = 9 รอบ consent หลัก + 2 จุดค้นพบกลางทาง (ดู A-2) | ไม่บล็อก — playbook อ้างรายการ trail |
| C-3 | อ้างอิง retro | charter เขียน "TEAM-ENHANCEMENT-RETRO **#2**" แต่ข้อเสนอ Playbook คือ **แถว 1** ของ §2 (แถว 2 = env-hardening bundle) | บริหารด้วย A-1 — CTO ฟันตอน gate |
| C-4 | ตำแหน่งสเปก Playwright กับ config | สเปกเดิมทั้งบ้านอยู่ `e2e/` (root · testDir `./e2e`) · charter สั่งเลนใหม่ที่ `tests/e2e/` — ไดเรกทอรีใหม่ ไม่ถูก config เดิมเลือก | โดยเจตนา (ศูนย์ overlap) · ต่อสายที่ execute lane ตาม A-4 — **จะเป็นหนี้ทางเทคนิคจุดเดียวของสปรินต์นี้ จดไว้ให้ execute lane เห็น** |
| C-5 | งาน lint ที่ค้างของ Sprint 2 | charter คิวหลัง close พูด "9 lint fixes" — ตัวเลข 9 ตรวจไม่ได้จากเอกสาร (post-QA rulings ระบุ eslintrc-removal aftermath + advisories 3 ตัว ไม่ได้นับเป็น 9) | ไม่กระทบ Sprint 3 — จดชื่องานตาม rulings จริง (ดู §0.3 ข้อ 2) |

---

*ท้ายเอกสาร — เขียนโดย PM · 2026-10-14 · ทุกอ้างอิง file:line/§ ตรวจกับ working tree จริง (main = `feat/wave-i-e2e04-403`@`d0ab35d` · ฐานเลน = `develop`@`65fbac9` · สเปก UAT-09 = branch `docs/sprint2-j-uat09-specs`@`b01f435` ที่ worktree `D:/LTC-w2`) ก่อนเขียนแล้ว · สถานะทั้งหมด DRAFT รอ CTO gate ตามธรรมนีย์ D70/D71 — ห้ามเริ่ม execute ส่วน deferred ก่อนคำประกาศ close drained · WO-1 ต้องคงสถานะ PROPOSAL จนกว่า owner ratify ที่ sprint close*

---

## 11. CTO GATE (ลงมติ 2026-10-14 · CTO seat = orchestrating session)

| # | คำวินิจฉัย |
|---|-----------|
| A-1 | **ยืนยัน** — Playbook = §2 แถว 1 ของ retro (แถว 2 env-hardening เป็นคนละเลน) |
| A-2 | **ยืนยัน** — playbook อ้างรายการ trail ที่นับได้ (9 รอบ consent + 2 จุดค้นพบ) ไม่อ้างเลขรวมของ charter |
| A-3 | **ยืนยัน** — ข้อยกเว้น constraint (b) สำหรับ TEAM.md (section เดียว purely-additive) + ไฟล์ playbook ใหม่ |
| A-4 | **ยืนยัน** — specs อยู่ `tests/e2e/` เพื่อศูนย์ overlap · การต่อสาย testDir เป็นของ execute lane |
| A-5 | **ยืนยัน** — fail-loud sourcing จาก UAT_DEMO_PASSWORD + mfa artifacts · ศูนย์ค่าจริงใน repo |
| A-6 | **ยืนยัน** — mirror-in-fixtures ตามแบบ d9-helpers · password-parameterized variant ของ loginViaForm จำเป็น (บันทึกความต่างไว้ใน fixtures) |
| A-7 | **ยืนยัน** — ฐาน develop@65fbac9 · rebase หลัง close drained โดยคำสั่ง CTO |
| A-8 | **ยืนยัน** — root `npx tsc --noEmit` เพียงพอเป็นช่องทางตรวงของเลนนี้ |
| A-9 | **ยืนยัน** — push branch ได้ · ห้าม PR/merge ก่อน gate |

**Contradiction dispositions:** C-1 ฉบับสุดท้าย 21 ชนะ (บันทึกประวัติศาสตร์ "20" ของ bb3f5ec) · C-2 ตาม A-2 · C-3 ปิดด้วย A-1 · **C-4 = หนี้ทางเทคนิคจุดเดียวของสปรินต์นี้ — ตั้งชื่อไว้ให้ execute lane เห็น (testDir wiring)** · **C-5 ปิดโดย CTO: ตัวเลข "9 lint fixes" มาจากรายงานบันได WO-3 ที่ QA ตรวจแล้ว (8 × react-hooks/set-state-in-effect + 1 × react-hooks/refs บน 16.3.5) — ทั้ง 9 ตัวนี้และ eslintrc/advisory items ของ post-QA rulings เป็นงานจริงทั้งคู่ คนละชุด**

**สั่งปล่อยงาน:** WO-1 → devops worker (Flash) · WO-2 → main worker (GLM-5.3) — เริ่มได้ทันที (worktree-local เท่านั้น)

*— CTO (orchestrating session) · 2026-10-14*
