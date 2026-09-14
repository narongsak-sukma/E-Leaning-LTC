/**
 * E2E-20 — Wave G P2: หลังบ้านคลังข้อสอบ (bank detail · แก้ข้อเห็นเฉลย · status toggle)
 *
 * ขอบเขตตามแผน wave-g-p2 section 4 W3 + D78:
 * - staff:exam -> /admin/question-banks -> เปิดคลัง (detail /admin/question-banks/{id})
 *   -> แก้ข้อ (เห็นคำตอบ/isCorrect ตามสัญญา EditQuestionResource · D74) -> เปลี่ยนสถานะ
 *   draft->active->retired (RPC admin_set_question_status 0047 · D75) -> ตารางสะท้อน
 * - instructor -> admin shell ปฏิเสธที่หน้ารายละเอียด (layout.tsx:56 redirect /login —
 *   ตามแบบ e2e-12 · ADMIN_STAFF_ROLES ไม่มี instructor) — การซ่อนปุ่ม/สิทธิ์ edit ตรวจที่
 *   component/unit test ของ W2 ตาม D78 ไม่ใช่ e2e
 * - เดิน endpoint ตาม API-SPECIFICATION 1.3.0 section 3.8 (4 เส้นใหม่):
 *   GET /admin/question-banks/{id} · GET .../{id}/questions · GET .../{id}/questions/{qid}
 *   (EditQuestionResource มี isCorrect + Cache-Control: private, no-store · D74) ·
 *   PATCH .../{qid}/status ({status: active|retired} · transition matrix · version+1)
 * - UI flow จริง (gate r1 M4): เปิด EditQuestionModal จากปุ่ม "แก้ไข" ในแถว · แก้โจทย์ ·
 *   บันทึกผ่าน dialog เห็นเวอร์ชันใหม่ · เปิด StatusConfirm จากปุ่ม toggle แล้วยืนยัน
 *   การเปลี่ยนสถานะผ่าน dialog — ไม่ใช่แค่ fetch API ตรง
 * - ไม่ seed หลักสูตร UAT ซ้ำ — e2e-04 นับแคตตาล็อกผู้เยี่ยมชม = 4 ต้องคงเดิม; fixture
 *   ของ suite นี้คือ question_banks/questions/question_options เท่านั้น (แนบ course 3
 *   LTC-103 ที่ is_public=false — ไม่โผล่ในแคตตาล็อกผู้เยี่ยมชม) และล้างใน afterAll
 *
 * ธงระหว่างพัฒนา (ให้ lead ตรวจตอนรัน battery):
 * - [ปิดแล้ว lead] ป้ายสถานะไทยของข้อ sync กับ W2 จริงแล้ว — retired = "ปลดจากการใช้งาน"
 *   (ตาม QUESTION_STATUS_LABEL_TH ของ bank-detail.view.ts · ไม่ใช่ "เลิกใช้" ฉบับร่างแรก)
 * - [ปิดแล้ว lead] การแกก body: edit GET / status PATCH คืน envelope { data } (§1.1)
 *   — ฉบับร่างแรกอ่าน resource ตรง top level ทำให้ editBody.id เป็น undefined
 *   (W3 เขียนก่อน W1 เสร็จ · แกพร้อม dataOf + ปิดธงตามแผน §5)
 */
import { expect, test, type Page } from "@playwright/test";

import { psql } from "./helpers/db";
import { loginViaForm } from "./helpers/session";
import {
  createStaffRoleUser,
  deleteD9User,
  enrollMfaTotp,
  injectSession,
  type Aal2Session,
  type D9User,
} from "./d9-helpers";

// fixture ตายตัวของ suite (uuid เนมสเปซ e20 — ไม่ชน seed และไม่ชนชุด D-8/D-9)

/** คลังของ suite — แนบ course 3 (LTC-103 · is_public=false — ไม่ใช่แคตตาล็อกผู้เยี่ยมชม) */
const BANK_ID = "e20e20e0-0000-4e20-8e20-000000000001";
const BANK_NAME = "ธนาคารข้อสอบ e2e-20 (status toggle)";

