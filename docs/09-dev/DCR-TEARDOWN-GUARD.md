# DCR teardown-guard: psql side-channel มีขอบเขต + afterAll คืน stack ก่อน cleanup จบ (two-strike จาก rb-dcr12)

Filing: BL-015 sibling residual · 2026-10-13 · ขอบเขตแคบ: **test-infra เท่านั้น (helpers.ts + 2 ไฟล์เทส) — ไม่แตะ `src/` · ไม่เพิ่ม budget ใด ๆ (เงื่อนไข pm ข้อ 3 ของ DCR-GATEWAY-ERRBODY-REBASELINE คงอยู่ครบ)**

## หลักฐาน (rb-dcr12 · `.omc/artifacts/it-rb-dcr12.log` · 14:37:15-19:47:19 · 18627s)

1. **beforeAll (300s) หมดกลาง createTestUser ด้วย stall ไม่ใช่เครื่องช้าทั้งเครื่อง**: auth log ยืนยัน signup ตัวที่ 1 (0.149s @14:37:26) · ตัวที่ 2 (0.145s @14:37:32) · login ตัวที่ 2 @14:37:43 แล้ว **เงียบสนิท** — signup ตัวที่ 3 ไม่เคยถึง GoTrue → ค้างอยู่แถว psql side-channel ของ confirm/assignRole หรือ ledger write ของ transport (ไม่มี timeout ทั้งคู่) → hook โดนตัดที่ 300s โดยได้ผู้ใช้แค่ 2/8 (แถว orphan เหลือจริงใน DB — ล้างแล้ว 20:13) · ฐานเทียบ: in-suite รอบ 13:02 ไฟล์เดียวกันจบทั้งไฟล์ 158.9s → เส้นทางปกติของ beforeAll ไม่ใช่คอขวด
2. **afterAll (ค่า default 60s จาก hookTimeout ของ config) < งานจริงของ cleanup** → hook timeout กลาง `cleanupE17World()` → **`finally { restoreCrons(); startMailer(); } ไม่ได้รันเลย** → ทิ้ง dev stack พัง 5 ชม. 17 นาที: mailer ถูก stop (FinishedAt 14:37:23) · cron 4 ตัว (notification-dispatch/renewal-reminder/email-outbox-purge/credit-accrual) ถูก unschedule · ผู้ใช้ orphan 2 ตัว — จน rb-dcr10 (19:51-19:59) afterAll ของตัวเองเพิ่งคืน cron+mailer ให้ (idempotent โดยดีไซน์)
3. **worker ค้าง 5 ชม. 4 นาทีหลัง hook timeout ทั้งคู่แล้ว** (สรุป run พิมพ์ 19:47:19 · "tests 18612s" ทั้งที่ 8 เคส skip) — child handle ที่ไม่มีขอบเขต (docker exec class) ของ promise ลอยถือ event loop ไว้ และ launcher (กฎ no-overlap) ถูกบล็อกยาวตาม
4. **พี่น้อง暴露 คลาสเดียวกัน**: `dcr10-notifications.test.ts:631-638` มี afterAll รูปเดียวกันเป๊ะ (cleanup ก่อน · restore ใน finally · ไม่มี timeout ระบุ) — ห่างจาก incident เดียวกันหนึ่งจังหวะ

## ทางแก้ (4 จุด — test-infra เท่านั้น)

| จุด | แก้ | ไฟล์:บรรทัด |
|---|---|---|
| 1 | **psql side-channel มีขอบเขต**: kill timer ที่ spawn (default **120_000ms** · opts _override ได้) — หมดเวลา = kill child + reject ดัง `psql side-channel timeout after Ns (killed): <sql 40 ตัวแรก>` — child ที่ถูก kill ไม่ถือ event loop อีก → คลาส "worker ค้างเพราะ docker exec ลอย" หมดไปทั้งคลาส · known-residue: backend ใน container อาจค้าง idle (ไม่ถือ loop ฝั่ง host — reap ด้วย `select pg_terminate_backend(pid) ... where state='idle' and application_name=''` ถ้าสะสม) | tests/integration/helpers.ts:30-66 |
| 2 | **afterAll คืน stack ก่อน cleanup จบ**: (ก) ระบุ timeout ระบุเอง `, 300_000` เท่า beforeAll (งานจริงของ teardown บนเครื่องช้า > 60s ได้) (ข) แข่ง `cleanupE17World()` กับ deadline **120s** — หมดเวลา = จด warning แล้ว**ไปคืน stack ต่อ** (restore อยู่ใน finally เหมือนเดิม) — เหตุผล: restore (เร็ว + idempotent) ต้องไม่อดตายหลัง cleanup (ช้า + idempotent-รอบถัดไปตามคอมเมนต์เดิม "ล้างของค้างจากรอบก่อน") · ผลข้างเคียงยอมรับได้: ถ้า cleanup ล้มเวลา cron tick อาจยิงโดนแถวค้างของ suite ก่อนถูกลบรอบถัดไป (แถวเนมสเปซ dcr12-p5r1-%/e14 ทั้งหมด — ไม่แตะโลกจริง) แลกกับ "stack พังเงียบ 5 ชม." ที่พิสูจน์แล้ว | dcr12-p5r1:296-304 · dcr10-notifications:631-638 |
| 3 | **stopMailer/startMailer มีขอบเขต**: execFileAsync ครอบ deadline **60s** (docker compose stop/start บนเครื่องช้า ~0.5-10s — 60s = เพดานกันลอย ไม่ใช่ค่าที่คาดว่าจะโดน) | ทั้งสองไฟล์ (ฟังก์ชัน local ของแต่ละไฟล์) |
| 4 | **ไม่ขยับ budget ใด ๆ**: beforeAll 300s คงเดิม (เส้นทางปกติวัดแล้ว 158.9s ทั้งไฟล์ — เหลือ headroom ~2x · คอขวดจริงคือ stall ซึ่งจุด 1 ทำให้ fail-loud ใน 120s ไม่ใช่ค้าง) | — |

## แผนทดสอบ

1. isolated dcr12-p5r1-hardening เขียว (พิสูจน์พร้อมกับ amendment body 5 จุดของ DCR ก่อนหน้าที่ยังไม่เคยได้ isolated green หลัง fix — rb-dcr12 ถูก environment กลืน)
2. isolated dcr10-notifications เขียว (regression จุด 2-3)
3. full-suite 35 ไฟล์ detached (ตามเงื่อนไข binding เดิม) → qa gate → battery r38

## คำถามที่ยังเปิด (ไม่บล็อก)

- สาเหตุเชิงลึกของ stall @14:37:43 (docker exec จริง หรือ ledger write ของ transport) ยังไม่ pin ตัวเดียว — จุด 1 ปิดคลาสทั้งหมดโดยไม่ต้องรอคำตอบ (bounded + fail-loud ทุกทาง) · ถ้าเจอซ้ำหลัง fix จะมี error ระบุชนิดให้สืบต่อ

## ขอ consent (NARROW — ผ่าน bridge)

- **pm**: scope = test-infra 4 จุดตามตาราง · ไม่แตะ acceptance/ผู้ใช้จริง · ไม่เพิ่ม budget (เงื่อนไขเพดานข้อ 3 คงอยู่) · ผลข้างเคียบ cron-tick-during-cleanup ในเส้นทาง timeout ยอมรับได้หรือไม่
- **qa**: testability ของจุด 2 (ความเรียบร้อยของ stack พิสูจน์ได้ด้วย cron.job 8 ตัว + mailer Up หลังรัน — ตรวจได้ทุกรอบ) · ค่าคงที่ 120s/60s สมเหตุสมผลหรือไม่ · known-residue idle backend จาก kill (harmless — ไม่ถือ loop ฝั่ง host)
