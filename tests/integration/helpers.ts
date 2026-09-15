/**
 * tests/integration/helpers.ts — ช่องทางกลางของ integration tests (C-9)
 *
 * - SQL ผ่าน psql ใน container db (docker compose exec) — supabase_admin (superuser)
 * - REST ผ่าน Kong (:8000) = PostgREST/GoTrue จริง ด้วย apikey (anon/service_role)
 * - ผู้ใช้ทดสอบ = GoTrue signup จริง + confirm ผ่าน SQL + login ด้วยรหัสผ่านจริง
 * - ไม่เพิ่ม dependency ใหม่ (node built-in + global fetch + supabase-js ที่มีอยู่)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** บังคับในไฟล์ทดสอบทุกไฟล์: const DB_URL = process.env.TEST_DATABASE_URL; describe.skipIf(!DB_URL) */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const REST_URL = process.env["TEST_SUPABASE_URL"] ?? "http://localhost:8000";
export const ANON_KEY =
  process.env["TEST_SUPABASE_ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IjAwMDAwMDAwMDAwMDAwMDAwMDAwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzU2ODk2MDAsImV4cCI6MTg5MzQ1NjAwMH0.3jsTHD6cIxwRFtwetOAvCHSIQ0Z1xBxfki6n38cwPvk";
export const SERVICE_KEY =
  process.env["TEST_SUPABASE_SERVICE_ROLE_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IjAwMDAwMDAwMDAwMDAwMDAwMDAwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNTY4OTYwMCwiZXhwIjoxODkzNDU2MDAwfQ.4m7tXPHtzmhd8_oafj7Xt0PDZFXn0I1WkNXrxJzwYtQ";
/** GOTRUE_PASSWORD_MIN_LENGTH=12 ใน docker-compose.yml */
export const TEST_PASSWORD = process.env["TEST_USER_PASSWORD"] ?? "Integration#2026";

// ─── SQL (psql ใน container db) ───────────────────────────────────────────────

/** รัน SQL ผ่าน psql ใน container `db` — คืน stdout (psql -At)
 * opts.quiet: เพิ่ม -q เพื่อตัด command tag (UPDATE n/INSERT n) ออกจาก stdout —
 * จำเป็นเมื่อ parse ผล UPDATE…RETURNING (ไม่งั้น "UPDATE 0\n" ทำให้เหมือนมีผลลัพธ์) */
export function psql(sql: string, opts: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        `PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At${
          opts.quiet === true ? " -q" : ""
        }`,
      ],
      { cwd: REPO_ROOT },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`psql exit ${code ?? "?"}: ${stderr || stdout}`));
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** รัน SELECT และ parse เป็นรายการแถว (json_agg) — ตัด ; ท้ายคำสั่งก่อน wrap เป็น subquery */
export async function psqlRows<T>(sql: string): Promise<T[]> {
  const inner = sql.trim().replace(/;\s*$/, "");
  const raw = await psql(
    `select coalesce(json_agg(q), '[]'::json)::text from (${inner}) q;`,
  );
  return JSON.parse(raw.trim()) as T[];
}

/** คืนค่า scalar หนึ่งค่า (trim แล้ว) — ใช้กับ select คอลัมน์เดียว */
export async function psqlScalar(sql: string): Promise<string> {
  const raw = await psql(sql);
  const lines = raw.trim().split("\n");
  const last = lines.at(-1) ?? "";
  return last.trim();
}

// ─── REST (PostgREST/GoTrue ผ่าน Kong) ────────────────────────────────────────

export interface RestResult {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  /** id ของ invocation ใน lifecycle ledger (มีเฉพาะ path การเขียนผ่าน httpWrite) */
  readonly invocationId?: string;
  /** opKey ที่ transport กลาง derive ไว้ — ใช้คู่ invocationId ตอน settle เอง */
  readonly opKey?: string;
}

export interface RestCallOptions {
  readonly apiKey?: string;
  readonly token?: string | null;
  /** "auto" (default) = transport ตัดสิน settle เองตาม provenance ·
   * "scenario" = ผู้เรียกถือหลักฐาน terminal และเป็นคน settle เองผ่าน
   * settleScenario() — ใช้กับ dispatch ที่ตัวเทสพิสูจน์สภาพปลายทางเองอยู่แล้ว
   * (เช่น opaque 500 จาก upstream ที่ connection ขาดกลางทาง — Kong log อย่างเดียว
   * พิสูจน์ไม่ได้ว่า TX ไม่ commit เพราะอาจ commit แล้วตายก่อนตอบ — เทสที่
   * snapshot DB ไว้และ assert ไม่เปลี่ยนคือหลักฐานจริง) */
  readonly settleMode?: "auto" | "scenario";
}

