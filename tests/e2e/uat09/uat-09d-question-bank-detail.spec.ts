/**
 * UAT-09D — หน้ารายละเอียดคลังข้อสอบ (F5 · Wave G P2 · /admin/question-banks/{id})
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ห้ามรันตอนนี้ — post-close เท่านั้น (หลัง close drained + กฎ P8/re-seed)
 * ═══════════════════════════════════════════════════════════════════════════
 * - สัญญา: UAT-09-SPECS-DRAFT §3.4 (scenarios D-1..D-5) + §4 ตาราง 09D (6 ขั้น)
 *   ป้ายปุ่ม/ข้อความไทยทุกตัว copy จากสเปก (อ้าง as-built develop@65fbac9) —
 *   เจอข้อความต่างจากสเปก = fail ขั้นนั้นแล้วจด "สิ่งที่เห็นจริง" ห้ามเดาแก้เอง (§4)
 * - **อ่านอย่างเดียว — ห้ามกด "บันทึกการแก้ไข" และห้ามยืนยันเปลี่ยนสถานะข้อ** (fence §7):
 *   เปิดโมดัลแก้ไข ตรวจ แล้วกด "ยกเลิก" · **ห้ามกดปุ่มสถานะของทุกแถว** (ขั้น 03 ดูอย่างเดียว)
 *   ไม่กระทบข้อมูลของรอบหลัก
 * - X-2 (§6 ของสเปก): ปุ่มสถานะต่อข้อเป็นป้ายไดนามิกตามสถานะจริง — "เปิดใช้งาน"
 *   (ข้อร่าง/ปลดแล้ว) หรือ "ปลดจากการใช้งาน" (ข้อใช้งาน) — **ไม่ใช่คำว่า "เปลี่ยนสถานะ"**
 *   (คำนั้นคือชื่อหน้าต่างยืนยัน) ขั้น 03 ตรวจป้ายตามของจริง + การ์ดกันคำ "เปลี่ยนสถานะ"
 * - ลำดับ (§0 ข้อ 2): รันต่อจาก 09C (บัญชีเดียวกัน · รหัสยังเป็นค่า env เพราะ 09C อ่าน
 *   อย่างเดียว) · ความต่างเล็ก: browser context ข้ามไฟล์ spec ไม่ได้ (Playwright แยก
 *   ไฟล์ = แยก context) จึงล็อกอินสองขั้นใหม่ใน beforeAll — เจตนาเดียวกับ Background ของ §3.4
 * - หลักฐาน `.omc/artifacts/uat/${RUN_ID}/uat-09d/step-NN.png` จับก่อนไปขั้นถัดไปเสมอ
 */
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

import {
  UAT_ACCOUNTS,
  loginViaFormUat,
  mfaSecretOf,
  runLog,
  stepShot,
  uat09Env,
} from "./fixtures";

/** caption ของตารางข้อ (D-2) — copy จากสเปก/as-built (sr-only caption + aria-label ของกรอบ) */
const TABLE_CAPTION = "ตารางข้อสอบในคลัง (แถวไม่มีเฉลย — ข้อมูลจาก BFF)";

/** คอลัมน์ 6 คอลัมน์ของตาราง (D-2) — ตามลำดับจริง */
const TABLE_COLUMNS = [
  "โจทย์",
  "ประเภท",
  "คะแนน",
  "สถานะข้อสอบ",
  "เวอร์ชัน",
  "การกระทำ",
] as const;

/** ป้ายสถานะไทยของข้อ (D-3) — sync QUESTION_STATUS_LABEL_TH ของ bank-detail.view.ts */
const STATUS_LABELS = ["ร่าง", "ใช้งาน", "ปลดจากการใช้งาน"] as const;

/** คลังของ seed ที่ใช้ตรวจ (Background ของ §3.4) */
const BANK_CODE = "QB-UAT-201";
const BANK_NAME = "ธนาคารข้อสอบ [UAT] จริยธรรมทนายความ";

test.describe.configure({ mode: "serial" });

