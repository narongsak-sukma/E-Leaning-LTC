/**
 * E2E-17 — เปลี่ยนรหัสผ่านด้วยตนเอง + ปุ่มออกจากระบบทุกเครื่อง (AUTH-005/AUTH-010 UI · Wave G P1 · D72)
 *
 * เดินหน้าจริงบน /my/security ทั้งกระบวนการ (browser จริง · server action จริง ·
 * GoTrue จริง · DB จริง):
 *   1) loginViaForm (citizen สด) → /my/security — section "รหัสผ่าน" (ฟอร์ม 3 ช่อง) +
 *      section "เซสชัน" (ปุ่ม "ออกจากระบบทุกเครื่อง") แสดงครบ
 *   2) ฟอร์มเปลี่ยนรหัสผ่าน — ทุกกรณีล้มเหลวต้องกลับมาพร้อมการ์ดไทยที่ถูกต้อง:
 *      รหัสปัจจุบันผิด → "รหัสผ่านปัจจุบันไม่ถูกต้อง" · สั้น (< 12) → ข้อความนโยบาย
 *      เดียวกับ register · ยืนยันไม่ตรง · ซ้ำกับปัจจุบัน
 *   3) สำเร็จ → การ์ด "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว" + **เซสชันคงอยู่** (ยังเห็นหน้า
 *      security ได้ทันทีโดยไม่ถูกเด้ง login — สัญญา D72) + DB มีแถว audit
 *      AUTH_PASSWORD_CHANGE (context.method = 'password')
 *   4) รหัสเดิมเข้าไม่ได้แล้ว (#login-alert "อีเมลหรือรหัสผ่านไม่ถูกต้อง") ·
 *      รหัสใหม่เข้าได้จริง (กรอกฟอร์ม login ด้วยมือ — loginViaForm ผูก TEST_PASSWORD)
 *   5) ปุ่ม "ออกจากระบบทุกเครื่อง" → POST /api/v1/auth/logout-all (route ของ W3):
 *      สำเร็จ = จบที่ /login · ล้ม = การ์ดแจ้งเตือน (lenient — รายงานผลตามจริง)
 *
 * ผู้ใช้ทดสอบสร้าง/ลบใน test ด้วย helper กลาง (prefix 'waveg17-') — ห้าม print
 * token/รหัสผ่านลง output
 */
import { expect, test, type Page } from "@playwright/test";

import { APP_ORIGIN, TEST_PASSWORD } from "./helpers/env";
import { loginViaForm } from "./helpers/session";
import { psqlRows } from "./helpers/db";
import { createLearnerUser, deleteLearnerUser, type LearnerUser } from "./helpers/users";

/** รหัสผ่านใหม่ที่ใช้เปลี่ยน (≥ 12 — ต่างจาก TEST_PASSWORD ของ helper) */
const NEW_PASSWORD = "WaveG17#Changed2026";

/** กรอกฟอร์มเปลี่ยนรหัสผ่านของ /my/security แล้วกดปุ่ม */
async function fillPasswordForm(
  page: Page,
  current: string,
  next: string,
  confirm: string,
): Promise<void> {
  await page.fill("#current-password", current);
  await page.fill("#new-password", next);
  await page.fill("#confirm-password", confirm);
  await page.getByRole("button", { name: "เปลี่ยนรหัสผ่าน" }).click();
}

/** login ด้วยรหัสผ่านที่กำหนดเอง (manual — loginViaForm ผูก TEST_PASSWORD กับช่อง #password) */
async function loginWithPassword(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/login") || url.pathname === "/login/verify",
    { timeout: 20_000 },
  );
}

