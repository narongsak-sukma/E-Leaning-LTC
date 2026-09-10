-- 0019_wave_d_batch.sql — Wave D lead migration batch (2026-09-11)
-- PB-14 / PB-15 / PB-16 + pass_pct grant + audit service_role allowlist ขยาย
-- r1 (codex gate round 1 — 2026-09-11): B1 กักสาขา blanket ของ media_read ตาม bucket +
--   เงื่อนไข inline ใน storage policy · B2/B7 admin_issue/revoke/reissue_certificate
--   (mutation + audit atomic ใน TX เดียว — D12-8) · B5 record_certificate_verification
--   (anon+authenticated · verification log + audit atomic) · B6 admin_update_question
--   (โจทย์+ตัวเลือก TX เดียว — สลับเฉลยได้) · ตัด CERT_ISSUE/REVOKE/REISSUE ออกจาก
--   allowlist service_role ของ wrapper (เหลือ AUTH_* + PII_ACCESS — RPC path ใหม่ท้ายไฟล์)
--
-- ที่มา (ทุกข้อพิสูจน์จาก source แล้วในรอบ close-out ของ D-1..D-4):
--   (e) D-4 flag#4: append_audit_event service_role branch (0008:453-461) ยอมรับ AUTH_* 12
--       เท่านั้น → CERT_ISSUE/CERT_REVOKE/CERT_REISSUE/PII_ACCESS ของ D-4 โดน 42501;
--       AUDIT §4 class ก (L241) รับรองทางเดินนี้อยู่แล้ว (BFF service_role = server path)
--   (a) PB-16: กลางสอบไม่มีแหล่งโจทย์ผ่าน user-JWT — learner_attempt_view null
--       question_snapshot จน after_final_attempt (0009:56-63) → ต้องมี paper view
--       เฉพาะ attempt in_progress (โจทย์+ตัวเลือก ตัดเฉลย ตามแบบแผน DCR-5)
--   (b) PB-15: submit_attempt คืน 'question_count' ที่เป็น sum(points) จริง
--       (0011:830-836,884) → แยกเป็น question_count=count(*) จริง + total_points
--   (d) D-1 flag#2: 0010:708-714 ซ่อน pass_pct จาก authenticated แต่ 0012
--       course_exam_summary เผยสาธารณะอยู่แล้ว → grant เพิ่มให้ BFF อ่านตรงได้
--   (c) PB-14: media_read (0010:371-375) เปิดเฉพาะ instructor/is_staff →
--       (1) เจ้าของใบอ่าน media PDF ไม่ได้ (D-2 pdf route ติดตรง step 5)
--       (2) enrolled-learner อ่าน media บทเรียนไม่ได้ (D-0 resolveLessonMediaUrl)
--       + bucket 'media'/'certificates' ยังไม่มี + storage.objects ไม่มีนโยบาย

-- ═══ (e) audit allowlist ขยาย — CREATE OR REPLACE เฉพาะชั้น wrapper ═══
-- internal (hash-chain/INSERT — 0008:254-388) ไม่แตะเลย; สัญญา/ลำดับชั้นตรวจอื่นทุกอย่าง
-- คงเดิมเป๊ะ (strict keys / AUDIT_READ.filters / before-after null / PII scan /
-- target_user_id uuid / actor lift จาก context.user_id แล้ว strip)
create or replace function public.append_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb,
  p_after jsonb,
  p_context jsonb,
  p_actor_roles jsonb, -- เมินโดยเจตนา: derive ฝั่ง server (D15-N1) — คงไว้ตาม signature ของ AUDIT §4
  p_ip_hash text,
  p_user_agent text,
  p_request_id text
) returns uuid
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_role text := coalesce(current_setting('role', true), ''); -- SET ROLE ของ session ผู้เรียก (ไม่เปลี่ยนตาม SECURITY DEFINER)
  v_keys text[];
  v_ft text;
  v_actor uuid;
