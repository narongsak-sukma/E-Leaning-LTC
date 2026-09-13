-- ============================================================================
-- supabase/seed-uat.sql - UAT demo seed (Wave F Phase 3 · D-f-11 · D18)
--
-- วัตถุประสงค์: ข้อมูลสาธิตสำหรับ UAT โดยมนุษย์ (สภาทนายความฯ) ตาม persona ของ SRS
--   8 บัญชี demo (ผู้เรียนพลเมือง · ทนาย · ผู้สอน · เจ้าหน้าที่ 4 บทบาท · super_admin)
--   + หลักสูตร/บทเรียน/ควิซ/ข้อสอบ/กฎ credit ชุด UAT (แยกจาก dev seed — คำนำหน้า [UAT])
--
-- วิธีรัน (มีสคริปต์ครอบให้): scripts/uat-seed.sh
--   สคริปต์สุ่มรหัสผ่าน (หรือรับจาก env UAT_DEMO_PASSWORD) แล้วเรียก:
--   docker compose exec -T -e UAT_PASS="$UAT_DEMO_PASSWORD" db sh -c \
--     'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres \
--      -v ON_ERROR_STOP=1 -v uat_pass="$UAT_PASS" -f -' < supabase/seed-uat.sql
--
-- รหัสผ่าน: ผ่าน psql variable :'uat_pass' เท่านั้น — ไม่มีค่าจริงอยู่ในไฟล์นี้/ใน repo
--   (เก็บที่ .env ของเครื่องสาธิต = UAT_DEMO_PASSWORD=... — ดู .env.example)
--   เข้ารหัส bcrypt ($2a$10) ด้วย pgcrypto — GoTrue (golang bcrypt) ยืนยันได้ทันที
--
-- idempotent: fixed UUIDs (คำนำหน้า 1707…) + on conflict do nothing ทุก insert
--   ยกเว้นรหัสผ่าน: รันซ้ำ = ตั้ง hash ใหม่จากรหัสปัจจุบันทุกครั้ง (update ตรง)
--   จึงเปลี่ยนรหัสผ่านชุด UAT ได้ด้วยการรันซ้ำ
--
-- ผู้รัน: supabase_admin (superuser — dev stack เท่านั้น · ไม่เกี่ยว RLS)
--   บัญชี demo มีแถว auth.users จริง (ต่างจาก dev seed) เพื่อให้มนุษย์ล็อกอินผ่าน /login ได้
--   — trigger on_auth_user_created (0003) สร้าง profiles + role_assignments(citizen) เอง
--
-- MFA ของเจ้าหน้าที่: ตั้งใจ **ไม่** seed factor — สคริปต์ UAT ให้ผู้ทดสอบลงทะเบียน MFA
--   ผ่าน UI จริง (/my/security/enroll) เป็นขั้นแรกหลังล็อกอินครั้งแรก (ทดสอบ AUTH-007
--   ในเส้นทางมนุษย์จริง · rbac.ts:327 บล็อก permission เจ้าหน้าที่ทุกตัวจนกว่า aal2)
--
-- วิดีโอสาธิต: media_assets ชี้ storage_path 'courses/uat-intro/intro.mp4' —
--   ไฟล์จริงอัปโหลดโดย scripts/uat-seed.sh (Big Buck Bunny 10 วิ · CC-BY Blender
--   Foundation — ถ้าไม่มีไฟล์/เน็ต บทเรียนวิดีโอจะเล่นไม่ได้ จดเป็นข้อจำกัดใน UAT.md)
-- ============================================================================

\if :{?uat_pass}
\else
\echo 'ERROR: ต้องส่งรหัสผ่านผ่าน -v uat_pass=... (รันผ่าน scripts/uat-seed.sh)'
\quit 15
\endif

begin;

