-- 0004_catalog.sql — โดเมน 2-3: Catalog & Enrollment + media_assets
-- ที่มา: DD §3.2, §3.3, §4.1 (FK วน -> ALTER ทีหลัง)

-- ═══ course_categories (DD §3.2) ═══
create table public.course_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  name_th text not null,
  name_en text null,
  parent_id uuid null references public.course_categories (id),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now() -- แบบแผนกลาง DD §1 (D18-M11)
);

create unique index uq_course_categories_slug on public.course_categories (slug);
create index course_categories_parent_idx on public.course_categories (parent_id);

-- D18-M9: กันโครงหมวด (DD §3.2 "โครง 1 ระดับ กัน loop — CHECK ผ่าน trigger"):
-- ห้าม parent_id ชี้ตัวเอง / วงวน (cycle) / ซ้อนเกิน 1 ระดับ
create or replace function public.guard_category_hierarchy() returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_parent uuid;
  v_hops int := 0;
begin
  -- self-parent: parent_id ชี้ตัวเอง
  if new.parent_id is not null and new.parent_id = new.id then
    raise exception 'course_categories: parent_id ห้ามชี้ตัวเอง (DD §3.2, D18-M9)';
  end if;
  if new.parent_id is not null then
    -- D19-M7: โหนดที่มีหมวดย่อยอยู่แล้ว ย้ายไปอยู่ใต้หมวดอื่นไม่ได้ — ไม่งั้นได้ depth 2
    -- (B ใต้ A แล้วย้าย A ไปใต้ C = 3 ชั้น) — โครง 1 ระดับต้องครบทั้ง insert และ update
    if exists (select 1 from public.course_categories c where c.parent_id = new.id) then
      raise exception 'course_categories: หมวดนี้มีหมวดย่อย — ย้ายไปใต้หมวดอื่นไม่ได้ (โครง 1 ระดับ - DD §3.2, D19-M7)';
    end if;
    -- depth เกิน 1 ระดับ: parent ของ parent ต้องไม่มี (DD §3.2)
    select parent_id into v_parent
    from public.course_categories
    where id = new.parent_id;
    if v_parent is not null then
      raise exception 'course_categories: หมวดซ้อนได้ระดับเดียว — parent ของ parent ต้องไม่มี (DD §3.2, D18-M9)';
    end if;
    -- กันวงวน: ไต่ขึ้นจาก parent ห้ามวนกลับมาที่ตัวเอง (belt-and-braces — depth guard กันไว้แล้ว)
    while v_parent is not null and v_hops < 5 loop
      if v_parent = new.id then
        raise exception 'course_categories: parent_id สร้างวงวน (cycle) ไม่ได้ (DD §3.2, D18-M9)';
      end if;
      select parent_id into v_parent
      from public.course_categories
      where id = v_parent;
      v_hops := v_hops + 1;
    end loop;
  end if;
  return new;
end;
$fn$;
create trigger trg_course_categories_hierarchy
  before insert or update on public.course_categories
  for each row execute function public.guard_category_hierarchy();

-- ═══ courses (DD §3.2) ═══
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  category_id uuid not null references public.course_categories (id),
  created_by uuid not null references public.profiles (id),
  title_th text not null,
  title_en text null,
  summary text null,
  description_md text null,
  cover_media_id uuid null,
  language text not null default 'th',
  is_public boolean not null default true,
  credit_type text not null default 'general',
  status public.course_status not null default 'draft',
  version int not null default 1,
  published_at timestamptz null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_courses_code on public.courses (code);
create index courses_category_status_idx on public.courses (category_id, status);
create index courses_status_active_idx on public.courses (status) where deleted_at is null;

-- ═══ course_modules (DD §3.2) ═══
create table public.course_modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id),
  title_th text not null,
  sort_order int not null,
  is_preview boolean not null default false,
  deleted_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_course_modules_sort
  on public.course_modules (course_id, sort_order) where deleted_at is null;
create index course_modules_course_idx on public.course_modules (course_id);

-- ═══ lesson_quizzes (DD §3.3) ═══
create table public.lesson_quizzes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  pass_pct smallint not null default 60 check (pass_pct between 1 and 100),
  max_attempts int null,
  shuffle_questions boolean not null default true,
  status text not null default 'active' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now()
);

-- ═══ lessons (DD §3.3) ═══
create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.course_modules (id),
  type public.lesson_type not null,
  title_th text not null,
  content_md text null,
  duration_sec int null check (duration_sec > 0),
  media_id uuid null,
  quiz_id uuid null,
  sort_order int not null,
  completion_rule jsonb null,
  is_preview boolean not null default false,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint lessons_video_check
    check (type <> 'video' or (media_id is not null and duration_sec is not null)),
  constraint lessons_quiz_check
    check (type <> 'quiz' or quiz_id is not null)
);
create unique index uq_lessons_sort
  on public.lessons (module_id, sort_order) where deleted_at is null;
