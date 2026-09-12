/**
 * E2E-16 — ผิวหลังบ้าน (lane C · ADM-001..005 · Wave E Phase 5)
 *
 * ครอบคลุม (ทุกเส้นทางเดินของจริงผ่าน BFF/DB/UI):
 *   1) super_admin: หน้า /admin/users (as-built) + ค้นหาผู้ใช้ผ่าน BFF (GET /admin/users —
 *      pin รูปร่างแถวขาออกให้ตายตัว) + สร้างบัญชีเจ้าหน้าที่ (POST /admin/users → 201 +
 *      DB role_assignments staff:viewer + audit ROLE_GRANT — ห้าม assert USER_* audit
 *      ตามธง best-effort) + role super_admin ใน body → 400 ERR-VAL-001 fields["role"]
 *   2) ปิด/เปิดใช้งานบัญชี (PATCH /admin/users/{id} {is_active, reason} → 200) — DB:
 *      auth.users.banned_until + profiles.is_active ตามจริงทั้งสองทิศ
 *   3) บทบาท: มอบ instructor (201 granted=true → ซ้ำ granted=false — idempotent) + ถอน
 *      (DELETE พร้อม body {role, reason} → 204) + audit ROLE_GRANT/ROLE_REVOKE
 *   4) SoD: staff:registrar มอบ staff:content → 403 ERR-RBAC-001 ที่ประตู BFF (ก่อน RPC)
 *   5) dashboard: registrar เปิด /admin/dashboard (UI) + GET (200 · KPI ครบ) + from>to → 400
 *   6) audit: registrar → 403 (UI แผง "ไม่มีสิทธิ์เข้าถึงข้อมูลส่วนนี้") · super_admin → 200
 *      + ทุกการอ่านเกื้อ audit AUDIT_READ (ตรวจ DB) + แถว AUDIT_READ ปรากฏบนตาราง UI
 *   7) หลักสูตร: return ไม่มี comment → 400 fields["comment"] → publish จาก pending_review
 *      → 200 published + audit COURSE_PUBLISH → unpublish → draft + audit COURSE_UNPUBLISH
 *      → publish จาก draft → 400 invalid_transition (RPC) — คืนสถานะ published ใน afterAll
 *
 * Drift ที่ธงไว้ — lead แก้แล้วใน commit เดียวกับ spec นี้ (align lane F UI ตามสัญญา
 * API-SPEC 1.2.3 §3.7):
 *   · data.ts parseAdminUserRow ตรง AdminUserResource ของ route แล้ว (deletedAt/
 *     hasVerifiedLicense แทน status/disabledReason · wire key query= แทน q= · enum
 *     active/deleted) → หน้า /admin/users แสดงตารางจริง — spec จึง assert ตาราง +
 *     แถวผู้ใช้ seed + badge สถานะ แทนแผง fail-closed แบบ as-built เดิม
 *   · UserActions bodies ตรง route แล้ว ({is_active, reason} · DELETE มี body {role,
 *     reason}) — spec ยังเดินสัญญา route ผ่าน fetch ในหน้าเพื่อ pin envelope ละเอียด
 *     (ปุ่ม UI ฝั่ง client ถูกคุมโดย unit test ของ UserActions)
 */
import { expect, test, type Page } from "@playwright/test";

import {
  COURSE3_ID,
  createStaffRoleUser,
  deleteD9User,
  enrollMfaTotp,
  injectSession,
  type Aal2Session,
  type D9User,
} from "./d9-helpers";
import { psql, psqlRows } from "./helpers/db";
import { browserApi, loginViaForm } from "./helpers/session";
import { createLearnerUser, type LearnerUser } from "./helpers/users";

/** เหตุผลสำหรับ BFF body ที่ต้องยาว 10-500 อักขระ (fixture — ไม่มีข้อมูลจริง) */
const REASON = "e2e-16 ทดสอบสิทธิ์หลังบ้านตามขอบเขตบทบาท (Wave E Phase 5)";

/** ผล JSON API แบบสั้น (body ตัด 4000 ตัวอักษร — พอสำหรับ resource เช่น audit 5 แถว
 *  และไม่มี token/PII — ตัดเพื่อกัน error-context บวมเวลา assert พัง) */
interface JsonCallResult {
  readonly status: number;
  readonly body: string;
}

