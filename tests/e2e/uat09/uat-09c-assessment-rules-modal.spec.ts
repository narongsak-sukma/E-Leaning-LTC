/**
 * UAT-09C — โมดัล "+ เพิ่มกติกา version ใหม่" + exam_review_mode (F4 · Wave G P3 · /admin/assessments)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ห้ามรันตอนนี้ — post-close เท่านั้น (หลัง close drained + กฎ P8/re-seed)
 * ═══════════════════════════════════════════════════════════════════════════
 * - สัญญา: UAT-09-SPECS-DRAFT §3.3 (scenarios C-1..C-5) + §4 ตาราง 09C (6 ขั้น)
 *   ป้ายปุ่ม/ข้อความไทยทุกตัว copy จากสเปก (อ้าง as-built develop@65fbac9) —
 *   เจอข้อความต่างจากสเปก = fail ขั้นนั้นแล้วจด "สิ่งที่เห็นจริง" ห้ามเดาแก้เอง (§4)
 * - **อ่านอย่างเดียว — ห้ามกด "บันทึกกติกา version ใหม่" ทุกกรณี** (fence §7 ของสเปก ·
 *   ทำนอง UAT-06 ขั้น 2b): ตรวจแล้วยกเลิกเท่านั้น ไม่บันทึกกติกาจริง · ข้อมูลของรอบหลัก
 *   ต้องไม่ถูกกระทบ
 * - X-3 (§6 ของสเปก): ปุ่มเปิดโมดัลเป็น **ปุ่มเดียวระดับหน้า** (ไม่ใช่ปุ่มต่อแถว) แล้ว
 *   เลือกชุดข้อสอบในโมดัลผ่านช่อง "ชุดข้อสอบ" — ขั้น 01 ตรวจว่าปุ่มมีเพียงปุ่มเดียวจริง
 * - ลำดับ (§0 ข้อ 2): รันหลัง re-seed ของ 09A (ก่อน 09D และ 09B) · ล็อกอิน
 *   uat.staff.exam สองขั้น (รหัส env + TOTP จากไฟล์ secret ของรอบ)
 * - หลักฐาน `.omc/artifacts/uat/${RUN_ID}/uat-09c/step-NN.png` จับก่อนไปขั้นถัดไปเสมอ
 *   (ขั้น 05: dropdown native ถ่ายรายการตัวเลือกค้างไม่ได้ — ตรวจ option แบบโปรแกรม
 *   แล้วถ่ายภาพค่าที่เลือกหลังสลับแต่ละครั้ง: step-05a/05b · จดไว้เป็นความต่าง)
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  UAT_ACCOUNTS,
  loginViaFormUat,
  mfaSecretOf,
  runLog,
  stepShot,
  uat09Env,
} from "./fixtures";

/** ช่องตัวเลข 5 ช่องของฟอร์มกติกา (C-2 prefill · C-3 ครบ) — ชื่อ copy จากสเปก/as-built */
const NUMERIC_FIELDS = [
  "เวลาทำข้อสอบ (นาที)",
  "จำนวนข้อสอบ",
  "เกณฑ์ผ่าน (%)",
  "จำนวนครั้งที่สอบได้",
  "ระยะพักก่อนสอบซ้ำ (นาที)",
] as const;

/** ติ๊ก 3 ช่อง (C-3) */
const CHECKBOX_FIELDS = [
  "สุ่มลำดับข้อสอบ",
  "สุ่มลำดับตัวเลือก",
  "ต้องเรียนจบหลักสูตรก่อนเข้าสอบ",
] as const;

/** select 2 ช่อง (C-3) — รวมช่องที่ UAT-06 2b ไม่มี (S-5) */
const SELECT_FIELDS = ["ระบบคุมการสอบ", "การเปิดเฉลยหลังสอบ"] as const;

/** ค่าไทยของ exam_review_mode สองค่า (§3.3 C-4 — after_final_attempt / never) */
const REVIEW_OPEN = "เปิดเฉลยเมื่อจบโอกาสสอบหรือผ่านแล้ว";
const REVIEW_NEVER = "ไม่เปิดเฉลย";

test.describe.configure({ mode: "serial" });

