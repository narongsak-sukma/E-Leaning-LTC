-- ═════════════════════════════════════════════════════════════════════════════
-- 0046_gate_r2_security_fixes.sql — ปิด findings ของ CTO gate r2 (codex FAIL)
--   G1 (HIGH) stash ciphertext re-hosting: ผู้ถือ uuid ขโมย ciphertext จาก take
--          แล้ว re-host เป็นแถวของตัวเอง (TTL ใหม่ + รอดการ consume ของเจ้าของ)
--          → เข้ารหัสแบบ **bind กับเจ้าของแถว+deadline**: แอปใช้ AAD ของ
--          AES-256-GCM = `${user_id}:${deadline_unix_sec}` — user_id มาจาก
--          auth.uid() ที่ create (ปลอมไม่ได้) · deadline มาจากแถวเอง (expires_at
--          เป็นค่าที่แอปส่งมาและ RPC ตรวจกรอบแล้ว เก็บ as-is) — สำเนาที่ re-host
--          ไปแถวของคนอื่น GCM auth ไม่ผ่าน → ถอดไม่ได้ · take คืน jsonb
--          {payload, user_id, expires_at} ให้แอปประกอบ AAD จากแถวจริงเสมอ
--   G3 (MED) consume fail-open + ไม่ตรวจ deadline ณ ตอน consume:
--          UPDATE เพิ่ม `and expires_at > now()` (take→verify→consume ช้ากว่า
--          deadline = แถวตายแม้ take ผ่านตอนแรก) · ฝั่งแอปเปลี่ยน consume
--          คืน boolean และ caller gate การออก session (mfa-actions.ts — fail-closed)
--   G4 (MED) invalidate ไม่ถือ advisory lock + replace ตรวจ factor นอก lock:
--          invalidate ถือ lock เดียวกับ replace (`mfa_backup_codes:<user>`) ·
--          การตรวจ factor-verified ของ replace ย้ายเข้าใต้ lock — invalidate/
--          replace แข่งกันจบด้วย "โค้ดตายทั้งชุดเสมอ" ไม่มีทางเหลือโค้ดใช้ได้
--          หลังปิด MFA
--
-- แบบแผนเดียวกับ 0045: ห้ามแก้ migration ที่ apply แล้ว — รอบแก้ใหม่ = ไฟล์ใหม่
-- ═════════════════════════════════════════════════════════════════════════════

-- ── G4a: replace — ตรวจ factor-verified "ใต้" advisory lock ──────────────────
-- (เดิมตรวจก่อนขอ lock: invalidate ของการปิด MFA วิ่งสอดแทรกระหว่างสองขั้นนั้น
-- ได้ — replace เห็น factor ยัง verified แล้ว INSERT โค้ดชุดใหม่หลัง invalidate
-- ลบชุดเก่าไปแล้ว = เหลือโค้ดใช้ได้บนบัญชีที่ปิด MFA ไปแล้ว)
create or replace function public.mfa_backup_codes_replace(p_hashes text[])
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_n int;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  -- F1: การออกชุดโค้ดใหม่คือการเปลี่ยนข้อมูลรับรอง — บังคับ aal2 ที่ตัว RPC
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') <> 'aal2' then
    raise exception 'ต้องยืนยันตัวตนสองชั้นก่อนดำเนินการ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  v_n := coalesce(array_length(p_hashes, 1), 0);
  if v_n < 8 or v_n > 12 then
    raise exception 'ข้อมูลไม่ถูกต้อง: ต้องส่ง hash 8-12 ค่า (ERR-VAL-001|hash_count)'
      using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_hashes) h where h is null or h !~ '^[0-9a-f]{64}$') then
    raise exception 'ข้อมูลไม่ถูกต้อง: hash ต้องเป็น hex 64 อักขระ (ERR-VAL-001|hash_format)'
      using errcode = '22023';
  end if;
  if (select count(distinct h) from unnest(p_hashes) h) <> v_n then
    raise exception 'ข้อมูลไม่ถูกต้อง: hash ซ้ำในชุด (ERR-VAL-001|hash_duplicate)'
      using errcode = '22023';
  end if;

  -- F6: serialize ต่อผู้ใช้ — invalidate (การปิด MFA) ถือ lock เดียวกัน
  perform pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || v_user::text));

  -- G4: บังคับ "มี factor TOTP verified" **ใต้ lock** — ใคร unenroll/invalidate
  -- ก่อนหน้านี้ในลำดับเดียวกันถูกเห็นแล้ว (มองเห็นสถานะหลัง serialize เท่านั้น)
  if not exists (select 1 from auth.mfa_factors f
                  where f.user_id = v_user and f.factor_type = 'totp'
                    and f.status = 'verified') then
    raise exception 'ต้องผูกและยืนยัน TOTP ก่อนสร้างโค้ดสำรอง (ERR-VAL-001|totp_required)'
      using errcode = '22023';
  end if;

  delete from public.mfa_backup_codes where user_id = v_user; -- ชุดเก่า invalid ทันที
  insert into public.mfa_backup_codes (user_id, code_hash)
  select v_user, h from unnest(p_hashes) h;

  perform public.append_audit_event_internal(
    'AUTH_MFA_BACKUPS_REGENERATED', 'user', v_user::text, null, null,
    jsonb_build_object('count', v_n, 'replaced_previous', true),
    null, null, gen_random_uuid()::text, v_user);
  return v_n;
