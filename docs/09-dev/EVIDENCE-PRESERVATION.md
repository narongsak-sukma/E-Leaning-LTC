# การรักษาหลักฐานสภาพแวดล้อม dev (D90) — Wave I เฟส 1

แหล่ง: verdict r21 (เกณฑ์ D90 3 ข้อ) + verdict r22 (คำสั่งเปิด Wave I ลำดับแรก = รักษาหลักฐาน) · บาดแผลที่ทำให้ต้องมีเอกสารนี้: restart 5 จุดของ container เก่ากลายเป็น "อธิบายไม่ได้ถาวร" เพราะ `docker compose down -v` ทำลาย container พร้อม `docker logs` ทั้งหมดก่อนมีใครอ่าน (PROJECT-STATE บันทึก r20–r22)

## กติกา

### E1 — ทุกแถว heap-samples ต้องมี identity ของ container

`scripts/heap-sampler.sh` เพิ่มสองฟิลด์ในทุกแถว JSONL:

- `container_id` — full ID 64 hex จาก `docker inspect --format '{{.Id}}'` (แยกจากฟิลด์ `container` เดิมที่เป็นชื่อ)
- `started_at` — `{{.State.StartedAt}}` ของ container ปัจจุบัน (จับคู่กับ anchor ได้ทุกแถว ไม่ต้องรอ anchor ปลายรอบ)

เหตุผล: เกณฑ์ D90 ข้อ 1 ต้องการ "เวลา UTC, ID, StartedAt และ RestartCount ก่อน–หลัง" ต่อ battery — เมื่อทุกแถวมี identity ครบ คู่ battery-start/battery-end พิสูจน์ "container ID เดียว + counter คงเดิม" ได้จากไฟล์เดียวโดยไม่ต้องอ้างหลักฐานภายนอก

### E2 — dump logs ก่อนทำลาย/recreate container ทุกครั้ง (fail-closed)

คำสั่งที่ทำลาย **หรือ recreate** container ต้องรัน `scripts/dump-app-logs.sh` ก่อนเสมอ สคริปต์เขียนสองไฟล์ต่อการ dump:

- `.omc/artifacts/app-logs-<UTC-ts>-<pid>.log` — `docker logs --timestamps <container>` เต็ม (ทุกบรรทัดมี timestamp ของ docker นำหน้า — เกณฑ์ D90 ข้อ 2 verbatim "เก็บ logs พร้อม timestamps ครอบคลุมทั้งหน้าต่าง"; `captured_at` ใน meta ใช้แทนไม่ได้)
- `.omc/artifacts/app-logs-<UTC-ts>-<pid>.meta.txt` — `captured_at` + `pid` (identity ของ invocation) แยกจากเวลาของ container + Name/ID/Created/StartedAt/Running/Status/RestartCount/OOMKilled (รูปเดียวกับ anchor)
- ชื่อไฟล์จองเฉพาะต่อ invocation (วินาที UTC + PID) — dump สองครั้งในวินาทีเดียวกันได้สองชุด ไม่ truncate ของเดิม · การ `rm` เมื่อล้มจึงแตะเฉพาะไฟล์ของ invocation ตัวเอง

พฤติกรรม (แยก "ยืนยันว่าไม่มี" ออกจาก "inspect ล้มด้วยเหตุอื่น" — ตาม verdict wavei-r1):

| สภาพ (วิธีตรวจ) | ผลลัพธ์ |
|---|---|
| container มี · dump สำเร็จ | เขียนครบสองไฟล์ · exit 0 — ผู้เรียกทำลายต่อได้ |
| container มี · `docker logs` ล้ม | **exit 2 ห้ามทำลาย** (fail-closed — หลักฐานมีค่ากว่าความสะดวก) |
| ไม่มี container · **ยืนยันแล้ว** (stderr ของ inspect มี `No such object`/`No such container` จาก docker เท่านั้น) | เตือนแล้ว exit 0 (ไม่มีอะไรจะเสีย) |
| inspect ล้มด้วยเหตุอื่น (daemon ตาย · permission · ฯลฯ) — ยืนยันว่าไม่มีไม่ได้ | **exit 3 ห้ามทำลาย** จนกว่าจะตรวจสอบด้วยตา (ไม่มีสิทธิ์เดาว่า "คงไม่มี") |

ทางเข้าที่ Makefile ครอบ (สคริปต์เป็นบรรทัดแรก — `make` หยุดที่ exit ≠ 0 เพราะ `SHELL := /bin/sh` ไม่มี `-f`):

- `make down` — ก่อน `docker compose down`
- `make reset-db` — ก่อน `docker compose down -v`
- `make up` — ก่อน `docker compose up -d --build` (rebuild อาจ recreate app container = logs เดิมสูญ) · `make dev` ผ่าน dependency `dev: up` จึงครอบอัตโนมัติ

กติกาสำหรับมือ: ก่อนเรียก `docker compose down [-v]` · `docker compose up -d --build` · `docker rm <container>` · หรือคำสั่งใดที่ recreate/remove app container ด้วยมือ ให้รัน `make dump-logs` ก่อนและอ่าน exit code ตามตารางข้างบน — เครื่องมืออื่นที่จะทำลาย container ต้องเรียกสคริปต์นี้แทนการเดา

### E3 — การนับ D90 เริ่มเฉพาะหลัง E1+E2 ลงจริง

ตามเกณฑ์ verdict r21 ข้อ 3 verbatim: "เริ่มเก็บ identity และรักษา logs **ก่อนรอบแรกที่นับ**; dump ก่อน reset/remove ทุกครั้ง หากเปลี่ยน container หรือหลักฐานขาด ให้เริ่มนับสามรอบใหม่" — battery ที่วิ่งก่อน E1+E2 ผ่าน gate ไม่นับเข้าสามรอบ

## หลักฐานของเฟสนี้ (เก็บใน `.omc/artifacts/` — ไม่ commit)

- แถว sampler จริงพร้อม `container_id` + `started_at` (`heap-samples-proof.jsonl`)
- ไฟล์ dump จริง + meta ตรง anchor ปัจจุบัน — ทุกบรรทัดของ `.log` ต้องมี timestamp ของ docker นำหน้า (นับ `^20xx-` ได้เท่าจำนวนแถว)
- ทิศลบ: stub `docker` ที่ inspect ผ่านแต่ logs ล้ม → สคริปต์ต้อง exit 2 (ห้ามเขียนไฟล์ครึ่ง ๆ แล้วเงียบ)
- กรณีไม่มี container สองแบบ: **ยืนยันแล้ว** (stub stderr `No such object` / ชื่อไม่มีจริง) → exit 0 เตือน · **ยืนยันไม่ได้** (stub permission error) → exit 3 ห้ามทำลาย
- dump สองครั้งติดกันในวินาทีเดียวกัน → ได้สองชุดไฟล์ต่างชื่อ (PID ต่าง) ชุดเดิมไม่ถูกแตะ
- ลำดับบรรทัด Makefile: บรรทัด dump อยู่ก่อน `down` · `down -v` · `up -d --build` เสมอ (grep -n + `make -n`)
