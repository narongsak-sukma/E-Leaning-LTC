# ARCHITECTURE — แบบจำลองสถาปัตยกรรม (C4 + Deployment + Data Flow)

|          |                                                   |
| -------- | ------------------------------------------------- |
| เวอร์ชัน | 1.0.0 — ผ่าน CTO gate (codex รอบ 5: PASS — D17) · แก้ตาม D8–D16 · baseline สำหรับ Wave B |
| วันที่    | 2026-09-09                                        |
| เจ้าของ  | worker-3 (Wave A — deliverable 6)                 |
| สถานะ    | ผ่าน CTO gate (codex รอบ 5: PASS — D17)           |
| อ้างอิงบังคับ | PROJECT-BRIEF.md §6 (stack ตัดสินแล้ว), §8     |
| เอกสารเชื่อมโยง | SDS.md (การออกแบบเชิงลึก), DATA-DICTIONARY.md |

> หลักการกลาง (บังคับ): **โค้ดชุดเดียว รันได้ทั้ง local Docker (dev) และ cloud (prod) ต่างกันเฉพาะ env vars** — ทุกแผนภาพด้านล่างต้องอ่านได้ทั้งสอง environment โดยสลับเพียงปลายทางของการเชื่อมต่อ

## 1. System Context (C4-L1)

```mermaid
flowchart TB
    Citizen["ประชาชน (Citizen)<br/>สมัครด้วย email/มือถือ เรียนหลักสูตรสาธารณะ"]
    Lawyer["ทนายความ (Lawyer)<br/>เรียน + สอบ + สะสม credit ต่อใบอนุญาต"]
    Instructor["วิทยากร (Instructor)<br/>สร้างเนื้อหา + ธนาคารข้อสอบ"]
    Staff["เจ้าหน้าที่ (Staff 4 ระดับ)<br/>viewer / content / exam / registrar"]
    Public["ผู้ตรวจสอบประกาศนียบัตร<br/>ไม่ระบุตัวตน ผ่าน QR"]
    SYS[["ระบบ LTC E-Learning<br/>(Next.js + Supabase)"]]
    MAIL[["ระบบอีเมลภายนอก<br/>dev: Mailpit / prod: Resend หรือ SMTP"]]
    Citizen --> SYS
    Lawyer --> SYS
    Instructor --> SYS
    Staff --> SYS
    Public -->|"GET /verify/{code}"| SYS
    SYS -->|"ส่งอีเมลแจ้งเตือน/ยืนยันตัวตน"| MAIL
```

ภาพระดับบนสุด: ผู้ใช้ 4 personas ตาม brief §3 บวก "ผู้ตรวจสอบประกาศนียบัตร" ที่ไม่ต้อง login ระบบมีระบบภายนอกเดียวคืออีเมล (นำเข้า payment/live class ทีหลังตามขอบเขต v1)

## 2. Container (C4-L2)

```mermaid
flowchart TB
    Browser["เบราว์เซอร์ผู้ใช้<br/>UI: RSC HTML + วิดีโอ player"]

    subgraph EDGE["ปลายทางสาธารณะ"]
        CF["Cloudflare<br/>DNS + WAF + Rate Limit + CDN<br/>(prod เท่านั้น — dev: Next.js โดยตรง)"]
    end

    subgraph APP["แอปพลิเคชัน (โค้ดชุดเดียว)"]
        NEXT["Next.js 15 App Router<br/>RSC + Route Handlers /api/v1 + Server Actions<br/>= BFF ทั้งหมดของระบบ"]
    end

    subgraph SUPA["Supabase (dev: local Docker / prod: Cloud)"]
        AUTH["Supabase Auth<br/>JWT + MFA"]
        PG["PostgreSQL 15<br/>RLS ทุกตาราง + pooler"]
        STG["Storage API<br/>(dev: local bucket)"]
    end

    MEDIA["Media abstraction<br/>dev: Supabase Storage<br/>prod: Cloudflare R2 / Stream"]
    MAIL["อีเมล: dev = Mailpit/console<br/>prod = Resend/SMTP"]

    Browser --> CF
    CF --> NEXT
    Browser -->|"dev: เข้า Next.js ตรง"| NEXT
    NEXT -->|"user JWT (authenticated / anon) — เส้นทางหลัก"| PG
    NEXT -.->|"service_role: jobs เฉพาะกิจ + SECURITY DEFINER functions — เส้นรอง (ขอบเขตแคบ)"| PG
    NEXT --> AUTH
    NEXT -->|"ออก signed URL"| MEDIA
    NEXT --> MAIL
    Browser -->|"สตรีมสื่อผ่าน signed URL อายุสั้น"| MEDIA
```

