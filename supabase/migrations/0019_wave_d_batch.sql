-- 0019_wave_d_batch.sql — Wave D lead migration batch (2026-09-11)
-- PB-14 / PB-15 / PB-16 + pass_pct grant + audit service_role allowlist ขยาย
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
    -- 0019: + class ก mutation events ของ certificates (CERT_ISSUE/REVOKE/REISSUE — AUDIT §4
    -- L241 รับรองทางเดิน BFF service_role ตาม D36-O3) + PII_ACCESS (คิว eligible ของ D-4
    -- อ่านชื่อผู้ผ่านเกณฑ์ D12-23) — ทุก event ยังผ่าน strict keys + PII scan เหมือนเดิม
    if p_action not in ('AUTH_REGISTER','AUTH_LOGIN_OK','AUTH_LOGIN_FAIL','AUTH_LOGOUT',
                        'AUTH_MFA_ENROLLED','AUTH_MFA_DISABLED','AUTH_MFA_BACKUPS_REGENERATED',
                        'AUTH_PASSWORD_RESET_REQUEST','AUTH_PASSWORD_RESET_DONE',
                        'AUTH_PASSWORD_CHANGE','AUTH_LOCKOUT','AUTH_SESSION_REVOKE',
                        'CERT_ISSUE','CERT_REVOKE','CERT_REISSUE','PII_ACCESS') then
      raise exception 'append_audit_event: service_role บันทึกได้เฉพาะ AUTH_*/CERT_*/PII_ACCESS (R5-m1 + 0019 — AUDIT §4): %', p_action
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
      -- 0019 — AUDIT §2.1 L85-87 (certificate_id คือ entity_id ของ event; คีย์เหล่านี้คือ
      -- context เสริม) · user_id ไม่อยู่ใน v_keys เพราะถูกยกเป็น actor แล้ว strip ก่อน strict-keys
      when 'CERT_ISSUE'                     then array['certificate_id','code','attempt_id','enrollment_id']
      when 'CERT_REVOKE'                    then array['certificate_id','reason']
      when 'CERT_REISSUE'                   then array['certificate_id','superseded_cert_id','reason','enrollment_id']
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
    public.has_any_role(array['instructor'])
    or public.is_staff()
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
  execute $p$create policy objects_via_media_assets on storage.objects
    for select to authenticated
    using (exists (
      select 1 from public.media_assets ma
      where ma.bucket = storage.objects.bucket_id
        and ma.storage_path = storage.objects.name))$p$;
end
$storage$;
