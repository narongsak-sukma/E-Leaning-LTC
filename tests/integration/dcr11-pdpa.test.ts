/**
 * DCR-11 — integration tests ของ Wave E Phase 5 ฝั่ง PDPA (migration 0036) บน dev stack
 * จริง — ระดับ DB (RPC ผ่าน REST + ตรวจแถวผ่าน psql) ตามแบบ suite DCR-10:
 *   a) my_request_data_export → แถว pending + audit DATA_EXPORT_REQUEST (TX เดียว) ·
 *      ยื่นซ้ำขณะค้าง → ERR-VAL-001|export_pending (uq user active เป็นชั้นสอง)
 *   b) worker claim_data_export_job (service_role): pending→processing คืน jobId+userId ·
 *      งานที่สองตามลำดับ requested_at · คิวหมด → jobId null · เรียกด้วย JWT ผู้ใช้ →
 *      ปฏิเสธ (execute เฉพาะ service_role)
 *   c) complete_data_export_job (service_role) พร้อมแถว media ผลลัพธ์ → done +
 *      file_media_id + completed_at + audit DATA_EXPORT_DONE (context job/file/chunks ·
 *      actor null = ระบบ) + event data_export.ready (payload user_id + source_id = job_id
 *      + job_id + file_media_id) · complete ซ้ำบนงานที่ done แล้ว → job_not_processing
 *   d) fail_data_export_job → failed + error ข้อความ + completed_at (แถว error คงสาเหตุ)
 *   e) my_request_account_deletion — ผู้ถือบทบาท staff → ERR-RBAC-001|account_delete_sod ·
 *      RPC ออก token จริง 43 อักขระ base64url คืนทาง return ครั้งเดียว (0036 r3 แก้
 *      search_path ให้เห็น gen_random_bytes ที่ schema extensions ตามแบบแผน 0019) ·
 *      ขอซ้ำขณะค้าง → ERR-VAL-001|delete_pending · ระบบเก็บ sha256(token) เท่านั้น
 *      (D24 — ตัว token ไม่ลง DB) เพื่อให้เคส f ทดสอบ confirm chain ต่อได้ครบ
 *   f) confirm_account_deletion (service) — token จริง → confirmed:true + profiles.deleted_at
 *      + display_name 'บัญชีที่ขอลบแล้ว' + audit PROFILE_DELETE (retention_note) + คำขอ
 *      confirmed · ยืนยันซ้ำ → token_used · token แปลก → token_not_found · หมดอายุ
 *      (seed expires_at ย้อนหลังด้วย supabase_admin) → token_expired
 *
 * การแยกโลกของ suite (แบบ DCR-10):
 *   - เนมสเปซ id ตายตัว e16 (cccccccc-cccc-4ccc-8ccc-e16a...) ไม่ยืมโครงชุดอื่น ·
 *     ผู้ใช้ทดสอบ email prefix 'dcr11-pdpa-%'
 *   - pg_cron จริง 4 ตัวถูกพักช่วงรัน (กัน tick กลืน event data_export.ready ก่อนเทส
 *     assert) และตั้งคืนตามนิยาม 0034 §9 / 0031 §10 ใน afterAll(finally)
 *   - cleanup tracked-first ตามลำดับ FK · audit_logs คงไว้ตามดีไซน์ append-only
 *   - ห้าม log token ลบบัญชี/JWT ใน output ใด ๆ ของ suite (D24 — token เป็น secret)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { randomBytes } from "node:crypto";

import {
  ANON_KEY,
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
import { sha256Hex } from "./helpers-d8.js";

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── id ตายตัวของ fixture ชุดนี้ (เนมสเปซ e16) ─────────────────────────────────

/** media ผลลัพธ์ของ complete (บักเก็ต pdpa-exports — worker อัปโหลดไฟล์ก่อนเรียก RPC) */
const E16_MEDIA_DONE = "cccccccc-cccc-4ccc-8ccc-e16a00000001";

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ─────────────────────────────────────────────────