-- == 0) กรอบรหัสผ่าน (สอดคล้อง GOTRUE_PASSWORD_MIN_LENGTH=12 · bcrypt ตัดที่ 72 ไบต์) ==
create temp table _uat_pw (hash text not null);
insert into _uat_pw values (extensions.crypt(:'uat_pass', extensions.gen_salt('bf', 10)));
alter table _uat_pw add constraint _uat_pw_len_ok check (
  length(:'uat_pass') >= 12 and length(:'uat_pass') <= 72
); -- แถวที่แทรกไว้ถูกตรวจย้อน — รหัสสั้น/ยาวเกิน = ERROR = ทั้ง TX กลิ้ง (ON_ERROR_STOP)

-- == 1) บัญชี demo 8 บัญชี (auth.users จริง + รหัสผ่าน bcrypt) ==
--   id คงที่ คำนำหน้า 1707a000 (แยกจาก dev seed ทุกคำนำหน้า)
--   on conflict (id) do nothing: แถวใหม่เท่านั้นที่ปลุก trigger สร้าง profiles+citizen
--   ตามด้วย update รหัสผ่าน/ยืนยันอีเมลทุกครั้ง — เปลี่ยนรหัส = รัน seed ซ้ำ
--
--   รูปแถวเลียนแบบ GoTrue เป๊ะ (ยืนยันกับแถวจริงที่ signup สร้างใน stack นี้):
--   - aud='' (ไม่ใช่ 'authenticated') — password grant ของ GoTrue กรอง
--     `aud = GOTRUE_AUD` ซึ่งไม่ได้ตั้งใน stack นี้ = ค่าว่าง · ใส่ 'authenticated'
--     จะทำให้ GoTrue หาแถวไม่เจอ → invalid_credentials (ทดสอบจริง 2026-09-13)
--   - คอลัมน์ token ทุกตัวเป็น '' ไม่ใช่ NULL — GoTrue scan เป็น string ค่าว่าง
--     ไม่ได้ (NULL → "converting NULL to string is unsupported" 500)
--   - is_sso_user/is_anonymous = false (NOT NULL) · confirmed_at ตั้งพร้อมยืนยันอีเมล
insert into auth.users
  (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
   confirmation_token, recovery_token, email_change,
   email_change_token_new, email_change_token_current, reauthentication_token,
   phone_change, raw_app_meta_data, raw_user_meta_data,
   is_sso_user, is_anonymous, created_at, updated_at)
values
  ('1707a000-0a70-4a70-8a70-000000000001', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.citizen@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"ผู้เรียนพลเมือง (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000002', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.lawyer@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"ทนายความ (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000003', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.instructor@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"ผู้สอน (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000004', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.staff.viewer@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"เจ้าหน้าที่ดูข้อมูล (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000005', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.staff.content@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"เจ้าหน้าที่เนื้อหา (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000006', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.staff.exam@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"เจ้าหน้าที่สอบ (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000007', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.staff.registrar@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"เจ้าหน้าที่ทะเบียน (UAT)"}'::jsonb,
   false, false, now(), now()),
  ('1707a000-0a70-4a70-8a70-000000000008', '00000000-0000-0000-0000-000000000000',
   '', 'authenticated', 'uat.admin@ltc.local', null, now(), '', '', '', '', '', '', '',
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"ผู้ดูแลระบบสูงสุด (UAT)"}'::jsonb,
   false, false, now(), now())
on conflict (id) do nothing;

-- รันซ้ำ: รีเซ็ตรหัสผ่าน + บังคับรูปแถว GoTrue อีกครั้ง (กันแถวจาก seed เวอร์ชันเก่า
-- ที่ aud='authenticated'/token เป็น NULL ค้างอยู่)
update auth.users
   set encrypted_password = (select hash from _uat_pw),
       email_confirmed_at = now(),
       banned_until = null, -- กัน ban ค้างจากการทดสอบของรอบก่อน (dcr13 — GoTrue ตัดสินที่คอลัมน์นี้)
       aud = '',
       confirmation_token = '', recovery_token = '', email_change = '',
       email_change_token_new = '', email_change_token_current = '',
       reauthentication_token = '', phone_change = '',
       is_sso_user = false, is_anonymous = false,
       created_at = coalesce(created_at, now()), -- แถวจาก seed รุ่นเก่าอาจเป็น NULL — GoTrue อ่านไม่ได้
       updated_at = now()
 where id::text like '1707a000-%';