บริการที่ "เป็นแอป" มีตัวเดียวคือ Next.js (ทำหน้าที่ BFF) — browser ไม่คุยกับ Postgres โดยตรง สื่อและอีเมลอยู่หลัง abstraction ที่สลับด้วย `MEDIA_PROVIDER`/`EMAIL_PROVIDER` ตามหลัก single codebase

## 3. Component (C4-L3) — ภายใน Next.js App

```mermaid
flowchart TB
    subgraph NEXT["Next.js App (BFF)"]
        subgraph MODS["Domain Modules (ตาม brief §5)"]
            M1["M1 Identity & License"]
            M2["M2 Catalog & Enrollment"]
            M3["M3 Learning & Progress"]
            M4["M4 Assessment & Certification"]
            M5["M5 Credit Bank"]
            M6["M6 Notification"]
            M7["M7 Admin & Reporting"]
            M8["M8 Audit"]
        end
        subgraph SHARED["Shared Kernel"]
            GUARD["auth guard<br/>session httpOnly"]
            RBAC["rbac<br/>my_roles() / has_any_role() / is_staff()"]
            CFG["config<br/>env + DB-config + Q1-Q6"]
            STAB["storage abstraction"]
            AUD["audit service"]
            NOTI["notification service"]
            LOG["logger + PII filter"]
        end
    end
    M1 --> GUARD
    M1 --> RBAC
    M2 --> GUARD
    M3 --> STAB
    M3 --> LOG
    M4 --> RBAC
    M4 --> AUD
    M4 --> STAB
    M5 --> AUD
    M6 --> NOTI
    M7 --> RBAC
    M8 --> AUD
    MODS --> CFG
```

module ทั้ง 8 ไม่เรียกกันเองโดยตรง แต่แลกเปลี่ยนผ่าน event ภายใน (เช่น `assessment_attempt.passed` จาก M4 ไป M5 เพื่อ credit accrual — F15/D12; `certificate.issued` เป็นเหตุการณ์แจ้งเตือนเท่านั้น) และใช้ shared kernel ร่วมกัน — รายละเอียดความรับผิดชอบ/interface/dependency ของแต่ละ module อยู่ใน SDS.md §2

## 4. Deployment — DEV (100% local Docker)

```mermaid
flowchart TB
    Dev["เครื่องนักพัฒนา (browser :3000)"]
    subgraph DC["docker-compose (local)"]
        APPC["next-app :3000<br/>Next.js dev server"]
        subgraph SUPA["Supabase local stack"]
            KONG["Kong gateway :8000"]
            AUTHL["Auth (GoTrue)"]
            REST["PostgREST"]
            STLJ["Storage API"]
            DBL["PostgreSQL :5432<br/>migrations + RLS เหมือน prod ทุกประการ"]
        end
        MAILP["Mailpit :8025 / 1025<br/>จับอีเมลทดสอบ"]
        CRONL["scheduler<br/>auto-submit + email worker (cron path เดียวกับ prod)"]
    end
    Dev --> APPC
    APPC -->|"SUPABASE_URL=localhost:8000"| KONG
    KONG --> AUTHL
    KONG --> REST
    KONG --> STLJ
    AUTHL --> DBL
    REST --> DBL
    STLJ --> DBL
    APPC -->|"EMAIL_PROVIDER = console หรือ smtp"| MAILP
    CRONL -->|"เรียก route เดียวกับ Vercel Cron"| APPC
```

dev รัน Supabase ชุดเต็มใน Docker ผ่าน Kong gateway — URL/คีย์ทั้งหมดชี้ localhost ผ่าน env vars โดยไม่แก้โค้ด scheduler ใน dev เป็น container ที่เรียก endpoint เดียวกับที่ prod ใช้ Vercel Cron เพื่อ parity ของพฤติกรรมเวลา

