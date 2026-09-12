/**
 * E2E-13 — หลังสอบผ่าน ผู้เรียนเห็นหน่วยกิตในรอบปัจจุบันที่ /my/credits (จริง end-to-end)
 *
 * flow: สอบเร็ว FAST-A (course 3 · seed กฎ CR-LTC-103 = 3.50 credit) ผ่านผ่าน UI จริง
 * (หน้ากติกา → เริ่มสอบ → ตอบถูกทุกข้อ → ส่ง + ยืนยัน → หน้าผล "ผ่าน") → harness เรียก
 * credit_accrual_tick() ตรงผ่าน psql (ธง: ไม่รอ cron ltc-credit-accrual — เทสกำหนดเอง
 * เพื่อความ deterministic; cron จริงทุก 1 นาทีก็ยังทำงานต่อให้ปกติหลังจบ spec) → ตรวจ
 * ledger จริงใน DB → เปิด /my/credits แล้วเห็นหน่วยกิตรอบปัจจุบัน
 *   - ผู้เรียน lawyer ใหม่ (ไม่มีรอบก่อน) → รอบ 1 คลุมวันนี้ · earned 3.50 / ต้องมี 12 /
 *     ขาดอีก 8.50 (ตัวเลขตามกฎของหลักสูตรที่ seed)
 *   - ผู้เรียน citizen (ไม่มีรอบ = ไม่ใช่เป้าหมายของรอบ) → หน้าแสดงข้อความอธิบาย ไม่ใช่ error
 *
 * หน้า /my/credits กำลังถูกสร้างโดย worker E-10 — spec ผูกกับ "สัญญาหน้า" แบบหลวม ๆ
 * (ข้อความไทย "หน่วยกิต" และ/หรือตัวเลข credit ด้วย getByText ที่ไม่อิง markup เฉพาะ)
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
import { psql, psqlRows } from "./helpers/db";
import { createLearnerUser, type LearnerUser } from "./helpers/users";
import { loginViaForm } from "./helpers/session";

/** เรียก credit_accrual_tick() ตรง (harness path — อ่าน/เขียน DB ฝั่ง fixture เท่านั้น)
 *  แล้วรอ ledger accrual ของผู้ใช้ปรากฏ (tick อาจโดน advisory lock ของ cron แชร์ → skipped
 *  จึงลองซ้ำได้ สูงสุด 4 ครั้ง) — ล้ม = throw ให้เทส fail อย่างชัดเจน */
async function tickUntilLedgerExists(userId: string): Promise<void> {
  for (let attemptNo = 1; attemptNo <= 4; attemptNo += 1) {
    const out = await psql(`select public.credit_accrual_tick();`);
    const tick = JSON.parse(out.trim()) as { skipped: boolean };
    if (tick.skipped === false) {
      const rows = await psqlRows<{ n: number }>(`
        select count(*)::int as n from public.credit_ledger_entries
         where user_id = '${userId}' and entry_type = 'accrual';
      `);
      if ((rows[0]?.n ?? 0) > 0) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `tickUntilLedgerExists: ledger accrual ของผู้ใช้ ${userId} ไม่ปรากฏหลัง tick ตรง 4 ครั้ง`,
  );
}

/** ล้างแถว credit ของผู้ใช้ทดสอบ (renewal_cycles + credit_ledger_entries — แถวที่ deleteD9User
 *  ไม่รู้จัก เพราะ d9-helpers เขียนก่อน 0031) · ledger เป็น append-only (trigger 0010) จึงต้อง
 *  ลบภายใต้ TX เดียวกับ disable/enable trigger — transactional DDL ทำให้ถ้าตายกลางทาง TX
 *  rollback แล้ว trigger กลับมา enabled เองเสมอ · ขอบเขต = ผู้ใช้ทดสอบของ spec นี้เท่านั้น */
async function cleanupCreditRows(userId: string): Promise<void> {
  await psql(`
    begin;
    alter table public.credit_ledger_entries disable trigger trg_append_only_rows;
    delete from public.credit_ledger_entries where user_id = '${userId}';
    alter table public.credit_ledger_entries enable trigger trg_append_only_rows;
    commit;
  `);
  await psql(`delete from public.renewal_cycles where user_id = '${userId}';`);
}

test.describe("E2E-13 สอบผ่านแล้วเห็นหน่วยกิตที่ /my/credits (UI จริง)", () => {
  let lawyer: D9User | undefined;
  let citizen: LearnerUser | undefined;

  test.beforeAll(async () => {
    await seedFastExamA();
    lawyer = await createLawyerLearner("d9-credit");
    citizen = await createLearnerUser("d9-credit-citizen");
  });

  test.afterAll(async () => {
    for (const user of [lawyer, citizen]) {
      if (user !== undefined) {
        await cleanupCreditRows(user.id);
        await deleteD9User(user.id);
      }
    }
  });

  test("lawyer สอบผ่าน → /my/credits เห็นหน่วยกิตรอบปัจจุบันตามกฎของหลักสูตร (3.50 / ต้องมี 12 / ขาด 8.50)", async ({
    page,
  }) => {
    await loginViaForm(page, lawyer?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    // เฉลยจาก DB ฝั่ง harness — UI ต้องไม่มีเฉลย (C-7)
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    expect(plan).toHaveLength(4);
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "correct");
    // หน้าผลสอบ: ผ่าน (จุดต่อยอดของ e2e-08)
    await expect(page.getByText("ผ่าน", { exact: true })).toBeVisible();
    // tick ตรง (harness) + ตรวจ ledger จริง — ตัวเลขบนหน้าต้องมาจาก ledger นี้
    await tickUntilLedgerExists(lawyer?.id ?? "");
    const ledger = await psqlRows<{ amount: string }>(`
      select amount::text from public.credit_ledger_entries
       where user_id = '${lawyer?.id ?? ""}' and entry_type = 'accrual';
    `);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amount).toBe("3.50");
    // หน้าหน่วยกิต: ข้อความไทย "หน่วยกิต" + ตัวเลข credit (selector หลวม — getByText)
    await page.goto("/my/credits");
    await expect(page.getByText("หน่วยกิต").first()).toBeVisible();
    // earned 3.50 ของรอบปัจจุบัน (กฎ seed CR-LTC-103) — รองรับทั้ง "3.50" และ "3.5"
    await expect(page.getByText(/(^|\D)3\.50?(\D|$)/).first()).toBeVisible();
    // ขาดอีก 8.50 จากเกณฑ์ 12 ของรอบ (ตัวเลขตามกฎของหลักสูตรที่ seed)
    await expect(page.getByText(/(^|\D)8\.50?(\D|$)/).first()).toBeVisible();
  });

  test("citizen ไม่มีรอบ → /my/credits แสดงข้อความอธิบาย ไม่ใช่ error", async ({ page }) => {
    await loginViaForm(page, citizen?.email ?? "");
    const response = await page.goto("/my/credits");
    // หน้าตอบกลับปกติ (ไม่ 5xx) + มีเนื้อหาหน้าหน่วยกิต ไม่ใช่หน้า error ของระบบ
    expect(response?.status()).toBe(200);
    await expect(page.getByText("หน่วยกิต").first()).toBeVisible();
    await expect(page.getByText("เกิดข้อผิดพลาด")).toHaveCount(0);
    await expect(page.getByText("Application error")).toHaveCount(0);
    await expect(page.getByText(/ERR-/)).toHaveCount(0);
  });
});
