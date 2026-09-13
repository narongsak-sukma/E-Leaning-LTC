#!/usr/bin/env bash
# ============================================================================
# scripts/uat-seed.sh - เตรียมข้อมูล UAT ให้ dev stack (Wave F Phase 3 · D-f-11)
#
# ทำ 3 อย่าง:
#   1) รหัสผ่านชุด UAT: จาก env UAT_DEMO_PASSWORD หรือสุ่มใหม่ (พิมพ์ครั้งเดียวท้ายสคริปต์
#      เฉพาะเมื่อ stdout เป็น terminal — redirect/เก็บ transcript = ไม่พิมพ์ กันติด log)
#      — ไม่เขียนลง repo · ไม่ส่งผ่าน argv ของโปรเซสใด (curl/psql รับ secret ทางไฟล์ temp
#      600/stdin เท่านั้น — gate p4-r1 M1) · เก็บซ้ำได้ที่ .env (UAT_DEMO_PASSWORD=...)
#   2) วิดีโอสาธิต 10 วิ: ใช้ไฟล์แคช .omc/artifacts/uat/uat-video.mp4 → ไม่มีก็ดาวน์โหลดครั้งเดียว
#      (Big Buck Bunny © Blender Foundation · CC-BY 3.0 — ขอบคุณ/แสดงที่มาใน UAT.md)
#      แล้วอัปโหลดเข้า bucket 'media' ที่ courses/uat-intro/intro.mp4 (ข้ามถ้ามีอยู่แล้ว)
#   3) apply supabase/seed-uat.sql (บัญชี 8 บัญชี + หลักสูตร/ข้อสอบ UAT) ผ่าน psql ใน container db
#
# ใช้ได้เมื่อ: dev stack รันอยู่ (docker compose up -d) · รันซ้ำได้ (seed idempotent —
#   รันซ้ำ = ตั้งรหัสผ่านใหม่ให้ทุกบัญชีตามค่าที่ส่งเข้ามา)
#
# การใช้งาน:  bash scripts/uat-seed.sh            # สุ่มรหัสผ่านใหม่
#             UAT_DEMO_PASSWORD='...' bash scripts/uat-seed.sh   # ใช้รหัสที่กำหนดเอง (≥12 ตัว)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

UAT_MEDIA_URL="https://www.w3schools.com/html/mov_bbb.mp4" # 10 วิ · ~1.0 MB · H.264/AAC เล่นได้ใน Chromium
VIDEO_CACHE=".omc/artifacts/uat/uat-video.mp4"
VIDEO_OBJ="courses/uat-intro/intro.mp4"
SEED_FILE="supabase/seed-uat.sql"
TMP_HDR=""

cleanup() { [[ -n "$TMP_HDR" ]] && rm -f "$TMP_HDR" || true; }
trap cleanup EXIT

log() { printf "%s\n" "[uat-seed] $*"; }

# ── 0) ตรวจ dev stack + guard ว่าเป้าหมายคือ local dev จริง (gate p4-r1 M2) ──
if ! docker compose ps db 2>/dev/null | grep -q "running\|healthy"; then
  log "ERROR: service db ไม่ได้รัน — เริ่มด้วย: docker compose up -d"
  exit 1
fi
# สองชั้นกัน seed รั่วไป environment อื่น: (1) SUPABASE_URL ใน .env ต้องเป็น localhost
# (2) docker CLI ต้องไม่ถูกชี้ไปเครื่องอื่นด้วย DOCKER_HOST — seed นี้สร้างบัญชี
# privileged ใน auth.users โดยตรง จึงห้ามรันกับ compose ที่ชี้ prod/staging เด็ดขาด
if [[ -f .env ]]; then
  SUPA_HOST=$(grep -E '^SUPABASE_URL=' .env | head -1 | cut -d= -f2- | sed -E 's#^[a-zA-Z]+://([^/:@]+).*#\1#')
  if [[ -n "$SUPA_HOST" && "$SUPA_HOST" != "localhost" && "$SUPA_HOST" != "127.0.0.1" ]]; then
    log "ERROR: SUPABASE_URL ใน .env ชี้ '$SUPA_HOST' (ไม่ใช่ localhost) — seed นี้สำหรับ dev stack เท่านั้น"
    exit 1
  fi
fi
if [[ -n "${DOCKER_HOST:-}" ]]; then
  log "ERROR: ตรวจพบ DOCKER_HOST (ชี้ ${DOCKER_HOST%%:*}…) — docker อาจคุมเครื่องอื่น · ปลด DOCKER_HOST ก่อนรัน seed dev"
  exit 1
fi

