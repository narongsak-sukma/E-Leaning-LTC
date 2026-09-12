/**
 * DCR-10 — integration tests ของ Wave E Phase 4 ระบบแจ้งเตือน (NTF) บน dev stack จริง
 * (migration 0034_notifications.sql — แผน §6 เคส 1..12 + gate r1 เคส 13..15):
 *   1) สอบผ่าน (RPC จริง start→save→submit) ผู้ใช้ grant email_notify ก่อน → event
 *      exam.result pending → notification_dispatch_tick() (psql ตรง) → in_app 1 แถว
 *      (severity success · title มี "สอบผ่าน") + email_outbox 1 แถว queued
 *      (template exam.result.passed · payload มี notification_id) + notification_recipients
 *      ช่องทาง email sent_at null → dispatch จริง POST /api/internal/jobs/email-dispatch
 *      (x-cron-secret) → 200 · outbox sent + sent_at · recipients email sent_at set →
 *      Mailpit มีจดหมาย Subject มี "ผลการสอบ" และ "ผ่าน" (UTF-8 ผ่าน API JSON)
 *   2) สอบไม่ผ่าน (ตอบถูก 1 จาก 2 = 50) → tick → in_app severity warning ·
 *      template exam.result.failed · body มี "50"
 *   3) fail-closed consent — ผู้ใช้ที่ไม่เคย grant email_notify สอบผ่าน → tick → in_app มี
 *      แต่ email_outbox ของเขา = 0 แถว (ไม่มีแถว consents = ปฏิเสธ ตาม D-p4-4)
 *   4) settings family email=false — grant consent → my_notification_settings_update
 *      ({certificate:{in_app:true,email:false}}) → ออกใบ → tick → in_app มี · อีเมล
 *      certificate ไม่มี (family exam.result ยังเข้าคิวตาม default) · รูปทรง
 *      my_notification_settings/_update ครบ 4 family merged defaults · patch กลับ true
 *   5) ออกใบ + เพิกถอน (svcRpc) — tick → สอง notification (certificate.issued +
 *      certificate.revoked) ref_type 'certificate' ทั้งคู่ (นายก fix A-2) · subject อีเมล
 *      เพิกถอน render แล้วมี "เลขที่" + cert_no
 *   6) credit.adjusted — registrar aal2 (mintAal2Token) admin_credit_adjust −1.25 → tick →
 *      notification topic credit.adjusted body มี "-1.25" · ref_type credit_ledger
 *   7) re-delivery — copy event exam.result ที่ processed แล้ว (topic+payload เดิม) → tick →
 *      already_notified ≥1 · จำนวน notification (topic,ref_id,user) คงเดิม
 *   8) poison — event exam.result user_id ไม่ใช่ uuid → tick รอด (skipped=false ·
 *      failed≥1) · แถว poison attempts=1 · last_error ไม่ว่าง · available_at > now() ·
 *      tick สองไม่เลือกซ้ำ (attempts คง 1) · ปิดเป็น processed เพื่อไม่ให้ค้าง
 *   9) template หาย — ปิด in_app exam.result.failed (superuser) → fail event ใหม่ → tick →
 *      event ล้ม last_error มี "template" · ไม่เกิด notification ใหม่ · เปิดคืนใน finally
 *  10) my_notifications — 3 notification จาก events จริง (tick ระหว่าง attempt เพื่อ
 *      created_at ต่างกัน — ลำดับ deterministic) · อ่านตัวกลางด้วย my_notification_read
 *      (idempotent — read_at คงเดิม) · คนอื่นอ่าน → ERR-NF-001 · unreadFirst +
 *      unread_count · pagination limit=2 เดินครบ 3 แถวแล้ว next_cursor null
 *  11) renewal_reminder_scan — cycle open +7/+30 วัน · lawyer ได้แจ้ง (ขาดอีก "12" หน่วย ·
 *      วันครบกำหนด DD/MM/พ.ศ.) · scan ซ้ำ = already ≥2 ไม่สร้างซ้ำ · citizen มี cycle →
 *      not_lawyer ไม่มี notification
 *  12) email backoff — ระบายคิวค้างด้วย worker จริงก่อน → insert email_outbox ตรง →
 *      email_claim_batch(5) (service_role) → email_complete ok:false ×5 รอบ (bypass เวลา
 *      ด้วย update scheduled_at) → attempts=5 status failed last_error มี smtp_test_fail
 *  13) crash reclaim (gate r1 M1) — insert outbox ตรง → claim → status 'sending' +
 *      lease = scheduled_at ในอนาคต → claim ซ้ำ "ไม่" ได้แถว (lease ยังมีชีวิต) →
 *      หมด lease (บังคับ scheduled_at ย้อนหลัง คงสถานะ sending — จำลอง worker ตาย) →
 *      claim ได้แถวเดิมกลับมา · attempts คงเดิม (reclaim ไม่นับเป็นความล้มเหลว)
 *  14) claim-time deny (gate r1 B2) — insert outbox ตรงของผู้ใช้ consent grant แล้ว →
 *      revoke email_notify ผ่าน RPC จริง → claim → แถว "ไม่" ถูกคืนให้ส่ง แต่ถูกปิด
 *      เป็น failed + last_error 'email_gate_denied_before_send' (grant→enqueue→
 *      revoke ต้องไม่ส่ง — รวมงาน retry ที่ค้างอยู่)
 *  15) ประตูรายช่องทาง (gate r1 B3 / NTF-005) — settings credit.in_app=false ·
 *      email=true → adjust → tick → notification เกิด (ที่เก็บเนื้อหา) แต่ "ไม่มี"
 *      แถว recipient in_app · my_notifications มองไม่เห็น (0 รายการ) · อีเมลยังเข้า
 *      คิว → ปิดครบทั้งสองช่องทาง → adjust ใหม่ → tick → skipped_no_channel ≥1 ·
 *      ไม่เกิดแถวใหม่ทั้งระบบ · event ปิดเป็น processed (ไม่ retry ตลอดไป)
 *
 * การแยกโลกของ suite (แบบ DCR-9):
 *   - เนมสเปซ id ตายตัว e14 (cccccccc-cccc-4ccc-8ccc-...e14...) ของตัวเอง — ไม่ยืม
 *     e12/f1f1f1f1/f3f3f3f3 โครง id ของชุดอื่น · ผู้ใช้ทดสอบ email prefix 'dcr10-notif-%'
 *   - cleanup tracked-first (id ที่รันนี้จดไว้) แล้วค่อยกวาด prefix — ลบตามลำดับ FK ·
 *     notifications/notification_recipients/email_outbox/consents/notification_settings ของ
 *     ผู้ใช้ของ suite ลบได้ตรง (ไม่ใช่ append-only) · event_outbox  scoped ด้วย user_id/
 *     source_id ของ attempts ตัวเอง · audit_logs คงไว้ตามดีไซน์ append-only
 *   - pg_cron จริง 4 ตัวถูกพักช่วงรัน (ltc-notification-dispatch ทุกนาที ·
 *     ltc-renewal-reminder · ltc-email-outbox-purge · ltc-credit-accrual) และตั้งคืน
 *     ตามนิยาม 0034 §9 / 0031 §10 ตัวอักษรเดียวใน afterAll(finally) — ตัวเลข deterministic
 *   - dev worker `mailer` (container loop ยิง email-dispatch ทุก 30 วินาที) ถูกหยุดช่วงรัน
 *     (docker compose stop mailer) แล้ว start คืนใน finally — เดียวกันกับการพัก cron:
 *     กัน worker จริงกลืนคิวอีเมลของ fixture ก่อนเทส assert สถานะ queued กลางทาง
 *   - ก่อน seed ระบายคิว 4 topic ให้หมด (tick จน quiet) เพื่อตัวเลข counter รายเคส
 *   - ห้าม log to_email/CRON_SECRET/JWT ใน output ใด ๆ ของ suite
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { mintAal2Token } from "./helpers-aal2.js";
import { jwtPayload, knownCorrectAnswers, STAFF_EXAM_DEMO_ID } from "./helpers-d8.js";

const execFileAsync = promisify(execFile);

const DB_URL = process.env.TEST_DATABASE_URL;

// ─── id ตายตัวของ fixture ชุดนี้ (เนมสเปซ e14 — ของ suite นี้แต่เพียงผู้เดียว) ────

/** หลักสูตรของ suite (published + is_public) — ใช้รอบสอบเร็วรอบเดียว */
const E14_COURSE = "cccccccc-cccc-4ccc-8ccc-e14c00000001";
/** รอบสอบเร็ว (2 โจทย์ 1 แต้ม · ผ่าน ≥70% = ต้องถูกทั้งคู่ · cooldown 0 · max 5) */
const E14_ASSESSMENT = "cccccccc-cccc-4ccc-8ccc-00000000e14a";
const E14_RULES_ID = "dddddddd-dddd-4ddd-8ddd-00000000e14a";
const E14_BANK = "eeeeeeee-eeee-4eee-8eee-00000000e14a";
/** โจทย์ 2 ข้อ (single_choice · เฉลย = ตัวเลือกลำดับ 1 — harness อ่านเฉลยจาก DB ตาม C-7) */
const E14_QUESTIONS = [
  "cccccccc-cccc-4ccc-8ccc-e14c00000011",
  "cccccccc-cccc-4ccc-8ccc-e14c00000012",
] as const;

/** ตัวเลือก 4 ตัวต่อข้อ — ล็อกรูป dddddddd-...-00e140000<ข้อ><ลำดับ> (เนมสเปซ e14 ของตัวเอง —
 *  ไม่ยืม f0f0f0f0/f3f3f3f3 ของชุด D-9) */
function optionId(questionKey: string, optionNo: number): string {
  return `dddddddd-dddd-4ddd-8ddd-00e140000${questionKey}${optionNo}`;
}

interface QuestionSeed {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly correct: string;
  readonly wrongs: readonly [string, string, string];
}

