/**
 * E2E-15 — คำขอผูกเลขที่ใบอนุญาตว่าความ ครบวงจร (Wave E Phase 5 · lane B ผู้เรียน + lane E registrar UI · IDENT-004/005)
 *
 * ตั้งฉาก (ทุกเส้นทางเดินของจริงผ่าน UI/BFF — ไม่มี shim):
 *   1) ผู้เรียน (citizen) /my/license → ตรวจ validation ฟอร์ม → ยื่นคำขอผูกเลขที่ใบอนุญาต
 *      (เลข 6-9 หลัก + ไฟล์หลักฐาน PNG) → 202 → ข้อความหลัง action (license-after-action) →
 *      DB: license_applications pending + media_assets (bucket license-evidence, ready) +
 *      audit LICENSE_BIND (TX เดียวกัน · context เก็บ license_hash เท่านั้น — ห้ามมีเลขจริง) ·
 *      GET /me/license (สัญญา BFF จริง): latestApplication.status=pending + canResubmit=false
 *   2) ยื่นซ้ำขณะ pending → 409 ERR-VAL-001 details.reason=pending_exists (ข้อความไทยกำกับ) —
 *      เดินผ่าน fetch ในหน้าเดียวกัน (คุกกี้ session จริง) เพราะ canResubmit=false ทำให้ UI ซ่อนฟอร์ม
 *   3) registrar (aal2 — harness ลงทะเบียน TOTP + inject session แบบเดียวกับ e2e-10) ตัดสิน
 *      "อนุมัติ" บน /admin/license-applications ผ่าน UI จริง (แถว → โมดัลยืนยัน) →
 *      DB: คำขอ approved + lawyer_licenses verified + role_assignments lawyer + audit
 *      LICENSE_VERIFY/ROLE_GRANT + event_outbox license.application.approved → ผู้เรียน
 *      GET /me/license ได้ currentLicense.licenseNo ตรงเลขที่ยื่น
 *   4) ผู้เรียนคนที่สองยื่น → registrar ปฏิเสธ: เหตุผล <10 → 400 details.fields=["reason"]
 *      (ประตู BFF — ยังไม่แตะ DB) แล้วตัดสินผ่านโมดัล UI ด้วยเหตุผล ≥10 → rejected +
 *      DB rejected_reason + audit LICENSE_VERIFY(result rejected) + event
 *      license.application.rejected → ผู้เรียน GET /me/license เห็น rejectedReason + canResubmit=true
 *
 * Drift ที่ธงไว้ (normalizeMyLicenseView อ่าน key "application"/"license" ขณะที่ BFF ส่ง
 * "latestApplication"/"currentLicense") — lead แก้แล้วใน commit เดียวกับ spec นี้:
 * normalize อ่าน latestApplication/currentLicense ก่อน (alias เดิมคงไว้แบบ tolerant) ·
 * spec จึง assert ทั้งสัญญา BFF+DB (ความจริง server-side) และป้ายบนการ์ด UI
 * (license-application-status / license-current-no) พร้อมกัน
 *
 * เนมสเปซ seed/cleanup ของตัวเอง (e15-*) — กวาดค้างก่อนเริ่ม + เก็บกวาดหลังจบ (รันซ้ำได้)
 */
import { expect, test, type Page } from "@playwright/test";

import {
  createStaffRoleUser,
  deleteD9User,
  enrollMfaTotp,
  injectSession,
  type Aal2Session,
  type D9User,
} from "./d9-helpers";
import { psql, psqlRows } from "./helpers/db";
import { loginViaForm } from "./helpers/session";
import { createLearnerUser, type LearnerUser } from "./helpers/users";

/** PNG 1x1 (bytes คงที่ — ใช้เป็นไฟล์หลักฐาน ไม่มีข้อมูลจริง) */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** เลขที่ใบอนุญาตของ spec นี้ (6-9 หลัก · ไม่ซ้ำกับชุดอื่น — ล้างที่ cleanup) */
const LICENSE_NO_A = "7301589";
const LICENSE_NO_B = "7302468";

/** ผล JSON API แบบสั้น (body ตัด 4000 ตัวอักษร — พอสำหรับ resource เช่น /me/license
 *  ทั้ง latestApplication+currentLicense และไม่มี token/PII — ตัดกัน error-context บวม) */
