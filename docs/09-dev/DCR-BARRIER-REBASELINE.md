# DCR barrier-rebaseline: สเกลเส้นเวลา scenario ของ barrier-proof suite ตามเครื่องวัดจริง (ตัดลูกต้องตกกลาง sleep หลังจดทะเบียน · เพดาน deadline ตามอัตรา ×2.5 ของแบบแผน)

Filing: ต่อจาก DCR-TEST-HARNESS-PORTABILITY Addendum 3 (ลูกสปอร์นได้แล้วผ่าน process.execPath+vitest.mjs) และ DCR-SUITE-STABILITY-R2 / DCR-GATEWAY-ERRBODY-REBASELINE (หลักคำสอน "เพดาน = ตัวเลขวัด ขยับได้ด้วยการวัดใหม่เท่านั้น อัตรา ~×2.5 ครอบครัวเดียวกัน") · 2026-10-14 · ขอบเขตแคบ: **ไฟล์เทส barrier-proof เท่านั้น — 11 ไฟล์ (children 6: aa/gg/hh/kk/ll/mm · wrappers 3: w8k/w8m/w8i · fixture 1: user-active-fixture · w8e อีกไฟล์แก้ comment อย่างเดียว = แก้ค่าคงที่จริง 10 ไฟล์) — ไม่แตะ `src/` · ไม่แตะ `barrier-harness.ts` (ค่า default ทั้งหมดคงเดิม) · ไม่แตะ `vitest.barrier-proof.config.ts` (hookTimeout 5_000 + testTimeout 30_000 คงเดิม — 8c/8d เขียวอยู่กับค่านี้)**

สถานะ ground truth: **it-barrier-clean-run.log (RUN_ID='pre-it' battery-identical · 07:44:19 local · 1220.56s) = 14 แดง / 47 เขียว / 13 skip ของ 74** — ชุดนี้ไม่เคยถูก re-baseline บนเครื่องสำรองเลย (battery r38 สองรอบแรกตายที่ชั้น spawn ก่อนถึงตัวเทส) ทุกแดงอยู่ในคลาสเครื่องช้าที่วัดไว้แล้ว (psql side-channel 0.5-1.4s/ครั้ง · child vitest boot ~2s · docker op หลายวินาที)

## หลักฐาน (ต่อครอบครัว · timeline จาก lifecycle_ledger run_id='pre-it' ช่วง clean-run 00:44-01:00Z + ข้อความล้มจาก log)

### ครอบครัว 1 — "ตัดลูกต้องตกกลาง sleep หลังจดทะเบียน" (8b-2/3/4 · 8e-2/3 · 8e2-2 · 8h-1)

กลไกที่พิสูจน์แล้ว (สองรูป ขั้นเดียวกัน): **จุดตัดของ runner ตกก่อน/คร่อมจุดจดทะเบียน ทำให้ lifecycleId ในมือลูกเป็นค่าว่าง หรือ fn ของ setup ยังไม่จบ** → afterAll fast-refuse `teardown-refused-no-setup` (guardedAfterAll เข้าทาง `opts.lifecycleId === ""`) → poison/หลักฐานที่เทสต้องการไม่เกิด:

