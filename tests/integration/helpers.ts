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

/** รัน SQL ผ่าน psql ใน container `db` — คืน stdout (psql -At) */
export function psql(sql: string): Promise<string> {
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
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At',
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
}

export interface RestCallOptions {
  readonly apiKey?: string;
  readonly token?: string | null;
}

/** เรียก REST ผ่าน Kong — apikey default = anon key */
export async function restCall(
  method: string,
  path: string,
  options: RestCallOptions = {},
  body?: unknown,
): Promise<RestResult> {
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

// ─── ผู้ใช้ทดสอบ (GoTrue จริง) ────────────────────────────────────────────────

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly accessToken: string;
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
  const loginBody = (login.json ?? {}) as { access_token?: string };
  if (login.status >= 400 || typeof loginBody.access_token !== "string") {
    throw new Error(`login failed (${login.status}): ${login.text.slice(0, 300)}`);
  }
  return { id: userId, email, accessToken: loginBody.access_token };
}

/** เพิ่มบทบาทให้ผู้ใช้ทดสอบ (role_assignments — INSERT จริงผ่าน service path เท่านั้นตาม DD §3.1) */
export async function assignRole(userId: string, role: string): Promise<void> {
  await psql(
    `insert into public.role_assignments (user_id, role, granted_by, reason)
     values ('${userId}', '${role}', null, 'integration test (c9)') on conflict do nothing;`,
  );
}

/** ลบข้อมูลของผู้ใช้ทดสอบ (เรียงตาม FK — RESTRICT) */
export async function deleteTestUser(userId: string): Promise<void> {
  await psql(`
    delete from public.lesson_progress where enrollment_id in (select id from public.enrollments where user_id = '${userId}');
    delete from public.enrollments where user_id = '${userId}';
    delete from public.role_assignments where user_id = '${userId}';
    delete from public.profiles where id = '${userId}';
    delete from auth.users where id = '${userId}';
  `);
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
