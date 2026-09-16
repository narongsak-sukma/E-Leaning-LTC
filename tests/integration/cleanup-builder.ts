/**
 * tests/integration/cleanup-builder.ts — D89-1 builder กลางล้างผู้ใช้ทดสอบ [#94]
 * (plan §2-D89-1/D89-2 ชั้นที่ 2 · แผน r30 APPROVED)
 *
 * ห้านโยบายต่อ (table, column): OWNED-DELETE · ACTOR-NULLIFY · SOLE-LINK-DELETE ·
 * ASSERT-FAIL · SHARED-COND — inventory นิ่งถูกพิสูจน์กับ catalog จริงโดย drift test
 * (wave-h-cleanup-fk-proof) · ไม่ import อะไรจาก helpers เลย (helpers import กลับเข้ามา —
 * ห้ามวงจร) · executor ฉีดผ่าน `exec` (psql ของ helpers)
 *
 * ชั้นที่ 2 defense-in-depth (TX เดียว ตามแผน §2-D89-2):
 *   BEGIN → LOCK TABLE ทุกตารางที่เขียน SHARE ROW EXCLUSIVE NOWAIT (55P03 → rollback
 *   ทั้ง TX → caller retry ×3 jitter) → select profiles FOR UPDATE (40P01 → retry) →
 *   SOLE-LINK-DELETE (non-FK) → ACTOR-NULLIFY/SELF-LINK-NULLIFY → OWNED-DELETE ตาม
 *   FK topological (leaf ก่อน — credit_ledger_entries ก่อน certificates คือบั๊กจริง
 *   r6:2311) พร้อม toggle trigger append-only ใน TX เดียวกัน (คง pattern purgeLedgerOf
 *   dcr9) → post-guard RAISE table.column=count → delete profiles/auth.users → COMMIT
 *
 * audit_logs + audit_chain_anchors = append-only ตามดีไซน์ ตั้งใจไม่แตะ (D8/D9 เดิม)
 */

export type CleanupPolicy =
  | "OWNED-DELETE" // แถวเป็นของผู้ใช้ — ลบ (user_id/recipient_user_id/requested_by/target_user_id)
  | "ACTOR-NULLIFY" // คอลัมน์นี้เป็น actor/self-link ชี้ผู้ใช้ (nullable) — set null แถวของคนอื่น
  | "SOLE-LINK-DELETE" // non-FK link (payload/verify_code) — ลบก่อนเจ้าของถูกลบ
  | "SHARED-COND" // แถวประวัติร่วม (CHECK บังคับ actor คงเดิม เช่น ledger reversal) — ไม่แตะ
  //             // แถวของผู้ใช้เองถูกลบทาง OWNED · ค้างอ้างข้ามเจ้า = post-guard RAISE
  | "ASSERT-FAIL"; // NOT NULL actor — ห้าม nullify/ลบ: เหลือแถว = RAISE ให้ suite จัดการเอง

export interface CleanupEntry {
  /** ตาราง public (ไม่มี prefix) */
  readonly table: string;
  /** คอลัมน์ที่ผูกผู้ใช้ — SOLE-LINK-DELETE ใช้คอลัมน์อ่าน/เงื่อนไขพิเศษ */
  readonly column: string;
  readonly policy: CleanupPolicy;
  /**
   * เงื่อนไขจริงของแถวที่ผูก userIds — default `"<column> in (…)"`;
   * SOLE-LINK/SELF-LINK ใส่ template ที่อ้าง subselect ของแถวผู้ใช้ (ยังไม่ถูกลบ)
   */
  readonly where?: (ids: string) => string;
  /** post-guard: นับแถวที่ยังอ้างผู้ใช้ผ่านคอลัมน์นี้ (default = where แบบตรง) */
  readonly residual?: (ids: string) => string;
  /** เขียนตารางนี้ = เข้า LOCK TABLE + toggle trigger ถ้ามี trigger append-only */
  readonly writesTable?: boolean;
}

/** ตัว escape uuid เดียว — ค่าทุกชิ้นที่ฝัง SQL ต้องผ่านนี่ */
export function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function inList(ids: readonly string[]): string {
  return ids.map(sqlLiteral).join(",");
}

