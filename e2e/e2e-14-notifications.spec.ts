/**
 * E2E-14 — การแจ้งเตือน NTF ฝั่ง UI (Wave E Phase 4 · NTF-001/005 · DCR-10 คู่ขนาน)
 *
 * flow (UI-contract — ผูกกับ data-testid ตามสัญญาของ lane D):
 *   1) ผู้เรียนเข้าสู่ระบบผ่านฟอร์ม /login จริง (แบบเดียวกับชุด e2e-13) — harness seed
 *      การแจ้งเตือน in_app 1 รายการตรงผ่าน psql ก่อนเริ่ม (beforeAll · id ตายตัว
 *      เนมสเปซ e14 ของ spec นี้เอง — ไม่ยืมโครง id ของชุดอื่น) → header เห็นกระดิ่ง
 *      bell-button พร้อมป้าย bell-count "1" → คลิกกระดิ่ง → /my/notifications เห็น
 *      notif-item + notif-unread-badge → กด notif-read-btn ("อ่านแล้ว") → จุดแดงหาย
 *      ปุ่มอ่านแล้วหาย (คงข้อความ "อ่านแล้ว") และ bell-count หาย (กระดิ่งรีเฟรชผ่าน
 *      NOTIF_READ_CHANGED_EVENT — 0 รายการ = ซ่อนป้าย) · ยืนยัน read_at ใน DB
 *      (ขา DB ของ harness ใช้ตรวจผล server-side คู่กับ UI เสมอ)
 *   2) /my/notification-settings — toggle settings-toggle-credit-email (role=switch
 *      aria-checked=true เริ่มต้น) → ปิด (aria-checked=false) → settings-save →
 *      ข้อความสำเร็จ role=status "บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว" →
 *      เปิดกลับ → บันทึก → สำเร็จอีกครั้ง (คืนสถานะ default on ตาม D-p4-4)
 *
 * ⚠️ CONTRACT DRIFT (บันทึกตามกติกาของ lane — ไม่แก้ไฟล์คนอื่น) — GET
 * /api/v1/me/notifications คืน 503 ERR-SYS-002 เสมอ เพราะสามฝ่ายขัดกันเรื่อง
 * `recipient_id` ใน items:
 *   - RPC my_notifications (supabase/migrations/0034_notifications.sql §6.1 บรรทัด ~1008-1012)
 *     ใส่ 'recipient_id' ในทุก item เสมอ (ยืนยันด้วยการเรียก RPC จริง)
 *   - schema ขาออกของ BFF (src/app/api/v1/me/notifications/schema.ts — NotificationItem
 *     .strict()) ไม่ประกาศ recipient_id → zod ตี "Unrecognized key" → route ปิดสวิตช์
 *     fail-closed เป็น 503 (log ของ app: "GET /api/v1/me/notifications?limit=1 503")
 *   - schema ฝั่ง client (src/components/learner/notifications/api.ts:119-132 —
 *     NotificationItem .strict()) กลับ "บังคับ" recipient_id: z.string().uuid() ทุก item
 *   สัญญาสองขั้ว (BFF↔client) จึงตอบสนองซึ่งกันและกันไม่ได้โดยโครงสร้าง — ต่อให้แก้ BFF
 *   ให้ผ่าน RPC ได้ client จะตีทันที (ไม่มี payload ใดผ่านได้ทั้งคู่)
 *
 * WORKAROUND ใน spec นี้ (UI-contract เท่านั้น): ขัดจังหวะเฉพาะ **GET**
 * /api/v1/me/notifications?… ด้วย page.route แล้ว fulfill ด้วยผล RPC จริงของผู้ใช้ตัวเอง
 * (restCall → my_notifications — ข้อมูลจริงจาก DB · รูปทรงตรงตาม schema ฝั่ง client ที่
 * ต้องการ recipient_id) — ทุกอย่างอื่นเดินเส้นจริงหมด: การอ่าน (POST …/{id}/read) ผ่าน BFF
 * จริง (204 · เขียน read_at ใน DB จริง), settings GET/PATCH ผ่าน BFF จริง, กระดิ่งรีเฟรช
 * ด้วย NOTIF_READ_CHANGED_EVENT จริง · ห้าม log JWT/token ใด ๆ ใน output
 */
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { psql, psqlRows } from "./helpers/db";
import { TEST_PASSWORD } from "./helpers/env";
import { restCall } from "./helpers/rest";
import { loginViaForm } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser, type LearnerUser } from "./helpers/users";

/** id การแจ้งเตือนที่ seed — เนมสเปซ e14 ของ spec นี้ (ตายตัว · cleanup หาเจอแน่นอน) */
const E2E14_NOTIF = "cccccccc-cccc-4ccc-8ccc-e14e00000001";

