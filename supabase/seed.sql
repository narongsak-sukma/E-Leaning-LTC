-- ============================================================================
-- supabase/seed.sql - dev seed (D25-O3): catalog + demo users for dev/integration tests
-- source: DATA-DICTIONARY 1.1.0 (migrations 0001-0012) - D25-O3 "dev seeds courses instead of authoring"
--
-- how to run (dev stack must be up + migrated first - migrate.sh does NOT run seed):
--   docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -1 -v ON_ERROR_STOP=1' \
--     < supabase/seed.sql
--
-- idempotent: fixed UUIDs on every row + on conflict do nothing on every insert - safe to re-run (no-op)
-- runs as supabase_admin (superuser -> bypasses RLS) - dev seed only; the app always writes via BFF/RPC
--
-- contents:
--   5 categories (4 active + 1 disabled - used by cc_read / cc_read_admin tests)
--   6 published courses (all 3 levels, both is_public, outcome_highlights on some) + 1 draft (TC-005)
--   lessons of all 3 types (video/document/quiz); quiz with 2 questions x 4 options (real is_correct)
--   credit_rules: active for 3 courses + retired 1 + future-window 1 (proves view filters)
--   final assessment for 1 course + bank with 6 questions (5 active + 1 draft - counts active only;
--   questions activate โดย staff:exam demo ผ่าน guard_question_activation หลัง insert options)
--   1 instructor + 1 staff:exam + 2 learners (citizen), 2 enrollments (active/cancelled), 2 lesson_progress rows
-- ============================================================================

begin;

-- == 1) profiles + roles ==
-- seed profiles have no auth.users row (direct DB insert - dev only);
-- users exercised through real GoTrue signup/login are created in tests/integration
insert into public.profiles (id, display_name, email, preferred_locale, is_active) values
  ('11111111-1111-4111-8111-000000000001', 'Somchai Instructor (demo)', 'instructor.demo@ltc.local', 'th', true),
  ('11111111-1111-4111-8111-000000000002', 'Ploy Exam Staff (demo)',    'staff-exam.demo@ltc.local', 'th', true),
  ('22222222-2222-4222-8222-000000000001', 'Somsri Learner (demo)',     'learner.demo@ltc.local',   'th', true),
  ('22222222-2222-4222-8222-000000000002', 'Somkiat Cancelled (demo)',  'learner2.demo@ltc.local',  'th', true)
on conflict do nothing;

insert into public.role_assignments (user_id, role, granted_by, reason) values
  ('11111111-1111-4111-8111-000000000001', 'instructor', null, 'dev seed'),
  ('22222222-2222-4222-8222-000000000001', 'citizen',    null, 'dev seed'),
  ('22222222-2222-4222-8222-000000000002', 'citizen',    null, 'dev seed'),
  ('11111111-1111-4111-8111-000000000002', 'staff:exam', null, 'dev seed (activate bank questions)')
on conflict do nothing;


-- == 2) course_categories (4 active + 1 disabled) ==
insert into public.course_categories (id, slug, name_th, name_en, sort_order, is_active) values
  ('33333333-3333-4333-8333-000000000001', 'law-basics',  'กฎหมายพื้นฐาน',  'Law Basics',  1, true),
  ('33333333-3333-4333-8333-000000000002', 'tax',         'ภาษีอากร',       'Taxation',    2, true),
  ('33333333-3333-4333-8333-000000000003', 'litigation',  'งานคดี',         'Litigation',  3, true),
  ('33333333-3333-4333-8333-000000000004', 'contracts',   'สัญญา',          'Contracts',   4, true),
  ('33333333-3333-4333-8333-000000000005', 'disabled-category', 'หมวดปิดใช้งาน (ทดสอบ)', 'Disabled (test)', 5, false)
on conflict do nothing;

