# DCR suite-stability r2: startMailer ข้าม dependency-gating ของ compose + เพดาน dcr9 แปดเคสตามการวัดใหม่ (two-strike จากรอบ rerun 22:0x)

Filing: ต่อจาก DCR-TEARDOWN-GUARD (จุด 3 mailer ops) + DCR-GATEWAY-ERRBODY-REBASELINE (หลักคำสอน budget = เพดาน ขยับได้ด้วยการวัดใหม่เท่านั้น) · 2026-10-13 ~22:3x local · ขอบเขตแคบ: **test-infra เท่านั้น (ไฟล์เทส 8 ไฟล์ + dcr9-credit.test.ts) — ไม่แตะ `src/` · ไม่แตะ docker-compose.yml · ไม่แตะ global testTimeout ของ vitest.integration.config.ts**

## หลักฐาน (รอบ rerun หลังแก้ DCR-TEARDOWN-GUARD · logs ที่ `.omc/artifacts/it-rr-*`)

1. **tg-waveh 4 ความล้ม = environmental ปิดจริง**: rr-waveh ผ่าน **43/43 (642s)** บนโค้ดชุดเดิมเป๊ะ (it-rr-waveh.log) หลังหน้าต่าง starvation 20:31-21:05 (app log: /api/health 129-813s · compile pdpa-export 1184.2s จบ 13:57:27Z · health 500 ช่วง 13:57-13:58Z) ผ่านไป — 4 เทสที่ล้ม (75s timeout :990 · resolved-not-rejected ×2 :1112/:1231 — settle ผ่านเพราะ lock_timeout 8s ฆ่า request ค้างก่อน probe จะรันบนเครื่องที่ psql ก้าวละ 10-30s · 300s timeout :1582) คือ timing-fence ที่โดนเครื่องช้าเกินหน้าต่าง ไม่ใช่ logic ผิด
2. **startMailer ล้มซ้ำใน suite ที่ "เขียว" (recurrence หลักของ DCR นี้)**: rr-waveh พิมพ์ warning `startMailer ล้มใน finally` **7 จุด** และจบรอบโดย **mailer ค้าง stop** (docker compose ps ไม่เห็น) — คำสั่ง `docker compose start mailer` ประเมิน `depends_on: app: condition: service_healthy` ใหม่ทุกครั้ง และเจอ ltc-dev-app **unhealthy (FailingStreak 79 ≈ 20 นาที ต่อเนื่อง 15:05-15:26Z)** ทั้งที่ host load 23% · healthcheck ของ app = `wget /api/health` timeout 10s — Next dev (CHOKIDAR_USEPOLLING/WATCHPACK_POLLING บน bind mount Windows) ตอบ /api/health >10s ช่วงมี file churn จากการรันเทส (งานเขียน log ลง .omc ใน repo ที่ container mount อยู่) · หลักฐานปิดกล่อง: `docker compose restart app` (~15:28Z) → healthy ทันที 0.33s → `docker compose start mailer` คำสั่งเดิมสำเร็จทันที — ตัวขวางคือการประเมิน dependency ไม่ใช่ตัว mailer · ผลกระทบต่อ full-suite: stack-integrity check (เงื่อนไข qa binding ข้อ 2 ของ DCR-TEARDOWN-GUARD = cron 8 + mailer Up) **จะตกแน่** ในรอบ 3 ชม. ถ้า app healthcheck พลิกแม้แต่ช่วงเดียวตอน suite กำลัง restore mailer
3. **เพดาน 30s ของ dcr9 แปดเคสไม่มี headroom บนสภาพปกติของเครื่องนี้ (two-strike ครบ)**: rr-dcr9 ล้ม **6 เคส (2,3,4,5,7,9) ที่ 30000ms พอดีหมด ไม่มี assertion fail เดียว** ขณะที่เคสที่ผ่านวัดได้ 13.2-46.6s (เคส 1 ผ่าน 27.4s · เคส 6 ผ่าน 28.3s — ชิดเพดาน · เคส 12 ผ่าน 46.6s ใต้เพดาน 110s ที่ DCR ก่อนขยับไว้แล้ว = หลักฐานว่าเพดานที่ขยับแล้วยืนได้) · strike ก่อนหน้า: rb3-dcr9 (20:20) เคส 1 ล้ม 30s พอดีในหน้าต่างเดียวกัน · สีเขียวล่าสุดของ suite = 198s ทั้งไฟล์ (เครื่องว่างเปล่า 14:2x) เฉลี่ย ~13s/เคส — คือ "ช้าในตัว" ของ psql side-channel บนเครื่องสำรอง (วัด 0.5-1.4s/ครั้ง) ไม่ใช่ความผิดที่โค้ดเทส · full-suite ยิ่งช้ากว่า isolated (ตามที่เคยวัด: dcr10 isolated 419s vs in-suite ช้ากว่า) → เพดาน 30s ของเคสกลุ่มนี้จะแดงแนวโน้มสูงในรอบ 35 ไฟล์