test.describe("UAT-09C — โมดัลเพิ่มกติกา version ใหม่ รวมการเปิดเฉลยหลังสอบ (/admin/assessments · อ่านอย่างเดียว)", () => {
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  /** hint "เลือกไว้: version ล่าสุด N ..." เต็มจากขั้น 03 — ใช้เทียบว่ายกเลิกไม่สร้าง version ใหม่ (C-5) */
  let hintTextAtOpen = "";

  test.beforeAll(async ({ browser }) => {
    const env = uat09Env();
    const totpSecret = mfaSecretOf(UAT_ACCOUNTS.staffExam);
    ctx = await browser.newContext();
    page = await ctx.newPage();
    // ล็อกอินสองขั้นสด (รหัส env + TOTP) แล้วไป /admin/assessments (Background ของ §3.3)
    await loginViaFormUat(page, UAT_ACCOUNTS.staffExam, env.demoPassword, {
      totpSecret,
    });
    await page.goto(`${env.appOrigin}/admin/assessments`);
    runLog("09c", "เริ่ม 09C — ล็อกอิน staff:exam สองขั้นสำเร็จ อยู่ที่ /admin/assessments");
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    // ไม่มี re-seed หลัง 09C — ตามลำดับ §0 ข้อ 2: 09C → 09D ต่อเนื่อง (อ่านอย่างเดียวทั้งคู่)
  });

  /** เลือก EXAM-UAT-201 ที่ช่อง "ชุดข้อสอบ" ของโมดัล (เปิดใหม่แต่ละครั้ง = ฟอร์มรีเซ็ต) */
  async function selectExamUat201(): Promise<void> {
    if (page === undefined) {
      throw new Error("UAT-09C: context ไม่พร้อม (beforeAll ล้ม?)");
    }
    const option = page.getByRole("option", { name: /EXAM-UAT-201/ });
    const value = await option.getAttribute("value");
    if (value === null) {
      throw new Error('UAT-09C: ไม่พบตัวเลือก EXAM-UAT-201 ในช่อง "ชุดข้อสอบ" — จด "สิ่งที่เห็นจริง"');
    }
    await page.getByLabel("ชุดข้อสอบ").selectOption(value);
  }

  test("C-1 เปิดโมดัลจากปุ่มเดียวระดับหน้า — หัวเรื่อง/คำอธิบาย/ปุ่มครบ", async () => {
    if (page === undefined) {
      throw new Error("UAT-09C: context ไม่พร้อม (beforeAll ล้ม?)");
    }

    // ขั้น 01: รายการมี EXAM-UAT-201 + ปุ่ม "+ เพิ่มกติกา version ใหม่" เพียงปุ่มเดียวระดับหน้า (X-3)
    await expect(page.getByText("EXAM-UAT-201").first()).toBeVisible();
    const openModalButton = page.getByRole("button", { name: "+ เพิ่มกติกา version ใหม่" });
    await expect(openModalButton).toHaveCount(1);
    await stepShot(page, "09c", "01");

    // ขั้น 02: กดปุ่ม → โมดัลเปิด ชื่อ/คำอธิบาย/ปุ่มครบตามสัญญา (fence: ห้ามกดปุ่มบันทึกเด็ดขาด)
    await openModalButton.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "เพิ่มกติกา version ใหม่" })).toBeVisible();
    await expect(
      dialog.getByText("แก้กติกา = เพิ่ม version ใหม่เสมอ — version ถัดไปคำนวณโดยระบบ (max+1)"),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "ยกเลิก" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "บันทึกกติกา version ใหม่" })).toBeVisible();
    await stepShot(page, "09c", "02");
  });

  test("C-2 เลือก EXAM-UAT-201 แล้วฟอร์ม prefill จากกติกา version ล่าสุด", async () => {
    if (page === undefined) {
      throw new Error("UAT-09C: ต้องรันตามลำดับ serial — โมดัลจาก C-1 ไม่พร้อม");
    }

    // ขั้น 03: เลือก EXAM-UAT-201 → hint version ล่าสุด N + ช่องตัวเลข prefill ไม่ว่าง
    await selectExamUat201();
    const hint = page.getByText(/เลือกไว้: version ล่าสุด/, { exact: false });
    await expect(hint).toBeVisible();
    hintTextAtOpen = ((await hint.textContent()) ?? "").replace(/\s+/gu, " ").trim();
    const hasRules = /version ล่าสุด \d+/.test(hintTextAtOpen);
    if (hasRules) {
      for (const label of NUMERIC_FIELDS) {
        const value = await page.getByLabel(label).inputValue();
        expect(value, `ช่อง "${label}" ต้อง prefill จากกติกาปัจจุบัน (ไม่ใช่ค่าว่าง)`).not.toBe("");
      }
    } else {
      // ป้องกันอนาคต: ถ้า seed วันหนึ่งไม่มีกติกาของชุดนี้ — จดตามจริงแล้วข้ามการตรวจ prefill
      runLog(
        "09c",
        `ขั้น 03: hint ไม่มีเลข version ("${hintTextAtOpen}") — ข้ามการตรวจ prefill ตามเงื่อนไขสเปก`,
      );
    }
    // (ถ้าชุดนั้นมีกติกา) กล่องขอบเขตคลังข้อสอบ + ข้อความส่งต่ออัตโนมัติ
    const scopeBox = page.getByText(
      "ขอบเขตคลังข้อสอบ (ส่งต่อจาก version ล่าสุด — แก้ที่เมนูคลังข้อสอบเท่านั้น)",
    );
    if (await scopeBox.isVisible().catch(() => false)) {
      await expect(
        page.getByText("การบันทึก version ใหม่จะส่งค่าขอบเขตนี้ต่อตามเดิมโดยอัตโนมัติ"),
      ).toBeVisible();
    }
    await stepShot(page, "09c", "03");
  });

  test('C-3 ฟอร์มมีครบทุกช่องตามทะเบียน — รวม "การเปิดเฉลยหลังสอบ" ที่ UAT-06 2b ไม่มี', async () => {
    if (page === undefined) {
      throw new Error("UAT-09C: ต้องรันตามลำดับ serial — โมดัลจาก C-2 ไม่พร้อม");
    }

    // ขั้น 04: ไล่ตรวจทุกช่องบนลงล่างโดยไม่แก้ค่าใด — ครบ 10 รายการ (5 ตัวเลข + 3 ติ๊ก + 2 เลือก)
    for (const label of NUMERIC_FIELDS) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    for (const label of CHECKBOX_FIELDS) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    for (const label of SELECT_FIELDS) {
      await expect(page.getByLabel(label)).toBeVisible();
    }
    // fullPage screenshot = "เห็นครบทั้งฟอร์ม" แม้สกรอลล์ยาว (สเปกอนุญาตแยก 04a/04b ได้ — ไม่จำเป็น)
    await stepShot(page, "09c", "04");
  });

  test('C-4 ช่อง "การเปิดเฉลยหลังสอบ" มีครบสองค่าและเลือกสลับได้', async () => {
    if (page === undefined) {
      throw new Error("UAT-09C: ต้องรันตามลำดับ serial — โมดัลจาก C-3 ไม่พร้อม");
    }

    // ขั้น 05: เปิดดูตัวเลือก — ครบ 2 ค่าตามสัญญา (ตรวจ option แบบโปรแกรม: dropdown native
    // ถ่าย "รายการค้าง" ไม่ได้ — ภาพหลักฐานคือค่าที่เลือกหลังสลับแต่ละครั้ง)
    const review = page.getByLabel("การเปิดเฉลยหลังสอบ");
    const optionTexts = await review.locator("option").allTextContents();
    expect(optionTexts).toHaveLength(2);
    expect(optionTexts).toContain(REVIEW_OPEN);
    expect(optionTexts).toContain(REVIEW_NEVER);
    const originalValue = await review.inputValue();

    // สลับทั้งสองค่า — ค่าที่แสดงเปลี่ยนตามที่เลือกทั้งสองครั้ง โดยไม่มีข้อผิดพลาด
    await review.selectOption({ label: REVIEW_NEVER });
    await expect(review).toHaveValue(/never/u);
    await stepShot(page, "09c", "05a");
    await review.selectOption({ label: REVIEW_OPEN });
    await expect(review).toHaveValue(/after_final_attempt/u);
    await stepShot(page, "09c", "05b");
    // คืนค่าเดิมก่อนยกเลิก (อ่านอย่างเดียว — ไม่ทิ้งการเปลี่ยนแปลงใดไว้ในฟอร์ม)
    await review.selectOption(originalValue);
  });

  test("C-5 กดยกเลิก — ปิดโมดัลและไม่เกิด version ใหม่", async () => {
    if (page === undefined) {
      throw new Error("UAT-09C: ต้องรันตามลำดับ serial — โมดัลจาก C-4 ไม่พร้อม");
    }

    // ขั้น 06: กด "ยกเลิก" → โมดัลปิดกลับไปหน้ารายการเดิม (ไม่ได้กด "บันทึกกติกา version ใหม่")
    await page.getByRole("dialog").getByRole("button", { name: "ยกเลิก" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("EXAM-UAT-201").first()).toBeVisible();
    await stepShot(page, "09c", "06a");

    // เปิดโมดัลใหม่อีกครั้งแล้วเลือก EXAM-UAT-201 → hint ยังแสดง "version ล่าสุด N" เดิม
    // (ไม่ใช่ N+1 — การยกเลิกไม่บันทึกอะไร)
    const openModalButton = page.getByRole("button", { name: "+ เพิ่มกติกา version ใหม่" });
    await openModalButton.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await selectExamUat201();
    const hintAgain = ((await page.getByText(/เลือกไว้: version ล่าสุด/).textContent()) ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    expect(hintAgain).toBe(hintTextAtOpen);
    await stepShot(page, "09c", "06b");
    // ปิดโมดัลให้สะอาดก่อนจบสคริปต์ (ยกเลิกเสมอ — ห้ามทิ้งโมดัลค้างให้ 09D)
    await page.getByRole("dialog").getByRole("button", { name: "ยกเลิก" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    runLog("09c", "ขั้น 06: ยกเลิกไม่สร้าง version ใหม่ (hint version ล่าสุดยังเดิม) — สคริปต์ 09C จบ");
  });
});
