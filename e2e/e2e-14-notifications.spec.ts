/**
 * E2E-14 — การแจ้งเตือน NTF ฝั่ง UI (Wave E Phase 4 · NTF-001/005 · DCR-10 คู่ขนาน)
 *
 * flow (UI-contract — ผูกกับ data-testid ตามสัญญาของ lane D) — ทุกเส้นทางเดิน
 * ของจริงผ่าน BFF ทั้งหมด (gate r1 adjudication-1: เดิมมี page.route shim ทดแทน
 * GET /api/v1/me/notifications ด้วยผล RPC ตรง — คำตัดสินของประตูคือ shim ไม่นับ
 * เป็นหลักฐาน ต้องมีอย่างน้อยหนึ่ง flow ที่ BFF GET จริง; จุด drift recipient_id
 * ที่เคยบังคับใช้ shim ถูกแก้ที่ schema ของ BFF เรียบร้อย → spec นี้เป็นของจริงล้วน):
 *   1) ผู้เรียนเข้าสู่ระบบผ่านฟอร์ม /login จริง (แบบเดียวกับชุด e2e-13) — harness seed
 *      การแจ้งเตือน in_app 1 รายการตรงผ่าน psql ก่อนเริ่ม (beforeAll · id ตายตัว
 *      เนมสเปซ e14 ของ spec นี้เอง — ไม่ยืมโครง id ของชุดอื่น) → header เห็นกระดิ่ง
 *      bell-button พร้อมป้าย bell-count "1" (GET /api/v1/me/notifications จริงผ่าน
 *      BFF — RPC → schema ที่มี recipient_id ครบ) → คลิกกระดิ่ง → /my/notifications
 *      เห็น notif-item + notif-unread-badge → กด notif-read-btn ("อ่านแล้ว") →
 *      จุดแดงหาย ปุ่มอ่านแล้วหาย (คงข้อความ "อ่านแล้ว") และ bell-count หาย
 *      (กระดิ่งรีเฟรชผ่าน NOTIF_READ_CHANGED_EVENT — 0 รายการ = ซ่อนป้าย) ·
 *      ยืนยัน read_at ใน DB (ขา DB ของ harness ใช้ตรวจผล server-side คู่กับ UI เสมอ)
 *   2) /my/notification-settings — toggle settings-toggle-credit-email (role=switch
 *      aria-checked=true เริ่มต้น) → ปิด (aria-checked=false) → settings-save →
 *      ข้อความสำเร็จ role=status "บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อยแล้ว" →
 *      เปิดกลับ → บันทึก → สำเร็จอีกครั้ง (คืนสถานะ default on ตาม D-p4-4)
 *      — settings GET/PATCH ผ่าน BFF จริงเช่นกัน · ห้าม log JWT/token ใด ๆ ใน output
 */
import { expect, test } from "@playwright/test";

import { psql, psqlRows } from "./helpers/db";
import { loginViaForm } from "./helpers/session";
import { createLearnerUser, deleteLearnerUser, type LearnerUser } from "./helpers/users";

/** id การแจ้งเตือนที่ seed — เนมสเปซ e14 ของ spec นี้ (ตายตัว · cleanup หาเจอแน่นอน) */
const E2E14_NOTIF = "cccccccc-cccc-4ccc-8ccc-e14e00000001";

let learner: LearnerUser | undefined;

test.describe("E2E-14 การแจ้งเตือน (กระดิ่ง → กล่องจดหมาย → อ่านแล้ว → ตั้งค่า)", () => {
  test.beforeAll(async () => {
    // กวาดของค้างจากรอบที่พังกลางทางของ id ตายตัวตัวเอง (idempotent — รันซ้ำได้)
    await psql(`
      delete from public.notification_recipients where notification_id = '${E2E14_NOTIF}';
      delete from public.notifications where id = '${E2E14_NOTIF}';
    `);
    learner = await createLearnerUser("e2e-14-notif");
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
    // sanity ของ seed ทาง DB ตรง ๆ — แถวผู้รับ in_app 1 แถวยังไม่อ่าน (แยกปัญหา
    // "seed พัง" ออกจาก "BFF/UI พัง" ก่อนเข้า browser)
    const seeded = await psqlRows<{ n: number }>(`
      select count(*)::int as n
        from public.notification_recipients
       where notification_id = '${E2E14_NOTIF}' and user_id = '${learner.id}'
         and channel = 'in_app' and read_at is null and deleted_at is null;
    `);
    expect(seeded[0]?.n).toBe(1);
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
    // · กระดิ่งรีเฟรชผ่าน event (GET ถัดไปได้ unread_count 0 — read_at ถูกเขียนจริง)
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
