/**
 * e2e/helpers/users.ts — ผู้ใช้ทดสอบของ E2E (GoTrue จริง + บทบาท citizen)
 *
 * - สร้างผู้ใช้ใหม่ทุกรอบรัน (unique email ต่อ spec) — ไม่แชร์ผู้ใช้ระหว่าง spec
 * - signup → confirm ฝั่ง DB (MAILER_AUTOCONFIRM=false) → บทบาท citizen → password grant
 * - cleanup เรียงตาม FK RESTRICT (เพิ่ม quiz_attempts เข้าจาก integration helpers)
 */
import { psql } from "./db";
import { TEST_PASSWORD } from "./env";
import { restCall } from "./rest";

export interface LearnerUser {
  readonly id: string;
  readonly email: string;
}

/** signup → confirm → citizen → password grant (คืน null เมื่อ password grant ล้ม) */
export async function createLearnerUser(prefix: string): Promise<LearnerUser> {
  const email = `${prefix}-${Date.now()}@ltc.test`;
  let signup = await restCall("POST", "/auth/v1/signup", {}, { email, password: TEST_PASSWORD });
  for (let attempt = 1; signup.status === 429 && attempt < 3; attempt += 1) {
    process.stderr.write(`signup 429 (rate limit) — รอ 65s แล้วลองใหม่ (${attempt + 1}/3)\n`);
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    signup = await restCall("POST", "/auth/v1/signup", {}, { email, password: TEST_PASSWORD });
  }
  const signupBody = (signup.json ?? {}) as { id?: string; msg?: string };
  if (signup.status >= 400 || typeof signupBody.id !== "string") {
    throw new Error(`signup failed (${signup.status}): ${signup.text.slice(0, 300)}`);
  }
  const userId = signupBody.id;
  await psql(`update auth.users set email_confirmed_at = now() where id = '${userId}';`);
  await psql(
    `insert into public.role_assignments (user_id, role, granted_by, reason)
     values ('${userId}', 'citizen', null, 'e2e smoke suite (PB-10)') on conflict do nothing;`,
  );
  const login = await restCall(
    "POST",
    "/auth/v1/token?grant_type=password",
    {},
    { email, password: TEST_PASSWORD },
  );
  const loginBody = (login.json ?? {}) as { access_token?: string };
  if (login.status >= 400 || typeof loginBody.access_token !== "string") {
    throw new Error(`password grant failed (${login.status}): ${login.text.slice(0, 300)}`);
  }
  return { id: userId, email };
}

/** ลบผู้ใช้ทดสอบ + ข้อมูลการเรียนทั้งหมด (เรียงตาม FK — RESTRICT) */
export async function deleteLearnerUser(userId: string): Promise<void> {
  await psql(`
    delete from public.lesson_progress where enrollment_id in (select id from public.enrollments where user_id = '${userId}');
    delete from public.quiz_attempts where user_id = '${userId}';
    delete from public.enrollments where user_id = '${userId}';
    delete from public.role_assignments where user_id = '${userId}';
    delete from public.profiles where id = '${userId}';
    delete from auth.users where id = '${userId}';
  `);
}