end;
$fn$;

-- ── G4b: invalidate — ถือ advisory lock เดียวกับ replace ─────────────────────
create or replace function public.mfa_backup_codes_invalidate()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_n int;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  -- F1: ทำลายชุดโค้ดสำรองก็เป็นการเปลี่ยนข้อมูลรับรอง — บังคับ aal2 เช่น replace
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', '') <> 'aal2' then
    raise exception 'ต้องยืนยันตัวตนสองชั้นก่อนดำเนินการ (ERR-AUTH-004|mfa_required)'
      using errcode = '42501';
  end if;
  -- G4: lock เดียวกับ replace — ปิด MFA (unenroll+invalidate) กับ regenerate
  -- ที่กำลังแข่งกันจบด้วยลำดับใดลำดับหนึ่งเต็มรูปแบบ ไม่มีทาง INSERT โค้ด
  -- หลุดข้ามการลบของ invalidate
  perform pg_advisory_xact_lock(hashtext('mfa_backup_codes:' || v_user::text));
  delete from public.mfa_backup_codes where user_id = v_user;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.append_audit_event_internal(
      'AUTH_MFA_BACKUPS_INVALIDATED', 'user', v_user::text, null, null,
      jsonb_build_object('removed', v_n),
      null, null, gen_random_uuid()::text, v_user);
  end if;
  return v_n;
end;
$fn$;