# ── 1) รหัสผ่าน ───────────────────────────────────────────────────────────────
# (ลำดับความสำคัญ: env UAT_DEMO_PASSWORD → ค่าใน .env ของเครื่องสาธิต (อ่านด้วย
#  grep ไม่ใช่ source — .env มีบรรทัดที่ shell parse ไม่ได้ เช่นค่าที่มี \n) → สุ่มใหม่)
if [[ -z "${UAT_DEMO_PASSWORD:-}" && -f .env ]]; then
  ENV_PW=$(grep -E '^UAT_DEMO_PASSWORD=.+' .env | head -1 | cut -d= -f2-)
  if [[ -n "$ENV_PW" ]]; then
    UAT_DEMO_PASSWORD="$ENV_PW"
    log "ใช้รหัสผ่านจาก .env (UAT_DEMO_PASSWORD) — ตั้ง env ทับได้ถ้าต้องการค่าอื่น"
  fi
fi
if [[ -n "${UAT_DEMO_PASSWORD:-}" ]]; then
  UAT_PASS="$UAT_DEMO_PASSWORD"
  log "ใช้รหัสผ่านจาก env UAT_DEMO_PASSWORD"
else
  # hex 24 ตัว (≥12 ตาม GOTRUE_PASSWORD_MIN_LENGTH) — ห้าม `tr | head` ใต้ pipefail
  # (tr ตายด้วย SIGPIPE 141 ก่อนสคริปต์ทำงานต่อ — gate p4-r1 M3) · ไม่มี openssl ใช้
  # dd อ่าน exact count แทน (ไม่มี pipeline ที่ถูกตัดกลางคัน)
  if command -v openssl >/dev/null 2>&1; then
    UAT_PASS="$(openssl rand -hex 12)"
  else
    UAT_PASS="$(dd if=/dev/urandom bs=12 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  fi
  log "สุ่มรหัสผ่านใหม่ 24 ตัวอักษร (แสดงท้ายสคริปต์เฉพาะบน terminal — จะไม่มีที่อื่น)"
fi

# ── 2) วิดีโอสาธิต: แคช → ดาวน์โหลด → อัปโหลดเข้า bucket 'media' ───────────────
mkdir -p "$(dirname "$VIDEO_CACHE")"
if [[ ! -s "$VIDEO_CACHE" ]]; then
  log "ดาวน์โหลดวิดีโอสาธิตครั้งแรก: $UAT_MEDIA_URL"
  # ใส่ UA เบราว์เซอร์ — โฮสต์ปฏิเสธ curl ปกติด้วย 403
  if ! curl -fsSL --max-time 60 \
      -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36" \
      -o "$VIDEO_CACHE" "$UAT_MEDIA_URL"; then
    log "WARN: ดาวน์โหลดไม่สำเร็จ (ไม่มีเน็ต?) — บทเรียนวิดีโอ [UAT] จะเปิดได้แต่เล่นไฟล์ไม่ได้"
    log "      แก้ได้ภายหลัง: วางไฟล์ mp4 ที่ $VIDEO_CACHE แล้วรันสคริปต์นี้ซ้ำ"
    VIDEO_CACHE=""
  fi
fi

VIDEO_EXISTS=$(docker compose exec -T db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -At' \
  <<< "select count(*) from storage.objects where bucket_id = 'media' and name = '$VIDEO_OBJ';" \
  2>/dev/null | tr -d '[:space:]')

if [[ "$VIDEO_EXISTS" == "1" ]]; then
  log "วิดีโอ $VIDEO_OBJ มีใน bucket แล้ว — ข้ามการอัปโหลด"
elif [[ -n "$VIDEO_CACHE" && -s "$VIDEO_CACHE" ]]; then
  # service key จาก .env — ส่งให้ curl ผ่านไฟล์ config ชั่วคราว (600) เท่านั้น ไม่แตะ
  # argv ของ curl (มองเห็นได้ใน ps ของ host — gate p4-r1 M1) · ลบไฟล์ทันที + trap EXIT
  SVC_KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2-)
  if [[ -z "$SVC_KEY" ]]; then
    log "WARN: ไม่พบ SUPABASE_SERVICE_ROLE_KEY ใน .env — ข้ามการอัปโหลดวิดีโอ (บทเรียนวิดีโอเล่นไม่ได้)"
  else
    TMP_HDR=$(mktemp /tmp/uat-seed-hdr.XXXXXX) && chmod 600 "$TMP_HDR"
    printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\nheader = "Content-Type: video/mp4"\n' \
      "$SVC_KEY" "$SVC_KEY" > "$TMP_HDR"
    HTTP=$(curl -s -o /tmp/uat-upload-body.json -w "%{http_code}" \
      -X POST "http://localhost:8000/storage/v1/object/media/$VIDEO_OBJ" \
      -K "$TMP_HDR" --data-binary "@$VIDEO_CACHE" || echo 000)
    rm -f "$TMP_HDR" && TMP_HDR=""
    if [[ "$HTTP" == "200" ]]; then
      log "อัปโหลดวิดีโอสาธิตสำเร็จ → media/$VIDEO_OBJ ($(stat -f%z "$VIDEO_CACHE") bytes)"
      # sync ขนาดจริงของไฟล์เข้า media_assets (seed ใส่ค่าประมาณไว้)
      docker compose exec -T db sh -c \
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -At' \
        <<< "update public.media_assets set size_bytes = $(stat -f%z "$VIDEO_CACHE") where storage_path = '$VIDEO_OBJ';" \
        >/dev/null || log "WARN: sync size_bytes ลง media_assets ไม่สำเร็จ (ไม่กระทบการเล่นไฟล์)"
    else
      log "WARN: อัปโหลดวิดีโอตอบ HTTP $HTTP — บทเรียนวิดีโอ [UAT] อาจเล่นไม่ได้"
      log "      body: $(head -c 200 /tmp/uat-upload-body.json 2>/dev/null)"
    fi
  fi
