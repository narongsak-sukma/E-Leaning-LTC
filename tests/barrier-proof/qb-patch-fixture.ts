/**
 * tests/barrier-proof/qb-patch-fixture.ts — fixture ร่วมของกลุ่ม qb PATCH
 * (8k/8l/8m/8n · r22 §2-D89-4): ผู้ใช้ staff:exam + คลัง + โจทย์ + 2 ตัวเลือก
 * + cookie session aal2 สำหรับยิง BFF PATCH ผ่าน httpWrite (จุดกลาง)
 *
 * เส้นทางจริงที่ fixture ยิง: PATCH /api/v1/admin/question-banks/{bank}/questions/{qid}
 * (route.ts PATCH → rpc admin_update_question → INSERT question_options เมื่อ option
 * ไม่มี id — 0019:973) · auth ผ่าน cookie sb-kong-auth-token (base64url session ตาม
 * @supabase/ssr) + Origin (CSRF โครงสร้าง SDS §5.4) — โครงเดียวกับ wave-g bffPatch
 */
import { randomUUID } from "node:crypto";

import {
  createTestUser,
  psql,
  psqlScalar,
  type TestUser,
} from "../integration/helpers.js";
import { mintAal2Token } from "../integration/helpers-aal2.js";

export const APP_URL = process.env["TEST_APP_URL"] ?? "http://localhost:3000";

const AUTH_COOKIE = "sb-kong-auth-token";

interface JwtPayload {
  readonly exp?: number;
}

/** base64url ของ session JSON — ตรงสูตร cookieEncoding:"base64url" ของ @supabase/ssr */
function sessionCookieValue(accessToken: string, userId: string): string {
  const part = accessToken.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as JwtPayload;
  const expiresAt = typeof payload.exp === "number"
    ? payload.exp
    : Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "h8k-unused-no-refresh",
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "",
      factors: [],
    },
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

/** header ชุดเต็มของ BFF PATCH ผ่าน httpWrite.extraHeaders */
export function bffPatchHeaders(accessToken: string, userId: string): Record<string, string> {
  return {
    cookie: `${AUTH_COOKIE}=${sessionCookieValue(accessToken, userId)}`,
    origin: APP_URL,
    "x-forwarded-for": "10.7.0.1",
  };
}

export interface QbFixture {
  readonly user: TestUser;
  /** access_token aal2 (mint สดต่อ fixture — password grant + TOTP ผ่าน GoTrue) */
  readonly token: string;
  readonly bankId: string;
  readonly questionId: string;
  readonly baseOptionCount: number;
}

/**
 * สร้างโลกของ scenario: staff:exam เจ้าของคลังเอง + โจทย์ single_choice (1 เฉลย)
 * draft + 2 ตัวเลือก — PATCH ที่แนบ option ใหม่ (ไม่มี id) จะไป INSERT
 * question_options ภายใน RPC TX เดียว (จุดจอดของ handshake 8k/8l/8m) ·
 * code คลัง unique ต่อ run (uq_question_banks_code)
 */
export async function ensureQbFixture(prefix: string): Promise<QbFixture> {
  const user = await createTestUser(`${prefix}-staff`, "staff:exam");
  const token = await mintAal2Token(user);
  const bankId = randomUUID();
  const questionId = randomUUID();
  const code = `QB-${prefix}-${randomUUID().slice(0, 8)}`;
  await psql(`
    insert into public.question_banks (id, code, name, created_by, description, is_active)
    values ('${bankId}', '${code}', 'คลัง fixture ${prefix}', '${user.id}',
            'barrier fixture ${prefix}', true);`);
  await psql(`
    insert into public.questions
      (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
    values
      ('${questionId}', '${bankId}', 'single_choice', 'easy',
       'โจทย์ fixture ${prefix}', null, 1, 'draft', array['${prefix}'], '${user.id}', 1);`);
  await psql(`
    insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
    values
      ('${randomUUID()}', '${questionId}', 'ตัวเลือกถูกของ ${prefix}', true, 1),
      ('${randomUUID()}', '${questionId}', 'ตัวเลือกผิดของ ${prefix}', false, 2);`);
  return { user, token, bankId, questionId, baseOptionCount: 2 };
}

export function qbPatchPath(bankId: string, questionId: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions/${questionId}`;
}

export function qbPatchUrl(bankId: string, questionId: string): string {
  return `${APP_URL}${qbPatchPath(bankId, questionId)}`;
}

/** ตัวเลือกใหม่ที่ไม่มี id — PATCH จะ INSERT เป็นแถวที่ 3 (is_correct=false เฉลยยังเดิม 1) */
export function newOptionBody(prefix: string, runTail: string): Record<string, unknown> {
  return {
    options: [
      { optionText: `ตัวเลือกใหม่ ${prefix} ${runTail}`, isCorrect: false, sortOrder: 3 },
    ],
  };
}

export async function optionRowCount(questionId: string): Promise<number> {
  const raw = await psqlScalar(
    `select count(*) from public.question_options where question_id = '${questionId}';`,
  );
  return Number(raw.trim());
}

export async function questionVersion(questionId: string): Promise<number> {
  const raw = await psqlScalar(
    `select version from public.questions where id = '${questionId}';`,
  );
  return Number(raw.trim());
}
