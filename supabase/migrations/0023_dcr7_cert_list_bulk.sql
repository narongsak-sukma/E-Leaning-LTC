-- ═══ 0023 — DCR-7 / PB-20 + D36-O4 (Wave E): cert list RPC + bulk job infra ═══
-- 3 ส่วน (ตัดสิน D55-2 / D55-5):
--   (1) admin_list_certificates — keyset-in-SQL แบบ admin_eligible_certificates
--       (0019 F6) สำหรับ GET /admin/certificates · role-gate ที่ BFF ตรง ๆ
--       (staff:registrar + super_admin — D55-2: ไม่เพิ่ม permission ใหม่ ไม่ยืม
--       certificate:issue) · audit PII_ACCESS ทำที่ BFF (แบบแผน eligible)
--   (2) cert_bulk_jobs — ตารางสถานะ job ออกใบเป็นชุด (รูปตาม report_exports
--       0007:103) · fail-closed ทุก JWT path (RLS เปิด + ไม่มี policy สำหรับ
--       authenticated) — เข้าถึงผ่าน BFF service_role เท่านั้น
--   (3) admin_cert_bulk_pick — picker ≤200 แถวต่อรอบ (WHERE เดียวกับ eligible)
--       BFF ลูปเรียก admin_issue_certificate ต่อใบ = TX เดียวต่อใบ + audit
--       CERT_ISSUE actor ครบต่อใบผ่าน cert_issue_core อยู่แล้ว (0019)
--       · anti-join ใบ valid ทำให้ pick ซ้ำ/ออกซ้ำไม่ได้ (idempotent per cert)

-- ═══ (1) admin_list_certificates ═══
-- อ่านจาก snapshot ของใบ (holder_name_snapshot/course_title_snapshot — 0006)
-- ไม่ live-join profiles/courses: ใบที่ออกไปแล้วเป็น immutable record ชื่อ/ชื่อ
-- หลักสูตรคือของวันออกใบ (เดียวกับที่ verify สาธารณะใช้)
create or replace function public.admin_list_certificates(
  p_after_issued_at timestamptz default null,
  p_after_id uuid default null,
  p_cert_no text default null,
  p_verify_code text default null,
  p_status text default null,
  p_holder_user_id uuid default null,
  p_course_id uuid default null,
  p_limit int default 20
) returns table (
  id uuid,
  cert_no text,
  verify_code text,
  status text,
  issued_at timestamptz,
  user_id uuid,
  holder_name text,
  course_id uuid,
  course_title text
)
language sql stable security definer
set search_path = public
as $fn$
  select c.id,
         c.cert_no,
         c.verify_code,
         c.status::text,
         c.issued_at,
         c.user_id,
         c.holder_name_snapshot,
         c.course_id,
         c.course_title_snapshot
  from public.certificates c
  where (p_cert_no is null or c.cert_no ilike p_cert_no || '%')
    and (p_verify_code is null or c.verify_code = p_verify_code)
    and (p_status is null or c.status::text = p_status)
    and (p_holder_user_id is null or c.user_id = p_holder_user_id)
    and (p_course_id is null or c.course_id = p_course_id)
    and ((p_after_issued_at is null and p_after_id is null)
         or (c.issued_at, c.id) < (p_after_issued_at, p_after_id))
  order by c.issued_at desc, c.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 101);
$fn$;
alter function public.admin_list_certificates(timestamptz, uuid, text, text, text, uuid, uuid, int)
  owner to app_owner;
revoke execute on function public.admin_list_certificates(timestamptz, uuid, text, text, text, uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function public.admin_list_certificates(timestamptz, uuid, text, text, text, uuid, uuid, int)
  to service_role;

-- keyset index ของ list (ไม่มี index ที่ (issued_at,id) เดิม — 0006 มีเฉพาะ
-- user_idx/supersedes_idx ซึ่งไม่ตอบ order by issued_at desc)
create index certificates_issued_keyset_idx
  on public.certificates (issued_at desc, id desc);

-- ═══ (2) cert_bulk_jobs ═══
-- คอลัมน์/index ตาม DD §3.7 ฉบับ DCR-7 (canonical) — status มี 'pending' เผื่อ
-- อนาคตมีคิว worker จริง (ปัจจุบัน BFF สร้าง job แล้วเลื่อนเป็น running ทันที)
create table public.cert_bulk_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles (id),
  course_id uuid null references public.courses (id), -- null = ทุกหลักสูตร
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed')),
  total_attempts int not null default 0,
  issued_count int not null default 0,
  failed_count int not null default 0,
  last_error text null,
  created_at timestamptz not null default now(),
  finished_at timestamptz null
);
create index cert_bulk_jobs_queue_idx
  on public.cert_bulk_jobs (status) where status in ('pending','running');
create index cert_bulk_jobs_created_idx
  on public.cert_bulk_jobs (created_by, created_at desc);

alter table public.cert_bulk_jobs enable row level security;
-- ไม่มี policy สำหรับ JWT path ใด ๆ (fail-closed) — BFF service_role เท่านั้น
revoke all on public.cert_bulk_jobs from public, anon, authenticated;
grant select, insert, update on public.cert_bulk_jobs to service_role;

-- ═══ (3) admin_cert_bulk_pick ═══
-- WHERE เดียวกับ admin_eligible_certificates (0019) แต่ cap 200 ต่อรอบ
-- (batch 200 ตาม D55-5 — เทียบเท่า batch ของ 0020) และไม่มี keyset (job วน
-- รับชุดถัดไปเองจนหมด: ใบที่ออกสำเร็จหายจาก anti-join ทันที)
create or replace function public.admin_cert_bulk_pick(
  p_course_id uuid default null,
  p_limit int default 200
) returns table (
  attempt_id uuid,
  enrollment_id uuid,
  user_id uuid,
  course_id uuid,
  holder_name text,
  score_pct smallint,
  submitted_at timestamptz
)
language sql stable security definer
set search_path = public
as $fn$
  select a.id,
         a.enrollment_id,
         a.user_id,
         e.course_id,
         coalesce(
           nullif(
             holder_name_trim(
               concat_ws(' ',
                 nullif(holder_name_trim(coalesce(p.first_name, '')), ''),
                 nullif(holder_name_trim(coalesce(p.last_name, '')), ''))),
             ''),
           nullif(holder_name_trim(p.display_name), ''),
           ''),
         a.score_pct,
         a.submitted_at
  from public.assessment_attempts a
  join public.enrollments e on e.id = a.enrollment_id
  join public.profiles p on p.id = a.user_id
  where a.passed
    and a.status = 'passed'
    and a.submitted_at is not null
    and e.status = 'completed'
    and e.deleted_at is null
    and e.completed_at is not null
    and not exists (select 1
                    from public.certificates c
                    where c.enrollment_id = a.enrollment_id
                      and c.status = 'valid')
    and (p_course_id is null or e.course_id = p_course_id)
  order by a.submitted_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$fn$;
alter function public.admin_cert_bulk_pick(uuid, int)
  owner to app_owner;
revoke execute on function public.admin_cert_bulk_pick(uuid, int)
  from public, anon, authenticated;
grant execute on function public.admin_cert_bulk_pick(uuid, int)
  to service_role;
