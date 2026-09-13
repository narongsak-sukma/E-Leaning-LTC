/**
 * e2e-18 — logout-all (AUTH-010 · Wave G P1): ปุ่ม "ออกจากระบบทุกเครื่อง" ที่
 * /my/security ต้องทำให้ **ทุก session** ของผู้ใช้ตายจริง — ตรวจสองเบราว์เซอร์
 * (สองเครื่องจำลอง): กด/เรียกจากเครื่อง A → /api/v1/me ของ **ทั้ง A และ B** = 401
 *
 * ขอบเขตตามสัญญา lane: ปุ่ม UI เป็นของ W2 — spec นี้เดินทาง API จริงเสมอ
 * (POST /api/v1/auth/logout-all ผ่าน fetch same-origin จากหน้า — Origin ของ
 * browser ผ่าน CSRF ของ middleware จริง) และกดปุ่มจริงบน /my/security ด้วย
 * (ปุ่มมีจริง — lane W2 รวมใน tree เดียวกันก่อน spec นี้รัน)
 *
 * **ห้ามรัน spec นี้เอง** — lead จะเรียงลำดับรัน (แบบแผนทีม)
 */
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";

import { browserApi, loginViaForm } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser } from "./helpers/users";

test.describe("e2e-18 logout-all (AUTH-010)", () => {
  let userId = "";
  let userEmail = "";

  test.beforeAll(async () => {
    const user = await createLearnerUser("e2eloall");
    userId = user.id;
    userEmail = user.email;
  });

  test.afterAll(async () => {
    if (userId !== "") {
      await deleteLearnerUser(userId);
    }
  });

  test("logout-all จากเครื่อง A → me 401 ทั้งเครื่อง A และ B (scope=global จริง)", async ({
    page,
  }) => {
    // สอง context = สองเครื่อง — cookie jar แยก (session แยกจริงผ่านฟอร์มจริง)
    const browser: Browser = page.context().browser()!;
    const contextB: BrowserContext = await browser.newContext();
    const pageB = await contextB.newPage();

    try {
      await loginViaForm(page, userEmail); // เครื่อง A — session ที่ใช้ logout-all
      await loginViaForm(pageB, userEmail); // เครื่อง B — session ที่ต้องตายตาม

      // ทั้งสอง session ใช้งานได้จริงก่อน logout-all
      expect((await browserApi(page, "GET", "/api/v1/me")).status).toBe(200);
      expect((await browserApi(pageB, "GET", "/api/v1/me")).status).toBe(200);

      // เรียก logout-all จากเครื่อง A (same-origin fetch — Origin ผ่าน CSRF จริง)
      const res = await browserApi(page, "POST", "/api/v1/auth/logout-all");
      expect(res.status).toBe(204);

      // session ทั้งคู่ตายจริง — me ผ่าน cookie ของ browser แต่ละเครื่อง = 401
      expect((await browserApi(page, "GET", "/api/v1/me")).status).toBe(401);
      expect((await browserApi(pageB, "GET", "/api/v1/me")).status).toBe(401);
    } finally {
      await contextB.close();
    }
  });

  test("ปุ่มบน /my/security (UI ของ W2) — กดแล้ว session ตายจริง", async ({ page }) => {
    await loginViaForm(page, userEmail);
    await page.goto("/my/security");
    const button = page.getByRole("button", { name: "ออกจากระบบทุกเครื่อง" });
    await expect(button).toBeVisible(); // ปุ่มมีจริง (lane W2 รวมใน tree เดียวแล้ว)
    // กดปุ่มจริงผ่าน UI — session นี้ต้องตายจากฝั่ง GoTrue (me = 401)
    await button.click();
    await expect
      .poll(async () => (await browserApi(page, "GET", "/api/v1/me")).status, {
        timeout: 10_000,
      })
      .toBe(401);
  });
});
