/**
 * E2E-21 — สอบผ่าน → หน้าผลเปิดเฉลยทันที (ASM-012 open-on-pass) + เริ่มสอบใหม่ถูกปฏิเสธ
 * (แผน Wave G P3 §4 W3 · คู่พลัง open-on-pass ⇔ block-retake-on-pass — migration 0049)
 *
 * พิสูจน์บนแอปจริง + DB จริง (สอบเร็ว FAST-A เดียวกับ E2E-08/09 — max_attempts 2 ·
 * cooldown 0 · 4 ข้อ):
 * - ตอบถูกทุกข้อ → ส่ง → หน้าผล /my/exams/{attemptId} แสดง "ผ่าน" 100% และ **เปิดเฉลยทันที**
 *   (ผ่านแล้วไม่ต้องรอครบโอกาสสอบ): ข้อความโจทย์ + ตัวเลือกป้าย "ถูกต้อง" + คำอธิบาย
 *   และไม่มีป้าย "ยังไม่เปิดเฉลยตามกติกา" หลงเหลือ — ตามที่ learner_attempt_view (0049)
 *   เปิด 4 คอลัมน์ (is_correct, points_earned, question_snapshot, explanation)
 * - DB: learner_attempt_view ของ attempt นั้น 4 คอลัมน์ non-null ครบทุกข้อ —
 *   อ่านผ่าน PostgREST ด้วย JWT ผู้ใช้ (ช่องทางเดียวกับ BFF จริง) เพราะ view
 *   ฝัง `where at.user_id = auth.uid()` (0049) — probe แบบ psql superuser ไร้ JWT
 *   เห็น 0 แถวตามดีไซน์
 * - กลับหน้ากติกากด "เริ่มสอบ" ใหม่ → ถูกปฏิเสธด้วยข้อความไทย
 *   "ผ่านการสอบนี้แล้ว จึงสอบซ้ำไม่ได้ — ดูผลสอบได้ที่หน้าผลสอบ" (assert ข้อความ
 *   ไม่ใช่รหัส — รหัสไม่เดินทางมาแสดงบน UI ของผู้เรียน) + DB ยังมี attempt เดียว
 * - เฉลยที่ harness ใช้ตอบมาจาก DB (is_correct) ฝั่ง harness เท่านั้น — เดียวกับ E2E-08 (C-7)
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
import { TEST_PASSWORD } from "./helpers/env";
import { restCall } from "./helpers/rest";
import { loginViaForm } from "./helpers/session";

/** ข้อความไทยบน UI เมื่อผู้ผ่านการสอบกดเริ่มสอบใหม่ (B3.5 ของ 0049 — assert ข้อความ ไม่ใช่รหัส) */
const PASSED_RETAKE_BLOCKED_MESSAGE = "ผ่านการสอบนี้แล้ว จึงสอบซ้ำไม่ได้";
const PASSED_RETAKE_BLOCKED_GUIDANCE = "ดูผลสอบได้ที่หน้าผลสอบ";
/** ป้ายที่หน้าผลเมื่อ view ยังปิดเฉลย — ต้องไม่ปรากฏเมื่อผ่านแล้ว (open-on-pass) */
const REVIEW_CLOSED_MARK = "ยังไม่เปิดเฉลยตามกติกา";