let exportA: TestUser; // เคส a/b/c — ยื่น export → claim → complete
let exportB: TestUser; // เคส b — งานที่สอง (ปิดด้วย fail เพื่อไม่ทิ้งคิวค้าง)
let failUser: TestUser; // เคส d — fail path
let delStaff: TestUser; // เคส e — ผู้ถือ staff role → SoD ปฏิเสธ
let delCitizen: TestUser; // เคส e/f — token + confirm จริง
let delExpired: TestUser; // เคส f — token หมดอายุ

/** token ลบบัญชีของ delCitizen — RPC คืนทาง return ครั้งเดียว (เคส e เก็บ · เคส f ใช้ ·
 *  ห้าม log ค่านี้ใน output ใด ๆ — D24) */
let deletionToken = "";
/** claimToken ของงาน exportA (จับจากเคส b — ใช้ต่อในเคส c · gate p5-r2 M1) */
let exportTokenA = "";

interface JobResult {
  readonly jobId: string | null;
  readonly userId?: string;
  readonly status?: string;
  readonly claimToken?: string;
}

function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริง — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
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
/** พัก cron จริง 4 ตัวช่วงรัน (idempotent) — dispatch กิน event data_export.ready */
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
async function cleanupE16World(): Promise<void> {
  await psql(`
    delete from public.event_outbox
     where topic = 'data_export.ready'
       and payload ->> 'user_id' in (select id::text from auth.users where email like 'dcr11-pdpa-%');
    -- tick อาจยังกิน event ของชุดนี้ได้แม้พัก cron ไว้ (รันที่ pg_cron dispatch ไปก่อน
    -- unschedule ยังวิ่งจบ — เห็นจริงในรอบแรกของ suite admin) — ล้าง notification/email
    -- ของผู้ใช้ชุดนี้ก่อนลบ profiles (FK NO ACTION จาก notification_recipients/email_outbox)
    create temp table _e16_notif as
      select distinct nr.notification_id as id
        from public.notification_recipients nr
       where nr.user_id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from public.notification_recipients
     where user_id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from public.email_outbox
     where recipient_user_id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from public.notifications where id in (select id from _e16_notif);
    delete from public.data_export_jobs
     where user_id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from public.account_deletion_requests
     where user_id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from public.media_assets where id = '${E16_MEDIA_DONE}';
    delete from public.role_assignments
     where user_id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from public.profiles
     where id in (select id from auth.users where email like 'dcr11-pdpa-%');
    delete from auth.users where email like 'dcr11-pdpa-%';
  `);
}