fi

# ── 3) apply seed-uat.sql — รหัสผ่านเดินทางผ่าน stdin เท่านั้น ────────────────
# (gate p4-r1 M1: `-e UAT_PASS=` / `-v uat_pass=` ติด argv ของ docker/psql — เปลี่ยนเป็น
#  รวม `\set` ที่ escape แล้วไว้หัว stream · psql อ่านจาก stdin `-f -` ตามเดิม)
psql_quote() { local s=$1; s=${s//\\/\\\\}; s=${s//\'/\\\'}; printf "'%s'" "$s"; }
log "apply $SEED_FILE (supabase_admin ใน container db · password ทาง stdin)"
SEED_RC=0
{ printf '\\set uat_pass %s\n' "$(psql_quote "$UAT_PASS")"; cat "$SEED_FILE"; } |
  docker compose exec -T db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f -' \
  || SEED_RC=$?
if [[ $SEED_RC -ne 0 ]]; then
  log "ERROR: seed ไม่สำเร็จ (rc=$SEED_RC) — ตรวจข้อความจาก psql ด้านบน"
  exit $SEED_RC
fi

# ── 4) พิมพ์บัญชี demo + รหัสผ่าน — เฉพาะ stdout เป็น terminal (gate p4-r1 M1) ──
# ถ้าถูก redirect / tee / เก็บ transcript จะไม่พิมพ์รหัสผ่านออกทาง stdout เด็ดขาด
printf "\n== UAT demo accounts (dev stack · http://localhost:3000) ==\n"
printf "  ผู้เรียนพลเมือง  uat.citizen@ltc.local\n"
printf "  ทนายความ        uat.lawyer@ltc.local        (ใบอนุญาต 4321987 verified)\n"
printf "  ผู้สอน           uat.instructor@ltc.local\n"
printf "  เจ้าหน้าที่ดูข้อมูล  uat.staff.viewer@ltc.local\n"
printf "  เจ้าหน้าที่เนื้อหา  uat.staff.content@ltc.local\n"
printf "  เจ้าหน้าที่สอบ    uat.staff.exam@ltc.local\n"
printf "  เจ้าหน้าที่ทะเบียน  uat.staff.registrar@ltc.local\n"
printf "  ผู้ดูแลสูงสุด     uat.admin@ltc.local\n"
if [[ -t 1 ]]; then
  printf "  รหัสผ่าน (ทุกบัญชี): %s\n" "$UAT_PASS"
  printf "  (ไม่เก็บใน repo — ถ้าต้องใช้ซ้ำ บันทึกที่ .env ในรูปแบบ UAT_DEMO_PASSWORD=<รหัส>)\n"
else
  printf "  รหัสผ่าน: ไม่พิมพ์เพราะ stdout ไม่ใช่ terminal (กันติด log/redirect)\n"
  printf "  ต้องการดูรหัส: รันบนเทอร์มินัลจริง หรือตั้ง UAT_DEMO_PASSWORD เองแล้วรันใหม่\n"
fi
printf "  เจ้าหน้าที่/ผู้สอน/ผู้ดูแล: ล็อกอินครั้งแรก -> ลงทะเบียน MFA ที่ /my/security/enroll ก่อนใช้งาน\n"
