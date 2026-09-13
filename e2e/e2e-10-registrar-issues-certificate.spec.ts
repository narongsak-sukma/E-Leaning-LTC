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
 * gate r3 BLOCKER (200-PDF ผ่าน session เจ้าของใบ): ออกใบผ่าน BFF จริงรัน pipeline
 * แนบ PDF ครบ (renderCertificatePdf → upload บักเก็ต certificates → RPC
 * admin_attach_certificate_pdf + audit CERT_PDF_ATTACH — issue.ts attachCertificatePdf
 * ต่อจาก admin_issue_certificate ใน request เดียวกัน) → DB: pdf_media_id ไม่เป็น null
 * + media row (bucket/path/mime) + audit → เปิด URL จากอีเมลผ่าน BFF ด้วย session
 * เจ้าของใบต้องได้ 200 + application/pdf + bytes %PDF- → เพิกถอนผ่าน UI จริง (ปุ่ม
 * ต่อแถวของทะเบียน PB-20) → เจ้าของใบโหลด PDF ได้อีกครั้งหลังเพิกถอน (route PDF
 * ไม่กรองสถานะโดยเจตนา — ลิงก์ PDF ในอีเมลเพิกถอนของ NTF-003 จึงใช้ได้จริง)
 *
 * SoD T9: canIssueCertificate = staff:registrar / super_admin เท่านั้น — registrar ที่
 * สร้างใหม่ (GoTrue + role ผ่าน psql) ต้องผ่านได้จริง
 */
import { expect, test, type Page } from "@playwright/test";

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

/**
 * fetch PDF ของใบแบบ same-origin ด้วย session ปัจจุบันของหน้า (คุกกี้ BFF ถูกส่งไป
 * กับ fetch โดยอัตโนมัติ) — URL นี้คือ URL เดียวกับที่ dispatch.ts ประกอบใส่อีเมล
 * (`<base>/api/v1/certificates/<certificate_id>/pdf`) ซึ่ง DCR-10 เคส 5 พิสูจน์แล้ว
 * ว่าอีเมลจริง issued/revoked ใน Mailpit มีครบทุกฉบับ — คืน status/type/magic/size
 */
