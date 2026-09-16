#!/bin/sh
# Wave I เฟส 1 [#94] — dump logs ของ app container ก่อนถูกทำลาย (D90 เกณฑ์ข้อ 3: "dump ก่อน reset/remove ทุกครั้ง")
# กติกา: docs/09-dev/EVIDENCE-PRESERVATION.md (E2)
# เขียนสองไฟล์: .omc/artifacts/app-logs-<UTC-ts>.log (docker logs เต็ม บริสุทธิ์) + .meta.txt (identity รูป anchor)
# พฤติกรรม: container มี + dump ผ่าน = exit 0 · container มี + logs ล้ม = exit 2 (fail-closed ห้ามทำลาย)
#           ไม่มี container ให้ dump = เตือนแล้ว exit 0
# ใช้โดย: Makefile (down · reset-db — บรรทัดแรกก่อน docker compose down) และมือ
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

META_FULL="$(docker inspect --format '{{.Name}}|{{.Id}}|{{.Created}}|{{.State.StartedAt}}|{{.State.Running}}|{{.State.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}' "$CONTAINER" 2>/dev/null)" || {
  echo "dump-app-logs: ไม่มี container '$CONTAINER' ให้ dump — ผ่านไปได้ (ไม่มีหลักฐานจะสูญ)" >&2
  exit 0
}

TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
LOG_FILE="$OUTDIR/app-logs-$TS.log"
META_FILE="$OUTDIR/app-logs-$TS.meta.txt"

mkdir -p "$OUTDIR"

# dump ก่อนเขียน meta เสมอ — logs ล้ม = ออกทันทีก่อนสร้าง meta ครึ่ง ๆ กลาง และห้ามให้ผู้เรียกทำลาย container
if ! docker logs "$CONTAINER" > "$LOG_FILE" 2>&1; then
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
echo "dump-app-logs: ครบ — $LOG_FILE ($LINES แถว) + $META_FILE (RestartCount=$RESTART_COUNT)"