/** JSON ทุก method จากหน้า — คุกกี้ session จริงของหน้า (browserApi ตัด text ที่ 500
 *  ตัวอักษร พอ envelope error แต่ไม่พอ resource ที่ dataOf ต้อง parse ทั้ง —
 *  sliceTo ปรับได้ต่อ call สำหรับ resource 200 ที่ยาวกว่า เช่น แถว audit) */
async function callJsonApi(
  page: Page,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  sliceTo = 600,
): Promise<JsonCallResult> {
  return page.evaluate(
    async ({ method, path, body, sliceTo }) => {
      const headers: Record<string, string> = { accept: "application/json" };
      const init: RequestInit & { body?: string } = { method, headers, credentials: "same-origin" };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(path, init);
      return { status: response.status, body: (await response.text()).slice(0, sliceTo) };
    },
    { method, path, body, sliceTo },
  );
}

/** envelope §1.3 → {error:{code, message, details}} — ใช้ assert code/fields ของ error */
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

/** ผู้ใช้ fixture ของ spec นี้ — staff ใช้ D9User (มี roles) · ผู้เรียนใช้ LearnerUser (spec ไม่อ่าน roles) */
let superAdmin: D9User | undefined;
let registrar: D9User | undefined;
let target: LearnerUser | undefined;
/** session aal2 ของ staff ทั้งสอง — สร้าง "ครั้งเดียวต่อรัน" ใน beforeAll (เหตุผลที่นั่น) */
let saAal2: Aal2Session | undefined;
let regAal2: Aal2Session | undefined;

