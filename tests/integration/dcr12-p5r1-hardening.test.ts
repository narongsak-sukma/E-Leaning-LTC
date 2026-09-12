/**
 * DCR-12 — integration tests ของ fix wave codex gate p5-r1 (BLOCKER 1-7 + M1)
 * บน dev stack จริง — ระดับ DB (RPC ผ่าน REST + psql) และ "หน้า HTML จริง"
 * ผ่าน container app (:3000) ตามแบบ suite DCR-10/DCR-11:
 *   g) B3 (ฝั่ง SQL): request → claim → complete → event → tick จริง → แถว
 *      email_outbox template data_export.ready โดย vars มี "ตัวระบุ" เท่านั้น
 *      (full_name + job_id + file_media_id) — ไม่มี download_url (signed URL
 *      604800s ผู้กลาง email worker ลงนามจาก media_assets — พิสูจน์คู่ unit tests)
 *   a) B1: my_request_account_deletion คืน userId ของผู้ขอจริง (คีย์ที่ BFF
 *      ใช้ผูกเจ้าของอีเมล confirm — เดิมคืน requestId ตัวเดียว)
 *   b) B2: เปิดลิงก์จากอีเมล /profile/delete/confirm?token=… ผ่าน HTTP จริง
 *      "โดยไม่มี session ใด ๆ" → 200 + การ์ดยืนยันสำเร็จภาษาไทย + บัญชีถูก
 *      soft-delete จริง · token ผิด → การ์ดลิงก์ไม่ถูกต้อง (generic)
 *   c) B5: ถอนสองบทบาทสุดท้ายของบัญชี "พร้อมกัน" (สอง TX ขนาน) — advisory lock
 *      ltc:account:roles ทำให้ผ่านด่าน last_role ได้รายการเดียว · อีกรายการ
 *      กลิ้งกลับ (ERR-VAL-001|last_role) และบัญชียังเหลือบทบาทใช้งาน 1
 *   d) B6: ขอลบ → ได้บทบาท instructor ระหว่างอายุ token → confirm เจอ SoD
 *      re-check ใต้ lock เดียวกัน → sod_role_changed กลิ้ง "ทั้ง TX" —
 *      บัญชีอยู่ครบ คำขอยัง pending · ถอนบทบาทกลับ → token "เดิม" ยืนยันผ่าน
 *   e) B7: claim ตั้ง claimed_at (lease) · เวลาผ่าน 11 นาที (จำลอง worker
 *      ตายกลางทาง) → claim ถัดไปยึดงานคืนได้ + lease ใหม่ (ไม่ติด processing
 *      ตลอดกาล)
 *   f) B4: admin_audit_user_created / admin_set_user_active (0038) — audit
 *      USER_CREATE + USER_DISABLE/USER_UPDATE เป็นแถว audit_logs จริง พร้อม
 *      actor (aal2 super_admin) + reason ใน context · mutation+audit ของ
 *      set_user_active จบใน TX เดียว (profiles.is_active ตามจริง) · session
 *      ยัง aal1 → guard ปฏิเสธ mfa_required ก่อนแตะข้อมูลใด ๆ
 *
 * การแยกโลกของ suite (แบบ DCR-10/DCR-11):
 *   - เนมสเปซ id ตายตัว e17 (cccccccc-…-e17a00000001 สำหรับ media ของเคส g) ·
 *     ผู้ใช้ทดสอบ email prefix 'dcr12-p5r1-%'
 *   - pg_cron จริง 4 ตัวถูกพักช่วงรัน (กัน tick กลืน event ของเคส g) + หยุด
 *     container mailer (ยิง email-dispatch/pdpa-export ทุก 30 วินาที — pdpa-export
 *     จะ claim งาน export ของเคส g/e ไปก่อน) — ตั้งคืนทั้งคู่ใน afterAll finally
 *   - cleanup tracked-first ตามลำดับ FK · audit_logs คงไว้ (append-only ตามดีไซน์)
 *   - ห้าม log token ลบบัญชี/JWT ใน output ใด ๆ (D24 — token เป็น secret)
 *   - เคส b ต้องการ container app (:3000) — ไม่มี = ctx.skip() เฉพาะเคสนั้น
 *     (สแตกบางสภาพรันแค่ db+kong สำหรับ DB-level suites)
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

const DB_URL = process.env.TEST_DATABASE_URL;

/** container app (next dev — hot reload ผ่าน volume mount) · เคส b ใช้ */
const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

