/**
 * e2e/helpers/session.ts — การเดินทางของผู้เรียนผ่าน browser session จริง
 *
 * - login ผ่านฟอร์ม /login จริง (ไม่แตะ cookie ฝั่ง harness — session ของ browser เท่านั้น)
 * - enroll / heartbeat / documentRead = fetch same-origin จากหน้า (Origin ของ browser ผ่าน
 *   CSRF ของ middleware จริง) — "authenticated API through the browser session" ตามขอบเขต
 * - ห้ามใช้ service-role สร้าง/แก้ learner-visible state — ขา service-role มีแค่ cleanup
 */
import type { Page } from "@playwright/test";

import { totpNow } from "../d9-helpers";
import { APP_ORIGIN, TEST_PASSWORD } from "./env";

export interface ApiResult {
  readonly status: number;
  readonly text: string;
}

/**
 * เข้าสู่ระบบผ่านฟอร์ม /login จริง แล้วรอ redirect ออกจาก /login
 *
 * Wave F (D-f-1): บัญชีที่มี factor TOTP verified เดิน login สองขั้น — รหัสผ่านผ่าน
 * แล้วระบบ 303 ไป /login/verify (pending cookie 300 วิ) ก่อนออก session จริง —
 * ส่ง `{ totpSecret }` (จาก enrollMfaTotp) เพื่อให้ helper กรอกรหัส 6 หลักและกด
 * ยืนยันขั้นที่สองต่อ · ไม่ส่งแล้วบัญชีต้อง MFA = throw ทันที (fail-loud ดีกว่ารอ timeout)
 */
export async function loginViaForm(
  page: Page,
  email: string,
  options?: { readonly totpSecret?: string | undefined },
): Promise<void> {
  await page.goto(`${APP_ORIGIN}/login`);
  await page.fill("#email", email);
  await page.fill("#password", TEST_PASSWORD);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  // ออกจาก /login เลย (ขั้นเดียว) หรือจอดหน้ายืนยันขั้นสอง — ทั้งสองถือว่าขั้นหนึ่งผ่าน
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/login") || url.pathname === "/login/verify",
    { timeout: 20_000 },
  );
  if (new URL(page.url()).pathname !== "/login/verify") {
    return;
  }
  const secret = options?.totpSecret;
  if (secret === undefined) {
    throw new Error(
      `loginViaForm: ${email} ถูกขอรหัส MFA ขั้นที่สอง — ส่ง { totpSecret } ของบัญชีนี้ให้ helper`,
    );
  }
  await page.fill("#code", totpNow(secret));
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
    page.getByRole("button", { name: "ยืนยันตัวตน" }).click(),
  ]);
}

/** fetch same-origin จากหน้า — Origin header ของ browser ผ่าน CSRF ของ middleware จริง */
export async function browserApi(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const init: RequestInit = { method, headers, credentials: "same-origin" };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const response = await fetch(path, init);
      const text = await response.text();
      return { status: response.status, text: text.slice(0, 500) };
    },
    { method, path, body },
  );
}

/** ลงทะเบียนหลักสูตร (POST /api/v1/courses/{id}/enroll) — คืน status 201 ครั้งแรก / 200 ซ้ำ */
export async function enrollCourse(page: Page, courseId: string): Promise<number> {
  const result = await browserApi(
    page,
    "POST",
    `/api/v1/courses/${courseId}/enroll`,
    {},
  );
  return result.status;
}

/** ส่ง heartbeat วิดีโอ (positionSeconds เดิมของ BFF = วินาที — O-2 delta คำนวณฝั่ง BFF) */
export async function postVideoPosition(
  page: Page,
  lessonId: string,
  positionSeconds: number,
): Promise<number> {
  const result = await browserApi(page, "POST", `/api/v1/lessons/${lessonId}/progress`, {
    positionSeconds,
  });
  return result.status;
}

/** ยืนยันอ่านเอกสาร (documentRead = attestation ตาม D12-12) — คืน status ของ BFF */
export async function postDocumentRead(page: Page, lessonId: string): Promise<number> {
  const result = await browserApi(page, "POST", `/api/v1/lessons/${lessonId}/progress`, {
    documentRead: true,
  });
  return result.status;
}

/** ออกจากระบบผ่านปุ่มจริง — รอ redirect ไป /login */
export async function logoutViaButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: "ออกจากระบบ" }).click();
  await page.waitForURL((url) => url.pathname === "/login", { timeout: 20_000 });
}