- **8b-aa (child/aa-poison-hook.test.ts)**: ledger — `file-attempt-allowed 00:45:00.652` → `teardown-refused-no-setup 00:45:51.771` (phase=setup-running) → `setup-complete 00:46:07.717` (โดย promise ที่ถูกทิ้ง ตาม F56) — คือ fn ของ beforeAll (openIsolatedWindow drain จริง + markers 3 แถว) ใช้จริง **~67 วินาที** บนเครื่องนี้ ตัดที่พอดี budget 60s กลาง fn → ผลคือ 8b-2 ได้ `setup-settled` แทน `poisoned` · 8b-3 เห็น predecessor phase ไม่ใช่ poisoned · 8b-4 ตายที่ 30s ท่ามกลางโลกที่ลูกยังวิ่งค้าง (cascade)
- **8e-gg (child/gg-abandoned-setup.test.ts)**: ledger — `file-attempt-allowed 00:50:36.37` → `teardown-refused-no-setup 00:50:38.64` ห่าง 2.27s — hookTimeout 5s (config) นับแต่ต้น hook ตัดลงตอน psql ประโยคสุดท้ายของ fileBegin ยัง drain ฝั่ง client อยู่ (DB เขียนแถวแล้วแต่ promise ยังไม่ resolve — psql end-to-end 0.5-1.4s/ครั้ง) → `lifecycleId` ยังเป็น "" → 8e-2 ไม่มี setup-complete ของ gg เลย (undefined) · 8e-3 phase ค้าง `setup-running` — pg_sleep(12) ไม่เคยเริ่มเพราะ process ลูกจบก่อน promise ที่ถูกทิ้งจะไปถึง
- **8e2-hh (child/hh-hang-setup.test.ts)**: `allowed 00:50:59.00` → `teardown-refused 00:51:00.90` — รูปเดียวกับ gg (hang เริ่มหลัง fileBegin แต่ cut มาก่อน assignment กลับมือ)
- **8h-kk (child/kk-abandoned-write.test.ts)**: เทสตัดที่ 5s กลาง pg_sleep(8) ถูกต้อง แต่ **สาย teardown ของ afterAll (phase TX + cleanup TX + descendants + settle ≈ 6-14s บนเครื่องนี้) ยังไม่จบตอน body ตื่นที่ ~9s** → mutation ถูกปฏิเสธด้วยเหตุ `phase-teardown-running` แทนที่เทส pin ไว้ `phase-teardown-settled` (w8h:90) — invariant ยังอยู่ (ปฏิเสธก่อนแตะ) แต่ค่าคงที่เวลาทำให้ phase ณ ตื่นไม่ใช่ตัวที่ design ตั้งใจ

### ครอบครัว 2 — เพดาน deadline ภายในโดนเครื่องช้า (8k · 8m · 8o/mm)

- **8k (w8k:83) · 8m (w8m:80)**: `awaitStuckWaiter(...): ไม่เห็น waiter ภายใน 10000ms` — waiter = backend INSERT ของ RPC ที่ติดคิวหลัง SRE lock ของ coordinator; สาย "PATCH → app (:3000 Next dev) → DB → ปรากฏใน pg_locks → poll psql เห็น" บนเครื่องนี้เกิน 10s (8k ล้มที่ 11.4s)
- **8o/mm**: `awaitStuckWaiter(h8o-hs1-a1-d1): ไม่เห็น waiter ภายใน 10000ms` ในลูก (user-active-fixture.ts:167 deadlineMs: 10_000) — สาย app เดียวกัน → ลูกตายก่อน scenario จบ → ไม่มีข้อความ designed-poison `h8o-attempt-loop-budget-poison` ให้ wrapper ตรวจ (w8o:38 assertion ที่ stdout ลูก)

### ครอบครัว 3 — เพดานเส้นทาง SIGKILL ของ 8i

- **8i (w8i:55)**: `end ต้องกลับมามีขอบเขต: expected 14229 to be less than 8000` — กลไกทำงานจริง (14.2s < pg_sleep 15s = ไม่รอ query จนจบ · code≠0 ผ่าน) แต่เพดาน 8s ตั้งจากเครื่องเก่า (kill+docker CLI+reap ~2-3s) ขณะเครื่องนี้ kill-path ใช้ ~9-14s

### การค้นพบกลางทาง (บันทึกก่อนแก้ตาม governance) — 8f f2/f3/f4a ไม่ใช่ latency แต่คือ ledger ปนเปื้อนข้ามรัน