// ─── id ตายตัวของ fixture ชุดนี้ (เนมสเปซ e17) ─────────────────────────────────

/** media ผลลัพธ์ของเคส g (บักเก็ต pdpa-exports — สัญญาเดียวกับ complete RPC) */
const E17_MEDIA_DONE = "cccccccc-cccc-4ccc-8ccc-e17a00000001";

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ─────────────────────────────────────────────────

let exportMail: TestUser; // เคส g — export เต็มสายจนถึงแถว email_outbox
let delOwner: TestUser; // เคส a — RPC คืน userId
let delPage: TestUser; // เคส b — ยืนยันผ่านหน้า HTML จริง
let delSoD: TestUser; // เคส d — SoD re-check ใน confirm TX
let exportLease: TestUser; // เคส e — lease/reclaim ของ claim
let revokeUser: TestUser; // เคส c — citizen + staff:viewer พอดีสองบทบาท
let auditTarget: TestUser; // เคส f — เป้าหมาย USER_CREATE/USER_DISABLE/USER_UPDATE
let adminSA: TestUser; // เคส c/f — super_admin (aal2 สำหรับ admin RPC)

/** session aal2 จริงของ adminSA (mint ครั้งเดียวใน beforeAll — ใช้ร่วมเคส c/f) */
let adminAal2 = "";

/** container app เข้าถึงได้หรือไม่ (probe ใน beforeAll — เคส b ctx.skip เมื่อไม่มี) */
let appReachable = false;

interface JobResult {
  readonly jobId: string | null;
  readonly userId?: string;
  readonly status?: string;
}

function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริง — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

const execFileAsync = promisify(execFile);

/** ข้อความ error ของ RPC ผ่าน gateway (มีแท็ก ERR-…|tag ติดมาเสมอ) */
function rpcMessage(res: RestResult): string {
  return ((res.json ?? {}) as { message?: string }).message ?? "";
}

/** run marker ต่อรอบ — ตัวอักษร a-f เท่านั้น: hex ทั่วไปมีโอกาส ~16% เกิด
 *  digit-run ≥6 ซึ่งชน้ด่าน PII (license_no) ของ audit_free_text_ok ใน reason */
function runMarker(): string {
  const letters = crypto.randomUUID().replace(/[^a-f]/g, "");
  return (letters + "abcdef").slice(0, 6);
}

/** หยุด container mailer (ยิง email-dispatch + pdpa-export ทุก 30 วินาที —
 *  pdpa-export จะ claim งานของเคส g/e ไปก่อน) ช่วงรัน suite */
async function stopMailer(): Promise<void> {
  await execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
}

/** สตาร์ต mailer คืน (finally — ไม่ทิ้ง dev stack หยุดค้าง) */
async function startMailer(): Promise<void> {
  await execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
}

/** พัก cron จริง 4 ตัวช่วงรัน (idempotent) — tick กิน event data_export.ready ของเคส g */
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

/** ล้างโลกของ suite ทั้งชุด — scope ด้วย email prefix (idempotent แม้รอบก่อนพัง
 *  กลางทาง · เรียงตาม FK — RESTRICT) · audit_logs เป็น append-only ตามดีไซน์ —
 *  ตั้งใจคงไว้ (เคส c/f นับแถวด้วย entity_id ของผู้ใช้สดต่อรอบจึง deterministic) */
async function cleanupE17World(): Promise<void> {
  // object ใน bucket อยู่นอก TX ของ DB — ลบแยก (best-effort กันสะสมข้ามรอบ)
  try {
    await restCall(
      "DELETE",
      `/storage/v1/object/pdpa-exports/dcr12/${E17_MEDIA_DONE}.json`,
      { apiKey: SERVICE_KEY, token: SERVICE_KEY },
    );
  } catch {
    // สแตกยังไม่พร้อม/ลบไปแล้ว — ไม่ขัดข้องของ suite
  }
  await psql(`
    delete from public.event_outbox
     where payload ->> 'user_id' in (select id::text from auth.users where email like 'dcr12-p5r1-%');
    create temp table _e17_notif as
      select distinct nr.notification_id as id
        from public.notification_recipients nr
       where nr.user_id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from public.notification_recipients
     where user_id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from public.email_outbox
     where recipient_user_id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from public.notifications where id in (select id from _e17_notif);
    delete from public.data_export_jobs
     where user_id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from public.account_deletion_requests
     where user_id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from public.media_assets where id = '${E17_MEDIA_DONE}';
    delete from public.role_assignments
     where user_id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from public.profiles
     where id in (select id from auth.users where email like 'dcr12-p5r1-%');
    delete from auth.users where email like 'dcr12-p5r1-%';
  `);
}