const QUESTIONS: readonly QuestionSeed[] = [
  {
    id: E14_QUESTIONS[0] ?? "",
    key: "a1",
    text: "D10 ข้อ 1: ผู้ขายที่ไม่บอกตำหนิสินค้าแก่ผู้ซื้อต้องรับผิดอย่างไร",
    correct: "รับผิดต่อผู้ซื้อในความเสียหายจากตำหนิสินค้านั้น",
    wrongs: ["ไม่ต้องรับผิดเพราะผู้ซื้อตรวจสอบเอง", "รับผิดเฉพาะเมื่อสัญญาระบุไว้", "สัญญาเป็นโมฆียะทั้งสัญญา"],
  },
  {
    id: E14_QUESTIONS[1] ?? "",
    key: "b1",
    text: "D10 ข้อ 2: เงื่อนไขทุนทรัพย์ของคดีในศาลแขวงเป็นอย่างไร",
    correct: "โต้แย้งทุนทรัพย์ต้องไม่เกินที่กฎหมายกำหนดสำหรับศาลแขวง",
    wrongs: ["ฟ้องได้ทุนทรัพย์เท่าใดก็ได้", "ต้องมีทุนทรัพย์ขั้นต่ำตามกฎหมาย", "ห้ามฟ้องเรื่องทุนทรัพย์ในศาลแขวง"],
  },
];

/** renewal_cycles id ตายตัวของเคส 11 และเคส 6 */
const E14_CYCLE_R7 = "cccccccc-cccc-4ccc-8ccc-e14c00000002";
const E14_CYCLE_R30 = "cccccccc-cccc-4ccc-8ccc-e14c00000003";
const E14_CYCLE_CREDIT = "cccccccc-cccc-4ccc-8ccc-e14c00000004";
/** รอบของ citizen (เคส 11 — scan เห็น cycle แต่เจ้าของไม่ใช่ lawyer → not_lawyer) */
const E14_CYCLE_CITIZEN = "cccccccc-cccc-4ccc-8ccc-e14c00000006";
/** email_outbox id ตายตัวของเคส 12 (backoff) */
const E14_OUTBOX_BACKOFF = "cccccccc-cccc-4ccc-8ccc-e14c00000005";
/** email_outbox id ตายตัวของเคส 13 (crash reclaim — gate r1 M1) */
const E14_OUTBOX_RECLAIM = "cccccccc-cccc-4ccc-8ccc-e14c00000009";
/** email_outbox id ตายตัวของเคส 14 (claim-time deny — gate r1 B2) */
const E14_OUTBOX_REVOKE = "cccccccc-cccc-4ccc-8ccc-e14c00000007";
/** renewal_cycles id ตายตัวของเคส 15 (ประตูรายช่องทาง — gate r1 B3) */
const E14_CYCLE_GATE = "cccccccc-cccc-4ccc-8ccc-e14c00000008";

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ────────────────────────────────────────────────

let passUser: TestUser; // เคส 1 — ผ่านสอบ + consent grant → in_app + email จริงถึง Mailpit
let failUser: TestUser; // เคส 2/9 — ไม่ผ่าน (50) + consent grant · เคส 9 ใช้ attempt ใหม่
let noConsentUser: TestUser; // เคส 3 — ไม่เคย grant (fail-closed) · เคส 10 ใช้เป็น "คนอื่น"
let settingsUser: TestUser; // เคส 4 — settings certificate.email=false
let certUser: TestUser; // เคส 5 — ออกใบ + เพิกถอน
let creditUser: TestUser; // เคส 6 — เป้า credit.adjusted −1.25 · เคส 12 เจ้าของแถว outbox
let listUser: TestUser; // เคส 10 — 3 notification (pagination/อ่าน/ERF)
let r7User: TestUser; // เคส 11 — lawyer cycle ครบ +7 วัน
let r30User: TestUser; // เคส 11 — lawyer cycle ครบ +30 วัน
let citizenCycleUser: TestUser; // เคส 11 — citizen มี cycle → not_lawyer
let gateUser: TestUser; // เคส 15 — ประตูรายช่องทาง in_app/email (gate r1 B3)
let registrarUser: TestUser; // เคส 6 — staff:registrar (aal2 ผ่าน mintAal2Token)
let registrarAal2Token = "";
/** B8 — id ผู้ใช้ที่รันนี้สร้าง (cleanup ลบด้วย id ก่อน แล้วค่อย prefix sweep) */
let trackedUserIds: readonly string[] = [];

interface StartResult {
  readonly attempt_id: string;
}
interface SubmitResult {
  readonly status: string;
  readonly passed: boolean;
  readonly score_pct: number;
}
interface TickResult {
  readonly skipped: boolean;
  readonly processed: number;
  readonly already_notified: number;
  readonly email_queued: number;
  readonly skipped_no_channel: number;
  readonly failed: number;
}
interface ScanResult {
  readonly skipped: boolean;
  readonly notified: number;
  readonly already: number;
  readonly not_lawyer: number;
  readonly email_queued: number;
  readonly skipped_no_channel: number;
  readonly failed: number;
}
interface NotifItem {
  readonly id: string;
  readonly recipient_id: string;
  readonly topic: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly ref_type: string | null;
  readonly ref_id: string | null;
  readonly read_at: string | null;
}
interface NotifListResult {
  readonly items: readonly NotifItem[];
  readonly unread_count: number;
  readonly next_cursor: { unread: boolean; created_at: string; id: string } | null;
}
interface ClaimRow {
  readonly id: string;
  readonly attempts: number;
}

/** เรียก RPC ในนาม service_role (ออกใบ/เพิกถอน/render/email worker ตาม 0034) */
function svcRpc(name: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: SERVICE_KEY, token: SERVICE_KEY }, body);
}

/** เรียก RPC ในนามผู้ใช้ (JWT จริงจาก GoTrue — ทางเดียวกับที่ BFF เรียก) */
function userRpc(name: string, token: string, body: unknown): Promise<RestResult> {
  return restCall("POST", `/rest/v1/rpc/${name}`, { apiKey: ANON_KEY, token }, body);
}

/** เรียก notification_dispatch_tick() ตรงผ่าน psql (postgres มี EXECUTE ตาม 0034) */
async function runTick(): Promise<TickResult> {
  const out = await psql(`select public.notification_dispatch_tick();`);
  return JSON.parse(out.trim()) as TickResult;
}

/** เรียก renewal_reminder_scan() ตรงผ่าน psql */
async function runScan(): Promise<ScanResult> {
  const out = await psql(`select public.renewal_reminder_scan();`);
  return JSON.parse(out.trim()) as ScanResult;
}

/** หยุด container mailer (dev worker ยิง email-dispatch ทุก 30 วินาที) ช่วงรัน suite */
async function stopMailer(): Promise<void> {
  await execFileAsync("docker", ["compose", "stop", "mailer"], { cwd: REPO_ROOT });
}

/** สตาร์ต mailer คืน (finally — ไม่ทิ้ง dev stack พัก) */
async function startMailer(): Promise<void> {
  await execFileAsync("docker", ["compose", "start", "mailer"], { cwd: REPO_ROOT });
}

/** พัก cron จริงที่เกี่ยวกับ suite ช่วงรัน (idempotent) — dispatch กิน event ทุกนาที */
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

/** ระบายคิว 4 topic ค้าง (จากรอบก่อน/ชุดอื่น) จน tick เงียบ — ตัวเลขรายเคสสะอาด */
async function drainQueue(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const result = await runTick();
    if (!result.skipped && result.processed + result.already_notified === 0) {
      return;
    }
  }
}

/** grant email_notify ให้ผู้ใช้ (ทาง RPC จริง — append-only + audit CONSENT_UPDATE) */
async function grantEmailConsent(user: TestUser): Promise<void> {
  const res = await userRpc("my_consents_update", user.accessToken, {
    p_type: "email_notify",
    p_action: "grant",
  });
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  expect((res.json as { status: string }).status).toBe("granted");
}

/** ลงทะเบียนหลักสูตรด้วย RPC จริง — คืน enrollment id */
async function enrollViaRpc(user: TestUser, courseId: string): Promise<string> {
  const result = await restCall(
    "POST",
    `/rest/v1/rpc/enroll`,
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_course_id: courseId },
  );
  expect(result.status, result.text.slice(0, 300)).toBe(200);
  return psqlScalar(
    `select id::text from public.enrollments
      where user_id = '${user.id}' and course_id = '${courseId}' limit 1;`,
  );
}

/** สอบผ่าน flow จริง start → save (เฉลยจาก DB) → submit — คืน attempt id (ผ่าน 100) */
async function passExamViaRest(user: TestUser): Promise<string> {
  const start = await restCall(
    "POST",
    "/rest/v1/rpc/start_attempt",
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_assessment_id: E14_ASSESSMENT },
  );
  expect(start.status, start.text.slice(0, 300)).toBe(200);
  const attemptId = (start.json as StartResult).attempt_id;
  const answers = await knownCorrectAnswers(E14_QUESTIONS);
  for (const [questionId, correct] of answers) {
    const saved = await restCall(
      "POST",
      "/rest/v1/rpc/save_answer",
      { apiKey: ANON_KEY, token: user.accessToken },
      {
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_selected_option_ids: [correct],
        p_session_id: jwtPayload(user.accessToken).session_id ?? "",
      },
    );
    expect(saved.status, saved.text.slice(0, 300)).toBeLessThan(300);
  }
  const submit = await restCall(
    "POST",
    "/rest/v1/rpc/submit_attempt",
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_attempt_id: attemptId, p_session_id: jwtPayload(user.accessToken).session_id ?? "" },
  );
  expect(submit.status, submit.text.slice(0, 300)).toBe(200);
  const body = submit.json as SubmitResult;
  expect(body.status).toBe("passed");
  expect(body.passed).toBe(true);
  expect(body.score_pct).toBe(100);
  return attemptId;
}

