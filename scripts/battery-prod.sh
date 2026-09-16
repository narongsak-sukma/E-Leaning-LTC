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
exec node scripts/battery-run.mjs "$@"