// ─── inventory นิ่ง (drift test ตรวจกับ catalog ทุกครั้ง) ───────────────────────
//
// ลำดับรันจริงแยก group จาก array นี้: SOLE-LINK ก่อน (ยังต้องมีแถวเจ้าของให้ subselect
// เห็น) → nullify → OWNED-DELETE leaf→root ตาม FK DAG → profiles/auth.users ท้ายสุด
// โดย runUserCleanup แยก group เอง — ที่นี่เก็บ leaf-first เรียงมือให้อ่านตาม FK จริง
export const CLEANUP_INVENTORY: readonly CleanupEntry[] = [
  // — SOLE-LINK-DELETE (non-FK · ต้องลบก่อนแถวเจ้าของหาย) —
  {
    table: "event_outbox",
    column: "payload",
    policy: "SOLE-LINK-DELETE",
    where: (ids) =>
      `payload->>'user_id' in (${ids}) or payload->>'source_id' in (select a.id::text from public.assessment_attempts a where a.user_id in (${ids}))`,
    residual: (ids) => `payload->>'user_id' in (${ids})`,
    writesTable: true,
  },
  {
    table: "certificate_verifications",
    column: "verify_code",
    policy: "SOLE-LINK-DELETE",
    where: (ids) =>
      `verify_code in (select c.verify_code from public.certificates c where c.user_id in (${ids}))`,
    residual: (ids) =>
      `verify_code in (select c.verify_code from public.certificates c where c.user_id in (${ids}))`,
    writesTable: true,
  },
  // — ACTOR-NULLIFY (nullable · แถวของคนอื่นที่ชี้ผู้ใช้) / SELF-LINK —
  { table: "certificates", column: "superseded_by", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "certificates", column: "supersedes_cert_id", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "credit_ledger_entries", column: "original_entry_id", policy: "ACTOR-NULLIFY", writesTable: true },
  {
    // CHECK จริง: adjustment/reversal บังคับ created_by NOT NULL (ledger = ประวัติ
    // การเงิน append-only) — nullify ไม่ได้ ลบของคนอื่นไม่ได้ → SHARED-COND:
    // แถวของผู้ใช้เอง (user_id ตรง) ลบทาง OWNED · ค้างอ้างข้ามเจ้า = RAISE ให้ suite จัดการ
    table: "credit_ledger_entries",
    column: "created_by",
    policy: "SHARED-COND",
    residual: (ids) => `created_by in (${ids}) and user_id not in (${ids})`,
  },
  { table: "enrollments", column: "created_by", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "role_assignments", column: "granted_by", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "lawyer_licenses", column: "verified_by", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "license_applications", column: "decided_by", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "notifications", column: "created_by", policy: "ACTOR-NULLIFY", writesTable: true },
  { table: "feature_flags", column: "updated_by", policy: "ACTOR-NULLIFY", writesTable: true },
  // — OWNED-DELETE leaf→root (ตาม FK DAG จริง — drift test enforce) —
  { table: "attempt_answers", column: "attempt_id", policy: "OWNED-DELETE", writesTable: true,
    where: (ids) => `attempt_id in (select a.id from public.assessment_attempts a where a.user_id in (${ids}))` },
  { table: "assessment_attempts", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "lesson_progress", column: "enrollment_id", policy: "OWNED-DELETE", writesTable: true,
    where: (ids) => `enrollment_id in (select e.id from public.enrollments e where e.user_id in (${ids}))` },
  { table: "quiz_attempts", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  // credit_ledger_entries ต้องมาก่อน certificates — FK certificate_id→certificates
  // (บั๊กจริง r6:2311: ลบ certificates ก่อน ledger = FK violation)
  { table: "credit_ledger_entries", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "certificates", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "notification_recipients", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "renewal_cycles", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "license_applications", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "lawyer_licenses", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "notification_settings", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "consents", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "notice_acknowledgments", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "security_events", column: "target_user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "admin_sessions", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "data_export_jobs", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "email_outbox", column: "recipient_user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "report_exports", column: "requested_by", policy: "OWNED-DELETE", writesTable: true },
  // media ของผู้ใช้เอง (pdpa-exports artifacts ที่ worker เขียน uploaded_by=user —
  // พิสูจน์จริงจาก cron PDPA-export บน dev) — ต้องอยู่หลังตารางที่ FK ชี้เข้า media
  // (certificates · report_exports · data_export_jobs) ทั้งหมด
  { table: "media_assets", column: "uploaded_by", policy: "OWNED-DELETE", writesTable: true },
  { table: "enrollments", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "mfa_backup_attempts", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "mfa_backup_codes", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "mfa_pending_stash", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "account_deletion_requests", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  { table: "role_assignments", column: "user_id", policy: "OWNED-DELETE", writesTable: true },
  // — ASSERT-FAIL (NOT NULL actor · แถว suite-owned — เหลือ = ล้มดังให้ suite เคลียร์เอง) —
  { table: "certificates", column: "issued_by", policy: "ASSERT-FAIL" },
  { table: "cert_bulk_jobs", column: "created_by", policy: "ASSERT-FAIL" },
  { table: "courses", column: "created_by", policy: "ASSERT-FAIL" },
  { table: "question_banks", column: "created_by", policy: "ASSERT-FAIL" },
  { table: "questions", column: "created_by", policy: "ASSERT-FAIL" },
];

/** ตาราง append-only ที่ OWNED-DELETE/NULLIFY เขียน → toggle trigger ใน TX เดียว */
export const APPEND_ONLY_TRIGGER: ReadonlyMap<string, string> = new Map([
  ["consents", "trg_append_only_rows"],
  ["credit_ledger_entries", "trg_append_only_rows"],
  ["notice_acknowledgments", "trg_append_only_rows"],
  ["security_events", "trg_append_only_rows"],
]);

/** ตาราง append-only ที่ตั้งใจคงไว้ (ไม่ลบเด็ดขาด — ดีไซน์ D8/D9) */
export const APPEND_ONLY_KEEP: readonly string[] = ["audit_logs", "audit_chain_anchors"];

// ─── pre-guard: schema สด + CHECK-aware (idempotent — เรียกซ้ำได้) ─────────────

export class CleanupGuardError extends Error {
  readonly reason: string;
  constructor(reason: string, detail: string) {
    super(`assertCleanupAllowed: ${reason} — ${detail}`);
    this.reason = reason;
  }
}

export type SqlExec = (sql: string) => Promise<string>;

/**
 * pre-guard ก่อนสร้าง/รัน cleanup (guard ชั้น 1): inventory ตรง schema จริง
 * ตอนนี้ (สด) — ทุก (table, column) มีจริง · ACTOR-NULLIFY ต้อง nullable
 * (CHECK-aware: NOT NULL ที่ nullify ไม่ได้ = ผิดนโยบาย) · ASSERT-FAIL ต้อง NOT NULL
 * · trigger append-only ของตารางที่เขียนมีจริง · เรียกกี่ครั้งก็ได้ (คืนค่าเดิม)
 */
export async function assertCleanupAllowedVia(exec: SqlExec): Promise<void> {
  const rows = await exec(`
    select t.table_name || '|' || t.column_name || '|' || t.is_nullable
    from information_schema.columns t
    where t.table_schema = 'public'
      and (${CLEANUP_INVENTORY.map((e) => `(t.table_name='${e.table}' and t.column_name='${e.column}')`).join(" or ")})
    order by 1;`);
  const found = new Map<string, string>();
  for (const line of rows.trim().split("\n").filter((l) => l.length > 0)) {
    const [tbl, col, nullable] = line.split("|");
    found.set(`${tbl}.${col}`, nullable ?? "?");
  }
  for (const e of CLEANUP_INVENTORY) {
    const key = `${e.table}.${e.column}`;
    const nullable = found.get(key);
    if (nullable === undefined) {
      throw new CleanupGuardError("schema-drift", `ไม่มีคอลัมน์ ${key} ใน schema จริง (inventory เก่า?)`);
    }
    if (e.policy === "ACTOR-NULLIFY" && nullable !== "YES") {
      throw new CleanupGuardError("check-violation", `${key} ไม่ nullable แต่นโยบาย ACTOR-NULLIFY`);
    }
    if (e.policy === "ASSERT-FAIL" && nullable === "YES") {
      throw new CleanupGuardError("check-violation", `${key} nullable — ควรเป็น ACTOR-NULLIFY ไม่ใช่ ASSERT-FAIL`);
    }
  }
  const trg = await exec(`
    select c.relname || '|' || t.tgname
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public'
      and t.tgname = 'trg_append_only_rows' and pg_get_triggerdef(t.oid) like '%BEFORE%'
      and (${[...APPEND_ONLY_TRIGGER.keys()].map((t) => `c.relname='${t}'`).join(" or ")});`);
  const trgFound = new Set(trg.trim().split("\n").filter((l) => l.length > 0).map((l) => l.split("|")[0] ?? ""));
  for (const t of APPEND_ONLY_TRIGGER.keys()) {
    if (!trgFound.has(t)) {
      throw new CleanupGuardError("schema-drift", `ตาราง ${t} ไม่มี trigger append-only ตาม APPEND_ONLY_TRIGGER`);
    }
  }
}

// ─── builder: SQL เดียวต่อ batch (TX เดียว) ─────────────────────────────────

export interface CleanupSql {
  readonly sql: string;
  readonly lockedTables: readonly string[];
  /** ตาราง OWNED/SOLE-LINK ตามลำดับในสคริปต์ (assert/หลักฐาน) */
  readonly deleteOrder: readonly string[];
}

function directWhere(e: CleanupEntry, ids: string): string {
  if (e.where !== undefined) return e.where(ids);
  return `${e.column} in (${ids})`;
}

/**
 * สร้างสคริปต์ TX เดียวต่อผู้ใช้ชุดเดียว — ทุกขั้นตามแผน §2-D89-2 ชั้นที่ 2:
 * NOWAIT lock → profiles FOR UPDATE → SOLE-LINK → NULLIFY → OWNED topological
 * (toggle trigger ครอบขั้นนี้) → post-guard RAISE → delete profiles/auth.users → COMMIT
 */
export function buildUserCleanupSql(userIds: readonly string[]): CleanupSql {
  if (userIds.length === 0) throw new Error("buildUserCleanupSql: userIds ว่าง");
  for (const id of userIds) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`buildUserCleanupSql: id ไม่ใช่ uuid: ${id}`);
  }
  const ids = inList(userIds);

  // ตารางที่สคริปต์เขียน (delete/update) — LOCK SRE NOWAIT เรียงชื่อ ( deadlock-safe )
  const written = [...new Set(CLEANUP_INVENTORY.filter((e) => e.writesTable === true).map((e) => e.table))].sort();

  const soleLink = CLEANUP_INVENTORY.filter((e) => e.policy === "SOLE-LINK-DELETE");
  const nullify = CLEANUP_INVENTORY.filter((e) => e.policy === "ACTOR-NULLIFY");
  const owned = CLEANUP_INVENTORY.filter((e) => e.policy === "OWNED-DELETE");

  const parts: string[] = [];
  parts.push("begin;");
  // (1) ปิดช่อง cron/worker เขียนพร้อมกัน: SRE NOWAIT — 55P03 = abort ทั้ง TX ให้ caller retry
  for (const t of written) parts.push(`lock table public.${t} in share row exclusive mode nowait;`);
  // (2) ปักหลักผู้ใช้: 40P01 deadlock → caller retry
  parts.push(`select id from public.profiles where id in (${ids}) for update;`);

  // (3) SOLE-LINK-DELETE ก่อนแถวเจ้าของหาย (subselect ยังเห็น)
  for (const e of soleLink) parts.push(`delete from public.${e.table} where ${directWhere(e, ids)};`);

  // (4) toggle trigger append-only ครอบทุกการเขียน (NULLIFY = UPDATE ก็โดน trigger
  // BEFORE DELETE OR UPDATE — จับจริงจาก dcr9 teardown: created_by nullify ล้ม)
  const toggles = [...APPEND_ONLY_TRIGGER.entries()].filter(
    ([t]) => owned.some((e) => e.table === t) || nullify.some((e) => e.table === t),
  );
  for (const [t, trg] of toggles) parts.push(`alter table public.${t} disable trigger ${trg};`);

  // (5) ACTOR-NULLIFY / SELF-LINK — nullify ก่อนเจ้าของถูกลบ (SHARED-COND ไม่แตะแถว)
  for (const e of nullify) {
    if (e.policy !== "ACTOR-NULLIFY") continue;
    parts.push(`update public.${e.table} set ${e.column} = null where ${e.column} in (${ids});`);
  }

  // (6) OWNED-DELETE ตาม inventory order (leaf-first)
  for (const e of owned) parts.push(`delete from public.${e.table} where ${directWhere(e, ids)};`);
  for (const [t, trg] of [...toggles].reverse()) {
    parts.push(`alter table public.${t} enable trigger ${trg};`);
  }

  // (7) post-guard: เหลือแถวอ้างผู้ใช้ = RAISE table.column=count (rollback ทั้ง TX)
  // SHARED-COND ต้องประกาศ residual เป๊ะ (เงื่อนไขข้ามเจ้า) — ขาด = builder ใช้ไม่ได้
  const sharedCond = CLEANUP_INVENTORY.filter((e) => e.policy === "SHARED-COND");
  for (const e of sharedCond) {
    if (e.residual === undefined) {
      throw new Error(`buildUserCleanupSql: SHARED-COND ${e.table}.${e.column} ต้องมี residual เป๊ะ`);
    }
  }
  const guards = [
    ...soleLink,
    ...owned,
    ...sharedCond,
    ...CLEANUP_INVENTORY.filter((e) => e.policy === "ASSERT-FAIL"),
  ];
  for (const e of guards) {
    const res = e.residual !== undefined ? e.residual(ids) : directWhere(e, ids);
    parts.push(
      `do $$
declare n int;
begin
  select count(*) into n from public.${e.table} where ${res};
  if n > 0 then
    raise exception 'CLEANUP-POSTGUARD ${e.table}.${e.column}=%', n;
  end if;
end $$;`,
    );
  }

  // (8) เจ้าของสุดท้าย: profiles → auth.users (profiles ก่อน กัน FK NO ACTION ค้าง)
  parts.push(`delete from public.profiles where id in (${ids});`);
  parts.push(`delete from auth.users where id in (${ids});`);
  parts.push("commit;");

  return {
    sql: parts.join("\n"),
    lockedTables: written,
    deleteOrder: [...soleLink, ...owned].map((e) => `${e.table}.${e.column}`),
  };
}