-- D20-B3: quiz หนึ่งอันผูกกับ lesson ที่มีชีวิตได้เพียงอันเดียว — ปิดช่อง instructor
-- สร้าง lesson ในหลักสูตรตัวเองโดยแนบ quiz_id ของหลักสูตรอื่น แล้วได้สิทธิ์
-- อ่าน (รวมคำตอบ) / แก้ quiz ต่างถิ่นผ่าน policy ที่ไล่ตาม lessons.quiz_id
-- D21-B3: predicate ห้ามยกเว้นแถว soft-delete — instructor มิฉะนั้นสร้าง lesson
-- "เกิดมาพร้อม deleted_at" พร้อม quiz_id ต่างถิ่นหลุด unique แล้วได้สิทธิ์ quiz นั้น
create unique index uq_lessons_quiz_ref
  on public.lessons (quiz_id) where quiz_id is not null;
create index lessons_quiz_idx on public.lessons (quiz_id);

-- ═══ media_assets (DD §3.2) ═══
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  provider public.media_provider not null,
  media_type public.media_type not null,
  bucket text not null,
  storage_path text not null,
  playback_id text null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  duration_sec int null check (duration_sec > 0 and duration_sec <= 3600),
  checksum_sha256 text null,
  status public.media_status not null default 'uploading',
  -- Wave F nit: NOT NULL ตามจริง · uploaded_by = ผู้อัปโหลดจริง (actor) — ไม่เสมอเจ้าของข้อมูล
  -- (เช่น PDF ใบประกาศ = ผู้ออกใบ/runner ตาม admin_attach_certificate_pdf 0019)
  uploaded_by uuid not null references public.profiles (id),
  deleted_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_media_assets_path
  on public.media_assets (provider, bucket, storage_path) where deleted_at is null;
create index media_assets_type_status_idx on public.media_assets (media_type, status);

-- ═══ enrollments (DD §3.2) ═══
create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  course_id uuid not null references public.courses (id),
  status public.enrollment_status not null default 'active',
  source text not null default 'self' check (source in ('self','staff')),
  created_by uuid null references public.profiles (id),
  enrolled_at timestamptz not null default now(),
  expires_at timestamptz null,
  completed_at timestamptz null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_enrollments_user_course_active
  on public.enrollments (user_id, course_id) where deleted_at is null;
create index enrollments_course_status_idx on public.enrollments (course_id, status);
create index enrollments_user_idx on public.enrollments (user_id);

-- ═══ FKs ที่เลื่อนมาทำภายหลัง (DD §4.1) ═══
alter table public.courses add constraint courses_cover_media_id_fkey
  foreign key (cover_media_id) references public.media_assets (id);
alter table public.lessons add constraint lessons_media_id_fkey
  foreign key (media_id) references public.media_assets (id);
-- DD §4.1: lesson(type=quiz) กับ quiz อ้างกัน — insert lesson ก่อน quiz ใน TX เดียว,
-- policy เห็น lesson ทันที FK ตรวจตอน commit (D18-M3)
alter table public.lessons add constraint lessons_quiz_id_fkey
  foreign key (quiz_id) references public.lesson_quizzes (id)
  deferrable initially deferred;
alter table public.lawyer_licenses add constraint lawyer_licenses_evidence_media_id_fkey
  foreign key (evidence_media_id) references public.media_assets (id);
alter table public.license_applications add constraint license_applications_evidence_media_id_fkey
  foreign key (evidence_media_id) references public.media_assets (id);

-- lesson_progress (DD §3.3)
create table public.lesson_progress (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments (id),
  lesson_id uuid not null references public.lessons (id),
  status public.progress_status not null default 'not_started',
  video_max_position_sec int null default 0 check (video_max_position_sec is null or video_max_position_sec >= 0), -- nullable ตาม DD §3.3 (D18-m2)
  created_at timestamptz not null default now(),
  watch_sec_accum int not null default 0 check (watch_sec_accum >= 0),
  watch_pct smallint not null default 0 check (watch_pct between 0 and 100),
  dwell_sec int not null default 0 check (dwell_sec >= 0),
  quiz_score_pct smallint null,
  completed_at timestamptz null,
  updated_at timestamptz not null default now()
);

create unique index uq_lesson_progress_enrollment_lesson
  on public.lesson_progress (enrollment_id, lesson_id);
create index lesson_progress_lesson_idx on public.lesson_progress (lesson_id);
create trigger trg_lesson_progress_updated_at
  before update on public.lesson_progress
  for each row execute function public.set_updated_at();
-- quiz_questions (DD §3.3)
create table public.quiz_questions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.lesson_quizzes (id),
  question_text text not null,
  type public.question_type not null,
  explanation text null,
  points smallint not null default 1 check (points > 0),
  sort_order int not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index quiz_questions_quiz_sort_idx on public.quiz_questions (quiz_id, sort_order);

-- quiz_options (DD §3.3)
create table public.quiz_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.quiz_questions (id),
  option_text text not null,
  is_correct boolean not null,
  sort_order int not null,
  created_at timestamptz not null default now()
);
create unique index uq_quiz_options_sort on public.quiz_options (question_id, sort_order);

-- quiz_attempts (DD §3.3)
create table public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references public.lesson_quizzes (id),
  user_id uuid not null references public.profiles (id),
  attempt_no int not null check (attempt_no > 0),
  started_at timestamptz not null default now(),
  submitted_at timestamptz null,
  score_pct smallint null check (score_pct between 0 and 100),
  passed boolean null,
  answers_snapshot jsonb null,
  created_at timestamptz not null default now()
);
create unique index uq_quiz_attempts_no
  on public.quiz_attempts (quiz_id, user_id, attempt_no);
create index quiz_attempts_user_idx on public.quiz_attempts (user_id);
