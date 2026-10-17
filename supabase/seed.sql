-- ====================================================================
-- LTC E-Learning & Credit Bank — Supabase Seed Data
-- ====================================================================

-- 1. Insert Initial Courses
INSERT INTO public.courses (
    id, code, title, subtitle, category, target_audience, credits, duration_hours, 
    passing_score_percent, cover_image, instructor_name, instructor_title, 
    instructor_avatar, description, is_mandatory_for_renewal, has_exam, status, 
    enrolled_count, rating
) VALUES 
(
    '00000000-0000-0000-0000-000000000001',
    'CLE-ETH-101',
    'จริยธรรมและมรรยาททนายความ 2569 (วิชาบังคับ)',
    'หลักจริยธรรมแห่งวิชาชีพและข้อบังคับสภาทนายความว่าด้วยมรรยาททนายความ พ.ศ. 2529 และฉบับแก้ไขเพิ่มเติม',
    'ethics',
    'lawyer',
    6,
    6.0,
    75,
    'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&w=800&q=80',
    'ศ.ดร. นันทิวัฒน์ ธรรมาภิบาล',
    'ผู้เชี่ยวชาญด้านมรรยาทวิชาชีพทนายความ สภาทนายความฯ',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=250&q=80',
    'หลักสูตรภาคบังคับสำหรับการต่อใบอนุญาตว่าความ มุ่งเน้นการปฏิบัติตนตามมรรยาทวิชาชีพ ความรับผิดชอบต่อลูกความ ศาล และเพื่อนร่วมวิชาชีพ',
    true,
    true,
    'published',
    1420,
    4.90
),
(
    '00000000-0000-0000-0000-000000000002',
    'CLE-TECH-204',
    'พระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล (PDPA) สำหรับที่ปรึกษากฎหมาย',
    'การตรวจร่างสัญญา Data Processing Agreement (DPA), การประเมิน DPIA และการรับมือเหตุการณ์ข้อมูลรั่วไหล',
    'emerging_tech',
    'lawyer',
    4,
    4.0,
    75,
    'https://images.unsplash.com/photo-1563986768609-322da13575f3?auto=format&fit=crop&w=800&q=80',
    'ดร.พงษ์ศักดิ์ นิติดิจิทัล',
    'กรรมการผู้ทรงคุณวุฒิด้านคุ้มครองข้อมูลส่วนบุคคล',
    'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=250&q=80',
    'หลักสูตรเจาะลึกบทบาทนักกฎหมายในการให้คำปรึกษาองค์กรภาคธุรกิจเกี่ยวกับการปฏิบัติตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562',
    false,
    true,
    'published',
    980,
    4.80
),
(
    '00000000-0000-0000-0000-000000000003',
    'PUB-LAW-001',
    'กฎหมายมรดกและการทำพินัยกรรมเบื้องต้นสำหรับประชาชน',
    'ความรู้พื้นฐานเรื่องสิทธิของทายาทโดยธรรม การแบ่งมรดก และวิธีเขียนพินัยกรรมให้ถูกต้องสมบูรณ์ตามกฎหมาย',
    'public_law',
    'all',
    2,
    3.0,
    70,
    'https://images.unsplash.com/photo-1450133064473-71024230f91b?auto=format&fit=crop&w=800&q=80',
    'อาจารย์กมลชนก นิติมงคล',
    'นักวิชาการกฎหมายแพ่ง สภาทนายความฯ',
    'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&w=250&q=80',
    'หลักสูตรเพื่อการเผยแพร่ความรู้ทางกฎหมายแก่ประชาชนทั่วไป เพื่อให้เข้าใจขั้นตอนการแบ่งทรัพย์มรดก',
    false,
    true,
    'published',
    3250,
    4.85
)
ON CONFLICT (id) DO NOTHING;

-- 2. Insert Sample Certificates
INSERT INTO public.certificates (
    certificate_number, course_id, course_title, user_id, user_name, 
    lawyer_license_number, credits_awarded, issue_date, status, signature_registrar
) VALUES
(
    'LTC-2025-CLE-04821',
    '00000000-0000-0000-0000-000000000002',
    'พระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล (PDPA) สำหรับที่ปรึกษากฎหมาย',
    '00000000-0000-0000-0000-000000000099',
    'ทนายวิชัย นิติกรชัย',
    '4521/2561',
    4,
    '2025-11-15',
    'valid',
    'คุณกาญจนา นิติการ (นายทะเบียน)'
)
ON CONFLICT (certificate_number) DO NOTHING;