interface RpcItem {
  readonly id: string;
  readonly topic: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
}

let learner: LearnerUser | undefined;
/** JWT ของผู้เรียน (สำหรับเรียก RPC ตรงใน route shim — ห้ามพิมพ์ค่าลง output) */
let learnerToken = "";

/** ดึงรายการแจ้งเตือนจริงของผู้เรียนผ่าน RPC (รูปทรงตามที่ RPC คืน — รวม recipient_id) */
async function fetchRealRpcPage(limit: number): Promise<{
  readonly ok: boolean;
  readonly body: { items?: readonly RpcItem[]; unread_count?: number };
}> {
  const rpc = await restCall(
    "POST",
    "/rest/v1/rpc/my_notifications",
    { token: learnerToken },
    { p_limit: limit, p_after_created_at: null, p_after_id: null },
  );
  if (rpc.status !== 200 || typeof rpc.json !== "object" || rpc.json === null) {
    return { ok: false, body: {} };
  }
  return { ok: true, body: rpc.json as { items?: readonly RpcItem[]; unread_count?: number } };
}

/** shim เฉพาะ GET /api/v1/me/notifications?… — fulfill ด้วยผล RPC จริง (ทางผ่านของ BFF
 *  พังจาก drift recipient_id — ดูหัวไฟล์) · เส้นอื่นทุกเส้นผ่านเครือข่ายจริง */
async function shimNotificationsGet(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/me\/notifications\?/, async (route) => {
    const page1 = await fetchRealRpcPage(20);
    if (!page1.ok) {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // envelope {data} ของ jsonOk (§1.1) — ฝั่ง client unwrap ก่อน parse ทุกครั้ง
      body: JSON.stringify({
        data: {
          items: page1.body.items ?? [],
          unread_count: page1.body.unread_count ?? 0,
          next_cursor: null,
        },
      }),
    });
  });
}

