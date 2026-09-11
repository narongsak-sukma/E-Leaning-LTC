/**
 * E2E-11 — ตรวจสอบประกาศนียบัตรสาธารณะ /verify/{code} แบบไม่ล็อกอิน
 *
 * ตั้งฉากแบบ self-contained: ออกใบจริงผ่าน UI (ผู้เรียน lawyer เรียนจบ + สอบ FAST-A ผ่าน
 * + ทะเบียนออกใบ — ครบทั้ง pipeline เหมือน E2E-10) จากนั้น:
 *   ออกจากระบบ → อ่าน verify_code จาก DB ผ่าน psql → เปิด /verify/{verify_code}
 *   → ต้องแสดง 4 ข้อมูล (เลขที่/รหัสอ้างอิง · หลักสูตร · วันที่ออกใบ · สถานะ)
 *   → assert ไม่มีชื่อเจ้าของใบปรากฏที่ใดบนหน้า (และ API ตอบ 4 ฟิลด์ ไม่มี holder_name)
 *   → รหัสที่ไม่มีจริง (รูปแบบถูก) → not_found สุภาพ
 *
 * นโยบายความเป็นส่วนตัว: 4 ฟิลด์เท่านั้น — ไม่มี holder_name/PII (schema ตรวจซ้ำ fail-closed)
 */
import { expect, test } from "@playwright/test";

import {
  COURSE3_ID,
  COURSE3_LESSON_ID,
  FAST_A,
  FAST_A_QUESTIONS,
  captureIssueSuccessToast,
  completeDocumentViaUi,
  createLawyerLearner,
  createStaffRoleUser,
  deleteD9User,
  enrollMfaTotp,
  enrollViaUi,
  injectSession,
  loadExamPlan,
  seedFastExamA,
  takeExamViaUi,
  type D9User,
} from "./d9-helpers";
import { psql, psqlRows } from "./helpers/db";
import { browserApi, loginViaForm, logoutViaButton } from "./helpers/session";

/** รหัสที่ไม่มีใบจริง (รูปแบบเลขที่ถูกตาม LTC-<ปี>-<6 หลัก> — BFF จำแนกเอง) */
const MISSING_CODE = "LTC-2099-000000";