// ─── executor: retry ×3 jitter บน 55P03/40P01 — อื่นล้มดัง ─────────────────────

export interface RunCleanupResult {
  readonly attempts: number;
  readonly retriedOn: readonly string[];
}

export interface RunCleanupOptions {
  /** เขียน note ลง lifecycle ledger ของ test_infra (ถ้ามี — helpers ฉีดเข้ามา) */
  readonly note?: (event: string, payload: Record<string, unknown>) => Promise<void>;
  readonly maxRetries?: number;
  readonly jitter?: () => number;
  /** exec แบบบอก exit code ได้ (psql ON_ERROR_STOP) — default ใช้ exec เดิมแล้วจับจากข้อความ */
  readonly execChecked?: (sql: string) => Promise<{ stdout: string; stderr: string; code: number }>;
}

function lockFailure(stderr: string): "55P03" | "40P01" | null {
  if (/could not obtain lock on relation/i.test(stderr)) return "55P03";
  if (/deadlock detected/i.test(stderr)) return "40P01";
  return null;
}

/**
 * รัน cleanup TX เดียวพร้อม retry — 55P03 (NOWAIT ไม่ได้ lock) กับ 40P01 (deadlock)
 * เท่านั้นที่ retry ได้ (≤3 ครั้ง jitter 150-400ms) · อื่น throw ตรง (ล้มดัง)
 * idempotent: ผู้ใช้ไม่มีแล้ว = delete 0 แถวทุกตาราง + post-guard 0 = ผ่าน
 */