interface JsonCallResult {
  readonly status: number;
  readonly body: string;
}

/**
 * JSON ทุก method ที่ต้อง parse เป็น resource จากหน้า — fetch same-origin ด้วย
 * คุกกี้ session จริงของหน้า (Origin ของ browser ผ่าน CSRF ของ middleware) ·
 * browserApi ตัด text ที่ 500 ตัวอักษร — พอ envelope error แต่ไม่พอ resource
 */
async function callJsonApi(
  page: Page,
  method: "GET" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<JsonCallResult> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers: Record<string, string> = { accept: "application/json" };
      const init: RequestInit & { body?: string } = { method, headers, credentials: "same-origin" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(path, init);
      return { status: response.status, body: (await response.text()).slice(0, 4000) };
    },
    { method, path, body },
  );
}

/** PUT /me/license แบบ multipart จากหน้า (license_no + ไฟล์ PNG จาก base64 — ไม่มี token ลอย) */
async function putLicenseMultipart(
  page: Page,
  licenseNo: string,
): Promise<JsonCallResult> {
  return page.evaluate(
    async ({ licenseNo, pngBase64 }) => {
      const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0));
      const form = new FormData();
      form.append("license_no", licenseNo);
      form.append("file", new File([bytes], "evidence.png", { type: "image/png" }));
      const response = await fetch("/api/v1/me/license", {
        method: "PUT",
        body: form,
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      return { status: response.status, body: (await response.text()).slice(0, 600) };
    },
    { licenseNo, pngBase64: PNG_1X1_BASE64 },
  );
}

/** envelope §1.3 → {error:{code, message, details}} — ใช้ assert code/fields/reason */
function errorOf(result: JsonCallResult): {
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
} {
  const parsed = JSON.parse(result.body) as {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
  };
  const error = parsed.error ?? {};
  return {
    code: error.code ?? "",
    message: error.message ?? "",
    details: error.details ?? {},
  };
}

/** envelope §1.1 → {data:...} */
function dataOf(result: JsonCallResult): unknown {
  return (JSON.parse(result.body) as { data?: unknown }).data;
}

/** ชื่อแสดงผลจาก DB (สำหรับกรองแถวในตาราง admin — ค่า fixture ไม่ใช่ข้อมูลจริง) */
async function displayNameOf(userId: string): Promise<string> {
  const rows = await psqlRows<{ name: string }>(
    `select display_name as name from public.profiles where id = '${userId}';`,
  );
  const name = rows[0]?.name ?? "";
  expect(name.length, "seed ต้องมี display_name ใน profiles").toBeGreaterThan(0);
  return name;
}

let learnerA: LearnerUser | undefined;
let learnerB: LearnerUser | undefined;
let registrar: D9User | undefined;
/** session aal2 ของ registrar — สร้าง "ครั้งเดียวต่อรัน" ใน beforeAll (เหตุผลอยู่ที่นั่น) */
let registrarAal2: Aal2Session | undefined;

