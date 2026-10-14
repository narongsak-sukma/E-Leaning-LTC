/**
 * UAT-09B — เปลี่ยนรหัสผ่าน + ออกจากระบบทุกเครื่อง (F2+F3 · Wave G P1 · บัญชี uat.staff.exam@ltc.local)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ห้ามรันตอนนี้ — post-close เท่านั้น (หลัง close drained + กฎ P8/re-seed)
 * ═══════════════════════════════════════════════════════════════════════════
 * - สัญญา: UAT-09-SPECS-DRAFT §3.2 (scenarios B-1..B-5) + §4 ตาราง 09B (12 ขั้น)
 *   ป้ายปุ่ม/ข้อความไทยทุกตัว copy จากสเปก (อ้าง as-built develop@65fbac9) —
 *   เจอข้อความต่างจากสเปก = fail ขั้นนั้นแล้วจด "สิ่งที่เห็นจริง" ห้ามเดาแก้เอง (§4)
 * - สอง browser context = สองเครื่อง (แบบแผน e2e-18:36-40): "บริบท ก" (เครื่องหลัก ·
 *   กด logout-all) และ "บริบท ข" (เครื่องที่สอง · ต้องตายตาม) — cookie jar แยก
 * - ขั้นเตรียม (ไม่ใช่ขั้นตรวจ): บัญชีนี้ต้องมี MFA factor TOTP จากรอบหลัก — secret
 *   ที่ ${RUN_ID}/mfa/ (จัดการโดย mfaSecretOf แบบ fail-loud · ถ้ายังไม่มีไปลงทะเบียน
 *   ผ่าน /my/security/enroll ก่อน) · ล็อกอินเป็นสองขั้น "สด" ทุกครั้งตาม Background
 * - X-1 (§6 ของสเปก): **ไม่คาดหวังการ์ด need-mfa บนเส้นทางเปลี่ยนรหัสผ่าน** —
 *   re-auth ของ changePasswordAction คือช่อง "รหัสผ่านปัจจุบัน" · ทุกครั้งที่กดปุ่ม
 *   "เปลี่ยนรหัสผ่าน" มี expectNoNeedMfaCard คุ้มไว้ (เห็นการ์ดนั้น = fail พร้อมจด)
 * - ลำดับ (§0 ข้อ 2): 09B เป็นสคริปต์ 09 ตัวสุดท้าย · รหัสเริ่มต้น = ค่า
 *   UAT_DEMO_PASSWORD ("รหัสเดิม" — re-seed ล่าสุดคือหลัง 09A · 09C/09D อ่านอย่างเดียว)
 *   · afterAll ของไฟล์นี้ re-seed ปิดท้ายรอบ (คืนฐานส่งมอบ · MFA factor ยังอยู่เดิม)
 * - หลักฐาน `.omc/artifacts/uat/${RUN_ID}/uat-09b/step-NN.png` จับก่อนไปขั้นถัดไปเสมอ
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  UAT_ACCOUNTS,
  expectNoNeedMfaCard,
  loginExpectRejected,
  loginViaFormUat,
  mfaSecretOf,
  reSeed,
  runLog,
  stepShot,
  totpNowFresh,
  uat09Env,
  uatNewPassword,
} from "./fixtures";

test.describe.configure({ mode: "serial" });

test.describe("UAT-09B — เปลี่ยนรหัสผ่านของตนเอง และออกจากระบบทุกเครื่อง (uat.staff.exam@ltc.local)", () => {
  let totpSecret = "";
  /** "บริบท ก" — เครื่องหลัก (ล็อกอิน B-1 · กด logout-all ขั้น 08) */
  let ctxA: BrowserContext | undefined;
  let pageA: Page | undefined;
  /** "บริบท ข" — เครื่องที่สอง (ล็อกอินขั้น 07 · ต้องตายตามขั้น 10) */
  let ctxB: BrowserContext | undefined;
  let pageB: Page | undefined;

  test.beforeAll(async ({ browser }) => {
    // fail-loud ก่อนแตะอะไร: env ครบ + secret MFA ของรอบนี้มีจริง (ขั้นเตรียม)
    const env = uat09Env();
    totpSecret = mfaSecretOf(UAT_ACCOUNTS.staffExam);
    runLog(
      "09b",
      `เริ่ม 09B — บัญชี ${UAT_ACCOUNTS.staffExam} · runtime ${env.appOrigin} · สอง context (ก/ข) · secret MFA โหลดจากไฟล์รอบแล้ว`,
    );
    ctxA = await browser.newContext();
    pageA = await ctxA.newPage();
    ctxB = await browser.newContext();
    pageB = await ctxB.newPage();
  });

  test.afterAll(async () => {
    // ขั้น 12 (คืนฐานส่งมอบ): re-seed ตามกฎ §0 ข้อ 2 — 09B จบด้วย logout-all + รหัสใหม่
    // ต้องคืนทุกบัญชีเป็นค่า env (MFA factor ของเจ้าหน้าที่ไม่ถูกแตะ — seed ไม่แตะ auth.mfa_factors)
    await reSeed("09b");
    await ctxA?.close().catch(() => undefined);
    await ctxB?.close().catch(() => undefined);
  });

  test("B-1 ล็อกอินสองขั้นสดแล้วเห็นหน้าความปลอดภัยครบสามส่วน", async () => {
    if (pageA === undefined) {
      throw new Error("UAT-09B: context ก ไม่พร้อม (beforeAll ล้ม?)");
    }
    const env = uat09Env();

    // ขั้น 01: ที่ "บริบท ก" ล็อกอินรหัสเดิม → หน้ายืนยันตัวตนสองชั้น (ข้อความ/ช่อง/ปุ่มครบ)
    await pageA.goto(`${env.appOrigin}/login`);
    await pageA.fill("#email", UAT_ACCOUNTS.staffExam);
    await pageA.fill("#password", env.demoPassword);
    await pageA.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
    await expect(pageA).toHaveURL(/\/login\/verify/);
    await expect(
      pageA.getByText("กรอกรหัส 6 หลักจากแอปยืนยันตัวตน หรือรหัสสำรอง (เช่น abcd-ef23)"),
    ).toBeVisible();
    await expect(pageA.getByLabel("รหัสยืนยัน")).toBeVisible();
    await expect(pageA.getByRole("button", { name: "ยืนยันตัวตน" })).toBeVisible();
    await stepShot(pageA, "09b", "01");

    // ขั้น 02: กรอก TOTP ปัจจุบัน → เข้าสู่ระบบสำเร็จ (สด · aal2) → /my/security ครบ 3 ส่วน
    await pageA.fill("#code", await totpNowFresh(totpSecret));
    await Promise.all([
      pageA.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 }),
      pageA.getByRole("button", { name: "ยืนยันตัวตน" }).click(),
    ]);
    await pageA.goto(`${env.appOrigin}/my/security`);
    await expect(pageA.getByRole("heading", { name: "ความปลอดภัยของบัญชี" })).toBeVisible();
    await expect(
      pageA.getByRole("heading", { name: "การยืนยันตัวตนสองชั้น (MFA)" }),
    ).toBeVisible();
    await expect(pageA.getByRole("heading", { name: "รหัสผ่าน", exact: true })).toBeVisible();
    await expect(pageA.getByRole("heading", { name: "เซสชัน" })).toBeVisible();
    await stepShot(pageA, "09b", "02");
  });

  test("B-2 รหัสปัจจุบันผิด — ไม่เปลี่ยน และแจ้งเป็นภาษาไทยเจาะจง", async () => {
    if (pageA === undefined) {
      throw new Error("UAT-09B: ต้องรันตามลำดับ serial — context ก ไม่พร้อม");
    }
    const newPassword = uatNewPassword("09b");

    // ขั้น 03: รหัสปัจจุบันผิด + รหัสใหม่/ยืนยันถูกต้องตรงกัน → การ์ดแดงเจาะจง · ไม่เปลี่ยน
    await pageA.fill("#current-password", "WrongCurrent#2026x");
    await pageA.fill("#new-password", newPassword);
    await pageA.fill("#confirm-password", newPassword);
    await pageA.getByRole("button", { name: "เปลี่ยนรหัสผ่าน" }).click();
    await expectNoNeedMfaCard(pageA); // X-1: เส้นทางนี้ไม่คาดหวัง need-mfa
    await expect(pageA.getByRole("status")).toHaveText(/รหัสผ่านปัจจุบันไม่ถูกต้อง/, {
      timeout: 20_000,
    });
    await expect(pageA.getByRole("status")).not.toHaveText(/เปลี่ยนรหัสผ่านเรียบร้อยแล้ว/);
    await expect(pageA).toHaveURL(/\/my\/security/);
    await stepShot(pageA, "09b", "03");
  });

  test("B-3 รหัสใหม่ผิดนโยบาย — การ์ดไทยเจาะจง (ทางเลือกอย่างน้อย 1 กรณี)", async () => {
    if (pageA === undefined) {
      throw new Error("UAT-09B: ต้องรันตามลำดับ serial — context ก ไม่พร้อม");
    }
    const env = uat09Env();

    // ขั้น 04 (ทางเลือก — เลือกกรณี "สั้นกว่า 12 อักษร"): ปัจจุบันถูกต้อง รหัสใหม่สั้น →
    // การ์ด "รหัสผ่านไม่ผ่านนโยบายความปลอดภัย (เช่น สั้นเกินไป หรือเดาง่ายเกินไป) กรุณาตั้งรหัสผ่านใหม่"
    await pageA.fill("#current-password", env.demoPassword);
    await pageA.fill("#new-password", "short12less");
    await pageA.fill("#confirm-password", "short12less");
    await pageA.getByRole("button", { name: "เปลี่ยนรหัสผ่าน" }).click();
    await expectNoNeedMfaCard(pageA); // X-1
    await expect(pageA.getByRole("status")).toHaveText(/รหัสผ่านไม่ผ่านนโยบายความปลอดภัย/, {
      timeout: 20_000,
    });
    await expect(pageA).toHaveURL(/\/my\/security/);
    await stepShot(pageA, "09b", "04");
  });

  test("B-4 เปลี่ยนรหัสผ่านสำเร็จ — เซสชันเครื่องนี้ยังใช้ต่อได้ รหัสเก่าใช้เข้าไม่ได้", async ({
    browser,
  }) => {
    if (pageA === undefined) {
      throw new Error("UAT-09B: ต้องรันตามลำดับ serial — context ก ไม่พร้อม");
    }
    const env = uat09Env();
    const newPassword = uatNewPassword("09b");

    // ขั้น 05a: กรอกถูกทุกช่อง → การ์ดเขียวสำเร็จ
    await pageA.fill("#current-password", env.demoPassword);
    await pageA.fill("#new-password", newPassword);
    await pageA.fill("#confirm-password", newPassword);
    await pageA.getByRole("button", { name: "เปลี่ยนรหัสผ่าน" }).click();
    await expectNoNeedMfaCard(pageA); // X-1
    await expect(pageA.getByRole("status")).toHaveText(/เปลี่ยนรหัสผ่านเรียบร้อยแล้ว/, {
      timeout: 20_000,
    });
    // "จดรหัสใหม่ 09B ลง run-log" → จดสูตรอนุพันธ์แทนค่าจริง (MAJOR-1 — ดู fixtures)
    runLog(
      "09b",
      "ขั้น 05: เปลี่ยนรหัสผ่านสำเร็จ — รหัสใหม่ 09B = อนุพันธ์ของ UAT_DEMO_PASSWORD " +
        "(สูตร: UAT_DEMO_PASSWORD + \"-UAT-09B\" · ไม่พิมพ์ค่าจริง MAJOR-1)",
    );
    await stepShot(pageA, "09b", "05a");

    // ขั้น 05b: "บริบท ก" ยังล็อกอินอยู่ — โหลดหน้าอื่นที่ต้องล็อกอิน (/my/courses) ไม่ถูกไล่ออก
    await pageA.goto(`${env.appOrigin}/my/courses`);
    await expect(pageA).not.toHaveURL(/\/login/, { timeout: 10_000 });
    await stepShot(pageA, "09b", "05b");

    // ขั้น 06: context ชั่วคราวตัวใหม่ลอง "รหัสเดิม" → ถูกปฏิเสธ (รหัสเก่าตายจริง) แล้วปิดทิ้ง
    const ctxTemp = await browser.newContext();
    const pageTemp = await ctxTemp.newPage();
    try {
      await loginExpectRejected(pageTemp, UAT_ACCOUNTS.staffExam, env.demoPassword);
      await stepShot(pageTemp, "09b", "06");
    } finally {
      await ctxTemp.close();
    }
  });

  test("B-5 ออกจากระบบทุกเครื่อง — ทุก context ตายจริง และกลับมาล็อกอินได้", async () => {
    if (pageA === undefined || pageB === undefined) {
      throw new Error("UAT-09B: ต้องรันตามลำดับ serial — context ก/ข ไม่พร้อม");
    }
    const env = uat09Env();
    const newPassword = uatNewPassword("09b");

    // ขั้น 07: "บริบท ข" ล็อกอินด้วยรหัสใหม่ผ่านขั้น MFA → มี 2 contexts ล็อกอินพร้อมกัน
    await loginViaFormUat(pageB, UAT_ACCOUNTS.staffExam, newPassword, {
      totpSecret,
    });
    await expect(pageB).not.toHaveURL(/\/login/);
    await stepShot(pageB, "09b", "07");

    // ขั้น 08a: ที่ "บริบท ก" ส่วน "เซสชัน" — ปุ่มอยู่ใต้คำอธิบายตามสัญญา
    await pageA.goto(`${env.appOrigin}/my/security`);
    await expect(
      pageA.getByText(
        "ใช้เมื่อสงสัยว่ามีผู้อื่นเข้าใช้บัญชีของท่าน — ระบบจะยกเลิกการเข้าสู่ระบบทุกเครื่องรวมถึงเครื่องนี้",
      ),
    ).toBeVisible();
    const logoutAllButton = pageA.getByRole("button", { name: "ออกจากระบบทุกเครื่อง" });
    await expect(logoutAllButton).toBeVisible();
    await stepShot(pageA, "09b", "08a");

    // ขั้น 08b: กดปุ่ม → ถูกพาไป /login (โหลดหน้าใหม่เต็มรูปแบบ)
    await logoutAllButton.click();
    await pageA.waitForURL("**/login**", { timeout: 20_000 });
    await stepShot(pageA, "09b", "08b");

    // ขั้น 09: "บริบท ก" พิมพ์ /my/security ตรง ๆ → ถูกพาไป /login (เซสชันเครื่องนี้ตายจริง)
    await pageA.goto(`${env.appOrigin}/my/security`);
    await pageA.waitForURL("**/login**", { timeout: 20_000 });
    await expect(pageA).toHaveURL(/\/login/);
    await stepShot(pageA, "09b", "09");

    // ขั้น 10: "บริบท ข" โหลดหน้าใหม่ที่ /my/security → ถูกพาไป /login เช่นกัน
    // (เครื่องอื่นตายด้วย — การยกเลิกเป็นแบบทุกเซสชัน ไม่ใช่เฉพาะเครื่องที่กด)
    await pageB.goto(`${env.appOrigin}/my/security`);
    await pageB.waitForURL("**/login**", { timeout: 20_000 });
    await expect(pageB).toHaveURL(/\/login/);
    await stepShot(pageB, "09b", "10");

    // ขั้น 11: ล็อกอินใหม่ด้วย "รหัสใหม่ 09B" + TOTP → บัญชีกลับมาใช้ได้ปกติหลัง logout-all
    await loginViaFormUat(pageA, UAT_ACCOUNTS.staffExam, newPassword, {
      totpSecret,
    });
    await expect(pageA).not.toHaveURL(/\/login/);
    await stepShot(pageA, "09b", "11");
    runLog("09b", "ขั้น 11: ล็อกอินใหม่ด้วยรหัสใหม่ 09B + TOTP สำเร็จ — สคริปต์ 09B จบ");
    // ขั้น 12 (re-seed คืนฐานส่งมอบ) ทำงานที่ afterAll ของ describe นี้
  });
});