-- == 2) ปรับ profiles ที่ trigger สร้างให้ (ชื่อไทยเต็ม · th) ==
update public.profiles
   set display_name = v.name, preferred_locale = 'th', is_active = true, deleted_at = null
  from (values
    ('1707a000-0a70-4a70-8a70-000000000001', 'ผู้เรียนพลเมือง (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000002', 'ทนายความ (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000003', 'ผู้สอน (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000004', 'เจ้าหน้าที่ดูข้อมูล (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000005', 'เจ้าหน้าที่เนื้อหา (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000006', 'เจ้าหน้าที่สอบ (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000007', 'เจ้าหน้าที่ทะเบียน (UAT)'),
    ('1707a000-0a70-4a70-8a70-000000000008', 'ผู้ดูแลระบบสูงสุด (UAT)')
  ) as v(id, name)
 where public.profiles.id = v.id::uuid;

-- == 3) บทบาท (citizen ได้จาก trigger แล้ว — แถวนี้เพื่อครบ/รันซ้ำได้) ==
insert into public.role_assignments (user_id, role, granted_by, reason) values
  ('1707a000-0a70-4a70-8a70-000000000001', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000002', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000002', 'lawyer',          null, 'UAT demo seed (license verified ใน seed)'),
  ('1707a000-0a70-4a70-8a70-000000000003', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000003', 'instructor',      null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000004', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000004', 'staff:viewer',    null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000005', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000005', 'staff:content',   null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000006', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000006', 'staff:exam',      null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000007', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000007', 'staff:registrar', null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000008', 'citizen',         null, 'UAT demo seed'),
  ('1707a000-0a70-4a70-8a70-000000000008', 'super_admin',     null, 'UAT demo seed')
on conflict do nothing;

-- == 4) ใบอนุญาตทนายของบัญชีทนาย (verified พร้อมใช้ — ให้เดินเส้นทางเรียน→สอบ→ใบประกาศได้ทันที)
--    เลขที่ 4321987 (7 หลัก) ผ่าน regex ^\d{6,9}$ ของ /me/license · อนุมัติโดย super_admin (UAT) ==
insert into public.lawyer_licenses
  (id, user_id, license_no, status, verified_by, verified_at, expires_on)
values
  ('1707a000-0a70-4a70-8a70-000000000095',
   '1707a000-0a70-4a70-8a70-000000000002',
   '4321987', 'verified', '1707a000-0a70-4a70-8a70-000000000008', now(),
   current_date + 365)
on conflict do nothing;

-- == 5) หมวดหลักสูตร UAT ==
insert into public.course_categories (id, slug, name_th, name_en, sort_order, is_active) values
  ('1707b000-0b70-4b70-8b70-000000000001', 'uat-demo', 'สาธิต UAT', 'UAT Demo', 90, true)
on conflict do nothing;

-- == 6) วิดีโอสาธิต (ไฟล์จริงอัปโหลดโดย scripts/uat-seed.sh ที่ path เดียวกัน) ==
insert into public.media_assets
  (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, duration_sec, status, uploaded_by) values
  ('1707b000-0b70-4b70-8b70-000000000002', 'supabase_storage', 'video', 'media',
   'courses/uat-intro/intro.mp4', 'video/mp4', 788493, 10, 'ready',
   '1707a000-0a70-4a70-8a70-000000000003')
on conflict do nothing;