test.describe("E2E-17 — เปลี่ยนรหัสผ่านด้วยตนเอง (/my/security)", () => {
  let user: LearnerUser;

  test.beforeEach(async () => {
    user = await createLearnerUser("waveg17");
  });

  test.afterEach(async () => {
    await deleteLearnerUser(user.id);
  });

  test("ฟอร์ม 3 ช่อง + ปุ่ม logout-all แสดงครบ · ทุกกรณีล้มเหลวมีการ์ดไทยถูกต้อง · สำเร็จคงเซสชัน + audit", async ({
    page,
  }) => {
    await loginViaForm(page, user.email);

    // (1) ผิวหน้า — section รหัสผ่าน (ฟอร์ม 3 ช่อง) + section เซสชัน (ปุ่ม logout-all)
    await page.goto(`${APP_ORIGIN}/my/security`);
    await expect(page.getByRole("heading", { name: "ความปลอดภัยของบัญชี" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "รหัสผ่าน", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "เซสชัน" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "ออกจากระบบทุกเครื่อง" }),
    ).toBeVisible();
    await expect(page.locator("#current-password")).toBeVisible();
    await expect(page.locator("#new-password")).toBeVisible();
    await expect(page.locator("#confirm-password")).toBeVisible();

    // (2) รหัสปัจจุบันผิด → การ์ดไทยตามสัญญา D72
    await fillPasswordForm(page, "WrongCurrent#2026", NEW_PASSWORD, NEW_PASSWORD);
    await expect(page.getByRole("status")).toHaveText(/รหัสผ่านปัจจุบันไม่ถูกต้อง/, {
      timeout: 20_000,
    });

    // (3) รหัสใหม่สั้น (< 12) → ข้อความนโยบายเดียวกับ register
    await fillPasswordForm(page, TEST_PASSWORD, "short12less", "short12less");
    await expect(page.getByRole("status")).toHaveText(/รหัสผ่านไม่ผ่านนโยบายความปลอดภัย/, {
      timeout: 20_000,
    });

    // (4) ยืนยันรหัสใหม่ไม่ตรง → การ์ดเจาะจง
    await fillPasswordForm(page, TEST_PASSWORD, NEW_PASSWORD, "Different#2026");
    await expect(page.getByRole("status")).toHaveText(
      /รหัสผ่านใหม่กับการยืนยันรหัสผ่านใหม่ไม่ตรงกัน/,
      { timeout: 20_000 },
    );

    // (5) ซ้ำกับปัจจุบัน → การ์ดเจาะจง
    await fillPasswordForm(page, TEST_PASSWORD, TEST_PASSWORD, TEST_PASSWORD);
    await expect(page.getByRole("status")).toHaveText(
      /รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน/,
      { timeout: 20_000 },
    );

    // (6) สำเร็จ → การ์ดสำเร็จ + เซสชันคงอยู่ (ยังใช้หน้าเดิมได้ ไม่ถูกเด้ง login)
    await fillPasswordForm(page, TEST_PASSWORD, NEW_PASSWORD, NEW_PASSWORD);
    await expect(page.getByRole("status")).toHaveText(/เปลี่ยนรหัสผ่านเรียบร้อยแล้ว/, {
      timeout: 20_000,
    });
    await expect(page.getByRole("heading", { name: "ความปลอดภัยของบัญชี" })).toBeVisible();

    // (7) DB มีหลักฐาน audit AUTH_PASSWORD_CHANGE (context.method = 'password')
    const rows = await psqlRows<{ context: { method?: string } }>(
      `select context from public.audit_logs
       where action = 'AUTH_PASSWORD_CHANGE' and entity_id = '${user.id}'
       order by occurred_at desc limit 1;`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.context["method"]).toBe("password");

    // (8) รหัสเดิมเข้าไม่ได้แล้ว — การ์ด login (ERR-AUTH-002)
    await fillPasswordFormLogin(page, user.email, TEST_PASSWORD);
    await expect(page.locator("#login-alert")).toHaveText(/อีเมลหรือรหัสผ่านไม่ถูกต้อง/, {
      timeout: 20_000,
    });

    // (9) รหัสใหม่เข้าได้จริง — แล้วกลับมาหน้า security ได้ต่อ
    await loginWithPassword(page, user.email, NEW_PASSWORD);
    await page.goto(`${APP_ORIGIN}/my/security`);
    await expect(page.getByRole("heading", { name: "ความปลอดภัยของบัญชี" })).toBeVisible();
  });

  test("ปุ่มออกจากระบบทุกเครื่อง — สำเร็จจบที่ /login หรือแจ้งเตือนเมื่อล้ม (lenient ตามสถานะ route ของ W3)", async ({
    page,
  }) => {
    await loginViaForm(page, user.email);
    await page.goto(`${APP_ORIGIN}/my/security`);
    await expect(
      page.getByRole("button", { name: "ออกจากระบบทุกเครื่อง" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "ออกจากระบบทุกเครื่อง" }).click();
    // สำเร็จ: full navigation ไป /login · ล้ม (route ยังไม่พร้อม/upstream ล้ม):
    // ยังค้างหน้าเดิมและต้องมีการ์ดแจ้งเตือน — ไม่หลอกว่าสำเร็จเงียบ ๆ
    let redirected = false;
    try {
      await page.waitForURL(`${APP_ORIGIN}/login**`, { timeout: 20_000 });
      redirected = true;
    } catch {
      redirected = false;
    }
    if (redirected) {
      await expect(page).toHaveURL(/\/login/);
    } else {
      await expect(page.getByRole("alert")).toBeVisible();
    }
  });
});

/** กรอกฟอร์ม login (helper ภายใน — ต่างจากฟอร์มเปลี่ยนรหัสผ่าน) */
async function fillPasswordFormLogin(page: Page, email: string, password: string): Promise<void> {
  // ต้องพาไป /login ก่อน — caller อาจยืนอยู่ /my/security (เซสชันคงหลังเปลี่ยนรหัส
  // ตามสัญญา D72) ซึ่งไม่มี #email บนหน้า
  await page.goto(`${APP_ORIGIN}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
}