## 5. Deployment — PROD (100% cloud services)

```mermaid
flowchart TB
    B["ผู้ใช้ (browser)"]
    subgraph CFJ["Cloudflare"]
        DNS["DNS + WAF + Rate Limit"]
        CDN["CDN (สื่อ + หน้าสาธารณะ)"]
        R2["R2 / Stream<br/>ไฟล์วิดีโอ-เอกสาร-PDF"]
    end
    subgraph VC["Vercel"]
        NX["Next.js 15<br/>(region: รอยืนยัน Q5 — default SG)"]
        CRONP["Vercel Cron<br/>auto-submit + email worker"]
    end
    subgraph SBC["Supabase Cloud (region SG/JP — รอยืนยัน Q5)"]
        AUTHC["Auth"]
        PGC["PostgreSQL + pooler + RLS"]
    end
    RESEND["Resend / SMTP"]
    B --> DNS
    DNS --> NX
    B -->|"สตรีมผ่าน signed URL"| CDN
    CDN --> R2
    NX -->|"user JWT (authenticated / anon) — เส้นทางหลัก"| PGC
    NX -.->|"service_role: jobs เฉพาะกิจ + SECURITY DEFINER functions — เส้นรอง"| PGC
    NX --> AUTHC
    NX --> RESEND
    CRONP --> NX
```

prod วางเหมือน dev ทุกโครง ต่างเฉพาะปลายทาง: แอปบน Vercel, ข้อมูลบน Supabase Cloud, สื่อ/CDN/WAF บน Cloudflare — region ของ Vercel และ Supabase เลือกให้ใกล้กันและใกล้ไทย (Q5 PDPA cross-border, รอยืนยัน)

### 5.5 Deployment — STAGING (cloud preview ก่อนขึ้น prod — brief §6, DCR-1)

```mermaid
flowchart TB
    T["ทีม/ผู้ทดสอบ (browser)<br/>ทีม dev + UAT เจ้าหน้าที่สภาฯ"]
    subgraph CFS["Cloudflare (โดเมน staging)"]
        WAFS["WAF + Rate Limit"]
    end
    subgraph VCS["Vercel (staging/preview deployment)"]
        NXS["Next.js 15 (โค้ดชุดเดียวกับ prod)"]
        CRONS["Vercel Cron"]
    end
    subgraph SBS["Supabase Cloud (staging branch)"]
        PGSI["PostgreSQL + pooler + RLS<br/>migrations เดียวกับ prod"]
        STGS["Storage (bucket staging)"]
    end
    R2S["Cloudflare R2/Stream (bucket/โดเมน staging)"]
    EMAILS["Resend/SMTP (ผู้รับจำกัด — อีเมลทดสอบ)"]
    T --> WAFS --> NXS
    NXS -->|"user JWT (authenticated / anon) — เส้นทางหลัก (env vars ชุด staging)"| PGSI
    NXS -.->|"service_role: jobs เฉพาะกิจ + SECURITY DEFINER functions — เส้นรอง"| PGSI
    NXS --> STGS
    NXS -->|"signed URL อายุสั้น"| R2S
    NXS --> EMAILS
    CRONS --> NXS
```

- **วัตถุประสงค์ (brief §6 เพิ่มเมื่อ 0.2.0 ตาม DCR-1)**: environment ระดับกลางที่แยกจาก dev และ prod ไว้พิสูจน์ว่าระบบรับโหลดและปลอดภัยจริง **ก่อน promote ขึ้น prod**
- **โครงเหมือน prod ทุกประการ โค้ดชุดเดียวกัน**: ใช้ config/โค้ดชุดเดียวกับ prod ต่างกันเฉพาะ **environment variables** (ปลายทาง Supabase staging branch, โดเมน/คีย์ staging ของ Cloudflare, คีย์อีเมล staging) — ห้าม branch โค้ดหรือ business logic ตาม environment ตามหลักการกลางด้านบน
- **Gate ก่อน promote ขึ้น prod**: performance test ด้วย k6 (เป้าหมาย brief §7: **10,000 concurrent learners / 5,000 exam takers**) + security test (รวมการตรวจ RLS/rate limit ตาม brief §8) ผ่านครบก่อน แล้วจึง promote — เกณฑ์ละเอียดอยู่ที่ TEST-PLAN §4 (Wave D)
- **ขอบเขตข้อมูล**: เฉพาะข้อมูลทดสอบ/ข้อมูลจำลอง — ห้ามใส่ PII จริง (PDPA, brief §8); งบ cloud tier ของ staging ผูกกับ Q7 (PROJECT-PLAN QP-5/Q7)