/** เรียก REST ผ่าน Kong — apikey default = anon key
 * waveh-r1 M1: "การเขียน" (method ที่ไม่ใช่ GET/HEAD) ต้องผ่าน transport กลาง
 * httpWrite ทุกครั้ง — invocation/attempt row + ua_nonce + settle ตาม completion
 * class ครบทุก dispatch · การอ่าน (GET/HEAD — ไม่มี lifecycle) คง fetch ตรง
 * dynamic import เพราะ test-io นำเข้า helpers อยู่แล้ว (ห้าม static วนรอบ) */
export async function restCall(
  method: string,
  path: string,
  options: RestCallOptions = {},
  body?: unknown,
): Promise<RestResult> {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") {
    const { httpWrite } = await import("./test-io");
    const r = await httpWrite(m, path, body, {
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.settleMode !== undefined ? { settleMode: options.settleMode } : {}),
      label: "restCall",
    });
    return { status: r.status, json: r.json, text: r.text, invocationId: r.invocationId, opKey: r.opKey };
  }
  const headers: Record<string, string> = {
    apikey: options.apiKey ?? ANON_KEY,
    accept: "application/json",
  };
  if (options.token !== undefined && options.token !== null) {
    headers["authorization"] = `Bearer ${options.token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${REST_URL}${path}`, init);
  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

/** ปิด invocation ของ dispatch แบบ settleMode:"scenario" — ผู้เรียกเป็นคน settle
 * เองด้วยหลักฐาน terminal ที่ตัวเทสพิสูจน์ (เช่น snapshot DB ไม่เปลี่ยนหลัง opaque 500
 * ที่ upstream connection ขาด — ไม่มี rest CLF line ให้ access-log fence ใช้ตัดสิน
 * ตาม kong500Decision → matches===0 จะ poison ทั้งที่เทสถือหลักฐานจริงอยู่)
 *
 * gate waveh-r2 M1: หลักฐานต้องพิสูจน์ "backend จบจริง" ไม่ใช่แค่ "ยังไม่เห็นการเปลี่ยน"
 * — snapshot ไม่เปลี่ยนอ่านได้แม้ TX ของ RPC ยังค้างอยู่ (race) จึงบังคับ terminalProbe
 * ทุกครั้ง: probe ล้ม = ปฏิเสธ settle (invocation ค้าง 'running' ให้ audit จับ —
 * fail-loud) · ต้องเรียกหลัง assert หลักฐานผ่านครบเท่านั้นเช่นกัน */
export async function settleScenario(
  res: RestResult,
  evidence: string,
  terminalProbe: () => Promise<void>,
): Promise<void> {
  const { invocationClose, manifestByOpKey } = await import("./test-io");
  if (res.invocationId === undefined || res.opKey === undefined) {
    throw new Error(`scenario dispatch ไม่มี invocationId/opKey กลับมา (${evidence})`);
  }
  // limitation 22: เขียนมือลอยไม่มีสิทธิ์ settle — scenario settle เปิดเฉพาะ opKey
  // ที่อยู่ใน EVIDENCE_SETTLE_MANIFEST (มี touchSet กำกับหลักฐานอยู่แล้ว)
  if (manifestByOpKey(res.opKey) === undefined) {
    throw new Error(`scenario settle ปฏิเสธ: opKey ${res.opKey} ไม่อยู่ใน manifest (${evidence})`);
  }
  // gate waveh-r2 M1: พิสูจน์ terminal ก่อนลงมือเสมอ — probe โยน = ไม่ settle
  await terminalProbe();
  await invocationClose(res.invocationId, res.opKey, "settled", {
    class: "completed-evidenced(rejected|state-changed)",
    transportTarget: "kong-path",
    evidence,
  });
}

/** probe terminal แบบ lock (ใช้กับ settleScenario): ยึด lock ระดับตาราง nowait ได้ =
 * ไม่มี TX ค้างถือแถวของตารางนั้นอยู่ (TX ของ RPC ใดจะ commit/rollback ก็ต้องถือ lock
 * จนจบ) — คู่กับ snapshot "ไม่เปลี่ยน" ที่เทส assert ไว้ = backend จบจริง ·
 * TX อื่นถืออยู่ = NOWAIT 55P03 โยนทันที (ใช้เป็นทิศปฏิเสธของ guard test)
 * ต้องครอบ begin/commit เสมอ — ตรวจจริง: LOCK TABLE เปล่า ๆ นอก transaction block
 * โดนปฏิเสธ ("LOCK TABLE can only be used in transaction blocks")
 * @param table ชื่อตารางเต็ม schema-qualified — มาจากค่าคงที่ของเทสเท่านั้น (ไม่รับ user input) */
