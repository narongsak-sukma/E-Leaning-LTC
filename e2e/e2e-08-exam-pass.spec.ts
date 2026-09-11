/**
 * E2E-08 — สอบเร็ว FAST-A (max_attempts 2 · cooldown 0 · require_course_complete=false)
 * สอบผ่านผ่าน UI จริง — เฉลยอ่านจาก DB ฝั่ง harness ผ่าน psql เท่านั้น (is_correct ห้ามเดินทาง
 * ผ่าน client bundle — C-7) แล้ว spec คลิก checkbox ของตัวเลือกที่ถูกในห้องสอบ:
 *   หน้ากติกา → "เริ่มสอบ" → ห้องสอบ (ตอบทีละข้อ) → "ส่งข้อสอบ" → ยืนยัน dialog
 *   → หน้าผล /my/exams/{attemptId} ต้องแสดง "ผ่าน" + คะแนนรวม 100% + DB ตรงกัน
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

test.describe("E2E-08 สอบ FAST-A แล้วผ่าน (UI จริง)", () => {
  let user: D9User | undefined;

  test.beforeAll(async () => {
    await seedFastExamA();
    user = await createLawyerLearner("d9-pass");
  });

  test.afterAll(async () => {
    if (user !== undefined) {
      await deleteD9User(user.id);
    }
  });

  test("เริ่มสอบ → คลิกคำตอบที่ถูกทุกข้อ → ส่ง + ยืนยัน → หน้าผลแสดงผ่าน 100%", async ({
    page,
  }) => {
    await loginViaForm(page, user?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    // เฉลยจาก DB ฝั่ง harness — แปลงเป็น "ข้อความตัวเลือก" สำหรับคลิกใน UI
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    expect(plan).toHaveLength(4);
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "correct");
    // หน้าผล: ครั้งที่ 1 · ผ่าน · 100% + ข้อความยินดีด้วย
    await expect(page.getByRole("heading", { name: "ผลการสอบ ครั้งที่ 1" })).toBeVisible();
    await expect(page.getByText("ผ่าน", { exact: true })).toBeVisible();
    await expect(page.getByText("100%")).toBeVisible();
    await expect(page.getByText("ยินดีด้วย ท่านสอบผ่านตามเกณฑ์ที่กำหนด")).toBeVisible();
    // DB: attempt สถานะ passed score 100 + ตอบครบ 4 ข้อ
    const attempts = await psqlRows<{
      id: string;
      status: string;
      score: number;
      passed: boolean;
    }>(`
      select id::text, status::text, score_pct as score, passed
        from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${FAST_A.assessment}';
    `);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("passed");
    expect(attempts[0]?.score).toBe(100);
    expect(attempts[0]?.passed).toBe(true);
    const answered = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.attempt_answers
       where attempt_id = '${attempts[0]?.id ?? ""}' and selected_option_ids is not null;
    `);
    expect(answered[0]?.n).toBe(4);
  });
});