หมายเหตุ: staging ไม่ใช่ environment ที่สามของ "โค้ดคนละชุด" — เป็น deployment ชุดเดียวกันกับ prod บนปลายทาง cloud อีกชุด เพื่อให้ผล k6/security test ที่พิสูจน์บน staging อ้างอิงไป prod ได้จริง

## 6. Data Flow — สื่อ และ ช่วงคาบสอบ

### 6.1 วิดีโอ streaming (dev ตรง vs prod ผ่าน CDN)

```mermaid
flowchart LR
    subgraph DEVD["DEV"]
        B1["browser"] -->|"1 เปิดบทเรียน"| N1["BFF"]
        N1 -->|"2 ตรวจสิทธิ์ + ออก signed URL"| B1
        B1 -->|"3 สตรีมตรงจาก local Storage"| S1["Supabase Storage (Docker)"]
    end
    subgraph PRODD["PROD (โค้ดเดียวกัน — ต่างแค่ MEDIA_PROVIDER)"]
        B2["browser"] -->|"1"| N2["BFF (Vercel)"]
        N2 -->|"2 ตรวจสิทธิ์ + ออก signed URL"| B2
        B2 -->|"3 สตรีมผ่าน CDN"| C2["Cloudflare CDN"]
        C2 --> R2["R2 / Stream"]
    end
```

เส้นทางสตรีมไม่ผ่าน app server ทั้งสอง environment — BFF ทำแค่ "ตรวจสิทธิ์แล้วออก signed URL อายุสั้น" ผลต่างเดียวคือปลายทาง storage ที่ abstraction เลือกให้ตาม env var

### 6.2 Exam submission burst (สอบพร้อมกัน ~5,000 คน)

```mermaid
flowchart LR
    B["ผู้สอบจำนวนมาก<br/>(answer ทีละข้อ + submit พร้อมกัน)"]
    CF["Rate limit + WAF<br/>(prod: Cloudflare / dev: middleware)"]
    N["BFF stateless<br/>ขยายอัตโนมัติ (Vercel)"]
    DB["PostgreSQL + pooler<br/>upsert สั้น + partial index"]
    OB["email_outbox"]
    W["email worker"]
    B --> CF --> N
    N -->|"transaction สั้นต่อรายการ"| DB
    N -->|"ไม่ block request"| OB
    OB --> W
```

answer save เป็น upsert transaction สั้น + rate limit ต่อ attempt เพื่อกระจายโหลด; งานส่งอีเมลปลอด path นี้ไป outbox แล้ว worker ดึงทีหลัง — รายละเอียดใน SDS §3.1 และ §8

## 7. Sequence — request ธรรมดาพร้อม RLS check

```mermaid
sequenceDiagram
    autonumber
    actor U as ผู้ใช้
    participant E as CDN / middleware
    participant MW as Next middleware
    participant RH as RSC / Route Handler
    participant GU as auth guard + rbac
    participant DB as PostgreSQL (RLS)
    U->>E: GET /api/v1/courses (cookie session)
    MW->>MW: rate limit + ตรวจ Origin (mutation) + x-request-id
    MW->>RH: ส่งต่อพร้อม request context
    RH->>GU: requireUser / requirePermission
    GU->>GU: verify JWT จาก httpOnly cookie
    GU-->>RH: user_id + roles + permissions
    RH->>DB: SELECT ด้วย user JWT (role authenticated) — RLS บังคับจริงทุก query
    DB->>DB: RLS policy กรองแถวตาม user_id/roles ของผู้ใช้
    DB-->>RH: เฉพาะแถวที่ policy อนุญาต
    RH-->>U: 200 + cache headers (CDN/ISR ตามชนิดหน้า)
    Note over RH,DB: service_role (bypass RLS) ใช้เฉพาะกิจ — background job (export / email / auto-submit) + server functions แคบขอบเขต (attempt snapshot, audit append) · **retention purge ใช้บทบาทเฉพาะ `purge_role` ไม่ใช่ service_role (DD §4.3/§4.6 — D13-F11)** · ควบคุมด้วยการจำกัดจุดเรียกในโค้ด + review ไม่ใช่โดย RLS (D11-1)
```

