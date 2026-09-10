/**
 * E2E-04 — ค้นหา/เลือกดูแคตตาล็อก และลงทะเบียนหลักสูตร (TEST-PLAN E2E-04)
 *
 * พิสูจน์บนแอปจริง (:3000) + DB จริง:
 * - ผู้เยี่ยมชมเห็นเฉพาะหลักสูตร published (4 รายการ) — draft ไม่ปรากฏ (TC-005)
 * - ค้นหา/ล้างตัวกรองทำงานจริง (ตัวนับ "พบหลักสูตร N รายการ")
 * - ผู้เยี่ยมชมกดเข้าหลักสูตร → ถูกพาไป /login?next=…
 * - ผู้เรียน (citizen จริงผ่าน GoTrue) ลงทะเบียนผ่าน BFF ด้วย browser session —
 *   201 ครั้งแรก / 200 เมื่อลงซ้ำ (DCR-3) แล้ว /my/courses สะท้อน "เรียนแล้ว 0 จาก 3"
 * - DB: แถว enrollments เดียวของ user+course นี้
 */
import { expect, test } from "@playwright/test";

import { psqlScalar } from "./helpers/db";
import { loadCourseFacts, type CourseFacts } from "./helpers/seed";
import { enrollCourse, loginViaForm } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser } from "./helpers/users";

const COURSE_CODE = "LTC-101";

test.describe("E2E-04 แคตตาล็อก + ลงทะเบียน", () => {
  let course: CourseFacts | undefined;
  let userId = "";
  let userEmail = "";

  test.beforeAll(async () => {
    course = await loadCourseFacts(COURSE_CODE);
    const user = await createLearnerUser("e2e04");
    userId = user.id;
    userEmail = user.email;
  });

  test.afterAll(async () => {
    if (userId !== "") {
      await deleteLearnerUser(userId);
    }
  });

  test("ผู้เยี่ยมชมเห็นแคตตาล็อก 4 หลักสูตร · ไม่เห็น draft · ค้นหาและล้างตัวกรองได้", async ({
    page,
  }) => {
    await page.goto("/courses");
    await expect(
      page.getByRole("heading", { name: "หลักสูตรฝึกอบรมทั้งหมด" }),
    ).toBeVisible();
    await expect(page.getByText("หลักสูตรร่าง (ยังไม่เผยแพร่)")).toHaveCount(0);
    const cards = page.locator("article");
    await expect(cards).toHaveCount(4);
    await page.fill("#course-search", "จริยธรรม");
    await expect(page.getByText(/พบหลักสูตร 1 รายการ/)).toBeVisible();
    await expect(page.locator("article")).toHaveCount(1);
    await page.getByRole("button", { name: "ล้างตัวกรองทั้งหมด" }).click();
    await expect(page.getByText(/พบหลักสูตร 4 รายการ/)).toBeVisible();
    await expect(page.locator("article")).toHaveCount(4);
  });

  test("ผู้เยี่ยมชมกดเข้าหลักสูตร → ถูกพาไป /login?next=…", async ({ page }) => {
    await page.goto("/courses");
    await page
      .locator("article")
      .filter({ hasText: course === undefined ? "" : course.titleTh })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: course === undefined ? "" : course.titleTh }),
    ).toBeVisible();
    const loginCta = page.locator('a[href*="/login?next="]');
    await expect(loginCta.first()).toBeVisible();
    const href = await loginCta.first().getAttribute("href");
    // next ถูก encode ใน querystring — ถอดก่อนเทียบ
    expect(decodeURIComponent(href ?? "")).toContain(`/courses/${course?.id ?? "x"}`);
  });

  test("ผู้เรียนเข้าสู่ระบบ → ลงทะเบียนได้ (201) · ซ้ำได้ (200 DCR-3) · /my/courses 0 จาก 3", async ({
    page,
  }) => {
    await loginViaForm(page, userEmail);
    const first = await enrollCourse(page, course?.id ?? "");
    expect(first).toBe(201);
    const second = await enrollCourse(page, course?.id ?? "");
    expect(second).toBe(200);
    await page.goto("/my/courses");
    await expect(page.getByText("เรียนแล้ว 0 จาก 3 บทเรียน")).toBeVisible();
    await expect(page.getByText(/ความคืบหน้าหลักสูตร/)).toBeVisible();
    const enrolled = await psqlScalar(`
      select count(*) from public.enrollments
      where user_id = '${userId}' and course_id = '${course?.id ?? ""}' and status = 'active';
    `);
    expect(Number(enrolled)).toBe(1);
  });
});
