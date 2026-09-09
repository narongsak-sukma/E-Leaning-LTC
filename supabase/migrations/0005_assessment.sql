-- 0005_assessment.sql — โดเมน 4: Assessment (DD §3.4 ยกเว้น certificates)
-- ที่มา: DD §3.4 + §4.2 (options correctness trigger)

-- ═══ question_banks (DD §3.4) ═══
create table public.question_banks (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  created_by uuid not null references public.profiles (id),
  course_id uuid null references public.courses (id),
  category_id uuid null references public.course_categories (id),
  description text null,
  is_active boolean not null default true,
  created_at timestamptz not null default now() -- แบบแผนกลาง DD §1 (D18-M11)
);
create unique index uq_question_banks_code on public.question_banks (code);
create index question_banks_course_idx on public.question_banks (course_id);

-- ═══ questions (DD §3.4) ═══
create table public.questions (
  id uuid primary key default gen_random_uuid(),
  bank_id uuid not null references public.question_banks (id),
  type public.question_type not null,
  difficulty public.question_difficulty not null default 'medium',
  question_text text not null,
  explanation text null,
  points smallint not null default 1 check (points > 0),
  status public.question_status not null default 'draft',
  tags text[] not null default '{}',
  created_by uuid not null references public.profiles (id),
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index questions_bank_status_diff_idx on public.questions (bank_id, status, difficulty);
create index questions_tags_gin_idx on public.questions using gin (tags);

-- ═══ question_options (DD §3.4) ═══
create table public.question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions (id),
  option_text text not null,
  is_correct boolean not null,
  sort_order int not null,
  created_at timestamptz not null default now()
);
create unique index uq_question_options_sort
  on public.question_options (question_id, sort_order);

-- ═══ assessments (DD §3.4) ═══
create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses (id),
  code text not null,
  title text not null,
  description text null,
  is_final boolean not null default true,
  status public.assessment_status not null default 'draft',
  published_at timestamptz null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_assessments_course_code
  on public.assessments (course_id, code) where deleted_at is null;

-- assessment_rules (DD §3.4 - Q2)
create table public.assessment_rules (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments (id),
  version int not null default 1,
  time_limit_minutes int not null default 60 check (time_limit_minutes between 5 and 480),
  question_count int not null default 30 check (question_count > 0),
  pass_pct smallint not null check (pass_pct between 1 and 100),
  max_attempts int not null default 3 check (max_attempts > 0),
  attempt_cooldown_minutes int not null default 1440 check (attempt_cooldown_minutes >= 0),
  shuffle_questions boolean not null default true,
  shuffle_options boolean not null default true,
  selection jsonb not null default '{}'::jsonb,
  require_course_complete boolean not null default true,
  proctoring_mode public.proctoring_mode not null default 'basic',
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index uq_assessment_rules_version
  on public.assessment_rules (assessment_id, version);
create index assessment_rules_effective_idx
  on public.assessment_rules (assessment_id, effective_from);
-- NB: effective_from <= now() ต้องใส่ตอน query ห้ามเป็น index predicate (now() ไม่ immutable - F21/D12)

-- assessment_attempts (DD §3.4)
create table public.assessment_attempts (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.assessments (id),
  user_id uuid not null references public.profiles (id),
  enrollment_id uuid not null references public.enrollments (id),
  rules_id uuid not null references public.assessment_rules (id),
  attempt_no int not null check (attempt_no > 0),
  status public.attempt_status not null default 'in_progress',
  session_id text not null,
  lease_expires_at timestamptz null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz null,
  score_pct smallint null check (score_pct between 0 and 100),
  passed boolean null,
  question_count int not null,
  correct_count int null,
  client_events jsonb null,
  created_at timestamptz not null default now()
);
create unique index uq_assessment_attempts_no
  on public.assessment_attempts (assessment_id, user_id, attempt_no);
create unique index uq_assessment_attempts_in_progress
  on public.assessment_attempts (assessment_id, user_id) where status = 'in_progress';
create index assessment_attempts_in_progress_idx
  on public.assessment_attempts (status) where status = 'in_progress';
create index assessment_attempts_user_idx on public.assessment_attempts (user_id);

-- attempt_answers (DD §3.4)
create table public.attempt_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.assessment_attempts (id),
  question_id uuid not null references public.questions (id),
  seq int not null,
  option_order int[] null,
  selected_option_ids uuid[] null,
  question_snapshot jsonb not null,
  is_correct boolean null,
  points_earned smallint null,
  answered_at timestamptz null,
  created_at timestamptz not null default now()
);
create unique index uq_attempt_answers_question
  on public.attempt_answers (attempt_id, question_id);
create index attempt_answers_question_idx on public.attempt_answers (question_id);
-- Trigger ตรวจ options ถูกต้อง (DD §4.2)
-- single_choice/true_false ต้องมี is_correct=true จำนวน 1
-- D18-M6(ก): ครอบ UPDATE ด้วย — แถว option ที่ย้าย question_id ต้องตรวจซ้ำ question เดิม
-- (เดิมตรวจเฉพาะ NEW.question_id ทำให้ question เดิมเสีย invariant ได้)
create or replace function public.validate_option_correctness() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_qtype public.question_type;
  v_count int;