f2 ล้มที่แถว `cleanup-start ts=23:37:34.93` ซึ่งเป็นแถวของ **รันก่อนที่ใช้ run_id='pre-it' เดียวกัน** (battery r38 รอบสอง 06:36 local — ตายที่ child spawn แต่ 8e3/8f ซึ่งไม่ใช้ลูกได้รันและเขียนแถวไปแล้ว) เพราะ `ledgerRead` อ่านทุกแถวของ run_id ใน ledger แบบ append-only — clean-run (07:44 local) เริ่มหลังแถวเหล่านั้นถูกเขียน · f3/f4a ตามมาเพราะ f2 ล้มกลางทางทิ้ง 8f2 อยู่ phase teardown-running ตอน fileBegin ของเคสถัดไป (cascade) · **battery มีกันชน `assertLedgerFresh` (scripts/battery-run.mjs:134-150) อยู่แล้ว** (check-and-fail + ทางเคลียร์ที่ชอบ: audit `--truncate` / เคลียร์มือตาม limitation 5) — ตัวแดงจริงของ clean-run คือ launcher แยกของเราตั้ง RUN_ID='pre-it' โดยไม่จำลองกันชนนี้ · **ไม่แก้เทส 8f แม้แต่บรรทัดเดียว** — แก้ที่ขั้นตอน (proof plan ข้อ 0)

## ทางแก้ (สเกลตัวเลขเวลาเท่านั้น — 21 จุด · invariant/assertion/fence semantics ทั้งหมดคงเดิม)

อัตรา ×2.5 ตามแบบแผน re-baseline ที่ GO ไปแล้ว (dcr9 30→75 · probe 5→30 ตามการวัด) — ปรับเฉพาะจุดที่วัดแดง + จุดในสายเดียวกันที่คำนวณแล้วชนกัน

