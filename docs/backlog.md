# E-Learning LTC — Backlog

Owned by the **PM** (`pm` agent). Status: `todo` → `in-progress` → `in-qa` → `in-e2e` → `done` | `blocked`.
Authoritative history: `PROJECT-STATE.md` (the second brain) — keep rows here as the working queue only.

| ID | Title | Priority | Status | Owner | Notes |
|----|-------|----------|--------|-------|-------|
| BL-000 | Wave I Phase 3 [#94]: e2e-04 403 investigation — DONE as investigation; original 403 closed as **non-reproducible** (five-direction probe + pre-fix e2e-04 3/3 on :3001, D-f-11 refuted on current env, D-f-12 unconfirmed hypothesis); **hardening delivered as defense-in-depth** per DCR-CSRF-ORIGIN-RESILIENCE (GO 2026-10-13: PM consent + QA round-2 consent) — remaining: TDD ladder + gates + battery r38 | P0 | in-progress | dev-backend + cto gate | PM closure language per consent (ก). Gherkin AC = DCR §5 ladder. r38 = proof-of-health only; D90 restarts post next@16.3.5 |
| BL-001 | Laptop toolchain: git ✅ 2.55 · node ✅ 24 LTS · Docker ✅ Desktop 4.95 / engine 29.8.2 running | P0 | done | devops | git/node installed via winget (stale PATH until restart — call by full path); Docker Desktop was already installed per-user (`...\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`) |
| BL-002 | Verify local dev stack boots: `make up` + health 200 (then probe task BL-000 can run) | P0 | done | devops (via command channel) | Verified 2026-10-13: dev :3000 health 200 + app-prod :3001 health 200 · env repairs: CRLF renormalize, CRON_SECRET set, supabase role passwords reset |
| BL-003 | Cloudflare security layer design (WAF, Turnstile, Access) for prod | P1 | todo | cto | ADR in docs/adr/ — which protections run where · ขยายใน Wave J เฟส J-P1 (T-6) รวมคำวินิจฉัย COOP/COEP/CORP |

### Wave J — Deploy & Go-Live (DRAFT — รอ CTO review · แผนเต็มที่ `docs/09-dev/WAVE-J-PLAN-DRAFT.md` · ห้ามเริ่ม J-P1+ ก่อน CTO อนุมัติแผน)

| ID | Title | Priority | Status | Owner | Notes |
|----|-------|----------|--------|-------|-------|
| BL-004 | Wave I P3 [#94]: สะสม D90 ใหม่ให้ครบ 3/3 บน production runtime (battery PASS 3 รอบติด + identity ก่อน–หลัง + timestamped logs ครบหน้าต่าง) → closing gate Wave I → ปิด wave ใน PROJECT-STATE | P0 | todo | cto | ต่อจาก BL-000 (probe/fix + r38) · PM เสนอเริ่มนับใหม่หลังอัป next (คำถาม CTO ข้อ 2 ในแผน) |
| BL-005 | ปิด npm-audit ก่อนอายุ: อัปเกรด `next@16.3.5` (postcss high ผ่าน build chain) + battery เต็มหลังอัป | P0 | todo | cto + dev-backend | **หมดอายุ 2026-10-15** (PROD-CHECKLIST §10 · D29 accept-with-expiry) — เหลือ 2 วัน |
| BL-006 | `vercel.json` + cron schedule 2 jobs (`email-dispatch` · `pdpa-export`) + สคริปต์พิสูจน์ CRON_SECRET (404 เงียบ ↔ 200) — code-ready ไม่ deploy | P1 | todo | dev-backend | repo ยังไม่มี vercel.json (PROD-CHECKLIST §4) · ทำวันนี้ได้ (T-4) |
| BL-007 | สคริปต์ replay-migrations 46 ไฟล์ + probe ตรวจผล (ledger 46 · buckets 4 · PGRST `select=id.count()` 200) + runbook backup/restore drill — เขียน+ทดสอบบน local docker | P1 | todo | devops | ทำวันนี้ได้ (T-5) · ใช้จริงใน J-P2 (BL-009) |
| BL-008 | สคริปต์ k6 PERF-001..008 + runbook การวัด (USA-002/ACC/OPE-001/MAINT-002) | P2 | todo | dev-backend | ทำวันนี้ได้ (T-7) · วัดจริงใน J-P5 (BL-011) |
| BL-009 | Supabase Cloud bootstrap จริง: สร้างโปรเจกต์ (ค่า platform-issued เท่านั้น) · migrations · buckets 4 ใบ · Auth settings (ปิด autoconfirm · ≥12 · Site URL จริง) · PITR | P1 | blocked | devops + cto gate | **External blocker E-2: บัญชี Supabase Cloud ของ สภาฯ** · AC-WJ-2 ในแผน |
| BL-010 | Vercel staging deploy + smoke 7 เส้นทาง (สมัครอีเมลจริง/เรียน/สอบ/ใบประกาศ/verify/วิดีโอ/PDPA) + env fail-fast ครบ | P1 | blocked | dev-backend + devops | **E-1: บัญชี Vercel + token** · ต้อง BL-009 ก่อน · AC-WJ-1 |
| BL-011 | การวัดบน staging: PERF-001..008 ด้วย k6 · USA-002 · ACC-001..004 · OPE-001 · MAINT-002 parity + SEC-005 ยกระดับ rate limit (Cloudflare คุมหลัก / Upstash fast-follow ตามคำตัดสิน CTO) | P1 | blocked | dev-backend + tester | ต้อง BL-010 · ปิดหนี้ SYSTEM-TEST §5.2 · AC ตาม SDS เกณฑ์ p95 ≤ 500ms |
| BL-012 | Go-live gate: external pentest (ToR VA-PENTEST §5 · 0 High/Critical) · UAT sign-off มนุษย์ 8 persona · restore drill จริง 1 ครั้ง · ตารางลงนาม PROD-CHECKLIST §11 ครบ → ปิด Wave J | P0 | blocked | pm (ประสาน) + cto (gate) | **E-6: มนุษย์ สภาทนายความฯ** (งบ pentest + ผู้ลงนาม + วันเปิดจริง) · AC-WJ-6 |
| BL-013 | Cloudflare จริง: zone + DNS cutover + WAF 10 กลุ่มตาม rate-limit.ts:44-53 + คำวินิจฉัย COOP/COEP/CORP จดใน PROD-CHECKLIST §5 + Bot โหมดอนุรักษ์ | P1 | blocked | devops + cto | **E-3: คุม DNS โดเมนจริง** · ต่อจาก ADR BL-003 · AC-WJ-4 |

*(PM: refine into Gherkin criteria; merge with the wave process in PROJECT-STATE.md. · แถว BL-004–BL-013 เป็น **DRAFT — รอ CTO review** ตาม design-first gate · อัปเดตล่าสุด 2026-10-13)*