test.describe("UAT-09D — หน้ารายละเอียดคลังข้อสอบ (/admin/question-banks/{id} · อ่านอย่างเดียว)", () => {
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  /** เวอร์ชัน vN ของข้อที่เปิดโมดัลแก้ไข (จดก่อนกด "แก้ไข" ของ D-4) — ใช้เทียบ D-5 */
  let openedVersion = "";

  test.beforeAll(async ({ browser }) => {
    const env = uat09Env();
    const totpSecret = mfaSecretOf(UAT_ACCOUNTS.staffExam);
    ctx = await browser.newContext();
    page = await ctx.newPage();
    // ล็อกอินสองขั้นสด (รหัส env + TOTP) — ดูหัวไฟล์เรื่อง "ต่อเนื่องจาก 09C"
    await loginViaFormUat(page, UAT_ACCOUNTS.staffExam, env.demoPassword, {
      totpSecret,
    });
    runLog("09d", "เริ่ม 09D — ล็อกอิน staff:exam สองขั้นสำเร็จ (context ใหม่ของไฟล์)");
  });

  test.afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    // ไม่มี re-seed หลัง 09D — ตามลำดับ §0 ข้อ 2: re-seed ตัวถัดไปคือของ afterAll 09B (ปิดท้ายรอบ)
  });

  /** ตารางข้อของหน้ารายละเอียดคลัง (หาผ่าน aria-label ของกรอบ scroll — caption เป็น sr-only) */
  function questionsTable(): Locator {
    if (page === undefined) {
      throw new Error("UAT-09D: context ไม่พร้อม (beforeAll ล้ม?)");
    }
    return page.locator(`div[aria-label="${TABLE_CAPTION}"] table`);
  }

  /** แถวข้อมูลของตาราง (ไม่รวมแถวหัว) */
  function questionRows(): Locator {
    return questionsTable().locator("tbody tr");
  }

  test("D-1 เข้าหน้ารายละเอียดคลังจากรายการ — ข้อมูลหัวคลังครบ", async () => {
    if (page === undefined) {
      throw new Error("UAT-09D: context ไม่พร้อม (beforeAll ล้ม?)");
    }
    const env = uat09Env();

    // ขั้น 01: ไป /admin/question-banks → กดรหัสคลัง QB-UAT-201 (ลิงก์ในคอลัมน์ "รหัสคลัง")
    await page.goto(`${env.appOrigin}/admin/question-banks`);
    await page.getByRole("link", { name: BANK_CODE }).click();
    await page.waitForURL(/\/admin\/question-banks\/[^/]+$/u);

    // มาถึงหน้ารายละเอียดคลัง: ลิงก์กลับ · หัวเรื่อง code · ชื่อ · ป้ายสถานะคลัง ·
    // จำนวนข้อ+สร้างเมื่อ · กล่องคำเตือน pool
    await expect(page.getByRole("link", { name: "← รายการคลังข้อสอบ" })).toBeVisible();
    const heading = page.getByRole("heading").filter({ hasText: BANK_CODE });
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(BANK_NAME);
    await expect(page.getByText("เปิดใช้งาน", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/\d+ ข้อ · สร้างเมื่อ /u).first()).toBeVisible();
    await expect(
      page.getByText(
        "ปิดคลังไม่ได้ตัดข้อออกจากการสุ่ม ข้อสถานะใช้งานยังอาจถูกเลือกตามเกณฑ์การสอบ",
      ),
    ).toBeVisible();
    await stepShot(page, "09d", "01");
  });

  test("D-2 ตารางข้อไม่เผยเฉลย", async () => {
    if (page === undefined) {
      throw new Error("UAT-09D: ต้องรันตามลำดับ serial — หน้าคลังจาก D-1 ไม่พร้อม");
    }

    // ขั้น 02: ตารางมี caption ครบ 6 คอลัมน์ตามลำดับ — และ "ไม่มี" คอลัมน์เฉลย/
    // คำอธิบายหลังตรวจ/ตัวเลือกในหัวคอลัมน์ (ชื่อคอลัมน์ครบชุด = พิสูจน์แบบ deterministic)
    const table = questionsTable();
    await expect(table).toBeVisible();
    const headers = table.getByRole("columnheader");
    await expect(headers).toHaveCount(TABLE_COLUMNS.length);
    await expect(headers).toHaveText([...TABLE_COLUMNS]);
    for (const headerText of await headers.allTextContents()) {
      expect(headerText, "หัวคอลัมน์ต้องไม่มีคำ เฉลย/คำอธิบายหลังตรวจ/ตัวเลือก").not.toMatch(
        /เฉลย|คำอธิบายหลังตรวจ|ตัวเลือก/u,
      );
    }
    // ทุกแถวมีจำนวนเซลล์เท่าจำนวนคอลัมน์ (ไม่มีคอลัมน์แอบแทรกเนื้อหาเฉลย)
    const rowCount = await questionRows().count();
    expect(rowCount).toBeGreaterThan(0);
    for (let i = 0; i < rowCount; i += 1) {
      const cells = questionRows().nth(i).locator("td");
      expect(await cells.count(), `แถวที่ ${i + 1} ต้องมีเซลล์เท่าจำนวนคอลัมน์`).toBe(
        TABLE_COLUMNS.length,
      );
    }
    await stepShot(page, "09d", "02");
  });

  test("D-3 ป้ายสถานะและปุ่มต่อข้อแสดงตามสถานะจริง", async () => {
    if (page === undefined) {
      throw new Error("UAT-09D: ต้องรันตามลำดับ serial — ตารางจาก D-2 ไม่พร้อม");
    }

    // ขั้น 03: ไล่ดูป้ายสถานะ+ปุ่มท้ายแถวของทุกข้อ **โดยไม่กดปุ่มสถานะ** (fence) —
    // สถานะเป็นป้ายไทยหนึ่งในสาม · ทุกแถวมี "แก้ไข" + ปุ่มสถานะตามป้ายจริง (X-2)
    const rowCount = await questionRows().count();
    for (let i = 0; i < rowCount; i += 1) {
      const row = questionRows().nth(i);
      const statusText = ((await row.locator("td").nth(3).textContent()) ?? "").trim();
      expect(
        STATUS_LABELS,
        `แถวที่ ${i + 1}: สถานะต้องเป็นป้ายไทยหนึ่งใน ${STATUS_LABELS.join("/")} (เห็น: "${statusText}")`,
      ).toContain(statusText);
      await expect(row.getByRole("button", { name: "แก้ไข" })).toHaveCount(1);
      const expectedToggle =
        statusText === "ใช้งาน" ? "ปลดจากการใช้งาน" : "เปิดใช้งาน";
      await expect(row.getByRole("button", { name: expectedToggle, exact: true })).toHaveCount(1);
      // X-2 การ์ดกัน: ปุ่มหน้าแถวต้องไม่มีคำว่า "เปลี่ยนสถานะ" (คำนั้นคือชื่อหน้าต่างยืนยัน)
      await expect(row.getByRole("button", { name: "เปลี่ยนสถานะ" })).toHaveCount(0);
    }
    await stepShot(page, "09d", "03");
  });

  test("D-4 เปิดโมดัลแก้ไขข้อ — โหลดข้อมูลครบและเห็นตัวเลือก/เฉลยเฉพาะในฟอร์ม", async () => {
    if (page === undefined) {
      throw new Error("UAT-09D: ต้องรันตามลำดับ serial — ตารางจาก D-3 ไม่พร้อม");
    }

    // ขั้น 04: กด "แก้ไข" ของข้อแรก (จดเวอร์ชัน vN ของข้อนั้นจากคอลัมน์ "เวอร์ชัน" ก่อน)
    const firstRow = questionRows().nth(0);
    openedVersion = ((await firstRow.locator("td").nth(4).textContent()) ?? "").trim();
    expect(openedVersion).toMatch(/^v\d+$/u);
    await firstRow.getByRole("button", { name: "แก้ไข" }).click();

    // โมดัล "แก้ไขข้อสอบ" เปิด → (ผ่านสถานะโหลด "กำลังโหลดข้อสอบ กรุณารอสักครู่…" ซึ่งชั่วคราว —
    // เห็นหรือไม่เห็นขึ้นกับความเร็วเครือข่าย จึงไม่ assert แบบแข็ง แต่จดเห็นไว้ใน run-log)
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "แก้ไขข้อสอบ" })).toBeVisible();
    if (await dialog.getByText("กำลังโหลดข้อสอบ กรุณารอสักครู่…").isVisible().catch(() => false)) {
      runLog("09d", "ขั้น 04: เห็นสถานะโหลด \"กำลังโหลดข้อสอบ กรุณารอสักครู่…\" ก่อนฟอร์มแสดง (ตามสัญญา)");
    }
    // กล่องเวอร์ชันปัจจุบัน + คำเตือน last-write-wins
    await expect(
      dialog.getByText(new RegExp(`เวอร์ชันปัจจุบัน:\\s*${openedVersion}\\b`, "u")),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "ทุกการบันทึกเพิ่มเวอร์ชัน +1 — หากมีผู้แก้ไขพร้อมกัน การบันทึกล่าสุดจะมีผลทับของเดิม",
      ),
    ).toBeVisible();
    // ช่องครบ: ชนิด/ระดับ/โจทย์/คำอธิบายหลังตรวจ/คะแนน/แท็ก + ส่วนตัวเลือก (ในฟอร์มเห็น
    // ตัวเลือก+เฉลยได้ = ตามสัญญา — ตารางด้านนอกไม่เผย)
    await expect(dialog.getByLabel("ชนิดข้อสอบ")).toBeVisible();
    await expect(dialog.getByLabel("ระดับความยาก")).toBeVisible();
    await expect(dialog.getByLabel("โจทย์")).toBeVisible();
    await expect(dialog.getByLabel("คำอธิบายหลังตรวจ (ไม่บังคับ)")).toBeVisible();
    await expect(dialog.getByLabel("คะแนนของข้อ (1-100)")).toBeVisible();
    await expect(dialog.getByLabel("แท็ก (ไม่บังคับ — คั่นด้วย ,)")).toBeVisible();
    await expect(dialog.getByText(/ตัวเลือก \(\d+\/10/u).first()).toBeVisible();
    // ปุ่มครบ (fence: ห้ามกด "บันทึกการแก้ไข" เด็ดขาด)
    await expect(dialog.getByRole("button", { name: "ยกเลิก" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "บันทึกการแก้ไข" })).toBeVisible();
    // fullPage screenshot = "เห็นครบ" แม้โมดัลยาว (สเปกอนุญาตแยก 04a/04b ได้ — ไม่จำเป็น)
    await stepShot(page, "09d", "04");
  });

  test("D-5 ยกเลิกโดยไม่แก้อะไร — ข้อมูลข้อไม่เปลี่ยน (เวอร์ชันไม่ +1)", async () => {
    if (page === undefined) {
      throw new Error("UAT-09D: ต้องรันตามลำดับ serial — โมดัลจาก D-4 ไม่พร้อม");
    }

    // ขั้น 05: ไม่แก้ข้อมูลใด → กด "ยกเลิก" → โมดัลปิดกลับมาตารางเดิม
    await page.getByRole("dialog").getByRole("button", { name: "ยกเลิก" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(questionsTable()).toBeVisible();
    await stepShot(page, "09d", "05");

    // ขั้น 06: ตรวจแถวข้อที่เพิ่งเปิด (โหลดหน้าใหม่) — คอลัมน์ "เวอร์ชัน" ยัง vN เดิม
    // (การยกเลิกไม่บันทึก · ไม่สร้างเวอร์ชันใหม่ · ข้อมูลของรอบหลักไม่ถูกกระทบ)
    await page.reload();
    await expect(questionsTable()).toBeVisible();
    const firstRowAfter = questionRows().nth(0);
    const versionAfter = ((await firstRowAfter.locator("td").nth(4).textContent()) ?? "").trim();
    expect(versionAfter, "เวอร์ชันต้องยังเป็น vN เดิม (การยกเลิกไม่บันทึก)").toBe(openedVersion);
    await stepShot(page, "09d", "06");
    runLog(
      "09d",
      `ขั้น 06: ยกเลิกไม่แก้ข้อมูล — เวอร์ชันยัง ${openedVersion} เดิม — สคริปต์ 09D จบ (รอบเสริม 09 ครบตามลำดับ §0)`,
    );
  });
});
