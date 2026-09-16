# LTC E-Learning — คำสั่ง dev ผ่าน Docker ทั้งหมด (brief §6: dev = 100% local Docker)
# เริ่มใช้: cp .env.example .env แล้ว make dev
SHELL := /bin/sh
COMPOSE := docker compose

.PHONY: dev up down logs ps lint test psql migrate reset-db dump-logs

dev: up
	$(COMPOSE) logs -f app

up:
	@test -f .env || { echo "ยังไม่มี .env — รัน: cp .env.example .env แล้วลองใหม่"; exit 1; }
	$(COMPOSE) up -d --build
	$(COMPOSE) ps

# D90 (verdict r21/r22): dump logs ก่อนทำลาย container ทุกครั้ง — ล้ม = ห้าม down/reset (fail-closed)
dump-logs:
	sh scripts/dump-app-logs.sh

down:
	sh scripts/dump-app-logs.sh
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

lint:
	$(COMPOSE) exec -T app npm run lint

test:
	$(COMPOSE) exec -T app npm run test

psql:
	$(COMPOSE) exec db psql -U postgres -d postgres

# apply migration ที่ยังไม่ได้ apply (รันได้ตลอด — idempotent)
migrate:
	$(COMPOSE) run --rm db-migrate

# ล้างฐานข้อมูล dev ทั้งหมด (ลบ volume) แล้ว up ใหม่ — migrations จะถูก apply ใหม่ตั้งแต่ต้น
# บรรทัดแรก = dump logs ก่อน down -v เสมอ (D90 เกณฑ์ข้อ 3 — หลักฐานก่อนการทำลาย)
reset-db:
	sh scripts/dump-app-logs.sh
	$(COMPOSE) down -v
	$(MAKE) up
