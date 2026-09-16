# การรักษาหลักฐานสภาพแวดล้อม dev (D90) — Wave I เฟส 1

แหล่ง: verdict r21 (เกณฑ์ D90 3 ข้อ) + verdict r22 (คำสั่งเปิด Wave I ลำดับแรก = รักษาหลักฐาน) · บาดแผลที่ทำให้ต้องมีเอกสารนี้: restart 5 จุดของ container เก่ากลายเป็น "อธิบายไม่ได้ถาวร" เพราะ `docker compose down -v` ทำลาย container พร้อม `docker logs` ทั้งหมดก่อนมีใครอ่าน (PROJECT-STATE บันทึก r20–r22)

## กติกา

### E1 — ทุกแถว heap-samples ต้องมี identity ของ container

`scripts/heap-sampler.sh` เพิ่มสองฟิลด์ในทุกแถว JSONL:

- `container_id` — full ID 64 hex จาก `docker inspect --format '{{.Id}}'` (แยกจากฟิลด์ `container` เดิมที่เป็นชื่อ)
- `started_at` — `{{.State.StartedAt}}` ของ container ปัจจุบัน (จับคู่กับ anchor ได้ทุกแถว ไม่ต้องรอ anchor ปลายรอบ)

เหตุผล: เกณฑ์ D90 ข้อ 1 ต้องการ "เวลา UTC, ID, StartedAt และ RestartCount ก่อน–หลัง" ต่อ battery — เมื่อทุกแถวมี identity ครบ คู่ battery-start/battery-end พิสูจน์ "container ID เดียว + counter คงเดิม" ได้จากไฟล์เดียวโดยไม่ต้องอ้างหลักฐานภายนอก

### E2 — dump logs ก่อนทำลาย container ทุกครั้ง (fail-closed)

คำสั่งที่ทำลาย container (`make down` · `make reset-db` — รวมถึงเรียก `docker compose down [-v]` มือเอง) ต้องรัน `scripts/dump-app-logs.sh` ก่อนเสมอ สคริปต์เขียนสองไฟล์ต่อการ dump:

- `.omc/artifacts/app-logs-<UTC-ts>.log` — `docker logs <container>` เต็ม (บริสุทธิ์ ไม่แต่ง เพื่อ grep ได้)
- `.omc/artifacts/app-logs-<UTC-ts>.meta.txt` — `captured_at` แยกจากเวลาของ container + Name/ID/Created/StartedAt/Running/Status/RestartCount/OOMKilled (รูปเดียวกับ anchor)

พฤติกรรม:

| สภาพ | ผลลัพธ์ |
|---|---|
| container มี · dump สำเร็จ | เขียนครบสองไฟล์ · exit 0 — ผู้เรียกทำลายต่อได้ |
| container มี · `docker logs` ล้ม | **exit 2 ห้ามทำลาย** (fail-closed — หลักฐานมีค่ากว่าความสะดวก) |
| ไม่มี container ให้ dump | เตือนแล้ว exit 0 (ไม่มีอะไรจะเสีย) |

Makefile เรียกสคริปต์เป็นบรรทัดแรกของ `down` และ `reset-db` — ล้ม = เป้าหมายสะดวกจะไม่ไปถึง `docker compose down` เพราะ `make` หยุดที่ exit ≠ 0 (`SHELL := /bin/sh` ไม่มี `-f`)

### E3 — การนับ D90 เริ่มเฉพาะหลัง E1+E2 ลงจริง

ตามเกณฑ์ verdict r21 ข้อ 3 verbatim: "เริ่มเก็บ identity และรักษา logs **ก่อนรอบแรกที่นับ**; dump ก่อน reset/remove ทุกครั้ง หากเปลี่ยน container หรือหลักฐานขาด ให้เริ่มนับสามรอบใหม่" — battery ที่วิ่งก่อน E1+E2 ผ่าน gate ไม่นับเข้าสามรอบ

## หลักฐานของเฟสนี้ (เก็บใน `.omc/artifacts/` — ไม่ commit)

- แถว sampler จริงพร้อม `container_id` + `started_at` (`heap-samples-proof.jsonl`)
- ไฟล์ dump จริง + meta ตรง anchor ปัจจุบัน
- ทิศลบ: stub `docker` ที่ inspect ผ่านแต่ logs ล้ม → สคริปต์ต้อง exit 2 (ห้ามเขียนไฟล์ครึ่ง ๆ แล้วเงียบ)
- กรณีไม่มี container → exit 0 พร้อมข้อความเตือน
- ลำดับบรรทัด Makefile: บรรทัด dump อยู่ก่อน `down -v` เสมอ (grep -n)