/** ข้อที่เดิน draft->active->retired ตลอดเทส (เฉลย = ตัวเลือกลำดับ 1 ตามแบบ seed D-8) */
const Q1_ID = "e20e20e0-0000-4e20-8e20-0000000000d1";
const Q1_TEXT = "E20 ข้อ 1: การแก้ไขข้อสอบผ่านหลังบ้าน เปลี่ยนสถานะได้ถูกต้องหรือไม่";
/** ตัวเลือกของ Q1 — id ตายตัว (เฉลยคือ id แรก) */
const Q1_OPTION_CORRECT = "f2f2f2f2-f2f2-4f2f-8f2f-000000000101";
const Q1_OPTION_WRONG_A = "f2f2f2f2-f2f2-4f2f-8f2f-000000000102";

/** ข้อคงสถานะ draft — ให้ตารางมีแถวอื่นและเทียบแถวต่อแถวได้ (ใช้เดิน UI flow ของ M4 ตอนท้าย) */
const Q2_ID = "e20e20e0-0000-4e20-8e20-0000000000d2";
const Q2_TEXT = "E20 ข้อ 2: ข้อนี้คงสถานะร่างตลอดเทส";
/** ข้อความโจทย์หลังแก้ผ่าน EditQuestionModal จริง (M4) — ตารางต้องสะท้อนข้อความนี้ */
const Q2_TEXT_EDITED = "E20 ข้อ 2 (แก้ผ่านหน้าจอแล้ว): ฟอร์มแก้ไขบันทึกได้จริง";

/** ป้ายสถานะไทยของข้อสอบ — sync กับ QUESTION_STATUS_LABEL_TH ของ W2 จริง
 *  (bank-detail.view.ts: draft=ร่าง · active=ใช้งาน · retired=ปลดจากการใช้งาน) */
const QUESTION_STATUS_THAI = { draft: "ร่าง", active: "ใช้งาน", retired: "ปลดจากการใช้งาน" } as const;

/** path ของหน้ารายละเอียดคลัง (UI ของ W2 — แผน section 4 W2) */
function bankDetailPath(bankId: string): string {
  return `/admin/question-banks/${bankId}`;
}

/** path ของ endpoint รายการข้อ (API-SPEC 1.3.0) */
function questionsListPath(bankId: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions`;
}

/** path ของ edit GET (คืนเฉลย — D74) */
function editQuestionPath(bankId: string, qid: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions/${qid}`;
}

/** path ของ status PATCH (RPC admin_set_question_status — D75) */
function statusPath(bankId: string, qid: string): string {
  return `/api/v1/admin/question-banks/${bankId}/questions/${qid}/status`;
}

/** ผล fetch same-origin พร้อมหัว Cache-Control (สัญญา D74 — edit GET ต้อง private, no-store) */
interface JsonCallResult {
  readonly status: number;
  readonly bodyText: string;
  readonly cacheControl: string | null;
}

/**
 * fetch same-origin จากหน้า (GET/PATCH) — ตามแบบ callJsonApi ของ e2e-16 แต่คืน
 * cache-control ด้วย (D74) · Origin ของ browser ผ่าน CSRF ของ middleware จริง
 */
async function fetchJson(
  page: Page,
  method: "GET" | "PATCH",
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
      return {
        status: response.status,
        bodyText: (await response.text()).slice(0, 2000),
        cacheControl: response.headers.get("cache-control"),
      };
    },
    { method, path, body },
  );
}

/** body JSON จากผล fetch (text ตัดที่ 2000 ตัวอักษร — พอสำหรับ fixture ขนาดนี้) */
function jsonOf<T>(result: { bodyText: string }): T {
  return JSON.parse(result.bodyText) as T;
}

/**
 * แกก { data } ของ envelope §1.1 — edit GET / status PATCH คืน { data: resource }
 * (W1 as-built เดียวกับ integration wave-g ที่ assert ผ่าน body.data.id) ·
 * สองเส้นนี้เป็น resource เดี่ยวเสมอ (ไม่มีรูป array ตรง)
 */
function dataOf<T>(result: { bodyText: string }): T {
  const parsed = JSON.parse(result.bodyText) as { data?: T } | null;
  if (parsed === null || typeof parsed !== "object" || !("data" in parsed)) {
    throw new Error(`คาด envelope { data } แต่ได้: ${result.bodyText.slice(0, 200)}`);
  }
  return parsed.data as T;
}

/** ล้าง fixture ของ suite (เรียงตาม FK: options -> questions -> bank) — รันซ้ำได้ */
async function cleanupQuestionBankFixture(): Promise<void> {
  await psql(`
    delete from public.question_options
     where question_id in (select id from public.questions where bank_id = '${BANK_ID}');
    delete from public.questions where bank_id = '${BANK_ID}';
    delete from public.question_banks where id = '${BANK_ID}';
  `);
}

