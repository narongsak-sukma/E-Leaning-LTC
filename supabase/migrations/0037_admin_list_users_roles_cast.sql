-- 0037 — hotfix: admin_list_users พังที่ plan time (42846) จาก coalesce type mismatch
-- ─────────────────────────────────────────────────────────────────────────────
-- อาการ: /api/v1/admin/users?limit=20 → 503 ทุกคำขอ (e2e-16 t1 fail ทุกรอบ)
-- เบื้องหลัง: RPC เรียกโดย user-JWT แล้ว PostgREST ตอบ
--   42846 "COALESCE could not convert type text[] to role_key[]"
-- เหตุ: 0035 §7 รวมบทบาทด้วย `coalesce(array_agg(ra.role …) filter …, array[]::text[])`
--   — role_assignments.role เป็น enum role_key[] หลัง array_agg → coalesce กับ text[]
--   ไม่ได้ (plan-time error เกิดก่อน guard/ทุกแถว) — เทียบแบบแผนที่ถูกอยู่แล้วของ
--   0002:14 / 0008:331 ที่ aggregate ค่า cast เป็น text ก่อน
-- แก้: cast ผล array_agg เป็น text[] ก่อน coalesce — ขาออก jsonb ยังเป็น string array
--   เหมือนเดิมทุกประการ (สัญญา route/zod ไม่เปลี่ยน)
-- พิสูจน์แล้วกับ DB จริง: ก่อนแก้ 400/42846 · หลังแก้ 200 + แถวตาม limit
-- (create or replace ทั้งฟังก์ชัน — เนื้ออื่นคงเดิมทุกบรรทัดตาม 0035 §7)

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
                     and ll.revoked_at is null and ll.deleted_at is null) as has_verified_license
      from public.profiles p
      left join public.role_assignments ra on ra.user_id = p.id
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
