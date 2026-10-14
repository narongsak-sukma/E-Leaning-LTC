/**
 * UAT-09A — ลืมรหัสผ่าน → รีเซ็ตผ่านอีเมล (F1 · Wave G P1 · บัญชี uat.citizen@ltc.local)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ห้ามรันตอนนี้ — post-close เท่านั้น (หลัง close drained + กฎ P8/re-seed)
 * ═══════════════════════════════════════════════════════════════════════════
 * - สัญญา: UAT-09-SPECS-DRAFT §3.1 (scenarios A-1..A-6) + §4 ตาราง 09A (12 ขั้น)
 *   ป้ายปุ่ม/ข้อความไทยทุกตัว copy จากสเปก (ซึ่งอ้าง as-built develop@65fbac9) —
 *   เจอข้อความต่างจากสเปก = fail ขั้นนั้นแล้วจด "สิ่งที่เห็นจริง" ห้ามเดาแก้เอง (§4)
 * - runtime `http://localhost:3001` (prod-build · E2E_BASE_URL) · Mailpit :8025
 * - หลักฐาน `.omc/artifacts/uat/${RUN_ID}/uat-09a/step-NN.png` จับก่อนไปขั้นถัดไปเสมอ
 *   (ขั้น 06 Mailpit/12 terminal ใช้ .txt ที่ redact token/รหัสแล้ว — ดู fixtures)
 * - ลำดับ (§0 ข้อ 2): 09A เป็นสคริปต์ 09 ตัวแรก · afterAll ของไฟล์นี้ re-seed
 *   คืนฐาน (ขั้น 12) ก่อนแตะบัญชีอื่น · ห้ามเริ่มเมื่อมีสคริปต์อื่นค้างกลางทาง
 * - ผลเป็น verdict เสริม (A-4) — ไม่เข้าตัวเลข 53 ขั้นบังคับของรอบหลัก
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  UAT_ACCOUNTS,
  countMailsTo,
  latestRecoveryMail,
  loginExpectRejected,
  loginViaFormUat,
  reSeed,
  runLog,
  stepNote,
  stepShot,
  uat09Env,
  uatNewPassword,
} from "./fixtures";

/** ข้อความคงที่ anti-enumeration (copy เดียวกับ PASSWORD_RESET_REQUEST_MESSAGE ของสเปก 09A ขั้น 04) */
const REQUEST_MESSAGE = "ถ้าอีเมลนี้มีในระบบ ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว";

/** บรรทัดเสริมของการ์ดยืนยัน (09A ขั้น 04) */
const JUNK_HINT = "ตรวจสอบโฟลเดอร์ junk/spam ด้วย หากไม่พบในกล่องจดหมายเข้า";

/** ข้อความ success ของฟอร์มตั้งรหัสใหม่ (09A ขั้น 09) */
const DONE_MESSAGE = "ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่";

test.describe.configure({ mode: "serial" });