-- == 7) หลักสูตร 3 หลักสูตร (สาธารณะ · ทนาย · ร่างรอ staff:content เผยแพร่) ==
insert into public.courses
  (id, code, category_id, created_by, title_th, title_en, summary, language, is_public,
   level, outcome_highlights, credit_type, status, version, published_at) values
  ('1707b000-0b70-4b70-8b70-000000000003', 'UAT-101',
   '1707b000-0b70-4b70-8b70-000000000001', '1707a000-0a70-4a70-8a70-000000000003',
   '[UAT] กฎหมายพื้นฐานสำหรับประชาชน', 'UAT Law Basics for Citizens',
   'หลักสูตรสาธิต UAT — เรียนวิดีโอ อ่านเอกสาร ทำควิซ จบในตัว (ไม่มีสอบปลายหลักสูตร)',
   'th', true, 'beginner',
   array['เข้าใจลำดับชั้นกฎหมายไทย', 'อ่านข้อกฎหมายเป็น'],
   'general', 'published', 1, now() - interval '2 days'),

  ('1707b000-0b70-4b70-8b70-000000000004', 'UAT-201',
   '1707b000-0b70-4b70-8b70-000000000001', '1707a000-0a70-4a70-8a70-000000000003',
   '[UAT] จริยธรรมทนายความ (มีสอบปลายหลักสูตร)', 'UAT Legal Ethics (with final exam)',
   'หลักสูตรสาธิต UAT สำหรับทนาย — เรียนครบแล้วสอบปลายหลักสูตร ผ่านแล้วรับใบประกาศ + 6 credit จริยธรรม',
   'th', false, 'beginner',
   array['รู้จักจรรยาบรรณทนายความ'],
   'ethics', 'published', 1, now() - interval '2 days'),

  ('1707b000-0b70-4b70-8b70-000000000005', 'UAT-DRAFT-001',
   '1707b000-0b70-4b70-8b70-000000000001', '1707a000-0a70-4a70-8a70-000000000003',
   '[UAT] หลักสูตรร่าง (รอเจ้าหน้าที่เนื้อหาเผยแพร่)', 'UAT Draft Course',
   'สถานะ draft — ผู้เรียนทั่วไปต้องยังมองไม่เห็น จนกว่า staff:content จะเผยแพร่ (สคริปต์ UAT-05)',
   'th', true, 'beginner', null,
   'general', 'draft', 1, null)
on conflict do nothing;

-- == 8) โมดูล ==
insert into public.course_modules (id, course_id, title_th, sort_order, is_preview) values
  ('1707b000-0b70-4b70-8b70-000000000006', '1707b000-0b70-4b70-8b70-000000000003', 'โมดูล 1 พื้นฐานกฎหมาย', 1, true),
  ('1707b000-0b70-4b70-8b70-000000000007', '1707b000-0b70-4b70-8b70-000000000004', 'โมดูล 1 จริยธรรมวิชาชีพ', 1, true),
  ('1707b000-0b70-4b70-8b70-000000000008', '1707b000-0b70-4b70-8b70-000000000005', 'โมดูล 1 ร่าง', 1, false)
on conflict do nothing;

-- == 9) ควิซท้ายบทของ UAT-101 ==
insert into public.lesson_quizzes (id, title, pass_pct, max_attempts, shuffle_questions, status) values
  ('1707b000-0b70-4b70-8b70-000000000021', 'ควิซท้ายบท [UAT] กฎหมายพื้นฐาน', 60, 3, true, 'active')
on conflict do nothing;

