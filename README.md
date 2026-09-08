# LTC E-Learning — ระบบ E-Learning สภาทนายความแห่งประเทศไทย

E-Learning platform for the **Lawyers Council of Thailand (สภาทนายความแห่งประเทศไทย)** —
การเรียนรู้ออนไลน์ระดับมาตรฐานสากล (Coursera / university-LMS grade) สำหรับ:

- 🎓 ประชาชนทั่วไป — หลักสูตรเพิ่มความรู้กฎหมาย
- ⚖️ ทนายความ — การอบรมเพิ่มพูนความรู้ + สอบรับประกาศนียบัตรเพื่อต่อใบอนุญาตว่าความ
- 🏦 Credit Bank — ติดตาม/สะสมคุณวุฒิตามรอบต่ออายุใบอนุญาต
- 🛠️ เจ้าหน้าที่ — ระบบบริหารจัดการหลักสูตร การสอบ ผู้ใช้ และรายงาน

## Stack (ตัดสินแล้ว ดู `docs/00-baseline/PROJECT-BRIEF.md`)

| Layer     | เทคโนโลยี                                                |
| --------- | ------------------------------------------------------- |
| Frontend  | Next.js 15 (App Router) + TypeScript strict + Tailwind |
| API/BFF   | Next.js Route Handlers + Server Actions + zod           |
| Data/Auth | Supabase (PostgreSQL + Auth + Storage + RLS ทุกตาราง)   |
| Dev       | 100% local Docker (Supabase local stack)                |
| Prod      | 100% cloud — Vercel + Supabase Cloud + Cloudflare       |

## โครงสร้างเอกสาร (doc-first)

```
docs/
├── 00-baseline/      # ขอบเขต + คำศัพท์ (source of truth)
├── 01-management/    # Project Plan, Risk Register
├── 02-requirements/  # SRS, RTM
├── 03-design/        # SDS, Architecture, Data Dictionary
├── 04-api-security/  # API Spec, RBAC, Audit Log Design
├── 05-ui/            # Design System + UI Prototype
└── 06-testing/       # Test Plan
```

สถานะโครงการและ wave board: `PROJECT-STATE.md`

## กฎการทำงาน

- Doc-first: เอกสารคือ source of truth — โค้ดขัดกับเอกสาร → ยื่น DCR ก่อนแก้
- TypeScript strict, ข้อความผู้ใช้ Thai-first, Conventional Commits
- ห้าม commit secrets, ห้าม log ข้อมูลส่วนบุคคลทุก environment
- No fake completion — ทุก completion ต้องมี evidence