/** สอบไม่ผ่าน (ตอบถูกข้อเดียว = 50 < 70) — คืน attempt id */
async function failExamViaRest(user: TestUser): Promise<string> {
  const start = await restCall(
    "POST",
    "/rest/v1/rpc/start_attempt",
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_assessment_id: E14_ASSESSMENT },
  );
  expect(start.status, start.text.slice(0, 300)).toBe(200);
  const attemptId = (start.json as StartResult).attempt_id;
  const answers = await knownCorrectAnswers(E14_QUESTIONS);
  // ตอบถูกเฉพาะโจทย์แรก — ข้อที่สองค้างไม่ตอบ (1×1 แต้ม จาก 2 แต้ม = 50)
  const first = [...answers.entries()][0];
  if (first === undefined) throw new Error("ไม่พบเฉลยของโจทย์");
  const [firstQuestionId, correct] = first;
  const saved = await restCall(
    "POST",
    "/rest/v1/rpc/save_answer",
    { apiKey: ANON_KEY, token: user.accessToken },
    {
      p_attempt_id: attemptId,
      p_question_id: firstQuestionId,
      p_selected_option_ids: [correct],
      p_session_id: jwtPayload(user.accessToken).session_id ?? "",
    },
  );
  expect(saved.status, saved.text.slice(0, 300)).toBeLessThan(300);
  const submit = await restCall(
    "POST",
    "/rest/v1/rpc/submit_attempt",
    { apiKey: ANON_KEY, token: user.accessToken },
    { p_attempt_id: attemptId, p_session_id: jwtPayload(user.accessToken).session_id ?? "" },
  );
  expect(submit.status, submit.text.slice(0, 300)).toBe(200);
  const body = submit.json as SubmitResult;
  expect(body.status).toBe("failed");
  expect(body.passed).toBe(false);
  expect(body.score_pct).toBe(50);
  return attemptId;
}

/** ปิดการเรียน (สำหรับออกใบ — cert_issue_core บังคับ enrollment completed) */
async function completeEnrollment(userId: string, courseId: string): Promise<string> {
  const enrollmentId = await psqlScalar(`
    select id::text from public.enrollments
     where user_id = '${userId}' and course_id = '${courseId}' limit 1;
  `);
  await psql(`
    update public.enrollments set status = 'completed', completed_at = now()
     where id = '${enrollmentId}';
  `);
  return enrollmentId;
}

/** ออกใบประกาศนียบัตรด้วย svcRpc (0029/0034 v2) — คืน certificate id */
async function issueCertificate(enrollmentId: string): Promise<string> {
  const issue = await svcRpc("admin_issue_certificate", {
    p_actor_user_id: STAFF_EXAM_DEMO_ID,
    p_enrollment_id: enrollmentId,
    p_request_id: crypto.randomUUID(),
  });
  expect(issue.status, issue.text.slice(0, 300)).toBe(200);
  return (issue.json as { id: string }).id;
}

/** ล้างโลกของ suite ทั้งชุด (เรียงตาม FK — RESTRICT) ครอบของค้างจากรอบที่พังกลางทาง ·
 *  audit_logs เป็น append-only ตามดีไซน์ — ตั้งใจคงไว้ (เหมือนชุด D-9) */
async function cleanupE14World(): Promise<void> {
  // B8 — tracked-first: ลบด้วย id ที่รันนี้จดไว้ก่อน แล้วค่อยกวาด prefix 'dcr10-notif-%'
  const trackedList = trackedUserIds.map((id) => `'${id}'`).join(",");
  const users = await psqlRows<{ id: string; email: string }>(`
    select id::text, email from auth.users
     where email like 'dcr10-notif-%'
       ${trackedList.length > 0 ? `or id in (${trackedList})` : ""}
  `);
  if (users.length > 0) {
    const list = users.map((u) => `'${u.id}'`).join(",");
    await psql(`
      delete from public.event_outbox
       where payload ->> 'user_id' in (${list})
          or payload ->> 'source_id' in (
               select id::text from public.assessment_attempts where user_id in (${list}));
      delete from public.email_outbox where recipient_user_id in (${list});
      delete from public.notification_recipients where user_id in (${list});
      delete from public.notifications
       where id in (select notification_id from public.notification_recipients
                     where user_id in (${list}));
      delete from public.certificate_verifications
       where verify_code in (select verify_code from public.certificates where user_id in (${list}));
      delete from public.certificates where user_id in (${list});
    `);
    await psql(`
      begin;
      alter table public.credit_ledger_entries disable trigger trg_append_only_rows;
      delete from public.credit_ledger_entries where user_id in (${list});
      alter table public.credit_ledger_entries enable trigger trg_append_only_rows;
      alter table public.consents disable trigger trg_append_only_rows;
      delete from public.consents where user_id in (${list});
      alter table public.consents enable trigger trg_append_only_rows;
      commit;
    `);
    await psql(`
      delete from public.renewal_cycles where user_id in (${list});
      delete from public.attempt_answers
       where attempt_id in (select id from public.assessment_attempts where user_id in (${list}));
      delete from public.assessment_attempts where user_id in (${list});
      delete from public.lesson_progress
       where enrollment_id in (select id from public.enrollments where user_id in (${list}));
      delete from public.enrollments where user_id in (${list});
      delete from public.notification_settings where user_id in (${list});
      delete from public.role_assignments where user_id in (${list});
      delete from public.profiles where id in (${list});
      delete from auth.users where email like 'dcr10-notif-%';
    `);
  }
  // ก้อน fixture — id ตายตัวของ suite ลบได้เสมอ **ไม่ขึ้นกับผู้ใช้** (ครั้งแรกที่ยังไม่มี
  // ผู้ใช้ หรือรอบก่อน cleanup สำเร็จจนไม่เหลือผู้ใช้ ก็ต้องลบของสังเคราะห์ได้):
  // event poison สังเคราะห์ (user_id เสีย — หาโดย source_id) + แถว outbox ของเคส 12
  await psql(`
    delete from public.event_outbox
     where payload ->> 'source_id' like 'aaaaaaaa-aaaa-4aaa-8aaa-e14a%';
    delete from public.email_outbox where id = '${E14_OUTBOX_BACKOFF}';
    delete from public.email_outbox where id in ('${E14_OUTBOX_RECLAIM}', '${E14_OUTBOX_REVOKE}');
    delete from public.question_options
     where question_id in (${E14_QUESTIONS.map((id) => `'${id}'`).join(",")});
    delete from public.questions where bank_id = '${E14_BANK}';
    delete from public.question_banks where id = '${E14_BANK}';
    delete from public.assessment_rules where id = '${E14_RULES_ID}';
    delete from public.assessments where id = '${E14_ASSESSMENT}';
    delete from public.courses where id = '${E14_COURSE}';
  `);
}

/** seed หลักสูตร + ข้อสอบเร็ว (id ตายตัว + on conflict do nothing — เรียกซ้ำได้) */
async function seedE14Fixtures(): Promise<void> {
  await psql(`
    insert into public.courses
      (id, code, category_id, created_by, title_th, is_public, status, published_at)
    values
      ('${E14_COURSE}', 'E14-DCR10-N',
       (select id from public.course_categories order by id limit 1), '${STAFF_EXAM_DEMO_ID}',
       'หลักสูตรทดสอบ DCR-10 การแจ้งเตือน (integration)', true, 'published', now())
    on conflict (id) do nothing;
    insert into public.assessments
      (id, course_id, code, title, description, is_final, status, published_at) values
      ('${E14_ASSESSMENT}', '${E14_COURSE}', 'EXAM-E14-N', 'สอบเร็ว D-10 (notifications)', null,
       false, 'published', now())
    on conflict (id) do nothing;
    insert into public.assessment_rules
      (id, assessment_id, version, time_limit_minutes, question_count, pass_pct, max_attempts,
       attempt_cooldown_minutes, shuffle_questions, shuffle_options, selection,
       require_course_complete, proctoring_mode, effective_from) values
      ('${E14_RULES_ID}', '${E14_ASSESSMENT}', 1, 5, 2, 70, 5,
       0, false, false, '{"bank_ids":["${E14_BANK}"]}'::jsonb, false, 'none', now() - interval '1 day')
    on conflict (id) do nothing;
    insert into public.question_banks
      (id, code, name, created_by, course_id, description, is_active) values
      ('${E14_BANK}', 'QB-EXAM-E14-N', 'ธนาคารข้อสอบ D-10 notifications', '${STAFF_EXAM_DEMO_ID}',
       '${E14_COURSE}', 'seed สอบเร็วของ suite DCR-10', true)
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.questions
      (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
    values ${QUESTIONS.map(
      (q) => `('${q.id}', '${E14_BANK}', 'single_choice', 'easy', '${q.text}',
              'คำอธิบายของ D-10', 1, 'draft', array['d10-integration'], '${STAFF_EXAM_DEMO_ID}', 1)`,
    ).join(",\n        ")};
  `);
  await psql(`
    insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
    values ${QUESTIONS.map((q) => {
      return [
        `('${optionId(q.key, 1)}', '${q.id}', '${q.correct}', true, 1)`,
        `('${optionId(q.key, 2)}', '${q.id}', '${q.wrongs[0]}', false, 2)`,
        `('${optionId(q.key, 3)}', '${q.id}', '${q.wrongs[1]}', false, 3)`,
        `('${optionId(q.key, 4)}', '${q.id}', '${q.wrongs[2]}', false, 4)`,
      ].join(",\n        ");
    }).join(",\n        ")};
  `);
  // เปิดใช้งานโจทย์ในนาม profile สาธิต staff:exam (guard_question_activation ต้องผ่าน)
  await psql(`
    begin;
    set local "request.jwt.claims" = '{"sub":"${STAFF_EXAM_DEMO_ID}","role":"authenticated"}';
    update public.questions set status = 'active'
     where id in (${E14_QUESTIONS.map((id) => `'${id}'`).join(",")});
    commit;
  `);
}