begin
  if p_context is null then
    p_context := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_context) <> 'object' then
    raise exception 'append_audit_event: context ต้องเป็น jsonb object (AUDIT §3.2)';
  end if;

  if v_role = 'authenticated' then
    -- class (ข) ผ่าน user-JWT RPC — 4 event เท่านั้น (D16-N1 + D18-B1)
    if p_action not in ('CERT_VERIFY_PUBLIC','AUDIT_READ','RATE_LIMIT_HIT','PII_ACCESS') then
      raise exception 'append_audit_event: event % ไม่อยู่ใน allowlist ของ RPC class ข (AUTH_*/mutation = server path เท่านั้น — AUDIT §4)', p_action
        using errcode = '42501';
    end if;
    if auth.uid() is null then
      raise exception 'append_audit_event: ต้องมี user JWT (ERR-AUTH-001)' using errcode = '42501';
    end if;
    v_keys := case p_action
      when 'CERT_VERIFY_PUBLIC' then array['code','result']
      when 'AUDIT_READ'         then array['filters','row_count']
      when 'RATE_LIMIT_HIT'     then array['group','endpoint']
      when 'PII_ACCESS'         then array['endpoint','target_user_id','purpose']
    end;
    -- ตัดฟิลด์อ้างตัวตนที่ caller ใส่มา — actor มาจาก auth.uid() เท่านั้น (D16-N1)
    p_context := p_context - 'user_id' - 'actor_user_id';
    -- D20-B4: typed value validation ทุกค่าใต้ทุกคีย์ทุกชั้น (AUDIT §3.2 strict schema)
    if not public.audit_rpc_context_schema_ok(p_context) then
      raise exception 'append_audit_event: ค่า context ไม่ตรงชนิดตาม schema ของ event % (ERR-VAL-001)', p_action
        using errcode = '22023';
    end if;
    -- D20-B4b (AUDIT §2 แถว request_id/ip_hash + §4.5): request_id/ip_hash มาจาก
    -- middleware header เท่านั้น — RPC ฝั่งผู้ใช้ override เป็น null เสมอ
    -- (service_role path = BFF trusted ได้ฉีดจาก middleware ตามปกติ)
    p_ip_hash := null;
    p_request_id := null;
  elsif v_role = 'service_role' then
    -- R5-m1: AUTH_* ทั้งชุด (12 event ของ §2.1) = BFF (service key ไม่ออกจาก server) เท่านั้น
    -- 0019-r1: CERT_ISSUE/CERT_REVOKE/CERT_REISSUE ถูกถอนออกจาก allowlist นี้ — mutation events
    -- ของ certificates ต้องบันทึกใน TX เดียวกับ mutation (D12-8) ซึ่งทำไม่ได้ผ่านสอง
    -- PostgREST call → ย้ายไป SECURITY DEFINER RPCs (admin_issue/revoke/reissue_certificate
    -- ท้ายไฟล์) เรียก append_audit_event_internal เอง (AUDIT §4 class ก) — wrapper คง
    -- PII_ACCESS (คิว eligible ของ D-4 อ่านชื่อผู้ผ่านเกณฑ์ D12-23) เหมือนเดิม
    if p_action not in ('AUTH_REGISTER','AUTH_LOGIN_OK','AUTH_LOGIN_FAIL','AUTH_LOGOUT',
                        'AUTH_MFA_ENROLLED','AUTH_MFA_DISABLED','AUTH_MFA_BACKUPS_REGENERATED',
                        'AUTH_PASSWORD_RESET_REQUEST','AUTH_PASSWORD_RESET_DONE',
                        'AUTH_PASSWORD_CHANGE','AUTH_LOCKOUT','AUTH_SESSION_REVOKE',
                        'PII_ACCESS') then
      raise exception 'append_audit_event: service_role บันทึกได้เฉพาะ AUTH_*/PII_ACCESS (R5-m1 + 0019-r1 — AUDIT §4): %', p_action
        using errcode = '42501';
    end if;
    v_keys := case p_action
      when 'AUTH_REGISTER'                  then array['method','user_agent']
      when 'AUTH_LOGIN_OK'                  then array['session_id','mfa_used','ip_hash']
      when 'AUTH_LOGIN_FAIL'                then array['reason','ip_hash']
      when 'AUTH_LOGOUT'                    then array['session_id','reason']
      when 'AUTH_MFA_ENROLLED'              then array['device_hint']
      when 'AUTH_MFA_DISABLED'              then array['reason']
      when 'AUTH_MFA_BACKUPS_REGENERATED'   then array['count','recent_mfa','user_agent','ip_hash']
      when 'AUTH_PASSWORD_RESET_REQUEST'    then array['ip_hash']
      when 'AUTH_PASSWORD_RESET_DONE'       then array['ip_hash']
      when 'AUTH_PASSWORD_CHANGE'           then array['method','session_id']
      when 'AUTH_LOCKOUT'                   then array['fail_count','ip_hash']
      when 'AUTH_SESSION_REVOKE'            then array['session_id','reason']
      -- 0019-r1 — CERT_* ย้ายไป RPC path (คอมเมนต์ branch ข้างบน); context keys ของ
      -- event เหล่านั้นฝังอยู่ในตัว RPCs ตามชุด AUDIT §2.1 L85-87
      when 'PII_ACCESS'                     then array['endpoint','target_user_id','purpose']
    end;
    -- actor = auth.uid() (null ใต้ service key) — ยกจาก context.user_id ที่ BFF (trusted) ใส่มา
    -- ตาม §1.2 "ใคร" ของ 5W แล้ว strip ออกจาก context ที่เก็บจริง
    if p_context ? 'user_id' then
      begin
        v_actor := (p_context ->> 'user_id')::uuid;
      exception when others then
        raise exception 'append_audit_event: context.user_id ต้องเป็น uuid' using errcode = '22023';
      end;
      p_context := p_context - 'user_id';
    end if;
  else
    raise exception 'append_audit_event: role % ไม่ได้รับอนุญาต (class ข เท่านั้นที่ RPC — AUDIT §4)', v_role
      using errcode = '42501';
  end if;

  -- strict keys: ห้ามคีย์นอก allowlist ของ event นั้น (zod .strict() ตรง §3.2)
  if exists (select 1 from jsonb_object_keys(p_context) k where k <> all (v_keys)) then
    raise exception 'append_audit_event: context มีคีย์นอก schema ของ event % (strict — AUDIT §3.2)', p_action
      using errcode = '22023';
  end if;
  -- D19-B2: AUDIT_READ.filters = typed allowlist .strict() ระดับซ้อนด้วย (D12-3 BLOCKER F9)
  -- — ห้าม field อื่นนอกชุด §3.2 และค่าทุก field ต้องตรงชนิด (uuid/datetime/short text)
  -- และผ่าน PII scan — ปิดช่อง exfil เช่น {"filters":{"email":"...@x.com"}}
  if p_action = 'AUDIT_READ' and p_context ? 'filters' then
    if jsonb_typeof(p_context -> 'filters') <> 'object' then
      raise exception 'append_audit_event: filters ต้องเป็น object (AUDIT §3.2)' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_object_keys(p_context -> 'filters') k
               where k <> all (array['actor_id','action','entity_type','entity_id',
                                     'occurred_from','occurred_to'])) then
      raise exception 'append_audit_event: filters มีคีย์นอก allowlist (strict — AUDIT §3.2)'
        using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_each_text(p_context -> 'filters') f
      where (f.key in ('actor_id','entity_id')
             and f.value !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
         or (f.key in ('occurred_from','occurred_to')
             and f.value !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$')
         or (f.key in ('action','entity_type')
             and (length(f.value) > 64 or not public.audit_free_text_ok(f.value)))
    ) then
      raise exception 'append_audit_event: ค่า filters ไม่ถูกต้องตามชนิด/มีรูปแบบ PII (ERR-VAL-001)'
        using errcode = '22023';
    end if;
  end if;
  -- D19-B2: class ข (RPC) ไม่มี event ใดที่ schema มี diff — before/after เป็นของ
  -- class ก (business function derive ฝั่ง server) เท่านั้น
  if p_before is not null or p_after is not null then
    raise exception 'append_audit_event: before/after บันทึกผ่าน business function เท่านั้น — RPC ส่ง diff มาไม่ได้ (AUDIT §3.2/§4)'
      using errcode = '22023';
  end if;
  -- D19-B2: FreeText + PII แบบ recursive ทุกชั้น (รวม object ซ้อนเช่น filters)
  if not public.audit_context_pii_ok(p_context) then
    raise exception 'append_audit_event: context มีรูปแบบ PII ในฟิลด์ฟรีเท็กซ์ (ERR-VAL-001 — ปฏิเสธ ไม่เขียน raw)'
      using errcode = '22023';
  end if;
  -- คีย์ uuid ที่รู้จักต้องเป็น uuid จริง
  if p_context ? 'target_user_id' then
    begin perform (p_context ->> 'target_user_id')::uuid;
    exception when others then
      raise exception 'append_audit_event: target_user_id ต้องเป็น uuid' using errcode = '22023';
    end;
  end if;

  return public.append_audit_event_internal(
    p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_context, p_ip_hash, p_user_agent, p_request_id,
    v_actor);
end;
$fn$;

-- ═══ (d) pass_pct grant — column grant สะสมได้ (ไม่ต้อง revoke ชุดเดิม) ═══
-- เหตุผล: 0012 course_exam_summary เผย pass_pct สาธารณะอยู่แล้ว (D-1 flag#2) —
-- การซ่อนจาก BFF จึงเป็นการซ่อนหลังประตูที่เปิดอยู่; selection ยังซ่อนตามเดิม
grant select (pass_pct) on public.assessment_rules to authenticated;

-- ═══ (a) PB-16 — learner_attempt_paper_view (โจทย์กลางสอบ ไม่มีเฉลย) ═══
-- เงื่อนไขเข้าถึง = เจ้าของ + status='in_progress' เท่านั้น (ส่งแล้วอ่านผลทาง
-- learner_attempt_view ซึ่งเปิดเฉลยตาม after_final_attempt เหมือนเดิม)
-- snapshot ตัดเฉลยทุกชั้นตามแบบแผน DCR-5: ตัด 'points' ระดับบน + ตัด
-- 'is_correct'/'points' ในทุก option (ตัวเลือกเหลือ {id,text} เท่านั้น)
create view public.learner_attempt_paper_view
  with (security_invoker = false) as
select
  at.id as attempt_id,
  at.user_id,
  at.assessment_id,
  at.attempt_no,
  at.status,
  at.started_at,
  at.expires_at,
  aa.question_id,
  aa.seq,
  aa.option_order,
  aa.selected_option_ids,
  aa.answered_at,
  (aa.question_snapshot - 'points') || jsonb_build_object('options', coalesce((
    select jsonb_agg(o - 'is_correct' - 'points' order by ord)
    from jsonb_array_elements(aa.question_snapshot -> 'options') with ordinality as t(o, ord)
  ), '[]'::jsonb)) as question_paper
from public.assessment_attempts at
join public.attempt_answers aa on aa.attempt_id = at.id
where at.user_id = auth.uid()
  and at.status = 'in_progress';

revoke all on public.learner_attempt_paper_view from public, anon, authenticated, service_role;
grant select on public.learner_attempt_paper_view to authenticated;

-- ═══ (b) PB-15 — submit_attempt: question_count จริง + total_points แยก ═══
-- แก้ชื่อฟิลด์ที่โกหก: เดิม 'question_count' = sum(points) (0011:830-836,884)
-- ตอนนี้ question_count = count(*) จริง + total_points = sum(points) แยก
-- โครงอื่นทั้งหมดคงเดิมเป๊ะ: FOR UPDATE idempotent key / session binding 2 ชั้น
-- (D20-B5) / deadline+grace 5 นาที / grading CTE set-equality จาก snapshot ล้วน /
-- credit outbox พร้อม rule snapshot (F6) / EXAM_SUBMIT audit
create or replace function public.submit_attempt(
  p_attempt_id uuid,
  p_session_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_user uuid := auth.uid();
  v_attempt public.assessment_attempts%rowtype;
  v_rules public.assessment_rules%rowtype;
  v_earned int := 0;
  v_total int := 0;
  v_correct int := 0;
  v_qcount int := 0;
  v_score smallint;
  v_passed boolean;
  v_rule public.credit_rules%rowtype;
  v_answered int;
  v_late boolean;
begin
  if v_user is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001)';
  end if;
  select * into v_attempt from public.assessment_attempts
  where id = p_attempt_id and user_id = v_user
  for update; -- idempotent key ของ submit (DD §3.4)
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001)';
  end if;
  if v_attempt.submitted_at is not null then
    -- 0019: early-return idempotent เติม contract ใหม่ให้ครบ (question_count จริงจากแถว
    -- attempt + total_points รวม snapshot) — รูป response สองทางเหมือนกันเป๊ะ
    select coalesce(sum((question_snapshot->>'points')::smallint), 0)
    into v_total
    from public.attempt_answers
    where attempt_id = p_attempt_id;
    return jsonb_build_object('attempt_id', v_attempt.id, 'status', v_attempt.status,
                              'score_pct', v_attempt.score_pct, 'passed', v_attempt.passed,
                              'question_count', v_attempt.question_count,
                              'total_points', v_total,
                              'already_submitted', true);
  end if;
  -- B4 + D20-B5: session binding สองชั้น (แถว + JWT claim — เหมือน save_answer)
  if p_session_id is null
     or p_session_id <> v_attempt.session_id
     or p_session_id is distinct from public.auth_session_claim() then
    raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: session ไม่ตรง (ASM-011 — ERR-RBAC-001)';
  end if;
  if v_attempt.status <> 'in_progress' then
    raise exception 'บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว (ERR-ASM-005)';
  end if;
  -- deadline + grace: เกิน expires_at ได้ไม่เกิน grace (auto-submit job = D-10)
  if now() > v_attempt.expires_at + interval '5 minutes' then
    raise exception 'หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม (ERR-ASM-004)';
  end if;
  v_late := now() > v_attempt.expires_at;

  select * into v_rules from public.assessment_rules where id = v_attempt.rules_id;

  -- ── M1: grading จาก snapshot ล้วน (F14) ──
  with g as (
    select aa.id,
           (aa.question_snapshot->>'points')::smallint as pts,
           coalesce((select jsonb_agg(o->>'id')
                     from jsonb_array_elements(aa.question_snapshot->'options') o
                     where (o->>'is_correct')::boolean), '[]'::jsonb) as correct_ids,
           coalesce(to_jsonb(aa.selected_option_ids), '[]'::jsonb) as sel_ids
    from public.attempt_answers aa
    where aa.attempt_id = p_attempt_id
  ),
  s as (
    select g.*,
           (jsonb_array_length(g.sel_ids) > 0
            and g.sel_ids <@ g.correct_ids
            and g.correct_ids <@ g.sel_ids) as ok
    from g
  )
  update public.attempt_answers aa
  set is_correct = s.ok,
      points_earned = case when s.ok then s.pts else 0 end
  from s
  where aa.id = s.id;

  -- 0019: นับแยก 4 ค่า — คะแนนรวม / คะแนนเต็ม / ถูก / ตอบแล้ว (+ question_count = count(*))
  select coalesce(sum(points_earned), 0),
         coalesce(sum((question_snapshot->>'points')::smallint), 0),
         count(*) filter (where is_correct),
         count(*) filter (where selected_option_ids is not null),
         count(*)
  into v_earned, v_total, v_correct, v_answered, v_qcount
  from public.attempt_answers
  where attempt_id = p_attempt_id;

  v_score := least(round(v_earned * 100.0 / greatest(v_total, 1))::int, 100)::smallint;
  v_passed := v_score >= v_rules.pass_pct;

  update public.assessment_attempts
  set status = case when v_passed then 'passed' else 'failed' end::public.attempt_status,
      submitted_at = now(), score_pct = v_score, passed = v_passed, correct_count = v_correct
  where id = p_attempt_id;

  -- ── M1/F15: ผ่าน → credit accrual event ใน TX เดียวกับ grading ──
  -- เลือกกฎครั้งเดียว ณ วันผ่าน: rule เฉพาะหลักสูตรก่อน generic แล้วตาม priority (F6/D13-F6)
  if v_passed then
    select * into v_rule from public.credit_rules
    where status = 'active'
      and effective_from <= now()
      and (effective_to is null or effective_to > now())
      and (course_id = (select a.course_id from public.assessments a
                        where a.id = v_attempt.assessment_id)
           or course_id is null)
    order by (course_id is null), priority, effective_from desc
    limit 1;
    if found then
      insert into public.event_outbox (topic, payload)
      values ('credit.accrual',
        jsonb_build_object(
          'source_type', 'assessment_attempt',
          'source_id', p_attempt_id,
          'user_id', v_user,
          'enrollment_id', v_attempt.enrollment_id,
          'passed_at', now(),
          'rule', jsonb_build_object(       -- snapshot — worker ห้าม lookup ซ้ำ (D13-F6)
            'rule_id', v_rule.id, 'code', v_rule.code,
            'credits', v_rule.credits, 'credit_type', v_rule.credit_type,
            'renewal_cycle', v_rule.renewal_cycle, 'valid_days', v_rule.valid_days,
            'carry_over', v_rule.carry_over)));
    end if;
    -- ไม่มีกฎที่ active = ไม่คิด credit (ไม่ใช่ error — บางหลักสูตรไม่ให้ credit)
  end if;

  perform public.append_audit_event_internal('EXAM_SUBMIT', 'assessment_attempt',
    p_attempt_id::text, null, null,
    jsonb_build_object('attempt_id', p_attempt_id, 'answered_count', v_answered,
                       'late', v_late, 'idempotency_key', p_attempt_id::text),
    null, null, null);
  return jsonb_build_object('attempt_id', p_attempt_id,
                            'status', case when v_passed then 'passed' else 'failed' end,
                            'score_pct', v_score, 'passed', v_passed,
                            'correct_count', v_correct,
                            'question_count', v_qcount,
                            'total_points', v_total);
end;
$fn$;

-- ═══ (c) PB-14 — media_read ขยาย + bucket + storage.objects นโยบาย ═══
drop policy if exists media_read on public.media_assets;
create policy media_read on public.media_assets for select to authenticated
  using (
    -- 0019-r1 (B1): instructor/is_staff อ่านได้เฉพาะสื่อ bucket 'media' (วิดีโอ/เอกสารบทเรียน)
    -- — ห้ามแผ่ครอบ bucket 'certificates' (PDF ใบประกาศนียบัตรมีชื่อเจ้าของใบ = PII:
    -- เจ้าของใบเท่านั้นที่อ่านได้ผ่านสาขาด้านล่าง ไม่ใช่ instructor/staff ทุกคนผ่าน storage)
    (media_assets.bucket = 'media'
     and (public.has_any_role(array['instructor']) or public.is_staff()))
    -- PB-14a: เจ้าของประกาศนียบัตรอ่าน media ของใบตัวเอง (D-2 pdf route step 5;
    -- certs_owner_read 0010:781 ให้เจ้าของเห็นแถวใบอยู่แล้ว)
    or exists (select 1 from public.certificates c
               where c.pdf_media_id = media_assets.id
                 and c.user_id = auth.uid())
    -- PB-14b: ผู้เรียนที่ลงทะเบียน (active/completed) อ่าน media ของบทเรียนใน
    -- หลักสูตรนั้น (D-0 resolveLessonMediaUrl — video บทเรียน)
    or exists (select 1
               from public.lessons l
               join public.course_modules m on m.id = l.module_id
               join public.enrollments e on e.course_id = m.course_id
               where l.media_id = media_assets.id
                 and l.deleted_at is null
                 and m.deleted_at is null
                 and e.deleted_at is null
                 and e.user_id = auth.uid()
                 and e.status in ('active','completed'))
  );

-- storage: bucket สองใบ (private) + นโยบายเดียวที่ mirror media_read —
-- object มองเห็นได้ก็ต่อเมื่อแถว media_assets ที่ชี้ object นั้นมองเห็นได้
-- (ma.bucket=objects.bucket_id and ma.storage_path=objects.name) — แหล่งความจริง
-- เดียวของสิทธิ์ อยู่ที่ media_read ข้างบน; service_role (upload ของ D-4/D-8)
-- bypass RLS อยู่แล้ว
-- vanilla postgres image ไม่มี storage schema → guard กัน migration พัง
-- (ทางเดิน supabase image / cloud ได้ bucket+นโยบายเต็ม)
do $storage$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice '0019: storage schema ไม่มี (vanilla image) — ข้าม bucket/นโยบาย storage';
    return;
  end if;
  insert into storage.buckets (id, name, public)
  values ('media','media',false), ('certificates','certificates',false)
  on conflict (id) do nothing;
  execute 'drop policy if exists objects_via_media_assets on storage.objects';
  -- 0019-r1 (B1): เงื่อนไข eligibility แบบ inline (mirror สาขาทั้งสามของ media_read)
  -- — defense in depth: แม้ media_assets policy เปลี่ยนในอนาคต storage ก็ไม่เปิดกว้าง
  -- กว่าชุดเงื่อนไขนี้ (subquery ฝั่ง public.* วิ่งใต้ role ผู้เรียก — RLS ของตารางนั้น ๆ
  -- บังคับเหมือนที่ media_read เรียกเอง — probes พิสูจน์แล้วในรอบ 0019)
  execute $p$create policy objects_via_media_assets on storage.objects
    for select to authenticated
    using (exists (
      select 1 from public.media_assets ma
      where ma.bucket = storage.objects.bucket_id
        and ma.storage_path = storage.objects.name
        and (
          (ma.bucket = 'media'
           and (public.has_any_role(array['instructor']) or public.is_staff()))
          or exists (select 1 from public.certificates c
                     where c.pdf_media_id = ma.id
                       and c.user_id = auth.uid())
          or exists (select 1
                     from public.lessons l
                     join public.course_modules m on m.id = l.module_id
                     join public.enrollments e on e.course_id = m.course_id
                     where l.media_id = ma.id
                       and l.deleted_at is null
                       and m.deleted_at is null
                       and e.deleted_at is null
                       and e.user_id = auth.uid()
                       and e.status in ('active','completed'))
        )))$p$;
end
$storage$;

-- ═══ (f) 0019-r1 — certificate business functions (B2/B7) + verify atomic (B5) ═══
-- ═══         + admin_update_question TX เดียว (B6)                              ═══
-- เหตุผลของโครงนี้ (gate r1 B2/B7): การทำ mutation กับ audit เป็นสอง PostgREST call
-- ทำให้ audit พังได้โดยที่ mutation ฝั่ง BFF "สำเร็จ" (และตายระหว่างกลาง) — D12-8
-- บังคับ TX เดียว → SECURITY DEFINER RPCs เป็นเจ้าของ mutation+audit (AUDIT §4 class ก)
-- · EXECUTE เฉพาะ service_role (BFF ของ D-4 — service key ไม่ออกจาก server)
-- · audit ผ่าน append_audit_event_internal พร้อม p_actor_override (ทางเดียวของ
--   server path — EXECUTE app_owner เท่านั้น) + context keys ตามชุด AUDIT §2.1 L85-87
-- · รูป error = ข้อความไทย + ป้าย "(ERR-XXX-NNN|reason)" ท้าย message ให้ BFF map
--   (แบบแผน 0011 — parseRpcErrorCode)

-- ── core ส่วน issue ใช้ร่วม issue/reissue — EXECUTE app_owner เท่านั้น ──
-- gen_random_bytes (CSPRNG ของ verify_code — D10) อยู่ที่ schema extensions
-- (pgcrypto; 0001 ไม่เคยลง) — สร้างสกีมา+extension ถ้ายังไม่มี (vanilla ไม่มีมาเอง
-- ส่วน supabase image ลงอยู่แล้ว → IF NOT EXISTS เป็น no-op) และเพิ่ม extensions
-- เข้า search_path เฉพาะฟังก์ชันนี้ (schema นี้เจ้าของโดย admin ไม่ใช่ public-writable)
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- supabase image ให้ USAGE ของ extensions แก่ anon/authenticated/service_role แต่ไม่ให้ app_owner
-- (vanilla ไม่มี ACL เลย) — DEFINER RPC รันใต้ app_owner จึงมองไม่เห็น gen_random_bytes
grant usage on schema extensions to app_owner;
create or replace function public.cert_issue_core(
  p_actor_user_id uuid,
  p_enrollment_id uuid,
  p_supersedes_cert_id uuid,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $fn$
declare
  v_user uuid;
  v_course uuid;
  v_status text;
  v_deleted timestamptz;
  v_attempt uuid;
  v_holder text;
  v_title text;
  v_year text;
  v_digits text;
  v_cert_no text;
  v_verify text;
  v_bytes bytea;
  v_i int;
  v_j int;
  v_ok boolean := false;
  v_cert_id uuid;
  v_issued_at timestamptz;
begin
  -- ตรวจ enrollment: completed + ไม่ถูกลบล้าง (mirror issue.ts ของ D-4)
  select user_id, course_id, status, deleted_at
    into v_user, v_course, v_status, v_deleted
  from public.enrollments where id = p_enrollment_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|enrollment_not_found)';
  end if;
  if v_status <> 'completed' or v_deleted is not null then
    raise exception 'ข้อมูลไม่ถูกต้อง: ผู้เรียนยังไม่จบหลักสูตรนี้ (ERR-VAL-001|enrollment_not_completed)';
  end if;
  -- มีใบ valid อยู่แล้ว (partial unique uq_certificates_enrollment_valid คุมเหมือนกัน)
  if exists (select 1 from public.certificates
             where enrollment_id = p_enrollment_id and status = 'valid') then
    raise exception 'ข้อมูลไม่ถูกต้อง: มีใบประกาศนียบัตรที่ยังไม่ถูกยกเลิกอยู่แล้ว (ERR-VAL-001|valid_certificate_exists)';
  end if;
  -- ต้องมี attempt ผ่านเกณฑ์ (ครั้งล่าสุดก่อน)
  select id into v_attempt from public.assessment_attempts
  where enrollment_id = p_enrollment_id
    and passed = true and submitted_at is not null
  order by attempt_no desc limit 1;
  if not found then
    raise exception 'ข้อมูลไม่ถูกต้อง: ไม่พบผลสอบที่ผ่านเกณฑ์ของหลักสูตรนี้ (ERR-VAL-001|no_passed_attempt)';
  end if;
  -- snapshot ชื่อผู้ถือใบ + ชื่อหลักสูตร (holderNameOf: ชื่อ-นามสกุล ไม่มีคือ display_name)
  select coalesce(nullif(btrim(concat_ws(' ',
           nullif(btrim(pr.first_name), ''), nullif(btrim(pr.last_name), ''))), ''),
         pr.display_name, '')
    into v_holder
  from public.profiles pr where pr.id = v_user;
  if not found then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cert_profile_lookup_failed)';
  end if;
  select title_th into v_title from public.courses where id = v_course;
  if not found then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cert_course_lookup_failed)';
  end if;
  -- สุ่มรหัส CSPRNG (mirror shared.ts ของ D-4): cert_no = LTC-<ปี ค.ศ. Asia/Bangkok>-<6 หลัก>
  -- verify_code = 43 อักขระจาก alphabet เดียวกับ BFF (63 อักขระ — ตรวจนับจริงจาก literal
  -- ของ shared.ts L39 · get_byte % 63) · ชน UNIQUE (23505) → สุ่มใหม่ ไม่เกิน 5 ครั้ง
  v_year := to_char(now() at time zone 'Asia/Bangkok', 'YYYY');
  v_i := 0;
  loop
    v_i := v_i + 1;
    exit when v_i > 5;
    v_digits := lpad(abs(hashtextextended(gen_random_uuid()::text, 0) % 1000000)::text, 6, '0');
    v_cert_no := 'LTC-' || v_year || '-' || v_digits;
    v_bytes := gen_random_bytes(43);
    v_verify := '';
    for v_j in 0..42 loop
      v_verify := v_verify || substr('useandom-26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict',
                                     1 + (get_byte(v_bytes, v_j) % 63), 1);
    end loop;
    begin
      insert into public.certificates (
        cert_no, verify_code, enrollment_id, user_id, course_id,
        holder_name_snapshot, course_title_snapshot, issued_by, supersedes_cert_id)
      values (v_cert_no, v_verify, p_enrollment_id, v_user, v_course,
              v_holder, v_title, p_actor_user_id, p_supersedes_cert_id)
      returning id, issued_at into v_cert_id, v_issued_at;
      v_ok := true;
      exit;
    exception when unique_violation then
      v_ok := false; -- สุ่มชน → วนสุ่มใหม่
    end;
  end loop;
  if not v_ok then
    raise exception 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-001|cert_code_retry_exhausted)';
  end if;
  perform public.append_audit_event_internal(
    'CERT_ISSUE', 'certificate', v_cert_id::text, null, null,
    jsonb_build_object('certificate_id', v_cert_id, 'code', v_cert_no,
                       'attempt_id', v_attempt, 'enrollment_id', p_enrollment_id),
    null, null, p_request_id, p_actor_user_id);
  return jsonb_build_object(
    'id', v_cert_id, 'cert_no', v_cert_no, 'verify_code', v_verify,
    'enrollment_id', p_enrollment_id, 'user_id', v_user, 'course_id', v_course,
    'holder_name', v_holder, 'course_title', v_title, 'issued_at', v_issued_at);
