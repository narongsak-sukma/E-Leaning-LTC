/**
 * DCR-11 — integration tests ฝั่ง Admin reporting (migration 0036) บน dev stack จริง —
 * ระดับ DB (RPC ผ่าน REST + ตรวจแถวผ่าน psql) ตามแบบ suite DCR-10:
 *   a) admin_dashboard_stats — KPI สดกรองช่วงวัน (ADM-001):
 *      baseline หน้าต่างว่าง (2021-06-15) = KPI ศูนย์ + passRatePct null · seed:
 *      ผู้ใช้ใหม่ 2 (เลื่อน created_at ภายใต้ disable trigger trg_profiles_update_guard)
 *      · ลงทะเบียน 1 · สอบ 3 ผ่าน 2 (passRatePct = round(2*100/3,1) = 66.7) · ใบ 1 ·
 *      credit accrual 2.5 · users.total คงเดิม · from > to → ERR-VAL-001|date_range ·
 *      staff:content aal2 → report_view_forbidden · aal1 → ERR-AUTH-004|mfa_required
 *   b) admin_list_audit_logs — filter + keyset (AUD-003): หลักฐาน audit สร้างผ่าน
 *      "อนุมัติใบอนุญาต 3 ราย" (admin_decide_license_application โดย super_admin aal2)
 *      — แต่ละรายเขียน ROLE_GRANT (entity_type 'user', entity_id = ผู้รับ lawyer) +
 *      LICENSE_VERIFY (entity_type 'license_application', entity_id = คำขอ) — เส้นทาง
 *      หลักของการมอบ lawyer (admin_grant_role ตรง ๆ ทดสอบแยกที่เคส g ของ identity
 *      suite — 0035 r2 แก้ cast enum แล้ว) · filter action prefix + actor → 3 · actor อื่น → 0 ·
 *      entity_type ตรง → 3 / ไม่ตรง → 0 · entity_id ตรง → 1 / สุ่ม → 0 · ช่วงเวลา
 *      กว้าง = 6 / อนาคต = 0 · keyset: limit 2 → cursor → หน้า 2 เหลือ 1 + null ·
 *      ยูเนียน = 3 ไม่ซ้ำ · แถวหน้า 2 < cursor เคร่งครัด (psql) · p_limit 500 → 200 ·
 *      staff:exam aal2 → audit_view_forbidden · ไม่เปิด before/after/row_hash/prev_hash
 *
 * การแยกโลกของ suite (แบบ DCR-10):
 *   - เนมสเปซ id ตายตัว e17 · ผู้ใช้ email prefix 'dcr11-admin-%' · license_no 9900xxx ·
 *     cert_no 'LTC-D11-' · verify_code 'dcr11' prefix
 *   - pg_cron จริง 4 ตัวพักช่วงรัน (กัน dispatch กลืน event การอนุมัติ) ตั้งคืนตาม
 *     นิยาม 0034 §9 / 0031 §10 ใน afterAll(finally)
 *   - cleanup tracked-first ด้วย email prefix (idempotent · เรียงตาม FK — RESTRICT ·
 *     ledger ลบภายใต้ begin/commit + disable/enable trigger append-only) ·
 *     audit_logs คงไว้ตาม append-only
 *   - ห้าม log token/JWT/license_no เต็มใน output ของ suite (D24)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ANON_KEY,
  createTestUser,
  psql,
  psqlRows,
  psqlScalar,
  REPO_ROOT,
  restCall,
  type RestResult,
  type TestUser,
} from "./helpers.js";
import { mintAal2Token } from "./helpers-aal2.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── id ตายตัวของ fixture ชุดนี้ (เนมสเปซ e17) ─────────────────────────────────

/** หน้าต่างวันที่ว่างจริงใน dev DB (อดีตห่าง 5 ปี — ไม่มี suite ใด seed ตรงนี้) */
const E17_WINDOW_FROM = "2021-06-15";
const E17_WINDOW_TO = "2021-06-15";
const E17_WINDOW_AT = "2021-06-15T08:00:00+00:00";