describe.skipIf(!DB_URL)(
  "DCR-11 PDPA (กลไกของ 0036 บน DB จริง — export job + ลบบัญชี token single-use)",
  () => {
    beforeAll(async () => {
      await cleanupE16World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
      await pauseCrons(); // พัก cron จริงช่วงรัน (ตั้งคืนใน afterAll finally)
      await stopMailer(); // หยุด dev worker อีเมล (ยิงทุก 30 วินาที) — start คืนใน finally
      exportA = await createTestUser("dcr11-pdpa-exporta", "citizen");
      exportB = await createTestUser("dcr11-pdpa-exportb", "citizen");
      failUser = await createTestUser("dcr11-pdpa-fail", "citizen");
      delStaff = await createTestUser("dcr11-pdpa-staff", "staff:viewer");
      delCitizen = await createTestUser("dcr11-pdpa-citizen", "citizen");
      delExpired = await createTestUser("dcr11-pdpa-expired", "citizen");
    }, 300_000);

    afterAll(async () => {
      // คืน dev stack เสมอ (try/finally — cleanup ล้มห้ามทิ้ง cron พักเงียบ)
      try {
        await cleanupE16World();
      } finally {
        await restoreCrons();
        await startMailer();
      }
    });

    // ─── เคส a: ยื่นคำขอ export → pending + audit; ยื่นซ้ำ → export_pending ─────

    it("เคส a ยื่น export: แถว pending + audit DATA_EXPORT_REQUEST (TX เดียว) · ยื่นซ้ำขณะค้าง → ERR-VAL-001|export_pending", async () => {
      const res = await userRpc("my_request_data_export", exportA.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as JobResult;
      expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.status).toBe("pending");
      // แถว job pending จริง + audit DATA_EXPORT_REQUEST ผูก job เดียวกัน (TX เดียว)
      const rows = await psqlRows<{ status: string }>(`
        select status::text from public.data_export_jobs where id = '${body.jobId ?? ""}';
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("pending");
      const audits = await psqlRows<{ ctx: string | null }>(`
        select context ->> 'job_id' as ctx from public.audit_logs
         where action = 'DATA_EXPORT_REQUEST' and entity_id::text = '${body.jobId ?? ""}';
      `);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.ctx).toBe(body.jobId);
      // ยื่นซ้ำขณะ pending — RPC ปฏิเสธชัดเจน (uq active เป็นชั้นที่สอง)
      const again = await userRpc("my_request_data_export", exportA.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(again.status, again.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const err = (again.json ?? {}) as { message?: string };
      expect(err.message ?? "").toContain("ERR-VAL-001");
      expect(err.message ?? "").toContain("export_pending");
    }, 45_000);

    // ─── เคส b: claim — pending→processing · คิวหมด → null · JWT ผู้ใช้ปฏิเสธ ────

    it("เคส b claim (service_role): job แรก pending→processing คืน jobId+userId · job ถัดไปตามลำดับ requested_at · คิวหมด → jobId null · JWT ผู้ใช้เรียก claim ปฏิเสธ", async () => {
      // ยื่นงานของ exportB ตามหลังงานของ exportA (claim เรียง requested_at)
      const resB = await userRpc("my_request_data_export", exportB.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(resB.status, resB.text.slice(0, 300)).toBe(200);
      const jobIdB = (resB.json as JobResult).jobId ?? "";
      // claim แรก — ต้องได้งานของ exportA (ยื่นก่อนในเคส a — เรียง requested_at)
      const claim1 = await svcRpc("claim_data_export_job", {});
      expect(claim1.status, claim1.text.slice(0, 300)).toBe(200);
      const first = claim1.json as JobResult;
      expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.userId).toBe(exportA.id);
      // gate p5-r2 M1: claim คืน token ของรอบการถือครอง (uuid) — complete/fail ต้องแนบ
      expect(first.claimToken ?? "").toMatch(/^[0-9a-f-]{36}$/);
      exportTokenA = first.claimToken ?? "";
      const status1 = await psqlScalar(
        `select status::text from public.data_export_jobs where id = '${first.jobId ?? ""}';`,
      );
      expect(status1).toBe("processing");
      // claim ที่สอง — ได้งานของ exportB (งานเดียวที่ยัง pending)
      const claim2 = await svcRpc("claim_data_export_job", {});
      expect(claim2.status, claim2.text.slice(0, 300)).toBe(200);
      const second = claim2.json as JobResult;
      expect(second.jobId).toBe(jobIdB);
      expect(second.userId).toBe(exportB.id);
      expect(second.claimToken ?? "").toMatch(/^[0-9a-f-]{36}$/);
      // คิวหมด — ไม่มี pending เหลือ → jobId null
      const claim3 = await svcRpc("claim_data_export_job", {});
      expect(claim3.status, claim3.text.slice(0, 300)).toBe(200);
      expect((claim3.json as JobResult).jobId).toBeNull();
      // JWT ผู้ใช้เรียก claim — execute เฉพาะ service_role (REVOKE authenticated)
      const denied = await userRpc("claim_data_export_job", exportA.accessToken, {});
      expect(denied.status, denied.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      // ปิดงานของ exportB ให้จบด้วย fail RPC (สถานะ failed ตามจริงของ worker — ไม่ทิ้งคิว)
      const failB = await svcRpc("fail_data_export_job", {
        p_job_id: jobIdB,
        p_error: "dcr11-pdpa-case-b-finish",
        p_claim_token: second.claimToken ?? "",
      });
      expect(failB.status, failB.text.slice(0, 300)).toBe(200);
    }, 45_000);

    // ─── เคส c: complete — done + file + audit + event · ซ้ำ → job_not_processing ──

    it("เคส c complete (service_role): done + file_media_id + audit DATA_EXPORT_DONE (chunks, actor ระบบ) + event data_export.ready payload ครบ · complete ซ้ำ → job_not_processing", async () => {
      // media ผลลัพธ์ — worker อัปโหลดไฟล์แล้ว insert media_assets ด้วย service client ก่อนเรียก
      await psql(`
        insert into public.media_assets
          (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, status, uploaded_by)
        values
          ('${E16_MEDIA_DONE}', 'supabase_storage', 'document', 'pdpa-exports',
           'pdpa-exports/dcr11/${E16_MEDIA_DONE}.json', 'application/json', 4096, 'ready',
           '${exportA.id}')
        on conflict (id) do nothing;
      `);
      // job ของ exportA ยัง processing จากเคส b — complete ด้วย service_role
      const jobId = await psqlScalar(`
        select id::text from public.data_export_jobs
         where user_id = '${exportA.id}' and status = 'processing' limit 1;
      `);
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
      const res = await svcRpc("complete_data_export_job", {
        p_job_id: jobId,
        p_file_media_id: E16_MEDIA_DONE,
        p_chunks: 3,
        p_request_id: crypto.randomUUID(),
        p_claim_token: exportTokenA,
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      expect((res.json as JobResult).status).toBe("done");
      // แถว done + file_media_id + completed_at
      const job = await psqlRows<{ status: string; file_media_id: string | null }>(`
        select status::text, file_media_id::text from public.data_export_jobs
         where id = '${jobId}';
      `);
      expect(job[0]?.status).toBe("done");
      expect(job[0]?.file_media_id).toBe(E16_MEDIA_DONE);
      // audit DATA_EXPORT_DONE — context ครบ (chunks) · actor NULL = ระบบ (worker)
      const audits = await psqlRows<{
        ctx_job: string | null;
        ctx_file: string | null;
        ctx_chunks: string | null;
        actor: string | null;
      }>(`
        select context ->> 'job_id' as ctx_job, context ->> 'file_media_id' as ctx_file,
               context ->> 'chunks' as ctx_chunks, actor_user_id::text as actor
          from public.audit_logs
         where action = 'DATA_EXPORT_DONE' and entity_id::text = '${jobId}';
      `);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.ctx_job).toBe(jobId);
      expect(audits[0]?.ctx_file).toBe(E16_MEDIA_DONE);
      expect(audits[0]?.ctx_chunks).toBe("3");
      expect(audits[0]?.actor).toBeNull();
      // event data_export.ready — payload ครบทั้งสี่คีย์ (source_id = job_id → ref_id ของ tick)
      const events = await psqlRows<{
        status: string;
        user_id: string;
        source_id: string;
        payload_job: string;
        payload_file: string;
      }>(`
        select status::text, payload ->> 'user_id' as user_id,
               payload ->> 'source_id' as source_id,
               payload ->> 'job_id' as payload_job,
               payload ->> 'file_media_id' as payload_file
          from public.event_outbox
         where topic = 'data_export.ready' and payload ->> 'job_id' = '${jobId}';
      `);
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("pending");
      expect(events[0]?.user_id).toBe(exportA.id);
      expect(events[0]?.source_id).toBe(jobId);
      expect(events[0]?.payload_file).toBe(E16_MEDIA_DONE);
      // complete ซ้ำบนงานที่ done แล้ว — ไม่พบงานสถานะ processing → ปฏิเสธ ·
      // (P0002 ผ่าน gateway ของ stack นี้ร่างกาย error หาย — บทเรียน dcr10 §"P0002" —
      //  จึง assert เฉพาะสถานะ; แท็ก ERR-NF-001|job_not_processing พิสูจน์ที่ชั้น DB)
      const again = await svcRpc("complete_data_export_job", {
        p_job_id: jobId,
        p_file_media_id: E16_MEDIA_DONE,
        p_chunks: 3,
        p_request_id: crypto.randomUUID(),
        p_claim_token: exportTokenA,
      });
      expect(again.status, again.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(again.json, "P0002 ผ่าน gateway ต้องไม่กลายเป็น 200 เงียบ").toBeNull();
    }, 45_000);

    // ─── เคส d: fail path — failed + error + completed_at ──────────────────────

    it("เคส d fail (service_role): claim แล้วยิง fail → แถว failed + error คงข้อความ + completed_at", async () => {
      const res = await userRpc("my_request_data_export", failUser.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const jobId = (res.json as JobResult).jobId ?? "";
      const claim = await svcRpc("claim_data_export_job", {});
      expect(claim.status, claim.text.slice(0, 300)).toBe(200);
      expect((claim.json as JobResult).jobId).toBe(jobId);
      const token = ((claim.json as JobResult).claimToken ?? "");
      expect(token).toMatch(/^[0-9a-f-]{36}$/);
      const reason = "ประกอบไฟล์ JSON ไม่สำเร็จ (storage timeout) — ทดสอบ fail path ของ DCR-11";
      const fail = await svcRpc("fail_data_export_job", {
        p_job_id: jobId,
        p_error: reason,
        p_claim_token: token,
      });
      expect(fail.status, fail.text.slice(0, 300)).toBe(200);
      expect((fail.json as JobResult).status).toBe("failed");
      const job = await psqlRows<{ status: string; error: string | null }>(`
        select status::text, error from public.data_export_jobs where id = '${jobId}';
      `);
      expect(job[0]?.status).toBe("failed");
      expect(job[0]?.error).toBe(reason);
    }, 45_000);

    // ─── เคส e: ขอลบบัญชี — SoD staff · token 43 base64url · hash เท่านั้น · ซ้ำ ──

    it("เคส e ขอลบบัญชี: ผู้ถือ staff role → ERR-RBAC-001|account_delete_sod · RPC ออก token จริง 43 อักขระครั้งเดียว (r3) · ขอซ้ำ → delete_pending · DB เก็บ sha256 เท่านั้น", async () => {
      // SoD — บัญชีที่ถือบทบาทบริหารจัดการห้ามลบเอง (ตรวจบทบาทก่อนถึงชั้นออก token)
      const staffRes = await userRpc("my_request_account_deletion", delStaff.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(staffRes.status, staffRes.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      const staffErr = (staffRes.json ?? {}) as { message?: string };
      expect(staffErr.message ?? "").toContain("ERR-RBAC-001");
      expect(staffErr.message ?? "").toContain("account_delete_sod");

      // 0036 r3 แก้ search_path (public, extensions ตามแบบแผน cert_issue_core ของ
      // 0019) แล้ว — การออก token ทำงานจริง: คืน token 43 อักขระ base64url ทาง
      // return ครั้งเดียว พร้อม requestId/expiresAt (24 ชม.)
      const issued = await userRpc("my_request_account_deletion", delCitizen.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(issued.status, issued.text.slice(0, 300)).toBe(200);
      const issuedBody = issued.json as { requestId: string; token: string; expiresAt: string };
      expect(issuedBody.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issuedBody.requestId).toMatch(/^[0-9a-f-]{36}$/);
      deletionToken = issuedBody.token;

      // มีคำขอค้างที่ยังใช้ได้อยู่แล้ว = ไม่ออก token ใหม่ (กัน spam อีเมล)
      const again = await userRpc("my_request_account_deletion", delCitizen.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(again.status, again.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((again.json ?? {}) as { message?: string }).message ?? "").toContain(
        "delete_pending",
      );

      // ระบบเก็บ sha256(token) เท่านั้น — ตัว token ไม่ปรากฏใน DB (D24)
      const stored = await psqlScalar(`
        select token_hash from public.account_deletion_requests
         where user_id = '${delCitizen.id}' and status = 'pending'
         order by requested_at desc limit 1;
      `);
      expect(stored).not.toBe(deletionToken); // ตัว token ห้ามอยู่ใน DB
      expect(stored).toBe(await sha256Hex(deletionToken)); // เก็บ sha256 เท่านั้น
    }, 45_000);

    // ─── เคส f: confirm — single-use · soft-delete · PROFILE_DELETE · ขอบมืด ─────

    it("เคส f ยืนยันลบบัญชี: token จริง → confirmed + profiles.deleted_at + display_name 'บัญชีที่ขอลบแล้ว' + audit PROFILE_DELETE (retention_note) · ซ้ำ → token_used · แปลก → token_not_found · หมดอายุ → token_expired", async () => {
      // token จริงจากเคส e (คืนทาง return ครั้งเดียว) — ยืนยันผ่าน service client
      expect(deletionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const requestId = await psqlScalar(`
        select id::text from public.account_deletion_requests
         where user_id = '${delCitizen.id}' and status = 'pending'
         order by requested_at desc limit 1;
      `);
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      const confirm = await svcRpc("confirm_account_deletion", {
        p_token: deletionToken,
        p_request_id: crypto.randomUUID(),
      });
      expect(confirm.status, confirm.text.slice(0, 300)).toBe(200);
      const confirmBody = confirm.json as { userId: string; confirmed: boolean };
      expect(confirmBody.confirmed).toBe(true);
      expect(confirmBody.userId).toBe(delCitizen.id);
      // soft-delete — deleted_at + ซ่อนชื่อแสดง
      const profile = await psqlRows<{ deleted: boolean; display_name: string | null }>(`
        select deleted_at is not null as deleted, display_name
          from public.profiles where id = '${delCitizen.id}';
      `);
      expect(profile[0]?.deleted).toBe(true);
      expect(profile[0]?.display_name).toBe("บัญชีที่ขอลบแล้ว");
      // คำขอ → confirmed + confirmed_at
      const reqRow = await psqlRows<{ status: string; confirmed: boolean }>(`
        select status::text, confirmed_at is not null as confirmed
          from public.account_deletion_requests where id = '${requestId}';
      `);
      expect(reqRow[0]?.status).toBe("confirmed");
      expect(reqRow[0]?.confirmed).toBe(true);
      // audit PROFILE_DELETE — retention_note ตาม registry §2.2
      const audits = await psqlRows<{ note: string | null; actor: string | null }>(`
        select context ->> 'retention_note' as note, actor_user_id::text as actor
          from public.audit_logs
         where action = 'PROFILE_DELETE' and entity_id::text = '${delCitizen.id}';
      `);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.note ?? "").toContain("เก็บผลการสอบ");
      expect(audits[0]?.actor).toBe(delCitizen.id);

      // single-use — token เดิมยืนยันซ้ำ → token_used
      const reuse = await svcRpc("confirm_account_deletion", {
        p_token: deletionToken,
        p_request_id: crypto.randomUUID(),
      });
      expect(reuse.status, reuse.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((reuse.json ?? {}) as { message?: string }).message ?? "").toContain("token_used");

      // token แปลก (ผ่านรูป 43 อักขระ แต่ไม่เคยออก) → ปฏิเสธ · gate p5-r1 B2:
      // errcode เปลี่ยน P0002 → 22023 (ขนส่งเท่านั้น — P0002 โดน gateway ตัด
      // ร่างกาย error) แท็ก ERR-NF-001|token_not_found จึงมาถึงผู้เรียกได้จริง —
      // เงื่อนไขเดียวที่หน้า UI เลือกการ์ด "ลิงก์ไม่ถูกต้อง" แทน system_error
      const stranger = await svcRpc("confirm_account_deletion", {
        p_token: "Z".repeat(43),
        p_request_id: crypto.randomUUID(),
      });
      expect(stranger.status, stranger.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((stranger.json ?? {}) as { message?: string }).message ?? "").toContain(
        "token_not_found",
      );

      // หมดอายุ — seed คำขอของ delExpired ตรง (RPC ออก token ยังพังที่ search_path —
      // เคส e) โดยตั้ง expires_at ย้อนหลัง 1 ชั่วโมงตั้งแต่ตอน insert
      const expiredToken = randomBytes(32).toString("base64url");
      await psql(`
        insert into public.account_deletion_requests (user_id, token_hash, expires_at)
        values ('${delExpired.id}', '${await sha256Hex(expiredToken)}',
                now() - interval '1 hour');
      `);
      const expired = await svcRpc("confirm_account_deletion", {
        p_token: expiredToken,
        p_request_id: crypto.randomUUID(),
      });
      expect(expired.status, expired.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(((expired.json ?? {}) as { message?: string }).message ?? "").toContain(
        "token_expired",
      );
      // แถวคำขอหมดอายุยัง pending (ไม่ถูกแตะ — backstop WHERE pending AND expires > now)
      const expiredStatus = await psqlScalar(`
        select status::text from public.account_deletion_requests
         where user_id = '${delExpired.id}' order by requested_at desc limit 1;
      `);
      expect(expiredStatus).toBe("pending");
    }, 60_000);
  },
);