-- == 10) บทเรียน ==
insert into public.lessons
  (id, module_id, type, title_th, content_md, duration_sec, media_id, quiz_id, sort_order, is_preview) values
  -- UAT-101: วิดีโอ 10 วิ (จริง) → เอกสาร → ควิซ
  ('1707b000-0b70-4b70-8b70-000000000011', '1707b000-0b70-4b70-8b70-000000000006', 'video',
   'บทที่ 1 แนะนำหลักสูตร (วิดีโอ 10 วินาที)', null, 10,
   '1707b000-0b70-4b70-8b70-000000000002', null, 1, true),
  ('1707b000-0b70-4b70-8b70-000000000012', '1707b000-0b70-4b70-8b70-000000000006', 'document',
   'บทที่ 2 ลำดับชั้นของกฎหมายไทย (เอกสาร)',
   '# ลำดับชั้นของกฎหมายไทย' || chr(10) || chr(10) ||
   '1. รัฐธรรมนูญ — กฎหมายสูงสุดของประเทศ' || chr(10) ||
   '2. พระราชบัญญัติ / พระราชกฤษฎีกา' || chr(10) ||
   '3. กฎกระทรวง กฎ ระเบียบ ข้อบังคับ' || chr(10) ||
   '4. คำสั่งทางปกครองของหน่วยงานท้องถิ่น' || chr(10) || chr(10) ||
   '**ภารกิจ**: อ่านจบแล้วกดยืนยัน "อ่านจบแล้ว" ท้ายหน้า ระบบจะบันทึกว่าเรียนบทนี้เสร็จสมบูรณ์',
   null, null, null, 2, true),
  ('1707b000-0b70-4b70-8b70-000000000013', '1707b000-0b70-4b70-8b70-000000000006', 'quiz',
   'บทที่ 3 ควิซท้ายบท', null, null, null,
   '1707b000-0b70-4b70-8b70-000000000021', 3, false),
  -- UAT-201: เอกสาร → วิดีโอ
  ('1707b000-0b70-4b70-8b70-000000000014', '1707b000-0b70-4b70-8b70-000000000007', 'document',
   'บทที่ 1 จรรยาบรรณทนายความ (เอกสาร)',
   '# จรรยาบรรณทนายความ' || chr(10) || chr(10) ||
   'ทนายความต้องรักษาความลับของลูกความ ปฏิบัติต่อศาลด้วยความเคารพและเที่ยงธรรม ' ||
   'ไม่รับประโยชน์ที่ไม่ควรได้จากคู่ความ และไม่ทำลายหรือซ่อนเร้นพยานหลักฐาน' || chr(10) || chr(10) ||
   '**ภารกิจ**: อ่านจบแล้วกดยืนยัน "อ่านจบแล้ว" ท้ายหน้า',
   null, null, null, 1, true),
  ('1707b000-0b70-4b70-8b70-000000000015', '1707b000-0b70-4b70-8b70-000000000007', 'video',
   'บทที่ 2 วามรู้คู่ความ (วิดีโอ 10 วินาที)', null, 10,
   '1707b000-0b70-4b70-8b70-000000000002', null, 2, false),
  -- UAT-DRAFT: เอกสารเดียว
  ('1707b000-0b70-4b70-8b70-000000000016', '1707b000-0b70-4b70-8b70-000000000008', 'document',
   'บทที่ 1 เนื้อหาร่าง', '# เนื้อหาหลักสูตรร่าง [UAT]' || chr(10) || chr(10) || 'รอเผยแพร่โดยเจ้าหน้าที่เนื้อหา',
   null, null, null, 1, false)
on conflict do nothing;

-- == 11) ข้อควิซท้ายบท UAT-101 (2 ข้อ · ตัวเลือก 4 · เฉลยชัด) ==
insert into public.quiz_questions (id, quiz_id, question_text, type, explanation, points, sort_order, is_active) values
  ('1707b000-0b70-4b70-8b70-000000000031', '1707b000-0b70-4b70-8b70-000000000021',
   'กฎหมายใดมีลำดับชั้นสูงสุดในระบบกฎหมายไทย', 'single_choice', 'รัฐธรรมนูญเป็นกฎหมายสูงสุด', 1, 1, true),
  ('1707b000-0b70-4b70-8b70-000000000032', '1707b000-0b70-4b70-8b70-000000000021',
   'ผู้ถูกกล่าวหาว่ากระทำผิดถือว่าเป็นเช่นไร จนกว่าจะมีคำพิพากษาถึงที่สุด', 'single_choice',
   'หลักสันนิษฐานว่าบริสุทธิ์จนกว่าจะพิสูจน์ได้ว่าผิด', 1, 2, true)
on conflict do nothing;