begin
  -- UPDATE ที่ย้าย question_id: ตรวจ question เดิม (OLD.question_id) ด้วย
  if tg_op = 'UPDATE' and old.question_id is distinct from new.question_id then
    select type into v_qtype from public.questions where id = old.question_id;
    if v_qtype in ('single_choice','true_false') then
      select count(*) into v_count
      from public.question_options
      where question_id = old.question_id and is_correct = true;
      if v_count <> 1 then
        raise exception 'options: single_choice/true_false ต้องมีคำตอบถูก 1 ตัว (DD §4.2)';
      end if;
    end if;
  end if;

  -- invariant เดิม ณ question ปัจจุบัน (NEW.question_id)
  select type into v_qtype from public.questions where id = new.question_id;
  if v_qtype in ('single_choice','true_false') then
    select count(*) into v_count
    from public.question_options
    where question_id = new.question_id and is_correct = true;
    if v_count <> 1 then
      raise exception 'options: single_choice/true_false ต้องมีคำตอบถูก 1 ตัว (DD §4.2)';
    end if;
  end if;
  return null;
end;
$fn$;

create constraint trigger trg_question_options_correctness
  after insert or update on public.question_options
  deferrable initially deferred
  for each row execute function public.validate_option_correctness();

-- D18-M6(ข): เปลี่ยน type ของข้อ → ตรวจ invariant เดิมซ้ำ (DD §4.2)
create or replace function public.validate_question_type_change() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_count int;
begin
  -- ตรวจเมื่อ type เปลี่ยนจริงเท่านั้น
  if new.type is not distinct from old.type then
    return null;
  end if;
  if new.type in ('single_choice','true_false') then
    select count(*) into v_count
    from public.question_options
    where question_id = new.id and is_correct = true;
    if v_count <> 1 then
      raise exception 'questions: เปลี่ยน type เป็น % ต้องมีคำตอบถูก 1 ตัวเลือก (DD §4.2, D18-M6)', new.type;
    end if;
  end if;
  return null;
end;
$fn$;

create trigger trg_questions_type_correctness
  after update on public.questions
  for each row execute function public.validate_question_type_change();

-- D18-M6(ข) ฝั่ง quiz — quiz_questions มี type เอง (0004) จึงตรวจซ้ำได้เช่นเดียวกัน
create or replace function public.validate_quiz_question_type_change() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_count int;
begin
  if new.type is not distinct from old.type then
    return null;
  end if;
  if new.type in ('single_choice','true_false') then
    select count(*) into v_count
    from public.quiz_options
    where question_id = new.id and is_correct = true;
    if v_count <> 1 then
      raise exception 'quiz_questions: เปลี่ยน type เป็น % ต้องมีคำตอบถูก 1 ตัวเลือก (DD §4.2, D18-M6)', new.type;
    end if;
  end if;
  return null;
end;
$fn$;

create trigger trg_quiz_questions_type_correctness
  after update on public.quiz_questions
  for each row execute function public.validate_quiz_question_type_change();

-- Trigger ตรวจ options ของ quiz (DD §4.2 - quiz_options)
-- D18-M6(ก): ครอบ UPDATE ที่ย้าย question_id — ตรวจซ้ำ question เดิมด้วย
create or replace function public.validate_quiz_option_correctness() returns trigger
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_qtype public.question_type;
  v_count int;
begin
  -- UPDATE ที่ย้าย question_id: ตรวจ question เดิม (OLD.question_id) ด้วย
  if tg_op = 'UPDATE' and old.question_id is distinct from new.question_id then
    select qq.type into v_qtype
    from public.quiz_questions qq
    where qq.id = old.question_id;
    if v_qtype in ('single_choice','true_false') then
      select count(*) into v_count
      from public.quiz_options o
      where o.question_id = old.question_id and o.is_correct = true;
      if v_count <> 1 then
        raise exception 'quiz_options: single_choice/true_false ต้องมีคำตอบถูก 1 ตัว (DD §4.2)';
      end if;
    end if;
  end if;

  -- invariant เดิม ณ question ปัจจุบัน (NEW.question_id)
  select qq.type into v_qtype
  from public.quiz_questions qq
  where qq.id = new.question_id;
  if v_qtype in ('single_choice','true_false') then
    select count(*) into v_count
    from public.quiz_options o
    where o.question_id = new.question_id and o.is_correct = true;
    if v_count <> 1 then
      raise exception 'quiz_options: single_choice/true_false ต้องมีคำตอบถูก 1 ตัว (DD §4.2)';
    end if;
  end if;
  return null;
end;
$fn$;

create constraint trigger trg_quiz_options_correctness
  after insert or update on public.quiz_options
  deferrable initially deferred
  for each row execute function public.validate_quiz_option_correctness();
