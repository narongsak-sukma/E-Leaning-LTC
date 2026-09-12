/**
 * dispatch — email worker ของ NTF-006 (Wave E Phase 4 · D-p4-7/D-p4-8)
 *
 * ตัวกระทำเดียวของระบบที่ "ส่งเมล์จริง": claim → render → send → complete
 *
 * - claim: RPC `email_claim_batch` ผ่าน service-role client (email_outbox เป็น
 *   service-only ตาม RLS 0010:865-867) — คืนแถว [{id, to_email, template_key,
 *   payload, locale}] (สัญญา lane A แผน §4.7)
 * - render: active template จาก notification_templates (channel='email') แทน {{var}}
 *   ด้วย payload — var ที่ template ต้องการแต่ payload ไม่มี = แถวนั้น fail-loud
 *   (ไม่ส่งเมล์เพี้ยน) ตามแบบแผน render_notification (แผน §4.7 item 3)
 * - send: ผ่าน provider (createEmailSender — console|smtp|resend ตาม config)
 * - complete: RPC `email_complete(p_results)` ครั้งเดียวต่อ batch รับ [{id, ok, error}]
 * - วนจน claim คืนว่างหรือครบ maxBatches — คืนสรุป {claimed, sent, failed}
 * - ห้าม log to_email/payload ทุก environment — logger allowlist (SDS §6.2)
 */
import "server-only";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { createEmailSender, type EmailSender } from "./providers";

/** ขนาด batch ต่อการ claim/complete หนึ่งครั้ง (D-p4-7 — batch ≤20) */
export const EMAIL_CLAIM_BATCH_SIZE = 20;

/** จำนวน batch สูงสุดต่อการรันหนึ่งรอบ — default ของ runEmailDispatch */
export const EMAIL_DISPATCH_MAX_BATCHES = 5;

/** รูปแบบ UUID (แบบเดียวกับ lib/api/pagination) — ใช้ชั้น drift-row reporting */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * แถวของ email_claim_batch — strict: คีย์เกิน/คีย์ขาด/ค่าผิดชนิด = drift →
 * แถวนั้นไม่ถูกส่ง (fail-closed) และรายงาน drift เข้าคิวให้ attempts+1/backoff
 */
export const ClaimedEmailRowSchema = z
  .object({
    id: z.uuid(),
    // สัญญาจริงของ RPC (0034 §7.1) — superset ของแผน §4.7: มี recipient_user_id + attempts เพิ่ม
    recipient_user_id: z.uuid().nullable(),
    to_email: z.string().min(3).max(320),
    template_key: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
    locale: z.enum(["th", "en"]),
    attempts: z.number().int().min(0),
  })
  .strict();

/** ชนิดแถวที่ parse ผ่านแล้ว (z.infer ของ ClaimedEmailRowSchema) */
export type ClaimedEmailRow = z.infer<typeof ClaimedEmailRowSchema>;