end;
$fn$;
alter function public.cert_issue_core(uuid, uuid, uuid, text) owner to app_owner;
revoke execute on function public.cert_issue_core(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ── BFF issue: actor + enrollment → ใบใหม่ (mutation+audit TX เดียว) ──
create or replace function public.admin_issue_certificate(
  p_actor_user_id uuid,
  p_enrollment_id uuid,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
begin
  if p_actor_user_id is null then
    raise exception 'ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)';
  end if;
  return public.cert_issue_core(p_actor_user_id, p_enrollment_id, null, p_request_id);
end;
$fn$;
alter function public.admin_issue_certificate(uuid, uuid, text) owner to app_owner;
revoke execute on function public.admin_issue_certificate(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_issue_certificate(uuid, uuid, text)
  to service_role;

-- ── BFF revoke: conditional UPDATE + audit TX เดียว (B2 — audit ล้ม = rollback ทั้ง) ──
create or replace function public.admin_revoke_certificate(
  p_actor_user_id uuid,
  p_certificate_id uuid,
  p_reason text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_cert_no text;
  v_revoked_at timestamptz;
begin
  if p_actor_user_id is null then
    raise exception 'ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 500 then
    raise exception 'ข้อมูลไม่ถูกต้อง: เหตุผลต้องยาว 10-500 ตัวอักษร (ERR-VAL-001|reason_length)'
      using errcode = '22023';
  end if;
  -- อ่าน cert_no คืนให้ BFF (response ของ route ต้องมี certNo) ใน TX เดียวกัน
  select cert_no into v_cert_no from public.certificates where id = p_certificate_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)';
  end if;
  update public.certificates
  set status = 'revoked', revoked_at = now(), revoked_reason = p_reason
  where id = p_certificate_id and status = 'valid'
  returning revoked_at into v_revoked_at;
  if not found then
    raise exception 'ข้อมูลไม่ถูกต้อง: ใบประกาศนียบัตรนี้ไม่ได้อยู่ในสถานะออกใบแล้ว (ERR-VAL-001|not_valid)'
      using errcode = '22023';
  end if;
  -- reason อยู่ในคอลัมน์ revoked_reason เท่านั้น (ฟรีเท็กซ์ — ห้ามลง audit context ตาม
  -- แบบแผน PII scan ของ AUDIT §3.2; context เก็บเฉพาะ id ที่ validate แล้ว)
  perform public.append_audit_event_internal(
    'CERT_REVOKE', 'certificate', p_certificate_id::text, null, null,
    jsonb_build_object('certificate_id', p_certificate_id),
    null, null, p_request_id, p_actor_user_id);
  return jsonb_build_object('id', p_certificate_id, 'cert_no', v_cert_no,
                            'revoked_at', v_revoked_at);
end;
$fn$;
alter function public.admin_revoke_certificate(uuid, uuid, text, text) owner to app_owner;
revoke execute on function public.admin_revoke_certificate(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_revoke_certificate(uuid, uuid, text, text)
  to service_role;

-- ── BFF reissue: supersede + issue + lineage ทั้งหมด TX เดียว (B7 — ล้มช่วงไหน
--    = rollback ทั้ง TX ไม่มีสถานะกึ่งๆ "เดิม superseded + lineage ไม่ครบ") ──
create or replace function public.admin_reissue_certificate(
  p_actor_user_id uuid,
  p_certificate_id uuid,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_enrollment uuid;
  v_new jsonb;
  v_new_id uuid;
begin
  if p_actor_user_id is null then
    raise exception 'ต้องระบุผู้ดำเนินการ (ERR-AUTH-001|actor_required)';
  end if;
  select enrollment_id into v_enrollment from public.certificates
  where id = p_certificate_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|certificate_not_found)';
  end if;
  update public.certificates set status = 'superseded'
  where id = p_certificate_id and status = 'valid';
  if not found then
    raise exception 'ข้อมูลไม่ถูกต้อง: ใบประกาศนียบัตรนี้ไม่ได้อยู่ในสถานะออกใบแล้ว (ERR-VAL-001|not_valid)'
      using errcode = '22023';
  end if;
  -- ออกใบใหม่ใน TX เดียว (cert_issue_core บันทึก CERT_ISSUE ให้ใบใหม่เอง —
  -- คงลายเซ็น audit สอง event CERT_ISSUE + CERT_REISSUE เหมือน reissue.ts เดิม)
  v_new := public.cert_issue_core(p_actor_user_id, v_enrollment, p_certificate_id, p_request_id);
  v_new_id := (v_new ->> 'id')::uuid;
  update public.certificates set superseded_by = v_new_id
  where id = p_certificate_id;
  perform public.append_audit_event_internal(
    'CERT_REISSUE', 'certificate', v_new_id::text, null, null,
    jsonb_build_object('certificate_id', v_new_id,
                       'superseded_cert_id', p_certificate_id,
                       'enrollment_id', v_enrollment),
    null, null, p_request_id, p_actor_user_id);
  return v_new || jsonb_build_object('superseded_cert_id', p_certificate_id);
end;
$fn$;
alter function public.admin_reissue_certificate(uuid, uuid, text) owner to app_owner;
revoke execute on function public.admin_reissue_certificate(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_reissue_certificate(uuid, uuid, text)
  to service_role;

-- ── public verify (B3/B5): SELECT 4 ฟิลด์ + verification log + audit TX เดียว ──
-- EXECUTE anon+authenticated (route ของ D-2 เรียกผ่าน SSR user client — ไม่มี
-- service_role อีกต่อไป); verify_code คอลัมน์ UNIQUE (0006) จับทั้ง QR และ manual
create or replace function public.record_certificate_verification(
  p_code text,
  p_source text,
  p_ip_hash text,
  p_user_agent text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_code text;
  v_cert_no text;
  v_title text;
  v_issued_at timestamptz;
  v_status text;
begin
  v_code := btrim(coalesce(p_code, ''));
  if v_code = '' or length(v_code) > 128 then
    raise exception 'ข้อมูลไม่ถูกต้อง: รหัสที่ตรวจสอบไม่ถูกรูปแบบ (ERR-VAL-001|code_invalid)'
      using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('qr','manual') then
    raise exception 'ข้อมูลไม่ถูกต้อง: แหล่งการตรวจสอบไม่ถูกต้อง (ERR-VAL-001|source_invalid)'
      using errcode = '22023';
  end if;
  -- ค้น cert_no หรือ verify_code · ตอบเฉพาะ 4 ฟิลด์สาธารณะ — ไม่มี holder_name
  -- และไม่มี verify_code ในทางกลับเด็ดขาด (D8/D11-12)
  select cert_no, course_title_snapshot, issued_at, status::text
    into v_cert_no, v_title, v_issued_at, v_status
  from public.certificates
  where cert_no = v_code or verify_code = v_code
  limit 1;
  -- เก็บ log ทุกครั้ง (DD §3.4): verify_code ที่ลงคือ "รหัสที่ผู้ใช้พิมพ์/สแกน" (input)
  -- ไม่ใช่ verify_code จริงของแถว — กัน secret หลุดไปตารางอื่นเมื่อค้นด้วย cert_no
  if not found then
    insert into public.certificate_verifications (verify_code, result, ip_hash, user_agent, source)
    values (v_code, 'not_found', p_ip_hash, left(p_user_agent, 256), p_source);
    perform public.append_audit_event_internal(
      'CERT_VERIFY_PUBLIC', 'certificate', null, null, null,
      jsonb_build_object('code', v_code, 'result', 'not_found'),
      null, null, p_request_id);
    return jsonb_build_object('code', v_code, 'course_title', null,
                              'issued_at', null, 'status', 'not_found');
  end if;
  insert into public.certificate_verifications (verify_code, result, ip_hash, user_agent, source)
  values (v_code, v_status::public.verification_result, p_ip_hash, left(p_user_agent, 256), p_source);
  perform public.append_audit_event_internal(
    'CERT_VERIFY_PUBLIC', 'certificate', null, null, null,
    jsonb_build_object('code', v_code, 'result', v_status),
    null, null, p_request_id);
  return jsonb_build_object('code', v_cert_no, 'course_title', v_title,
                            'issued_at', v_issued_at, 'status', v_status);
end;
$fn$;
alter function public.record_certificate_verification(text, text, text, text, text) owner to app_owner;
revoke execute on function public.record_certificate_verification(text, text, text, text, text)
  from public, service_role;
grant execute on function public.record_certificate_verification(text, text, text, text, text)
  to anon, authenticated;

-- ── BFF question PATCH (B6): โจทย์ + ตัวเลือกทั้งชุด TX เดียว — สลับเฉลยได้จริง ──
-- constraint trigger validate_option_correctness เป็น DEFERRABLE INITIALLY
-- DEFERRED (0005:174-177) จึงตรวจ "คำตอบถูกเป็น 1 เท่านั้น" ที่ COMMIT; route เดิม
-- อัปเดตทีละ option ผ่าน PostgREST = คนละ TX → ค้าง 0/2 เฉลยชั่วขณะ → trigger ยิง
-- (uq_question_options_sort ไม่ deferrable → เลื่อน sort_order ชั่วคราวกันชนก่อน)
create or replace function public.admin_update_question(
  p_question_id uuid,
  p_bank_id uuid,
  p_patch jsonb,
  p_options jsonb
) returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_status public.question_status;
  v_version int;
  v_owner uuid;
  v_exam_staff boolean;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  o jsonb;
  v_ids uuid[];
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อนใช้บริการนี้ (ERR-AUTH-001|auth_required)';
  end if;
  select q.status, q.version, qb.created_by
    into v_status, v_version, v_owner
  from public.questions q
  join public.question_banks qb on qb.id = q.bank_id
  where q.id = p_question_id and q.bank_id = p_bank_id;
  if not found then
    raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|question_not_found)';
  end if;
  -- สิทธิ์ (mirror RLS q_update/qopts_update ของ 0010 + guard_question_activation):
  -- has_any_role อ่าน role_assignments ของ auth.uid() จึงปลอดภัยใต้ SECURITY DEFINER
  v_exam_staff := public.has_any_role(array['staff:exam','super_admin']);
  if not v_exam_staff then
    if not public.has_any_role(array['instructor']) or v_owner <> auth.uid() then
      raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้ (ERR-RBAC-001|not_question_owner)'
        using errcode = '42501';
    end if;
    if v_status = 'active' then
      raise exception 'คุณไม่มีสิทธิ์ดำเนินการนี้: ข้อที่เปิดใช้แล้วแก้ไม่ได้ (ERR-RBAC-001|question_active_readonly_for_instructor)'
        using errcode = '42501';
    end if;
  end if;
  -- patch keys ต้องอยู่ในชุดที่อนุญาตเท่านั้น (BFF strict-parse แล้ว — ชั้นนี้คุมซ้ำ)
  if exists (select 1 from jsonb_object_keys(v_patch) k
             where k not in ('type','difficulty','question_text','explanation','points','tags')) then
    raise exception 'ข้อมูลไม่ถูกต้อง: ฟิลด์ที่แก้ได้ไม่ถูกต้อง (ERR-VAL-001|patch_keys)'
      using errcode = '22023';
  end if;
  if p_options is not null and jsonb_typeof(p_options) <> 'array' then
    raise exception 'ข้อมูลไม่ถูกต้อง: options ต้องเป็น array (ERR-VAL-001|options_not_array)'
      using errcode = '22023';
  end if;
  -- โจทย์ + version bump (DD §3.4 L391 — bump ในแถวเดิม; explanation null-clearing
  -- ด้วย ? operator: มีคีย์ = เซ็ตค่า (รวม null) / ไม่มีคีย์ = คงเดิม)
  update public.questions q
  set type          = coalesce((v_patch->>'type')::public.question_type, q.type),
      difficulty    = coalesce((v_patch->>'difficulty')::public.question_difficulty, q.difficulty),
      question_text = coalesce(v_patch->>'question_text', q.question_text),
      explanation   = case when v_patch ? 'explanation' then v_patch->>'explanation' else q.explanation end,
      points        = coalesce((v_patch->>'points')::smallint, q.points),
      tags          = coalesce((select array_agg(t.value::text)
                                from jsonb_array_elements(v_patch->'tags') t), q.tags),
      version       = q.version + 1
  where q.id = p_question_id;
  -- ตัวเลือก (ถ้าแนบมา): เลื่อน sort_order ของ option ที่จะแก้ออกจากช่วงจริงก่อน
  -- (- 1000000 กันชน uq_question_options_sort ระหว่างสลับ) แล้วตั้งค่าจริงทีละตัว
  if p_options is not null then
    v_ids := array(select (o2->>'id')::uuid
                   from jsonb_array_elements(p_options) o2
                   where o2->>'id' is not null);
    if coalesce(array_length(v_ids, 1), 0) > 0 then
      update public.question_options qo
      set sort_order = qo.sort_order - 1000000
      where qo.question_id = p_question_id and qo.id = any (v_ids);
    end if;
    -- o = scalar jsonb (declare ด้านบน) — อ้างเป็น o ตรง ๆ ห้ามเขียน o.value
    -- (record-style access ถูก parser ตีเป็นตาราง o → missing FROM-clause entry)
    for o in select o2.value from jsonb_array_elements(p_options) o2 loop
      if exists (select 1 from jsonb_object_keys(o) k
                 where k not in ('id','option_text','is_correct','sort_order')) then
        raise exception 'ข้อมูลไม่ถูกต้อง: ฟิลด์ตัวเลือกไม่ได้รับอนุญาต (ERR-VAL-001|option_keys)'
          using errcode = '22023';
      end if;
      if o ? 'id' and o->>'id' is not null then
        update public.question_options
        set option_text = o->>'option_text',
            is_correct  = (o->>'is_correct')::boolean,
            sort_order  = (o->>'sort_order')::int
        where id = (o->>'id')::uuid
          and question_id = p_question_id;
        if not found then
          raise exception 'ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|option_not_found)';
        end if;
      else
        insert into public.question_options (question_id, option_text, is_correct, sort_order)
        values (p_question_id, o->>'option_text',
                (o->>'is_correct')::boolean, (o->>'sort_order')::int);
      end if;
    end loop;
  end if;
  return jsonb_build_object('question_id', p_question_id, 'version', v_version + 1);
end;
$fn$;
alter function public.admin_update_question(uuid, uuid, jsonb, jsonb) owner to app_owner;
revoke execute on function public.admin_update_question(uuid, uuid, jsonb, jsonb)
  from public, anon, service_role;
grant execute on function public.admin_update_question(uuid, uuid, jsonb, jsonb)
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- B9 (probe r1 R4-R8): สิทธิ์ของเจ้าของ RPC — DEFINER RPCs รันใต้ app_owner
-- ตารางข้างบนมี policy INSERT/SELECT ของ app_owner ครบ แต่ขาด BOTH (1) ACL
-- grant ของ app_owner (มีแค่ SELECT — policy ไม่ใช่สิทธิ์) และ (2) policy UPDATE
-- สำหรับเส้นทาง mutation ของ RPC — ผลคือ revoke/reissue/issue/update พังด้วย
-- "permission denied" ทั้ง dev/prod (unit test mock RPC จึงไม่เห็น)
-- แบบเดียวกับที่ 0011 ทำให้ submit_attempt ใช้ assessment_attempts ได้
-- app_owner = NOLOGIN ภายใน เข้าถึงได้ทางเดียวผ่าน RPCs เหล่านี้ที่ grant EXECUTE
-- แคบ ๆ จึงให้สิทธิ์ระดับตารางตามการใช้จริงของ RPC เท่านั้น
-- ─────────────────────────────────────────────────────────────────────────────
-- (1) ACL: cert_issue_core INSERT · admin_revoke/reissue UPDATE ·
--         record_certificate_verification INSERT · admin_update_question UPDATE
grant insert, update on public.certificates to app_owner;
grant insert on public.certificate_verifications to app_owner;
grant update on public.questions to app_owner;
grant insert, update on public.question_options to app_owner;

-- (2) RLS UPDATE policies ของ app_owner (คู่ policy INSERT/SELECT ที่มีอยู่แล้ว)
create policy app_owner_update_certificates
  on public.certificates for update to app_owner
  using (true) with check (true);
create policy app_owner_update_questions
  on public.questions for update to app_owner
  using (true) with check (true);
create policy app_owner_update_question_options
  on public.question_options for update to app_owner
  using (true) with check (true);