-- == 3) media_assets (video lessons need media_id + duration_sec) ==
insert into public.media_assets
  (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, duration_sec, status, uploaded_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', 'supabase_storage', 'video', 'media', 'courses/ltc-101/intro.mp4',   'video/mp4', 52428800, 600,  'ready', '11111111-1111-4111-8111-000000000001'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', 'supabase_storage', 'video', 'media', 'courses/ltc-102/intro.mp4',   'video/mp4', 52428800, 1200, 'ready', '11111111-1111-4111-8111-000000000001'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000004', 'supabase_storage', 'video', 'media', 'courses/ltc-104/intro.mp4',   'video/mp4', 52428800, 900,  'ready', '11111111-1111-4111-8111-000000000001'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000006', 'supabase_storage', 'video', 'media', 'courses/ltc-106/intro.mp4',   'video/mp4', 52428800, 720,  'ready', '11111111-1111-4111-8111-000000000001'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-000000000007', 'supabase_storage', 'video', 'media', 'courses/ltc-draft/intro.mp4', 'video/mp4', 52428800, 300,  'ready', '11111111-1111-4111-8111-000000000001')
on conflict do nothing;

-- == 4) courses (6 published + 1 draft; level 3 ค่า, is_public 2 แบบ, highlights บางหลักสูตร) ==
insert into public.courses
  (id, code, category_id, created_by, title_th, title_en, summary, language, is_public,
   level, outcome_highlights, credit_type, status, version, published_at) values
  ('44444444-4444-4444-8444-000000000001', 'LTC-101', '33333333-3333-4333-8333-000000000001',
   '11111111-1111-4111-8111-000000000001',
   'พื้นฐานกฎหมายสำหรับผู้เริ่มต้น', 'Law Basics for Beginners',
   'โครงสร้างกฎหมายไทยและหลักการพื้นฐาน',
   'th', true, 'beginner',
   array['เข้าใจโครงสร้างกฎหมายไทย', 'อ่านกฎหมายลำดับชั้นเป็น'],
   'general', 'published', 1, now() - interval '9 days'),

  ('44444444-4444-4444-8444-000000000002', 'LTC-102', '33333333-3333-4333-8333-000000000002',
   '11111111-1111-4111-8111-000000000001',
   'ภาษีน่ารู้สำหรับทนายความ', 'Tax Essentials',
   'ภาษีเงินได้และภาษีมูลค่าเพิ่มสำหรับทนายความ',
   'th', true, 'intermediate', null,
   'general', 'published', 1, now() - interval '7 days'),

  ('44444444-4444-4444-8444-000000000003', 'LTC-103', '33333333-3333-4333-8333-000000000003',
   '11111111-1111-4111-8111-000000000001',
   'การฟ้องร้องคดีขั้นสูง', 'Advanced Litigation',
   'ยุทธวิธีฟ้องคดีและการเตรียมพยานหลักฐาน',
   'th', false, 'advanced',
   array['ออกแบบแผนฟ้องคดี', 'เตรียมพยานหลักฐานครบ'],
   'general', 'published', 1, now() - interval '5 days'),

  ('44444444-4444-4444-8444-000000000004', 'LTC-104', '33333333-3333-4333-8333-000000000004',
   '11111111-1111-4111-8111-000000000001',
   'ทักษะการร่างสัญญา', 'Contract Drafting',
   'หลักการร่างสัญญาและจุดตรวจสอบความเสี่ยง',
   'th', true, 'beginner',
   array['ร่างสัญญาได้ด้วยตนเอง'],
   'general', 'published', 1, now() - interval '2 days'),

  ('44444444-4444-4444-8444-000000000005', 'LTC-105', '33333333-3333-4333-8333-000000000002',
   '11111111-1111-4111-8111-000000000001',
   'วางแผนภาษีให้ลูกค้า', 'Tax Planning',
   'แนวทางวางแผนภาษีอย่างถูกกฎหมาย',
   'th', false, 'intermediate', null,
   'general', 'published', 1, now() - interval '1 day'),

  ('44444444-4444-4444-8444-000000000006', 'LTC-106', '33333333-3333-4333-8333-000000000003',
   '11111111-1111-4111-8111-000000000001',
   'จริยธรรมทนายความ', 'Legal Ethics',
   'มาตรฐานจริยธรรมวิชาชีพของสภาทนายความฯ',
   'th', true, 'beginner', null,
   'general', 'published', 1, now() - interval '2 days'),

  ('44444444-4444-4444-8444-000000000007', 'LTC-DRAFT-001', '33333333-3333-4333-8333-000000000001',
   '11111111-1111-4111-8111-000000000001',
   'หลักสูตรร่าง (ยังไม่เผยแพร่)', 'Draft Course',
   'สถานะ draft - guest ต้องมองไม่เห็น (TC-005)',
   'th', true, 'beginner', null,
   'general', 'draft', 1, null)
