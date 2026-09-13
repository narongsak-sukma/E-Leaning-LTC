/**
 * E2E-19 — flow ลืมรหัสผ่าน/ตั้งรหัสใหม่ครบวงจรบน UI จริง (AUTH-004 · Wave G P1 · D72)
 *
 * พิสูจน์บนแอปจริง:
 * - /forgot-password — ฟอร์มอีเมล → ส่งแล้วเห็นข้อความคงที่ (anti-enumeration:
 *   อีเมลไม่มีจริงก็เห็นข้อความเดียวกันบนหน้าเดียวกัน)
 * - อีเมล recovery ถึงจริง (Mailpit :8025) — ดึงลิงก์ verify (type=recovery) เอง
 *   (self-contained — ไม่เพิ่ม helper กลาง) · token ห้ามปรากฏใน log ทุกชนิด
 * - คลิกลิงก์ → 303 → /reset-password#... → หน้าจับ fragment ตั้ง session → ฟอร์ม
 *   รหัสใหม่ ≥12 → success card → พิสูจน์เปลี่ยนรหัสจริงด้วยการล็อกอินด้วยรหัสใหม่
 *   ผ่านฟอร์ม /login (และรหัสเก่าต้องไม่ผ่าน)
 * - **ห้ามรันตอนนี้** (ข้อตกลง Wave G P1 — e2e เขียนเท่านั้น รันโดย lead/chain battery)
 */
import { expect, test } from "@playwright/test";

import { APP_ORIGIN, TEST_PASSWORD } from "./helpers/env";
import { restCall } from "./helpers/rest";
import { createLearnerUser, deleteLearnerUser, type LearnerUser } from "./helpers/users";

/** ข้อความคงที่ anti-enumeration (copy เดียวกับ PASSWORD_RESET_REQUEST_MESSAGE) */
const REQUEST_MESSAGE = "ถ้าอีเมลนี้มีในระบบ ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว";

/** ข้อความ success (copy เดียวกับ PASSWORD_RESET_DONE_MESSAGE) */
const DONE_MESSAGE = "ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่";

/** รหัสผ่านใหม่ของ spec — ≥12 ตาม GOTRUE_PASSWORD_MIN_LENGTH */
const NEW_PASSWORD = "E2e19Reset#2026x";

/** origin ของ Mailpit API (เมล recovery ถึงจริง) */
const MAILPIT_ORIGIN = process.env["E2E_MAILPIT_URL"] ?? "http://localhost:8025";

interface MailpitAddress {
  readonly Address: string;
}

interface MailpitSummary {
  readonly ID: string;
  readonly To: readonly MailpitAddress[];
}

interface MailpitFull {
  readonly Text?: string;
}

/** เมล recovery ถึง address — ล่าสุดที่มีลิงก์ verify type=recovery (poll 1s) */
async function recoveryMailId(address: string, timeoutSec: number): Promise<string | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const list = (await (await fetch(`${MAILPIT_ORIGIN}/api/v1/messages?limit=50`)).json()) as {
      messages?: MailpitSummary[];
    };
    for (const candidate of list.messages ?? []) {
      if (candidate.To.some((t) => t.Address === address) === false) continue;
      const full = (await (
        await fetch(`${MAILPIT_ORIGIN}/api/v1/message/${candidate.ID}`)
      ).json()) as MailpitFull;
      if ((full.Text ?? "").includes("type=recovery")) return candidate.ID;
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** ลิงก์ verify จากเนื้อเมล (token อยู่ใน URL — ห้าม print/log) */
function verifyLinkOf(mailText: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/u.exec(mailText);
  return match === null ? null : match[0];
}

test.describe("E2E-19 — password reset (AUTH-004)", () => {
  let user: LearnerUser;

  test.beforeAll(async () => {
    user = await createLearnerUser("e2epwreset");
  });

  test.afterAll(async () => {
    if (user?.id !== undefined && user.id !== "") {
      await deleteLearnerUser(user.id);
    }
  });

  test("ลืมรหัสผ่าน → เมล → ตั้งรหัสใหม่บน UI → ล็อกอินด้วยรหัสใหม่ได้จริง", async ({ page }) => {
    // (1) หน้า /forgot-password — ส่งฟอร์มอีเมลจริง → ข้อความคงที่
    await page.goto(`${APP_ORIGIN}/forgot-password`);
    await page.fill("#email", user.email);
    await page.getByRole("button", { name: "ส่งลิงก์ตั้งรหัสผ่านใหม่" }).click();
    await expect(page.locator("#forgot-notice")).toContainText(REQUEST_MESSAGE);

    // (2) anti-enumeration — อีเมลไม่มีจริงเห็นข้อความเดียวกันบนหน้าเดิม
    await page.reload();
    await page.fill("#email", `e2epwreset-unknown-${Date.now()}@ltc.test`);
    await page.getByRole("button", { name: "ส่งลิงก์ตั้งรหัสผ่านใหม่" }).click();
    await expect(page.locator("#forgot-notice")).toContainText(REQUEST_MESSAGE);

    // (3) Mailpit — เมล recovery ถึงจริง + ดึงลิงก์ verify (ไม่ print token)
    const mailId = await recoveryMailId(user.email, 30);
    expect(mailId).not.toBeNull();
    const mail = (await (
      await fetch(`${MAILPIT_ORIGIN}/api/v1/message/${mailId}`)
    ).json()) as MailpitFull;
    const link = verifyLinkOf(mail.Text ?? "");
    expect(link).not.toBeNull();
    const linkUrl = new URL(link!);
    expect(linkUrl.searchParams.get("redirect_to")).toBe(`${APP_ORIGIN}/reset-password`);

    // (4) คลิกลิงก์ → 303 → /reset-password — หน้าจับ fragment ตั้ง session → ฟอร์ม
    await page.goto(link!);
    await expect(page).toHaveURL(new RegExp(`/reset-password$`));
    await expect(page.locator("#password")).toBeVisible();

    // (5) ตั้งรหัสใหม่บน UI — success card
    await page.fill("#password", NEW_PASSWORD);
    await page.fill("#confirm", NEW_PASSWORD);
    await page.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }).click();
    await expect(page.locator("#reset-success")).toContainText(DONE_MESSAGE);

    // (6) พิสูจน์เปลี่ยนรหัสจริง — รหัสเก่า grant 400 ผ่าน Kong ตรง
    const oldGrant = await restCall("POST", "/auth/v1/token?grant_type=password", {}, {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(oldGrant.status).toBe(400);
    // (7) ล็อกอินด้วยรหัสใหม่ผ่านฟอร์ม /login จริง
    await page.goto(`${APP_ORIGIN}/login`);
    await page.fill("#email", user.email);
    await page.fill("#password", NEW_PASSWORD);
    await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  });
});
