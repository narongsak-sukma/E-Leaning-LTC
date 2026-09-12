/**
 * DCR-11 — integration tests ของ Wave E Phase 5 ฝั่ง Identity/License (migration 0035)
 * บน dev stack จริง — ระดับ DB (RPC ผ่าน REST + ตรวจแถวผ่าน psql) ตามแบบ suite DCR-10:
 *   a) พลเมืองยื่น my_submit_license_application (seed media_assets license-evidence
 *      uploaded_by ตัวเองก่อน) → แถวคำขอ pending + audit LICENSE_BIND ใน TX เดียว
 *      · context มี license_hash เท่านั้น (sha256:16 หลักแรก ตรงกับเลขจริง) — ห้ามมี
 *      license_no ตัวเลขจริงใน audit
 *   b) ยื่นซ้ำขณะ pending → ปฏิเสธ ERR-VAL-001|pending_exists (uq user pending เป็นชั้นสอง)
 *   c) registrar aal2 อนุมัติ admin_decide_license_application → คำขอ approved +
 *      lawyer_licenses แถว verified + role_assignments lawyer (idempotent — เคสย่อย
 *      ผู้ถือ lawyer อยู่แล้วได้ roleGranted=false และไม่เกิด ROLE_GRANT) + audit
 *      LICENSE_VERIFY + ROLE_GRANT (context ไม่มี license_no) + event_outbox
 *      license.application.approved (payload user_id/application_id/license_no)
 *   d) ปฏิเสธ — เหตุผลสั้นกว่า 10 → ERR-VAL-001|reason_required · เหตุผลเต็ม →
 *      แถว rejected + rejected_reason + audit LICENSE_VERIFY result rejected +
 *      event license.application.rejected (payload มี reason)
 *   e) อนุมัติเลขซ้ำกับใบ verified ของคนอื่น → ERR-VAL-001|license_no_conflict
 *      (ตั้งชื่อ uq_lawyer_licenses_license_no_active_license) · คำขอยัง pending ·
 *      ไม่เกิดใบ/บทบาทใหม่ (TX rollback ทั้งชุด)
 *   f) JWT aal1 เรียก RPC admin → ERR-AUTH-004|mfa_required (guard ตรวจ aal2 ในตัว)
 *   g) admin_grant_role/admin_revoke_role — registrar มอบ non-lawyer → ERR-RBAC-001|
 *      role_scope · super_admin มอบ super_admin → ERR-VAL-001|role_not_grantable ·
 *      grant instructor + idempotent + revoke จริงผ่านชั้น enum (0035 r2 แก้ cast) ·
 *      ถอนบทบาทสุดท้ายของบัญชี → ERR-VAL-001|last_role (citizen คงใช้งานอยู่) ·
 *      ค่านอก enum → ERR-VAL-001|role_not_manageable
 *   h) RLS — account_deletion_requests มืดสนิท: 0036 REVOKE SELECT จาก authenticated
 *      → ผู้ใช้อ่านตาราง → 403 permission denied (service_role อ่านได้) ·
 *      authenticated เห็น data_export_jobs เฉพาะของตัวเอง · INSERT ตรงทั้งสองตาราง
 *      ถูก REVOKE (path เดียว = RPC)
 *
 * การแยกโลกของ suite (แบบ DCR-10):
 *   - เนมสเปซ id ตายตัว e15 (cccccccc-cccc-4ccc-8ccc-e15a...) ไม่ยืมโครงชุดอื่น ·
 *     ผู้ใช้ทดสอบ email prefix 'dcr11-ident-%'
 *   - pg_cron จริง 4 ตัวถูกพักช่วงรัน (กัน tick กลืน event license.application.* ก่อน
 *     เทส assert) และตั้งคืนตามนิยาม 0034 §9 / 0031 §10 ใน afterAll(finally)
 *   - cleanup tracked-first ตามลำดับ FK · audit_logs คงไว้ตามดีไซน์ append-only
 *   - ห้าม log token/JWT/license_no เต็มใน output ของ suite (D24 — audit เก็บ hash เอง)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ANON_KEY,
  assignRole,
  createTestUser,
  psql,
  psqlRows,
  psqlScalar,
  REPO_ROOT,
  restCall,
  SERVICE_KEY,
  type RestResult,
  type TestUser,
} from "./helpers.js";
import { mintAal2Token } from "./helpers-aal2.js";
import { sha256Hex } from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── id ตายตัวของ fixture ชุดนี้ (เนมสเปซ e15) ─────────────────────────────────

const E15_MEDIA_SUBMIT = "cccccccc-cccc-4ccc-8ccc-e15a00000001";
const E15_MEDIA_APPROVE = "cccccccc-cccc-4ccc-8ccc-e15a00000002";
const E15_MEDIA_APPROVE2 = "cccccccc-cccc-4ccc-8ccc-e15a00000003";
const E15_MEDIA_REJECT = "cccccccc-cccc-4ccc-8ccc-e15a00000004";
const E15_MEDIA_CONFLICT = "cccccccc-cccc-4ccc-8ccc-e15a00000005";
/** แถว RLS ของเคส h — account_deletion_requests + data_export_jobs คู่เทียบ */
const E15_ADR_RLS = "cccccccc-cccc-4ccc-8ccc-e15a00000006";
const E15_DEJ_RLS_A = "cccccccc-cccc-4ccc-8ccc-e15a00000007";
const E15_DEJ_RLS_B = "cccccccc-cccc-4ccc-8ccc-e15a00000008";

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ─────────────────────────────────────────────────