export async function runUserCleanupVia(
  exec: SqlExec,
  userIds: readonly string[],
  opts: RunCleanupOptions = {},
): Promise<RunCleanupResult> {
  await assertCleanupAllowedVia(exec);
  const { sql } = buildUserCleanupSql(userIds);
  const max = opts.maxRetries ?? 3;
  const retriedOn: string[] = [];
  let attempt = 0;
  const fail = (cause: string): Error =>
    Object.assign(new Error(`runUserCleanup (${attempt} attempts): ${cause.slice(0, 400)}`), {
      attempts: attempt,
      retriedOn: [...retriedOn],
    });
  for (;;) {
    attempt += 1;
    if (opts.execChecked !== undefined) {
      const r = await opts.execChecked(sql);
      if (r.code === 0) {
        await opts.note?.("cleanup-run", { users: userIds.length, attempts: attempt, retriedOn });
        return { attempts: attempt, retriedOn };
      }
      const lf = lockFailure(r.stderr);
      if (lf !== null && attempt <= max) {
        retriedOn.push(lf);
        await opts.note?.("cleanup-retry", { sqlstate: lf, attempt });
        await new Promise((res) => setTimeout(res, (opts.jitter?.() ?? Math.random()) * 250 + 150));
        continue;
      }
      throw fail(`psql exit ${r.code}: ${r.stderr.trim()}`);
    }
    try {
      await exec(sql);
      await opts.note?.("cleanup-run", { users: userIds.length, attempts: attempt, retriedOn });
      return { attempts: attempt, retriedOn };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lf = lockFailure(msg);
      if (lf !== null && attempt <= max) {
        retriedOn.push(lf);
        await opts.note?.("cleanup-retry", { sqlstate: lf, attempt });
        await new Promise((res) => setTimeout(res, (opts.jitter?.() ?? Math.random()) * 250 + 150));
        continue;
      }
      // แนบ attempts/retriedOn กับ error เดิม (caller FR assert ได้) — สำรองข้อความเต็ม
      throw Object.assign(err instanceof Error ? err : new Error(msg), {
        attempts: attempt,
        retriedOn: [...retriedOn],
      });
    }
  }
}