test.describe("E2E-15 คำขอผูกเลขที่ใบอนุญาตว่าความ (ผู้เรียน + registrar)", () => {
  // serial — เทสของไฟล์นี้ต่อกันเป็นเรื่องเดียว (คำขอของเทส 1 ถูกยื่นซ้ำในเทส 2 และ
  // อนุมัติในเทส 3): Playwright ≥1.63 รีสตาร์ท worker หลังเทสที่พัง = beforeAll รันใหม่
  // พร้อมผู้ใช้ใหม่ ทำให้เทสถัดไปเห็นโลกว่างแล้วพังด้วยอาการเกินจริง (ฟอร์มโผล่ทั้งที่
  // คำขอ pending / แถวตาราง registrar หาย) — serial ตัดลูกโซ่ตรงนั้น: เทสต่อจากตัวที่
  // พังเป็น skipped อย่างซื่อตรง ไม่ใช่ fail ลวง
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    // กวาดของค้างของเนมสเปซตัวเองจากรอบที่พังกลางทาง (idempotent — รันซ้ำได้)
    await cleanupE15();
    // const เฉพาะที่ — narrowing ของ let ระดับโมดูลโดน reset หลังทุก call ใน closure
    const learnerAUser = await createLearnerUser("e15-a"); // citizen — บทบาท lawyer ต้องได้จากการอนุมัติจริง
    const learnerBUser = await createLearnerUser("e15-b");
    const registrarUser = await createStaffRoleUser("e15-reg", "staff:registrar");
    learnerA = learnerAUser;
    learnerB = learnerBUser;
    registrar = registrarUser;
    // sanity ของ seed (แยกปัญหา seed พังออกจาก BFF/UI พัง)
    const seedCheck = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.profiles
       where id in ('${learnerAUser.id}', '${learnerBUser.id}', '${registrarUser.id}');
    `);
    expect(seedCheck[0]?.n).toBe(3);
    const roleCheck = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.role_assignments
       where user_id = '${registrarUser.id}' and role = 'staff:registrar' and revoked_at is null;
    `);
    expect(roleCheck[0]?.n).toBe(1);
    // session aal2 ครั้งเดียวต่อรัน — GoTrue ปฏิเสธการ enroll ใหม่จาก session aal1 ของผู้ใช้
    // ที่มี factor ที่ verify แล้ว (403 — เดิมถูก 422 ชื่อ factor ซ้ำบังไว้) เทส 3/4 จึงแชร์
    // session นี้ (inject ซ้ำได้หลัง login ทับคุกกี้ — เป็นการคืน session เดิม ไม่ใช่ enroll ใหม่)
    registrarAal2 = await enrollMfaTotp(registrarUser.email);
  });

  test.afterAll(async () => {
    await cleanupE15();
  });

  test("ผู้เรียนยื่นคำขอผ่านฟอร์ม → 202 → DB pending + media + audit LICENSE_BIND (hash เท่านั้น)", async ({
    page,
  }) => {
    expect(learnerA).toBeDefined();
    await loginViaForm(page, learnerA?.email ?? "");
    await page.goto("/my/license");
    await expect(page.getByRole("heading", { name: "ใบอนุญาตว่าความของฉัน" })).toBeVisible();
    // สถานะเริ่มต้น — ยังไม่มีคำขอ/ใบอนุญาต + ฟอร์มแสดง (canResubmit=true)
    await expect(page.getByText("ยังไม่เคยยื่นคำขอ")).toBeVisible();
    await expect(page.getByText("ยังไม่มีใบอนุญาตที่ได้รับการยืนยัน")).toBeVisible();
    await expect(page.getByTestId("license-no-input")).toBeVisible();

    // validation ฝั่ง client: ฟอร์มว่าง → เตือนเลขที่ใบอนุญาตก่อน (fieldError แสดงทีละข้อความ)
    await page.getByTestId("license-submit").click();
    await expect(page.getByTestId("license-form-error")).toContainText(
      "เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก",
    );
    // กรอกเลขถูกแต่ยังไม่แนบไฟล์ → เตือนเรื่องไฟล์หลักฐาน
    await page.getByTestId("license-no-input").fill(LICENSE_NO_A);
    await page.getByTestId("license-submit").click();
    await expect(page.getByTestId("license-form-error")).toContainText(
      "กรุณาแนบไฟล์หลักฐาน (JPG, PNG หรือ PDF)",
    );

    // ยื่นจริง — แนบ PNG → 202 → ข้อความหลัง action + ฟอร์มถูกซ่อน (canResubmit=false)
    await page.getByTestId("license-file-input").setInputFiles({
      name: "evidence.png",
      mimeType: "image/png",
      buffer: Buffer.from(PNG_1X1_BASE64, "base64"),
    });
    await page.getByTestId("license-submit").click();
    await expect(page.getByTestId("license-after-action")).toHaveText(
      "ส่งคำขอเรียบร้อยแล้ว — เจ้าหน้าที่จะตรวจสอบและแจ้งผลการพิจารณาให้ท่านทราบ",
    );
    await expect(page.getByTestId("license-no-input")).toHaveCount(0);

    // การ์ดโหลดสถานะใหม่ — ป้ายสถานะคำขอ pending ปรากฏบน UI (normalize ตรง key ขาออกแล้ว)
    await expect(page.getByTestId("license-application-status")).toHaveText(
      "รอเจ้าหน้าที่ตรวจสอบ",
    );

    // สัญญา BFF จริง: latestApplication.status=pending · currentLicense=null · canResubmit=false
    const statusResult = await callJsonApi(page, "GET", "/api/v1/me/license");
    expect(statusResult.status).toBe(200);
    const statusData = dataOf(statusResult) as {
      latestApplication?: { status?: string; submittedAt?: string } | null;
      currentLicense?: unknown;
      canResubmit?: boolean;
    } | null;
    expect(statusData?.latestApplication?.status).toBe("pending");
    expect(typeof statusData?.latestApplication?.submittedAt).toBe("string");
    expect(statusData?.currentLicense ?? null).toBeNull();
    expect(statusData?.canResubmit).toBe(false);

    // DB: คำขอ pending + submitted_at · หลักฐาน ready ในบักเก็ตของงาน อัปโหลดโดยเจ้าของเอง
    const apps = await psqlRows<{
      id: string;
      status: string;
      license_no: string;
      evidence_media_id: string;
    }>(`
      select id::text, status::text, license_no, evidence_media_id::text as evidence_media_id
        from public.license_applications
       where user_id = '${learnerA?.id ?? ""}' order by submitted_at desc limit 1;
    `);
    expect(apps).toHaveLength(1);
    const application = apps[0];
    expect(application?.status).toBe("pending");
    expect(application?.license_no).toBe(LICENSE_NO_A);
    const media = await psqlRows<{ bucket: string; status: string; uploaded_by: string }>(`
      select bucket, status::text, uploaded_by::text from public.media_assets
       where id = '${application?.evidence_media_id ?? ""}';
    `);
    expect(media[0]?.bucket).toBe("license-evidence");
    expect(media[0]?.status).toBe("ready");
    expect(media[0]?.uploaded_by).toBe(learnerA?.id ?? "");

    // audit LICENSE_BIND ใน TX เดียวกับแถวคำขอ — บริบทเก็บ "license_hash" เท่านั้น (ห้ามมีเลขจริง)
    // (คอลัมน์ context รวมกับ count() ต้อง aggregate — min() ของแถวเดียวที่ n ถูก pin
    // เป็น 1 ทันทีหลังคิวรี = ค่าของแถวนั้นเอง)
    const bindAudit = await psqlRows<{ n: number; hash: string; status: string; target: string }>(`
      select count(*)::int as n,
             min(coalesce(context ->> 'license_hash', '')) as hash,
             min(coalesce(context ->> 'status', '')) as status,
             min(coalesce(context ->> 'target_user_id', '')) as target
        from public.audit_logs
       where action = 'LICENSE_BIND' and entity_type = 'license_application'
         and entity_id = '${application?.id ?? ""}';
    `);
    expect(bindAudit[0]?.n).toBe(1);
    expect(bindAudit[0]?.hash).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(bindAudit[0]?.status).toBe("pending");
    expect(bindAudit[0]?.target).toBe(learnerA?.id ?? "");
    expect(bindAudit[0]?.hash.includes(LICENSE_NO_A)).toBe(false); // ไม่มีเลขจริงใน audit

    // ยังไม่มี event แจ้งผล (event เกิดตอนตัดสินเท่านั้น)
    const events = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.event_outbox
       where topic like 'license.application.%' and payload ->> 'user_id' = '${learnerA?.id ?? ""}';
    `);
    expect(events[0]?.n).toBe(0);
  });

  test("ยื่นซ้ำขณะคำขอยัง pending → 409 ERR-VAL-001|pending_exists (ไม่สร้างแถวใหม่)", async ({
    page,
  }) => {
    expect(learnerA).toBeDefined();
    await loginViaForm(page, learnerA?.email ?? "");
    await page.goto("/my/license");
    // UI ซ่อนฟอร์มแล้ว (canResubmit=false ตาม pending ที่ค้างอยู่)
    await expect(page.getByTestId("license-no-input")).toHaveCount(0);

    // ยื่นซ้ำทาง API ตรง (ด้วยเลขต่างออกไป — พิสูจน์ว่ากันที่ "มี pending" ไม่ใช่ที่เลขซ้ำ)
    const duplicate = await putLicenseMultipart(page, "7301590");
    expect(duplicate.status).toBe(409);
    const error = errorOf(duplicate);
    expect(error.code).toBe("ERR-VAL-001");
    expect(error.details["reason"]).toBe("pending_exists");
    expect(error.message).toBe("ท่านมีคำขอที่รอตัดสินอยู่แล้ว กรุณารอผลการตรวจก่อนยื่นคำขอใหม่");

    // DB: ยังมีคำขอ pending แถวเดียว (คำขอซ้ำไม่ถูกบันทึก)
    const pending = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.license_applications
       where user_id = '${learnerA?.id ?? ""}' and status = 'pending';
    `);
    expect(pending[0]?.n).toBe(1);
  });

  test("registrar อนุมัติผ่าน UI → ใบ verified + role lawyer + audit + event + ผู้เรียนเห็นเลขใบ (BFF)", async ({
    page,
  }) => {
    expect(learnerA).toBeDefined();
    expect(registrar).toBeDefined();
    const learnerName = await displayNameOf(learnerA?.id ?? "");

    // registrar — ฟอร์มล็อกอินจริงก่อน (ให้แอปเขียน cookie) แล้ว inject session aal2 (แบบ e2e-10)
    await loginViaForm(page, registrar?.email ?? "");
    if (registrarAal2 === undefined) throw new Error("beforeAll ต้อง enroll registrar สำเร็จก่อน");
    await injectSession(page, registrarAal2);
    await page.goto("/admin/license-applications");
    await expect(page.getByRole("heading", { name: "คำขอใบอนุญาตทนายความ" })).toBeVisible();

    // แถวคำขอของผู้เรียน A — ป้าย "รอตรวจ" + ปุ่มตัดสิน
    const table = page.getByRole("table", { name: /ตารางคำขอใบอนุญาต/ });
    const row = table.getByRole("row").filter({ hasText: learnerName });
    await expect(row).toBeVisible();
    await expect(row.getByText("รอตรวจ")).toBeVisible();
    await row.getByRole("button", { name: "อนุมัติ" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`อนุมัติคำขอของ ${learnerName}`);
    // รอ PATCH ตัดสินจบก่อน reload — click() คืนทันทีที่ dispatch แล้ว page.goto
    // จะ abort fetch ที่กำลังบิน (trace เห็น response status -1) และ SSR อ่านตาราง
    // ก่อน RPC commit (~1.2s) = แถวยัง "รอตรวจ" ทั้งที่เซิร์ฟเวอร์ตอบ 200
    const decided = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        res.url().includes("/api/v1/admin/license-applications/"),
    );
    await dialog.getByRole("button", { name: "ยืนยันอนุมัติ" }).click();
    await expect((await decided).status()).toBe(200);

    // หลังตัดสิน: รายการรีเฟรช — แถวเป็น "อนุมัติแล้ว" และไม่มีปุ่มตัดสินค้าง (โหลด SSR ใหม่)
    await page.goto("/admin/license-applications");
    const rowAfter = page
      .getByRole("table", { name: /ตารางคำขอใบอนุญาต/ })
      .getByRole("row")
      .filter({ hasText: learnerName });
    await expect(rowAfter).toBeVisible();
    await expect(rowAfter.getByText("อนุมัติแล้ว")).toBeVisible();
    await expect(rowAfter.getByRole("button", { name: "อนุมัติ" })).toHaveCount(0);
    await expect(rowAfter.getByRole("button", { name: "ปฏิเสธ" })).toHaveCount(0);

    // DB: คำขอ approved (decided_by registrar) + ใบ verified + role lawyer idempotent ครั้งแรก
    const approved = await psqlRows<{
      status: string;
      decided_by: string;
      resulting_license_id: string;
    }>(`
      select status::text, decided_by::text as decided_by,
             resulting_license_id::text as resulting_license_id
        from public.license_applications where id = (
          select id from public.license_applications
           where user_id = '${learnerA?.id ?? ""}' order by submitted_at desc limit 1);
    `);
    expect(approved[0]?.status).toBe("approved");
    expect(approved[0]?.decided_by).toBe(registrar?.id ?? "");
    expect(approved[0]?.resulting_license_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const license = await psqlRows<{
      license_no: string;
      status: string;
      verified_by: string;
    }>(`
      select license_no, status::text, verified_by::text as verified_by
        from public.lawyer_licenses where user_id = '${learnerA?.id ?? ""}';
    `);
    expect(license).toHaveLength(1);
    expect(license[0]?.license_no).toBe(LICENSE_NO_A);
    expect(license[0]?.status).toBe("verified");
    expect(license[0]?.verified_by).toBe(registrar?.id ?? "");
    const lawyerRole = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.role_assignments
       where user_id = '${learnerA?.id ?? ""}' and role = 'lawyer' and revoked_at is null;
    `);
    expect(lawyerRole[0]?.n).toBe(1);

    // audit: LICENSE_VERIFY(result approved) + ROLE_GRANT(lawyer) — entity/บริบทตรงตาม 0035
    const verifyAudit = await psqlRows<{ n: number; result: string }>(`
      select count(*)::int as n, coalesce(min(context ->> 'result'), '') as result
        from public.audit_logs
       where action = 'LICENSE_VERIFY' and entity_type = 'license_application'
         and entity_id = (
           select id from public.license_applications
            where user_id = '${learnerA?.id ?? ""}' order by submitted_at desc limit 1);
    `);
    expect(verifyAudit[0]?.n).toBe(1);
    expect(verifyAudit[0]?.result).toBe("approved");
    const grantAudit = await psqlRows<{ n: number; role: string }>(`
      select count(*)::int as n, coalesce(min(context ->> 'role'), '') as role
        from public.audit_logs
       where action = 'ROLE_GRANT' and entity_type = 'user' and entity_id = '${learnerA?.id ?? ""}'
         and context ->> 'role' = 'lawyer';
    `);
    expect(grantAudit[0]?.n).toBe(1);

    // event_outbox — แจ้งผลอนุมัติ (topic + payload ตาม 0035 §5)
    const approvedEvent = await psqlRows<{ n: number; license_no: string }>(`
      select count(*)::int as n, coalesce(min(payload ->> 'license_no'), '') as license_no
        from public.event_outbox
       where topic = 'license.application.approved'
         and payload ->> 'user_id' = '${learnerA?.id ?? ""}';
    `);
    expect(approvedEvent[0]?.n).toBe(1);
    expect(approvedEvent[0]?.license_no).toBe(LICENSE_NO_A);

    // ผู้เรียนกลับมาดูสถานะ — สัญญา BFF: currentLicense.licenseNo = เลขที่ยื่น + canResubmit=false
    await loginViaForm(page, learnerA?.email ?? "");
    const afterApprove = await callJsonApi(page, "GET", "/api/v1/me/license");
    expect(afterApprove.status).toBe(200);
    const afterData = dataOf(afterApprove) as {
      latestApplication?: { status?: string } | null;
      currentLicense?: { licenseNo?: string; verifiedAt?: string } | null;
      canResubmit?: boolean;
    } | null;
    expect(afterData?.latestApplication?.status).toBe("approved");
    expect(afterData?.currentLicense?.licenseNo).toBe(LICENSE_NO_A);
    expect(typeof afterData?.currentLicense?.verifiedAt).toBe("string");
    expect(afterData?.canResubmit).toBe(false);

    // การ์ด UI — เลขใบที่ verified + ป้ายคำขอผ่านการตรวจสอบ (drift แก้แล้ว)
    await page.goto("/my/license");
    await expect(page.getByTestId("license-current-no")).toHaveText(LICENSE_NO_A);
    await expect(page.getByTestId("license-application-status")).toHaveText(
      "ผ่านการตรวจสอบ",
    );
  });

  test("ปฏิเสธ: เหตุผล <10 → 400 fields[reason] (ยังไม่แตะ DB) → โมดัล ≥10 → rejected + event + ผู้เรียนเห็นเหตุผล", async ({
    page,
  }) => {
    expect(learnerB).toBeDefined();
    expect(registrar).toBeDefined();
    const learnerNameB = await displayNameOf(learnerB?.id ?? "");

    // ผู้เรียน B ยื่นคำขอผ่านฟอร์มจริง (พิสูจน์ซ้ำว่าฟอร์มใช้ได้กับผู้ใช้อื่น)
    await loginViaForm(page, learnerB?.email ?? "");
    await page.goto("/my/license");
    await expect(page.getByTestId("license-no-input")).toBeVisible();
    await page.getByTestId("license-no-input").fill(LICENSE_NO_B);
    await page
      .getByTestId("license-file-input")
      .setInputFiles({
        name: "evidence-b.png",
        mimeType: "image/png",
        buffer: Buffer.from(PNG_1X1_BASE64, "base64"),
      });
    await page.getByTestId("license-submit").click();
    await expect(page.getByTestId("license-after-action")).toBeVisible();

    const appB = await psqlRows<{ id: string }>(`
      select id::text from public.license_applications
       where user_id = '${learnerB?.id ?? ""}' order by submitted_at desc limit 1;
    `);
    expect(appB).toHaveLength(1);

    // registrar — login ทับคุกกี้เดิม (กลับเป็น aal1) จึงต้อง inject session aal2 กลับก่อนใช้หน้า staff
    await loginViaForm(page, registrar?.email ?? "");
    if (registrarAal2 === undefined) throw new Error("beforeAll ต้อง enroll registrar สำเร็จก่อน");
    await injectSession(page, registrarAal2);
    await page.goto("/admin/license-applications");
    await expect(page.getByRole("heading", { name: "คำขอใบอนุญาตทนายความ" })).toBeVisible();

    // ประตู BFF ก่อน RPC: เหตุผล <10 → 400 ERR-VAL-001 fields=["reason"] และคำขอยัง pending
    const shortReject = await callJsonApi(page, "PATCH", `/api/v1/admin/license-applications/${appB[0]?.id ?? ""}`, {
      action: "reject",
      reason: "สั้น",
    });
    expect(shortReject.status).toBe(400);
    const shortError = errorOf(shortReject);
    expect(shortError.code).toBe("ERR-VAL-001");
    expect(shortError.details["fields"]).toEqual(["reason"]);
    const stillPending = await psqlRows<{ status: string }>(`
      select status::text from public.license_applications where id = '${appB[0]?.id ?? ""}';
    `);
    expect(stillPending[0]?.status).toBe("pending");

    // โมดัลปฏิเสธบน UI: ปุ่มยืนยันล็อกจนกว่าเหตุผล ≥10 ตัวอักษร
    const table = page.getByRole("table", { name: /ตารางคำขอใบอนุญาต/ });
    const row = table.getByRole("row").filter({ hasText: learnerNameB });
    await expect(row).toBeVisible();
    await expect(row.getByText("รอตรวจ")).toBeVisible();
    await row.getByRole("button", { name: "ปฏิเสธ" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`ปฏิเสธคำขอของ ${learnerNameB}`);
    const confirmReject = dialog.getByRole("button", { name: "ยืนยันปฏิเสธ" });
    await expect(confirmReject).toBeDisabled();
    await dialog.locator("#reject-reason").fill("สั้น");
    await expect(confirmReject).toBeDisabled();
    await dialog.locator("#reject-reason").fill(
      "เลขที่ใบอนุญาตไม่ตรงกับทะเบียนสภาทนายความ กรุณาตรวจทานและยื่นใหม่อีกครั้ง",
    );
    await expect(confirmReject).toBeEnabled();
    // แบบเดียวกับเทสอนุมัติ — รอ PATCH จบก่อน reload กัน goto abort fetch กลางทาง
    const decided = page.waitForResponse(
      (res) =>
        res.request().method() === "PATCH" &&
        res.url().includes("/api/v1/admin/license-applications/"),
    );
    await confirmReject.click();
    await expect((await decided).status()).toBe(200);

    // รายการรีเฟรช — แถวเป็น "ปฏิเสธแล้ว" + เหตุผลปรากฏในคอลัมน์
    await page.goto("/admin/license-applications");
    const rowAfter = page
      .getByRole("table", { name: /ตารางคำขอใบอนุญาต/ })
      .getByRole("row")
      .filter({ hasText: learnerNameB });
    await expect(rowAfter).toBeVisible();
    await expect(rowAfter.getByText("ปฏิเสธแล้ว")).toBeVisible();
    await expect(rowAfter).toContainText(
      "เลขที่ใบอนุญาตไม่ตรงกับทะเบียนสภาทนายความ กรุณาตรวจทานและยื่นใหม่อีกครั้ง",
    );

    // DB: rejected + rejected_reason + decided_by · audit LICENSE_VERIFY(result rejected) + event
    const rejected = await psqlRows<{ status: string; reason: string; decided_by: string }>(`
      select status::text, coalesce(rejected_reason, '') as reason, decided_by::text as decided_by
        from public.license_applications where id = '${appB[0]?.id ?? ""}';
    `);
    expect(rejected[0]?.status).toBe("rejected");
    expect(rejected[0]?.reason).toBe(
      "เลขที่ใบอนุญาตไม่ตรงกับทะเบียนสภาทนายความ กรุณาตรวจทานและยื่นใหม่อีกครั้ง",
    );
    expect(rejected[0]?.decided_by).toBe(registrar?.id ?? "");
    const verifyAudit = await psqlRows<{ n: number; result: string }>(`
      select count(*)::int as n, coalesce(min(context ->> 'result'), '') as result
        from public.audit_logs
       where action = 'LICENSE_VERIFY' and entity_type = 'license_application'
         and entity_id = '${appB[0]?.id ?? ""}';
    `);
    expect(verifyAudit[0]?.n).toBe(1);
    expect(verifyAudit[0]?.result).toBe("rejected");
    const rejectedEvent = await psqlRows<{ n: number; reason: string }>(`
      select count(*)::int as n, coalesce(min(payload ->> 'reason'), '') as reason
        from public.event_outbox
       where topic = 'license.application.rejected'
         and payload ->> 'application_id' = '${appB[0]?.id ?? ""}';
    `);
    expect(rejectedEvent[0]?.n).toBe(1);
    expect(rejectedEvent[0]?.reason).toBe(
      "เลขที่ใบอนุญาตไม่ตรงกับทะเบียนสภาทนายความ กรุณาตรวจทานและยื่นใหม่อีกครั้ง",
    );

    // ผู้เรียน B: BFF คืน rejected + เหตุผล + canResubmit=true → ฟอร์มกลับมาแสดงบน UI
    await loginViaForm(page, learnerB?.email ?? "");
    const afterReject = await callJsonApi(page, "GET", "/api/v1/me/license");
    expect(afterReject.status).toBe(200);
    const afterData = dataOf(afterReject) as {
      latestApplication?: { status?: string; rejectedReason?: string | null } | null;
      currentLicense?: unknown;
      canResubmit?: boolean;
    } | null;
    expect(afterData?.latestApplication?.status).toBe("rejected");
    expect(afterData?.latestApplication?.rejectedReason).toBe(
      "เลขที่ใบอนุญาตไม่ตรงกับทะเบียนสภาทนายความ กรุณาตรวจทานและยื่นใหม่อีกครั้ง",
    );
    expect(afterData?.currentLicense ?? null).toBeNull();
    expect(afterData?.canResubmit).toBe(true);
    await page.goto("/my/license");
    await expect(page.getByTestId("license-application-status")).toHaveText(
      "ไม่ผ่านการตรวจสอบ",
    );
    await expect(page.getByTestId("license-no-input")).toBeVisible();
  });
});

/**
 * เก็บกวาดเนมสเปซ e15 ทั้งชุด (เรียกได้ทั้งก่อนเริ่มและหลังจบ — idempotent):
 * แถว license/lawyer_licenses ของผู้ใช้ e15-% ต้องลบก่อน deleteD9User (media_assets
 * ของ deleteD9User มี not-exists guard อ้างตารางสองตารางนี้) · audit_logs คงไว้ตามดีไซน์ append-only
 */
async function cleanupE15(): Promise<void> {
  // แถวของเนมสเปซนี้ต้องเคลียร์แบบ set-based ก่อนลบ profiles — คำขอ approved ชี้
  // decided_by → registrar และใบ verified ชี้ verified_by → registrar (profiles
  // RESTRICT) ถ้าลบ profiles รายคนโดย registrar มาก่อนในลูปจะตายที่ FK ทิ้งค้าง
  await psql(`
    update public.lawyer_licenses set verified_by = null
     where verified_by in (select id from auth.users where email like 'e15-%');
    delete from public.license_applications
     where user_id in (select id from auth.users where email like 'e15-%')
        or decided_by in (select id from auth.users where email like 'e15-%');
    delete from public.lawyer_licenses
     where user_id in (select id from auth.users where email like 'e15-%');
  `);
  const users = await psqlRows<{ id: string }>(
    `select id::text from auth.users where email like 'e15-%';`,
  );
  for (const user of users) {
    await deleteD9User(user.id);
  }
}