/**
 * seed คลัง + ข้อ 2 ข้อ + ตัวเลือก — status ข้อเป็น draft ทั้งคู่ (ไม่แตะ trigger
 * guard_question_activation) · Q2 มีตัวเลือกด้วยเพราะ M4 เดิน draft→active ผ่าน
 * dialog จริง — 0047 pre-check ปฏิเสธข้อไร้ตัวเลือก (question_needs_options)
 * created_by = ผู้ใช้ staff:exam ของ suite (runtime id)
 */
async function seedQuestionBankFixture(createdBy: string): Promise<void> {
  await psql(`
    insert into public.question_banks
      (id, code, name, created_by, course_id, description, is_active) values
      ('${BANK_ID}', 'QB-E20', '${BANK_NAME}', '${createdBy}',
       '44444444-4444-4444-8444-000000000003', 'fixture ของ e2e-20 (สถานะ/เฉลย)', true)
    on conflict (id) do nothing;
  `);
  await psql(`
    insert into public.questions
      (id, bank_id, type, difficulty, question_text, explanation, points, status, tags, created_by, version)
    values
      ('${Q1_ID}', '${BANK_ID}', 'single_choice', 'easy', '${Q1_TEXT}',
       'คำอธิบายของ e2e-20', 1, 'draft', array['e2e20'], '${createdBy}', 1),
      ('${Q2_ID}', '${BANK_ID}', 'single_choice', 'easy', '${Q2_TEXT}',
       'คำอธิบายของ e2e-20', 1, 'draft', array['e2e20'], '${createdBy}', 1);
  `);
  await psql(`
    insert into public.question_options (id, question_id, option_text, is_correct, sort_order)
    values
      ('${Q1_OPTION_CORRECT}', '${Q1_ID}', 'ตัวเลือกถูกของ E20 ข้อ 1', true, 1),
      ('${Q1_OPTION_WRONG_A}', '${Q1_ID}', 'ตัวเลือกผิด ก ของ E20 ข้อ 1', false, 2),
      ('f2f2f2f2-f2f2-4f2f-8f2f-000000000103', '${Q1_ID}', 'ตัวเลือกผิด ข ของ E20 ข้อ 1', false, 3),
      ('f2f2f2f2-f2f2-4f2f-8f2f-000000000104', '${Q1_ID}', 'ตัวเลือกผิด ค ของ E20 ข้อ 1', false, 4),
      ('f2f2f2f2-f2f2-4f2f-8f2f-000000000201', '${Q2_ID}', 'ตัวเลือกถูกของ E20 ข้อ 2', true, 1),
      ('f2f2f2f2-f2f2-4f2f-8f2f-000000000202', '${Q2_ID}', 'ตัวเลือกผิดของ E20 ข้อ 2', false, 2);
  `);
}