insert into public.quiz_options (id, question_id, option_text, is_correct, sort_order) values
  ('1707b000-0b70-4b70-8b70-000000000041', '1707b000-0b70-4b70-8b70-000000000031', 'รัฐธรรมนูญ',    true,  1),
  ('1707b000-0b70-4b70-8b70-000000000042', '1707b000-0b70-4b70-8b70-000000000031', 'พระราชบัญญัติ', false, 2),
  ('1707b000-0b70-4b70-8b70-000000000043', '1707b000-0b70-4b70-8b70-000000000031', 'กฎกระทรวง',     false, 3),
  ('1707b000-0b70-4b70-8b70-000000000044', '1707b000-0b70-4b70-8b70-000000000031', 'ระเบียบ',        false, 4),
  ('1707b000-0b70-4b70-8b70-000000000045', '1707b000-0b70-4b70-8b70-000000000032', 'บริสุทธิ์',      true,  1),
  ('1707b000-0b70-4b70-8b70-000000000046', '1707b000-0b70-4b70-8b70-000000000032', 'ผิดทันทีที่ถูกกล่าวหา', false, 2),
  ('1707b000-0b70-4b70-8b70-000000000047', '1707b000-0b70-4b70-8b70-000000000032', 'ต้องพิสูจน์ว่าบริสุทธิ์เอง', false, 3),
  ('1707b000-0b70-4b70-8b70-000000000048', '1707b000-0b70-4b70-8b70-000000000032', 'ไม่มีข้อใดถูก',  false, 4)
on conflict do nothing;

-- == 12) ข้อสอบปลายหลักสูตร UAT-201 + กติกา + ธนาคารข้อสอบ ==
--    ผ่าน 60% (ตอบถูก 2/3 = 67% ผ่าน · 1/3 = 33% ไม่ผ่าน) · คูลดาวน์ 30 นาทีตามจริง
insert into public.assessments
  (id, course_id, code, title, description, is_final, status, published_at) values
  ('1707b000-0b70-4b70-8b70-000000000051', '1707b000-0b70-4b70-8b70-000000000004',
   'EXAM-UAT-201', 'ข้อสอบปลายหลักสูตร [UAT] จริยธรรมทนายความ',
   'สอบ 3 ข้อ ใน 15 นาที ผ่านที่ 60% — ผ่านแล้วเข้าเกณฑ์รับใบประกาศ (สคริปต์ UAT-02)',
   true, 'published', now() - interval '1 day')
on conflict do nothing;

insert into public.assessment_rules
  (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
   attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection, require_course_complete,
   proctoring_mode, effective_from) values
  ('1707b000-0b70-4b70-8b70-000000000052', '1707b000-0b70-4b70-8b70-000000000051',
   1, 15, 3, 60, 3, 30, true, true,
   '{"bank_ids":["1707b000-0b70-4b70-8b70-000000000053"]}'::jsonb,
   true, 'basic', now() - interval '1 day')
on conflict do nothing;

insert into public.question_banks
  (id, code, name, created_by, course_id, description, is_active) values
  ('1707b000-0b70-4b70-8b70-000000000053', 'QB-UAT-201', 'ธนาคารข้อสอบ [UAT] จริยธรรมทนายความ',
   '1707a000-0a70-4a70-8a70-000000000003', '1707b000-0b70-4b70-8b70-000000000004',
   'UAT demo bank — 3 ข้อ active + 1 ข้อ draft', true)
on conflict do nothing;