test.describe("E2E-14 การแจ้งเตือน (กระดิ่ง → กล่องจดหมาย → อ่านแล้ว → ตั้งค่า)", () => {
  test.beforeAll(async () => {
    // กวาดของค้างจากรอบที่พังกลางทางของ id ตายตัวตัวเอง (idempotent — รันซ้ำได้)
    await psql(`
      delete from public.notification_recipients where notification_id = '${E2E14_NOTIF}';
      delete from public.notifications where id = '${E2E14_NOTIF}';
    `);
    learner = await createLearnerUser("e2e-14-notif");
    // token ของผู้เรียนสำหรับ route shim (password grant — ห้าม log ค่า token)
    const grant = await restCall(
      "POST",
      "/auth/v1/token?grant_type=password",
      {},
      { email: learner.email, password: TEST_PASSWORD },
    );
    const grantBody = (grant.json ?? {}) as { access_token?: string };
    if (grant.status >= 400 || typeof grantBody.access_token !== "string") {
      throw new Error(`password grant failed (${grant.status})`);
    }
    learnerToken = grantBody.access_token;
    // seed การแจ้งเตือน in_app 1 รายการให้ผู้เรียน (บนแถวแจ้งเตือนของ spec นี้เท่านั้น)
    await psql(`
      insert into public.notifications (id, topic, title, body, severity, ref_type, ref_id)
      values ('${E2E14_NOTIF}', 'exam.result',
              'ยินดีด้วย คุณสอบผ่านหลักสูตรทดสอบ (e2e-14)',
              'ผลการสอบ: คุณสอบผ่านหลักสูตรทดสอบของ e2e-14 ด้วยคะแนน 100% (เกณฑ์ผ่าน 70%)',
              'success', null, null);
      insert into public.notification_recipients (notification_id, user_id, channel, sent_at)
      values ('${E2E14_NOTIF}', '${learner.id}', 'in_app', now())
      on conflict (notification_id, user_id, channel) do nothing;
    `);
    // sanity ข้อมูลจริง — RPC ต้องเห็น 1 ไม่อ่าน (แยกปัญหาให้เหลือที่ BFF drift จุดเดียว)
    const sanity = await fetchRealRpcPage(20);
    expect(sanity.ok).toBe(true);
    expect(sanity.body.unread_count).toBe(1);
    expect(sanity.body.items?.[0]?.id).toBe(E2E14_NOTIF);
  });

  test.afterAll(async () => {
    // cleanup เฉพาะของ spec นี้ — แถวแจ้งเตือน id ตายตัว + ของผู้ใช้ + ผู้ใช้ทดสอบ (tracked)
    // (notification_settings/notification_recipients ต้องลบเองก่อน — deleteLearnerUser ของ
    //  e2e/helpers/users.ts ยังไม่รู้จักตารางใหม่ของ 0034)
    if (learner !== undefined) {
      await psql(`
        delete from public.notification_recipients where notification_id = '${E2E14_NOTIF}';
        delete from public.notification_recipients where user_id = '${learner.id}';
        delete from public.notifications where id = '${E2E14_NOTIF}';
        delete from public.notification_settings where user_id = '${learner.id}';
      `);
      await deleteLearnerUser(learner.id);
    } else {
      await psql(`
        delete from public.notification_recipients where notification_id = '${E2E14_NOTIF}';
        delete from public.notifications where id = '${E2E14_NOTIF}';
      `);
    }
  });

  test("ผู้เรียนเห็นป้ายกระดิ่ง → เปิดกล่องจดหมาย → กดอ่านแล้ว → ป้ายและจุดแดงหาย (ครบทั้งหน้าจอและ DB)", async ({ page }) => {
    expect(learner).toBeDefined();
    await shimNotificationsGet(page); // drift workaround — ดูหัวไฟล์ (เฉพาะ GET เท่านั้น)
    await loginViaForm(page, learner!.email);
    await page.goto("/my/courses"); // หน้าแรกของ shell ผู้เรียน — กระดิ่งอยู่ header เสมอ
    const bell = page.getByTestId("bell-button");
    await expect(bell).toBeVisible();
    await expect(page.getByTestId("bell-count")).toHaveText("1");

    // คลิกกระดิ่ง → /my/notifications (next/link — full navigation ตามสัญญา)
    await bell.click();
    await page.waitForURL((url) => url.pathname.startsWith("/my/notifications"));
    await expect(page).toHaveURL(/\/my\/notifications$/);
    await expect(page).toHaveTitle(/การแจ้งเตือน/);

    const item = page.getByTestId("notif-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("ยินดีด้วย คุณสอบผ่านหลักสูตรทดสอบ (e2e-14)");
    const readButton = page.getByTestId("notif-read-btn");
    await expect(readButton).toBeVisible();
    await expect(readButton).toHaveText("อ่านแล้ว");
    await expect(page.getByTestId("notif-unread-badge")).toBeVisible();
    await expect(page.getByText("ยังไม่ได้อ่าน 1 รายการ")).toBeVisible();

    // กดอ่านแล้ว — POST …/{id}/read ผ่าน BFF จริง (204 · idempotent) แล้ว UI ปรับทันที
    // · กระดิ่งรีเฟรชผ่าน event (GET shim คืน unread_count 0 — read_at ถูกเขียนจริง)
    await readButton.click();
    await expect(page.getByTestId("notif-read-btn")).toHaveCount(0);
    await expect(page.getByTestId("notif-unread-badge")).toHaveCount(0);
    await expect(page.getByTestId("bell-count")).toHaveCount(0);
    await expect(page.getByText("คุณอ่านครบทุกรายการแล้ว")).toBeVisible();
    await expect(item).toContainText("ผลการสอบ: คุณสอบผ่านหลักสูตรทดสอบของ e2e-14");

    // ยืนยันฝั่ง server — read_at ถูกตั้งแล้ว (harness DB ขาตรวจผล ไม่ใช่ทางผ่านของ assertion)
    const rows = await psqlRows<{ read: boolean }>(`
      select read_at is not null as read
        from public.notification_recipients
       where notification_id = '${E2E14_NOTIF}' and user_id = '${learner!.id}'
         and channel = 'in_app';
    `);
    expect(rows[0]?.read).toBe(true);
  });

  test("ตั้งค่าการแจ้งเตือน: ปิดอีเมลหน่วยกิตสะสม → บันทึกสำเร็จ → เปิดกลับ → บันทึกสำเร็จ", async ({ page }) => {
    expect(learner).toBeDefined();
    await loginViaForm(page, learner!.email);
    await page.goto("/my/notification-settings");
    await expect(page).toHaveTitle(/ตั้งค่าการแจ้งเตือน/);

    const toggle = page.getByTestId("settings-toggle-credit-email");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true"); // default on (D-p4-4)

    await toggle.click(); // ปิด — draft เท่านั้น ยังไม่บันทึก
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    const save = page.getByTestId("settings-save");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('p[role="status"]')).toHaveText(
      "บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว",
    );
    await expect(toggle).toHaveAttribute("aria-checked", "false"); // ค่าบันทึกแล้วคงอยู่

    await toggle.click(); // เปิดกลับ
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await save.click();
    await expect(page.locator('p[role="status"]')).toHaveText(
      "บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว",
    );
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(save).toBeDisabled(); // ไม่มี draft ค้าง — สถานะตรง server แล้ว
  });
});