test.describe("E2E-11 ตรวจสอบประกาศนียบัตรสาธารณะ (ไม่ล็อกอิน)", () => {
  let learner: D9User | undefined;
  let registrar: D9User | undefined;

  test.beforeAll(async () => {
    await seedFastExamA();
    learner = await createLawyerLearner("d9-verify");
    registrar = await createStaffRoleUser("d9-registrar", "staff:registrar");
  });

  test.afterAll(async () => {
    if (learner !== undefined) {
      await deleteD9User(learner.id);
    }
    if (registrar !== undefined) {
      await deleteD9User(registrar.id);
    }
  });

  test("ออกใบจริงผ่าน UI แล้วอ่าน verify_code จาก DB", async ({ page }) => {
    test.setTimeout(180_000);
    await loginViaForm(page, learner?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    await completeDocumentViaUi(page, COURSE3_ID, COURSE3_LESSON_ID);
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "correct");
    await psql(`
      update public.enrollments
         set status = 'completed', completed_at = now()
       where user_id = '${learner?.id ?? ""}' and course_id = '${COURSE3_ID}';
    `);
    const profile = await psqlRows<{ name: string }>(`
      select display_name as name from public.profiles where id = '${learner?.id ?? ""}';
    `);
    const holderName = profile[0]?.name ?? "";
    expect(holderName.length).toBeGreaterThan(0); // fail-fast: คิวค้นด้วยชื่อผู้ถือใบ
    const titles = await psqlRows<{ title: string }>(`
      select title_th as title from public.courses where id = '${COURSE3_ID}';
    `);
    const courseTitle = titles[0]?.title ?? "";
    expect(courseTitle.length).toBeGreaterThan(0);
    await loginViaForm(page, registrar?.email ?? "");
    // ธง MFA (รายงาน lead): staff:* ถูกบังคับ aal2 ที่ BFF (ERR-AUTH-004) แต่ยังไม่มีหน้าจอ
    // MFA (Wave F) — จึงลงทะเบียน TOTP ฝั่ง harness แล้วเขียน session aal2 ลง cookie
    // (@supabase/ssr ตัวเดียวกับแอป); การ login ผ่านฟอร์มก่อนหน้ายังพิสูจน์ว่าบัญชีใช้ได้จริง
    const aal2 = await enrollMfaTotp(registrar?.email ?? "");
    await injectSession(page, aal2);
    await page.goto("/admin/certificates");
    const row = page.getByRole("row").filter({ hasText: holderName });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "ออกใบประกาศนียบัตร" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // ข้อความสำเร็จอยู่ "ใน" dialog ที่ถูก unmount ทันทีที่ router.refresh() เรนเดอร์คิวใหม่ —
    // จับด้วย MutationObserver (captureIssueSuccessToast — เหตุผลเดียวกับ e2e-10)
    const readToastLog = await captureIssueSuccessToast(page);
    await dialog.getByRole("button", { name: "ยืนยันออกใบ" }).click();
    await expect
      .poll(readToastLog, { timeout: 15_000 })
      .toMatch(/ออกใบสำเร็จ เลขที่ LTC-\d{4}-\d{6} — รายการคิวจะรีเฟรชอัตโนมัติ/);
    const certs = await psqlRows<{ cert_no: string; verify_code: string }>(`
      select cert_no, verify_code from public.certificates
       where user_id = '${learner?.id ?? ""}' and status = 'valid';
    `);
    expect(certs).toHaveLength(1);
    expect(certs[0]?.verify_code ?? "").toMatch(/^[0-9A-Za-z_-]{43}$/);
  });

  test("/verify/{verify_code} (หลังออกจากระบบ): แสดง 4 ข้อมูล ไม่มีชื่อเจ้าของใบที่ใด", async ({
    page,
  }) => {
    // ค่าจริงอ่านจาก DB ในตัว test เอง (ไม่แชร์ตัวแปรข้าม test — กัน dependency แฝง)
    const certs = await psqlRows<{ cert_no: string; verify_code: string }>(`
      select cert_no, verify_code from public.certificates
       where user_id = '${learner?.id ?? ""}' and status = 'valid';
    `);
    expect(certs).toHaveLength(1);
    const certNo = certs[0]?.cert_no ?? "";
    const verifyCode = certs[0]?.verify_code ?? "";
    expect(certNo).toMatch(/^LTC-\d{4}-\d{6}$/);
    expect(verifyCode).toMatch(/^[0-9A-Za-z_-]{43}$/);
    const profile = await psqlRows<{ name: string }>(`
      select display_name as name from public.profiles where id = '${learner?.id ?? ""}';
    `);
    const holderName = profile[0]?.name ?? "";
    expect(holderName.length).toBeGreaterThan(0);
    const titles = await psqlRows<{ title: string }>(`
      select title_th as title from public.courses where id = '${COURSE3_ID}';
    `);
    const courseTitle = titles[0]?.title ?? "";
    expect(courseTitle.length).toBeGreaterThan(0);

    // ออกจากระบบจริงผ่านปุ่ม (ธง: ปุ่ม "ออกจากระบบ" มีเฉพาะหน้าแอปของผู้ใช้ เช่น /my/courses
    // — หน้า "/" ไม่มีปุ่มนี้) — บริบทถัดไปเป็นบริบทสาธารณะ
    await loginViaForm(page, learner?.email ?? "");
    await page.goto("/my/courses");
    await logoutViaButton(page);
    await expect(page.getByRole("button", { name: "เข้าสู่ระบบ" })).toBeVisible();

    // เปิดลิงก์ตรง /verify/{verify_code} — VerifyPanel ตรวจทันทีเมื่อ hydrate
    await page.goto(`/verify/${verifyCode}`);
    await expect(
      page.getByRole("heading", { name: "ตรวจสอบแล้ว — ประกาศนียบัตรถูกต้อง" }),
    ).toBeVisible();
    await expect(
      page.getByText("ประกาศนียบัตรฉบับนี้ออกโดยสภาทนายความแห่งประเทศไทย และมีผลใช้งานอยู่"),
    ).toBeVisible();
    // 4 ฟิลด์: เลขที่/รหัสอ้างอิง (แสดงเลขที่ใบ LTC-…) · หลักสูตร · วันที่ออกใบ
    // (+ สถานะจากหัวข้อ/คำอธิบาย) — RPC ไม่มี verify_code คืนเด็ดขาด (0019: D8/D11-12)
    await expect(page.getByText("เลขที่/รหัสอ้างอิง")).toBeVisible();
    await expect(page.getByText("หลักสูตร", { exact: true })).toBeVisible();
    await expect(page.getByText("วันที่ออกใบ", { exact: true })).toBeVisible();
    await expect(page.getByText(certNo)).toBeVisible(); // ช่องเลขที่/รหัสอ้างอิง
    await expect(page.getByText(courseTitle)).toBeVisible(); // ช่องหลักสูตร
    // ความเป็นส่วนตัวซ้ำเป็นเงินเป็นตอง: ไม่มีชื่อเจ้าของใบ/อีเมล/รหัสตรวจ 43 อักขระที่ใดบนหน้า
    await expect(page.locator("body")).not.toContainText(holderName);
    await expect(page.locator("body")).not.toContainText(learner?.email ?? "no-email");
    await expect(page.locator("body")).not.toContainText(verifyCode);
    // API ตรงกัน: ตอบ 200 + 4 ฟิลด์เท่านั้น · code = เลขที่ใบ (ไม่ใช่รหัสตรวจ)
    // (สั่งจากบริบท anon หลัง logout)
    const api = await browserApi(page, "GET", `/api/v1/certificates/${verifyCode}`);
    expect(api.status).toBe(200);
    const json = JSON.parse(api.text) as Record<string, unknown>;
    expect(Object.keys(json).sort().join(",")).toBe("code,course_title,issued_at,status");
    expect(json["status"]).toBe("valid");
    expect(json["code"]).toBe(certNo);
    expect(api.text).not.toContain(holderName);
    expect(api.text).not.toContain(learner?.email ?? "no-email");
    expect(api.text).not.toContain(verifyCode);
  });

  test("รหัสที่ไม่มีจริง → not_found สุภาพ (ไม่มีชื่อ/ไม่มีรายละเอียดภายใน)", async ({ page }) => {
    // ชื่อจริงของผู้เรียนอ่านจาก DB ในตัว test (ไม่อิงตัวแปรข้าม test)
    const profile = await psqlRows<{ name: string }>(`
      select display_name as name from public.profiles where id = '${learner?.id ?? ""}';
    `);
    const holderName = profile[0]?.name ?? "";
    expect(holderName.length).toBeGreaterThan(0);

    await page.goto(`/verify/${MISSING_CODE}`);
    await expect(
      page.getByRole("heading", { name: "ตรวจสอบแล้ว — ไม่พบข้อมูลประกาศนียบัตร" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "ไม่พบข้อมูลตามรหัสที่ตรวจสอบ กรุณาตรวจทานรหัสอีกครั้ง หรือติดต่อเจ้าหน้าที่สภาทนายความฯ (โทร 0 2351 1128)",
      ),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(holderName);
    await expect(page.locator("body")).not.toContainText(learner?.email ?? "no-email");
    // สถานะที่แสดงเป็น "ไม่พบ" — ไม่มีแผงข้อผิดพลาดระบบ/stack ใด ๆ
    await expect(page.getByText("ไม่พบข้อมูลตามรหัสที่ตรวจสอบ")).toHaveCount(1);
  });
});
