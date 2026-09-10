/**
 * e2e/helpers/rest.ts — เรียก Supabase REST/GoTrue ผ่าน Kong (:8000) ตรง ๆ
 *
 * - ใช้จัดเตรียมผู้ใช้ทดสอบ (signup/token) เท่านั้น — สถานะผู้เรียนทุกอย่าง
 *   ต้องเดินผ่าน browser session ของ Playwright (session.ts) เท่านั้น
 * - ไม่เพิ่ม dependency (global fetch)
 */
import { ANON_KEY, REST_BASE } from "./env";

export interface RestResult {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
}

export interface RestCallOptions {
  readonly apiKey?: string;
  readonly token?: string | null;
}

/** เรียก REST ผ่าน Kong — apikey default = anon (เหมือน browser ทั่วไป) */
export async function restCall(
  method: string,
  path: string,
  options: RestCallOptions = {},
  body?: unknown,
): Promise<RestResult> {
  if (ANON_KEY.length === 0) {
    throw new Error("harness env missing SUPABASE_ANON_KEY (or TEST_SUPABASE_ANON_KEY)");
  }
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
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
  const response = await fetch(`${REST_BASE}${path}`, init);
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
