/**
 * E2E-10 — เจ้าหน้าที่ทะเบียน (staff:registrar) ออกใบประกาศนียบัตรผ่าน UI จริง
 *
 * ตั้งฉาก: ผู้เรียน (lawyer) ลงทะเบียน + เรียนจบ + สอบ FAST-A ผ่าน 100% ทั้งหมดผ่าน UI
 * (E2E-07..09 แบบเดียวกัน) แล้วฝั่ง harness จัดสถานะ enrollment = completed ผ่าน psql
 * (เงื่อนไขคิว eligible — เทียบเท่าชุด D-8) จากนั้น:
 *   registrar login → /admin/certificates → คิวผู้มีสิทธิ์รับประกาศนียบัตร → พบแถวผู้เรียน
 *   → "ออกใบประกาศนียบัตร" → ยืนยัน dialog → role=status "ออกใบสำเร็จ เลขที่ LTC-…"
 *   → DB: ใบ valid + cert_no รูป LTC-<ปี>-<6 หลัก> + verify_code 43 อักขระ + audit CERT_ISSUE
 *
 * SoD T9: canIssueCertificate = staff:registrar / super_admin เท่านั้น — registrar ที่
 * สร้างใหม่ (GoTrue + role ผ่าน psql) ต้องผ่านได้จริง
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
import { loginViaForm } from "./helpers/session";

test.describe("E2E-10 ทะเบียนออกใบประกาศนียบัตรผ่าน UI", () => {
  let learner: D9User | undefined;
  let registrar: D9User | undefined;

  test.beforeAll(async () => {
    await seedFastExamA();
    learner = await createLawyerLearner("d9-reg");
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

  test("registrar เห็นผู้เรียนในคิว → ออกใบ → เห็นเลขที่ใบ + DB สอดคล้อง", async ({ page }) => {
    test.setTimeout(180_000);
    // ── ตั้งฉากผู้เรียนผ่าน UI จริง: ลงทะเบียน → เรียนจบ → สอบผ่าน ──
    await loginViaForm(page, learner?.email ?? "");
    await enrollViaUi(page, COURSE3_ID);
    await completeDocumentViaUi(page, COURSE3_ID, COURSE3_LESSON_ID);
    const plan = await loadExamPlan(FAST_A_QUESTIONS);
    await takeExamViaUi(page, COURSE3_ID, FAST_A.assessment, plan, "correct");
    await expect(page.getByText("ยินดีด้วย ท่านสอบผ่านตามเกณฑ์ที่กำหนด")).toBeVisible();
    // เงื่อนไขคิว: enrollment completed + completed_at (harness-side ตามแบบ D-8)
    await psql(`
      update public.enrollments
         set status = 'completed', completed_at = now()
       where user_id = '${learner?.id ?? ""}' and course_id = '${COURSE3_ID}';
    `);
    const holderName = await psqlRows<{ name: string }>(`
      select display_name as name from public.profiles where id = '${learner?.id ?? ""}';
    `);
    expect(holderName[0]?.name.length ?? 0).toBeGreaterThan(0);

    // ── registrar ออกใบผ่าน UI ──
    // ธง MFA (รายงาน lead): BFF บังคับ aal2 กับ staff:* (ERR-AUTH-004) แต่แอปยังไม่มี
    // หน้าจอ MFA (Wave F) — session aal2 จัดการฝั่ง harness: login ฟอร์มจริงก่อน (พิสูจน์
    // บัญชี + ให้แอปเขียน cookie จริง) → ลงทะเบียน TOTP กับ GoTrue ผ่าน REST → เขียน
    // session aal2 ลง cookie ด้วย @supabase/ssr ตัวเดียวกับแอป — ทุกขั้นตอนการออกใบบน
    // หน้าจอ (คิว → dialog ยืนยัน → toast เลขที่ใบ) ยังเป็น UI จริงทั้งหมด
    await loginViaForm(page, registrar?.email ?? "");
    const aal2 = await enrollMfaTotp(registrar?.email ?? "");
    await injectSession(page, aal2);
    await page.goto("/admin/certificates");
    await expect(page.getByRole("heading", { name: "ประกาศนียบัตร", exact: true })).toBeVisible();
    await expect(page.getByText("คิวผู้มีสิทธิ์รับประกาศนียบัตร")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: holderName[0]?.name ?? "" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "ออกใบประกาศนียบัตร" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("ยืนยันการออกประกาศนียบัตร");
    // ข้อความสำเร็จอยู่ "ใน" dialog ที่ถูก unmount ทันทีที่ router.refresh() เรนเดอร์คิวใหม่ —
    // จับด้วย MutationObserver (captureIssueSuccessToast — ไม่มีทางพลาดกรอบเดียวที่ toast ยังอยู่)
    const readToastLog = await captureIssueSuccessToast(page);
    await dialog.getByRole("button", { name: "ยืนยันออกใบ" }).click();
    await expect
      .poll(readToastLog, { timeout: 15_000 })
      .toMatch(/ออกใบสำเร็จ เลขที่ LTC-\d{4}-\d{6} — รายการคิวจะรีเฟรชอัตโนมัติ/);

    // ── DB: ใบ valid + เลขที่ + รหัสตรวจ 43 อักขระ + audit CERT_ISSUE ──
    const certs = await psqlRows<{
      id: string;
      cert_no: string;
      verify_code: string;
      status: string;
    }>(`
      select id::text, cert_no, verify_code, status::text
        from public.certificates where user_id = '${learner?.id ?? ""}';
    `);
    expect(certs).toHaveLength(1);
    const cert = certs[0];
    expect(cert?.cert_no ?? "").toMatch(/^LTC-\d{4}-\d{6}$/);
    expect(cert?.verify_code ?? "").toMatch(/^[0-9A-Za-z_-]{43}$/);
    expect(cert?.status).toBe("valid");
    const audit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_ISSUE' and entity_id = '${cert?.id ?? ""}';
    `);
    expect(audit[0]?.n).toBe(1);
    // คิวรีเฟรชแล้ว: ผู้เรียนนี้ตกออกจากคิว (anti-join — มีใบ valid แล้ว)
    await expect(row).toHaveCount(0);
  });
});