-- ── G1a: stash_create — รับ p_expires_at จากแอป (ตรวจกรอบ) เก็บ as-is ─────────
-- เปลี่ยน signature (text) → (text, timestamptz): ต้อง drop ตัวเดิมแล้วสร้างใหม่
-- (grants ของตัวเดิมตายไปพร้อม drop — ให้ใหม่ครบด้านล่าง)
drop function if exists public.mfa_pending_stash_create(text);
create function public.mfa_pending_stash_create(p_payload text, p_expires_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน (ERR-AUTH-001|no_session)'
      using errcode = '42501';
  end if;
  if p_payload is null or length(p_payload) > 8192 then
    raise exception 'ข้อมูลไม่ถูกต้อง (ERR-VAL-001|payload)'
      using errcode = '22023';
  end if;
  -- G1: deadline เป็นของที่แอปผูกกับ ciphertext (AAD) — RPC ตรวจกรอบแล้วเก็บ
  -- ค่าที่ส่งมาเป๊ะ ๆ (ห้ามคำนวณเอง: AAD ฝั่งแอปอ้างค่านี้) · กรอบ = อนาคต
  -- และไม่เกิน now()+305 วิ (แอปส่ง +300 วิ · เผื่อ skew นาฬิกา 5 วิ — ยาวกว่า
  -- นี้ = พยายามต่ออายุหน้าต่างโจมตี ปฏิเสธ)
  if p_expires_at is null or p_expires_at <= now()
     or p_expires_at > now() + interval '305 seconds' then
    raise exception 'ข้อมูลไม่ถูกต้อง (ERR-VAL-001|expires_at)'
      using errcode = '22023';
  end if;
  -- เก็บกวาดสิ้นเปลือง: หมดอายุเกิน 1 ชั่วโมง/ใช้แล้วเกิน 1 ชั่วโมง
  delete from public.mfa_pending_stash
   where expires_at < now() - interval '1 hour'
      or (consumed_at is not null and consumed_at < now() - interval '1 hour');
  delete from public.mfa_pending_stash where user_id = v_user;
  insert into public.mfa_pending_stash (user_id, payload, expires_at)
  values (v_user, p_payload, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$fn$;

-- ── G1b: stash_take — คืน jsonb {payload, user_id, expires_at} ────────────────
-- เปลี่ยน return type text → jsonb (ต้อง drop ตัวเดิม) — แอปประกอบ AAD จาก
-- user_id+expires_at "ของแถวจริง" ก่อนถอดรหัส: สำเนา ciphertext ที่ถูก re-host
-- ไปแถวของคนอื่น (user_id เจ้าของใหม่) GCM ไม่ผ่าน = ถอดไม่ได้ แม้ deadline
-- จะถูกตั้งให้ตรงค่าเดิม
drop function if exists public.mfa_pending_stash_take(uuid);
create function public.mfa_pending_stash_take(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.mfa_pending_stash%rowtype;
begin
  select * into v_row
    from public.mfa_pending_stash
   where id = p_id
     and consumed_at is null
     and expires_at > now();
  if v_row.id is null then
    delete from public.mfa_pending_stash
     where expires_at < now() - interval '1 hour'
        or (consumed_at is not null and consumed_at < now() - interval '1 hour');
    return null; -- ไม่มี/ใช้แล้ว/หมดอายุ → caller ตอบ state=expired
  end if;
  return jsonb_build_object(
    'payload',    v_row.payload,
    'user_id',    v_row.user_id,
    'expires_at', v_row.expires_at
  );
end;
$fn$;

-- ── G3a: stash_consume — เพิ่ม `and expires_at > now()` ─────────────────────
-- (เดิม UPDATE ขาดเงื่อนไข deadline: take ตอนยังมีชีวิต → verify ช้า → consume
-- หลัง deadline ผ่านอยู่ — single-use ต้องตายพร้อม deadline ที่ DB ตัดสินจริง)
create or replace function public.mfa_pending_stash_consume(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.mfa_pending_stash
     set consumed_at = now()
   where id = p_id
     and consumed_at is null
     and expires_at > now(); -- G3: deadline ถูกตรวจทั้ง take และ consume
  return found;
end;
$fn$;

-- ── เจ้าของ/สิทธิ์ ของฟังก์ชันที่ signature เปลี่ยน (drop แล้วสร้างใหม่) ────────
alter function public.mfa_backup_codes_replace(text[]) owner to app_owner;
alter function public.mfa_backup_codes_invalidate() owner to app_owner;
alter function public.mfa_pending_stash_create(text, timestamptz) owner to app_owner;
alter function public.mfa_pending_stash_take(uuid) owner to app_owner;
alter function public.mfa_pending_stash_consume(uuid) owner to app_owner;

revoke execute on function public.mfa_pending_stash_create(text, timestamptz) from public, anon;
grant  execute on function public.mfa_pending_stash_create(text, timestamptz) to authenticated;
-- take/consume ต้องให้ anon ด้วย: ขั้นสองของ login ยังไม่มี session — uuid คือ
-- bearer secret (122 บิต) · อายุ 300 วิที่ DB เท่านั้น · consume = single-use
-- จริงหลังออก session (ความลับที่ถือครองคือ uuid — ciphertext ที่ได้จาก take
-- นำไปใช้ต่อไม่ได้เพราะ AAD ผูกเจ้าของแถว)
revoke execute on function public.mfa_pending_stash_take(uuid) from public;
grant  execute on function public.mfa_pending_stash_take(uuid) to anon, authenticated;
revoke execute on function public.mfa_pending_stash_consume(uuid) from public;
grant  execute on function public.mfa_pending_stash_consume(uuid) to anon, authenticated;

-- ให้ PostgREST เห็น signature ใหม่ของ create/take ทันที (drop+create เปลี่ยน
-- รูปร่างฟังก์ชัน — reload schema cache ก่อนใครเรียก)
notify pgrst, 'reload schema';