test.describe("E2E-16 ผิวหลังบ้าน (ผู้ใช้/บทบาท/dashboard/audit/หลักสูตร)", () => {
  test.beforeAll(async () => {
    // กวาดของค้างของเนมสเปซตัวเองจากรอบที่พังกลางทาง (idempotent — รันซ้ำได้)
    await cleanupE16();
    // const เฉพาะที่ — narrowing ของ let ระดับโมดูลโดน reset หลังทุก call ใน closure
    const sa = await createStaffRoleUser("e16-sa", "super_admin");
    const reg = await createStaffRoleUser("e16-reg", "staff:registrar");
    const tgt = await createLearnerUser("e16-target");
    superAdmin = sa;
    registrar = reg;
    target = tgt;
    // sanity ของ seed (แยกปัญหา seed พังออกจาก BFF/UI พัง) — staff 2 + ผู้เรียน 1 ต่างมี
    // citizen ของตัวเอง (3) + staff:registrar + super_admin = 5 แถว
    const roles = await psqlRows<{ role: string }>(`
      select role::text from public.role_assignments
       where user_id in ('${sa.id}', '${reg.id}', '${tgt.id}')
         and revoked_at is null order by role::text;
    `);
    expect(roles.map((row) => row.role)).toEqual([
      "citizen",
      "citizen",
      "citizen",
      "staff:registrar",
      "super_admin",
    ]);
    // session aal2 ครั้งเดียวต่อรันสำหรับ staff ทั้งสอง — GoTrue ปฏิเสธการ enroll ใหม่
    // จาก session aal1 ของผู้ใช้ที่มี factor ที่ verify แล้ว (403 — เดิมโดน 422 ชื่อซ้ำ
    // บังไว้ก่อนแก้ชื่อ factor ให้ไม่ซ้ำ) เทสทั้งหมดจึงแชร์ session ที่สร้างตรงนี้ (inject
    // ซ้ำได้ — access token ไม่หมดอายุภายในช่วงรัน suite)
    saAal2 = await enrollMfaTotp(sa.email);
    regAal2 = await enrollMfaTotp(reg.email);
  });

  test.afterAll(async () => {
    // คืนสถานะ course 3 เป็น published (หลักสูตร seed ใช้ร่วมโดยชุดอื่น) — publish ตรงผ่าน
    // SQL โดน trg_courses_publish_guard (SoD staff-only) ต้องพัก trigger ใน TX แบบเดียว
    // กับ purgeLedgerOf ของ dcr9 (transactional DDL — ตายกลางทาง trigger กลับมาเอง) ·
    // restore ล้มห้ามทิ้ง cleanup (try/finally — รอบก่อนโดนเจ๊งตรงนี้จนผู้ใช้ e16 ค้างใน DB)
    try {
      await psql(`
        begin;
        alter table public.courses disable trigger trg_courses_publish_guard;
        update public.courses set status = 'published' where id = '${COURSE3_ID}';
        alter table public.courses enable trigger trg_courses_publish_guard;
        commit;
      `);
    } finally {
      await cleanupE16();
    }
  });

  test("super_admin: /admin/users (as-built fail-closed) + ค้นหา BFF + สร้างบัญชี staff:viewer + กัน role ต้องห้าม", async ({
    page,
  }) => {
    expect(superAdmin).toBeDefined();
    await loginViaForm(page, superAdmin?.email ?? "");
    if (saAal2 === undefined) throw new Error("beforeAll ต้อง enroll sa สำเร็จก่อน");
    await injectSession(page, saAal2);

    // หน้า UI จริง — drift แก้แล้ว: parser ตรงขาออก BFF → ตารางแสดงจริง + แถวผู้ใช้ seed
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "ผู้ใช้และบทบาท" })).toBeVisible();
    const usersTable = page.getByRole("table", { name: /ตารางผู้ใช้/ });
    const targetRow = usersTable.getByRole("row").filter({ hasText: target?.email ?? "" });
    await expect(targetRow).toBeVisible();
    await expect(targetRow.getByText("ใช้งาน", { exact: true })).toBeVisible();
    await expect(targetRow.getByText("ประชาชน")).toBeVisible();

    // ค้นหาผ่าน UI — ฟอร์มส่ง q → page map เป็น wire key query= ตามสัญญา route (strict zod)
    await page.fill("#user-search", target?.email ?? "");
    await page.getByRole("button", { name: "ค้นหา" }).click();
    await page.waitForURL(/\/admin\/users\?q=/);
    await expect(
      page.getByRole("table", { name: /ตารางผู้ใช้/ }).getByRole("row").filter({ hasText: target?.email ?? "" }),
    ).toBeVisible();

    // สัญญา BFF จริง — ค้นหาเจอผู้ใช้ seed (user:view = sv/sr/sa)
    const search = await callJsonApi(
      page,
      "GET",
      `/api/v1/admin/users?query=${encodeURIComponent(target?.email ?? "")}`,
    );
    expect(search.status).toBe(200);
    const searchData = dataOf(search) as
      | readonly {
          readonly id: string;
          readonly displayName: string;
          readonly email: string;
          readonly deletedAt: string | null;
          readonly createdAt: string;
          readonly roles: readonly string[];
          readonly hasVerifiedLicense: boolean;
        }[]
      | null;
    expect(Array.isArray(searchData)).toBe(true);
    const found = (searchData ?? []).find((row) => row.id === target?.id);
    expect(found, "ค้นหาเจอผู้ใช้ e16-target ด้วยอีเมลเต็ม").toBeDefined();
    // pin รูปร่างแถวขาออกให้ตายตัว — หลักฐานว่า BFF ไม่มี status/disabledReason (ธง drift)
    expect(Object.keys(found ?? {}).sort().join(",")).toBe(
      "createdAt,deletedAt,displayName,email,hasVerifiedLicense,id,roles",
    );
    expect(found?.roles ?? []).toContain("citizen");
    expect(found?.hasVerifiedLicense).toBe(false);
    expect(found?.deletedAt ?? null).toBeNull();

    // สร้างบัญชีเจ้าหน้าที่ (super_admin) — 201 + DB role + audit ROLE_GRANT (ไม่ assert USER_CREATE)
    const staffEmail = `e16-staffviewer-${Date.now()}@ltc.test`;
    const created = await callJsonApi(page, "POST", "/api/v1/admin/users", {
      email: staffEmail,
      displayName: "e16 เจ้าหน้าที่ดูข้อมูล",
      role: "staff:viewer",
      reason: REASON,
    });
    expect(created.status).toBe(201);
    const createdData = dataOf(created) as {
      userId?: string;
      email?: string;
      displayName?: string;
      role?: string;
      granted?: boolean;
      invitedAt?: string | null;
    } | null;
    expect(createdData?.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createdData?.email).toBe(staffEmail);
    expect(createdData?.displayName).toBe("e16 เจ้าหน้าที่ดูข้อมูล");
    expect(createdData?.role).toBe("staff:viewer");
    expect(createdData?.granted).toBe(true);
    expect(typeof createdData?.invitedAt).toBe("string");

    // DB: role staff:viewer ยังใช้งาน (granted_by = sa) + audit ROLE_GRANT — USER_CREATE best-effort ไม่ assert
    const grantedRole = await psqlRows<{ granted_by: string }>(`
      select granted_by::text as granted_by from public.role_assignments
       where user_id = '${createdData?.userId ?? ""}' and role = 'staff:viewer' and revoked_at is null;
    `);
    expect(grantedRole).toHaveLength(1);
    expect(grantedRole[0]?.granted_by).toBe(superAdmin?.id ?? "");
    const grantAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'ROLE_GRANT' and entity_type = 'user'
         and entity_id = '${createdData?.userId ?? ""}'
         and context ->> 'role' = 'staff:viewer';
    `);
    expect(grantAudit[0]?.n).toBe(1);

    // role super_admin ใน body — zod ปฏิเสธก่อนแตะ DB (400 ERR-VAL-001 fields["role"])
    const forbiddenRole = await browserApi(page, "POST", "/api/v1/admin/users", {
      email: `e16-sablock-${Date.now()}@ltc.test`,
      displayName: "e16 ป้องกัน super_admin",
      role: "super_admin",
      reason: REASON,
    });
    expect(forbiddenRole.status).toBe(400);
    const forbiddenError = errorOf({ status: forbiddenRole.status, body: forbiddenRole.text });
    expect(forbiddenError.code).toBe("ERR-VAL-001");
    expect(forbiddenError.details["fields"]).toEqual(["role"]);

    // DB: ไม่มีบัญชีเกิดขึ้นจากคำขอที่ถูกปฏิเสธ
    const sablock = await psqlRows<{ n: number }>(`
      select count(*)::int as n from auth.users where email like 'e16-sablock-%';
    `);
    expect(sablock[0]?.n).toBe(0);
  });

  test("ปิด/เปิดใช้งานบัญชี (PATCH {is_active, reason}) — ban/unban จริง + profiles.is_active ตามทั้งสองทิศ", async ({
    page,
  }) => {
    expect(superAdmin).toBeDefined();
    expect(target).toBeDefined();
    await loginViaForm(page, superAdmin?.email ?? "");
    if (saAal2 === undefined) throw new Error("beforeAll ต้อง enroll sa สำเร็จก่อน");
    await injectSession(page, saAal2);
    await page.goto("/admin/dashboard"); // หน้า same-origin ของ staff — คุกกี้ใช้ได้ทั้งโดเมน
    await expect(page.getByRole("heading", { name: "แดชบอร์ดผู้ดูแล" })).toBeVisible();

    // ปิดใช้งาน — PATCH {is_active:false, reason} → 200 {userId, isActive:false}
    const disable = await callJsonApi(page, "PATCH", `/api/v1/admin/users/${target?.id ?? ""}`, {
      is_active: false,
      reason: REASON,
    });
    expect(disable.status).toBe(200);
    const disableData = dataOf(disable) as { userId?: string; isActive?: boolean } | null;
    expect(disableData?.userId).toBe(target?.id ?? "");
    expect(disableData?.isActive).toBe(false);

    // DB: GoTrue ban จริง (banned_until) + profiles.is_active=false
    const banned = await psqlRows<{ banned_until: string | null; is_active: boolean }>(`
      select u.banned_until::text as banned_until, p.is_active
        from auth.users u join public.profiles p on p.id = u.id
       where u.id = '${target?.id ?? ""}';
    `);
    expect(banned[0]?.banned_until).not.toBeNull();
    expect(banned[0]?.is_active).toBe(false);

    // ปิดโดยไม่ระบุเหตุผล — cross-field ที่ประตู BFF → 400 fields["reason"]
    const noReason = await callJsonApi(page, "PATCH", `/api/v1/admin/users/${target?.id ?? ""}`, {
      is_active: false,
    });
    expect(noReason.status).toBe(400);
    expect(errorOf(noReason).details["fields"]).toEqual(["reason"]);

    // เปิดกลับ — PATCH {is_active:true} → 200 + unban (banned_until null) + is_active true
    const enable = await callJsonApi(page, "PATCH", `/api/v1/admin/users/${target?.id ?? ""}`, {
      is_active: true,
    });
    expect(enable.status).toBe(200);
    const enableData = dataOf(enable) as { userId?: string; isActive?: boolean } | null;
    expect(enableData?.userId).toBe(target?.id ?? "");
    expect(enableData?.isActive).toBe(true);
    const unbanned = await psqlRows<{ banned_until: string | null; is_active: boolean }>(`
      select u.banned_until::text as banned_until, p.is_active
        from auth.users u join public.profiles p on p.id = u.id
       where u.id = '${target?.id ?? ""}';
    `);
    expect(unbanned[0]?.banned_until ?? null).toBeNull();
    expect(unbanned[0]?.is_active).toBe(true);
  });

  test("บทบาท: มอบ instructor (granted true→false) + ถอน (DELETE พร้อม body) → 204 + audit ครบ", async ({
    page,
  }) => {
    expect(superAdmin).toBeDefined();
    expect(target).toBeDefined();
    await loginViaForm(page, superAdmin?.email ?? "");
    if (saAal2 === undefined) throw new Error("beforeAll ต้อง enroll sa สำเร็จก่อน");
    await injectSession(page, saAal2);
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "แดชบอร์ดผู้ดูแล" }).first()).toBeVisible();

    const rolesPath = `/api/v1/admin/users/${target?.id ?? ""}/roles`;

    // มอบ instructor → 201 granted=true · DB แถว active + audit ROLE_GRANT
    const grant = await callJsonApi(page, "POST", rolesPath, { role: "instructor", reason: REASON });
    expect(grant.status).toBe(201);
    const grantData = dataOf(grant) as { userId?: string; role?: string; granted?: boolean } | null;
    expect(grantData?.userId).toBe(target?.id ?? "");
    expect(grantData?.role).toBe("instructor");
    expect(grantData?.granted).toBe(true);
    const activeRow = await psqlRows<{ granted_by: string }>(`
      select granted_by::text as granted_by from public.role_assignments
       where user_id = '${target?.id ?? ""}' and role = 'instructor' and revoked_at is null;
    `);
    expect(activeRow).toHaveLength(1);
    expect(activeRow[0]?.granted_by).toBe(superAdmin?.id ?? "");
    const grantAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'ROLE_GRANT' and entity_type = 'user' and entity_id = '${target?.id ?? ""}'
         and context ->> 'role' = 'instructor';
    `);
    expect(grantAudit[0]?.n).toBe(1);

    // มอบซ้ำ — idempotent (201 granted=false · ไม่มี mutation จึงไม่มี audit ใหม่)
    const grantAgain = await callJsonApi(page, "POST", rolesPath, { role: "instructor", reason: REASON });
    expect(grantAgain.status).toBe(201);
    const grantAgainData = dataOf(grantAgain) as { granted?: boolean } | null;
    expect(grantAgainData?.granted).toBe(false);
    const grantAuditAfterRepeat = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'ROLE_GRANT' and entity_type = 'user' and entity_id = '${target?.id ?? ""}'
         and context ->> 'role' = 'instructor';
    `);
    expect(grantAuditAfterRepeat[0]?.n).toBe(1);

    // role super_admin ผ่าน endpoint บทบาท — zod ปฏิเสธก่อนแตะ RPC (400 fields["role"])
    const saViaRoles = await browserApi(page, "POST", rolesPath, { role: "super_admin", reason: REASON });
    expect(saViaRoles.status).toBe(400);
    expect(errorOf({ status: saViaRoles.status, body: saViaRoles.text }).details["fields"]).toEqual(["role"]);

    // ถอน — DELETE พร้อม body {role, reason} → 204 · DB revoked + audit ROLE_REVOKE
    const revoke = await callJsonApi(page, "DELETE", rolesPath, { role: "instructor", reason: REASON });
    expect(revoke.status).toBe(204);
    const afterRevoke = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.role_assignments
       where user_id = '${target?.id ?? ""}' and role = 'instructor' and revoked_at is null;
    `);
    expect(afterRevoke[0]?.n).toBe(0);
    const revokeAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'ROLE_REVOKE' and entity_type = 'user' and entity_id = '${target?.id ?? ""}'
         and context ->> 'role' = 'instructor';
    `);
    expect(revokeAudit[0]?.n).toBe(1);

    // DELETE ไม่มี body — route บังคับ {role, reason} → 400 ก่อนแตะ RPC
    const revokeNoBody = await callJsonApi(page, "DELETE", rolesPath);
    expect(revokeNoBody.status).toBe(400);
    const revokeNoBodyError = errorOf(revokeNoBody);
    expect(revokeNoBodyError.code).toBe("ERR-VAL-001");

    // DB ไม่เปลี่ยน — instructor ยังคงถูกถอนอยู่ (คำขอผิดรูปไม่กระทบข้อมูล)
    const afterNoBody = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.role_assignments
       where user_id = '${target?.id ?? ""}' and role = 'instructor' and revoked_at is null;
    `);
    expect(afterNoBody[0]?.n).toBe(0);
  });

  test("SoD: staff:registrar มอบ staff:content → 403 ERR-RBAC-001 ที่ประตู BFF (ก่อน RPC)", async ({
    page,
  }) => {
    expect(registrar).toBeDefined();
    expect(target).toBeDefined();
    await loginViaForm(page, registrar?.email ?? "");
    if (regAal2 === undefined) throw new Error("beforeAll ต้อง enroll registrar สำเร็จก่อน");
    await injectSession(page, regAal2);
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "แดชบอร์ดผู้ดูแล" }).first()).toBeVisible();

    // registrar ไม่มี role:grant สำหรับ non-lawyer → ประตู BFF ปฏิเสธก่อน RPC (แบบแผน 1.2.3)
    const forbidden = await browserApi(page, "POST", `/api/v1/admin/users/${target?.id ?? ""}/roles`, {
      role: "staff:content",
      reason: REASON,
    });
    expect(forbidden.status).toBe(403);
    const forbiddenError = errorOf({ status: forbidden.status, body: forbidden.text });
    expect(forbiddenError.code).toBe("ERR-RBAC-001");
    expect(forbiddenError.details["permission"]).toBe("role:grant");

    // DB: ไม่มีแถว staff:content เกิดขึ้นสำหรับเป้าหมาย
    const noRow = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.role_assignments
       where user_id = '${target?.id ?? ""}' and role = 'staff:content' and revoked_at is null;
    `);
    expect(noRow[0]?.n).toBe(0);
  });

  test("dashboard: registrar เห็นแดชบอร์ด (UI + BFF) + from>to → 400 fields[\"from\"]", async ({ page }) => {
    expect(registrar).toBeDefined();
    await loginViaForm(page, registrar?.email ?? "");
    if (regAal2 === undefined) throw new Error("beforeAll ต้อง enroll registrar สำเร็จก่อน");
    await injectSession(page, regAal2);
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "แดชบอร์ดผู้ดูแล" })).toBeVisible();
    // KPI ของหน้า (report:view = sv/se/sr/sa — ตรวจข้อความ ไม่พึ่งสี)
    await expect(page.getByText("ผู้ใช้ใหม่")).toBeVisible();
    await expect(page.getByText("อัตราผ่าน (%)")).toBeVisible();
    await expect(page.getByText("ใบประกาศฯ ที่ออก")).toBeVisible();

    const dashboard = await callJsonApi(page, "GET", "/api/v1/admin/dashboard");
    expect(dashboard.status).toBe(200);
    const dashData = dataOf(dashboard) as {
      users?: { new?: number; total?: number };
      enrollments?: { new?: number };
      exams?: { attempts?: number; passed?: number; passRatePct?: number };
      certificates?: { issued?: number };
      credits?: { issued?: number };
    } | null;
    expect(typeof dashData?.users?.total).toBe("number");
    expect(dashData?.users?.total ?? 0).toBeGreaterThan(0);
    // passRatePct = null เมื่อไม่มีคนสอบเลยในช่วง (สัญญา nullable — typeof null
    // เป็น "object" จึงห้าม pin "number" เปล่า ๆ)
    const passRate = dashData?.exams?.passRatePct ?? null;
    expect(
      passRate === null || (typeof passRate === "number" && passRate >= 0 && passRate <= 100),
    ).toBe(true);

    // from > to — 400 ERR-VAL-001 fields["from"]
    const badRange = await browserApi(
      page,
      "GET",
      "/api/v1/admin/dashboard?from=2026-09-12&to=2026-09-01",
    );
    expect(badRange.status).toBe(400);
    expect(errorOf({ status: badRange.status, body: badRange.text }).details["fields"]).toEqual(["from"]);
  });

  test("audit: registrar → 403 + แผง UI fail-closed · super_admin → 200 + audit AUDIT_READ + แถวบน UI", async ({
    page,
  }) => {
    expect(registrar).toBeDefined();
    expect(superAdmin).toBeDefined();

    // registrar — UI /admin/audit: ผ่าน gate หน้า (staff) แต่ BFF 403 → แผง forbidden
    await loginViaForm(page, registrar?.email ?? "");
    if (regAal2 === undefined) throw new Error("beforeAll ต้อง enroll registrar สำเร็จก่อน");
    await injectSession(page, regAal2);
    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: "บันทึกการตรวจสอบ" })).toBeVisible();
    // กรองด้วยข้อความ — div #__next-route-announcer__ ของ Next (aria-live=assertive)
    // ถูกนับเป็น alert ด้วย เกิด strict-mode violation เมื่อใช้ getByRole("alert") เปล่า ๆ
    await expect(
      page.getByRole("alert").filter({ hasText: "ไม่มีสิทธิ์เข้าถึงข้อมูลส่วนนี้" }),
    ).toBeVisible();
    const regRead = await browserApi(page, "GET", "/api/v1/admin/audit-logs?limit=5");
    expect(regRead.status).toBe(403);
    expect(errorOf({ status: regRead.status, body: regRead.text }).code).toBe("ERR-RBAC-001");

    // super_admin — อ่านได้ (200 + แถวมี action) + ทุกการอ่านเกิด audit AUDIT_READ
    await loginViaForm(page, superAdmin?.email ?? "");
    if (saAal2 === undefined) throw new Error("beforeAll ต้อง enroll sa สำเร็จก่อน");
    await injectSession(page, saAal2);
    await page.goto("/admin/dashboard"); // หน้า staff same-origin ก่อนยิง fetch อ่าน audit
    await expect(page.getByRole("heading", { name: "แดชบอร์ดผู้ดูแล" }).first()).toBeVisible();

    // ตัดที่ 4000 (ค่าเริ่มต้น 600 ตัดกลาง JSON ของแถว audit 5 แถว →
    // "Unterminated string" ตอน dataOf parse)
    const saRead = await callJsonApi(page, "GET", "/api/v1/admin/audit-logs?limit=5", undefined, 4000);
    expect(saRead.status).toBe(200);
    const saData = dataOf(saRead) as readonly { action?: string }[] | null;
    expect(Array.isArray(saData)).toBe(true);
    expect((saData ?? []).length).toBeGreaterThan(0);
    expect((saData ?? [])[0]?.action).toBeTruthy();

    // DB: AUDIT_READ ของ sa ถูกเขียนจริง (BFF เขียนผ่าน user-JWT — allowlist รับ AUDIT_READ)
    const auditRead = await psqlRows<{ n: number; actor: string }>(`
      select count(*)::int as n, min(actor_user_id::text) as actor
        from public.audit_logs
       where action = 'AUDIT_READ' and actor_user_id = '${superAdmin?.id ?? ""}';
    `);
    expect(auditRead[0]?.n).toBeGreaterThan(0);
    expect(auditRead[0]?.actor).toBe(superAdmin?.id ?? "");

    // UI super_admin: ตาราง audit แสดงแถว AUDIT_READ (แถวใหม่สุด — อ่านเมื่อครู่)
    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: "บันทึกการตรวจสอบ" })).toBeVisible();
    await expect(page.getByText("AUDIT_READ").first()).toBeVisible();
  });

  test("หลักสูตร: return ไม่มี comment → 400 · publish/unpublish ตาม lifecycle + audit COURSE_* · publish จาก draft 400", async ({
    page,
  }) => {
    expect(superAdmin).toBeDefined();
    await loginViaForm(page, superAdmin?.email ?? "");
    if (saAal2 === undefined) throw new Error("beforeAll ต้อง enroll sa สำเร็จก่อน");
    await injectSession(page, saAal2);
    await page.goto("/admin/dashboard");
    await expect(page.getByRole("heading", { name: "แดชบอร์ดผู้ดูแล" }).first()).toBeVisible();

    // harness-side: ตั้ง course 3 เป็น pending_review (สถานะเดียวที่ publish/return ได้ — 0035)
    await psql(`update public.courses set status = 'pending_review' where id = '${COURSE3_ID}';`);
    const coursePath = `/api/v1/admin/courses/${COURSE3_ID}`;
    // audit_logs เป็น append-only และ COURSE3_ID เป็น fixture ใช้ร่วมข้ามชุด/ข้ามรัน —
    // แถว COURSE_PUBLISH/UNPUBLISH สะสมเรื่อย ๆ จึงวัด "เพิ่มจาก baseline ตอนนี้อีก 1"
    // ไม่ใช่ 1 เสมอ (คำขอที่ตกทั้งหมดอยู่หลังจุดนี้ — ไม่มี mutation ใดแตะ audit ก่อน baseline)
    const pubBase = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'COURSE_PUBLISH' and entity_type = 'course' and entity_id = '${COURSE3_ID}';
    `);
    const unpubBase = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'COURSE_UNPUBLISH' and entity_type = 'course' and entity_id = '${COURSE3_ID}';
    `);

    // return ไม่มี comment → 400 ERR-VAL-001 fields["comment"] (ก่อนแตะ RPC)
    const returnNoComment = await callJsonApi(page, "PATCH", coursePath, { action: "return" });
    expect(returnNoComment.status).toBe(400);
    expect(errorOf(returnNoComment).details["fields"]).toEqual(["comment"]);

    // publish จาก pending_review → 200 published + audit COURSE_PUBLISH
    const publish = await callJsonApi(page, "PATCH", coursePath, { action: "publish" });
    expect(publish.status).toBe(200);
    const publishData = dataOf(publish) as { courseId?: string; status?: string } | null;
    expect(publishData?.courseId).toBe(COURSE3_ID);
    expect(publishData?.status).toBe("published");
    const publishedRow = await psqlRows<{ status: string }>(`
      select status::text from public.courses where id = '${COURSE3_ID}';
    `);
    expect(publishedRow[0]?.status).toBe("published");
    const publishAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'COURSE_PUBLISH' and entity_type = 'course' and entity_id = '${COURSE3_ID}';
    `);
    expect(publishAudit[0]?.n).toBe((pubBase[0]?.n ?? 0) + 1);

    // unpublish จาก published → 200 draft + audit COURSE_UNPUBLISH
    const unpublish = await callJsonApi(page, "PATCH", coursePath, { action: "unpublish" });
    expect(unpublish.status).toBe(200);
    const unpublishData = dataOf(unpublish) as { courseId?: string; status?: string } | null;
    expect(unpublishData?.status).toBe("draft");
    const draftRow = await psqlRows<{ status: string }>(`
      select status::text from public.courses where id = '${COURSE3_ID}';
    `);
    expect(draftRow[0]?.status).toBe("draft");
    const unpublishAudit = await psqlRows<{ n: number }>(`
      select count(*)::int as n from public.audit_logs
       where action = 'COURSE_UNPUBLISH' and entity_type = 'course' and entity_id = '${COURSE3_ID}';
    `);
    expect(unpublishAudit[0]?.n).toBe((unpubBase[0]?.n ?? 0) + 1);

    // publish จาก draft → 400 invalid_transition (RPC — เผยแพร่ได้จาก pending_review เท่านั้น)
    // mapAdminRpcError แปลงป้าย RPC เป็น code ERR-VAL-001 + details.reason (message เป็น
    // ข้อความไทยกลางของรหัส ไม่มีป้าย) — สัญญานี้ถูก pin ไว้ที่ route.test.ts ("invalid_transition")
    const invalidTransition = await callJsonApi(page, "PATCH", coursePath, { action: "publish" });
    expect(invalidTransition.status).toBe(400);
    const invalidError = errorOf(invalidTransition);
    expect(invalidError.code).toBe("ERR-VAL-001");
    expect(invalidError.details["reason"]).toBe("invalid_transition");
  });
});

/**
 * เก็บกวาดเนมสเปซ e16 ทั้งชุด (เรียกได้ทั้งก่อนเริ่มและหลังจบ — idempotent):
 * แถว license/lawyer_licenses ของผู้ใช้ e16-% ต้องลบก่อน deleteD9User (media_assets
 * ของ deleteD9User มี not-exists guard อ้างตารางสองตารางนี้) · audit_logs คงไว้ตามดีไซน์ append-only
 */
async function cleanupE16(): Promise<void> {
  const users = await psqlRows<{ id: string }>(
    `select id::text from auth.users where email like 'e16-%';`,
  );
  for (const user of users) {
    await psql(`
      delete from public.license_applications where user_id = '${user.id}';
      delete from public.lawyer_licenses where user_id = '${user.id}';
    `);
    await deleteD9User(user.id);
  }
}