const E17_CATEGORY = "cccccccc-cccc-4ccc-8ccc-e17a00000001";
const E17_COURSE = "cccccccc-cccc-4ccc-8ccc-e17a00000002";
const E17_ASSESS = "cccccccc-cccc-4ccc-8ccc-e17a00000003";
const E17_RULES = "cccccccc-cccc-4ccc-8ccc-e17a00000004";
const E17_ENROLL = "cccccccc-cccc-4ccc-8ccc-e17a00000005";
const E17_ATT_1 = "cccccccc-cccc-4ccc-8ccc-e17a00000009";
const E17_ATT_2 = "cccccccc-cccc-4ccc-8ccc-e17a0000000a";
const E17_ATT_3 = "cccccccc-cccc-4ccc-8ccc-e17a0000000b";
const E17_CERT = "cccccccc-cccc-4ccc-8ccc-e17a00000006";
const E17_CYCLE = "cccccccc-cccc-4ccc-8ccc-e17a00000007";
const E17_LEDGER = "cccccccc-cccc-4ccc-8ccc-e17a00000008";
/** media หลักฐานของคำขออนุมัติใบอนุญาต 3 ราย (เคส b) */
const E17_MEDIA_G = [
  "cccccccc-cccc-4ccc-8ccc-e17a0000000c",
  "cccccccc-cccc-4ccc-8ccc-e17a0000000d",
  "cccccccc-cccc-4ccc-8ccc-e17a0000000e",
];

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ─────────────────────────────────────────────────

let superA: TestUser; // super_admin — ผู้อ่าน KPI + ผู้อนุมัติใบอนุญาตเคส b (aal2)
let contentU: TestUser; // staff:content — ไม่อยู่ในชุด report:view (รายงาน)
let examU: TestUser; // staff:exam — อยู่ใน report:view แต่ไม่อยู่ในชุด audit_log:view
let dash1: TestUser; // citizen — เจ้าของ enrollment/attempt/ใบ/credit ในหน้าต่าง
let dash2: TestUser; // citizen — ผู้ใช้ใหม่ตัวที่สองของหน้าต่าง (ไม่มีกิจกรรม)
let grant1: TestUser; // เคส b — ผู้ยื่น/ผู้รับ lawyer รายที่ 1
let grant2: TestUser; // เคส b — รายที่ 2
let grant3: TestUser; // เคส b — รายที่ 3

let superAal2Token = "";
let contentAal2Token = "";
let examAal2Token = "";

