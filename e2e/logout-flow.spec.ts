/**
 * Logout flow — เข้าสู่ระบบ → ออกจากระบบ → /login → protected page ต้องกลับมาขอสิทธิ์ใหม่
 *
 * พิสูจน์บนแอปจริง:
 * - /my/courses ก่อนลงทะเบียน = empty state ไทย (ไม่มีข้อมูลหลักสูตร)
 * - ปุ่ม "ออกจากระบบ" → POST /api/v1/auth/logout → redirect /login จริง
 * - หลังออก: browser-session GET /api/v1/me = 401 + /my/courses แสดง error card ไทย
 *   (ไม่มีข้อมูล protected หลุดมาแสดง) — และเข้าสู่ระบบซ้ำด้วยรหัสผ่านเดิมได้จริง
 */
import { expect, test } from "@playwright/test";

import { browserApi, loginViaForm, logoutViaButton } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser } from "./helpers/users";

test.describe("Logout flow", () => {
  let userId = "";
  let userEmail = "";

  test.beforeAll(async () => {
    const user = await createLearnerUser("e2elogout");
    userId = user.id;
    userEmail = user.email;
  });

  test.afterAll(async () => {
    if (userId !== "") {
      await deleteLearnerUser(userId);
    }
  });

  test("ออกจากระบบแล้ว protected page ต้องกลับมาขอสิทธิ์ใหม่", async ({ page }) => {
    await loginViaForm(page, userEmail);
    await page.goto("/my/courses");
    await expect(page.getByText("ยังไม่มีหลักสูตรที่ลงทะเบียน")).toBeVisible();
    await logoutViaButton(page);
    // session ตายจริง — /api/v1/me ผ่าน cookie ของ browser ต้องเป็น 401
    const me = await browserApi(page, "GET", "/api/v1/me");
    expect(me.status).toBe(401);
    // protected page ไม่หลุดข้อมูล — แสดง error card ไทยแทน
    await page.goto("/my/courses");
    await expect(page.getByText("โหลดข้อมูลหลักสูตรของท่านไม่สำเร็จ")).toBeVisible();
    await expect(page.getByText("ยังไม่มีหลักสูตรที่ลงทะเบียน")).toHaveCount(0);
    // เข้าสู่ระบบซ้ำด้วยรหัสผ่านเดิมได้จริง
    await loginViaForm(page, userEmail);
    await page.goto("/my/courses");
    await expect(page.getByText("ยังไม่มีหลักสูตรที่ลงทะเบียน")).toBeVisible();
  });
});