on conflict do nothing;

-- == 5) course_modules (1 module per course) ==
insert into public.course_modules (id, course_id, title_th, sort_order, is_preview) values
  ('55555555-5555-4555-8555-000000000001', '44444444-4444-4444-8444-000000000001', 'โมดูลที่ 1 พื้นฐาน',      1, true),
  ('55555555-5555-4555-8555-000000000002', '44444444-4444-4444-8444-000000000002', 'โมดูลที่ 1 ภาษี',         1, true),
  ('55555555-5555-4555-8555-000000000003', '44444444-4444-4444-8444-000000000003', 'โมดูลที่ 1 คดี',          1, false),
  ('55555555-5555-4555-8555-000000000004', '44444444-4444-4444-8444-000000000004', 'โมดูลที่ 1 สัญญา',        1, false),
  ('55555555-5555-4555-8555-000000000005', '44444444-4444-4444-8444-000000000005', 'โมดูลที่ 1 แผนภาษี',      1, false),
  ('55555555-5555-4555-8555-000000000006', '44444444-4444-4444-8444-000000000006', 'โมดูลที่ 1 จริยธรรม',     1, false),
  ('55555555-5555-4555-8555-000000000007', '44444444-4444-4444-8444-000000000007', 'โมดูลที่ 1 ร่าง',         1, false)
on conflict do nothing;

-- == 6) lesson_quizzes (quiz lesson of course 1) ==
insert into public.lesson_quizzes (id, title, pass_pct, max_attempts, shuffle_questions, status) values
  ('77777777-7777-4777-8777-000000000001', 'ควิซท้ายบท พื้นฐานกฎหมาย', 60, 3, true, 'active')
on conflict do nothing;