-- ข้อสอบ 4 ข้อ: insert เป็น draft → activate 3 ข้อหลัง insert options (ขั้น 13)
-- (แบบแผนเดียวกับ dev seed: guard_question_activation ต้องการตัวเลือกครบก่อน
--  และผู้เปิดต้องเป็น staff:exam — เจ้าหน้าที่สอบ (UAT) คือผู้เปิดในที่นี้)
drop table if exists seed_new_questions;
create temp table seed_new_questions (id uuid not null primary key);
with ins as (
  insert into public.questions
    (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version) values
    ('1707b000-0b70-4b70-8b70-000000000061', '1707b000-0b70-4b70-8b70-000000000053', 'single_choice', 'easy',
     'ตามจรรยาบรรณทนายความ ทนายความต้องรักษาสิ่งใดของลูกความ', 'ต้องรักษาความลับของลูกความ', 1, 'draft',
     array['ethics'], '1707a000-0a70-4a70-8a70-000000000003', 1),
    ('1707b000-0b70-4b70-8b70-000000000062', '1707b000-0b70-4b70-8b70-000000000053', 'single_choice', 'easy',
     'ทนายความพึงปฏิบัติต่อศาลอย่างไร', 'เคารพและเที่ยงธรรมต่อศาล', 1, 'draft',
     array['ethics'], '1707a000-0a70-4a70-8a70-000000000003', 1),
    ('1707b000-0b70-4b70-8b70-000000000063', '1707b000-0b70-4b70-8b70-000000000053', 'single_choice', 'easy',
     'การโฆษณาตัวของทนายความที่ไม่เหมาะสม ได้แก่ ข้อใด', 'ห้ามอวดอ้างผลคดีว่าชนะแน่นอน', 1, 'draft',
     array['ethics'], '1707a000-0a70-4a70-8a70-000000000003', 1),
    ('1707b000-0b70-4b70-8b70-000000000064', '1707b000-0b70-4b70-8b70-000000000053', 'single_choice', 'medium',
     'ข้อร่าง (ไม่นับใน question_count)', null, 1, 'draft',
     array['ethics'], '1707a000-0a70-4a70-8a70-000000000003', 1)
  on conflict do nothing
  returning id
)
insert into seed_new_questions select id from ins
 where id <> '1707b000-0b70-4b70-8b70-000000000064'; -- ข้อ 0064 คง draft → สอบใช้จริง 3 ข้อ

insert into public.question_options (id, question_id, option_text, is_correct, sort_order) values
  ('1707b000-0b70-4b70-8b70-000000000071', '1707b000-0b70-4b70-8b70-000000000061', 'ความลับ', true,  1),
  ('1707b000-0b70-4b70-8b70-000000000072', '1707b000-0b70-4b70-8b70-000000000061', 'โทรศัพท์มือถือ', false, 2),
  ('1707b000-0b70-4b70-8b70-000000000073', '1707b000-0b70-4b70-8b70-000000000061', 'รถยนต์', false, 3),
  ('1707b000-0b70-4b70-8b70-000000000074', '1707b000-0b70-4b70-8b70-000000000061', 'เฟอร์นิเจอร์สำนักงาน', false, 4),
  ('1707b000-0b70-4b70-8b70-000000000075', '1707b000-0b70-4b70-8b70-000000000062', 'เคารพและเที่ยงธรรม', true,  1),
  ('1707b000-0b70-4b70-8b70-000000000076', '1707b000-0b70-4b70-8b70-000000000062', 'ข่มขู่ผู้พิพากษา', false, 2),
  ('1707b000-0b70-4b70-8b70-000000000077', '1707b000-0b70-4b70-8b70-000000000062', 'ปิดบังข้อเท็จจริง', false, 3),
  ('1707b000-0b70-4b70-8b70-000000000078', '1707b000-0b70-4b70-8b70-000000000062', 'ชักชวนพยานให้เบิ้ลปาก', false, 4),
  ('1707b000-0b70-4b70-8b70-000000000079', '1707b000-0b70-4b70-8b70-000000000063', 'อวดอ้างว่าชนะคดีแน่นอน', true,  1),
  ('1707b000-0b70-4b70-8b70-000000000080', '1707b000-0b70-4b70-8b70-000000000063', 'แจ้งชื่อสำนักงานตามจริง', false, 2),
  ('1707b000-0b70-4b70-8b70-000000000081', '1707b000-0b70-4b70-8b70-000000000063', 'ระบุตำแหน่งตามที่สภาทนายความรับรอง', false, 3),
  ('1707b000-0b70-4b70-8b70-000000000082', '1707b000-0b70-4b70-8b70-000000000063', 'ให้ข้อมูลการติดต่อถูกต้อง', false, 4)