/**
 * claim จนกว่าจะได้งานของ suite — งานกำพร้า (รอบก่อนพังกลางทาง/cleanup ไม่ทัน)
 * ถูกปิดด้วย fail เพื่อไม่บังลำดับคิวของเคส · คิวว่างก่อนเจองานตัวเอง = fail-loud
 */
async function claimUntilJob(jobId: string): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const claim = await svcRpc("claim_data_export_job", {});
    expect(claim.status, claim.text.slice(0, 300)).toBe(200);
    const got = (claim.json as JobResult).jobId;
    if (got === jobId) {
      return;
    }
    if (got === null) {
      throw new Error(`claim ไม่พบงานของ suite ในคิว (งานหายก่อนถูก claim)`);
    }
    await svcRpc("fail_data_export_job", {
      p_job_id: got,
      p_error: "dcr12-p5r1-orphan-cleanup",
    });
  }
  throw new Error("claim ไม่พบงานของ suite ภายใน 10 รอบ (คิวพร้ามากผิดปกติ)");
}

describe.skipIf(!DB_URL)(
  "DCR-12 gate p5-r1 fixes (export email vars · userId · หน้ายืนยันสาธารณะ · last_role ขนาน · SoD ใน confirm · lease reclaim · audit USER_* durable)",
  () => {
    beforeAll(async () => {
      await cleanupE17World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
      await pauseCrons(); // พัก cron จริงช่วงรัน (ตั้งคืนใน afterAll finally)
      await stopMailer(); // หยุด dev worker (claim export/ส่งเมล์ทุก 30 วินาที)
      exportMail = await createTestUser("dcr12-p5r1-exportmail", "citizen");
      delOwner = await createTestUser("dcr12-p5r1-owner", "citizen");
      delPage = await createTestUser("dcr12-p5r1-page", "citizen");
      delSoD = await createTestUser("dcr12-p5r1-sod", "citizen");
      exportLease = await createTestUser("dcr12-p5r1-lease", "citizen");
      revokeUser = await createTestUser("dcr12-p5r1-revoke", "staff:viewer");
      auditTarget = await createTestUser("dcr12-p5r1-target", "citizen");
      adminSA = await createTestUser("dcr12-p5r1-admin", "super_admin");
      adminAal2 = await mintAal2Token(adminSA);
      // probe container app — ไม่มี = เคส b ctx.skip (ไม่พังทั้ง suite)
      try {
        const probe = await fetch(APP_URL, { signal: AbortSignal.timeout(5_000) });
        appReachable = probe.status < 500;
      } catch {
        appReachable = false;
      }
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

    // ─── เคส g: export เต็มสาย → event → tick → email_outbox (B3 ฝั่ง SQL) ────

    it("เคส g complete → event data_export.ready → tick จริง → email_outbox vars ส่งตัวระบุเท่านั้น (job_id+file_media_id ไม่มี download_url — worker ลงนามเอง)", async () => {
      const res = await userRpc("my_request_data_export", exportMail.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const jobId = (res.json as JobResult).jobId ?? "";
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
      await claimUntilJob(jobId);
      // media ผลลัพธ์ — สัญญาเดียวกับเคส c ของ DCR-11 (worker อัปโหลดก่อนเรียก RPC)
      await psql(`
        insert into public.media_assets
          (id, provider, media_type, bucket, storage_path, mime_type, size_bytes, status, uploaded_by)
        values
          ('${E17_MEDIA_DONE}', 'supabase_storage', 'document', 'pdpa-exports',
           'pdpa-exports/dcr12/${E17_MEDIA_DONE}.json', 'application/json', 2048, 'ready',
           '${exportMail.id}')
        on conflict (id) do nothing;
      `);
      // worker จริงอัปโหลดไฟล์ JSON ก่อนเสมอ (0036 §11) — ไม่มี object จริง =
      // createSignedUrl ล้ม (storage ตรวจ object ตอนลงนาม) → เมล์ fail ก่อนส่ง
      const upload = await restCall(
        "POST",
        `/storage/v1/object/pdpa-exports/dcr12/${E17_MEDIA_DONE}.json`,
        { apiKey: SERVICE_KEY, token: SERVICE_KEY },
        { job_id: jobId, user_id: exportMail.id, suite: "dcr12-p5r1-g" },
      );
      expect(upload.status, upload.text.slice(0, 300)).toBe(200);
      const done = await svcRpc("complete_data_export_job", {
        p_job_id: jobId,
        p_file_media_id: E17_MEDIA_DONE,
        p_chunks: 2,
        p_request_id: crypto.randomUUID(),
      });
      expect(done.status, done.text.slice(0, 300)).toBe(200);
      expect((done.json as JobResult).status).toBe("done");
      // tick จริง (psql ตรง — สิทธิ์เดียวกับ pg_cron) แปลง event → notification +
      // email_outbox · data_export.ready เป็นธุรกรรมบังคับ (0036 §12) — แถวอีเมล
      // เกิดเสมอไม่ขึ้นกับ consent ของผู้ใช้
      await psql("select public.notification_dispatch_tick();");
      const rows = await psqlRows<{
        template_key: string;
        recipient: string;
        p_user: string;
        v_name: string | null;
        v_job: string | null;
        v_file: string | null;
        has_download_url: boolean;
      }>(`
        select template_key::text, recipient_user_id::text as recipient,
               payload ->> 'user_id' as p_user,
               payload -> 'vars' ->> 'full_name' as v_name,
               payload -> 'vars' ->> 'job_id' as v_job,
               payload -> 'vars' ->> 'file_media_id' as v_file,
               (payload -> 'vars') ? 'download_url' as has_download_url
          from public.email_outbox
         where template_key = 'data_export.ready'
           and payload -> 'vars' ->> 'job_id' = '${jobId}';
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipient).toBe(exportMail.id); // เจ้าของ = ผู้ยื่นจริง
      expect(rows[0]?.p_user).toBe(exportMail.id);
      expect(rows[0]?.v_name ?? "").not.toBe(""); // full_name สำหรับ render template
      expect(rows[0]?.v_job).toBe(jobId);
      expect(rows[0]?.v_file).toBe(E17_MEDIA_DONE);
      // สัญญา B3: SQL ผู้ผลิตส่ง "ตัวระบุ" เท่านั้น — URL ลงนาม 7 วันเกิดที่ worker
      expect(rows[0]?.has_download_url).toBe(false);
      // event ปิดจบ (processed — ไม่ค้าง retry)
      const ev = await psqlScalar(`
        select status::text from public.event_outbox
         where topic = 'data_export.ready' and payload ->> 'job_id' = '${jobId}';
      `);
      expect(ev).toBe("processed");
      // ส่งจริงผ่าน internal route (สัญญา worker จริง) → sent · M1: ลิงก์ bearer ถูก
      // ถอดออกจาก payload อะตอมกับเปลี่ยนสถานะ · B3: URL ลงนาม 604800s ปรากฏใน
      // เนื้อเมล์ (อ่านจาก Mailpit) ไม่ใช่ในแถวที่เก็บ — กันซ้ำ regression NULL-concat
      // ของ redaction (dcr10 เคส 1 เคยจับ complete พังทั้งคิวทำทุกแถวติด sending)
      const cronSecret = process.env.CRON_SECRET ?? "";
      expect(cronSecret.length, "CRON_SECRET ไม่พบใน env ของรัน").toBeGreaterThan(0);
      const dispatch = await fetch("http://localhost:3000/api/internal/jobs/email-dispatch", {
        method: "POST",
        headers: { "x-cron-secret": cronSecret },
        signal: AbortSignal.timeout(30_000),
      });
      expect(dispatch.status, (await dispatch.text()).slice(0, 300)).toBe(200);
      const sentRow = await psqlRows<{
        status: string;
        last_error: string | null;
        has_download: boolean;
        vars_download: string | null;
      }>(`
        select status::text, last_error,
               (payload -> 'vars') ? 'download_url' as has_download,
               payload -> 'vars' ->> 'download_url' as vars_download
          from public.email_outbox
         where template_key = 'data_export.ready'
           and payload -> 'vars' ->> 'job_id' = '${jobId}';
      `);
      expect(
        sentRow[0]?.status,
        `dispatch แล้วแถวไม่ sent (last_error="${sentRow[0]?.last_error ?? ""}")`,
      ).toBe("sent");
      // B3: ลิงก์ไม่เคยหยุดพักใน DB — worker ลงนาม "ในหน่วยความจำ" ตอน render เท่านั้น
      // แถวหลังส่งจึงไม่มี download_url เลย (sentinel [redacted-after-send] ของ M1
      // เป็นหน้าที่ของลิงก์ที่ persist ตอน enqueue เช่น confirm_url — dcr10 เคส 1 เฝ้า)
      expect(sentRow[0]?.has_download).toBe(false);
      expect(sentRow[0]?.vars_download).toBeNull();
      // ปลายทางจริงของ B3 — เนื้อเมล์ (Mailpit) ต้องมี signed URL ของ object นี้
      // (host ของลิงก์ตาม SUPABASE_URL ใน container = kong:8000 — dev เท่านั้น ·
      // assert เป็น path ล้วนจึงผ่านทั้ง host view และ container view)
      const mailList = (await (
        await fetch("http://localhost:8025/api/v1/messages?limit=50")
      ).json()) as {
        messages: readonly {
          ID: string;
          To: readonly { Address: string }[];
          Subject: string;
        }[];
      };
      const signedKey = `/object/sign/pdpa-exports/dcr12/${E17_MEDIA_DONE}.json`;
      let mailText: string | null = null;
      for (const m of mailList.messages.filter((x) =>
        x.To.some((to) => to.Address === exportMail.email),
      )) {
        const full = (await (
          await fetch(`http://localhost:8025/api/v1/message/${m.ID}`)
        ).json()) as { Text: string };
        if (full.Text.includes("object/sign/pdpa-exports/")) {
          mailText = full.Text;
          break;
        }
      }
      expect(mailText, "ไม่พบจดหมาย export พร้อมลิงก์ที่ Mailpit ของ exportMail").not.toBeNull();
      expect(
        mailText?.includes(signedKey),
        `เนื้อเมล์ขาด signed URL ของ object นี้ (${signedKey})`,
      ).toBe(true);
    }, 45_000);

    // ─── เคส a: RPC ขอลบบัญชีคืน userId ของผู้ขอ (B1) ──────────────────────────

    it("เคส a my_request_account_deletion คืน userId ของผู้ขอจริง (B1 — คีย์ที่ BFF ผูกเจ้าของอีเมล confirm)", async () => {
      const res = await userRpc("my_request_account_deletion", delOwner.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as {
        requestId: string;
        token: string;
        expiresAt: string;
        userId: string;
      };
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      // ตัวชี้ขาดของ fix: RPC บอกตัวตนเจ้าของคำขอ — BFF เอาไป lookup profiles +
      // recipient_user_id + payload.user_id (เดิมได้แค่ requestId ซึ่งเป็น id ของ
      // "คำขอ" ไม่ใช่ "ผู้ใช้")
      expect(body.userId).toBe(delOwner.id);
      // แถวคำขอเป็นของผู้ขอจริง (เจ้าของเดียวกันทั้ง return และ row)
      const owner = await psqlScalar(`
        select user_id::text from public.account_deletion_requests
         where id = '${body.requestId}';
      `);
      expect(owner).toBe(delOwner.id);
    }, 45_000);

    // ─── เคส b: เปิดลิงก์ยืนยันจากอีเมลแบบไม่มี session (B2) ───────────────────

    it("เคส b GET /profile/delete/confirm?token=… ไม่มี session → 200 การ์ดยืนยันสำเร็จ + บัญชีถูกลบจริง · token ผิด → การ์ดลิงก์ไม่ถูกต้อง (B2)", async (ctx) => {
      if (!appReachable) {
        return ctx.skip();
      }
      // token จริงจาก RPC (คืนทาง return ครั้งเดียว — สิ่งเดียวที่อีเมลใส่ลิงก์ไป)
      const res = await userRpc("my_request_account_deletion", delPage.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const token = (res.json as { token: string }).token;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // เปิดหน้าแบบผู้ใช้ที่คลิกลิงก์จากอีเมล — ไม่มี cookie/session ใด ๆ เลย
      const page = await fetch(
        `${APP_URL}/profile/delete/confirm?token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(60_000) }, // next dev compile route ตอนเปิดครั้งแรก
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("ยืนยันการลบบัญชีสำเร็จ");
      // ผลยืนยันจริงที่ DB — soft-delete + ซ่อนชื่อ (สัญญาเดียวกับ confirm ผ่าน RPC)
      const profile = await psqlRows<{ deleted: boolean; display_name: string | null }>(`
        select deleted_at is not null as deleted, display_name
          from public.profiles where id = '${delPage.id}';
      `);
      expect(profile[0]?.deleted).toBe(true);
      expect(profile[0]?.display_name).toBe("บัญชีที่ขอลบแล้ว");
      // token ผิด (ผ่านรูป 43 อักขระ แต่ไม่เคยออก) — การ์ด generic ไม่เฉลยสถานะ
      const wrong = await fetch(`${APP_URL}/profile/delete/confirm?token=${"Z".repeat(43)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      expect(wrong.status).toBe(200);
      const wrongHtml = await wrong.text();
      expect(wrongHtml).toContain("ลิงก์ไม่ถูกต้องหรือหมดอายุ");
      expect(wrongHtml).not.toContain("ยืนยันการลบบัญชีสำเร็จ");
    }, 90_000);

    // ─── เคส c: ถอนสองบทบาทสุดท้ายพร้อมกัน (B5) ───────────────────────────────

    it("เคส c ถอนสองบทบาทสุดท้ายขนานกัน (B5): advisory lock ให้ผ่านรายการเดียว — อีกรายการ last_role กลิ้งทั้ง TX และบัญชียังเหลือบทบาท 1", async () => {
      // fixture: citizen (จาก trigger ตอน signup) + staff:viewer = 2 พอดี
      const activeBefore = await psqlScalar(`
        select count(*)::text from public.role_assignments
         where user_id = '${revokeUser.id}' and revoked_at is null;
      `);
      expect(activeBefore).toBe("2");
      expect(adminAal2).not.toBe("");
      const run = runMarker();
      const reason = `ทดสอบการถอนคู่ขนานสองบทบาทสุดท้ายของบัญชี (DCR-12 เคส c #${run})`;
      // สอง TX ขนานจริง (สอง request แยกกันผ่าน Kong) — ไม่มี lock ทั้งคู่จะเห็น
      // "อีกบทบาทยังอยู่" พร้อมกันแล้ว commit ทั้งคู่ → บัญชีไร้บทบาท
      const [ra, rb] = await Promise.all([
        userRpc("admin_revoke_role", adminAal2, {
          p_user_id: revokeUser.id,
          p_role: "citizen",
          p_reason: reason,
          p_request_id: crypto.randomUUID(),
        }),
        userRpc("admin_revoke_role", adminAal2, {
          p_user_id: revokeUser.id,
          p_role: "staff:viewer",
          p_reason: reason,
          p_request_id: crypto.randomUUID(),
        }),
      ]);
      const ok = [ra, rb].filter((r) => r.status === 200);
      const lost = [ra, rb].filter((r) => r.status >= 400);
      expect(
        ok,
        `ต้องสำเร็จรายการเดียว (ได้ ${ra.status}/${rb.status} · A="${rpcMessage(ra).slice(0, 200)}" · B="${rpcMessage(rb).slice(0, 200)}")`,
      ).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(rpcMessage(lost[0] ?? ra)).toContain("last_role");
      // บัญชียังมีบทบาทใช้งาน 1 (ไม่มีทางไร้บทบาท — DD §3.1)
      const activeAfter = await psqlScalar(`
        select count(*)::text from public.role_assignments
         where user_id = '${revokeUser.id}' and revoked_at is null;
      `);
      expect(activeAfter).toBe("1");
      // audit ROLE_REVOKE เกิดรายการเดียว (TX ที่แพ้กลิ้งกลับทั้งหมด) — scope ด้วย
      // reason ของรอบนี้กันนับซ้ำจากรอบก่อน (audit_logs เป็น append-only)
      const revokes = await psqlScalar(`
        select count(*)::text from public.audit_logs
         where action = 'ROLE_REVOKE' and entity_id::text = '${revokeUser.id}'
           and context ->> 'reason' like '%${run}%';
      `);
      expect(revokes).toBe("1");
    }, 45_000);

    // ─── เคส d: SoD re-check ใน TX ของ confirm (B6) ────────────────────────────

    it("เคส d ได้บทบาท instructor หลังยื่นคำขอ (B6): confirm → sod_role_changed กลิ้งทั้ง TX (บัญชีอยู่ครบ · คำขอ pending) · ถอนบทบาทกลับ → token เดิมยืนยันผ่าน", async () => {
      const res = await userRpc("my_request_account_deletion", delSoD.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const body = res.json as { requestId: string; token: string };
      expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // ระหว่างอายุ token ผู้ใช้ได้บทบาท instructor (ช่องทาง admin ปกติ — SoD
      // ต้องตัดสิน "ตอนกดยืนยัน" ไม่ใช่ตอนยื่น)
      await assignRole(delSoD.id, "instructor");
      const blocked = await svcRpc("confirm_account_deletion", {
        p_token: body.token,
        p_request_id: crypto.randomUUID(),
      });
      expect(blocked.status, blocked.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(rpcMessage(blocked)).toContain("sod_role_changed");
      // TX กลิ้งทั้งหมด — บัญชี คำขอ และ token ไม่ถูกแตะสักค่า
      const deleted = await psqlScalar(`
        select (deleted_at is null)::text from public.profiles where id = '${delSoD.id}';
      `);
      expect(deleted).toBe("true");
      const reqRow = await psqlRows<{ status: string; unconfirmed: boolean }>(`
        select status::text, (confirmed_at is null) as unconfirmed
          from public.account_deletion_requests where id = '${body.requestId}';
      `);
      expect(reqRow[0]?.status).toBe("pending");
      expect(reqRow[0]?.unconfirmed).toBe(true);
      // ถอนบทบาทกลับ → token "เดิม" ยืนยันผ่าน (single-use ยังไม่ถูกใช้ — rollback
      // เกิดก่อน UPDATE token ตามลำดับใน TX)
      await psql(`
        delete from public.role_assignments
         where user_id = '${delSoD.id}' and role = 'instructor';
      `);
      const ok = await svcRpc("confirm_account_deletion", {
        p_token: body.token,
        p_request_id: crypto.randomUUID(),
      });
      expect(ok.status, ok.text.slice(0, 300)).toBe(200);
      expect((ok.json as { confirmed: boolean }).confirmed).toBe(true);
    }, 60_000);

    // ─── เคส e: lease/reclaim ของ claim (B7) ───────────────────────────────────

    it("เคส e claim ตั้ง claimed_at · worker ตาย 11 นาที → claim ถัดไปยึดงานคืน + lease ใหม่ (B7 — ไม่ติด processing ตลอดกาล)", async () => {
      const res = await userRpc("my_request_data_export", exportLease.accessToken, {
        p_request_id: crypto.randomUUID(),
      });
      expect(res.status, res.text.slice(0, 300)).toBe(200);
      const jobId = (res.json as JobResult).jobId ?? "";
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
      await claimUntilJob(jobId);
      // lease ถูกตั้งจริงตอน claim (คอลัมน์ใหม่ของ fix — ไม่มี = งานตายกลางทางแล้ว
      // คิวหมดตลอดกาล)
      const lease1 = await psqlScalar(`
        select (claimed_at is not null)::text from public.data_export_jobs
         where id = '${jobId}';
      `);
      expect(lease1).toBe("true");
      // จำลอง worker ตายกลางทาง — เลยหน้าต่าง reclaim 10 นาทีแล้ว 1 นาที
      await psql(`
        update public.data_export_jobs set claimed_at = now() - interval '11 minutes'
         where id = '${jobId}';
      `);
      const reclaim = await svcRpc("claim_data_export_job", {});
      expect(reclaim.status, reclaim.text.slice(0, 300)).toBe(200);
      expect((reclaim.json as JobResult).jobId).toBe(jobId); // ยึดงานเดิมคืน
      const lease2 = await psqlScalar(`
        select (claimed_at > now() - interval '1 minute')::text
          from public.data_export_jobs where id = '${jobId}';
      `);
      expect(lease2).toBe("true"); // lease ใหม่สำหรับ worker ที่ยึดคืน
      // ปิดงานไม่ทิ้งคิวค้าง
      const fail = await svcRpc("fail_data_export_job", {
        p_job_id: jobId,
        p_error: "dcr12-p5r1-case-e-close",
      });
      expect(fail.status, fail.text.slice(0, 300)).toBe(200);
    }, 45_000);

    // ─── เคส f: audit USER_* durable ผ่าน RPC 0038 (B4) ───────────────────────

    it("เคส f admin_audit_user_created + admin_set_user_active (0038): แถว audit_logs จริง actor+reason · mutation+audit จบ TX เดียว · aal1 → mfa_required", async () => {
      expect(adminAal2).not.toBe("");
      const run = runMarker();
      const reason = `แต่งตั้งเจ้าหน้าที่ฝ่ายรายงานประจำวัน (DCR-12 เคส f #${run})`;
      // 1) USER_CREATE — durable ผ่าน append_audit_event_internal (allowlist ของ
      //    wrapper ปฏิเสธ USER_* ทุกครั้ง — นี่คือทางเดียวที่เขียนได้จริง)
      const created = await userRpc("admin_audit_user_created", adminAal2, {
        p_target_user_id: auditTarget.id,
        p_role: "staff:viewer",
        p_reason: reason,
        p_request_id: crypto.randomUUID(),
      });
      expect(created.status, created.text.slice(0, 300)).toBe(200);
      expect(created.json).toEqual({
        userId: auditTarget.id,
        role: "staff:viewer",
        audited: true,
      });
      const uc = await psqlRows<{
        actor: string;
        target: string;
        role: string;
        reason: string;
      }>(`
        select actor_user_id::text as actor, context ->> 'target_user_id' as target,
               context ->> 'role' as role, context ->> 'reason' as reason
          from public.audit_logs
         where action = 'USER_CREATE' and entity_id::text = '${auditTarget.id}';
      `);
      expect(uc).toHaveLength(1);
      expect(uc[0]?.actor).toBe(adminSA.id);
      expect(uc[0]?.target).toBe(auditTarget.id);
      expect(uc[0]?.role).toBe("staff:viewer");
      expect(uc[0]?.reason ?? "").toContain(run);
      // 2) ปิดใช้งาน — profiles.is_active=false + audit USER_DISABLE ใน TX เดียว
      const offReason = `ปิดใช้งานชั่วคราวเนื่องจากอยู่ระหว่างตรวจสอบข้อมูลสมาชิก (DCR-12 เคส f #${run})`;
      const off = await userRpc("admin_set_user_active", adminAal2, {
        p_target_user_id: auditTarget.id,
        p_is_active: false,
        p_reason: offReason,
        p_request_id: crypto.randomUUID(),
      });
      expect(off.status, off.text.slice(0, 300)).toBe(200);
      expect(off.json).toEqual({ userId: auditTarget.id, isActive: false });
      const offState = await psqlScalar(`
        select is_active::text from public.profiles where id = '${auditTarget.id}';
      `);
      expect(offState).toBe("false");
      const ud = await psqlRows<{ actor: string; reason: string }>(`
        select actor_user_id::text as actor, context ->> 'reason' as reason
          from public.audit_logs
         where action = 'USER_DISABLE' and entity_id::text = '${auditTarget.id}';
      `);
      expect(ud).toHaveLength(1);
      expect(ud[0]?.actor).toBe(adminSA.id);
      expect(ud[0]?.reason ?? "").toContain(run);
      // 3) เปิดคืน (ไม่บังคับ reason) — USER_UPDATE + is_active กลับ true
      const on = await userRpc("admin_set_user_active", adminAal2, {
        p_target_user_id: auditTarget.id,
        p_is_active: true,
        p_reason: null,
        p_request_id: crypto.randomUUID(),
      });
      expect(on.status, on.text.slice(0, 300)).toBe(200);
      const onState = await psqlScalar(`
        select is_active::text from public.profiles where id = '${auditTarget.id}';
      `);
      expect(onState).toBe("true");
      const uu = await psqlRows<{ actor: string }>(`
        select actor_user_id::text as actor from public.audit_logs
         where action = 'USER_UPDATE' and entity_id::text = '${auditTarget.id}';
      `);
      expect(uu).toHaveLength(1);
      expect(uu[0]?.actor).toBe(adminSA.id);
      // 4) session ยัง aal1 → guard ปฏิเสธก่อนแตะอะไรใด ๆ (mfa_required) และ
      //    ไม่ก่อแถว audit ซ้ำ
      const aal1 = await userRpc("admin_set_user_active", adminSA.accessToken, {
        p_target_user_id: auditTarget.id,
        p_is_active: false,
        p_reason: offReason,
        p_request_id: crypto.randomUUID(),
      });
      expect(aal1.status, aal1.text.slice(0, 300)).toBeGreaterThanOrEqual(400);
      expect(rpcMessage(aal1)).toContain("mfa_required");
      const udCount = await psqlScalar(`
        select count(*)::text from public.audit_logs
         where action = 'USER_DISABLE' and entity_id::text = '${auditTarget.id}';
      `);
      expect(udCount).toBe("1");
    }, 60_000);
  },
);