-- == 7) lessons (all 3 types: video/document/quiz) ==
insert into public.lessons
  (id, module_id, type, title_th, content_md, duration_sec, media_id, quiz_id, sort_order, is_preview) values
  -- course 1: video + document + quiz
  ('66666666-6666-4666-8666-000000000001', '55555555-5555-4555-8555-000000000001', 'video',
   'บทที่ 1 แนะนำหลักสูตร', null, 600, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', null, 1, true),
  ('66666666-6666-4666-8666-000000000002', '55555555-5555-4555-8555-000000000001', 'document',
   'บทที่ 2 เอกสารประกอบ', '# เอกสารประกอบการเรียน' || chr(10) || chr(10) || 'อ่านประกอบบทเรียนวิดีโอ', null, null, null, 2, true),
  ('66666666-6666-4666-8666-000000000003', '55555555-5555-4555-8555-000000000001', 'quiz',
   'บทที่ 3 ควิซท้ายบท', null, null, null, '77777777-7777-4777-8777-000000000001', 3, false),
  -- course 2: video + document
  ('66666666-6666-4666-8666-000000000004', '55555555-5555-4555-8555-000000000002', 'video',
   'บทที่ 1 ภาษีเงินได้', null, 1200, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', null, 1, true),
  ('66666666-6666-4666-8666-000000000005', '55555555-5555-4555-8555-000000000002', 'document',
   'บทที่ 2 ตารางภาษี', '# ตารางภาษี' || chr(10) || chr(10) || 'อัตราภาษีเงินได้บุคคลธรรมดา', null, null, null, 2, false),
  -- course 3: document
  ('66666666-6666-4666-8666-000000000006', '55555555-5555-4555-8555-000000000003', 'document',
   'บทที่ 1 แผนฟ้องคดี', '# แผนฟ้องคดี' || chr(10) || chr(10) || 'โครงร่างการเตรียมพยานหลักฐาน', null, null, null, 1, false),
  -- course 4: video
  ('66666666-6666-4666-8666-000000000007', '55555555-5555-4555-8555-000000000004', 'video',
   'บทที่ 1 หลักร่างสัญญา', null, 900, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004', null, 1, false),
  -- course 5: document
  ('66666666-6666-4666-8666-000000000008', '55555555-5555-4555-8555-000000000005', 'document',
   'บทที่ 1 แผนภาษี', '# แผนภาษี' || chr(10) || chr(10) || 'ขั้นตอนการวางแผนภาษี', null, null, null, 1, false),
  -- course 6: video
  ('66666666-6666-4666-8666-000000000009', '55555555-5555-4555-8555-000000000006', 'video',
   'บทที่ 1 จริยธรรมพื้นฐาน', null, 720, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006', null, 1, false),
  -- course 7 (draft): video
  ('66666666-6666-4666-8666-000000000010', '55555555-5555-4555-8555-000000000007', 'video',
   'บทที่ 1 ร่าง', null, 300, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007', null, 1, false)
on conflict do nothing;

-- == 8) quiz_questions + quiz_options (single_choice = correct 1 ตัว) ==
insert into public.quiz_questions (id, quiz_id, question_text, type, explanation, points, sort_order, is_active) values
  ('88888888-8888-4888-8888-000000000001', '77777777-7777-4777-8777-000000000001',
   'กฎหมายใดมีลำดับชั้นสูงสุดในระบบกฎหมายไทย', 'single_choice', 'รัฐธรรมนูญสูงสุด', 1, 1, true),
  ('88888888-8888-4888-8888-000000000002', '77777777-7777-4777-8777-000000000001',
   'กฎหมายลำดับชั้นรองจาก พ.ร.บ. คืออะไร', 'single_choice', 'กฎกระทรวง', 1, 2, true)
on conflict do nothing;

insert into public.quiz_options (id, question_id, option_text, is_correct, sort_order) values
  -- q1: correct = option 1 (รัฐธรรมนูญ)
  ('99999999-9999-4999-8999-000000000001', '88888888-8888-4888-8888-000000000001', 'กฎหมายรัฐธรรมนูญ', true,  1),
  ('99999999-9999-4999-8999-000000000002', '88888888-8888-4888-8888-000000000001', 'พระราชบัญญัติ',    false, 2),
  ('99999999-9999-4999-8999-000000000003', '88888888-8888-4888-8888-000000000001', 'กฎกระทรวง',        false, 3),
  ('99999999-9999-4999-8999-000000000004', '88888888-8888-4888-8888-000000000001', 'ระเบียบ',          false, 4),
  -- q2: correct = option 3
  ('99999999-9999-4999-8999-000000000005', '88888888-8888-4888-8888-000000000002', 'รัฐธรรมนูญ',       false, 1),
  ('99999999-9999-4999-8999-000000000006', '88888888-8888-4888-8888-000000000002', 'พระราชกฤษฎีกา',    false, 2),
  ('99999999-9999-4999-8999-000000000007', '88888888-8888-4888-8888-000000000002', 'กฎกระทรวง',        true,  3),
  ('99999999-9999-4999-8999-000000000008', '88888888-8888-4888-8888-000000000002', 'ระเบียบ',          false, 4)
on conflict do nothing;

-- == 9) credit_rules (active x3 + retired x1 + future-window x1) ==
insert into public.credit_rules
  (id, code, name, course_id, credit_type, credits, valid_days, carry_over, priority,
   effective_from, effective_to, status, renewal_cycle) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', 'CR-LTC-101', 'หลักสูตร 101 ให้ 12.50 credit',
   '44444444-4444-4444-8444-000000000001', 'general', 12.50, 365, true, 10,
   now() - interval '30 days', null, 'active', 'annual'),

  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000002', 'CR-LTC-102', 'หลักสูตร 102 ให้ 6.00 credit',
   '44444444-4444-4444-8444-000000000002', 'general', 6.00, 365, false, 20,
   now() - interval '30 days', null, 'active', 'annual'),

  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000003', 'CR-LTC-103', 'หลักสูตร 103 ให้ 3.50 credit',
   '44444444-4444-4444-8444-000000000003', 'general', 3.50, 365, false, 10,
   now() - interval '30 days', null, 'active', 'annual'),

  -- retired: ต้องไม่ถูกเลือก แม้ priority ต่ำกว่า active (status filter ของ course_public_stats)
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000004', 'CR-LTC-101-OLD', 'เก่า retired 9.00 (ห้ามใช้)',
   '44444444-4444-4444-8444-000000000001', 'general', 9.00, null, false, 5,
   now() - interval '400 days', now() - interval '365 days', 'retired', 'annual'),

  -- future window: effective_from ในอนาคต → course 4 ต้องได้ credits NULL
  ('bbbbbbbb-bbbb-4bbb-8bbb-000000000005', 'CR-LTC-104-FUTURE', 'อนาคต 8.00 (ยังไม่มีผล)',
   '44444444-4444-4444-8444-000000000004', 'general', 8.00, null, false, 5,
   now() + interval '90 days', null, 'active', 'annual')
