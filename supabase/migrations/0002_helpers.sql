-- 0002_helpers.sql
-- ที่มา: RBAC-DESIGN.md §3.1 + DD §1

set check_function_bodies = off; -- role_assignments ถูกสร้างใน 0003 (forward reference)

-- SECURITY DEFINER functions (owner = app_owner) เรียก auth.uid() ได้
-- Supabase ให้ USAGE บน schema auth เฉพาะ anon/authenticated/service_role — role ที่เราสร้างเองต้อง grant เพิ่ม
grant usage on schema auth to app_owner;

create or replace function public.my_roles() returns text[]
language sql stable security definer
set search_path = public
as $$
  select coalesce(array_agg(role::text), '{}')
  from public.role_assignments
  where user_id = auth.uid() and revoked_at is null;
$$;

create or replace function public.has_any_role(roles text[]) returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.my_roles() && roles;
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_any_role(array['staff:viewer','staff:content',
                                  'staff:exam','staff:registrar','super_admin']);
$$;

revoke execute on function public.my_roles() from public, anon;
revoke execute on function public.has_any_role(text[]) from public, anon;
revoke execute on function public.is_staff() from public, anon;
grant execute on function public.my_roles() to anon, authenticated, service_role;
grant execute on function public.has_any_role(text[]) to anon, authenticated, service_role;
grant execute on function public.is_staff() to anon, authenticated, service_role;