test.describe("E2E-21 เปิดเฉลยเมื่อสอบผ่าน + สอบซ้ำถูกปฏิเสธ", () => {
  let user: D9User | undefined;

  test.beforeAll(async () => {
    await seedFastExamA();
    user = await createLawyerLearner("d9-review");
  });

  test.afterAll(async () => {
    if (user !== undefined) {
      await deleteD9User(user.id);
    }
  });

  test("สอบผ่าน 100% → หน้าผลเห็นเฉลย + คำอธิบายทันที → เริ่มสอบใหม่เจอข้อความไทยห้ามสอบซ้ำ", async ({
    page,
  }) => {
    await loginViaForm(page, user?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    // เฉลยจาก DB ฝั่ง harness — แปลงเป็น "ข้อความตัวเลือก" สำหรับคลิกใน UI (เดียวกับ E2E-08)
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    expect(plan).toHaveLength(4);
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "correct");

    // ─── หน้าผลสอบ: ผ่าน 100% ───
    await expect(page.getByRole("heading", { name: "ผลการสอบ ครั้งที่ 1" })).toBeVisible();
    await expect(page.getByText("ผ่าน", { exact: true })).toBeVisible();
    await expect(page.getByText("100%")).toBeVisible();
    await expect(page.getByText("ยินดีด้วย ท่านสอบผ่านตามเกณฑ์ที่กำหนด")).toBeVisible();

    // ─── เปิดเฉลยทันทีเพราะผ่าน (ASM-012 open-on-pass): โจทย์ + เฉลย + คำอธิบายครบทุกข้อ ───
    for (const entry of plan) {
      await expect(page.getByText(entry.questionText)).toBeVisible();
    }
    // คำอธิบายของธนาคาร D-8 ใช้ข้อความเดียวกันทุกข้อ → getByText resolve เป็น 4 ธาตุ
    // ห้าม toBeVisible (strict mode violation) — ยืนยัน "เห็นจริง + ครบ 4" ด้วย first + count
    await expect(page.getByText("คำอธิบายของ D-8").first()).toBeVisible();
    await expect(page.getByText("คำอธิบายของ D-8")).toHaveCount(4);
    await expect(page.getByText("คำอธิบาย", { exact: true })).toHaveCount(4);
    // ตัวเลือกถูกติดป้าย "ถูกต้อง" ครบ 4 ข้อ (ข้อละตัวเลือกที่ถูก) — ไม่มี "ที่ท่านเลือก" แยก
    // เพราะที่ตอบคือตัวเลือกที่ถูกทั้งหมด
    await expect(page.getByText("ถูกต้อง")).toHaveCount(4);
    await expect(page.getByText("ที่ท่านเลือก")).toHaveCount(0);
    // ป้ายปิดเฉลยต้องหายไปทั้งหน้า — พิสูจน์ว่าเปิดเพราะ "ผ่าน" ไม่ใช่แค่แสดงผลธรรมดา
    await expect(page.getByText(REVIEW_CLOSED_MARK)).toHaveCount(0);
    await expect(page.getByText("ข้อความโจทย์ยังไม่แสดงตามกติกาการเปิดเฉลยของระบบ")).toHaveCount(0);

    // ─── DB: attempt ผ่าน 100% + learner_attempt_view เปิด 4 คอลัมน์ครบทุกข้อ ───
    const attempts = await psqlRows<{ id: string; status: string; score: number; passed: boolean }>(`
      select id::text, status::text, score_pct as score, passed
        from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${FAST_A.assessment}';
    `);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("passed");
    expect(attempts[0]?.score).toBe(100);
    expect(attempts[0]?.passed).toBe(true);
    const attemptId = attempts[0]?.id ?? "";
    // view กรอง `at.user_id = auth.uid()` (0049) → ต้องอ่านในชื่อผู้ใช้เอง: grant
    // รหัสผ่านรับ JWT สด แล้ว GET ผ่าน PostgREST — ช่องทางเดียวกับที่ BFF ของหน้า
    // ผลใช้จริง (psql แบบ superuser ไร้ JWT เห็น 0 แถว — ตาม grants/RLS ของ view)
    const grant = await restCall(
      "POST",
      "/auth/v1/token?grant_type=password",
      {},
      { email: user?.email ?? "", password: TEST_PASSWORD },
    );
    expect(grant.status, `grant HTTP ${grant.status}`).toBe(200);
    const token = ((grant.json ?? {}) as { access_token?: string }).access_token ?? "";
    expect(token.startsWith("ey")).toBe(true);
    const view = await restCall(
      "GET",
      `/rest/v1/learner_attempt_view?attempt_id=eq.${attemptId}` +
        "&select=is_correct,points_earned,question_snapshot,explanation",
      { token },
    );
    expect(view.status, view.text.slice(0, 300)).toBe(200);
    const openRows = (view.json ?? []) as {
      is_correct: boolean | null;
      points_earned: number | null;
      question_snapshot: unknown;
      explanation: string | null;
    }[];
    expect(openRows).toHaveLength(4);
    for (const row of openRows) {
      expect(row.is_correct).toBe(true);
      expect(row.points_earned).not.toBeNull();
      expect(row.question_snapshot).not.toBeNull();
      expect(row.explanation).not.toBeNull();
    }

    // ─── กลับไปเริ่มสอบใหม่: กด "เริ่มสอบ" แล้วถูกปฏิเสธด้วยข้อความไทย (ไม่ใช่รหัส) ───
    await page.goto(`/courses/${COURSE3_ID}/exam/${FAST_A.assessment}`);
    await expect(page.getByRole("heading", { name: "กติกาการสอบ" })).toBeVisible();
    await page.getByRole("button", { name: "เริ่มสอบ" }).click();
    const alert = page.getByRole("alert").filter({ hasText: PASSED_RETAKE_BLOCKED_MESSAGE });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(PASSED_RETAKE_BLOCKED_MESSAGE);
    await expect(alert).toContainText(PASSED_RETAKE_BLOCKED_GUIDANCE);

    // DB ยืนยัน: การกดถูกปฏิเสธจริง — ไม่มี attempt ใหม่ถูกสร้าง (คงเดิม 1 ครั้ง)
    const afterBlock = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.assessment_attempts
       where user_id = '${user?.id ?? ""}' and assessment_id = '${FAST_A.assessment}';
    `);
    expect(afterBlock[0]?.n).toBe(1);
  });
});