on conflict do nothing;

-- == 10) assessment ปลายหลักสูตร (course 3) + rules + bank + questions ==
insert into public.assessments
  (id, course_id, code, title, description, is_final, status, published_at) values
  ('cccccccc-cccc-4ccc-8ccc-000000000001', '44444444-4444-4444-8444-000000000003',
   'EXAM-LTC-103', 'ข้อสอบปลายหลักสูตร การฟ้องร้องคดีขั้นสูง', null, true, 'published', now())
on conflict do nothing;

insert into public.assessment_rules
  (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
   attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection, require_course_complete,
   proctoring_mode, effective_from) values
  ('dddddddd-dddd-4ddd-8ddd-000000000001', 'cccccccc-cccc-4ccc-8ccc-000000000001',
   1, 90, 5, 70, 3, 1440, true, true, '{"bank_ids":["eeeeeeee-eeee-4eee-8eee-000000000001"]}'::jsonb,
   true, 'basic', now() - interval '1 day')
on conflict do nothing;

insert into public.question_banks
  (id, code, name, created_by, course_id, description, is_active) values
  ('eeeeeeee-eeee-4eee-8eee-000000000001', 'QB-LTC-103', 'ธนาคารข้อสอบ การฟ้องร้องคดีขั้นสูง',
   '11111111-1111-4111-8111-000000000001', '44444444-4444-4444-8444-000000000003',
   'dev seed bank', true)
on conflict do nothing;

-- ทั้ง 6 ข้อ insert เป็น draft ก่อน (guard_question_activation: active ต้องมีตัวเลือกก่อน
-- — D20-M3 — และเปิดโดย staff:exam เท่านั้น) แล้วค่อย activate 5 ข้อหลัง insert options
-- (ดู step activate ท้ายไฟล์) — view course_exam_summary ต้องนับได้ 5
insert into public.questions
  (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version) values
  ('f0f0f0f0-f0f0-4f0f-8f0f-000000000001', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'single_choice', 'easy',
   'ข้อใดเป็นหลักนำตัวบุคคล', 'หลักนำตัวบุคคล', 1, 'draft', array['procedural'], '11111111-1111-4111-8111-000000000001', 1),
  ('f0f0f0f0-f0f0-4f0f-8f0f-000000000002', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'single_choice', 'medium',
   'พยานหลักฐานเอกสารต้องยื่นเมื่อใด', 'ยื่นพร้อมฟ้อง', 1, 'draft', array['procedural'], '11111111-1111-4111-8111-000000000001', 1),
  ('f0f0f0f0-f0f0-4f0f-8f0f-000000000003', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'single_choice', 'medium',
   'คำฟ้องต้องมีรายละเอียดอย่างน้อยกี่ข้อ', '3 ข้อ', 1, 'draft', array['procedural'], '11111111-1111-4111-8111-000000000001', 1),
  ('f0f0f0f0-f0f0-4f0f-8f0f-000000000004', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'single_choice', 'hard',
   'คำสั่งศาลสั่งฟ้องพินาศ หมายถึงอะไร', 'ฟ้องไม่มีนัยสำคัญ', 1, 'draft', array['substantive'], '11111111-1111-4111-8111-000000000001', 1),
  ('f0f0f0f0-f0f0-4f0f-8f0f-000000000005', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'single_choice', 'medium',
   'การยื่นคำให้การของจำเลยภายในกี่วัน', '15 วัน', 1, 'draft', array['procedural'], '11111111-1111-4111-8111-000000000001', 1),
  ('f0f0f0f0-f0f0-4f0f-8f0f-000000000006', 'eeeeeeee-eeee-4eee-8eee-000000000001', 'single_choice', 'medium',
   'ข้อร่าง (ไม่นับใน question_count)', null, 1, 'draft', array['prose'], '11111111-1111-4111-8111-000000000001', 1)