| # | ไฟล์:บรรทัด | เดิม | ใหม่ | เหตุผล (ตัวเลขวัด/คำนวณ) |
|---|---|---|---|---|
| 1 | child/aa-poison-hook.test.ts:37 | `}, 60_000);` (beforeAll) | `}, 150_000);` | fn วัดจริง ~67s (00:45:00.65→00:46:07.72) · 60s ตัดกลาง fn · 150s = 2.2× ที่วัด |
| 2 | child/gg-abandoned-setup.test.ts:36 | beforeAll ไร้ timeout (ตก config 5s) | `}, 12_500);` | ตัดต้องตกกลาง sleep หลังจดทะเบียน: boot ~2s + fileBegin ~2.5-4.5s → sleep เริ่ม ~5s · 12.5s ตัดกลาง sleep ที่ ~5-35s |
| 3 | child/gg-abandoned-setup.test.ts:38 | `pg_sleep(12)` | `pg_sleep(30)` | สัดส่วนเดิม (cut 5s ต่อ sleep 12s ≈ 0.42) → 12.5s ต่อ 30s ≈ 0.42 |
| 4 | child/gg-abandoned-setup.test.ts:52 | `setupBudgetMs: 25_000` | `62_500` | afterAll เริ่ม ~12.7s · abandoned promise เซ็ตเทิล ~39s → ต้องมี ≥26.3s+poll lag · 25s เดิมไม่พอ · 62.5s = ×2.5 |
| 5 | child/gg-abandoned-setup.test.ts:54 | `}, 30_000);` (afterAll) | `}, 75_000);` | 12.7 + budget 62.5 คร่อมเพดานเดิม 30s |
| 6 | child/hh-hang-setup.test.ts:26 | beforeAll ไร้ timeout (ตก config 5s) | `}, 12_500);` | hang เริ่ม ~4.5s → 12.5s ตัดกลาง hang หลัง lifecycleId กลับมือแน่นอน |
| 7 | child/kk-abandoned-write.test.ts:32 | `pg_sleep(8)` | `pg_sleep(20)` | ตื่นต้องช้ากว่า teardown-settled (~5.2s+6-14s=11.2-19.2s) → ตื่นที่ ~21s มี margin ~2s เท่า design เดิม (9s ตื่น vs 7.1s settle) |
| 8 | child/ll-hold-open.test.ts:9 | `9_000` hold | `22_500` | กระบวนการต้องมีชีวิตเกินตื่นของ kk (~21s) — หน้าที่เดิมของ ll |
| 9 | child/ll-hold-open.test.ts:11 | `}, 15_000);` | `}, 37_500);` | คร่อม hold ใหม่ |
| 10 | w8k-qb-patch-commit-after-abort.test.ts:83-86 | awaitStuckWaiter ไร้ deadline (default 10s) | เพิ่ม `deadlineMs: 25_000` | วัดล้ม 10s (11.4s ไม่เห็น) · default ของ harness ไม่ขยับ |
| 11 | w8m-settle-refused-while-blocked.test.ts:80-83 | รูปเดียวกัน | เพิ่ม `deadlineMs: 25_000` | วัดล้ม 10s สาย app เดียวกัน |
| 12 | user-active-fixture.ts:169 | `deadlineMs: 10_000` | `deadlineMs: 25_000` | วัดล้ม (h8o-hs1-a1-d1 ที่ 19.3s) · ใช้ร่วมโดย 8o/mm |
| 13 | child/mm-attempt-loop.test.ts:194-198 | awaitStuckWaiter ไร้ deadline | เพิ่ม `deadlineMs: 25_000` | handshake#2 = retry INSERT สาย app เดียวกับจุด 12 (คำนวณ ~10-15s) |
| 14 | w8i-held-session-end.test.ts:33 | `pg_sleep(15)` | `pg_sleep(37.5)` | รักษาความหมายเพดานใหม่ 20s (< sleep เสมอ = พิสูจน์ว่าไม่รอ query จบ) |
| 15 | w8i-held-session-end.test.ts:39 | `activeDeadline + 5_000` | `+ 12_500` | poll findBackendByNonce ก้าวละ ~1.4s — 5s ได้แค่ ~3 รอบ ชิด |
| 16 | w8i-held-session-end.test.ts:52 | `killAfterMs: 4_000` | `10_000` | kill-path วัด ~9-14s |
| 17 | w8i-held-session-end.test.ts:55 | `toBeLessThan(8_000)` | `toBeLessThan(20_000)` | วัดจริง 14229ms · 20s = ×2.5 |
| 18 | w8i-held-session-end.test.ts:60 | `graceDeadline + 3_000` | `+ 7_500` | ×2.5 ครอบครัวเดียวกัน |
| 19 | w8i-held-session-end.test.ts:82 | `goneDeadline + 5_000` | `+ 12_500` | poll หลัง terminate ก้าวละ ~1.4s |
| 20 | w8i-held-session-end.test.ts:97 | `}, 60_000);` | `}, 90_000);` | worst-case คำนวณใต้ค่าใหม่ ~59s — headroom 1.0x ขัดหลักคำสอน · 90s = 1.5x worst |
| 21 | header comments ของ child/gg · hh · kk · ll + w8e · w8i · inline comment gg:35 + hh:24 ("ห้ามใส่ timeout — หัวใจของ 8e" เดิม) | timeline เดิม 5s/12s/8s/9s | อัปเดตเป็นเส้นเวลาใหม่ + เหตุผล per-hook 12.5s แทน config 5s | comment คือบันทึก design — ต้องตรงตัวเลขจริง · หมายเหตุ: วลี "ทิ้ง hook จริงที่ 5s" ใน header ของ vitest.barrier-proof.config.ts เว่อร์สำหรับครอบครัวที่สเกลแล้ว (config เองไม่ถูกแตะ — 8c/8d ยังตัดที่ 5s จริง) — บันทึกไว้ที่นี่โดยไม่แก้ไฟล์ config |

**จุดที่พิจารณาแล้วไม่ขยับ (มีเหตุผลจดไว้):** config `hookTimeout: 5_000` (หัวใจของ 8c — budget 8s ของ cc ต้องชนะ cut ที่ 5s · 8c/8d เขียวอยู่) · `setupBudgetMs: 8_000` ของ hh (เส้นตายเชิง scenario "budget ต้องเป็น deadline" — margin คำนวณ: poison ตก ~23.6s < afterAll 15s ครบที่ 27.7s) · afterAll 20s ของ aa/kk · childRun/wrapper timeout ทั้งหมด (150s/200s/240s — วัดแล้วไม่โดน) · default ทั้งสามของ barrier-harness.ts (fnBudget 60s · settle 30s · awaitStuckWaiter 10s — จุดที่เขียวอยู่กับ default ไม่แตะ) · 8f ทั้งไฟล์ (ดูการค้นพบกลางทาง) · 8b-4 (cascade — ในกลไกที่ซ่อมแล้วโลก settle ก่อน 8b-1 คืนค่า · คำนวณ ~10s < 30s)