on conflict do nothing;

-- == 13) เปิดใช้งานข้อสอบ 3 ข้อ (ทางการ — guard_question_activation โดย staff:exam (UAT)) ==
--    ต้องตั้ง "สอง" GUC (แบบแผนเดียวกับ seed.sql — image supabase/postgres ของ auth.uid()
--    อ่าน request.jwt.claim.sub แบบแยกฟิลด์) — ตั้งตัวเดียว = auth.uid() null → guard ปฏิเสธ
set local "request.jwt.claims" = '{"sub":"1707a000-0a70-4a70-8a70-000000000006","role":"authenticated"}';
set local "request.jwt.claim.sub" = '1707a000-0a70-4a70-8a70-000000000006';
update public.questions q set status = 'active'
  from seed_new_questions n
 where q.id = n.id; -- เฉพาะข้อที่ INSERT ใหม่จริงในรอบนี้ (ไม่ปลุกแถวที่ staff ปิดไว้)

-- == 14) กฎ credit (UAT-101 = 9.00 general · UAT-201 = 6.00 ethics) ==
insert into public.credit_rules
  (id, code, name, course_id, credit_type, credits, valid_days, carry_over, priority,
   effective_from, effective_to, status, renewal_cycle) values
  ('1707b000-0b70-4b70-8b70-000000000091', 'CR-UAT-101', 'หลักสูตร UAT-101 ให้ 9.00 credit',
   '1707b000-0b70-4b70-8b70-000000000003', 'general', 9.00, 365, true, 10,
   now() - interval '30 days', null, 'active', 'annual'),
  ('1707b000-0b70-4b70-8b70-000000000092', 'CR-UAT-201', 'หลักสูตร UAT-201 ให้ 6.00 credit จริยธรรม',
   '1707b000-0b70-4b70-8b70-000000000004', 'ethics', 6.00, 365, false, 20,
   now() - interval '30 days', null, 'active', 'annual')
on conflict do nothing;

-- == 15) สรุปให้ผู้รันเห็น (ไม่พิมพ์รหัสผ่าน) ==
\echo '== UAT seed: บัญชี demo (อีเมล · บทบาท · MFA ที่ต้องลงทะเบียนหลังล็อกอินครั้งแรก) =='
select p.email,
       (select string_agg(ra.role::text, ', ' order by ra.role)
          from public.role_assignments ra where ra.user_id = p.id) as roles,
       u.encrypted_password is not null as password_set
  from public.profiles p
  join auth.users u on u.id = p.id
 where p.id::text like '1707a000-%'
 order by p.id;

\echo '== UAT seed: หลักสูตร/ข้อสอบ =='
select c.code, c.title_th, c.status, c.is_public,
       (select count(*) from public.lessons l
          join public.course_modules m on m.id = l.module_id
         where m.course_id = c.id) as lessons,
       (select count(*) from public.questions q
          join public.question_banks b on b.id = q.bank_id
         where b.course_id = c.id and q.status = 'active') as active_exam_questions
  from public.courses c
 where c.id::text like '1707b000-%'
 order by c.code;

\echo '== UAT seed: ตรวจสอบเพิ่ม =='
select
  (select count(*) from auth.users where id::text like '1707a000-%') as demo_users,
  (select count(*) from public.lawyer_licenses where user_id = '1707a000-0a70-4a70-8a70-000000000002'
     and status = 'verified') as lawyer_license_verified,
  (select count(*) from public.questions where bank_id = '1707b000-0b70-4b70-8b70-000000000053'
     and status = 'active') as bank_active_questions,
  (select count(*) from public.credit_rules where code in ('CR-UAT-101','CR-UAT-201')
     and status = 'active') as active_credit_rules;

commit;

\echo 'UAT seed เสร็จสมบูรณ์ — รหัสผ่านชุดเดียวกันทุกบัญชี (ดูจาก scripts/uat-seed.sh ที่พิมพ์ให้แล้ว)'
