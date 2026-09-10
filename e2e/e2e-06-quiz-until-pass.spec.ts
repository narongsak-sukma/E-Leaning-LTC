/**
 * E2E-06 — ทำแบบทดสอบย่อยจนผ่าน (TEST-PLAN E2E-06)
 *
 * พิสูจน์บนแอปจริง + DB จริง:
 * - ตอบผิดทุกข้อ → "ได้คะแนน 0% (ยังไม่ผ่านเกณฑ์)" + quiz_attempts แถวแรก score 0/passed false
 * - "ทำซ้ำอีกครั้ง" → (QuizPanel คงคำตอบเดิมไว้) ถอนตัวเลือกผิด แล้วเลือกตัวเลือกที่ถูก
 *   → "ได้คะแนน 100% (ผ่านเกณฑ์)" + attempt 2 passed=true
 * - ผ่านเกณฑ์แล้ว RPC ปิดบทเรียนควิซเอง → /my/courses "เรียนแล้ว 1 จาก 3" + outline "เรียนจบแล้ว"
 * - เฉลยที่ harness ใช้ตอบมาจาก DB (is_correct) ฝั่ง harness เท่านั้น — UI ต้องไม่มีเฉลย
 */
import { expect, test, type Page } from "@playwright/test";

import { psqlScalar } from "./helpers/db";
import { loadCourseFacts, loadQuizFacts, type CourseFacts, type QuestionFacts } from "./helpers/seed";
import { enrollCourse, loginViaForm } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser } from "./helpers/users";

const COURSE_CODE = "LTC-101";

/** เลือก/ถอน checkbox ของตัวเลือก — ระบุคำถามด้วยข้อความ (shuffle_questions=true ของ seed) */
async function chooseOption(
  page: Page,
  questionText: string,
  label: string,
  action: "check" | "uncheck",
): Promise<void> {
  const box = page
    .locator("fieldset")
    .filter({ hasText: questionText })
    .locator("label")
    .filter({ hasText: label })
    .locator("input");
  if (action === "check") {
    await box.check();
  } else {
    await box.uncheck();
  }
}

test.describe("E2E-06 แบบทดสอบย่อยจนผ่าน", () => {
  let course: CourseFacts | undefined;
  let quiz: QuestionFacts[] = [];
  let userId = "";
  let userEmail = "";

  test.beforeAll(async () => {
    course = await loadCourseFacts(COURSE_CODE);
    const lesson = course.lessons.find((l) => l.type === "quiz");
    expect(lesson, "seed: LTC-101 ต้องมีบทเรียน quiz").toBeDefined();
    quiz = await loadQuizFacts(lesson?.id ?? "");
    expect(quiz.length, "seed: ควิซต้องมี 2 คำถาม").toBe(2);
    const user = await createLearnerUser("e2e06");
    userId = user.id;
    userEmail = user.email;
  });

  test.afterAll(async () => {
    if (userId !== "") {
      await deleteLearnerUser(userId);
    }
  });

  test("ตอบผิด → 0% ยังไม่ผ่าน → ทำซ้ำตอบถูก → 100% ผ่าน → progress 1 จาก 3", async ({
    page,
  }) => {
    const lesson = course?.lessons.find((l) => l.type === "quiz");
    await loginViaForm(page, userEmail);
    expect(await enrollCourse(page, course?.id ?? "")).toBe(201);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${lesson?.id ?? ""}`);
    // โจทย์ครบ 2 คำถาม (fieldset ต่อคำถาม)
    for (const question of quiz) {
      await expect(page.getByText(question.questionText)).toBeVisible();
    }
    await expect(page.locator("fieldset")).toHaveCount(2);
    // รอบแรก: ตอบผิดทุกข้อ
    for (const q of quiz) {
      await chooseOption(page, q.questionText, q.wrongLabel, "check");
    }
    await page.getByRole("button", { name: "ส่งคำตอบ" }).click();
    await expect(page.getByText(/ได้คะแนน 0% \(ยังไม่ผ่านเกณฑ์\)/)).toBeVisible();
    const attempt1 = await psqlScalar(`
      select coalesce(sum(case when passed then 1 else 0 end), 0) || '/' || count(*)
      from public.quiz_attempts where user_id = '${userId}';
    `);
    expect(attempt1).toBe("0/1");
    // รอบสอง: QuizPanel คงคำตอบเดิม — ถอนตัวเลือกผิดก่อน แล้วเลือกตัวเลือกที่ถูก
    await page.getByRole("button", { name: "ทำซ้ำอีกครั้ง" }).click();
    for (const q of quiz) {
      await chooseOption(page, q.questionText, q.wrongLabel, "uncheck");
      await chooseOption(page, q.questionText, q.correctLabel, "check");
    }
    await page.getByRole("button", { name: "ส่งคำตอบ" }).click();
    await expect(page.getByText(/ได้คะแนน 100% \(ผ่านเกณฑ์\)/)).toBeVisible();
    const attempt2 = await psqlScalar(`
      select count(*) filter (where passed) || '/' || count(*) || '/' || coalesce(max(score_pct), 0)
      from public.quiz_attempts where user_id = '${userId}';
    `);
    expect(attempt2).toBe("1/2/100");
    // ควิซผ่าน → บทเรียนควิซถูกปิดเอง → progress 1 จาก 3 บน UI จริง
    await page.goto("/my/courses");
    await expect(page.getByText("เรียนแล้ว 1 จาก 3 บทเรียน")).toBeVisible();
    const completed = await psqlScalar(`
      select count(*) from public.lesson_progress lp
      join public.enrollments e on e.id = lp.enrollment_id
      where e.user_id = '${userId}' and lp.status = 'completed'
        and lp.lesson_id = '${lesson?.id ?? ""}';
    `);
    expect(Number(completed)).toBe(1);
    await page.goto(`/courses/${course?.id ?? ""}/learn/${lesson?.id ?? ""}`);
    await expect(page.getByText("เรียนจบแล้ว")).toHaveCount(1);
  });
});