async function fetchPdfAsPage(
  page: Page,
  certId: string,
): Promise<{ status: number; contentType: string; magic: string; size: number }> {
  return page.evaluate(async (id: string) => {
    const res = await fetch(`/api/v1/certificates/${id}/pdf`);
    const contentType = res.headers.get("content-type") ?? "";
    const buf = new Uint8Array(await res.arrayBuffer());
    const magic = Array.from(buf.slice(0, 5), (b) => String.fromCharCode(b)).join("");
    return { status: res.status, contentType, magic, size: buf.length };
  }, certId);
}

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

  test("registrar เห็นผู้เรียนในคิว → ออกใบ (PDF แนบจริง) → เจ้าของโหลด PDF 200 → เพิกถอน → โหลดได้อีก", async ({ page }) => {
    test.setTimeout(300_000);
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
    // ขอบเขต "ตารางคิว" (caption sr-only ของ DataTable — PB-20 เพิ่มตารางทะเบียนใบ
    // ที่ออกแล้วบนหน้าเดียวกัน แถวมีชื่อผู้ถือใบด้วย — ห้าม scope ทั้งหน้า)
    const queueTable = page.getByRole("table", { name: "ตารางคิวผู้มีสิทธิ์รับใบ" });
    const row = queueTable.getByRole("row").filter({ hasText: holderName[0]?.name ?? "" });
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

    // ── gate r3 BLOCKER: ออกใบผ่าน BFF จริงต้อง "แนบ PDF จริง" — พิสูจน์ที่ DB ──
    // issueCertificate() รัน attachCertificatePdf ต่อจาก RPC ออกใบ (render → upload
    // บักเก็ต certificates → RPC admin_attach_certificate_pdf) — pdf_media_id ไม่ null
    const pdfRows = await psqlRows<{ media_id: string | null }>(`
      select pdf_media_id::text as media_id from public.certificates
       where id = '${cert?.id ?? ""}';
    `);
    expect(pdfRows[0]?.media_id ?? "").toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // media row ครบตามที่ attach RPC เขียน (0019: bucket certificates · path
    // certificates-pdf/<cert_no>.pdf · mime application/pdf)
    const media = await psqlRows<{ bucket: string; path: string; mime: string }>(`
      select m.bucket, m.storage_path as path, m.mime_type as mime
        from public.media_assets m
       where m.id = '${pdfRows[0]?.media_id ?? ""}';
    `);
    expect(media).toHaveLength(1);
    expect(media[0]?.bucket).toBe("certificates");
    expect(media[0]?.path).toBe(`certificates-pdf/${cert?.cert_no ?? ""}.pdf`);
    expect(media[0]?.mime).toBe("application/pdf");
    // audit CERT_PDF_ATTACH ของใบนี้ (TX เดียวกับการแนบ — 0019)
    const pdfAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_PDF_ATTACH' and entity_id = '${cert?.id ?? ""}';
    `);
    expect(pdfAudit[0]?.n).toBe(1);

    // ── gate r3 BLOCKER: เปิดลิงก์ PDF จากอีเมลผ่าน BFF ด้วย session เจ้าของใบ ──
    // (issued) — ต้องได้ 200 + application/pdf + bytes %PDF- จริง · RLS เปิดให้เจ้าของ
    // ใบ (certificates_owner_read + media_read PB-14a + storage.objects 0019)
    await loginViaForm(page, learner?.email ?? "");
    const issuedPdf = await fetchPdfAsPage(page, cert?.id ?? "");
    expect(issuedPdf.status, JSON.stringify(issuedPdf)).toBe(200);
    expect(issuedPdf.contentType).toContain("application/pdf");
    expect(issuedPdf.magic).toBe("%PDF-");
    expect(issuedPdf.size).toBeGreaterThan(100);

    // ── gate r3: เพิกถอนผ่าน UI จริง — ปุ่มต่อแถวของทะเบียนใบที่ออกแล้ว (PB-20) ──
    // registrar ผูก factor แล้วตั้งแต่ต้นเทส → login สองขั้น (Wave F) — ส่ง secret ให้ helper
    await loginViaForm(page, registrar?.email ?? "", { totpSecret: aal2.totpSecret });
    // reuse session aal2 ตัวเดิม: token ยังอยู่ในอายุ (ทั้งเทสจบภายในไม่กี่นาที) และ
    // loginViaForm เพิ่งสร้าง session aal1 ทับคุกกี้ — inject คืน aal2 ก่อนใช้หน้า staff
    await injectSession(page, aal2);
    // ค้นหาทะเบียนด้วยเลขที่ใบ — เข้า URL ค้นหาตรง ๆ (GET form ใช้ URL เดียวกัน;
    // ผลลัพธ์ SSR เหมือนกันแต่ตัดช่วง form-submit ออกจาก flow)
    await page.goto(`/admin/certificates?cert_no=${cert?.cert_no ?? ""}`);
    await expect(
      page.getByRole("heading", { name: "ทะเบียนประกาศนียบัตรที่ออกแล้ว" }),
    ).toBeVisible();
    // ขอบเขต "ตารางทะเบียน" (caption sr-only) — เช่นเดียวกับตารางคิวด้านบน
    const registryTable = page.getByRole("table", { name: "ตารางทะเบียนประกาศนียบัตร" });
    const certRow = registryTable.getByRole("row").filter({ hasText: cert?.cert_no ?? "" });
    await expect(certRow).toBeVisible();
    // dev stack: Next HMR ("Fast Refresh rebuilding") อาจยิงระหว่าง hydration และกลืน
    // คลิกแรกไป — ปุ่มนี้เปิด modal เท่านั้น (ไม่มี side effect อื่น) คลิกซ้ำจน dialog
    // เปิดได้จริง (ผ่าน trace ยืนยัน: rebuild ตรงกับช่วงคลิกพอดี)
    const revokeDialog = page.getByRole("dialog");
    for (let clickAttempt = 0; clickAttempt < 4; clickAttempt += 1) {
      await certRow.getByRole("button", { name: `เพิกถอนใบ ${cert?.cert_no ?? ""}` }).click();
      if (await revokeDialog.isVisible().catch(() => false)) {
        break;
      }
      await page.waitForTimeout(750);
    }
    await expect(revokeDialog).toContainText("ยืนยันการเพิกถอนประกาศนียบัตร");
    await revokeDialog.locator("#cert-revoke-reason").fill(
      "เพิกถอนเพื่อทดสอบว่าเจ้าของใบยังโหลด PDF ของตัวเองได้ (gate r3)",
    );
    await revokeDialog.getByRole("button", { name: "ยืนยันเพิกถอน" }).click();
    await expect(revokeDialog.getByRole("status")).toContainText("เพิกถอนสำเร็จ");
    // โหลดทะเบียนใหม่ (SSR อ่านจาก DB) — แถวเป็น "เพิกถอนแล้ว" และไม่มีปุ่มจัดการ
    // (revoked ไม่มี action — CertificateRowActions คืน null) · ไม่พึ่งการคลิกปุ่ม
    // "ปิด" + router.refresh ของโมดัล เพื่อตัดช่วง HMR ออกเช่นเดียวกับด้านบน
    await page.goto(`/admin/certificates?cert_no=${cert?.cert_no ?? ""}`);
    const revokedRowUi = registryTable.getByRole("row").filter({ hasText: cert?.cert_no ?? "" });
    await expect(revokedRowUi).toBeVisible();
    await expect(revokedRowUi).toContainText("เพิกถอนแล้ว");
    await expect(
      revokedRowUi.getByRole("button", { name: `เพิกถอนใบ ${cert?.cert_no ?? ""}` }),
    ).toHaveCount(0);
    // DB สอดคล้อง: สถานะ revoked + audit CERT_REVOKE
    const revokedCert = await psqlRows<{ status: string }>(`
      select status::text from public.certificates where id = '${cert?.id ?? ""}';
    `);
    expect(revokedCert[0]?.status).toBe("revoked");
    const revokeAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'CERT_REVOKE' and entity_id = '${cert?.id ?? ""}';
    `);
    expect(revokeAudit[0]?.n).toBe(1);

    // ── gate r3: เจ้าของใบที่ถูกเพิกถอนยังโหลด PDF ตัวเองได้ (revoked) ──
    // route PDF ไม่กรองสถานะโดยเจตนา — ลิงก์ PDF ในอีเมลเพิกถอน (NTF-003) ใช้ได้จริง
    // สำหรับผู้ถือใบ · สาธารณะไม่มี session ได้ 401 (DCR-10 เคส 5)
    await loginViaForm(page, learner?.email ?? "");
    const revokedPdf = await fetchPdfAsPage(page, cert?.id ?? "");
    expect(revokedPdf.status, JSON.stringify(revokedPdf)).toBe(200);
    expect(revokedPdf.contentType).toContain("application/pdf");
    expect(revokedPdf.magic).toBe("%PDF-");
  });
});