test.describe("e2e-20 — คลังข้อสอบฝั่ง admin (staff:exam) + instructor โดนปฏิเสธที่ shell (D78)", () => {
  let staffExam: D9User;
  let staffAal2: Aal2Session;
  let instructor: D9User;

  test.beforeAll(async () => {
    await cleanupQuestionBankFixture(); // เคลียร์เศษจากรอบก่อน (idempotent)
    staffExam = await createStaffRoleUser("e20-se", "staff:exam");
    instructor = await createStaffRoleUser("e20-ins", "instructor");
    staffAal2 = await enrollMfaTotp(staffExam.email);
    await seedQuestionBankFixture(staffExam.id);
  });

  test.afterAll(async () => {
    await cleanupQuestionBankFixture();
    await deleteD9User(staffExam.id);
    await deleteD9User(instructor.id);
  });

  test("staff:exam — เปิดคลังจากรายการ → เห็นเฉลยของข้อ (edit GET · D74) → เปลี่ยนสถานะ draft→active→retired → ตารางสะท้อน → เดิน UI จริง (แก้ไข+บันทึก · ยืนยันเปลี่ยนสถานะผ่าน dialog · M4)", async ({ page }) => {
    test.setTimeout(180_000);
    await loginViaForm(page, staffExam.email, { totpSecret: staffAal2.totpSecret });
    await injectSession(page, staffAal2);

    // รายการคลัง → เปิดคลังของ suite จากลิงก์ในตาราง
    await page.goto("/admin/question-banks");
    await expect(page.getByRole("heading", { name: "คลังข้อสอบ" })).toBeVisible();
    const bankLink = page.locator(`a[href*="${BANK_ID}"]`).first();
    await expect(bankLink).toBeVisible();
    await bankLink.click();
    await expect(page).toHaveURL(new RegExp(BANK_ID));
    await expect(page.getByText(BANK_NAME)).toBeVisible();
    // D77 — คำใบ้สถานะตายตัวตามแผน (ข้อความไทยครบทั้งประโยค)
    await expect(
      page.getByText(/ปิดคลังไม่ได้ตัดข้อออกจากการสุ่ม\s*ข้อสถานะใช้งานยังอาจถูกเลือกตามเกณฑ์การสอบ/),
    ).toBeVisible();

    // ตารางข้อ — Q1 เริ่มที่ "ร่าง"
    const rowQ1 = page.locator("tr", { hasText: Q1_TEXT });
    await expect(rowQ1).toBeVisible();
    await expect(rowQ1).toContainText(QUESTION_STATUS_THAI.draft);

    // edit GET (D74) — 200 + Cache-Control: private, no-store + เฉลย isCorrect ครบ
    const edit = await fetchJson(page, "GET", editQuestionPath(BANK_ID, Q1_ID));
    expect(edit.status).toBe(200);
    expect(edit.cacheControl).toContain("no-store");
    const editBody = dataOf<{
      id: string;
      status: string;
      options: ReadonlyArray<{ id: string; isCorrect: boolean }>;
    }>(edit);
    expect(editBody.id).toBe(Q1_ID);
    expect(editBody.status).toBe("draft");
    expect(editBody.options.find((o) => o.id === Q1_OPTION_CORRECT)?.isCorrect).toBe(true);
    expect(editBody.options.find((o) => o.id === Q1_OPTION_WRONG_A)?.isCorrect).toBe(false);

    // list GET — ไม่มีเฉลยในรายการ (D74: list ไม่มี isCorrect)
    const list = await fetchJson(page, "GET", questionsListPath(BANK_ID));
    expect(list.status).toBe(200);
    expect(list.bodyText).not.toContain("isCorrect");

    // PATCH draft → active (D75 — RPC admin_set_question_status · version +1)
    const toActive = await fetchJson(page, "PATCH", statusPath(BANK_ID, Q1_ID), { status: "active" });
    expect(toActive.status).toBe(200);
    const activeBody = dataOf<{ status: string; version: number }>(toActive);
    expect(activeBody.status).toBe("active");
    expect(activeBody.version).toBe(2);

    // ตารางสะท้อนสถานะใหม่หลังโหลดซ้ำ (RSC อ่านสด no-store)
    await page.reload();
    await expect(page.locator("tr", { hasText: Q1_TEXT })).toContainText(QUESTION_STATUS_THAI.active);

    // PATCH active → retired
    const toRetired = await fetchJson(page, "PATCH", statusPath(BANK_ID, Q1_ID), { status: "retired" });
    expect(toRetired.status).toBe(200);
    const retiredBody = dataOf<{ status: string; version: number }>(toRetired);
    expect(retiredBody.status).toBe("retired");
    expect(retiredBody.version).toBe(3);

    // transition matrix (D75) — retired → retired (same-status) = 400 ERR-VAL-001
    const same = await fetchJson(page, "PATCH", statusPath(BANK_ID, Q1_ID), { status: "retired" });
    expect(same.status).toBe(400);
    expect(same.bodyText).toContain("ERR-VAL-001");
    expect(same.bodyText).toContain("question_status_transition");

    // ตารางสะท้อนหลังสุดท้าย — Q1 "ปลดจากการใช้งาน" (ไม่ใช่ "ร่าง") · Q2 ยัง "ร่าง"
    await page.reload();
    const rowQ1Last = page.locator("tr", { hasText: Q1_TEXT });
    await expect(rowQ1Last).toContainText(QUESTION_STATUS_THAI.retired);
    await expect(rowQ1Last).not.toContainText(QUESTION_STATUS_THAI.draft);
    await expect(page.locator("tr", { hasText: Q2_TEXT })).toContainText(QUESTION_STATUS_THAI.draft);

    // list API สะท้อนสถานะจริงของสองข้อ (retired/draft) — รองรับทั้ง envelope {data} และ array ตรง
    const list2 = await fetchJson(page, "GET", questionsListPath(BANK_ID));
    expect(list2.status).toBe(200);
    const parsed = jsonOf<{ data?: Array<{ id: string; status: string }> } | Array<{ id: string; status: string }>>(list2);
    const items = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    const q1 = items.find((q) => q.id === Q1_ID);
    const q2 = items.find((q) => q.id === Q2_ID);
    expect(q1?.status).toBe("retired");
    expect(q2?.status).toBe("draft");

    // ─── M4 (gate r1): เดิน UI จริง — ไม่ใช่แค่ fetch API ─────────────────────
    // Q2 (draft) — เปิด EditQuestionModal จากปุ่ม "แก้ไข" ในแถว · แก้โจทย์ · บันทึก ·
    // เห็นข้อความสำเร็จพร้อมเวอร์ชันใหม่ (PATCH จริง — version 2)
    const rowQ2 = page.locator("tr", { hasText: Q2_TEXT });
    await rowQ2.getByRole("button", { name: "แก้ไข" }).click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByRole("heading", { name: "แก้ไขข้อสอบ" })).toBeVisible();
    const questionField = editDialog.getByLabel("โจทย์");
    await expect(questionField).toHaveValue(Q2_TEXT);
    await questionField.fill(Q2_TEXT_EDITED);
    await editDialog.getByRole("button", { name: "บันทึกการแก้ไข" }).click();
    await expect(
      editDialog.getByText(/บันทึกการแก้ไขเรียบร้อยแล้ว — ข้อสอบเวอร์ชัน 2/),
    ).toBeVisible();
    // phase saved: ปุ่มทั้งสองข้างกล่องชื่อ "ปิด" — ปิดด้วย Esc (cancel ไม่ถูกล็อกตอน saved)
    await page.keyboard.press("Escape");
    await expect(editDialog).toBeHidden();
    await page.reload();
    await expect(page.locator("tr", { hasText: Q2_TEXT_EDITED })).toBeVisible();

    // M4 ต่อ — StatusConfirm ผ่าน dialog จริง: Q2 ยัง draft → ปุ่ม "เปิดใช้งาน" →
    // ข้อความยืนยัน from→to ตาม D77 → ยืนยัน → สำเร็จ → ตารางสะท้อน "ใช้งาน"
    const rowQ2Edited = page.locator("tr", { hasText: Q2_TEXT_EDITED });
    await rowQ2Edited.getByRole("button", { name: "เปิดใช้งาน" }).click();
    const statusDialog = page.getByRole("dialog");
    // ใช้ heading role — getByText สตริงจะจับ h2 และ description (มีข้อความนี้เป็นส่วนหนึ่ง) พร้อมกัน
    await expect(statusDialog.getByRole("heading", { name: "เปลี่ยนสถานะข้อสอบ" })).toBeVisible();
    await expect(
      statusDialog.getByText(/เปลี่ยนสถานะข้อสอบจาก "ร่าง" เป็น "ใช้งาน"/),
    ).toBeVisible();
    await statusDialog.getByRole("button", { name: "ยืนยันเปลี่ยนสถานะ" }).click();
    await expect(
      statusDialog.getByText('เปลี่ยนสถานะข้อสอบเป็น "ใช้งาน" เรียบร้อยแล้ว'),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator("tr", { hasText: Q2_TEXT_EDITED })).toContainText(
      QUESTION_STATUS_THAI.active,
    );
  });

  test("instructor เข้าหน้า admin คลัง → shell ปฏิเสธ พาไป /login (D78 · แบบ e2e-12 — redirect ที่ layout ไม่ใช่ปุ่ม)", async ({ page }) => {
    test.setTimeout(90_000);
    const insAal2 = await enrollMfaTotp(instructor.email);
    await loginViaForm(page, instructor.email, { totpSecret: insAal2.totpSecret });
    await injectSession(page, insAal2);

    // ADMIN_STAFF_ROLES ไม่มี instructor → (admin)/admin/layout.tsx redirect /login
    // ก่อนถึงหน้าคลัง (ขึ้นกับหน้า [id] ของ W2 ถูก merge แล้ว — lead รันหลัง merge ครบ)
    await page.goto(bankDetailPath(BANK_ID));
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toContain("/login");
  });
});