## สิ่งที่ไม่เปลี่ยน (ขอบเขตตาย)

- **invariant ทุกตัว**: ตัดลูกกลาง slow-op หลังจดทะเบียน (8e/8e2/8h) · poison หยุดการลาม (8b) · ts(setup-complete) < ts(cleanup-start) (8e-2) · fence ปฏิเสธ write หลังหน้าต่างปิด (8h-1 — เหตุผลปฏิเสธยัง pin phase-teardown-settled) · end() ไม่รอ query จบ + ไม่กำพร้า (8i) · waiter handshake ก่อน abort (8k/8m/8o)
- **assertion ทุกบรรทัดคงเดิม** — ยกเว้นค่าคงที่เวลาใน toBeLessThan จุดเดียว (w8i:55 — ตัวเพดานเองคือสิ่งที่ถูก re-baseline)
- **fence/settle semantics ของ harness ทั้งระบบ** — barrier-harness.ts ไม่ถูกแตะ
- **ลำดับไฟล์/singleFork/sequencer/bail semantics** — config ไม่ถูกแตะ

## แผนพิสูจน์ (หลัง implement)

0. **สุขลักษณะ ledger จำลองกันชน battery (จากการค้นพบกลางทาง)**: ก่อน clean-run — ตรวจแถว pre-it ค้างใน lifecycle_ledger แล้วเคลียร์ด้วยทางที่ชอบตาม battery-run.mjs:139-148 (audit --truncate / เคลียร์มือตาม limitation 5 จด intent ใน PROJECT-STATE) — ทำให้ assertLedgerFresh ของ battery r38 ผ่าน และ f2 ตัดสินจากแถวของรอบตัวเองเท่านั้น
1. **clean-run เต็มชุด detached** (RUN_ID=pre-it + สุขลักษณะข้อ 0 · log .omc/artifacts/it-barrier-rebaseline-run.log): ต้อง **61 เทสหลักเขียวทั้งหมด (74 รวม 13 skip)** — ต้องเห็น child markers จริง (binding Addendum 3) · เก็บเวลาจบแต่ละไฟล์เป็น baseline ceiling รอบใหม่
2. **13 skip ต้องเป็น self-skip ของ child files ทั้ง 13 อันเดียวกัน** (describe.skipIf BARRIER_CHILD !== "1") — environmental-by-design: ลูกถูก spawn เฉพาะโดย wrapper ผ่าน childRun — ตรวจด้วย grep ว่าไม่มี skip จากสาเหตุอื่น
3. ตัวเลขรอบใหม่ (เวลาจบจริงต่อไฟล์) บันทึกลง PROJECT-STATE เป็น **baseline ceiling ของ barrier suite** ต่อจากตาราง dcr9/dcr10/waveh เดิม
4. แดงรอบใหม่ = หยุด สอบสวน (อนุญาต amendment ด้วยการวัดใหม่เท่านั้น)
5. จากนั้น: battery r38 detached 13/13 → merge --no-ff → RISK ACCEPTANCE + ตาราง ceiling ครบ → UAT

## คำถามที่ยังเปิด (ไม่บล็อก)

