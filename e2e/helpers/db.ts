/**
 * e2e/helpers/db.ts — ขา DB ของ harness (psql ใน container db ผ่าน docker compose)
 *
 * - ใช้เฉพาะ: จัดเตรียม/เก็บกวาดผู้ใช้ทดสอบ + ตรวจผลลัพธ์ server-side
 *   (lesson_progress / quiz_attempts) คู่กับ assertion บน UI จริง
 * - ลำดับ FK ของ cleanup คัดลอกจาก tests/integration/helpers.ts (deleteTestUser)
 *   แล้วเพิ่ม quiz_attempts (ผูก user_id ตรง) — เรียงตาม FK RESTRICT
 * - ไม่ใช้แทนการ assert สถานะผู้เรียนบน UI — spec ต้องยืนยันบน UI จริงด้วยเสมอ
 */
import { spawn } from "node:child_process";
import { DB_SERVICE } from "./env";

/** root ของ repo — worker รันด้วย cwd = repo root (ดู playwright.config.ts) */
const REPO_ROOT = process.cwd();

/** รัน SQL ผ่าน psql ใน container `db` — คืน stdout ของ `psql -At` */
export function psql(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "exec", "-T", DB_SERVICE, "sh", "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At'],
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
      reject(new Error(`psql exit ${code ?? "??"}: ${stderr || stdout}`));
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** รัน SELECT แล้ว parse เป็นรายการแถว (wrap json_agg — แบบเดียวกับ integration helpers) */
export async function psqlRows<T>(sql: string): Promise<T[]> {
  const inner = sql.trim().replace(/;\s*$/, "");
  const raw = await psql(
    `select coalesce(json_agg(q), '[]'::json)::text from (${inner}) q;`,
  );
  return JSON.parse(raw.trim()) as T[];
}

/** คืนค่า scalar หนึ่งค่า (บรรทัดสุดท้ายของ stdout, trim) */
export async function psqlScalar(sql: string): Promise<string> {
  const raw = await psql(sql);
  const lines = raw.trim().split("\n");
  const last = lines.at(-1) ?? "";
  return last.trim();
}
