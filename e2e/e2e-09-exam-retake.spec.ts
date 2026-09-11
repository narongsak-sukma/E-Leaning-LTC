/**
 * E2E-09 — สอบเร็ว FAST-A: ครั้งแรกตอบผิดทุกข้อ → ไม่ผ่าน → สอบใหม่ (cooldown 0) ตอบถูก
 * → ผ่าน → ครั้งที่สาม start ต้องถูกปฏิเสธ (max_attempts 2 — ERR-ASM-001)
 *
 * ทุกรอบผ่าน UI จริง เช่นเดียวกับ E2E-08 (เฉลยจาก psql ฝั่ง harness เท่านั้น)
 * บทเรียนต้องระวัง: "เริ่มสอบ" ที่ถูกปฏิเสธ ERR-ASM-001 แสดงแผง blocked "ใช้สิทธิ์สอบครบ
 * ตามกติกาแล้ว" (role=alert) และยังแสดงปุ่มได้ (blocked ≠ attempt ค้าง) — ตาม ExamRulesStart
 */
import { expect, test } from "@playwright/test";

import {
  COURSE3_ID,
  FAST_A,
  FAST_A_QUESTIONS,
  createLawyerLearner,
  deleteD9User,
  enrollViaUi,
  loadExamPlan,
  seedFastExamA,
  takeExamViaUi,
  type D9User,
} from "./d9-helpers";
import { psqlRows } from "./helpers/db";
import { loginViaForm } from "./helpers/session";

test.describe("E2E-09 สอบใหม่จนครบสิทธิ์ (max_attempts 2)", () => {
  let user: D9User | undefined;

  test.beforeAll(async () => {
    await seedFastExamA();
    user = await createLawyerLearner("d9-retake");
  });

  test.afterAll(async () => {
    if (user !== undefined) {
      await deleteD9User(user.id);
    }
  });

  test("ครั้งที่ 1 ตอบผิดทุกข้อ → ไม่ผ่าน 0% + DB failed", async ({ page }) => {
    await loginViaForm(page, user?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "wrong");
    await expect(page.getByRole("heading", { name: "ผลการสอบ ครั้งที่ 1" })).toBeVisible();
    await expect(page.getByText("ไม่ผ่าน", { exact: true })).toBeVisible();
    await expect(page.getByText("0%")).toBeVisible();
    await expect(page.getByText("ครั้งนี้ท่านยังไม่ผ่านเกณฑ์ที่กำหนด")).toBeVisible();
    const rows = await psqlRows<{ status: string; score: number }>(`
      select status::text, score_pct as score from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${FAST_A.assessment}'
       order by started_at;
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.score).toBe(0);
  });

  test("ครั้งที่ 2 (cooldown 0) ตอบถูกทุกข้อ → ผ่าน 100% + DB passed", async ({ page }) => {
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    await loginViaForm(page, user?.email ?? "");
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "correct");
    await expect(page.getByRole("heading", { name: "ผลการสอบ ครั้งที่ 2" })).toBeVisible();
    await expect(page.getByText("ผ่าน", { exact: true })).toBeVisible();
    await expect(page.getByText("100%")).toBeVisible();
    await expect(page.getByText("ยินดีด้วย ท่านสอบผ่านตามเกณฑ์ที่กำหนด")).toBeVisible();
    const rows = await psqlRows<{ status: string; score: number }>(`
      select status::text, score_pct as score from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${FAST_A.assessment}'
       order by started_at;
    `);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.status).toBe("passed");
    expect(rows[1]?.score).toBe(100);
  });

  test("ครั้งที่ 3: start ถูกปฏิเสธ (ERR-ASM-001 — ใช้สิทธิ์ครบ 2 ครั้ง)", async ({ page }) => {
    await loginViaForm(page, user?.email ?? "");
    await page.goto(`/courses/${COURSE3_ID}/exam/${FAST_A.assessment}`);
    await expect(page.getByRole("heading", { name: "กติกาการสอบ" })).toBeVisible();
    await page.getByRole("button", { name: "เริ่มสอบ" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "ใช้สิทธิ์สอบครบตามกติกาแล้ว" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว ตรวจสอบผลการสอบได้ที่หน้าประวัติการสอบ");
    // DB ยืนยัน: attempt ยังคง 2 ครั้งเท่าเดิม — การกดถูกปฏิเสธจริง
    const rows = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${FAST_A.assessment}';
    `);
    expect(rows[0]?.n).toBe(2);
    // ประวัติการสอบของผู้เรียนมีทั้งสองครั้ง
    await page.goto("/my/exams");
    await expect(page.getByText("ประวัติการสอบ")).toBeVisible();
    await expect(page.getByText("ดูผลการสอบ")).toHaveCount(2);
  });
});
