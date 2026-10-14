#!/bin/sh
# Wave I เฟส 3 [#94] — battery เต็มบน production runtime (DCR-PROD-BUILD-E2E.md ข้อ 2)
# ตั้ง env สามตัวแล้วส่งต่อให้ scripts/battery-run.mjs ทุก argument:
#   E2E_BASE_URL=http://localhost:3001  — health gate + e2e มอง app-prod
#   HEAP_CONTAINER=ltc-prod-app         — heap-start/end ผูก identity กับ container ที่ e2e วัด
#   E2E_REQUIRE_PROD=1                  — stage health ต้องผ่าน scripts/prod-build-proof.mjs ก่อน e2e
# ต้อง `make up-prod` ให้ ltc-prod-app healthy ก่อน (build ใน container ใช้เวลาตอนแรก)
# ตัวแปรสามตัว override ได้จากภายนอก (เช่น CI ชี้ origin อื่น)
set -eu

export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:3001}"
export HEAP_CONTAINER="${HEAP_CONTAINER:-ltc-prod-app}"
export E2E_REQUIRE_PROD="${E2E_REQUIRE_PROD:-1}"

echo "battery-prod: E2E_BASE_URL=${E2E_BASE_URL} HEAP_CONTAINER=${HEAP_CONTAINER} E2E_REQUIRE_PROD=${E2E_REQUIRE_PROD}"
# (PM-2 binding · battery-rate-override amendment) เสียงสะท้อนค่า rate-limit ที่ instance
# ทำงานอยู่จริงตอนเริ่ม battery — re-up โดยไม่ส่ง PROD_RATE_LIMIT_* จะเห็นทันทีว่ากลับ
# เป็น default (10/5) = คลาสแดงกลับมา ไม่เงียบ
EFF_AUTH=$(docker exec ltc-prod-app printenv RATE_LIMIT_AUTH_PER_MIN 2>/dev/null || echo "?")
EFF_PWD=$(docker exec ltc-prod-app printenv RATE_LIMIT_PWD_RESET_PER_HOUR 2>/dev/null || echo "?")
echo "battery-prod: effective RATE_LIMIT_AUTH_PER_MIN=${EFF_AUTH} RATE_LIMIT_PWD_RESET_PER_HOUR=${EFF_PWD} (battery expects 60/60 — default 10/5 = self-saturation class returns)"
exec node scripts/battery-run.mjs "$@"