test.describe("UAT-09A — ลืมรหัสผ่านและตั้งรหัสใหม่ผ่านลิงก์อีเมล (uat.citizen@ltc.local)", () => {
  // context ของลิงก์รีเซ็ต (ขั้น 07 "browser context ใหม่ที่ยังไม่ล็อกอิน") — A-4..A-6 ใช้ร่วมกัน
  // เพราะลิงก์ verify แลก session ได้ครั้งเดียว ฟอร์มตั้งรหัสต้องอยู่ context เดิมจนจบ
  let resetContext: BrowserContext | undefined;
  let resetPage: Page | undefined;
  /** ข้อความการ์ดยืนยันเต็มจากขั้น 04 — ใช้เทียบ "ทุกตัวอักษร" กับขั้น 05 (A-3) */
  let sentNoticeText = "";

  test.afterAll(async () => {
    await resetContext?.close().catch(() => undefined);
    // ขั้น 12 (คืนฐาน): re-seed ตามกฎ §0 ข้อ 2 — 09A เปลี่ยนรหัส citizen จริง
    // ต้องคืนค่า env ก่อนแตะสคริปต์อื่น (MFA ของบัญชีเจ้าหน้าที่ไม่ถูกแตะ)
    await reSeed("09a");
  });

  test("A-1 หน้าลืมรหัสผ่านแสดงครบและตรวจรูปแบบอีเมลก่อนส่ง", async ({ page }) => {
    const env = uat09Env();

    // ขั้น 01 (เตรียม): context ของ Playwright เป็น cookie jar เปล่า = "ไม่มี context ของ
    // citizen ค้างอยู่" โดยสถาปัตยกรรม · จด "รหัสเดิม" ลง run-log เป็นชื่อ env อย่างเดียว
    // (MAJOR-1 — ห้ามพิมพ์ค่าจริง) · หลักฐาน = หน้า login ที่พร้อมรัน
    runLog("09a", "ขั้น 01 เตรียม: รหัสเดิม = ค่า UAT_DEMO_PASSWORD จาก env (ไม่พิมพ์ค่าจริง)");
    await page.goto(`${env.appOrigin}/login`);
    await expect(page.locator("#email")).toBeVisible();
    await stepShot(page, "09a", "01");

    // ขั้น 02: หน้า /forgot-password แสดงครบ
    await page.goto(`${env.appOrigin}/forgot-password`);
    await expect(page.getByRole("heading", { name: "ลืมรหัสผ่าน" })).toBeVisible();
    await expect(
      page.getByText("กรอกอีเมลที่ลงทะเบียนไว้ ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "กลับไปหน้าเข้าสู่ระบบ" })).toBeVisible();
    await expect(page.getByLabel("อีเมล")).toBeVisible();
    await expect(page.getByRole("button", { name: "ส่งลิงก์ตั้งรหัสผ่านใหม่" })).toBeVisible();
    await stepShot(page, "09a", "02");

    // ขั้น 03: อีเมลผิดรูปแบบ → ข้อความตรวจจับ + ไม่ส่งคำขอออกไป (ไม่เปลี่ยนเป็นหน้ายืนยัน)
    await page.fill("#email", "not-an-email");
    await page.getByRole("button", { name: "ส่งลิงก์ตั้งรหัสผ่านใหม่" }).click();
    await expect(page.locator("#forgot-alert")).toContainText(
      "รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
    );
    await expect(page.locator("#forgot-notice")).toHaveCount(0);
    await expect(page).toHaveURL(/\/forgot-password/);
    await stepShot(page, "09a", "03");
  });

  test("A-2 ขอลิงก์ด้วยอีเมลจริงได้ข้อความยืนยันชุดเดียวกันเสมอ", async ({ page }) => {
    const env = uat09Env();

    // ขั้น 04: อีเมลจริง → การ์ดเขียว role=status (ข้อความหลัก + บรรทัด junk/spam)
    await page.goto(`${env.appOrigin}/forgot-password`);
    await page.fill("#email", UAT_ACCOUNTS.citizen);
    await page.getByRole("button", { name: "ส่งลิงก์ตั้งรหัสผ่านใหม่" }).click();
    const notice = page.locator("#forgot-notice");
    await expect(notice).toContainText(REQUEST_MESSAGE);
    await expect(notice).toContainText(JUNK_HINT);
    await expect(notice).toHaveAttribute("role", "status");
    sentNoticeText = ((await notice.textContent()) ?? "").trim();
    await stepShot(page, "09a", "04");
  });

  test("A-3 อีเมลที่ไม่มีในระบบได้ข้อความเดียวกันเป๊ะ (anti-enumeration) [ทางเลือก — N/A ได้ถ้าชน rate limit]", async ({
    page,
  }) => {
    const env = uat09Env();
    const unknownEmail = "uat.zero@ltc.local";

    // ขั้น 05 (ทางเลือก): อีเมลไม่มีในระบบ → ข้อความเดียวกับขั้น 04 ทุกตัวอักษร ·
    // ถ้าชน rate limit = จด N/A พร้อมเหตุ แล้วไปขั้นถัดไป (สเปก §3.1 A-3 "But")
    await page.goto(`${env.appOrigin}/forgot-password`);
    await page.fill("#email", unknownEmail);
    await page.getByRole("button", { name: "ส่งลิงก์ตั้งรหัสผ่านใหม่" }).click();
    const alertText = ((await page.locator("#forgot-alert").textContent().catch(() => "")) ?? "").trim();
    if (alertText.includes("กรุณารอสักครู่แล้วลองอีกครั้ง")) {
      runLog("09a", `ขั้น 05 N/A — ชน rate limit: "${alertText}" · ข้ามการตรวจ anti-enumeration ต่อ`);
      test.info().annotations.push({
        type: "verdict",
        description: "A-3 N/A — ชน rate limit ของ /forgot-password (จดเหตุแล้ว ไปขั้นถัดไป)",
      });
      await stepShot(page, "09a", "05");
      return;
    }
    const notice = page.locator("#forgot-notice");
    await expect(notice).toContainText(REQUEST_MESSAGE);
    const noticeText = ((await notice.textContent()) ?? "").trim();
    expect(noticeText).toBe(sentNoticeText); // ทุกตัวอักษร (รวมบรรทัด junk/spam)
    // Mailpit ต้องไม่มีอีเมลตั้งรหัสใหม่ฉบับใหม่ถึงอีเมลนั้น (รอ 3 วิให้การส่งเดินทางพอ)
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await countMailsTo(unknownEmail)).toBe(0);
    await stepShot(page, "09a", "05");
  });

  test("A-4 ลิงก์จากอีเมลพามาถึงฟอร์มตั้งรหัสใหม่ และ token ไม่ค้างใน address bar", async ({
    browser,
  }) => {
    const env = uat09Env();

    // ขั้น 06: ดึงอีเมลล่าสุดถึง citizen จาก Mailpit → คัดลิงก์ออกจากเนื้อหา (token ห้าม log)
    const mail = await latestRecoveryMail(UAT_ACCOUNTS.citizen, 30);
    if (mail === null) {
      throw new Error(
        `UAT-09A ขั้น 06: ไม่พบอีเมลตั้งรหัสผ่านใหม่ถึง ${UAT_ACCOUNTS.citizen} ใน Mailpit ภายใน 30 วิ — ตรวจ ${env.mailpitOrigin}`,
      );
    }
    const linkUrl = new URL(mail.link);
    // ลิงก์ชี้ปลายทางมาที่ /reset-password ของ origin :3001 (redirect_to ของ GoTrue verify)
    expect(linkUrl.searchParams.get("redirect_to")).toBe(`${env.appOrigin}/reset-password`);
    // หลักฐานขั้น 06 (.txt): สรุปผล JSON แบบ redact — ไม่ใส่ URL เต็ม (มี token) ลงไฟล์ใด
    stepNote(
      "09a",
      "06",
      `${new Date().toISOString()} — Mailpit พบเมล recovery ถึง ${UAT_ACCOUNTS.citizen}\n` +
        `id: ${mail.id}\nverify origin+path: ${linkUrl.origin}${linkUrl.pathname}\n` +
        `redirect_to: ${linkUrl.searchParams.get("redirect_to") ?? ""}\n(token ถูก redact — MAJOR-1)\n`,
    );
    runLog("09a", "ขั้น 06: พบเมล recovery จาก Mailpit — ลิงก์ชี้ redirect_to /reset-password แล้ว");

    // ขั้น 07: เปิดลิงก์ใน browser context ใหม่ที่ยังไม่ล็อกอิน → ฟอร์มตั้งรหัส + address สะอาด
    resetContext = await browser.newContext();
    resetPage = await resetContext.newPage();
    await resetPage.goto(mail.link);
    await expect(resetPage).toHaveURL(/\/reset-password$/);
    await expect(resetPage.getByRole("heading", { name: "ตั้งรหัสผ่านใหม่" })).toBeVisible();
    await expect(resetPage.getByLabel("รหัสผ่านใหม่")).toBeVisible();
    await expect(resetPage.getByLabel("ยืนยันรหัสผ่านใหม่")).toBeVisible();
    await expect(resetPage.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" })).toBeVisible();
    // token ไม่ค้างใน address bar — ส่วนท้าย URL (fragment #access_token=...) ถูกลบออกอัตโนมัติ
    expect(new URL(resetPage.url()).hash).toBe("");
    // ภาพหน้าจอไม่เห็น address bar — จด URL หลังเคลียร์ (ปลอดภัยแล้ว) ลง run-log คู่กับภาพ
    runLog("09a", `ขั้น 07: มาถึงฟอร์มตั้งรหัสใหม่ — URL หลังเคลียร์ fragment: ${resetPage.url()}`);
    await stepShot(resetPage, "09a", "07");
  });

  test("A-5 ฟอร์มตั้งรหัสใหม่ตรวจความยาวและความตรงกันของรหัส", async () => {
    if (resetPage === undefined) {
      throw new Error("UAT-09A: ต้องรันตามลำดับ serial — หน้าฟอร์มจาก A-4 ไม่พร้อม");
    }
    // ขั้น 08a: สั้นกว่า 12 → ข้อความความยาว · ไม่บันทึก (ค้างฟอร์ม)
    await resetPage.fill("#password", "short");
    await resetPage.fill("#confirm", "short");
    await resetPage.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }).click();
    await expect(resetPage.locator("#reset-alert")).toContainText(
      "รหัสผ่านต้องมีความยาวอย่างน้อย 12 อักขระ",
    );
    await stepShot(resetPage, "09a", "08a");

    // ขั้น 08b: ยาวพอแต่สองช่องไม่ตรงกัน → ข้อความไม่ตรงกัน · ไม่บันทึก
    const newPassword = uatNewPassword("09a");
    await resetPage.fill("#password", newPassword);
    await resetPage.fill("#confirm", `${newPassword}-diff`);
    await resetPage.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }).click();
    await expect(resetPage.locator("#reset-alert")).toContainText("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
    await expect(resetPage).toHaveURL(/\/reset-password/);
    await stepShot(resetPage, "09a", "08b");
  });

  test("A-6 ตั้งรหัสใหม่สำเร็จ — รหัสเก่าถูกปฏิเสธ รหัสใหม่ใช้เข้าสู่ระบบได้", async () => {
    if (resetPage === undefined) {
      throw new Error("UAT-09A: ต้องรันตามลำดับ serial — หน้าฟอร์มจาก A-4 ไม่พร้อม");
    }
    const env = uat09Env();
    const newPassword = uatNewPassword("09a");

    // ขั้น 09: กรอกรหัสใหม่ตรงกันทั้งสองช่อง → การ์ดสำเร็จ + ปุ่ม "ไปหน้าเข้าสู่ระบบ"
    await resetPage.fill("#password", newPassword);
    await resetPage.fill("#confirm", newPassword);
    await resetPage.getByRole("button", { name: "ตั้งรหัสผ่านใหม่" }).click();
    await expect(resetPage.locator("#reset-success")).toContainText(DONE_MESSAGE);
    await expect(resetPage.getByRole("link", { name: "ไปหน้าเข้าสู่ระบบ" })).toBeVisible();
    // "จดรหัสใหม่ 09A ลง run-log" → จดสูตรอนุพันธ์แทนค่าจริง (MAJOR-1 — ดู fixtures ข้อ 7)
    runLog(
      "09a",
      "ขั้น 09: ตั้งรหัสใหม่สำเร็จ — รหัสใหม่ 09A = อนุพันธ์ของ UAT_DEMO_PASSWORD (สูตร: " +
        "UAT_DEMO_PASSWORD + \"-UAT-09A\" — ดึงค่าจริงจาก env ได้เสมอ · ไม่พิมพ์ค่าจริง MAJOR-1)",
    );
    await stepShot(resetPage, "09a", "09");

    // ขั้น 10: ไปหน้าเข้าสู่ระบบ → ลองรหัสเดิม → ถูกปฏิเสธ (รหัสเก่าตายจริง)
    await resetPage.getByRole("link", { name: "ไปหน้าเข้าสู่ระบบ" }).click();
    await expect(resetPage).toHaveURL(/\/login/);
    await loginExpectRejected(resetPage, UAT_ACCOUNTS.citizen, env.demoPassword);
    await stepShot(resetPage, "09a", "10");

    // ขั้น 11: ล็อกอินด้วยรหัสใหม่ → สำเร็จ (ไม่มีขั้น MFA — บัญชีพลเมืองไม่บังคับ)
    await loginViaFormUat(resetPage, UAT_ACCOUNTS.citizen, newPassword);
    await expect(resetPage).not.toHaveURL(/\/login/);
    await stepShot(resetPage, "09a", "11");
    runLog("09a", "ขั้น 11: ล็อกอินด้วยรหัสใหม่ 09A สำเร็จ (ไม่มีขั้น MFA) — สคริปต์ 09A จบ");
    // ขั้น 12 (re-seed คืนฐาน) ทำงานที่ afterAll ของ describe นี้
  });
});
