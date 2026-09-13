-- ═══ 0041 — admin_list_users v2: สถานะแบนของ GoTrue (Wave F · D-f-5 · [#91]) ════
-- ADM-002: หน้ารายชื่อผู้ใช้ไม่บอกว่าบัญชีถูกระงะ (PATCH /admin/users/{id} แบน
-- ผ่าน GoTrue `banned_until` 876000h มาตั้งแต่ Wave E) — v2 เพิ่มคอลัมน์ additive
--   `is_banned`    (boolean) = banned_until ยังไม่หมดอายุ (แบนหมดอายุ = false)
--   `banned_until` (timestamptz | null) = ค่าจริงจาก auth.users (ตรวจย้อนหลัง)
-- สัญญาเดิม (0035 §7 + 0037 cast-fix) คงทุกฟิลด์ — เพิ่ม 2 คอลัมน์ท้ายแถวเท่านั้น
-- สิทธิ์: SECURITY DEFINER (owner app_owner) อ่าน auth.users แค่ 2 คอลัมน์ผ่าน
-- column-level grant — ไม่เปิดขอบเขตอื่นของ auth schema เลย
-- หมายเหตุ: auth.users ไม่มีคอลัมน์ banned_at (ตรวจ DB จริง) — "เคยถูกแบนแล้ว
-- ครบกำหนด" ดูได้จาก banned_until ที่ยังค้างค่าในอดีต (is_banned=false)

-- ── column-level grant ให้ app_owner อ่านสถานะแบน (ก่อนฟังก์ชันใช้จริง) ────────
-- auth.users เปิด RLS (เจ้าของ supabase_auth_admin) — SECURITY DEFINER ของ
-- app_owner ไม่ bypass RLS ต้องมี policy คู่กัน ไม่งั้น join เห็น 0 แถวเงียบ ๆ
grant select (id, banned_until) on auth.users to app_owner;
do $do$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'auth' and tablename = 'users'
                    and policyname = 'ltc_app_owner_read_ban') then
    execute 'create policy ltc_app_owner_read_ban on auth.users for select to app_owner using (true)';
  end if;
end
$do$;

create or replace function public.admin_list_users(
  p_query text,
  p_status text,               -- 'active' | 'deleted' | null (ทุกสถานะ)
  p_cursor_created_at timestamptz,
  p_cursor_id uuid,
  p_limit int
) returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_actor uuid := public.admin_users_staff_guard();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_q text;
  v_rows jsonb;
  v_has_more boolean;
begin
  v_q := nullif(btrim(coalesce(p_query, '')), '');
  if v_q is not null and length(v_q) > 100 then
    raise exception 'ข้อมูลไม่ถูกต้อง: คำค้นยาวเกิน 100 อักขระ (ERR-VAL-001|query_length)'
      using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('active', 'deleted') then
    raise exception 'ข้อมูลไม่ถูกต้อง: status ต้องเป็น active/deleted (ERR-VAL-001|status_value)'
      using errcode = '22023';
  end if;

  -- has_more จากแถวเกิน (limit+1) หลัง aggregation — ห้าม count(*) over () ร่วมกับ
  -- jsonb_agg ใน SELECT เดียว (window คำนวณหลัง aggregate = ได้ 1 เสมอ — บทเรียน 0032)
  -- 0041: left join auth.users (1:1 ต่อ profile) — คอลัมน์แบนต้องรวมใต้ group by p.id
  --   ด้วย aggregate เช่นกัน (functional dependency ครอบเฉพาะ PK ของ profiles)
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    into v_rows
  from (
    select p.id,
           p.display_name,
           p.email,
           p.deleted_at,
           p.created_at,
           -- 0037: cast array_agg(enum) → text[] ก่อน coalesce (เดิม coalesce กับ
           -- array[]::text[] ตรง ๆ = 42846 plan-time error ทุก call)
           coalesce((array_agg(ra.role order by ra.role)
                    filter (where ra.role is not null and ra.revoked_at is null))::text[],
                    array[]::text[]) as roles,
           exists (select 1 from public.lawyer_licenses ll
                   where ll.user_id = p.id and ll.status = 'verified'
                     and ll.revoked_at is null and ll.deleted_at is null) as has_verified_license,
           -- 0041: สถานะแบน GoTrue — bool_or/max เพราะแถวรวมหลาย role_assignment
           bool_or(au.banned_until is not null and au.banned_until > now())
             as is_banned,
           max(au.banned_until) as banned_until
      from public.profiles p
      left join public.role_assignments ra on ra.user_id = p.id
      left join auth.users au on au.id = p.id
     where (v_q is null
            or p.display_name ilike v_q || '%'
            or p.email ilike v_q || '%')
       and (p_status is null
            or (p_status = 'active' and p.deleted_at is null)
            or (p_status = 'deleted' and p.deleted_at is not null))
       and (p_cursor_created_at is null
            or (p.created_at, p.id) < (p_cursor_created_at, p_cursor_id))
     group by p.id
     order by p.created_at desc, p.id desc
     limit v_limit + 1
  ) t;

  v_has_more := jsonb_array_length(v_rows) > v_limit;
  if v_has_more then
    v_rows := v_rows - (jsonb_array_length(v_rows) - 1); -- ตัดแถวสุดท้าย (แถวเกินโควตา — เรียง desc)
  end if;

  return jsonb_build_object(
    'data', v_rows,
    'nextCursor', case when coalesce(v_has_more, false) and jsonb_array_length(v_rows) > 0
                       then jsonb_build_object(
                              'createdAt', (v_rows -> jsonb_array_length(v_rows) - 1) ->> 'created_at',
                              'id', (v_rows -> jsonb_array_length(v_rows) - 1) ->> 'id')
                       else null end);
end;
$fn$;
alter function public.admin_list_users(text, text, timestamptz, uuid, int) owner to app_owner;
revoke execute on function public.admin_list_users(text, text, timestamptz, uuid, int) from public, anon;
grant execute on function public.admin_list_users(text, text, timestamptz, uuid, int) to authenticated;
