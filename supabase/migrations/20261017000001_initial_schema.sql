-- ====================================================================
-- LTC E-Learning & Credit Bank — Supabase PostgreSQL Schema Migration
-- สภาทนายความ ในพระบรมราชูปถัมภ์ (Lawyers Council of Thailand)
-- Architecture: 100% Cloud (Vercel Frontend + Supabase Backend/Auth)
-- Standards: OWASP ASVS L2, PDPA, Append-only Audit, RLS on every table
-- ====================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Custom ENUM Types
DO $$ BEGIN
    CREATE TYPE user_role_enum AS ENUM (
        'guest',
        'citizen',
        'lawyer',
        'instructor',
        'staff:viewer',
        'staff:content',
        'staff:exam',
        'staff:registrar',
        'super_admin'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE license_status_enum AS ENUM (
        'unregistered',
        'pending',
        'verified',
        'suspended',
        'revoked'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE course_category_enum AS ENUM (
        'ethics',
        'substantive',
        'procedural',
        'emerging_tech',
        'public_law',
        'labor_tax'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE target_audience_enum AS ENUM (
        'all',
        'citizen',
        'lawyer'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. Profiles Table (Extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    avatar_url TEXT,
    citizen_id TEXT, -- Masked/encrypted according to PDPA
    lawyer_license_number TEXT UNIQUE, -- e.g. "4521/2561"
    license_status license_status_enum NOT NULL DEFAULT 'unregistered',
    license_expiry_date DATE,
    credits_earned INTEGER NOT NULL DEFAULT 0,
    credits_required INTEGER NOT NULL DEFAULT 30,
    current_cycle TEXT DEFAULT 'รอบปี 2568 - 2570',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. User Roles Table (RBAC Matrix — Multi-role support)
CREATE TABLE IF NOT EXISTS public.user_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role user_role_enum NOT NULL DEFAULT 'citizen',
    granted_by UUID REFERENCES public.profiles(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    revoked_at TIMESTAMPTZ,
    UNIQUE(user_id, role)
);

-- 5. Courses Table
CREATE TABLE IF NOT EXISTS public.courses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code TEXT NOT NULL UNIQUE, -- e.g. "CLE-ETH-101"
    title TEXT NOT NULL,
    subtitle TEXT,
    category course_category_enum NOT NULL DEFAULT 'substantive',
    target_audience target_audience_enum NOT NULL DEFAULT 'lawyer',
    credits INTEGER NOT NULL DEFAULT 4,
    duration_hours NUMERIC(4, 1) NOT NULL DEFAULT 4.0,
    passing_score_percent INTEGER NOT NULL DEFAULT 75,
    cover_image TEXT,
    instructor_name TEXT NOT NULL,
    instructor_title TEXT,
    instructor_avatar TEXT,
    description TEXT,
    is_mandatory_for_renewal BOOLEAN NOT NULL DEFAULT false,
    has_exam BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'published', -- draft, published, archived
    enrolled_count INTEGER NOT NULL DEFAULT 0,
    rating NUMERIC(3, 2) NOT NULL DEFAULT 5.0,
    created_by UUID REFERENCES public.profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 6. Course Modules & Lessons Table
CREATE TABLE IF NOT EXISTS public.course_modules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.lessons (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    module_id UUID NOT NULL REFERENCES public.course_modules(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 45,
    video_url TEXT NOT NULL,
    summary TEXT,
    content_pdf_url TEXT,
    order_index INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 7. Enrollments Table
CREATE TABLE IF NOT EXISTS public.enrollments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    completed_lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
    exam_score INTEGER,
    exam_passed BOOLEAN DEFAULT false,
    status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress, completed
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    completed_at TIMESTAMPTZ,
    certificate_id UUID,
    UNIQUE(user_id, course_id)
);

-- 8. Question Bank Table
CREATE TABLE IF NOT EXISTS public.question_bank (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    options JSONB NOT NULL, -- Array of {id, text}
    correct_option_id TEXT NOT NULL,
    explanation TEXT NOT NULL,
    legal_reference TEXT,
    created_by UUID REFERENCES public.profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 9. Certificates Table (Verifiable Public Registry)
CREATE TABLE IF NOT EXISTS public.certificates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    certificate_number TEXT NOT NULL UNIQUE, -- e.g. "LTC-2026-CLE-8842"
    course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT,
    course_title TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    user_name TEXT NOT NULL,
    lawyer_license_number TEXT,
    credits_awarded INTEGER NOT NULL DEFAULT 0,
    issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'valid', -- valid, revoked
    signature_registrar TEXT NOT NULL DEFAULT 'คุณกาญจนา นิติการ (นายทะเบียน)',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 10. Credit Ledger Table (Immutable Financial/Accreditation Ledger)
CREATE TABLE IF NOT EXISTS public.credit_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    course_id UUID REFERENCES public.courses(id),
    course_title TEXT NOT NULL,
    category course_category_enum NOT NULL,
    credits INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'course_cle', -- course_cle, seminar, registrar_adjustment
    certificate_number TEXT REFERENCES public.certificates(certificate_number),
    approved_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 11. Audit Logs Table (Append-Only per AUDIT-LOG-DESIGN.md)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    user_role TEXT NOT NULL,
    action TEXT NOT NULL,
    target_resource TEXT NOT NULL,
    ip_address TEXT,
    status TEXT NOT NULL DEFAULT 'SUCCESS',
    details TEXT NOT NULL
);

-- ====================================================================
-- IMMUTABILITY SECURITY TRIGGERS (AUDIT & CREDIT LEDGER)
-- ====================================================================

-- Prevent any UPDATE or DELETE on audit_logs
CREATE OR REPLACE FUNCTION public.prevent_audit_log_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'PDPA/Security Violation: Audit logs are immutable and cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_audit_logs
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_tampering();

-- Prevent any UPDATE or DELETE on credit_ledger
CREATE OR REPLACE FUNCTION public.prevent_credit_ledger_tampering()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Accreditation Violation: Credit ledger entries are immutable. Adjustments must be made via new credit entries.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_credit_ledger
BEFORE UPDATE OR DELETE ON public.credit_ledger
FOR EACH ROW EXECUTE FUNCTION public.prevent_credit_ledger_tampering();

-- ====================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES ON EVERY TABLE
-- ====================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 1. Profiles Policies
CREATE POLICY "Public profiles are readable by authenticated users" 
ON public.profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can update own profile" 
ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- 2. User Roles Policies
CREATE POLICY "Users can read own roles" 
ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- 3. Courses Policies
CREATE POLICY "Public can view published courses" 
ON public.courses FOR SELECT USING (status = 'published');

CREATE POLICY "Staff can manage all courses" 
ON public.courses FOR ALL TO authenticated USING (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('staff:content', 'super_admin')
    )
);

-- 4. Course Modules & Lessons Policies
CREATE POLICY "Public can view modules for published courses" 
ON public.course_modules FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.courses WHERE id = course_id AND status = 'published')
);

CREATE POLICY "Public can view lessons for published courses" 
ON public.lessons FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.courses WHERE id = course_id AND status = 'published')
);

-- 5. Enrollments Policies
CREATE POLICY "Users can view and manage own enrollments" 
ON public.enrollments FOR ALL TO authenticated USING (auth.uid() = user_id);

-- 6. Question Bank Policies
CREATE POLICY "Exam staff and instructors can view and manage questions" 
ON public.question_bank FOR ALL TO authenticated USING (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('staff:exam', 'instructor', 'super_admin')
    )
);

-- 7. Certificates Policies
CREATE POLICY "Public can verify valid certificates" 
ON public.certificates FOR SELECT USING (status = 'valid');

CREATE POLICY "Registrar can issue certificates" 
ON public.certificates FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('staff:registrar', 'super_admin')
    )
);

-- 8. Credit Ledger Policies
CREATE POLICY "Lawyers can view own credit ledger" 
ON public.credit_ledger FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Registrar can append to credit ledger" 
ON public.credit_ledger FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role IN ('staff:registrar', 'super_admin')
    )
);

-- 9. Audit Logs Policies
CREATE POLICY "Super Admins can view audit logs" 
ON public.audit_logs FOR SELECT TO authenticated USING (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role = 'super_admin'
    )
);

CREATE POLICY "System can append audit logs" 
ON public.audit_logs FOR INSERT TO authenticated WITH CHECK (true);