## ทางแก้ (2 จุด — test-infra เท่านั้น)

| จุด | แก้ | ไฟล์:บรรทัด (15 จุด) |
|---|---|---|
| 1 | **startMailer เปลี่ยน `docker compose start mailer` → `docker start ltc-dev-mailer`**: docker start สั่ง start container เดิมตรง ๆ **ไม่ประเมิน depends_on ใหม่** (ตัวเดียวที่ทำให้ล้มทั้ง 7 จุดคืนนี้) · ความหมายเชิงพฤติกรรมไม่เปลี่ยน: container_name ตายตัวใน compose (`ltc-dev-mailer`) · loop ของ mailer ทน app ล่มได้เอง (curl -m 25 + code=curl_failed + ลองใหม่ทุก 30s ตาม docker-compose.yml:349-353) — dependency gating ของ compose เป็นการป้องกันตอน "สตาร์ทเย็น" ไม่ใช่เงื่อนไขที่ mailer ต้องการจริงตอน restore กลางเทส · stopMailer คง `docker compose stop mailer` (stop ไม่ประเมิน deps — ไม่เคยล้ม) · deadline 60s + warning fail-loud greppable ของ DCR-TEARDOWN-GUARD จุด 3 คงเดิมครบทุกจุด | dcr11-admin:142 · dcr11-identity:144 · dcr11-pdpa:105 · dcr10-notifications:254 · dcr12-p5r1-hardening:139 · wave-h-window-coordinator:59 · wave-h-owner-proof:75,83 · wave-h-battery-audit-guards:1058,1157,1291,1423,1603,1873,2023 |
| 2 | **dcr9 budget แปดเคส 30s→75s (อัตรา ×2.5 เดียวกับที่ GO ไปแล้วใน DCR-GATEWAY-ERRBODY-REBASELINE จุด 3)**: เพิ่ม per-test `timeout: 75_000` ที่เคส 1,2,3,4,5,6,7,9 — ครบตามเงื่อนไข pm ข้อ 3 "ขยับ budget ได้เมื่อวัดใหม่" (ตัวเลขวัด = rr-dcr9 ในหลักฐานข้อ 3) · ไม่แต่เคส 8,10,11,13 (ผ่านที่ 5.7-13.2s มี headroom) · เคส 12 อยู่ที่ 110s อยู่แล้ว · global testTimeout 30_000 ของ config ไม่ขยับ (ไฟล์อื่น 34 ไฟล์ผ่านที่เพดานนี้มาแล้วทั้งคืน) | dcr9-credit.test.ts:619,673,707,747,773,863,955,1034 |

## แผนทดสอบ (หลัง implement)

1. isolated dcr9-credit detached → ต้อง **13/13** ใต้เพดานใหม่ (log it-rr2-dcr9.log)
2. isolated wave-h-battery-audit-guards detached → ต้องเขียว **และไม่มี warning `startMailer ล้ม` แม้จุดเดียว** + จบรอบ mailer Up + cron 8 (log it-rr2-waveh.log) — จุด 1 ต้องพิสูจน์ตัวเองด้วยการเงียบของ warning
3. full-suite 35 ไฟล์ detached (3h cap) + stack-integrity check (cron 8 ตัวพอดี + mailer Up) ตาม binding เดิม → qa gate → battery r38 → merge --no-ff

## คำถามที่ยังเปิด (ไม่บล็อก)

- **ต้นเหตุชั้นลึกของ app healthcheck flap ช่วงรันเทส** (Next dev polling watchers บน bind mount Windows + file churn จาก log ของเทสเอง): ยกเป็น OQ เพิ่มของ DCR-PROD-DEPLOY-DRAFT (บันทึก dev-parity: prod runtime :3001 = next start ไม่มี dev watcher — อาการนี้เป็น dev-only) · ทางแก้ในอนาคตที่เป็นไปได้ (ยกไว้ ไม่ทำรอบนี้): ย้าย .omc ออกนอก bind mount / ปรับ healthcheck dev
- จุด 1 ทำให้ "mailer start ตอน app ตายจริง" เป็นไปได้ (เคยเป็นไปไม่ได้) — ยอมรับโดยเจตนา: mailer ทน app ล่มได้ตามดีไซน์ loop ของตัวเอง และการตายจริงของ app จะถูกจับโดย compose ps + full-suite stack-integrity + battery อยู่แล้ว (ไม่ mask)

## ฉันทามติ + GO (รอ)

- รอ pm (scope + หลัก budget ข้อ 3 ครบเงื่อนไข "วัดใหม่"?) + qa (จุด 1: การ bypass dependency-gating ยอมรับได้? · จุด 2: ตัวเลข/ขอบเขต 8 เคส) ผ่าน bridge