describe.skipIf(!DB_URL)(
  "DCR-10 ระบบแจ้งเตือน NTF (กลไกของ 0034 บน DB จริง — dispatch/consent/settings/cert/credit/renewal/backoff)",
  () => {
    beforeAll(async () => {
      await cleanupE14World(); // ล้างของค้างจากรอบก่อน (ถ้ามี) ให้ beforeAll ทำซ้ำได้
      await pauseCrons(); // พัก cron จริง 4 ตัวช่วงรัน (ตั้งคืนใน afterAll finally)
      await stopMailer(); // หยุด dev worker อีเมล (ยิงทุก 30 วินาที) — start คืนใน finally
      await drainQueue(); // ระบายคิว 4 topic ให้ว่างก่อนเริ่ม
      await seedE14Fixtures();
      passUser = await createTestUser("dcr10-notif-pass", "lawyer");
      failUser = await createTestUser("dcr10-notif-fail", "lawyer");
      noConsentUser = await createTestUser("dcr10-notif-noconsent", "lawyer");
      settingsUser = await createTestUser("dcr10-notif-settings", "lawyer");
      certUser = await createTestUser("dcr10-notif-cert", "lawyer");
      creditUser = await createTestUser("dcr10-notif-credit", "lawyer");
      listUser = await createTestUser("dcr10-notif-list", "lawyer");
      r7User = await createTestUser("dcr10-notif-r7", "lawyer");
      r30User = await createTestUser("dcr10-notif-r30", "lawyer");
      citizenCycleUser = await createTestUser("dcr10-notif-citizen", "citizen");
      gateUser = await createTestUser("dcr10-notif-gate", "lawyer");
      registrarUser = await createTestUser("dcr10-notif-registrar", "staff:registrar");
      trackedUserIds = [
        passUser,
        failUser,
        noConsentUser,
        settingsUser,
        certUser,
        creditUser,
        listUser,
        r7User,
        r30User,
        citizenCycleUser,
        gateUser,
        registrarUser,
      ].map((u) => u.id);
      registrarAal2Token = await mintAal2Token(registrarUser);
      // ลงทะเบียนหลักสูตรให้ผู้สอบทุกคน (start_attempt ตามทางจริง)
      for (const user of [passUser, failUser, noConsentUser, settingsUser, certUser, listUser]) {
        await enrollViaRpc(user, E14_COURSE);
      }
      // grant email_notify ล่วงหน้า (เคส 1/2/4/5/6/11/15 — เคส 3 ตั้งใจไม่ grant)
      for (const user of [passUser, failUser, settingsUser, certUser, creditUser, r7User, r30User, gateUser]) {
        await grantEmailConsent(user);
      }
      // รอบ renewal ของเคส 11 + รอบเป้า adjustment ของเคส 6/15 (insert ตรง — status open)
      await psql(`
        insert into public.renewal_cycles
          (id, user_id, cycle_no, starts_on, ends_on, required_credits, status) values
          ('${E14_CYCLE_R7}', '${r7User.id}', 1, current_date - 1, current_date + 7,
           '{"general":12}'::jsonb, 'open'),
          ('${E14_CYCLE_R30}', '${r30User.id}', 1, current_date - 1, current_date + 30,
           '{"general":12}'::jsonb, 'open'),
          ('${E14_CYCLE_CREDIT}', '${creditUser.id}', 1, current_date - 1, current_date + 200,
           '{"general":12}'::jsonb, 'open'),
          ('${E14_CYCLE_CITIZEN}', '${citizenCycleUser.id}', 1, current_date - 1, current_date + 7,
           '{"general":12}'::jsonb, 'open'),
          ('${E14_CYCLE_GATE}', '${gateUser.id}', 1, current_date - 1, current_date + 200,
           '{"general":12}'::jsonb, 'open')
        on conflict (id) do nothing;
      `);
    }, 300_000);

    afterAll(async () => {
      // คืน dev stack เสมอ (try/finally — cleanup ล้มห้ามทิ้ง cron/mailer พักเงียบ)
      try {
        await cleanupE14World();
      } finally {
        await restoreCrons();
        await startMailer();
      }
    });

    // ─── เคส 1: สอบผ่าน → in_app + email จริงถึง Mailpit (ปลายทางครบสาย) ────────

    it("เคส 1 ผ่านสอบ → tick → in_app success 'สอบผ่าน' + outbox queued + recipients email sent_at null → dispatch จริง (x-cron-secret) → sent + Mailpit Subject ผลการสอบ/ผ่าน", async () => {
      const attemptId = await passExamViaRest(passUser);
      // event เกิด in-TX กับการตรวจ — 1 แถว pending พร้อม payload ครบ
      const events = await psqlRows<{ id: string; status: string; passed: string; score: string }>(`
        select id::text, status::text, payload ->> 'passed' as passed, payload ->> 'score_pct' as score
          from public.event_outbox
         where topic = 'exam.result' and payload ->> 'source_id' = '${attemptId}';
      `);
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("pending");
      expect(events[0]?.passed).toBe("true");
      expect(events[0]?.score).toBe("100");
      // tick ตรง — processed แล้วแจ้ง in_app + เข้าคิวอีเมล
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.processed, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
      const notifs = await psqlRows<{
        id: string;
        topic: string;
        title: string;
        severity: string;
        ref_type: string;
        ref_id: string;
      }>(`
        select n.id::text, n.topic, n.title, n.severity::text, n.ref_type::text, n.ref_id::text
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${passUser.id}' and nr.channel = 'in_app'
           and n.topic = 'exam.result' and n.ref_id = '${attemptId}';
      `);
      expect(notifs).toHaveLength(1);
      expect(notifs[0]?.severity).toBe("success");
      expect(notifs[0]?.title).toContain("สอบผ่าน");
      expect(notifs[0]?.ref_type).toBe("assessment_attempt");
      const notifId = notifs[0]?.id ?? "";
      // อีเมลเข้าคิว — queued · template ผ่าน · payload ผูก notification_id (D-p4-8)
      const outbox = await psqlRows<{
        id: string;
        status: string;
        template_key: string;
        notification_id: string;
      }>(`
        select id::text, status::text, template_key, payload ->> 'notification_id' as notification_id
          from public.email_outbox
         where recipient_user_id = '${passUser.id}';
      `);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.status).toBe("queued");
      expect(outbox[0]?.template_key).toBe("exam.result.passed");
      expect(outbox[0]?.notification_id).toBe(notifId);
      // แถวผู้รับช่องทาง email รอ worker ยืนยัน (sent_at = null — D-p4-7)
      const emailRecipients = await psqlRows<{ sent_at: string | null }>(`
        select sent_at::text from public.notification_recipients
         where notification_id = '${notifId}' and channel = 'email';
      `);
      expect(emailRecipients).toHaveLength(1);
      expect(emailRecipients[0]?.sent_at).toBeNull();
      // dispatch จริงผ่านประตู cron ของแอป (secret จาก .env — ห้าม log ค่า)
      const cronSecret = process.env.CRON_SECRET ?? "";
      expect(cronSecret.length, "CRON_SECRET ไม่พบใน env ของรัน").toBeGreaterThan(0);
      const dispatch = await fetch(
        "http://localhost:3000/api/internal/jobs/email-dispatch",
        { method: "POST", headers: { "x-cron-secret": cronSecret } },
      );
      expect(dispatch.status, `dispatch HTTP ${dispatch.status}`).toBe(200);
      const summary = (await dispatch.json()) as { processed: { claimed: number; sent: number; failed: number } };
      expect(summary.processed.claimed).toBe(1);
      expect(summary.processed.sent).toBe(1);
      expect(summary.processed.failed).toBe(0);
      // หลัง dispatch: outbox sent + sent_at · recipients email sent_at ถูกตั้ง
      const after = await psqlRows<{ status: string; sent: boolean; recipient_sent: boolean }>(`
        select o.status::text,
               o.sent_at is not null as sent,
               exists (select 1 from public.notification_recipients nr
                        where nr.notification_id = '${notifId}' and nr.channel = 'email'
                          and nr.sent_at is not null) as recipient_sent
          from public.email_outbox o
         where o.id = '${outbox[0]?.id ?? ""}';
      `);
      expect(after[0]?.status).toBe("sent");
      expect(after[0]?.sent).toBe(true);
      expect(after[0]?.recipient_sent).toBe(true);
      // Mailpit จริง — จดหมายถึงผู้ใช้ Subject มี "ผลการสอบ" และ "ผ่าน" (JSON decode แล้ว)
      const mailpit = (await (await fetch("http://localhost:8025/api/v1/messages")).json()) as {
        messages: readonly { To: readonly { Address: string }[]; Subject: string }[];
      };
      const mine = mailpit.messages.filter((m) =>
        m.To.some((to) => to.Address === passUser.email),
      );
      expect(mine.length, "ไม่พบจดหมายที่ Mailpit สำหรับผู้ใช้ของเคส 1").toBeGreaterThanOrEqual(1);
      expect(
        mine.some((m) => m.Subject.includes("ผลการสอบ") && m.Subject.includes("ผ่าน")),
        `Mailpit Subject ไม่ตรง (พบ ${mine.length} จดหมายของผู้ใช้)`,
      ).toBe(true);
    }, 60_000);

    // ─── เคส 2: สอบไม่ผ่าน (50) → warning + template failed + body มี 50 ─────────

    it("เคส 2 ไม่ผ่าน (ตอบถูก 1 จาก 2 = 50) → tick → in_app severity warning · template exam.result.failed · body มี '50'", async () => {
      const attemptId = await failExamViaRest(failUser);
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.processed, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
      const notifs = await psqlRows<{ title: string; body: string; severity: string }>(`
        select n.title, n.body, n.severity::text
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${failUser.id}' and nr.channel = 'in_app'
           and n.topic = 'exam.result' and n.ref_id = '${attemptId}';
      `);
      expect(notifs).toHaveLength(1);
      expect(notifs[0]?.severity).toBe("warning");
      expect(notifs[0]?.body).toContain("50");
      expect(notifs[0]?.body).toContain("70"); // เกณฑ์ผ่านของรอบสอบ fixture
      // อีเมล variant ไม่ผ่าน เข้าคิวตาม consent ของผู้ใช้
      const outbox = await psqlRows<{ template_key: string }>(`
        select template_key from public.email_outbox where recipient_user_id = '${failUser.id}';
      `);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.template_key).toBe("exam.result.failed");
    }, 45_000);

    // ─── เคส 3: fail-closed — ไม่มีแถว consents = ไม่มีอีเมล ────────────────────

    it("เคส 3 fail-closed consent: ผู้ใช้ไม่เคย grant email_notify สอบผ่าน → tick → in_app มี · email_outbox ของเขา 0 แถว · ไม่มี recipients email", async () => {
      const attemptId = await passExamViaRest(noConsentUser);
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.processed, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
      const notifs = await psqlRows<{ n: number }>(`
        select count(*)::int as n
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${noConsentUser.id}' and nr.channel = 'in_app'
           and n.ref_id = '${attemptId}';
      `);
      expect(notifs[0]?.n).toBe(1);
      const emails = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.email_outbox
         where recipient_user_id = '${noConsentUser.id}';
      `);
      expect(emails[0]?.n).toBe(0);
      const emailRows = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.notification_recipients nr
         where nr.channel = 'email'
           and nr.user_id in (select user_id from public.notification_recipients
                               where notification_id in (
                                 select notification_id from public.notification_recipients
                                  where user_id = '${noConsentUser.id}'));
      `);
      expect(emailRows[0]?.n).toBe(0);
    }, 45_000);

    // ─── เคส 4: settings family email=false + รูปทรง my_notification_settings ───

    it("เคส 4 settings certificate.email=false → ออกใบ → tick → in_app มี · อีเมล certificate ไม่มี (family อื่นปกติ) · รูปทรง GET/UPDATE ครบ 4 family merged defaults · patch กลับ true", async () => {
      // ปิดอีเมลเฉพาะ family certificate (ผ่าน RPC จริง — validate strict ใน SQL)
      const before = await userRpc("my_notification_settings_update", settingsUser.accessToken, {
        p_settings: { certificate: { in_app: true, email: false } },
      });
      expect(before.status, before.text.slice(0, 300)).toBe(200);
      expect((before.json as { settings: { certificate: { email: boolean } } }).settings.certificate.email).toBe(false);
      // ผู้ใช้ต้องผ่านสอบก่อนออกใบ (cert_issue_core บังคับ attempt ผ่านเกณฑ์)
      await passExamViaRest(settingsUser);
      const enrollmentId = await completeEnrollment(settingsUser.id, E14_COURSE);
      const certId = await issueCertificate(enrollmentId);
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      // tick นี้ประมวลผล 2 event (exam.result + certificate.issued ของ settingsUser)
      expect(tick.processed, JSON.stringify(tick)).toBeGreaterThanOrEqual(2);
      // in_app ของ certificate.issued มา แต่อีเมลถูกปิดที่ settings (family certificate)
      const certNotifs = await psqlRows<{ id: string }>(`
        select n.id::text
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${settingsUser.id}' and nr.channel = 'in_app'
           and n.topic = 'certificate.issued' and n.ref_id = '${certId}';
      `);
      expect(certNotifs).toHaveLength(1);
      const certNotifId = certNotifs[0]?.id ?? "";
      // family certificate: ห้ามมีทั้ง outbox และ recipients email ของ notification ใบนี้
      const certEmails = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.email_outbox
         where recipient_user_id = '${settingsUser.id}' and template_key = 'certificate.issued';
      `);
      expect(certEmails[0]?.n).toBe(0);
      const certEmailRows = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.notification_recipients
         where notification_id = '${certNotifId}' and channel = 'email';
      `);
      expect(certEmailRows[0]?.n).toBe(0);
      // family exam.result ยังเปิด (default on) — อีเมลผลสอบยังเข้าคิวตาม consent
      const examEmails = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.email_outbox
         where recipient_user_id = '${settingsUser.id}' and template_key = 'exam.result.passed';
      `);
      expect(examEmails[0]?.n).toBe(1);
      // รูปทรง GET — merged defaults ครบ 4 family · certificate.email คง false
      const shape = await userRpc("my_notification_settings", settingsUser.accessToken, {});
      expect(shape.status, shape.text.slice(0, 300)).toBe(200);
      const settingsBody = shape.json as {
        settings: Record<string, { in_app: boolean; email: boolean }>;
      };
      expect(Object.keys(settingsBody.settings).sort()).toEqual([
        "certificate",
        "credit",
        "exam.result",
        "renewal",
      ]);
      expect(settingsBody.settings.certificate).toEqual({ in_app: true, email: false });
      // family อื่นที่ไม่เคยตั้ง = default on (merged)
      expect(settingsBody.settings["exam.result"]).toEqual({ in_app: true, email: true });
      expect(settingsBody.settings.credit).toEqual({ in_app: true, email: true });
      expect(settingsBody.settings.renewal).toEqual({ in_app: true, email: true });
      // patch กลับ — certificate.email = true แล้วรูปทรงเดิมครบ
      const patched = await userRpc("my_notification_settings_update", settingsUser.accessToken, {
        p_settings: { certificate: { in_app: true, email: true } },
      });
      expect(patched.status, patched.text.slice(0, 300)).toBe(200);
      const patchedBody = patched.json as typeof settingsBody;
      expect(patchedBody.settings.certificate).toEqual({ in_app: true, email: true });
      expect(Object.keys(patchedBody.settings).sort()).toEqual([
        "certificate",
        "credit",
        "exam.result",
        "renewal",
      ]);
    }, 60_000);

    // ─── เคส 5: ออกใบ + เพิกถอน → สอง notification ref_type certificate ทั้งคู่ ──

    it("เคส 5 ออกใบ→เพิกถอน → tick → notification certificate.issued + certificate.revoked ref_type 'certificate' ทั้งคู่ (A-2) · subject อีเมลเพิกถอน render แล้วมี 'เลขที่' + cert_no", async () => {
      await passExamViaRest(certUser);
      const enrollmentId = await completeEnrollment(certUser.id, E14_COURSE);
      const certId = await issueCertificate(enrollmentId);
      const certNo = await psqlScalar(
        `select cert_no from public.certificates where id = '${certId}';`,
      );
      expect(certNo).toMatch(/^LTC-\d{4}-/);
      const revoke = await svcRpc("admin_revoke_certificate", {
        p_actor_user_id: STAFF_EXAM_DEMO_ID,
        p_certificate_id: certId,
        p_reason: "เพิกถอนเพื่อทดสอบการแจ้งเตือนเพิกถอนใบประกาศนียบัตรของ DCR-10",
        p_request_id: crypto.randomUUID(),
      });
      expect(revoke.status, revoke.text.slice(0, 300)).toBe(200);
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.processed, JSON.stringify(tick)).toBeGreaterThanOrEqual(2);
      const certNotifs = await psqlRows<{ topic: string; ref_type: string; body: string }>(`
        select n.topic, n.ref_type::text, n.body
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${certUser.id}' and nr.channel = 'in_app'
           and n.ref_id = '${certId}'
         order by n.topic;
      `);
      expect(certNotifs).toHaveLength(2);
      expect(certNotifs.map((r) => r.topic).sort()).toEqual([
        "certificate.issued",
        "certificate.revoked",
      ]);
      // นายก fix A-2: issued ต้อง ref_type 'certificate' เหมือน revoked (ไม่ใช่ null)
      for (const row of certNotifs) {
        expect(row.ref_type).toBe("certificate");
        expect(row.body).toContain(certNo);
      }
      // อีเมลสองฉบับ (issued + revoked) — subject ฉบับเพิกถอน render แล้วต้องมี เลขที่+cert_no
      const revokedOutbox = await psqlRows<{
        template_key: string;
        vars: { cert_no?: string; full_name?: string };
      }>(`
        select template_key, payload -> 'vars' as vars
          from public.email_outbox
         where recipient_user_id = '${certUser.id}' and template_key = 'certificate.revoked';
      `);
      expect(revokedOutbox).toHaveLength(1);
      expect(revokedOutbox[0]?.vars?.cert_no).toBe(certNo);
      const rendered = await svcRpc("render_notification", {
        p_key: "certificate.revoked",
        p_locale: "th",
        p_channel: "email",
        p_vars: revokedOutbox[0]?.vars ?? {},
      });
      expect(rendered.status, rendered.text.slice(0, 300)).toBe(200);
      const subject = (rendered.json as { subject: string }).subject;
      expect(subject).toContain("เลขที่");
      expect(subject).toContain(certNo);
    }, 60_000);

    // ─── เคส 6: credit.adjusted −1.25 (registrar aal2) ──────────────────────────

    it("เคส 6 registrar aal2 ปรับ −1.25 → tick → notification credit.adjusted body มี '-1.25' ref_type credit_ledger + อีเมลเข้าคิว", async () => {
      const adjust = await userRpc("admin_credit_adjust", registrarAal2Token, {
        p_user_id: creditUser.id,
        p_cycle_id: E14_CYCLE_CREDIT,
        p_credit_type: "general",
        p_amount: -1.25,
        p_reason: "ปรับยอดเพื่อทดสอบการแจ้งเตือนหน่วยกิตของ DCR-10",
        p_request_id: crypto.randomUUID(),
      });
      expect(adjust.status, adjust.text.slice(0, 300)).toBe(200);
      const ledgerId = (adjust.json as { id: string }).id;
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.processed, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
      const notifs = await psqlRows<{ body: string; ref_type: string; ref_id: string }>(`
        select n.body, n.ref_type::text, n.ref_id::text
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${creditUser.id}' and nr.channel = 'in_app'
           and n.topic = 'credit.adjusted';
      `);
      expect(notifs).toHaveLength(1);
      expect(notifs[0]?.body).toContain("-1.25");
      expect(notifs[0]?.ref_type).toBe("credit_ledger");
      expect(notifs[0]?.ref_id).toBe(ledgerId);
      const outbox = await psqlRows<{ amount: string }>(`
        select payload -> 'vars' ->> 'amount' as amount
          from public.email_outbox where recipient_user_id = '${creditUser.id}';
      `);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.amount).toBe("-1.25");
    }, 45_000);

    // ─── เคส 7: re-delivery → dedupe already_notified ───────────────────────────

    it("เคส 7 re-delivery: copy event exam.result ที่ processed แล้ว → tick → already_notified ≥1 · จำนวน notification เดิมไม่เพิ่ม", async () => {
      const events = await psqlRows<{ id: string }>(`
        select id::text from public.event_outbox
         where topic = 'exam.result' and payload ->> 'source_id' in (
               select id::text from public.assessment_attempts where user_id = '${passUser.id}')
           and status = 'processed';
      `);
      expect(events).toHaveLength(1);
      await psql(`
        insert into public.event_outbox (topic, payload)
        select topic, payload from public.event_outbox where id = '${events[0]?.id ?? ""}';
      `);
      const countBefore = await psqlRows<{ n: number }>(`
        select count(*)::int as n
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${passUser.id}' and nr.channel = 'in_app' and n.topic = 'exam.result';
      `);
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.already_notified, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
      const countAfter = await psqlRows<{ n: number }>(`
        select count(*)::int as n
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${passUser.id}' and nr.channel = 'in_app' and n.topic = 'exam.result';
      `);
      expect(countAfter[0]?.n).toBe(countBefore[0]?.n ?? -1);
    }, 30_000);

    // ─── เคส 8: poison event ไม่ลากทั้ง tick ────────────────────────────────────

    it("เคส 8 poison: event user_id เสีย → tick รอด (failed≥1) · attempts=1 + last_error + available_at เลื่อน · tick สองไม่เลือกซ้ำ", async () => {
      await psql(`
        insert into public.event_outbox (topic, payload)
        values ('exam.result', jsonb_build_object(
          'source_type', 'assessment_attempt', 'source_id', 'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000001',
          'user_id', 'malformed-not-a-uuid', 'passed', true, 'score_pct', 100, 'pass_pct', 70));
      `);
      const tick = await runTick();
      expect(tick.skipped).toBe(false);
      expect(tick.failed, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
      const poison = await psqlRows<{
        status: string;
        attempts: number;
        error: string | null;
        deferred: boolean;
      }>(`
        select status::text, attempts, last_error as error, available_at > now() as deferred
          from public.event_outbox
         where topic = 'exam.result' and payload ->> 'source_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000001';
      `);
      expect(poison).toHaveLength(1);
      expect(poison[0]?.status).toBe("pending");
      expect(poison[0]?.attempts).toBe(1);
      expect(poison[0]?.error ?? "").not.toBe("");
      expect(poison[0]?.deferred).toBe(true);
      // tick สอง — backoff ทำให้ไม่ถูกเลือกซ้ำ (attempts คง 1)
      await runTick();
      const poisonAfter = await psqlScalar(`
        select attempts::text from public.event_outbox
         where topic = 'exam.result' and payload ->> 'source_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000001';
      `);
      expect(poisonAfter).toBe("1");
      // ปิด poison เป็น processed — ไม่ให้ค้าง retry ตอน cron จริงกลับมา
      await psql(`
        update public.event_outbox set status = 'processed', processed_at = now(), last_error = null
         where topic = 'exam.result' and payload ->> 'source_id' = 'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000001';
      `);
    }, 30_000);

    // ─── เคส 9: template in_app ถูกปิด → event ล้ม fail-loud ────────────────────

    it("เคส 9 template หาย: ปิด in_app exam.result.failed → fail event ใหม่ → tick → last_error มี 'template' · ไม่เกิด notification · เปิด template คืนใน finally", async () => {
      // fail event ใหม่ (attempt ที่สองของ failUser — ref_id ใหม่จึงไม่โดน dedupe)
      const attemptId = await failExamViaRest(failUser);
      const events = await psqlRows<{ id: string }>(`
        select id::text from public.event_outbox
         where topic = 'exam.result' and payload ->> 'source_id' = '${attemptId}';
      `);
      expect(events).toHaveLength(1);
      const eventId = events[0]?.id ?? "";
      await psql(`
        update public.notification_templates set is_active = false
         where template_key = 'exam.result.failed' and channel = 'in_app' and locale = 'th';
      `);
      try {
        const tick = await runTick();
        expect(tick.failed, JSON.stringify(tick)).toBeGreaterThanOrEqual(1);
        const failed = await psqlRows<{
          attempts: number;
          error: string | null;
          processed: boolean;
        }>(`
          select attempts, last_error as error, status = 'processed' as processed
            from public.event_outbox where id = '${eventId}';
        `);
        expect(failed[0]?.processed).toBe(false);
        expect(failed[0]?.attempts).toBe(1);
        expect(failed[0]?.error ?? "").toContain("template");
        // ไม่มี notification ใหม่สำหรับ attempt นี้ (render ล้มก่อน INSERT)
        const notifs = await psqlRows<{ n: number }>(`
          select count(*)::int as n
            from public.notifications n
            join public.notification_recipients nr on nr.notification_id = n.id
           where nr.user_id = '${failUser.id}' and nr.channel = 'in_app' and n.ref_id = '${attemptId}';
        `);
        expect(notifs[0]?.n).toBe(0);
      } finally {
        // เปิด template คืน + ปิด event ค้างเป็น processed — ไม่ให้ cron จริง retry ทีหลัง
        await psql(`
          update public.notification_templates set is_active = true
           where template_key = 'exam.result.failed' and channel = 'in_app' and locale = 'th';
          update public.event_outbox set status = 'processed', processed_at = now(), last_error = null
           where id = '${eventId}';
        `);
      }
    }, 45_000);

    // ─── เคส 10: my_notifications — อ่าน/idempotent/ข้ามเจ้าของ/pagination ──────

    it("เคส 10 my_notifications: 3 แจ้งจาก events → อ่านตัวกลาง (idempotent) · คนอื่นอ่านโดน ERR-NF-001 · unreadFirst + unread_count · pagination limit=2 เดินครบแล้ว next_cursor null", async () => {
      // 3 attempts จริง — tick หลังแต่ละ attempt เพื่อให้ created_at ของ notification
      // ต่างกันชัดเจน (tick เดียวจะได้ created_at เดียวกันทั้งก้อน → ลำดับพิง id ไม่ deterministic)
      const attempt1 = await passExamViaRest(listUser);
      const tick1 = await runTick();
      expect(tick1.processed, JSON.stringify(tick1)).toBeGreaterThanOrEqual(1);
      const attempt2 = await passExamViaRest(listUser);
      const tick2 = await runTick();
      expect(tick2.processed, JSON.stringify(tick2)).toBeGreaterThanOrEqual(1);
      const attempt3 = await passExamViaRest(listUser);
      const tick3 = await runTick();
      expect(tick3.processed, JSON.stringify(tick3)).toBeGreaterThanOrEqual(1);
      const list1 = await userRpc("my_notifications", listUser.accessToken, {});
      expect(list1.status, list1.text.slice(0, 300)).toBe(200);
      const page1All = list1.json as NotifListResult;
      expect(page1All.items).toHaveLength(3);
      // ยังไม่อ่านทั้งหมด → เรียง created_at ล่าสุดก่อน: [attempt3, attempt2, attempt1]
      const byAttempt = (item: NotifItem | undefined): string => item?.ref_id ?? "";
      expect(byAttempt(page1All.items[0])).toBe(attempt3);
      expect(byAttempt(page1All.items[1])).toBe(attempt2);
      expect(byAttempt(page1All.items[2])).toBe(attempt1);
      expect(page1All.unread_count).toBe(3);
      // pagination limit=2 (ยังไม่มีการอ่าน — เรียง created_at ล้วน ซึ่ง keyset ครอบ):
      // หน้าแรก [attempt3, attempt2] + next_cursor → หน้าถัดไป [attempt1] + next_cursor null
      const firstPage = await userRpc("my_notifications", listUser.accessToken, { p_limit: 2 });
      expect(firstPage.status).toBe(200);
      const firstBody = firstPage.json as NotifListResult;
      expect(firstBody.items).toHaveLength(2);
      expect(byAttempt(firstBody.items[0])).toBe(attempt3);
      expect(byAttempt(firstBody.items[1])).toBe(attempt2);
      expect(firstBody.next_cursor).not.toBeNull();
      const secondPage = await userRpc("my_notifications", listUser.accessToken, {
        p_limit: 2,
        p_after_unread: firstBody.next_cursor?.unread ?? false,
        p_after_created_at: firstBody.next_cursor?.created_at ?? "",
        p_after_id: firstBody.next_cursor?.id ?? "",
      });
      expect(secondPage.status).toBe(200);
      const secondBody = secondPage.json as NotifListResult;
      expect(secondBody.items).toHaveLength(1);
      expect(byAttempt(secondBody.items[0])).toBe(attempt1);
      expect(secondBody.next_cursor).toBeNull();
      expect(secondBody.unread_count).toBe(3);
      // อ่านตัวกลาง (attempt2) — คืน read_at
      const middle = page1All.items[1];
      const read = await userRpc("my_notification_read", listUser.accessToken, {
        p_notification_id: middle?.id ?? "",
      });
      expect(read.status, read.text.slice(0, 300)).toBe(200);
      const readAt1 = (read.json as { read_at: string }).read_at;
      expect(readAt1).toBeTruthy();
      // idempotent — อ่านซ้ำ read_at คงเดิม
      const readAgain = await userRpc("my_notification_read", listUser.accessToken, {
        p_notification_id: middle?.id ?? "",
      });
      expect(readAgain.status).toBe(200);
      expect((readAgain.json as { read_at: string }).read_at).toBe(readAt1);
      // คนอื่นอ่านแทน → RPC ปฏิเสธ (≥400) และ read_at ต้องไม่ถูกแตะ (ผลลัพธ์จริงของ
      // owner-check) — หมายเหตุ (gate r1 adj-3): RPC นี้ raise ด้วย errcode default
      // P0001 → PostgREST 12.2 แปลงเป็น HTTP 400 พร้อม message ของ raise ทะลุถึง
      // caller (P0* อื่นกลายเป็น 500) · ส่วนการเปลี่ยน message เป็น "Something went
      // wrong" ที่เคยเห็นกับ P0002 สังเกตที่ชั้น gateway ของ stack นี้ — ตรวจแยกที่
      // gateway หากจะใช้ P0002 (เหตุผลที่ 0034 §6.2 เลือก P0001)
      const stranger = await userRpc("my_notification_read", noConsentUser.accessToken, {
        p_notification_id: middle?.id ?? "",
      });
      expect(stranger.status, `stranger read HTTP ${stranger.status}`).toBeGreaterThanOrEqual(400);
      // read_at ต้องคงเดิม (เทียบแบบ normalize รูปแบบ — psql คืน '...+00' ส่วน PostgREST
      // คืน ISO '...+00:00' ต่างรูปเท่านั้น)
      const afterStranger = await psqlRows<{ read_at: string | null }>(`
        select read_at::text from public.notification_recipients
         where notification_id = '${middle?.id ?? ""}' and user_id = '${listUser.id}'
           and channel = 'in_app';
      `);
      const normTs = (s: string): string =>
        s.replace(" ", "T").replace(/\+00(:00)?$/, "Z").replace(/(\.\d{3})\d+/, "$1");
      expect(normTs(afterStranger[0]?.read_at ?? "")).toBe(normTs(readAt1));
      // หลังอ่าน: unread ก่อนเสมอ — [attempt3(unread), attempt1(unread), attempt2(read)]
      const list2 = await userRpc("my_notifications", listUser.accessToken, {});
      expect(list2.status).toBe(200);
      const pageAll = list2.json as NotifListResult;
      expect(byAttempt(pageAll.items[0])).toBe(attempt3);
      expect(byAttempt(pageAll.items[1])).toBe(attempt1);
      expect(byAttempt(pageAll.items[2])).toBe(attempt2);
      expect(pageAll.items[2]?.read_at).not.toBeNull();
      expect(pageAll.unread_count).toBe(2);
      // D-p4-13 regression: keyset ทูเปิลเต็ม — เดินหน้า limit=1 ข้ามรอยต่อ unread→read
      // (แถว read ที่ created_at เก่ากว่าแถว cursor ต้องถูกแวะถึง — keyset (created_at,id)
      // เปล่า ๆ ตัดแถวพวกนี้ทิ้ง) — ลำดับที่คาด: attempt3 → attempt1 → attempt2 แล้วจบ
      const walk: string[] = [];
      let walkCursor: NotifListResult["next_cursor"] = null;
      for (let page = 0; page < 5; page += 1) {
        const res = await userRpc("my_notifications", listUser.accessToken, {
          p_limit: 1,
          ...(walkCursor === null
            ? {}
            : {
                p_after_unread: walkCursor.unread,
                p_after_created_at: walkCursor.created_at,
                p_after_id: walkCursor.id,
              }),
        });
        expect(res.status, res.text.slice(0, 300)).toBe(200);
        const body = res.json as NotifListResult;
        if (body.items.length === 0) {
          break;
        }
        walk.push(byAttempt(body.items[0]));
        walkCursor = body.next_cursor;
        if (walkCursor === null) {
          break;
        }
      }
      expect(walk).toEqual([attempt3, attempt1, attempt2]);
    }, 60_000);

    // ─── เคส 11: renewal_reminder_scan — +7/+30 · dedupe · not_lawyer ──────────

    it("เคส 11 renewal scan: lawyer +7 → renewal.reminder.7d (ขาด '12' หน่วย · วัน DD/MM/พ.ศ.) · +30 → 30d · scan ซ้ำ already ไม่สร้างซ้ำ · citizen มี cycle → not_lawyer", async () => {
      const scan = await runScan();
      expect(scan.skipped).toBe(false);
      expect(scan.notified, JSON.stringify(scan)).toBeGreaterThanOrEqual(2);
      expect(scan.not_lawyer, JSON.stringify(scan)).toBeGreaterThanOrEqual(1);
      expect(scan.email_queued, JSON.stringify(scan)).toBeGreaterThanOrEqual(2);
      // เจาะ +7 — topic/ref_type/ref_id/severity/เนื้อหา (ขาด 12 หน่วย · วัน พ.ศ.)
      const r7Notifs = await psqlRows<{
        id: string;
        body: string;
        severity: string;
        ref_type: string;
        ref_id: string;
      }>(`
        select n.id::text, n.body, n.severity::text, n.ref_type::text, n.ref_id::text
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${r7User.id}' and nr.channel = 'in_app'
           and n.topic = 'renewal.reminder.7d';
      `);
      expect(r7Notifs).toHaveLength(1);
      expect(r7Notifs[0]?.severity).toBe("warning");
      expect(r7Notifs[0]?.ref_type).toBe("renewal_cycle");
      expect(r7Notifs[0]?.ref_id).toBe(E14_CYCLE_R7);
      expect(r7Notifs[0]?.body).toContain("12"); // ขาดอีก 12 หน่วย (ledger ว่าง)
      const thaiDate = await psqlScalar(`
        select to_char(ends_on, 'DD/MM/') || (extract(year from ends_on)::int + 543)::text
          from public.renewal_cycles where id = '${E14_CYCLE_R7}';
      `);
      expect(r7Notifs[0]?.body).toContain(thaiDate);
      // +30 — topic 30d แยกกัน
      const r30Notifs = await psqlRows<{ n: number }>(`
        select count(*)::int as n
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${r30User.id}' and nr.channel = 'in_app'
           and n.topic = 'renewal.reminder.30d';
      `);
      expect(r30Notifs[0]?.n).toBe(1);
      // อีเมลเข้าคิวสองฉบับ (consent granted ทั้งคู่)
      const renewalEmails = await psqlRows<{ templates: readonly string[] }>(`
        select jsonb_agg(template_key order by template_key) as templates
          from public.email_outbox
         where recipient_user_id in ('${r7User.id}', '${r30User.id}');
      `);
      expect(renewalEmails[0]?.templates).toEqual([
        "renewal.reminder.30d",
        "renewal.reminder.7d",
      ]);
      // citizen มี cycle — ไม่มี notification ให้
      const citizenNotifs = await psqlRows<{ n: number }>(`
        select count(*)::int as n
          from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${citizenCycleUser.id}';
      `);
      expect(citizenNotifs[0]?.n).toBe(0);
      // scan ซ้ำ — dedupe: already ≥2 ไม่สร้างเพิ่ม
      const scanAgain = await runScan();
      expect(scanAgain.skipped).toBe(false);
      expect(scanAgain.already, JSON.stringify(scanAgain)).toBeGreaterThanOrEqual(2);
      const r7After = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.notifications n
          join public.notification_recipients nr on nr.notification_id = n.id
         where nr.user_id = '${r7User.id}' and n.topic = 'renewal.reminder.7d'
           and nr.channel = 'in_app';
      `);
      expect(r7After[0]?.n).toBe(1);
    }, 45_000);

    // ─── เคส 12: email backoff — claim→complete(fail) ×5 → failed ──────────────

    it("เคส 12 email backoff: claim(5) → complete ok:false ×5 รอบ (bypass เวลา) → attempts=5 · status failed · last_error มี smtp_test_fail", async () => {
      // ระบายคิวอีเมลที่ค้างจากเคส 2/4/5/6/11 ผ่าน worker จริง (ส่งถึง Mailpit) —
      // เหลือคิวว่างก่อนทดสอบ backoff เพื่อให้ claim(5) ต้องได้แถวของเราแน่นอน
      const cronSecret = process.env.CRON_SECRET ?? "";
      expect(cronSecret.length, "CRON_SECRET ไม่พบใน env ของรัน").toBeGreaterThan(0);
      const drain = await fetch(
        "http://localhost:3000/api/internal/jobs/email-dispatch",
        { method: "POST", headers: { "x-cron-secret": cronSecret } },
      );
      expect(drain.status, `dispatch HTTP ${drain.status}`).toBe(200);
      // insert แถวคิวตรง — เจ้าของ = ผู้ใช้ที่ consent grant แล้ว (เคส 6)
      await psql(`
        insert into public.email_outbox
          (id, recipient_user_id, to_email, template_key, payload, locale, status, scheduled_at)
        values ('${E14_OUTBOX_BACKOFF}', '${creditUser.id}', '${creditUser.email}',
                'credit.adjusted',
                jsonb_build_object('notification_id',
                  'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000002'::uuid,
                  'user_id', '${creditUser.id}'::uuid,
                  'vars', jsonb_build_object('full_name', 'ทดสอบ DCR-10', 'amount', '-1.25')),
                'th', 'queued', now())
        on conflict (id) do nothing;
      `);
      for (let round = 1; round <= 5; round += 1) {
        // bypass เวลา backoff ระหว่างรอบ — บังคับ queued + available ทันที
        await psql(`
          update public.email_outbox set status = 'queued', scheduled_at = now()
           where id = '${E14_OUTBOX_BACKOFF}';
        `);
        const claim = await svcRpc("email_claim_batch", { p_limit: 5 });
        expect(claim.status, claim.text.slice(0, 300)).toBe(200);
        const mine = (claim.json as readonly ClaimRow[]).find(
          (row) => row.id === E14_OUTBOX_BACKOFF,
        );
        expect(mine, `รอบ ${round}: แถวไม่ถูก claim`).toBeDefined();
        expect(mine?.attempts).toBe(round - 1);
        const complete = await svcRpc("email_complete", {
          p_results: [{ id: E14_OUTBOX_BACKOFF, ok: false, error: "smtp_test_fail" }],
        });
        expect(complete.status, complete.text.slice(0, 300)).toBe(200);
        expect((complete.json as { retried: number }).retried).toBe(1);
      }
      // ครบ 5 ครั้ง — failed + attempts=5 + last_error คงสาเหตุเดิม
      const finalRow = await psqlRows<{
        status: string;
        attempts: number;
        error: string | null;
      }>(`
        select status::text, attempts, last_error as error
          from public.email_outbox where id = '${E14_OUTBOX_BACKOFF}';
      `);
      expect(finalRow[0]?.status).toBe("failed");
      expect(finalRow[0]?.attempts).toBe(5);
      expect(finalRow[0]?.error ?? "").toContain("smtp_test_fail");
    }, 45_000);

    // ─── เคส 13: crash reclaim — lease 10 นาทีจากจุด claim (gate r1 M1) ─────────

    it("เคส 13 crash reclaim: claim → sending + lease อนาคต → claim ซ้ำไม่ได้ → lease หมด (worker ตาย) → claim ได้แถวเดิม attempts คงเดิม", async () => {
      // insert ตรง — เจ้าของ creditUser (consent grant อยู่ · เคส 14 จะ revoke ทีหลัง)
      await psql(`
        insert into public.email_outbox
          (id, recipient_user_id, to_email, template_key, payload, locale, status, scheduled_at)
        values ('${E14_OUTBOX_RECLAIM}', '${creditUser.id}', '${creditUser.email}',
                'credit.adjusted',
                jsonb_build_object('notification_id',
                  'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000003'::uuid,
                  'user_id', '${creditUser.id}'::uuid,
                  'vars', jsonb_build_object('full_name', 'ทดสอบ DCR-10', 'amount', '-1.25')),
                'th', 'queued', now())
        on conflict (id) do nothing;
      `);
      // claim ครั้งแรก — ได้แถว → status 'sending' + lease = now()+10 นาที (M1)
      const claim1 = await svcRpc("email_claim_batch", { p_limit: 5 });
      expect(claim1.status, claim1.text.slice(0, 300)).toBe(200);
      const mine1 = (claim1.json as readonly ClaimRow[]).find(
        (row) => row.id === E14_OUTBOX_RECLAIM,
      );
      expect(mine1, "claim ครั้งแรกต้องได้แถวของเคส 13").toBeDefined();
      expect(mine1?.attempts).toBe(0);
      const leased = await psqlRows<{ status: string; lease_future: boolean }>(`
        select status::text, scheduled_at > now() as lease_future
          from public.email_outbox where id = '${E14_OUTBOX_RECLAIM}';
      `);
      expect(leased[0]?.status).toBe("sending");
      expect(leased[0]?.lease_future).toBe(true);
      // claim ซ้ำระหว่าง lease ยังมีชีวิต — ต้อง "ไม่" ได้แถวนี้กลับ (ไม่ส่งซ้ำสอง worker)
      const claim2 = await svcRpc("email_claim_batch", { p_limit: 5 });
      expect(claim2.status).toBe(200);
      const mine2 = (claim2.json as readonly ClaimRow[]).find(
        (row) => row.id === E14_OUTBOX_RECLAIM,
      );
      expect(mine2, "lease ยังไม่หมดต้องไม่ถูก claim ซ้ำ").toBeUndefined();
      // จำลอง worker ตายกลางทาง — คงสถานะ sending แต่บังคับ lease หมดอายุแล้ว
      await psql(`
        update public.email_outbox set scheduled_at = now() - interval '1 minute'
         where id = '${E14_OUTBOX_RECLAIM}';
      `);
      const claim3 = await svcRpc("email_claim_batch", { p_limit: 5 });
      expect(claim3.status).toBe(200);
      const mine3 = (claim3.json as readonly ClaimRow[]).find(
        (row) => row.id === E14_OUTBOX_RECLAIM,
      );
      expect(mine3, "lease หมดแล้วต้อง reclaim ได้").toBeDefined();
      // reclaim ไม่ใช่ความล้มเหลว — attempts คง 0 (เพิ่มเฉพาะเมื่อ complete ok:false)
      expect(mine3?.attempts).toBe(0);
      // ปิดจ๊อบให้เรียบร้อย (sent) — ไม่ทิ้งแถวค้าง sending ให้ cron จริง
      const complete = await svcRpc("email_complete", {
        p_results: [{ id: E14_OUTBOX_RECLAIM, ok: true }],
      });
      expect(complete.status, complete.text.slice(0, 300)).toBe(200);
      expect((complete.json as { sent: number }).sent).toBe(1);
    }, 30_000);

    // ─── เคส 14: grant→enqueue→revoke — claim ต้องปิดเป็น failed ไม่ส่ง (gate r1 B2) ──

    it("เคส 14 claim-time deny: enqueue ตอน grant → revoke consent → claim → ไม่คืนแถว · status failed + last_error email_gate_denied_before_send", async () => {
      // enqueue ขณะสิทธิ์ยัง valid (เลียนแบบสิ่งที่ tick ทำในคิวจริง)
      await psql(`
        insert into public.email_outbox
          (id, recipient_user_id, to_email, template_key, payload, locale, status, scheduled_at)
        values ('${E14_OUTBOX_REVOKE}', '${creditUser.id}', '${creditUser.email}',
                'credit.adjusted',
                jsonb_build_object('notification_id',
                  'aaaaaaaa-aaaa-4aaa-8aaa-e14a00000004'::uuid,
                  'user_id', '${creditUser.id}'::uuid,
                  'vars', jsonb_build_object('full_name', 'ทดสอบ DCR-10', 'amount', '-1.25')),
                'th', 'queued', now())
        on conflict (id) do nothing;
      `);
      // revoke email_notify ผ่าน RPC จริง (append-only — ล่าสุดชนะ)
      const revoke = await userRpc("my_consents_update", creditUser.accessToken, {
        p_type: "email_notify",
        p_action: "revoke",
      });
      expect(revoke.status, revoke.text.slice(0, 300)).toBe(200);
      expect((revoke.json as { status: string }).status).toBe("revoked");
      // claim — แถวต้องถูกปฏิเสธ "ก่อน" ถึงมือ provider: ไม่คืนใน result set เลย
      const claim = await svcRpc("email_claim_batch", { p_limit: 5 });
      expect(claim.status, claim.text.slice(0, 300)).toBe(200);
      const mine = (claim.json as readonly ClaimRow[]).find(
        (row) => row.id === E14_OUTBOX_REVOKE,
      );
      expect(mine, "แถวที่ถูกปฏิเสธต้องไม่ถูกคืนให้ worker ส่ง").toBeUndefined();
      // และถูกปิดถาวรเป็น failed พร้อม last_error คงที่ (ไม่ reclaim วนซ้ำ)
      const denied = await psqlRows<{ status: string; error: string | null; sent_at: string | null }>(`
        select status::text, last_error as error, sent_at::text
          from public.email_outbox where id = '${E14_OUTBOX_REVOKE}';
      `);
      expect(denied[0]?.status).toBe("failed");
      expect(denied[0]?.error).toBe("email_gate_denied_before_send");
      expect(denied[0]?.sent_at).toBeNull();
      // claim ซ้ำอีกรอบ — แถว failed ไม่ถูกหยิบอีก (จบเรื่องจริง ไม่ retry)
      const claimAgain = await svcRpc("email_claim_batch", { p_limit: 5 });
      expect(claimAgain.status).toBe(200);
      const mineAgain = (claimAgain.json as readonly ClaimRow[]).find(
        (row) => row.id === E14_OUTBOX_REVOKE,
      );
      expect(mineAgain).toBeUndefined();
    }, 30_000);

    // ─── เคส 15: ประตูรายช่องทาง in_app/email แยกกัน (gate r1 B3 / NTF-005) ──────

    it("เคส 15 ประตูรายช่องทาง: credit.in_app=false อย่างเดียว → notification มีแต่ไม่มี recipient in_app (inbox มองไม่เห็น) · ปิดครบทั้งคู่ → skipped_no_channel ≥1 ไม่เกิดแถวใหม่ · event ปิด processed", async () => {
      // ขา A — ปิด in_app เฉพาะ family credit (email ยังเปิด + consent grant)
      const offInApp = await userRpc("my_notification_settings_update", gateUser.accessToken, {
        p_settings: { credit: { in_app: false, email: true } },
      });
      expect(offInApp.status, offInApp.text.slice(0, 300)).toBe(200);
      const adjust1 = await userRpc("admin_credit_adjust", registrarAal2Token, {
        p_user_id: gateUser.id,
        p_cycle_id: E14_CYCLE_GATE,
        p_credit_type: "general",
        p_amount: -0.5,
        p_reason: "ทดสอบประตูรายช่องทาง in_app ปิดของ DCR-10 ขา A",
        p_request_id: crypto.randomUUID(),
      });
      expect(adjust1.status, adjust1.text.slice(0, 300)).toBe(200);
      const ledger1 = (adjust1.json as { id: string }).id;
      const tick1 = await runTick();
      expect(tick1.skipped).toBe(false);
      expect(tick1.processed, JSON.stringify(tick1)).toBeGreaterThanOrEqual(1);
      // notification เกิด (ที่เก็บเนื้อหาอ้างอิงของอีเมล) แต่ "ไม่มี" recipient in_app —
      // เหลือแค่ email · my_notifications จึงมองไม่เห็น (badge/inbox ไม่นับ)
      const row1 = await psqlRows<{ in_app: number; email: number }>(`
        select
          count(*) filter (where nr.channel = 'in_app')::int as in_app,
          count(*) filter (where nr.channel = 'email')::int as email
        from public.notifications n
        join public.notification_recipients nr on nr.notification_id = n.id
        where n.topic = 'credit.adjusted' and n.ref_id = '${ledger1}';
      `);
      expect(row1[0]?.in_app).toBe(0);
      expect(row1[0]?.email).toBe(1);
      const inbox1 = await userRpc("my_notifications", gateUser.accessToken, {});
      expect(inbox1.status).toBe(200);
      const inbox1Body = inbox1.json as NotifListResult;
      expect(inbox1Body.items).toHaveLength(0);
      expect(inbox1Body.unread_count).toBe(0);
      // อีเมลยังเข้าคิวตามสิทธิ์ (consent grant + email on)
      const outbox1 = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.email_outbox
         where recipient_user_id = '${gateUser.id}' and template_key = 'credit.adjusted';
      `);
      expect(outbox1[0]?.n).toBe(1);
      // ขา B — ปิดครบทั้งสองช่องทาง → event ถูกข้าม ไม่เกิดแถวเลย และปิดเป็น processed
      const offAll = await userRpc("my_notification_settings_update", gateUser.accessToken, {
        p_settings: { credit: { in_app: false, email: false } },
      });
      expect(offAll.status, offAll.text.slice(0, 300)).toBe(200);
      const adjust2 = await userRpc("admin_credit_adjust", registrarAal2Token, {
        p_user_id: gateUser.id,
        p_cycle_id: E14_CYCLE_GATE,
        p_credit_type: "general",
        p_amount: -0.75,
        p_reason: "ทดสอบปิดครบทั้งสองช่องทางของ DCR-10 ขา B",
        p_request_id: crypto.randomUUID(),
      });
      expect(adjust2.status, adjust2.text.slice(0, 300)).toBe(200);
      const ledger2 = (adjust2.json as { id: string }).id;
      const tick2 = await runTick();
      expect(tick2.skipped).toBe(false);
      expect(tick2.skipped_no_channel, JSON.stringify(tick2)).toBeGreaterThanOrEqual(1);
      // event ของ adjust2 ปิดเป็น processed (ไม่ค้าง pending วน retry ตลอดไป)
      const event2 = await psqlRows<{ status: string }>(`
        select status::text from public.event_outbox
         where topic = 'credit.adjusted' and payload ->> 'ledger_id' = '${ledger2}';
      `);
      expect(event2).toHaveLength(1);
      expect(event2[0]?.status).toBe("processed");
      // ไม่เกิด notification/recipients ใหม่สำหรับ ledger2 · outbox ยังเป็นของขา A แถวเดิม
      const row2 = await psqlRows<{ notifs: number; recipients: number }>(`
        select
          (select count(*) from public.notifications where topic = 'credit.adjusted'
             and ref_id = '${ledger2}')::int as notifs,
          (select count(*) from public.notification_recipients nr
             join public.notifications n on n.id = nr.notification_id
            where n.topic = 'credit.adjusted' and n.ref_id = '${ledger2}')::int as recipients;
      `);
      expect(row2[0]?.notifs).toBe(0);
      expect(row2[0]?.recipients).toBe(0);
      const outbox2 = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.email_outbox
         where recipient_user_id = '${gateUser.id}';
      `);
      expect(outbox2[0]?.n).toBe(1);
    }, 60_000);
  },
);
