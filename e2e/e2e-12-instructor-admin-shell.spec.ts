/**
 * E2E-12 — ธง D-7 ข้อ 3: บทบาท instructor กับหลังบ้าน (admin shell)
 *
 * โจทย์เดิมของ lead: "instructor → /admin/question-banks เข้าได้ · /admin/certificates
 * ถูกปฏิเสธ (forbidden ไทย)" — แต่พฤติกรรมจริงของโค้ดปัจจุบัน (r7) **ต่างจากโจทย์**:
 *
 *   · RBAC matrix (0004-r3) ให้ instructor มี question_bank:view จริง และ BFF GET
 *     /api/v1/admin/question-banks ก็รับ instructor — แต่
 *   · src/app/(admin)/admin/layout.tsx บังคับ ADMIN_STAFF_ROLES = [staff:viewer,
 *     staff:content, staff:exam, staff:registrar, super_admin] (src/lib/fixtures/admin.ts:92)
 *     ซึ่ง **ไม่รวม instructor** → ไม่ว่าเข้าหน้าใดใต้ /admin/* จะถูก redirect("/login")
 *     ทั้งคู่ (fail-closed ก่อนถึงหน้า/BFF เสมอ)
 *
 * spec นี้จึง **บันทึกพฤติกรรมจริง** (redirect ไป /login ทั้งสองหน้า) ไว้เป็นหลักฐาน
 * ของธง — ไม่ enshrine ว่าพฤติกรรมนี้ถูกต้องตามนโยบาย: ถ้า lead ตัดสินใจให้ instructor
 * เข้า question-banks ได้ (แก้ layout/matrix) ให้ปรับ assertion ข้อแรกตามการตัดสินนั้น
 * (ผู้ใช้ instructor สร้างใหม่ d9-* + role ผ่าน psql — profile สาธิตของ seed
 * instructor.demo@ltc.local ไม่มีแถว auth.users จึง login ผ่านฟอร์มไม่ได้)
 */
import { expect, test } from "@playwright/test";

import { createStaffRoleUser, deleteD9User, type D9User } from "./d9-helpers";
import { loginViaForm } from "./helpers/session";

test.describe("E2E-12 ธง D-7 (3): instructor กับหลังบ้าน — บันทึกพฤติกรรมจริง", () => {
  let instructor: D9User | undefined;

  test.beforeAll(async () => {
    instructor = await createStaffRoleUser("d9-instructor", "instructor");
  });

  test.afterAll(async () => {
    if (instructor !== undefined) {
      await deleteD9User(instructor.id);
    }
  });

  test("instructor ไป /admin/question-banks → ถูก redirect ไป /login (fail-closed)", async ({
    page,
  }) => {
    await loginViaForm(page, instructor?.email ?? "");
    await page.goto("/admin/question-banks");
    // พฤติกรรมจริง: admin layout กั้นก่อนถึงหน้า (ADMIN_STAFF_ROLES ไม่มี instructor)
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 20_000 });
    await expect(page).toHaveURL(/\/login$/);
  });

  test("instructor ไป /admin/certificates → ถูก redirect ไป /login เช่นกัน (ไม่ใช่ forbidden ไทย)", async ({
    page,
  }) => {
    await loginViaForm(page, instructor?.email ?? "");
    await page.goto("/admin/certificates");
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 20_000 });
    await expect(page).toHaveURL(/\/login$/);
  });
});
