# คู่มือการติดตั้งและ Deploy: Frontend on Vercel + Backend on Supabase

โครงสร้างสถาปัตยกรรมของโครงการ **LTC E-Learning (สภาทนายความ ในพระบรมราชูปถัมภ์)**:
- **Frontend**: โฮสต์บน **Vercel** (Vite + React 19 + TypeScript + Tailwind CSS)
- **Backend & Database**: รันบน **Supabase Cloud** (PostgreSQL 15 + Auth + Storage + RLS ทุกตาราง)

---

## ขั้นตอนที่ 1: ตั้งค่า Supabase (Backend & Database)

1. เข้าสู่ระบบที่ [https://supabase.com](https://supabase.com) แล้วกด **New Project**
2. ตั้งชื่อโครงการ เช่น `ltc-elearning` และกำหนด Database Password
3. เลือก Region ใกล้ประเทศไทย เช่น **Singapore (ap-southeast-1)**
4. เมื่อโปรเจกต์สร้างเสร็จแล้ว ไปที่เมนู **SQL Editor** ทางแถบซ้ายมือ
5. เปิดไฟล์ `supabase/migrations/20261017000001_initial_schema.sql` ใน repo นี้ คัดลอกโค้ดทั้งหมดแล้วนำไปวางใน SQL Editor แล้วกด **RUN**
   - คำสั่งนี้จะสร้างตาราง `profiles`, `user_roles`, `courses`, `enrollments`, `question_bank`, `certificates`, `credit_ledger`, `audit_logs`
   - เปิดใช้งาน **Row Level Security (RLS)** ทุกตาราง และสร้าง Trigger ป้องกันการแก้ไข/ลบ Audit Log (ASVS L2 / PDPA)
6. (ทางเลือก) คัดลอกโค้ดจาก `supabase/seed.sql` ไปรันใน SQL Editor เพื่อใส่ข้อมูลหลักสูตรเริ่มต้นและวุฒิบัตรตัวอย่าง
7. ไปที่เมนู **Project Settings** -> **API** คัดลอกค่า 2 ค่า:
   - **Project URL** (เช่น `https://xyzcompany.supabase.co`)
   - **anon public key** (เช่น `eyJhbGciOi...`)

---

## ขั้นตอนที่ 2: ตั้งค่า Vercel (Frontend Hosting)

1. Push โค้ดทั้งหมดขึ้น GitHub ไปยัง repository ของท่าน:
   ```bash
   git add .
   git commit -m "feat: setup Vercel & Supabase integration"
   git push origin main
   ```
2. เข้าสู่ระบบที่ [https://vercel.com](https://vercel.com) แล้วกด **Add New...** -> **Project**
3. เลือก Repository `narongsak-sukma/E-Leaning-LTC`
4. ในส่วน **Build and Output Settings**:
   - Framework Preset: **Vite**
   - Build Command: `npm run build`
   - Output Directory: `dist`
5. ในส่วน **Environment Variables** ให้เพิ่ม 2 ค่าที่ได้จาก Supabase:
   - `VITE_SUPABASE_URL` = ค่า Project URL จากขั้นตอนที่ 1
   - `VITE_SUPABASE_ANON_KEY` = ค่า anon public key จากขั้นตอนที่ 1
6. กดปุ่ม **Deploy**
   - Vercel จะ build และ deploy แอปพลิเคชันอัตโนมัติภายใน 1-2 นาที
   - ไฟล์ `vercel.json` ในโปรเจกต์ได้ตั้งค่า SPA rewrites (`/(.*) -> /index.html`) และ Security Headers ไว้พร้อมแล้ว

---

## สรุปสถานะการทำงานในสภาพแวดล้อมต่างๆ (Environment Parity)

| สภาพแวดล้อม | Frontend | Backend / Database | พฤติกรรมการทำงาน |
| :--- | :--- | :--- | :--- |
| **Local Dev (AI Studio)** | Vite Dev Server (พอร์ต 3000) | In-Memory Simulation + LocalStorage | ใช้งานได้ทันที มีข้อมูลจำลองครบทุกบทบาท |
| **Production (Vercel)** | Vercel Edge / CDN Global | Supabase Cloud (PostgreSQL + RLS) | ทำงานร่วมกับฐานข้อมูลจริง อัปเดตข้อมูลอัตโนมัติ |