/** ผลลัพธ์ต่อแถวที่รายงาน email_complete */
export interface EmailCompleteItem {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** template ที่ render ได้ (subject_tpl/body_tpl ของ notification_templates) */
interface EmailTemplate {
  readonly subjectTpl: string;
  readonly bodyTpl: string;
}

/** {{var}} — ชื่อ var เป็น [a-z0-9_] ตาม seed template (แผน §4 item 1) */
const TEMPLATE_VAR_RE = /\{\{([a-z0-9_]+)\}\}/g;

/**
 * แทน {{var}} ใน template ด้วย payload — คืน text + รายชื่อ var ที่ payload ไม่มี
 * (fail-loud ให้ผู้เรียกตัดสิน) · scalar เท่านั้น (string/number/boolean) —
 * jsonb ซ้อน/null/ไม่มีคีย์ = ถือว่า var หาย (ไม่แทนด้วยค่าว่างเงียบ ๆ)
 */
export function renderTemplateVars(
  tpl: string,
  payload: Record<string, unknown>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = tpl.replace(TEMPLATE_VAR_RE, (raw: string, key: string) => {
    const value = payload[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    missing.push(key);
    return raw;
  });
  return { text, missing };
}

/**
 * ดึง active template (channel='email') — cache ต่อ run กันยิงซ้ำใน batch เดียว ·
 * ไม่มีแถว (data null ไม่มี error) = โครงสร้างถาวร → cache null ได้ · error ชั่วคราว
 * (network/DB) = **ไม่ cache** ให้แถวถัดไปลองใหม่ (fail-closed ต่อแถว)
 */
async function loadEmailTemplate(
  client: ReturnType<typeof createSupabaseServiceRoleClient>,
  cache: Map<string, EmailTemplate | null>,
  templateKey: string,
  locale: string,
): Promise<EmailTemplate | null> {
  const cacheKey = `${templateKey}|${locale}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const { data, error } = await client
    .from("notification_templates")
    .select("subject_tpl,body_tpl")
    .eq("template_key", templateKey)
    .eq("locale", locale)
    .eq("channel", "email")
    .eq("is_active", true)
    .maybeSingle();
  if (error !== null) {
    return null; // error ชั่วคราว — ไม่ cache
  }
  if (data === null || typeof data.subject_tpl !== "string" || typeof data.body_tpl !== "string") {
    // ไม่มี active template หรือชนิดเพี้ยน (drift) — โครงสร้างถาวร → cache ได้
    cache.set(cacheKey, null);
    return null;
  }
  const tpl: EmailTemplate = { subjectTpl: data.subject_tpl, bodyTpl: data.body_tpl };
  cache.set(cacheKey, tpl);
  return tpl;
}

/** สรุปผลการรันหนึ่งรอบ — โครงสร้างตอบกลับของ cron endpoint (D-p4-8) */
export interface DispatchSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
}

/** ผลการประมวลผลแถวเดียว — item null = id เสีย รายงาน email_complete ไม่ได้ */
interface RowOutcome {
  readonly item: EmailCompleteItem | null;
  readonly sent: boolean;
}

/**
 * ประมวลผลแถวคิวเดียว: parse สัญญา → template → render → send · ทุกทางล้มเหลว
 * กลับเป็นผลลัพธ์ ok=false พร้อม static token (ไม่มี PII · ไม่ throw เด็ดขาด —
 * แถวพิษต้องไม่ทำ batch ทั้งชุดตาย)
 */
async function processEmailRow(
  raw: unknown,
  ctx: {
    client: ReturnType<typeof createSupabaseServiceRoleClient>;
    cache: Map<string, EmailTemplate | null>;
    sender: EmailSender;
  },
): Promise<RowOutcome> {
  const parsed = ClaimedEmailRowSchema.safeParse(raw);
  if (!parsed.success) {
    // drift: id ยังใช้ได้ = รายงาน drift เข้าคิว (attempts+1 ไปเบื้องหลัง) ·
    // id เสียด้วย = รายงานไม่ได้ (นับ failed เฉย ๆ — แถวถูก reclaim ใน 10 นาที)
    const id =
      typeof raw === "object" && raw !== null && "id" in raw
        ? (raw as { id: unknown }).id
        : undefined;
    if (typeof id === "string" && UUID_RE.test(id)) {
      return { item: { id, ok: false, error: "row_contract_drift" }, sent: false };
    }
    return { item: null, sent: false };
  }
  const row = parsed.data;
  // ตัวแปร render อยู่ใต้ payload.vars ตามสัญญาผู้ผลิต (0034 §4a/§4b: payload =
  // {notification_id, user_id, vars} — D-p4-7/8) · ไม่มี vars/ไม่ใช่ object = drift
  // รายแถว (fail-closed — ไม่พยายามเดาจาก payload แบน)
  const varsRaw = row.payload["vars"];
  let vars: Record<string, unknown> | null =
    varsRaw !== null && typeof varsRaw === "object" && !Array.isArray(varsRaw)
      ? (varsRaw as Record<string, unknown>)
      : null;
  if (vars === null) {
    return { item: { id: row.id, ok: false, error: "row_contract_drift" }, sent: false };
  }
  // gate r1 B4: ตรวจสัญญา payload ครบ "ก่อน" เรียก provider — notification_id/user_id
  // ต้องเป็น UUID จริง (เดิมตรวจแค่ vars เป็น object: payload พิษ notification_id="bad"
  // จะถูกส่งจริงก่อน แล้ว cast ใน email_complete ล้ม → subtx ย้อนสถานะคืน sending →
  // reclaim มาส่งซ้ำได้โดย attempts ไม่โต) — ผิดสัญญา = fail รายแถวก่อนส่ง ให้
  // complete นับ attempts ตามกติกา backoff
  const notificationId = row.payload["notification_id"];
  const payloadUserId = row.payload["user_id"];
  if (
    typeof notificationId !== "string" ||
    !UUID_RE.test(notificationId) ||
    typeof payloadUserId !== "string" ||
    !UUID_RE.test(payloadUserId)
  ) {
    return { item: { id: row.id, ok: false, error: "row_contract_drift" }, sent: false };
  }
  // gate r1 B5 (NTF-003): template อีเมลใบประกาศฯ อ้าง {{verify_url}}/{{pdf_url}} —
  // URL ประกอบที่ worker จาก config ของแอป (SQL ผู้ผลิตไม่รู้ env): vars มี
  // verify_code = แถวใบประกาศฯ → ฉีดลิงก์หน้าตรวจสอบ (/verify/<code>) และ PDF
  // (/api/v1/certificates/<code>/pdf) · template อื่นไม่อ้างตัวแปรคู่นี้ = ไม่กระทบ
  // · certPublicBaseUrl มีที่ตั้ง (prod — โดเมน certificate สาธารณะ) ไม่มี = ใช้
  // publicBaseUrl ของแอป (dev)
  const verifyCode = vars["verify_code"];
  if (typeof verifyCode === "string" && verifyCode.length > 0) {
    const config = getConfig();
    const base = config.certPublicBaseUrl ?? config.publicBaseUrl;
    vars = {
      ...vars,
      verify_url: `${base}/verify/${verifyCode}`,
      pdf_url: `${base}/api/v1/certificates/${verifyCode}/pdf`,
    };
  }
  const tpl = await loadEmailTemplate(ctx.client, ctx.cache, row.template_key, row.locale);
  if (tpl === null) {
    return { item: { id: row.id, ok: false, error: "template_missing" }, sent: false };
  }
  const subject = renderTemplateVars(tpl.subjectTpl, vars);
  const body = renderTemplateVars(tpl.bodyTpl, vars);
  if (subject.missing.length > 0 || body.missing.length > 0) {
    return { item: { id: row.id, ok: false, error: "template_var_missing" }, sent: false };
  }
  const sendResult = await ctx.sender({
    to: row.to_email,
    subject: subject.text,
    body: body.text,
  });
  if (sendResult.ok) {
    return { item: { id: row.id, ok: true }, sent: true };
  }
  return {
    item: { id: row.id, ok: false, error: sendResult.error ?? "send_failed" },
    sent: false,
  };
}

/**
 * runEmailDispatch — รัน worker หนึ่งรอบ (claim→render→send→complete ต่อ batch) ·
 * วนจน claim คืนว่างหรือครบ maxBatches · คืนสรุป {claimed, sent, failed} ·
 * เรียกจาก POST /api/internal/jobs/email-dispatch (D-p4-8) — ไม่ throw (log ต่อ
 * ความล้มเหลวของ RPC แล้วคืนสรุปย่อย) เพื่อให้ cron ได้ 200 เสมอเมื่อผ่าน secret
 */
export async function runEmailDispatch(
  options: { maxBatches?: number } = {},
): Promise<DispatchSummary> {
  const maxBatches = options.maxBatches ?? EMAIL_DISPATCH_MAX_BATCHES;
  const config = getConfig();
  const logger = createLogger(config.logLevel);
  const client = createSupabaseServiceRoleClient();
  const sender = createEmailSender(config);
  const cache = new Map<string, EmailTemplate | null>();
  let claimed = 0;
  let sent = 0;
  let failed = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { data, error } = await client.rpc("email_claim_batch", {
      p_limit: EMAIL_CLAIM_BATCH_SIZE,
    });
    if (error !== null) {
      logger.warn("email_dispatch_claim_rpc_failed", { status: "rpc_error" });
      break;
    }
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      break;
    }
    claimed += rows.length;
    const results: EmailCompleteItem[] = [];
    for (const raw of rows) {
      const outcome = await processEmailRow(raw, { client, cache, sender });
      if (outcome.item !== null) {
        results.push(outcome.item);
      }
      if (outcome.sent) {
        sent += 1;
      } else {
        failed += 1;
      }
    }
    if (results.length > 0) {
      const { error: completeError } = await client.rpc("email_complete", {
        p_results: results,
      });
      if (completeError !== null) {
        logger.warn("email_dispatch_complete_rpc_failed", { status: "rpc_error" });
      }
    }
  }
  return { claimed, sent, failed };
}