เส้นทางหลักของ request ธรรมดา = **user JWT (role `authenticated`)** — RLS policy บังคับจริงทุก query; `service_role` (bypass RLS) ใช้เฉพาะงานเบื้องหลังและ server functions ที่ขอบเขตแคบ เช่น attempt snapshot / audit append — ความปลอดภัยของเส้นทาง service_role พึ่งการจำกัดจุดเรียกในโค้ด + code review **ไม่ใช่ RLS** (RLS ไม่คุม service_role — D11-1) · ทุกตารางยังต้อง ENABLE RLS + policy ครบทุก path สำหรับ anon/authenticated ตาม DATA-DICTIONARY.md และ authorization ตัดสินที่ rbac service (`requirePermission()` — RBAC §1.2 ข้อ 4) ก่อน query เสมอ

## 8. Migration Path dev → staging → prod (อะไรเปลี่ยน / อะไรเหมือน)

```mermaid
flowchart LR
    subgraph SAME["เหมือนทุกอย่าง (ไม่แตะโค้ด)"]
        C1["โค้ด Next.js ทั้งหมด<br/>(RSC + Route Handlers + Server Actions)"]
        C2["SQL migrations + RLS policies<br/>+ seed กฎ (credit/assessment)"]
        C3["กฎการทำงาน<br/>exam engine / progress / credit"]
        C4["rate limit + CSRF + logging policy"]
    end
    subgraph SWAP["สลับเฉพาะ env vars"]
        E1["SUPABASE_URL + keys<br/>local Kong → Supabase Cloud"]
        E2["MEDIA_PROVIDER + คีย์ R2/Stream<br/>local Storage → R2/Stream"]
        E3["EMAIL_PROVIDER + คีย์/SMTP<br/>Mailpit → Resend"]
        E4["PUBLIC_BASE_URL + CERT_PUBLIC_BASE_URL"]
    end
    SAME --> SWAP
```

| ด้าน | DEV (local Docker) | STAGING (cloud preview) | PROD (cloud) | สิ่งที่สลับด้วย env vars |
| ---- | ------------------ | ---------------------- | ------------ | ---------------------- |
| แอป | next-app container :3000 | Vercel staging/preview deployment | Vercel | `PUBLIC_BASE_URL`, คีย์ platform |
| DB/Auth/Storage | Supabase local (Kong :8000, PG :5432) | Supabase Cloud **staging branch** | Supabase Cloud (region SG/JP) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_POOLER_URL` — migrations เดียวกันทุก env |
| สื่อ | Supabase Storage (Docker volume) | Cloudflare R2/Stream + CDN (bucket/โดเมน staging) | Cloudflare R2/Stream + CDN | `MEDIA_PROVIDER=r2\|stream` + คีย์ |
| อีเมล | Mailpit (จับทดสอบ) | Resend/SMTP staging (ผู้รับจำกัด) | Resend/SMTP จริง | `EMAIL_PROVIDER` + คีย์ |
| WAF/Rate limit | Next middleware (in-memory) | Cloudflare + middleware ชั้นใน | Cloudflare + middleware ชั้นใน | ค่า config ชุดเดียวกัน |
| Cron | container scheduler | Vercel Cron | Vercel Cron | endpoint เดียวกันทุก env |
| การใช้งาน | วนลูปพัฒนา | พิสูจน์ k6 10k/5k + security test + UAT ก่อน promote | ผู้ใช้จริง | โค้ด/migrations/config ชุดเดียวกัน |

สรุป: การ "ขึ้น staging หรือ prod" = รัน migrations เดียวกัน + ตั้ง env vars ชุดของ environment นั้น — ไม่มีการแก้โค้ดหรือ branch ตาม environment (บังคับโดย review + lint) และ promote ขึ้น prod ต้องผ่าน gate บน staging ก่อน (k6 + security — §5.5)