let applicant: TestUser; // เคส a/b/f — ยื่นคำขอแรก (ค้าง pending ทั้งเคส)
let applicant2: TestUser; // เคส h — เจ้าของ data_export_jobs แถวเทียบ
let approveUser: TestUser; // เคส c — อนุมัติปกติ (roleGranted true)
let approveUser2: TestUser; // เคส c — ถือ lawyer อยู่แล้ว (roleGranted false)
let rejectUser: TestUser; // เคส d/g — ปฏิเสธ + เป้า role grant/revoke
let conflictHolder: TestUser; // เคส e — เจ้าของใบ verified เลขซ้ำ (seed ตรง)
let conflictApplicant: TestUser; // เคส e — ผู้ยื่นเลขซ้ำ
let registrarUser: TestUser; // staff:registrar — ผู้ตัดสิน (aal2 ผ่าน mintAal2Token)
let superAdmin: TestUser; // เคส g — ฝั่ง super_admin (role_not_grantable / last_role)
let registrarAal2Token = "";
let superAal2Token = "";

interface SubmitRow {
  readonly id: string;
  readonly user_id: string;
  readonly license_no: string;
  readonly status: string;
  readonly evidence_media_id: string;
}

interface DecideResult {
  readonly applicationId: string;
  readonly result: string;
  readonly resultingLicenseId?: string;
  readonly roleGranted?: boolean;
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริง — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

/** แถวหลักฐาน license-evidence ที่ "เจ้าของอัปโหลดเอง" — พร้อมใช้ (status ready) */
async function seedEvidence(mediaId: string, userId: string, path: string): Promise<void> {
  await psql(`
    insert into public.media_assets
      (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, status, uploaded_by)
    values
      ('${mediaId}', 'supabase_storage', 'document', 'license-evidence', '${path}',
       'application/pdf', 2048, 'ready', '${userId}')
    on conflict (id) do nothing;
  `);
}

/** ยื่นคำขอผูกใบอนุญาตในนามผู้ใช้ */
function submitLicense(
  user: TestUser,
  licenseNo: string,
  mediaId: string,
): Promise<RestResult> {
  return userRpc("my_submit_license_application", user.accessToken, {
    p_license_no: licenseNo,
    p_evidence_media_id: mediaId,
    p_request_id: crypto.randomUUID(),
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
/** พัก cron จริง 4 ตัวช่วงรัน (idempotent) — dispatch กิน event license.application.* */
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
 *  เรียงตาม FK — RESTRICT) · audit_logs เป็น append-only ตามดีไซน์ — ตั้งใจคงไว้ */
async function cleanupE15World(): Promise<void> {
  await psql(`
    delete from public.event_outbox
     where topic like 'license.application.%'
       and payload ->> 'user_id' in (select id::text from auth.users where email like 'dcr11-ident-%');
    -- tick อาจยังกิน event ของชุดนี้ได้แม้พัก cron ไว้ (รันที่ pg_cron dispatch ไปก่อน
    -- unschedule ยังวิ่งจบ — เห็นจริงในรอบแรกของ suite admin) — ล้าง notification/email
    -- ของผู้ใช้ชุดนี้ก่อนลบ profiles (FK NO ACTION จาก notification_recipients/email_outbox)
    create temp table _e15_notif as
      select distinct nr.notification_id as id
        from public.notification_recipients nr
       where nr.user_id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from public.notification_recipients
     where user_id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from public.email_outbox
     where recipient_user_id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from public.notifications where id in (select id from _e15_notif);
    delete from public.account_deletion_requests
     where user_id in (select id from auth.users where email like 'dcr11-ident-%')
        or id = '${E15_ADR_RLS}';
    delete from public.data_export_jobs
     where user_id in (select id from auth.users where email like 'dcr11-ident-%')
        or id in ('${E15_DEJ_RLS_A}', '${E15_DEJ_RLS_B}');
    delete from public.license_applications
     where user_id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from public.lawyer_licenses
     where user_id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from public.media_assets
     where id in ('${E15_MEDIA_SUBMIT}', '${E15_MEDIA_APPROVE}', '${E15_MEDIA_APPROVE2}',
                  '${E15_MEDIA_REJECT}', '${E15_MEDIA_CONFLICT}');
    delete from public.role_assignments
     where user_id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from public.profiles
     where id in (select id from auth.users where email like 'dcr11-ident-%');
    delete from auth.users where email like 'dcr11-ident-%';
  `);
}

describe.skipIf(!DB_URL)(
  "DCR-11 Identity/License (กลไกของ 0035 บน DB จริง — ยื่น/ตัดสิน TX เดียว · role · RLS)",
  () => {
    beforeAll(async () => {
      await cleanupE15World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
      await pauseCrons(); // พัก cron จริงช่วงรัน (ตั้งคืนใน afterAll finally)
      await stopMailer(); // หยุด dev worker อีเมล (ยิงทุก 30 วินาที) — start คืนใน finally
      applicant = await createTestUser("dcr11-ident-applicant", "citizen");
      applicant2 = await createTestUser("dcr11-ident-applicant2", "citizen");
      approveUser = await createTestUser("dcr11-ident-approve", "citizen");
      approveUser2 = await createTestUser("dcr11-ident-approve2", "citizen");
      rejectUser = await createTestUser("dcr11-ident-reject", "citizen");
      conflictHolder = await createTestUser("dcr11-ident-holder", "citizen");
      conflictApplicant = await createTestUser("dcr11-ident-conflict", "citizen");
      registrarUser = await createTestUser("dcr11-ident-registrar", "staff:registrar");
      superAdmin = await createTestUser("dcr11-ident-super", "super_admin");
      registrarAal2Token = await mintAal2Token(registrarUser);
      superAal2Token = await mintAal2Token(superAdmin);
    }, 300_000);

    afterAll(async () => {
      // คืน dev stack เสมอ (try/finally — cleanup ล้มห้ามทิ้ง cron พักเงียบ)
      try {
        await cleanupE15World();
      } finally {
        await restoreCrons();
        await startMailer();
      }
    });

    // ─── เคส a: ยื่นคำขอ → pending + audit LICENSE_BIND (license_hash เท่านั้น) ──

    it("เคส a ยื่นคำขอ: media เจ้าของอัปโหลดเอง → 200 pending · แถวคำขอ + audit LICENSE_BIND TX เดียว · context มี license_hash ตรง sha256 จริง และไม่มี license_no", async () => {
      await seedEvidence(E15_MEDIA_SUBMIT, applicant.id, "dcr11/e15/submit.pdf");
      const res = await submitLicense(applicant, "1234567", E15_MEDIA_SUBMIT);
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as SubmitRow;
      expect(body.status).toBe("pending");
      expect(body.user_id).toBe(applicant.id);
      expect(body.license_no).toBe("1234567");
      // แถวคำขอ pending จริงใน DB
      const rows = await psqlRows<{ id: string; status: string; license_no: string }>(`
        select id::text, status::text, license_no from public.license_applications
         where user_id = '${applicant.id}' and status = 'pending';
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.license_no).toBe("1234567");
      // audit atomic — LICENSE_BIND ผูก entity_id = คำขอ · context มี license_hash เท่านั้น
      const audits = await psqlRows<{
        action: string;
        entity_type: string;
        entity_id: string;
        hash: string | null;
        has_license_no: boolean;
        ctx_status: string | null;
        target: string | null;
      }>(`
        select action, entity_type, entity_id::text,
               context ->> 'license_hash' as hash,
               context ? 'license_no' as has_license_no,
               context ->> 'status' as ctx_status,
               context ->> 'target_user_id' as target
          from public.audit_logs
         where action = 'LICENSE_BIND' and entity_id::text = '${body.id}';
      `);
      expect(audits).toHaveLength(1);
      const audit = audits[0];
      expect(audit?.entity_type).toBe("license_application");
      const expectHash = `sha256:${(await sha256Hex("1234567")).slice(0, 16)}`;
      expect(audit?.hash).toBe(expectHash);
      expect(audit?.has_license_no).toBe(false); // ห้ามเลขจริงลง audit (AUDIT §2.2)
      expect(audit?.ctx_status).toBe("pending");
      expect(audit?.target).toBe(applicant.id);
    }, 45_000);

    // ─── เคส b: ยื่นซ้ำขณะ pending → pending_exists ─────────────────────────────

    it("เคส b ยื่นซ้ำขณะ pending → ปฏิเสธ ERR-VAL-001|pending_exists · ยังมีคำขอ pending แถวเดียว", async () => {
      await seedEvidence(E15_MEDIA_SUBMIT, applicant.id, "dcr11/e15/submit2.pdf");
      const res = await submitLicense(applicant, "2345678", E15_MEDIA_SUBMIT);
      expect(res.status, res.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const err = (res.json ?? {}) as { message?: string };
      expect(err.message ?? "").toContain("ERR-VAL-001");
      expect(err.message ?? "").toContain("pending_exists");
      const count = await psqlScalar(`
        select count(*)::text from public.license_applications
         where user_id = '${applicant.id}' and status = 'pending';
      `);
      expect(count).toBe("1");
    }, 30_000);

    // ─── เคส c: registrar aal2 อนุมัติ → ใบ verified + role + audit + event ─────

    it("เคส c อนุมัติ (registrar aal2): คำขอ approved + lawyer_licenses verified + role lawyer + audit LICENSE_VERIFY/ROLE_GRANT (ไม่มี license_no) + event approved · กรณีถือ lawyer อยู่แล้ว roleGranted=false ไม่มี ROLE_GRANT", async () => {
      await seedEvidence(E15_MEDIA_APPROVE, approveUser.id, "dcr11/e15/approve.pdf");
      const submitted = await submitLicense(approveUser, "3456789", E15_MEDIA_APPROVE);
      expect(submitted.status, submitted.text.slice(0, 300)).toBe(200);
      const appId = (submitted.json as SubmitRow).id;

      const approved = await userRpc("admin_decide_license_application", registrarAal2Token, {
        p_app_id: appId,
        p_action: "approve",
        p_reason: null,
        p_request_id: crypto.randomUUID(),
      });
      expect(approved.status, approved.text.slice(0, 300)).toBe(200);
      const decide = approved.json as DecideResult;
      expect(decide.result).toBe("approved");
      expect(decide.roleGranted).toBe(true);
      expect(decide.resultingLicenseId).toMatch(/^[0-9a-f-]{36}$/);

      // คำขอ → approved + resulting_license_id + decided_by = registrar
      const appRow = await psqlRows<{
        status: string;
        resulting: string | null;
        decided_by: string | null;
      }>(`
        select status::text, resulting_license_id::text as resulting, decided_by::text
          from public.license_applications where id = '${appId}';
      `);
      expect(appRow[0]?.status).toBe("approved");
      expect(appRow[0]?.resulting).toBe(decide.resultingLicenseId);
      expect(appRow[0]?.decided_by).toBe(registrarUser.id);

      // ใบ verified — เลข/หลักฐาน/ผู้ยืนยัน ครบ ยังไม่ถูกเพิกถอน
      const license = await psqlRows<{
        user_id: string;
        license_no: string;
        status: string;
        evidence: string | null;
        verified_by: string | null;
        revoked: boolean;
      }>(`
        select user_id::text, license_no, status::text, evidence_media_id::text as evidence,
               verified_by::text, revoked_at is null as revoked
          from public.lawyer_licenses where id = '${decide.resultingLicenseId ?? ""}';
      `);
      expect(license).toHaveLength(1);
      expect(license[0]?.user_id).toBe(approveUser.id);
      expect(license[0]?.license_no).toBe("3456789");
      expect(license[0]?.status).toBe("verified");
      expect(license[0]?.evidence).toBe(E15_MEDIA_APPROVE);
      expect(license[0]?.verified_by).toBe(registrarUser.id);
      expect(license[0]?.revoked).toBe(true);

      // บทบาท lawyer มอบอัตโนมัติ (แถวเดียว ยัง active)
      const roles = await psqlRows<{ granted_by: string | null }>(`
        select granted_by::text from public.role_assignments
         where user_id = '${approveUser.id}' and role = 'lawyer' and revoked_at is null;
      `);
      expect(roles).toHaveLength(1);
      expect(roles[0]?.granted_by).toBe(registrarUser.id);

      // audit LICENSE_VERIFY (result approved · ไม่มี license_no) + ROLE_GRANT (role lawyer)
      const verifyAudits = await psqlRows<{
        result: string | null;
        has_license_no: boolean;
        resulting: string | null;
        actor: string | null;
      }>(`
        select context ->> 'result' as result, context ? 'license_no' as has_license_no,
               context ->> 'resulting_license_id' as resulting, actor_user_id::text as actor
          from public.audit_logs
         where action = 'LICENSE_VERIFY' and entity_id::text = '${appId}';
      `);
      expect(verifyAudits).toHaveLength(1);
      expect(verifyAudits[0]?.result).toBe("approved");
      expect(verifyAudits[0]?.has_license_no).toBe(false);
      expect(verifyAudits[0]?.resulting).toBe(decide.resultingLicenseId);
      expect(verifyAudits[0]?.actor).toBe(registrarUser.id);
      const grantAudits = await psqlRows<{ role: string | null; has_license_no: boolean }>(`
        select context ->> 'role' as role, context ? 'license_no' as has_license_no
          from public.audit_logs
         where action = 'ROLE_GRANT' and entity_id::text = '${approveUser.id}';
      `);
      expect(grantAudits).toHaveLength(1);
      expect(grantAudits[0]?.role).toBe("lawyer");
      expect(grantAudits[0]?.has_license_no).toBe(false);

      // event_outbox license.application.approved — payload ครบ (ยัง pending เพราะพัก cron)
      const events = await psqlRows<{
        status: string;
        user_id: string;
        application_id: string;
        license_no: string;
      }>(`
        select status::text, payload ->> 'user_id' as user_id,
               payload ->> 'application_id' as application_id,
               payload ->> 'license_no' as license_no
          from public.event_outbox
         where topic = 'license.application.approved'
           and payload ->> 'application_id' = '${appId}';
      `);
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("pending");
      expect(events[0]?.user_id).toBe(approveUser.id);
      expect(events[0]?.license_no).toBe("3456789");

      // ── กรณีย่อย idempotent: ผู้ถือ lawyer อยู่แล้ว — roleGranted=false ไม่มี ROLE_GRANT
      await assignRole(approveUser2.id, "lawyer");
      await seedEvidence(E15_MEDIA_APPROVE2, approveUser2.id, "dcr11/e15/approve2.pdf");
      const submitted2 = await submitLicense(approveUser2, "4567890", E15_MEDIA_APPROVE2);
      expect(submitted2.status, submitted2.text.slice(0, 300)).toBe(200);
      const appId2 = (submitted2.json as SubmitRow).id;
      const approved2 = await userRpc("admin_decide_license_application", registrarAal2Token, {
        p_app_id: appId2,
        p_action: "approve",
        p_reason: null,
        p_request_id: crypto.randomUUID(),
      });
      expect(approved2.status, approved2.text.slice(0, 300)).toBe(200);
      expect((approved2.json as DecideResult).roleGranted).toBe(false);
      const roleCount = await psqlScalar(`
        select count(*)::text from public.role_assignments
         where user_id = '${approveUser2.id}' and role = 'lawyer' and revoked_at is null;
      `);
      expect(roleCount).toBe("1"); // แถวเดิมจาก assignRole — ไม่ insert ซ้ำ
      const grantCount2 = await psqlScalar(`
        select count(*)::text from public.audit_logs
         where action = 'ROLE_GRANT' and entity_id::text = '${approveUser2.id}';
      `);
      expect(grantCount2).toBe("0"); // ไม่มี mutation จึงไม่มี audit
    }, 60_000);

    // ─── เคส d: ปฏิเสธ — reason สั้นโดน, เหตุผลเต็ม → rejected + event ──────────

    it("เคส d ปฏิเสธ: reason สั้นกว่า 10 → ERR-VAL-001|reason_required · เหตุผลเต็ม → แถว rejected + rejected_reason + audit result rejected + event rejected (payload มี reason)", async () => {
      await seedEvidence(E15_MEDIA_REJECT, rejectUser.id, "dcr11/e15/reject.pdf");
      const submitted = await submitLicense(rejectUser, "5678901", E15_MEDIA_REJECT);
      expect(submitted.status, submitted.text.slice(0, 300)).toBe(200);
      const appId = (submitted.json as SubmitRow).id;

      const shortReason = await userRpc("admin_decide_license_application", registrarAal2Token, {
        p_app_id: appId,
        p_action: "reject",
        p_reason: "สั้นไป",
        p_request_id: crypto.randomUUID(),
      });
      expect(shortReason.status, shortReason.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((shortReason.json ?? {}) as { message?: string }).message ?? "").toContain(
        "reason_required",
      );

      const reason = "เอกสารหลักฐานไม่ชัดเจน กรุณาถ่ายรูปใบอนุญาตใหม่แล้วยื่นอีกครั้ง";
      const rejected = await userRpc("admin_decide_license_application", registrarAal2Token, {
        p_app_id: appId,
        p_action: "reject",
        p_reason: reason,
        p_request_id: crypto.randomUUID(),
      });
      expect(rejected.status, rejected.text.slice(0, 300)).toBe(200);
      expect((rejected.json as DecideResult).result).toBe("rejected");

      const appRow = await psqlRows<{
        status: string;
        rejected_reason: string | null;
        decided_by: string | null;
      }>(`
        select status::text, rejected_reason, decided_by::text
          from public.license_applications where id = '${appId}';
      `);
      expect(appRow[0]?.status).toBe("rejected");
      expect(appRow[0]?.rejected_reason).toBe(reason);
      expect(appRow[0]?.decided_by).toBe(registrarUser.id);
      // ปฏิเสธต้องไม่เกิดใบ/บทบาท
      const licenseCount = await psqlScalar(`
        select count(*)::text from public.lawyer_licenses where user_id = '${rejectUser.id}';
      `);
      expect(licenseCount).toBe("0");

      const audit = await psqlRows<{ result: string | null }>(`
        select context ->> 'result' as result from public.audit_logs
         where action = 'LICENSE_VERIFY' and entity_id::text = '${appId}';
      `);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.result).toBe("rejected");

      const events = await psqlRows<{ reason: string | null; user_id: string }>(`
        select payload ->> 'reason' as reason, payload ->> 'user_id' as user_id
          from public.event_outbox
         where topic = 'license.application.rejected'
           and payload ->> 'application_id' = '${appId}';
      `);
      expect(events).toHaveLength(1);
      expect(events[0]?.reason).toBe(reason);
      expect(events[0]?.user_id).toBe(rejectUser.id);
    }, 45_000);

    // ─── เคส e: อนุมัติเลขซ้ำกับใบ verified ของคนอื่น → license_no_conflict ─────

    it("เคส e เลขซ้ำ: seed ใบ verified ของคนอื่นด้วยเลขเดียวกัน → อนุมัติโดน ERR-VAL-001|license_no_conflict (ตั้งชื่อ uq) · คำขอยัง pending · ไม่เกิดใบ/บทบาท (TX rollback)", async () => {
      await psql(`
        insert into public.lawyer_licenses
          (user_id, license_no, status, verified_by, verified_at)
        values
          ('${conflictHolder.id}', '7654321', 'verified', '${registrarUser.id}', now())
        on conflict do nothing;
      `);
      await seedEvidence(E15_MEDIA_CONFLICT, conflictApplicant.id, "dcr11/e15/conflict.pdf");
      const submitted = await submitLicense(conflictApplicant, "7654321", E15_MEDIA_CONFLICT);
      expect(submitted.status, submitted.text.slice(0, 300)).toBe(200);
      const appId = (submitted.json as SubmitRow).id;

      const conflict = await userRpc("admin_decide_license_application", registrarAal2Token, {
        p_app_id: appId,
        p_action: "approve",
        p_reason: null,
        p_request_id: crypto.randomUUID(),
      });
      expect(conflict.status, conflict.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const err = (conflict.json ?? {}) as { message?: string };
      expect(err.message ?? "").toContain("ERR-VAL-001");
      expect(err.message ?? "").toContain("license_no_conflict");
      expect(err.message ?? "").toContain("uq_lawyer_licenses_license_no_active_license");

      // rollback ครบชุด — คำขอยัง pending · ไม่มีใบ/บทบาทใหม่ของผู้ยื่น
      const status = await psqlScalar(`
        select status::text from public.license_applications where id = '${appId}';
      `);
      expect(status).toBe("pending");
      const newLicense = await psqlScalar(`
        select count(*)::text from public.lawyer_licenses where user_id = '${conflictApplicant.id}';
      `);
      expect(newLicense).toBe("0");
      const newRole = await psqlScalar(`
        select count(*)::text from public.role_assignments
         where user_id = '${conflictApplicant.id}' and role = 'lawyer' and revoked_at is null;
      `);
      expect(newRole).toBe("0");
    }, 45_000);

    // ─── เคส f: JWT aal1 เรียก RPC admin → mfa_required ─────────────────────────

    it("เคส f aal1: registrar ยังไม่ยืนยัน MFA (aal1) เรียกตัดสินคำขอ → ERR-AUTH-004|mfa_required · คำขอคง pending", async () => {
      const appId = await psqlScalar(`
        select id::text from public.license_applications
         where user_id = '${applicant.id}' and status = 'pending' limit 1;
      `);
      expect(appId).toMatch(/^[0-9a-f-]{36}$/);
      const denied = await userRpc("admin_decide_license_application", registrarUser.accessToken, {
        p_app_id: appId,
        p_action: "approve",
        p_reason: null,
        p_request_id: crypto.randomUUID(),
      });
      expect(denied.status, denied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const err = (denied.json ?? {}) as { message?: string };
      expect(err.message ?? "").toContain("ERR-AUTH-004");
      expect(err.message ?? "").toContain("mfa_required");
      const status = await psqlScalar(
        `select status::text from public.license_applications where id = '${appId}';`,
      );
      expect(status).toBe("pending");
    }, 30_000);

    // ─── เคส g: scope การมอบ/ถอนบทบาท ──────────────────────────────────────────

    it("เคส g บทบาท: registrar มอบ non-lawyer → ERR-RBAC-001|role_scope · super_admin มอบ super_admin → ERR-VAL-001|role_not_grantable · grant/revoke จริงผ่านชั้น enum ได้ (0035 r2) · ถอนบทบาทสุดท้าย → ERR-VAL-001|last_role · citizen คง active", async () => {
      // registrar (aal2) มอบ instructor — ผิด resource-scope (มอบได้เฉพาะ lawyer)
      const scope = await userRpc("admin_grant_role", registrarAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "instructor",
        p_reason: "ทดสอบ registrar ห้ามมอบบทบาทอื่นนอกจาก lawyer ของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(scope.status, scope.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((scope.json ?? {}) as { message?: string }).message ?? "").toContain("role_scope");

      // super_admin มอบ super_admin — ห้ามผ่าน endpoint (bootstrap เท่านั้น)
      const notGrantable = await userRpc("admin_grant_role", superAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "super_admin",
        p_reason: "ทดสอบห้ามมอบ super_admin ผ่าน endpoint ของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(notGrantable.status, notGrantable.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((notGrantable.json ?? {}) as { message?: string }).message ?? "").toContain(
        "role_not_grantable",
      );

      // 0035 r2 แก้ cast p_role::role_key แล้ว — เส้นทาง mutation ทะลุถึงชั้น SQL จริง:
      // super_admin มอบ instructor ให้ rejectUser (ผู้ถือ citizen) → granted:true
      const grant = await userRpc("admin_grant_role", superAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "instructor",
        p_reason: "ทดสอบมอบบทบาท instructor ผ่าน RPC จริงของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(grant.status, grant.text.slice(0, 300)).toBe(200);
      expect((grant.json as { granted: boolean }).granted).toBe(true);
      // idempotent — ถืออยู่แล้ว: granted:false ไม่เกิดแถวใหม่ (ไม่มี mutation/audit ซ้ำ)
      const grantAgain = await userRpc("admin_grant_role", superAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "instructor",
        p_reason: "ทดสอบซ้ำ idempotent ของ admin_grant_role ของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(grantAgain.status, grantAgain.text.slice(0, 300)).toBe(200);
      expect((grantAgain.json as { granted: boolean }).granted).toBe(false);
      const instructorRows = await psqlScalar(`
        select count(*)::text from public.role_assignments
         where user_id = '${rejectUser.id}' and role = 'instructor' and revoked_at is null;
      `);
      expect(instructorRows).toBe("1");

      // ถอน instructor → revoked:true (บัญชียังเหลือ citizen อยู่)
      const revoke = await userRpc("admin_revoke_role", superAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "instructor",
        p_reason: "ทดสอบถอนบทบาท instructor ผ่าน RPC จริงของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(revoke.status, revoke.text.slice(0, 300)).toBe(200);
      expect((revoke.json as { revoked: boolean }).revoked).toBe(true);

      // ถอน citizen (บทบาทสุดท้ายที่เหลือ) → ERR-VAL-001|last_role — แท็กไปถึงจริงหลัง
      // r2 · exception ใน TX เดียวกับ UPDATE → rollback ทั้งรายการ → citizen คง active
      const lastRole = await userRpc("admin_revoke_role", superAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "citizen",
        p_reason: "ทดสอบกันถอนบทบาทสุดท้ายของบัญชีของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(lastRole.status, lastRole.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((lastRole.json ?? {}) as { message?: string }).message ?? "").toContain("last_role");

      // ค่านอก enum → ERR-VAL-001|role_not_manageable (whitelist จับก่อน cast —
      // ไม่รั่วเป็น 22P02 ไร้แท็ก)
      const garbage = await userRpc("admin_revoke_role", superAal2Token, {
        p_user_id: rejectUser.id,
        p_role: "banana",
        p_reason: "ทดสอบค่าบทบาทที่ไม่มีในระบบของ DCR-11",
        p_request_id: crypto.randomUUID(),
      });
      expect(garbage.status, garbage.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((garbage.json ?? {}) as { message?: string }).message ?? "").toContain(
        "role_not_manageable",
      );
      // ไม่มี mutation ค้าง — citizen ยัง active เพียงบทบาทเดียวที่ใช้งานอยู่
      const citizen = await psqlScalar(`
        select count(*)::text from public.role_assignments
         where user_id = '${rejectUser.id}' and role = 'citizen' and revoked_at is null;
      `);
      expect(citizen).toBe("1");
    }, 60_000);

    // ─── เคส h: RLS — account_deletion_requests มืดสนิท · data_export_jobs เห็นของตัวเอง ──

    it("เคส h RLS: account_deletion_requests มืดสนิท — authenticated อ่าน → 403 permission denied (REVOKE SELECT) · service_role เห็น · data_export_jobs เห็นเฉพาะแถวตัวเอง · INSERT ตรงถูก REVOKE ทั้งสองตาราง", async () => {
      // แถวทดสอบ — สร้างตรง (service path เท่านั้นตาม 0036)
      await psql(`
        insert into public.account_deletion_requests
          (id, user_id, token_hash, expires_at)
        values ('${E15_ADR_RLS}', '${applicant.id}',
                'e15integrationhash0000000000000000000000000000000000000000000000000', now() + interval '24 hours')
        on conflict (id) do nothing;
        insert into public.data_export_jobs (id, user_id, status) values
          ('${E15_DEJ_RLS_A}', '${applicant.id}', 'pending'),
          ('${E15_DEJ_RLS_B}', '${applicant2.id}', 'pending')
        on conflict (id) do nothing;
      `);
      // ผู้ใช้ธรรมดา "อ่านตารางไม่ได้เลย" — 0036 REVOKE SELECT จาก authenticated →
      // PostgREST คืน 403 permission denied (มืดกว่า RLS-ว่าง: ตัวตนถึงตารางไม่ได้ตั้งแต่ grant)
      const owner = await restCall(
        "GET",
        "/rest/v1/account_deletion_requests?select=id",
        { apiKey: ANON_KEY, token: applicant.accessToken },
      );
      expect(owner.status, owner.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((owner.json ?? {}) as { message?: string }).message ?? "").toContain(
        "permission denied",
      );
      // service_role เห็นแถวนั้นจริง (พิสูจน์ว่า [] เพราะ RLS ไม่ใช่เพราะแถวไม่มี)
      const svc = await restCall(
        "GET",
        `/rest/v1/account_deletion_requests?select=id&id=eq.${E15_ADR_RLS}`,
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
      );
      expect(svc.status).toBe(200);
      expect(svc.json).toEqual([{ id: E15_ADR_RLS }]);
      // data_export_jobs — เจ้าของเห็นเฉพาะแถวตัวเอง
      const mine = await restCall(
        "GET",
        "/rest/v1/data_export_jobs?select=id&order=id.asc",
        { apiKey: ANON_KEY, token: applicant.accessToken },
      );
      expect(mine.status, mine.text.slice(0, 300)).toBe(200);
      expect(mine.json).toEqual([{ id: E15_DEJ_RLS_A }]);
      const other = await restCall(
        "GET",
        "/rest/v1/data_export_jobs?select=id&order=id.asc",
        { apiKey: ANON_KEY, token: applicant2.accessToken },
      );
      expect(other.status).toBe(200);
      expect(other.json).toEqual([{ id: E15_DEJ_RLS_B }]);
      // INSERT ตรงถูก REVOKE — path เดียวคือ RPC
      const directJob = await restCall(
        "POST",
        "/rest/v1/data_export_jobs",
        { apiKey: ANON_KEY, token: applicant.accessToken },
        { user_id: applicant.id },
      );
      expect(directJob.status, directJob.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const directAdr = await restCall(
        "POST",
        "/rest/v1/account_deletion_requests",
        { apiKey: ANON_KEY, token: applicant.accessToken },
        { user_id: applicant.id, token_hash: "x", expires_at: new Date().toISOString() },
      );
      expect(directAdr.status, directAdr.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
    }, 45_000);
  },
);
