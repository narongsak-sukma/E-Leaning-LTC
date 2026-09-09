#!/usr/bin/env bash
# =============================================================================
# ci-local.sh — รัน merge gates 5 ด่านเดียวกับ CI บนเครื่อง ก่อน push / เปิด PR
# -----------------------------------------------------------------------------
# ใช้คู่กับ: .github/workflows/ci.yml และ .gitleaks.toml  [B-04]
# กฎ merge: ทุก PR ต้องผ่าน lint + typecheck + test + build + secrets scan
# ครบ 5 ด่าน (PROJECT-PLAN §3/§4) — สคริปต์นี้คือชุดเดียวกัน 5 ด่านบนเครื่อง
#
# การใช้งาน:  bash scripts/ci-local.sh
#
# Exit code:
#   0 = ผ่านทุกด่านที่รัน (ถ้า gate 5 ถูกข้ามเพราะไม่มี gitleaks binary จะมีคำเตือนชัด —
#       evidence ด่าน secrets ต้องยืนยันจาก CI ก่อน merge)
#   1 = มี gate ที่ fail (หยุดทันที ไม่รันด่านถัดไป — เหมือน CI)
#   2 = สภาพแวดล้อมยังไม่พร้อม (ยังไม่มี package.json / ยังไม่ npm ci) — ไม่ใช่
#       gate ที่พัง แต่เป็น "ยังรันไม่ได้" — ห้ามอ้างว่า gates ผ่าน
#
# หมายเหตุ: สคริปต์นี้ "ไม่ใช้ git" ตามกฎทีม (workers ห้ามใช้ git) — gate 5 สแกน
#   ไฟล์ใน working tree (--no-git) ส่วน git history ให้ CI (push/PR) เป็นผู้สแกน
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---- สี (ปิดอัตโนมัติเมื่อ output ไม่ใช่ terminal) ---------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BOLD=''; RESET=''
fi

# ---- ค่าคงที่ ---------------------------------------------------------------
EXIT_OK=0
EXIT_GATE_FAILED=1
EXIT_NOT_READY=2
NODE_MIN_MAJOR=22

LOG="$(mktemp "${TMPDIR:-/tmp}/ci-local.XXXXXX")"
trap 'rm -f "$LOG"' EXIT

RESULTS=() # แต่ละแถว: "name|status|exit|secs|note"
FAILED=0
SKIPPED_SECRETS=0
TEST_NOTE=""

# ---- ฟังก์ชันช่วย ------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
rule() { printf '%s\n' "--------------------------------------------------------------------------"; }

# record <name> <PASS|FAIL|SKIP> <exit> <secs> <note>
record() {
  RESULTS+=("$1|$2|$3|$4|$5")
}

print_summary() {
  local row name status exit_code secs note
  rule
  say "${BOLD}สรุปผล merge gates (local)${RESET}"
  rule
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r name status exit_code secs note <<< "$row"
    case "$status" in
      PASS) printf '  [PASS] %-22s exit=%-4s %-7s %s\n' "$name" "$exit_code" "$secs" "$note" ;;
      FAIL) printf '  [FAIL] %-22s exit=%-4s %-7s %s\n' "$name" "$exit_code" "$secs" "$note" ;;
      SKIP) printf '  [SKIP] %-22s exit=%-4s %-7s %s\n' "$name" "-" "$secs" "$note" ;;
      *)    printf '  %-28s %s\n' "$name" "$note" ;;
    esac
  done
  rule
  if [ "$FAILED" -eq 1 ]; then
    say "${RED}${BOLD}ผลรวม: ไม่ผ่าน — ห้าม push/merge (แก้ gate ที่พังแล้วรันใหม่)${RESET}"
    say "        exit code รวม = ${EXIT_GATE_FAILED}"
  elif [ "$SKIPPED_SECRETS" -eq 1 ]; then
    say "${YELLOW}${BOLD}ผลรวม: ผ่านทุกด่านที่รันได้ แต่ gate 5 (secrets) ถูกข้าม — ยืนยันจาก CI ก่อน merge${RESET}"
    say "        exit code รวม = ${EXIT_OK} (evidence ยังไม่ครบ 5 ด่าน)"
  else
    say "${GREEN}${BOLD}ผลรวม: ผ่านครบ 5 ด่าน — push ได้ (CI จะยืนยันอีกชั้น)${RESET}"
    say "        exit code รวม = ${EXIT_OK}"
  fi
}

# ---- ฟังก์ชัน gate (คำสั่งเดียวกับ CI ทุกด่าน) -------------------------------
gate_lint()      { npm run lint; }
gate_typecheck() { npm run typecheck; }
gate_test()      { npm run test; }
gate_build()     { npm run build; }
gate_secrets()   {
  gitleaks detect --no-git --source "$ROOT" --config "$ROOT/.gitleaks.toml" --redact --verbose
}

