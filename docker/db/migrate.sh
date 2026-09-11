#!/bin/sh
# db-migrate — one-shot service ของ dev stack (docker-compose.yml)
# หน้าที่ 1: ตั้งรหัสผ่าน service roles ของ Supabase local (image supabase/postgres สร้าง role มาแบบไม่มีรหัสผ่าน)
# หน้าที่ 2: apply SQL migrations จาก supabase/migrations/*.sql เรียงตามชื่อไฟล์ (transaction ต่อไฟล์)
# idempotent ทั้งหมด — รันซ้ำได้ทุกครั้งที่ `make up` / `make migrate`
# note: ตาราง track (_dev.migrations) เป็นกลไก dev เท่านั้น ไม่เกี่ยวกับตารางของ supabase CLI
set -eu

# psql อ่านค่าจาก environment — ต้อง export (ค่า default ชี้ service db ใน compose network)
export PGHOST="${PGHOST:-db}"
export PGPORT="${PGPORT:-5432}"
# supabase_admin = superuser ของ image supabase/postgres (จำเป็น: postgres role ไม่ใช่ superuser
# และ supautils บล็อกการ ALTER reserved roles เช่น supabase_auth_admin จาก non-superuser)
export PGUSER="${PGUSER:-supabase_admin}"
export PGDATABASE="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}}"

echo "[db-migrate] target: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

# --- 1) รหัสผ่าน service roles (เทียบเท่า volumes/db/pooler.sql ของ supabase/docker) ---
# note: psql -c ไม่ทำ variable substitution — escape single-quote เป็น SQL literal เอง
# role ใดยังไม่มี (image เปลี่ยน) ให้เตือนแล้วข้าม — ไม่ block การ apply migrations
sql_quote() { printf "%s" "$1" | sed "s/'/''/g"; }
pwd_lit=$(sql_quote "$PGPASSWORD")
for role in supabase_auth_admin authenticator supabase_storage_admin supabase_functions_admin; do
  if psql -v ON_ERROR_STOP=1 -q -c "ALTER ROLE ${role} WITH LOGIN PASSWORD '${pwd_lit}';"; then
    echo "[db-migrate] role password set: ${role}"
  else
    echo "[db-migrate] WARN: role not found, skip: ${role}"
  fi
done

# --- 2) ตาราง track การ apply ---
psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS _dev;
CREATE TABLE IF NOT EXISTS _dev.migrations (
  file text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

# --- 3) ยังไม่มี migration → จบปกติ (worker-b2 อาจยังไม่ส่งมอบ) ---
if ! ls /migrations/*.sql >/dev/null 2>&1; then
  echo "[db-migrate] no /migrations/*.sql found - skip"
  exit 0
fi

rc=0
for f in /migrations/*.sql; do
  base="$(basename "$f")"
  already=$(psql -Atq -c "SELECT 1 FROM _dev.migrations WHERE file = '$(sql_quote "$base")';")
  if [ "$already" = "1" ]; then
    echo "[db-migrate] skip (applied): $base"
    continue
  fi
  echo "[db-migrate] applying: $base"
  if psql -1 -v ON_ERROR_STOP=1 -f "$f" -c "INSERT INTO _dev.migrations(file) VALUES ('$(sql_quote "$base")');"; then
    :
  else
    echo "[db-migrate] FAILED: $base"
    rc=1
    break
  fi
done

# --- 4) dev seed (supabase/seed.sql — idempotent: fixed UUIDs + on conflict do nothing) ---
# เดิมเป็น manual step ตาม header ของ seed.sql — fresh volume (down -v) จึงลืม seed ได้
# (เจอจริงจาก replay รอบ gate r1: integration ที่อ้าง seed ตายทั้งชุด) · ผูกกับ boot เลย
# note: ไม่ track ใน _dev.migrations — seed คง idempotent ของตัวเอง รันทุกครั้งที่ up
# note: ไม่ใส่ -1 (single-transaction ของ psql) — ไฟล์เปิด begin; ... commit; เอง สองชั้น
#       จะเกิด WARNING "no transaction in progress" ตอน commit ครั้งที่สอง
if [ -f /seed.sql ]; then
  echo "[db-migrate] seeding: /seed.sql"
  psql -v ON_ERROR_STOP=1 -f /seed.sql
else
  echo "[db-migrate] WARN: /seed.sql not mounted - skip seed"
fi

echo "[db-migrate] done rc=$rc"
exit "$rc"
