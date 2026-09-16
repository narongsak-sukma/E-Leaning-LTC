#!/bin/sh
# Wave H D90 [#94] — heap sampler (dev-only)
# บันทึกหนึ่งแถว JSON ต่อการเรียก ลง JSONL (append) เพื่อพิสูจน์ว่า heap ที่ตั้งอยู่พอ/ไม่พอ
# (D90 เดิมตั้ง 6144 · ถอยเป็น 4096 ตามเกณฑ์ rollback หลัง battery r1 เจอ kernel-OOM ของ VM)
# ใช้โดย: มือ (ติดตาม 24 ชม. ด้วย --watch) และ scripts/battery-run.mjs (จุดเริ่ม/จบ battery)
# ต้องการ: docker · ไม่มี dependency อื่น · ไม่ log ค่าใดที่เป็นความลับ
#
# ใช้: scripts/heap-sampler.sh [--container ltc-dev-app] [--out .omc/artifacts/heap-samples.jsonl]
#        [--label battery-start] [--watch 60]
# ออก: แถว {ts,label,container,container_id,started_at,mem_usage,mem_pct,restart_count,oom_killed,health}
#      container_id/started_at = identity ของ container ตาม D90 เกณฑ์ข้อ 1 (verdict r21) — ทุกแถวพิสูจน์ ID เดียวได้เอง
#      ไม่มี container/สั่ง docker ไม่ได้ = exit 2 พร้อมข้อความ (ไม่เขียนแถวปลอม)

set -eu

CONTAINER="ltc-dev-app"
OUT=".omc/artifacts/heap-samples.jsonl"
LABEL="manual"
WATCH="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --label)     LABEL="$2"; shift 2 ;;
    --watch)     WATCH="$2"; shift 2 ;;
    *) echo "heap-sampler: unknown arg: $1" >&2; exit 2 ;;
  esac
done

sample_once() {
  STATS="$(docker stats --no-stream --format '{{.MemUsage}}|{{.MemPerc}}' "$CONTAINER" 2>/dev/null)" || {
    echo "heap-sampler: docker stats ล้มเหลวสำหรับ $CONTAINER" >&2
    return 2
  }
  INSPECT="$(docker inspect --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)" || {
    echo "heap-sampler: docker inspect ล้มเหลวสำหรับ $CONTAINER" >&2
    return 2
  }
  MEM_USAGE="${STATS%%|*}"
  REST="${STATS#*|}"
  MEM_PCT="${REST%%|*}"
  if [ "$MEM_PCT" = "$REST" ] && [ "$MEM_USAGE" = "$STATS" ]; then
    echo "heap-sampler: รูปแบบ docker stats ไม่ตรงที่คาด: $STATS" >&2
    return 2
  fi
  CONTAINER_ID="${INSPECT%%|*}"
  R0="${INSPECT#*|}"
  STARTED_AT="${R0%%|*}"
  R1="${R0#*|}"
  RESTART_COUNT="${R1%%|*}"
  R2="${R1#*|}"
  OOM_KILLED="${R2%%|*}"
  HEALTH="${R2#*|}"
  mkdir -p "$(dirname "$OUT")"
  printf '{"ts":"%s","label":"%s","container":"%s","container_id":"%s","started_at":"%s","mem_usage":"%s","mem_pct":"%s","restart_count":%s,"oom_killed":%s,"health":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LABEL" "$CONTAINER" "$CONTAINER_ID" "$STARTED_AT" "$MEM_USAGE" "$MEM_PCT" "$RESTART_COUNT" "$OOM_KILLED" "$HEALTH" >> "$OUT"
}

if [ "$WATCH" = "0" ]; then
  sample_once
else
  echo "heap-sampler: ทุก $WATCH วินาที — Ctrl-C เพื่อหยุด (append $OUT)"
  while :; do
    sample_once || exit 2
    sleep "$WATCH"
  done
fi