- ชุด barrier ทั้งฉบับยาวขึ้น ~2-2.5 เท่า (~20 → ~45-50 นาที) — ยอมรับเพื่อความหมายของ scenario บนเครื่องนี้ · ทางเลือก "ยกไป infra ใหม่" (ข้อเสนอ #3/#6 ของ TEAM-ENHANCEMENT-RETRO) ยังเปิดสำหรับอนาคต ไม่ทำรอบนี้
- จุดเฝ้าระวังรอบพิสูจน์ (ไม่ขยับล่วงหน้า — ถ้าแดงยกเป็น amendment ด้วยตัวเลขวัด): OBS_DEADLINE_MS 5s ขอ mm · DRAIN_DEADLINE_MS 20s ขอ mm · it 150s ขอ mm (คำนวณ ~90-140s) · หน้าต่าง handshake 25s ในบริบท battery ที่มีโหลดรอบด้าน

## ฉันทามติ + GO (รอ)

- รอ pm (scope test-infra แคบ + หลัก "ขยับได้เมื่อวัดใหม่" ครบเงื่อนไขไหม + การค้นพบ 8f: ไม่แก้เทส แก้ขั้นตอน) + qa (จุด ×2.5 ทั้ง 20 + รายการ "ไม่ขยับ" ยอมรับไหม + แผนพิสูจน์ครบไหม) ผ่าน bridge — fast round

## ฉันทามติ + GO (สมบูรณ์)

- **pm CONSENT (ผ่าน bridge · 2026-10-14)**: scope ถูกต้อง (test-infra แคบ · ไม่แตะ harness/config/src) · การวัดใหม่ครบเงื่อนไขหลัก "ขยับได้เมื่อวัดใหม่" · การค้นพบ 8f (ledger ปนเปื้อนข้ามรัน · battery มีกันชนอยู่แล้ว) ยอมรับทางแก้ "แก้ขั้นตอน ไม่แก้เทส" — **binding fold-in ข้อ 1**: แก้เลขขอบเขตใน header ให้ตรงจริง (11 ไฟล์ · แก้ค่าคงที่จริง 10 · w8e comment-only)
- **qa CONSENT (ผ่าน bridge · 2026-10-14)**: ตัวเลขทั้งหมดตรวจครบกับ timestamp จริงของ ledger · ข้อเสนอ stale-row พิสูจน์แล้ว · margin ของจุดที่ไม่ขยับคำนวณแล้ว — **binding fold-ins**: (ข้อ 2) เคลียร์แถวตาราง #17 ตอนก่อน implement · (ข้อ 3) แก้ line drift สองจุด (kk pg_sleep อยู่ :32 ไม่ใช่ :40 · fixture deadlineMs อยู่ :169 ไม่ใช่ :167) · (ข้อ 5) จุด 21 ขยายคลุม inline comment เดิม gg:35 + hh:24 ที่จัดการขัดแย้งกับแก้ #2/#6 + บันทึกว่าวลี "ทิ้ง hook จริงที่ 5s" ใน header ของ config เว่อร์สำหรับครอบครัวที่สเกล (แต่ config ไม่แตะ — 8c/8d ยังตัดที่ 5s จริง)
- **watchpoint ที่ประกาศล่วงหน้า (qa arithmetic · จุด 16)**: killAfterMs 4s→10s เป็นการบวกเข้าตรง ๆ ในระยะเวลา end() — end ที่วัด 14.2s **รวม wait 4s เดิมอยู่แล้ว** ดังนั้นแบบใหม่ ≈ 20.2s อาจแปรงเพดานใหม่ 20s — 8i คือ watchpoint อันดับหนึ่งของรอบพิสูจน์: ถ้าแดงที่ toBeLessThan(20_000) นั่นคือเลขคณิตไม่ใช่ latency — **ทางเลือกที่ตัดสินด้วยการวัด ประกาศไว้ก่อน**: (ก) คง killAfterMs 4s เดิม (กลไก kill วัดเขียว — ที่แดงจริงคือเพดาน 8s เท่านั้น) หรือ (ข) ขยับเพดานตามแบบแผนด้วยตัวเลขที่วัดได้จากรอบพิสูจน์ — ห้ามตัดสินด้วยการเดา
- **GO (CTO · 2026-10-14 ผ่าน bridge)**: ฉันทามติครบทั้งสองฝ่าย + fold-ins ข้อ 1-5 พับเข้า spec ก่อน implement → **GO ทั้ง 21 จุด** · ลำดับ: implement → tsc/eslint → สุขลักษณะ ledger (ข้อ 0) → clean-run เต็มชุด detached (61 เขียว + 13 self-skip + child markers จริง) → battery r38 detached 13/13 → merge --no-ff + RISK ACCEPTANCE + ตาราง baseline ceiling รวม barrier → BL-015 ปิด → UAT