# ---- รัน 1 gate พร้อมจับเวลา/ผล ----------------------------------------------
# $1 = ชื่อแสดงผล, $2 = ชื่อฟังก์ชัน gate
run_gate() {
  local name="$1" fn="$2"
  local start secs status
  printf '%s\n' "${BOLD}[gate] $name${RESET} — กำลังรัน..."
  start="$(date +%s)"
  status=0
  if "$fn" >"$LOG" 2>&1; then
    status=0
  else
    status=$?
  fi
  secs="$(( $(date +%s) - start ))s"
  if [ "$status" -eq 0 ]; then
    record "$name" "PASS" "0" "$secs" ""
    printf '%s\n' "${GREEN}[PASS] $name (${secs})${RESET}"
  else
    record "$name" "FAIL" "$status" "$secs" ""
    printf '%s\n' "${RED}[FAIL] $name (exit $status)${RESET}"
    say "----- log ช่วงท้ายของ gate ที่พัง -----"
    tail -n 30 "$LOG" || true
    say "-------------------------------------"
  fi
  return "$status"
}

# =============================================================================
# ขั้นที่ 0 — ตรวจสภาพแวดล้อมก่อนรัน gates (ยังไม่พร้อม = exit 2 อย่างตรงไปตรงมา)
# =============================================================================
say ""
say "${BOLD}=== LTC E-Learning — local merge gates [B-04] ===${RESET}"
say ""

if [ ! -f package.json ]; then
  say "${RED}ยังไม่มี package.json ที่ root — repo scaffold (task B-01) ยังไม่เสร็จ${RESET}"
  say "จึงยังรัน gates ไม่ได้แม้แต่ด่านเดียว — รอ worker-b1 เสร็จแล้วรันใหม่"
  say "(mark: re-run needed after B-01)"
  exit "$EXIT_NOT_READY"
fi

if [ ! -d node_modules ]; then
  say "${RED}ยังไม่มี node_modules — ติดตั้ง dependencies ก่อนด้วย: npm ci${RESET}"
  exit "$EXIT_NOT_READY"
fi

if ! command -v node >/dev/null 2>&1; then
  say "${RED}ไม่พบ node — ต้องมี Node.js ${NODE_MIN_MAJOR}+ บนเครื่อง${RESET}"
  exit "$EXIT_NOT_READY"
fi

NODE_MAJOR="$(node -p 'parseInt(process.versions.node, 10)' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  say "${YELLOW}คำเตือน: node v${NODE_MAJOR} ต่ำกว่าที่ CI ใช้ (Node 22 LTS) — ผลอาจต่างจาก CI${RESET}"
fi

if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS_BIN="$(command -v gitleaks)"
  say "gitleaks: $GITLEAKS_BIN ($(gitleaks version 2>/dev/null | head -1))"
else
  SKIPPED_SECRETS=1
  say "${YELLOW}คำเตือน: ไม่พบ gitleaks binary บนเครื่อง — gate 5 จะถูกข้าม (CI ยังสแกนจริง)${RESET}"
fi

say ""

# =============================================================================
# รัน gates ตามลำดับ — lint → typecheck → test → build → secrets (fail fast)
# =============================================================================
run_gate "1/5 lint (npm run lint)" gate_lint || FAILED=1
if [ "$FAILED" -eq 0 ]; then
  run_gate "2/5 typecheck (npm run typecheck)" gate_typecheck || FAILED=1
fi
if [ "$FAILED" -eq 0 ]; then
  run_gate "3/5 test (npm run test)" gate_test || FAILED=1
  # เก็บจำนวน test จาก output ของ vitest เป็น evidence (DoD: exit code + test count)
  TEST_NOTE="$(grep -Eo '[0-9]+ passed' "$LOG" | tail -1 || true)"
fi
if [ "$FAILED" -eq 0 ]; then
  run_gate "4/5 build (npm run build)" gate_build || FAILED=1
fi
if [ "$FAILED" -eq 0 ] && [ "$SKIPPED_SECRETS" -eq 0 ]; then
  run_gate "5/5 secrets (gitleaks)" gate_secrets || FAILED=1
fi

# =============================================================================
# สรุปผล + exit code รวม
# =============================================================================
say ""
print_summary
if [ -n "$TEST_NOTE" ]; then
  say "จำนวน test (จาก vitest): $TEST_NOTE"
fi
say ""

if [ "$FAILED" -eq 1 ]; then
  exit "$EXIT_GATE_FAILED"
fi
exit "$EXIT_OK"