on conflict do nothing;

-- == 11) bank question_options (4 options per active question, exactly 1 correct each) ==
insert into public.question_options (id, question_id, option_text, is_correct, sort_order) values
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000001', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000001', 'หลักนำตัวบุคคล',      true,  1),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000002', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000001', 'หลักนำผู้เสียหาย',    false, 2),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000003', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000001', 'หลักตามสมควร',        false, 3),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000004', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000001', 'หลักอื่น',            false, 4),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000005', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000002', 'พร้อมคำฟ้อง',         true,  1),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000006', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000002', 'หลังตอบ 15 วัน',      false, 2),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000007', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000002', 'หลังพิจารณา',         false, 3),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000008', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000002', 'ไม่ต้องยื่น',          false, 4),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000009', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000003', '2 ข้อ',               false, 1),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000010', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000003', '3 ข้อ',               true,  2),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000011', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000003', '4 ข้อ',               false, 3),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000012', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000003', 'ไม่จำกัด',            false, 4),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000013', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000004', 'ฟ้องไม่มีนัยสำคัญ',   true,  1),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000014', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000004', 'ฟ้องเกินกำหนด',       false, 2),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000015', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000004', 'ฟ้องซ้ำ',             false, 3),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000016', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000004', 'ไม่มีอำนาจศาล',       false, 4),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000017', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000005', '15 วัน',              true,  1),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000018', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000005', '7 วัน',               false, 2),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000019', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000005', '30 วัน',              false, 3),
  ('f1f1f1f1-f1f1-4f1f-8f1f-000000000020', 'f0f0f0f0-f0f0-4f0f-8f0f-000000000005', '60 วัน',              false, 4)
on conflict do nothing;

-- == 11b) activate โจทย์ธนาคารข้อสอบ 5 ข้อ (ทางการตาม guard_question_activation —
--          ต้องมีตัวเลือกครบก่อน (D20-M3) และผู้เปิดต้องเป็น staff:exam) ==
set local "request.jwt.claims" = '{"sub":"11111111-1111-4111-8111-000000000002","role":"authenticated"}';
update public.questions set status = 'active'
 where bank_id = 'eeeeeeee-eeee-4eee-8eee-000000000001'
   and id <> 'f0f0f0f0-f0f0-4f0f-8f0f-000000000006'; -- ข้อ 0006 คง draft → view นับได้ 5

-- == 12) enrollments (active + cancelled) ==
insert into public.enrollments
  (id, user_id, course_id, status, source, created_by, enrolled_at, expires_at, completed_at) values
  ('e0e0e0e0-e0e0-4e0e-8e0e-000000000001', '22222222-2222-4222-8222-000000000001',
   '44444444-4444-4444-8444-000000000001', 'active', 'self', null, now() - interval '3 days', null, null),
  ('e0e0e0e0-e0e0-4e0e-8e0e-000000000002', '22222222-2222-4222-8222-000000000002',
   '44444444-4444-4444-8444-000000000001', 'cancelled', 'self', null, now() - interval '3 days', null, null)
on conflict do nothing;

-- == 13) lesson_progress (learner: video จบแล้ว + document กำลังเรียน) ==
insert into public.lesson_progress
  (id, enrollment_id, lesson_id, status, video_max_position_sec, watch_sec_accum, watch_pct, dwell_sec,
   quiz_score_pct, completed_at) values
  ('f2f2f2f2-f2f2-4f2f-8f2f-000000000001', 'e0e0e0e0-e0e0-4e0e-8e0e-000000000001',
   '66666666-6666-4666-8666-000000000001', 'completed', 600, 600, 100, 620, null, now() - interval '2 days'),
  ('f2f2f2f2-f2f2-4f2f-8f2f-000000000002', 'e0e0e0e0-e0e0-4e0e-8e0e-000000000001',
   '66666666-6666-4666-8666-000000000002', 'in_progress', 0, 40, 7, 45, null, null)
on conflict do nothing;

commit;
