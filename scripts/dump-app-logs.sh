#!/bin/sh
# Wave I เฟส 1 [#94] — dump logs ของ app container ก่อนถูกทำลาย (D90 เกณฑ์ข้อ 2/3: timestamps + dump ก่อน reset/remove ทุกครั้ง)
# กติกา: docs/09-dev/EVIDENCE-PRESERVATION.md (E2) — แก้ตาม verdict wavei-r1 ทั้ง 4 MAJOR:
#   (1) แยก "ยืนยันว่าไม่มี container" (No such object/container) ออกจาก inspect error อื่น — ยืนยันไม่ได้ = exit 3
#   (2) ทางเข้า make up/dev เพิ่ม dump แล้ว (up -d --build อาจ recreate container)
#   (3) docker logs --timestamps ทุกบรรทัด (เกณฑ์ D90 ข้อ 2 — captured_at แทนไม่ได้)
#   (4) ชื่อไฟล์จองเฉพาะต่อ invocation (UTC วินาที + PID) — ซ้ำในวินาทีเดียวกันไม่ truncate/rm หลักฐานเดิม
# เขียนสองไฟล์: app-logs-<UTC-ts>-<pid>.log (docker logs --timestamps เต็ม) + .meta.txt (identity รูป anchor)
# exit: 0 = ครบหรือยืนยันไม่มี container · 2 = มี container แต่ docker logs ล้ม (ห้ามทำลาย) · 3 = inspect ยืนยันไม่ได้ (ห้ามทำลาย)
# ใช้โดย: Makefile (down · reset-db · up) และมือ (make dump-logs ก่อนเรียก docker compose/rm ด้วยมือ)
# ต้องการ: docker · ไม่มี dependency อื่น · ไม่ log ค่าใดที่เป็นความลับ

set -eu

CONTAINER="ltc-dev-app"
OUTDIR=".omc/artifacts"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --out-dir)   OUTDIR="$2"; shift 2 ;;
    *) echo "dump-app-logs: unknown arg: $1" >&2; exit 2 ;;
  esac
done

INSPECT_FMT='{{.Name}}|{{.Id}}|{{.Created}}|{{.State.StartedAt}}|{{.State.Running}}|{{.State.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}'

# จับ stderr เข้าตัวแปรเพื่อแยก "ไม่มี container จริง" (ข้อความ no such object/container จาก docker)
# ออกจาก "inspect ล้มเพราะเหตุอื่น" (daemon ตาย/permission) — หลังเกณฑ์ wavei-r1 MAJOR 1
# (normalize ตัวพิมพ์ก่อนเทียบ: docker CLI ใหม่พิมพ์ "error: no such object" พิมพ์เล็ก)
META_FULL="$(docker inspect --format "$INSPECT_FMT" "$CONTAINER" 2>&1)" || {
  ERR_LC="$(printf '%s' "$META_FULL" | tr '[:upper:]' '[:lower:]')"
  case "$ERR_LC" in
    *"no such object"*|*"no such container"*)
      echo "dump-app-logs: ยืนยันแล้วไม่มี container '$CONTAINER' — ผ่านไปได้ (ไม่มีหลักฐานจะสูญ)" >&2
      exit 0
      ;;
    *)
      echo "dump-app-logs: docker inspect ล้มและยืนยันไม่ได้ว่าไม่มี container '$CONTAINER' — ห้ามทำลายจนกว่าจะตรวจได้ว่า: $META_FULL" >&2
      exit 3
      ;;
  esac
}

# ชื่อจองเฉพาะต่อ invocation: วินาที UTC + PID (wavei-r1 MAJOR 4 — dump ซ้ำในวินาทีเดียวกันต้องไม่ชนของเดิม)
TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
BASE="$OUTDIR/app-logs-$TS-$$"
LOG_FILE="$BASE.log"
META_FILE="$BASE.meta.txt"

mkdir -p "$OUTDIR"

# dump ก่อนเขียน meta เสมอ — logs ล้ม = ออกทันที ลบได้เฉพาะไฟล์ของ invocation นี้ (ชื่อจองไว้แล้ว ไม่แตะของรอบก่อน)
if ! docker logs --timestamps "$CONTAINER" > "$LOG_FILE" 2>&1; then
  echo "dump-app-logs: docker logs ล้มเหลวสำหรับ $CONTAINER — ห้ามทำลาย container จนกว่าจะ dump ได้ (ตรวจด้วยตาแล้วรันใหม่)" >&2
  rm -f "$LOG_FILE"
  exit 2
fi

NAME="${META_FULL%%|*}"
M1="${META_FULL#*|}"
ID="${M1%%|*}"
M2="${M1#*|}"
CREATED="${M2%%|*}"
M3="${M2#*|}"
STARTED_AT="${M3%%|*}"
M4="${M3#*|}"
RUNNING="${M4%%|*}"
M5="${M4#*|}"
STATUS="${M5%%|*}"
M6="${M5#*|}"
RESTART_COUNT="${M6%%|*}"
OOM_KILLED="${M6#*|}"

{
  echo "captured_at=$TS"
  echo "pid=$$"
  echo ""
  echo "Name=$NAME"
  echo "ID=$ID"
  echo "Created=$CREATED"
  echo "StartedAt=$STARTED_AT"
  echo "Running=$RUNNING"
  echo "Status=$STATUS"
  echo "RestartCount=$RESTART_COUNT"
  echo "OOMKilled=$OOM_KILLED"
} > "$META_FILE"

LINES="$(wc -l < "$LOG_FILE" | tr -d ' ')"
STAMPED="$(grep -c '^20[0-9][0-9]-' "$LOG_FILE" || true)"
echo "dump-app-logs: ครบ — $LOG_FILE ($LINES แถว · $STAMPED แถวมี timestamp นำหน้า) + $META_FILE (RestartCount=$RESTART_COUNT)"
