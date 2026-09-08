# ดัชนีเอกสาร + Deliverable Checklist (21 รายการ)

> Deliverables 1–12 ต้องเสร็จและผ่าน CTO gate ก่อนเริ่มเขียนโค้ด (Wave B+)
> ทุกเอกสารต้องสอดคล้องกับ `00-baseline/PROJECT-BRIEF.md` (source of truth)

| #  | Deliverable            | ไฟล์/ตำแหน่ง                          | Owner    | Wave | สถานะ |
| -- | ---------------------- | ------------------------------------- | -------- | ---- | ----- |
| 1  | Project Plan           | `01-management/PROJECT-PLAN.md`       | worker-1 | A    | ⏳    |
| 2  | Risk Register          | `01-management/RISK-REGISTER.md`      | worker-1 | A    | ⏳    |
| 3  | SRS                    | `02-requirements/SRS.md`              | worker-2 | A    | ⏳    |
| 4  | RTM                    | `02-requirements/RTM.md`              | worker-2 | A    | ⏳    |
| 5  | SDS                    | `03-design/SDS.md`                    | worker-3 | A    | ⏳    |
| 6  | Architecture Diagram   | `03-design/ARCHITECTURE.md`           | worker-3 | A    | ⏳    |
| 7  | Data Dictionary        | `03-design/DATA-DICTIONARY.md`        | worker-3 | A    | ⏳    |
| 8  | API Specification      | `04-api-security/API-SPECIFICATION.md`| worker-4 | A    | 🔄    |
| 9  | RBAC Design            | `04-api-security/RBAC-DESIGN.md`      | worker-4 | A    | 🔄    |
| 10 | Audit Log Design       | `04-api-security/AUDIT-LOG-DESIGN.md` | worker-4 | A    | 🔄    |
| 11 | UI Prototype           | `05-ui/DESIGN-SYSTEM.md` + `05-ui/prototype/*.html` | worker-5 | A | ⏳ |
| 12 | Test Plan              | `06-testing/TEST-PLAN.md`             | worker-1 | A    | ⏳    |
| 13 | Developed System       | `apps/*`                              | team     | B–E  | —    |
| 14 | Source Code            | repo ทั้งหมด                          | team     | B–E  | —    |
| 15 | Database Script        | `supabase/migrations/*`               | team     | B–E  | —    |
| 16 | Deployment Package     | `infra/` + CI + คู่มือ deploy          | team     | F    | —    |
| 17 | System Test Result     | `docs/07-results/SYSTEM-TEST.md`      | team     | F    | —    |
| 18 | UAT Result             | `docs/07-results/UAT.md`              | team     | F    | —    |
| 19 | VA/Pentest Report      | `docs/07-results/VA-PENTEST.md`       | team     | F    | —    |
| 20 | Security Remediation   | `docs/07-results/SECURITY-REMEDIATION.md` | team  | F    | —    |
| 21 | User Manual            | `docs/08-manuals/USER-MANUAL.md`      | team     | F    | —    |

สถานะ: ⏳ รอ · 🔄 กำลังทำ · ✅ ผ่าน CTO gate · ❌ ตีกลับแก้ไข