export async function tableTerminalProbe(table: string): Promise<void> {
  await psql(`begin; lock table ${table} in access exclusive mode nowait; commit;`);
}

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ────────────────────────────────────────────────

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly accessToken: string;
  /**
   * refresh token จริงของ session ที่ login ได้มา (gate g-p1-r3) — จำเป็นกับเคส
   * regression ของ middleware ที่ต้องการให้ GoTrue ตอบ rotation สำเร็จจริง
   * (ค่าปลอมทำให้ refresh พลาด = ไม่เกิด Set-Cookie จับอะไรไม่ได้) · ห้าม log
   */
  readonly refreshToken: string;
}

/** signup → confirm ผ่าน SQL (MAILER_AUTOCONFIRM=false) → login ด้วยรหัสผ่านจริง */
export async function createTestUser(localPart: string, role?: string): Promise<TestUser> {
  const email = `${localPart}-${Date.now()}@ltc.test`;
  // GoTrue caps emails/hour (over_email_send_rate_limit) - wait 65s and retry (max 3 attempts)
  let signup = await restCall("POST", "/auth/v1/signup", {}, { email, password: TEST_PASSWORD });
  for (let attempt = 1; signup.status === 429 && attempt < 3; attempt += 1) {
    process.stderr.write(
      `signup 429 (over_email_send_rate_limit) - wait 65s then retry (${attempt + 1}/3)\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    signup = await restCall("POST", "/auth/v1/signup", {}, { email, password: TEST_PASSWORD });
  }
  const signupBody = (signup.json ?? {}) as { id?: string; msg?: string };
  if (signup.status >= 400 || typeof signupBody.id !== "string") {
    throw new Error(`signup failed (${signup.status}): ${signup.text.slice(0, 300)}`);
  }
  const userId = signupBody.id;
  // MAILER_AUTOCONFIRM=false — ยืนยันอีเมลฝั่ง DB เพื่อให้ password grant ผ่าน (dev เท่านั้น)
  // note: confirmed_at เป็น GENERATED column จาก email_confirmed_at — อัปเดตเฉพาะ email_confirmed_at
  // note: role ของ JWT ถูกต้องนับจาก signup (PB-6: compose ตั้ง
  //  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated) — ไม่ต้อง patch auth.users.role อีกต่อไป
  await psql(
    `update auth.users set email_confirmed_at = now() where id = '${userId}';`,
  );
  if (role !== undefined) {
    await assignRole(userId, role);
  }
  const login = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email, password: TEST_PASSWORD },
  );
  const loginBody = (login.json ?? {}) as { access_token?: string; refresh_token?: string };
  if (
    login.status >= 400 ||
    typeof loginBody.access_token !== "string" ||
    typeof loginBody.refresh_token !== "string"
  ) {
    throw new Error(`login failed (${login.status}): ${login.text.slice(0, 300)}`);
  }
  return {
    id: userId,
    email,
    accessToken: loginBody.access_token,
    refreshToken: loginBody.refresh_token,
  };
}

/** เพิ่มบทบาทให้ผู้ใช้ทดสอบ (role_assignments — INSERT จริงผ่าน service path เท่านั้นตาม DD §3.1) */
export async function assignRole(userId: string, role: string): Promise<void> {
  await psql(
    `insert into public.role_assignments (user_id, role, granted_by, reason)
     values ('${userId}', '${role}', null, 'integration test (c9)') on conflict do nothing;`,
  );
}

/** ลบข้อมูลของผู้ใช้ทดสอบ — ผ่าน builder กลาง D89-1 (TX เดียว · guard สามชั้น ·
 *  retry 55P03/40P01 · post-guard RAISE เมื่อเหลือแถวอ้างผู้ใช้ — เช่น NOT NULL actor
 *  ที่ suite ต้องเคลียร์เองก่อน) */
export async function deleteTestUser(userId: string): Promise<void> {
  const { runUserCleanupVia } = await import("./cleanup-builder");
  await runUserCleanupVia(psql, [userId]);
}

/** แจ้ง PostgREST โหลด schema cache ใหม่ (หลัง apply migration 0012) */
export async function reloadRestSchema(): Promise<void> {
  await psql("notify pgrst_ddl_watch;");
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

/** คืน uuid ของหลักสูตรจากรหัส */
export async function courseIdByCode(code: string): Promise<string> {
  return psqlScalar(`select id::text from public.courses where code = '${code}' limit 1;`);
}
