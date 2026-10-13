# DCR teardown-guard: psql side-channel มีขอบเขต + afterAll คืน stack ก่อน cleanup จบ (two-strike จาก rb-dcr12)

Filing: BL-015 sibling residual · 2026-10-13 · ขอบเขตแคบ: **test-infra เท่านั้น (helpers.ts + 2 ไฟล์เทส) — ไม่แตะ `src/` · ไม่เพิ่ม budget ใด ๆ (เงื่อนไข pm ข้อ 3 ของ DCR-GATEWAY-ERRBODY-REBASELINE คงอยู่ครบ)**

## หลักฐาน (rb-dcr12 · `.omc/artifacts/it-rb-dcr12.log` · 14:37:15-19:47:19 · 18627s)

1. **beforeAll (300s) หมดกลาง createTestUser ด้วย stall ไม่ใช่เครื่องช้าทั้งเครื่อง**: auth log ยืนยัน signup ตัวที่ 1 (0.149s @14:37:26) · ตัวที่ 2 (0.145s @14:37:32) · login ตัวที่ 2 @14:37:43 แล้ว **เงียบสนิท** — signup ตัวที่ 3 ไม่เคยถึง GoTrue → ค้างอยู่แถว psql side-channel ของ confirm/assignRole หรือ ledger write ของ transport (ไม่มี timeout ทั้งคู่) → hook โดนตัดที่ 300s โดยได้ผู้ใช้แค่ 2/8 (แถว orphan เหลือจริงใน DB — ล้างแล้ว 20:13) · ฐานเทียบ: in-suite รอบ 13:02 ไฟล์เดียวกันจบทั้งไฟล์ 158.9s → เส้นทางปกติของ beforeAll ไม่ใช่คอขวด · **สังเกตคลาสเดียวกันเกิดซ้ำเป็น dcr9 เคส 1 (30s test timeout) ในหน้าต่างเย็นที่แวดล้อมเสื่อม — 20:00 และ 20:21 — ผ่านสะอาด 14:06**
2. **afterAll (ค่า default 60s จาก hookTimeout ของ config) < งานจริงของ cleanup** → hook timeout กลาง `cleanupE17World()` → **`finally { restoreCrons(); startMailer(); } ไม่ได้รันเลย** → ทิ้ง dev stack พัง 5 ชม. 17 นาที: mailer ถูก stop (FinishedAt 14:37:23) · cron 4 ตัว (notification-dispatch/renewal-reminder/email-outbox-purge/credit-accrual) ถูก unschedule · ผู้ใช้ orphan 2 ตัว — จน rb-dcr10 (19:51-19:59) afterAll ของตัวเองเพิ่งคืน cron+mailer ให้ (idempotent โดยดีไซน์) · **รูยังไม่มีอะไรตรวจสถาพร stack หลังรัน — พังเงียบ 5 ชม. ไม่มีใครเห็น (เงื่อนไข qa binding ข้อ 2 ปิดรูนี้)**
3. **worker ค้าง 5 ชม. 4 นาทีหลัง hook timeout ทั้งคู่แล้ว** (สรุป run พิมพ์ 19:47:19 · "tests 18612s" ทั้งที่ 8 เคส skip) — child handle ที่ไม่มีขอบเขต (docker exec class) ของ promise ลอยถือ event loop ไว้ และ launcher (กฎ no-overlap) ถูกบล็อกยาวตาม
4. **พี่น้องคลาสเดียวกัน**: `dcr10-notifications.test.ts:631-638` มี afterAll รูปเดียวกันเป๊ะ (cleanup ก่อน · restore ใน finally · ไม่มี timeout ระบุ) — ห่างจาก incident เดียวกันหนึ่งจังหวะ

## ทางแก้ (4 จุด — test-infra เท่านั้น)

| จุด | แก้ | ไฟล์:บรรทัด |
|---|---|---|
| 1 | **psql side-channel มีขอบเขต**: kill timer ที่ spawn (default **120_000ms** · opts _override ได้) — หมดเวลา = kill child + reject ดัง `psql side-channel timeout after Ns (killed): <sql 40 ตัวแรก>` — child ที่ถูก kill ไม่ถือ event loop อีก → คลาส "worker ค้างเพราะ docker exec ลอย" ของ **helpers.psql** จบ (fail-loud ทุกครั้ง แทนค้างเงียบ) · known-residue: backend ใน container อาจค้าง idle (ไม่ถือ loop ฝั่ง host — reap ด้วย `select pg_terminate_backend(pid) ... where state='idle' and usename='supabase_admin' ...` ถ้าสะสม) · **ขอบเขตความจริง: ครอบเฉพาะ psql ของ helpers.ts — test-io.ts มี sibling spawns ที่ยังไร้ขอบเขต (:353-355 · :375 · :636-637 · :675 · :690) ซึ่ง**ไม่เคยถูกหลักฐานชี้** — ยกเป็น follow-up OQ ด้านล่าง ไม่อ้างว่าจบทั้งคลาส** | tests/integration/helpers.ts:30-66 |
| 2 | **afterAll คืน stack ก่อน cleanup จบ**: (ก) ระบุ timeout เอง `, 300_000` **เทียบเท่า (parity) กับ beforeAll ของไฟล์เดียวกัน — ไม่ใช่บรรทัดฐานให้ขยับ hook อื่นในอนาคต (pm ข้อสังเกต)** (ข) แข่ง `cleanupE17World()` กับ deadline **120s** — หมดเวลา = จด warning **เป็นบรรทัด greppable `TEARDOWN-GUARD: cleanup deadline` ใน log (.omc/artifacts) เพื่อ stack-check รายรอบของ qa** แล้ว**ไปคืน stack ต่อ** (ค) **restore สองขาพยายามเสมอ — nested finally: `try { await restoreCrons(); } finally { await startMailer(); }`** (รูปเดิม `await restoreCrons(); await startMailer();` ต่อเนื่องจะ**ข้าม startMailer เมื่อ restoreCrons reject** — คลาส incident เดียวกันแค่ถูกจำกัดเวลา · เงื่อนไข qa binding ข้อ 1) พร้อม aggregate error ดังถ้าขาใดล้ม · เหตุผล: restore (เร็ว + idempotent) ต้องไม่อดตายหลัง cleanup (ช้า + idempotent-รอบถัดไปตามคอมเมนต์เดิม "ล้างของค้างจากรอบก่อน") · ผลข้างเคียงยอมรับได้: ถ้า cleanup ล้มเวลา cron tick อาจยิงโดนแถวค้างของ suite ก่อนถูกลบรอบถัดไป (แถวเนมสเปซ dcr12-p5r1-%/e14 ทั้งหมด — ไม่แตะโลกจริง) แลกกับ "stack พังเงียบ 5 ชม." ที่พิสูจน์แล้ว | dcr12-p5r1:296-304 · dcr10-notifications:631-638 |
| 3 | **stopMailer/startMailer มีขอบเขต**: execFileAsync ครอบ deadline **60s** (docker compose stop/start บนเครื่องช้า ~0.5-10s — 60s = เพดานกันลอย ไม่ใช่ค่าที่คาดว่าจะโดน) | ทั้งสองไฟล์ (ฟังก์ชัน local ของแต่ละไฟล์) |
| 4 | **ไม่ขยับ budget ใด ๆ**: beforeAll 300s คงเดิม (เส้นทางปกติวัดแล้ว 158.9s ทั้งไฟล์ — เหลือ headroom ~2x · คอขวดจริงคือ stall ซึ่งจุด 1 ทำให้ fail-loud ใน 120s ไม่ใช่ค้าง) | — |

## แผนทดสอบ (หลัง implement → isolated → full-suite → gate)

1. isolated dcr12-p5r1-hardening เขียว (พิสูจน์พร้อมกับ body 5 จุดของ DCR ก่อนหน้าที่ยังไม่เคยได้ isolated green หลัง fix — rb-dcr12 ถูก environment กลืน)
2. isolated dcr10-notifications เขียว (regression จุด 2-3) · isolated dcr9-credit (จุดยืนยันสามของเคส 1 — ผ่านสะอาด 14:06 · stall 30s สองครั้งในหน้าต่างเย็น) · isolated wave-h-battery-audit-guards (amendment 5)
3. **full-suite 35 ไฟล์ detached** (ตามเงื่อนไข binding เดิม) **+ ตรวจสถาพร stack หลังรันทุกครั้ง (เงื่อนไข qa binding ข้อ 2): `select jobname from cron.job` ต้องได้ 8 ตัวพอดี (ltc-auto-close-attempts · ltc-cert-auto-issue · ltc-cert-bulk-step · ltc-credit-accrual · ltc-notification-dispatch · ltc-renewal-reminder · ltc-email-outbox-purge · ltc-purge-retention) และ mailer Up ตาม docker compose ps — stack พังเงียบ 5 ชม. ไม่มีใครเห็นเพราะไม่มีอะไรตรวจ** → qa gate → battery r38

## คำถามที่ยังเปิด (ไม่บล็อก)

- สาเหตุเชิงลึกของ stall @14:37:43 (docker exec จริง หรือ ledger write ของ transport) ยังไม่ pin ตัวเดียว — จุด 1 ทำให้ทางเดินของ helpers.psql fail-loud ทุกกรณี (ถ้าเจอซ้ำหลัง fix จะมี error ระบุชนิดให้สืบต่อ)
- **follow-up (ยกโดยผู้วิจารณ์)**: test-io.ts sibling spawns ไร้ขอบเขต (:353-355 · :375 · :636-637 · :675 · :690) — ไม่เคยถูกหลักฐานชี้ แยกตั๋ว follow-up ไม่รวมใน DCR นี้

## ฉันทามติ + GO

- **pm CONSENT (ผ่าน bridge · 2026-10-13)**: scope ถูกต้อง · ผลข้างเคียง cron-tick-during-cleanup ในเส้นทาง timeout ยอมรับ · ข้อสังเกต binding: afterAll 60→300s บันทึกเป็น **parity กับ beforeAll ของไฟล์เดียวกัน** ไม่ใช่บรรทัดฐานขยับ hook อื่น · บรรทัด warning ของ 120s-race ต้อง greppable ใน log .omc/artifacts
- **qa CONSENT (ผ่าน bridge · 2026-10-13)** พร้อมเงื่อนไข binding 2 ข้อ (ครบในตารางจุด 2 และแผนทดสอบข้อ 3): (1) **nested finally** ทั้งสองขา restore พยายามเสมอ — รูป sequential เดิมข้าม startMailer เมื่อ restoreCrons reject (2) **ตรวจสถาพร stack หลังรัน** (cron 8 ตัวพอดี + mailer Up) เป็นส่วนของ protocol · เพิ่มเติม: reap predicate ให้ระบุ `and usename='supabase_admin'` (รูปกว้างเดิมเกือบชน pool ของ PostgREST/authenticator — เกือบเป็นจริงเมื่อ CTO kill แถว "commit" แล้วโดน pool ของ GoTrue — SQLSTATE 57P01 · บทเรียนบันทึกแล้ว)
- **GO (CTO · 2026-10-13)**: ฉันทามติครบทั้งสองฝ่าย + เงื่อนไข binding ทั้งหมดถูกพับเข้า spec ก่อน implement → **GO ทั้งสี่จุด** ตามตาราง · ลำดับ: implement → isolated (dcr12 · dcr10 · dcr9 · waveh) → full-suite 35 ไฟล์ detached + stack-integrity check → qa gate → battery r38 → merge --no-ff