interface SubmitRow {
  readonly id: string;
  readonly status: string;
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริง — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

/** เรียก admin_list_audit_logs — 0036 r3 ใส่ DEFAULT ครบ 9 พารามิเตอร์แล้ว (ตัวช่วย
 *  ยังส่งครบทุกค่า — explicit null ≡ ละเว้น · กัน PGRST202 จากการส่งเกิน/ขาดชื่อ) */
function listAudit(
  token: string,
  extra: Partial<{
    p_action: string;
    p_actor: string;
    p_entity_type: string;
    p_entity_id: string;
    p_from: string;
    p_to: string;
    p_cursor_occurred_at: string | undefined;
    p_cursor_id: string | undefined;
    p_limit: number;
  }>,
): Promise<RestResult> {
  return userRpc("admin_list_audit_logs", token, {
    p_action: null,
    p_actor: null,
    p_entity_type: null,
    p_entity_id: null,
    p_from: null,
    p_to: null,
    p_cursor_occurred_at: null,
    p_cursor_id: null,
    p_limit: 20,
    ...extra,
  });
}

const execFileAsync = promisify(execFile);

/** หยุด container mailer (dev worker ยิง email-dispatch ทุก 30 วินาที) ช่วงรัน suite —
 *  พัก cron แล้วก็ยังมีทาง tick ได้ (mailer ยิง HTTP email-dispatch ทุก 30 วิ และ tick
 *  ที่ pg_cron dispatch ไปก่อน unschedule ยังวิ่งจบ — เห็นจริงใน suite นี้) */
async function stopMailer(): Promise<void> {
  await execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
}

/** สตาร์ต mailer คืน (finally — ไม่ทิ้ง dev stack หยุดค้าง) */
async function startMailer(): Promise<void> {
  await execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
}
/** พัก cron จริง 4 ตัวช่วงรัน (idempotent) — กัน dispatch กลืน event การอนุมัติ */
async function pauseCrons(): Promise<void> {
  await psql(`
    do $do$
    begin
      if exists (select 1 from cron.job where jobname = 'ltc-notification-dispatch') then
        perform cron.unschedule('ltc-notification-dispatch');
      end if;
      if exists (select 1 from cron.job where jobname = 'ltc-renewal-reminder') then
        perform cron.unschedule('ltc-renewal-reminder');
      end if;
      if exists (select 1 from cron.job where jobname = 'ltc-email-outbox-purge') then
        perform cron.unschedule('ltc-email-outbox-purge');
      end if;
      if exists (select 1 from cron.job where jobname = 'ltc-credit-accrual') then
        perform cron.unschedule('ltc-credit-accrual');
      end if;
    end
    $do$;
  `);
}

/** ตั้ง cron คืนตามนิยาม 0034 §9 / 0031 §10 ทุกตัวอักษร (idempotent — รันซ้ำได้) */
async function restoreCrons(): Promise<void> {
  await psql(`
    do $do$
    begin
      if not exists (select 1 from cron.job where jobname = 'ltc-notification-dispatch') then
        perform cron.schedule('ltc-notification-dispatch', '* * * * *',
          'select public.notification_dispatch_tick()');
      end if;
      if not exists (select 1 from cron.job where jobname = 'ltc-renewal-reminder') then
        perform cron.schedule('ltc-renewal-reminder', '17 3 * * *',
          'select public.renewal_reminder_scan()');
      end if;
      if not exists (select 1 from cron.job where jobname = 'ltc-email-outbox-purge') then
        perform cron.schedule('ltc-email-outbox-purge', '19 4 * * *',
          $cmd$ delete from public.email_outbox
                where status in ('sent','failed')
                  and coalesce(sent_at, created_at) < now() - interval '90 days' $cmd$);
      end if;
      if not exists (select 1 from cron.job where jobname = 'ltc-credit-accrual') then
        perform cron.schedule('ltc-credit-accrual', '* * * * *',
          'select public.credit_accrual_tick()');
      end if;
    end
    $do$;
  `);
}

/** ล้างโลกของ suite ทั้งชุด — scope ด้วย email prefix (idempotent แม้รอบก่อนพังกลางทาง ·
 *  เรียงตาม FK — RESTRICT) · ledger ลบภายใต้ begin/commit + disable/enable trigger
 *  append-only (ถ้า delete ล้ม ทุกอย่างคืน — ทริกเกอร์ไม่ค้างปิด) ·
 *  audit_logs เป็น append-only ตามดีไซน์ — ตั้งใจคงไว้ */
async function cleanupE17World(): Promise<void> {
  const scope = `(select id from auth.users where email like 'dcr11-admin-%')`;
  await psql(`
    begin;
    alter table public.credit_ledger_entries disable trigger trg_append_only_rows;
    delete from public.credit_ledger_entries where user_id in ${scope};
    alter table public.credit_ledger_entries enable trigger trg_append_only_rows;
    commit;
    delete from public.renewal_cycles where user_id in ${scope};
    delete from public.certificate_verifications where verify_code like 'dcr11%';
    delete from public.certificates where user_id in ${scope};
    delete from public.assessment_attempts where user_id in ${scope};
    delete from public.enrollments where user_id in ${scope};
    delete from public.assessment_rules
     where assessment_id in (select id from public.assessments
                              where course_id in (select id from public.courses
                                                   where created_by in ${scope}));
    delete from public.assessments
     where course_id in (select id from public.courses where created_by in ${scope});
    delete from public.courses where created_by in ${scope};
    delete from public.course_categories where id = '${E17_CATEGORY}';
    delete from public.event_outbox
     where topic = 'license.application.approved'
       and payload ->> 'user_id' in (select id::text from auth.users where email like 'dcr11-admin-%');
    -- tick อาจยังกิน event ของชุดนี้ได้แม้พัก cron ไว้ (รันที่ pg_cron dispatch ไปก่อน
    -- unschedule ยังวิ่งจบ — เห็นจริงในรอบแรกของ suite admin) — ล้าง notification/email
    -- ของผู้ใช้ชุดนี้ก่อนลบ profiles (FK NO ACTION จาก notification_recipients/email_outbox)
    create temp table _e17_notif as
      select distinct nr.notification_id as id
        from public.notification_recipients nr
       where nr.user_id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from public.notification_recipients
     where user_id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from public.email_outbox
     where recipient_user_id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from public.notifications where id in (select id from _e17_notif);
    delete from public.license_applications
     where user_id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from public.lawyer_licenses
     where user_id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from public.media_assets
     where id in ('${E17_MEDIA_G[0]}', '${E17_MEDIA_G[1]}', '${E17_MEDIA_G[2]}');
    delete from public.role_assignments
     where user_id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from public.profiles
     where id in (select id from auth.users where email like 'dcr11-admin-%');
    delete from auth.users where email like 'dcr11-admin-%';
  `);
}

/** seed ข้อมูลในหน้าต่าง 2021-06-15 ของเคส a (จำนวนที่ KPI ต้องเห็นพอดี) */
async function seedDashboardWindow(): Promise<void> {
  await psql(`
    begin;
    alter table public.profiles disable trigger trg_profiles_update_guard;
    update public.profiles
       set created_at = '${E17_WINDOW_AT}'
     where id in ('${dash1.id}', '${dash2.id}');
    alter table public.profiles enable trigger trg_profiles_update_guard;
    commit;

    insert into public.course_categories (id, slug, name_th, sort_order)
    values ('${E17_CATEGORY}', 'dcr11-admin-cat', 'หมวดทดสอบ DCR-11 admin', 0)
    on conflict (id) do nothing;

    insert into public.courses (id, code, category_id, created_by, title_th, status, published_at)
    values ('${E17_COURSE}', 'DCR11ADMIN', '${E17_CATEGORY}', '${dash1.id}',
            'หลักสูตรทดสอบ DCR-11 admin', 'published', now())
    on conflict (id) do nothing;

    insert into public.assessments (id, course_id, code, title, is_final, status, published_at)
    values ('${E17_ASSESS}', '${E17_COURSE}', 'FIN', 'ข้อสอบท้ายหลักสูตรทดสอบ', true,
            'published', now())
    on conflict (id) do nothing;

    insert into public.assessment_rules (id, assessment_id, pass_pct)
    values ('${E17_RULES}', '${E17_ASSESS}', 70)
    on conflict (id) do nothing;

    insert into public.enrollments (id, user_id, course_id, status, enrolled_at)
    values ('${E17_ENROLL}', '${dash1.id}', '${E17_COURSE}', 'active',
            '${E17_WINDOW_AT}')
    on conflict (id) do nothing;

    insert into public.assessment_attempts
      (id, assessment_id, user_id, enrollment_id, rules_id, attempt_no, status, session_id,
       started_at, expires_at, submitted_at, score_pct, passed, question_count, correct_count)
    values
      ('${E17_ATT_1}', '${E17_ASSESS}', '${dash1.id}', '${E17_ENROLL}', '${E17_RULES}', 1,
       'passed', 'dcr11-admin-sess-1', '${E17_WINDOW_AT}',
       '2021-06-15T11:00:00+00:00', '2021-06-15T10:45:00+00:00', 90, true, 3, 3),
      ('${E17_ATT_2}', '${E17_ASSESS}', '${dash1.id}', '${E17_ENROLL}', '${E17_RULES}', 2,
       'passed', 'dcr11-admin-sess-2', '2021-06-15T12:00:00+00:00',
       '2021-06-15T13:00:00+00:00', '2021-06-15T12:40:00+00:00', 85, true, 3, 3),
      ('${E17_ATT_3}', '${E17_ASSESS}', '${dash1.id}', '${E17_ENROLL}', '${E17_RULES}', 3,
       'failed', 'dcr11-admin-sess-3', '2021-06-15T14:00:00+00:00',
       '2021-06-15T15:00:00+00:00', '2021-06-15T14:30:00+00:00', 40, false, 3, 1)
    on conflict (id) do nothing;

    insert into public.certificates
      (id, cert_no, verify_code, enrollment_id, user_id, course_id, holder_name_snapshot,
       course_title_snapshot, issued_by, issued_at, status)
    values ('${E17_CERT}',
            'LTC-D11-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
            'dcr11' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 28),
            '${E17_ENROLL}', '${dash1.id}', '${E17_COURSE}',
            'ชื่อผู้เข้ารับใบประกาศทดสอบ', 'หลักสูตรทดสอบ DCR-11 admin',
            '${superA.id}', '${E17_WINDOW_AT}', 'valid')
    on conflict (id) do nothing;

    insert into public.renewal_cycles
      (id, user_id, cycle_no, starts_on, ends_on, required_credits, status)
    values ('${E17_CYCLE}', '${dash1.id}', 1, '2021-01-01', '2021-12-31',
            '{"general": 12}'::jsonb, 'open')
    on conflict (id) do nothing;

    insert into public.credit_ledger_entries
      (id, user_id, renewal_cycle_id, entry_type, credit_type, amount, source_type,
       source_id, created_at)
    values ('${E17_LEDGER}', '${dash1.id}', '${E17_CYCLE}', 'accrual', 'general', 2.5,
            'assessment_attempt', '${E17_ATT_1}', '${E17_WINDOW_AT}');
  `);
}

describe.skipIf(!DB_URL)(
  "DCR-11 Admin reporting (กลไกของ 0036 บน DB จริง — dashboard KPI + audit logs keyset)",
  () => {
    beforeAll(async () => {
      await cleanupE17World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
      await pauseCrons(); // กัน dispatch กลืน event การอนุมัติ (ตั้งคืนใน afterAll finally)
      await stopMailer(); // หยุด dev worker อีเมล (ยิงทุก 30 วินาที) — start คืนใน finally
      superA = await createTestUser("dcr11-admin-super", "super_admin");
      contentU = await createTestUser("dcr11-admin-content", "staff:content");
      examU = await createTestUser("dcr11-admin-exam", "staff:exam");
      dash1 = await createTestUser("dcr11-admin-dash1", "citizen");
      dash2 = await createTestUser("dcr11-admin-dash2", "citizen");
      grant1 = await createTestUser("dcr11-admin-grant1", "citizen");
      grant2 = await createTestUser("dcr11-admin-grant2", "citizen");
      grant3 = await createTestUser("dcr11-admin-grant3", "citizen");
      superAal2Token = await mintAal2Token(superA);
      contentAal2Token = await mintAal2Token(contentU);
      examAal2Token = await mintAal2Token(examU);
    }, 300_000);

    afterAll(async () => {
      // คืน dev stack เสมอ (try/finally — cleanup ล้มห้ามทิ้ง cron พักเงียบ)
      try {
        await cleanupE17World();
      } finally {
        await restoreCrons();
        await startMailer();
      }
    });

    // ─── เคส a: admin_dashboard_stats — KPI ต่อช่วงวัน + ขอบมืดของสิทธิ์ ──────────

    it("เคส a dashboard: หน้าต่างว่าง = KPI ศูนย์ · seed หน้าต่าง → users.new=2 total คงเดิม · enroll 1 · สอบ 3 ผ่าน 2 passRatePct 66.7 · ใบ 1 · credit 2.5 · from>to → date_range · staff:content → report_view_forbidden · aal1 → mfa_required", async () => {
      // baseline — หน้าต่างอดีตห่าง 5 ปีต้องว่างจริง (สถิติของ suite อื่นไม่ตกหน้าต่างนี้)
      const base = await userRpc("admin_dashboard_stats", superAal2Token, {
        p_from: E17_WINDOW_FROM,
        p_to: E17_WINDOW_TO,
      });
      expect(base.status, base.text.slice(0, 300)).toBe(200);
      const b = base.json as {
        users: { new: number; total: number };
        enrollments: { new: number };
        exams: { attempts: number; passed: number; passRatePct: number | null };
        certificates: { issued: number };
        credits: { issued: number };
      };
      expect(b.users.new).toBe(0);
      expect(b.enrollments.new).toBe(0);
      expect(b.exams.attempts).toBe(0);
      expect(b.exams.passed).toBe(0);
      expect(b.exams.passRatePct).toBeNull();
      expect(b.certificates.issued).toBe(0);
      expect(b.credits.issued).toBe(0);
      const baselineTotal = b.users.total;

      // seed จำนวนที่รู้จักเข้าหน้าต่าง แล้วเรียกใหม่ — KPI ต้องเห็นพอดีตัวต่อตัว
      await seedDashboardWindow();
      const after = await userRpc("admin_dashboard_stats", superAal2Token, {
        p_from: E17_WINDOW_FROM,
        p_to: E17_WINDOW_TO,
      });
      expect(after.status, after.text.slice(0, 300)).toBe(200);
      const s = after.json as {
        range: { from: string; to: string };
        users: { new: number; total: number };
        enrollments: { new: number };
        exams: { attempts: number; passed: number; passRatePct: number | null };
        certificates: { issued: number };
        credits: { issued: number };
      };
      expect(s.range.from).toBe("2021-06-15");
      expect(s.range.to).toBe("2021-06-15");
      expect(s.users.new).toBe(2);
      expect(s.users.total).toBe(baselineTotal); // ยอดรวมนับบัญชี active — ไม่ขยับ
      expect(s.enrollments.new).toBe(1);
      expect(s.exams.attempts).toBe(3);
      expect(s.exams.passed).toBe(2);
      expect(s.exams.passRatePct).toBe(66.7); // round(2*100/3, 1) — ทดสอบการปัด
      expect(s.certificates.issued).toBe(1);
      expect(s.credits.issued).toBe(2.5);

      // from > to — ปฏิเสธชัดเจน
      const inverted = await userRpc("admin_dashboard_stats", superAal2Token, {
        p_from: "2021-06-16",
        p_to: "2021-06-15",
      });
      expect(inverted.status, inverted.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const invErr = (inverted.json ?? {}) as { message?: string };
      expect(invErr.message ?? "").toContain("ERR-VAL-001");
      expect(invErr.message ?? "").toContain("date_range");

      // staff:content ไม่อยู่ในชุด report:view (sv/se/sr/sa) — aal2 ผ่านแต่โดน roles
      const contentDenied = await userRpc("admin_dashboard_stats", contentAal2Token, {
        p_from: E17_WINDOW_FROM,
        p_to: E17_WINDOW_TO,
      });
      expect(contentDenied.status, contentDenied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const cErr = (contentDenied.json ?? {}) as { message?: string };
      expect(cErr.message ?? "").toContain("ERR-RBAC-001");
      expect(cErr.message ?? "").toContain("report_view_forbidden");

      // aal1 (ยังไม่ยืนยัน MFA) — guard aal2 ในตัวตัดก่อนถึงชั้น roles
      const aal1Denied = await userRpc("admin_dashboard_stats", examU.accessToken, {
        p_from: E17_WINDOW_FROM,
        p_to: E17_WINDOW_TO,
      });
      expect(aal1Denied.status, aal1Denied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const aErr = (aal1Denied.json ?? {}) as { message?: string };
      expect(aErr.message ?? "").toContain("ERR-AUTH-004");
      expect(aErr.message ?? "").toContain("mfa_required");
    }, 90_000);

    // ─── เคส b: admin_list_audit_logs — filter + keyset + ขอบมืด ─────────────────

    it("เคส b audit logs: อนุมัติใบอนุญาต 3 ราย → ROLE_GRANT + LICENSE_VERIFY อย่างละ 3 (actor=ผู้อนุมัติ) · filter action/actor/entity/วันที่ · keyset limit 2 → หน้า 2 ต่อจาก cursor เคร่งครัด · clamp 500 → 200 · staff:exam → audit_view_forbidden · ไม่เปิด before/after/hash", async () => {
      // หลักฐาน: super_admin aal2 อนุมัติ 3 คำขอ — ครั้งละ ROLE_GRANT (มอบ lawyer
      // ครั้งแรก) + LICENSE_VERIFY · เส้นทางหลักของการมอบ lawyer ใช้ literal ใน SQL
      // อยู่แล้ว (admin_grant_role ตรง ๆ พิสูจน์ที่เคส g ของ identity suite หลัง r2)
      const appIds: string[] = [];
      for (const [i, grantee] of [grant1, grant2, grant3].entries()) {
        await psql(`
          insert into public.media_assets
            (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, status,
             uploaded_by)
          values ('${E17_MEDIA_G[i]}', 'supabase_storage', 'document', 'license-evidence',
                  'dcr11/e17/grant${i + 1}.pdf', 'application/pdf', 2048, 'ready',
                  '${grantee.id}')
          on conflict (id) do nothing;
        `);
        const submitted = await userRpc("my_submit_license_application", grantee.accessToken, {
          p_license_no: `990000${i + 1}`,
          p_evidence_media_id: E17_MEDIA_G[i],
          p_request_id: crypto.randomUUID(),
        });
        expect(submitted.status, submitted.text.slice(0, 300)).toBe(200);
        const appId = (submitted.json as SubmitRow).id;
        appIds.push(appId);
        const approved = await userRpc(
          "admin_decide_license_application",
          superAal2Token,
          {
            p_app_id: appId,
            p_action: "approve",
            p_reason: null,
            p_request_id: crypto.randomUUID(),
          },
        );
        expect(approved.status, approved.text.slice(0, 300)).toBe(200);
      }

      // filter: action prefix ROLE_ + actor ผู้อนุมัติ → พอดี 3 แถวของรันนี้
      // (ตัด actor ให้แคบเสมอ — audit_logs เก็บถาวร แถวของรอบก่อนต้องไม่ติดมา)
      const base = await listAudit(superAal2Token, {
        p_action: "ROLE_",
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(base.status, base.text.slice(0, 300)).toBe(200);
      const page = base.json as {
        data: readonly Record<string, unknown>[];
        nextCursor: { occurredAt: string; id: string } | null;
      };
      expect(page.data).toHaveLength(3);
      for (const row of page.data) {
        expect(row.action).toBe("ROLE_GRANT");
        expect(row.entity_type).toBe("user");
        expect([grant1.id, grant2.id, grant3.id]).toContain(row.entity_id);
        expect(row.actor_user_id).toBe(superA.id);
      }

      // LICENSE_VERIFY ครบ 3 — entity_type license_application / entity_id = คำขอ
      const verify = await listAudit(superAal2Token, {
        p_action: "LICENSE_VERIFY",
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(verify.status, verify.text.slice(0, 300)).toBe(200);
      const vPage = verify.json as typeof page;
      expect(vPage.data).toHaveLength(3);
      for (const row of vPage.data) {
        expect(row.entity_type).toBe("license_application");
        expect(appIds).toContain(row.entity_id);
      }

      // actor อื่น (ผู้รับบทบาทไม่เคยเป็น actor) → 0
      const otherActor = await listAudit(superAal2Token, {
        p_action: "ROLE_",
        p_actor: grant1.id,
        p_limit: 20,
      });
      expect(otherActor.status).toBe(200);
      expect((otherActor.json as typeof page).data).toHaveLength(0);

      // entity_type ตรง → 3 (user=ROLE_GRANT / license_application=LICENSE_VERIFY)
      const byTypeUser = await listAudit(superAal2Token, {
        p_entity_type: "user",
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(byTypeUser.status).toBe(200);
      expect((byTypeUser.json as typeof page).data).toHaveLength(3);
      const byTypeApp = await listAudit(superAal2Token, {
        p_entity_type: "license_application",
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(byTypeApp.status).toBe(200);
      expect((byTypeApp.json as typeof page).data).toHaveLength(3);
      const byTypeNone = await listAudit(superAal2Token, {
        p_entity_type: "no_such_entity_type",
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(byTypeNone.status).toBe(200);
      expect((byTypeNone.json as typeof page).data).toHaveLength(0);

      // entity_id ตรง → 1 · สุ่ม → 0
      const byId1 = await listAudit(superAal2Token, {
        p_entity_id: grant1.id,
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(byId1.status).toBe(200);
      expect((byId1.json as typeof page).data).toHaveLength(1);
      const byIdNone = await listAudit(superAal2Token, {
        p_entity_id: crypto.randomUUID(),
        p_actor: superA.id,
        p_limit: 20,
      });
      expect(byIdNone.status).toBe(200);
      expect((byIdNone.json as typeof page).data).toHaveLength(0);

      // ช่วงเวลา — กว้างครอบวันนี้ (ไม่กรอง action) → 6 · หน้าต่างอนาคต → 0
      const wide = await listAudit(superAal2Token, {
        p_actor: superA.id,
        p_from: "2000-01-01T00:00:00+00:00",
        p_to: new Date(Date.now() + 5 * 60_000).toISOString(),
        p_limit: 20,
      });
      expect(wide.status, wide.text.slice(0, 300)).toBe(200);
      expect((wide.json as typeof page).data).toHaveLength(6);
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const dayAfter = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
      const future = await listAudit(superAal2Token, {
        p_actor: superA.id,
        p_from: tomorrow,
        p_to: dayAfter,
        p_limit: 20,
      });
      expect(future.status).toBe(200);
      expect((future.json as typeof page).data).toHaveLength(0);

      // keyset — limit 2 → 2 แถว + nextCursor · หน้า 2 ได้ที่เหลือ 1 + cursor จบ
      const p1 = await listAudit(superAal2Token, {
        p_action: "ROLE_",
        p_actor: superA.id,
        p_limit: 2,
      });
      expect(p1.status, p1.text.slice(0, 300)).toBe(200);
      const page1 = p1.json as typeof page;
      expect(page1.data).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.nextCursor?.occurredAt).toBeTruthy();
      expect(page1.nextCursor?.id).toBeTruthy();

      const p2 = await listAudit(superAal2Token, {
        p_action: "ROLE_",
        p_actor: superA.id,
        p_limit: 2,
        p_cursor_occurred_at: page1.nextCursor?.occurredAt,
        p_cursor_id: page1.nextCursor?.id,
      });
      expect(p2.status, p2.text.slice(0, 300)).toBe(200);
      const page2 = p2.json as typeof page;
      expect(page2.data).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      // ยูเนียนสองหน้า = 3 แถวไม่ซ้ำ · หน้า 2 เข้มงวด (occurred_at, id) < cursor
      const ids = new Set([...page1.data, ...page2.data].map((r) => String(r.id)));
      expect(ids.size).toBe(3);
      const strictlyBefore = await psqlScalar(`
        select count(*)::text from public.audit_logs
         where id = '${String(page2.data[0]?.id)}'
           and (occurred_at, id) < ('${page1.nextCursor?.occurredAt}'::timestamptz,
                                    '${page1.nextCursor?.id}'::uuid);
      `);
      expect(strictlyBefore).toBe("1");

      // clamp — p_limit 500 ยอมรับได้ (ถูกตัดเหลือ ≤100) ไม่ใช่ error
      const clamped = await listAudit(superAal2Token, {
        p_action: "ROLE_",
        p_actor: superA.id,
        p_limit: 500,
      });
      expect(clamped.status, clamped.text.slice(0, 300)).toBe(200);
      expect(((clamped.json as typeof page).data).length).toBeLessThanOrEqual(100);

      // staff:exam ไม่อยู่ในชุด audit_log:view (staff:viewer + super_admin เท่านั้น)
      const examDenied = await listAudit(examAal2Token, {
        p_limit: 20,
      });
      expect(examDenied.status, examDenied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const eErr = (examDenied.json ?? {}) as { message?: string };
      expect(eErr.message ?? "").toContain("ERR-RBAC-001");
      expect(eErr.message ?? "").toContain("audit_view_forbidden");

      // endpoint แสดงผลเท่านั้น — ห้ามเปิดคอลัมน์หลักฐาน before/after/row_hash/prev_hash
      for (const row of page1.data) {
        const keys = Object.keys(row);
        for (const hidden of ["before", "after", "row_hash", "prev_hash"]) {
          expect(keys, `ต้องไม่เปิดคอลัมน์ ${hidden} ผ่าน endpoint`).not.toContain(hidden);
        }
        expect(keys).toContain("context");
        expect(keys).toContain("request_id");
      }
      const cols = await psqlRows<{ column_name: string }>(`
        select column_name from information_schema.columns
         where table_name = 'audit_logs' and column_name in
               ('id','occurred_at','actor_user_id','actor_roles','action','entity_type',
                'entity_id','context','request_id');
      `);
      expect(cols.length).toBe(9); // ชุดคอลัมน์ที่ endpoint คืนมีจริงในตาราง
    }, 90_000);
  },
);
