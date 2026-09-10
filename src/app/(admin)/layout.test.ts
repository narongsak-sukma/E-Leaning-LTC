/**
 * unit tests — admin shell layout (C-8 Phase 1)
 * ตรวจ 3 ทางของ layout: session เจ้าหน้าที่ → แสดง shell จริง ·
 * ไม่มี session/ไม่มีบทบาทเจ้าหน้าที่ → redirect /login ·
 * BFF ล่ม → แผง "ระบบขัดข้อง" (ไม่ redirect, ไม่แสดง children)
 * เรนเดอร์ด้วย renderToStaticMarkup (node) — mock AdminSidebar (client hook) ที่ขอบเขต module
 */
import { renderToStaticMarkup } from "react-dom/server";
import * as ReactPkg from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * vitest ของ repo ใช้ esbuild transform .tsx แบบ classic runtime (tsconfig jsx: "preserve")
 * — เรนเดอร์ JSX ใน node จึงต้องมี React identifier ระดับ global
 * (แก้ที่ test เท่านั้น ไม่แตะ vitest.config.ts ซึ่งอยู่นอกขอบเขต lane นี้)
 */
(globalThis as Record<string, unknown>)["React"] = ReactPkg;

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      host: "admin.test.local",
      "x-forwarded-proto": "https",
      cookie: "session-cookie=abc",
    }),
}));

vi.mock("@/components/admin/AdminSidebar", () => ({
  AdminSidebar: () => null,
}));

import AdminLayoutImport from "./layout";

/** default export ของ layout — ช่วยให้ type เป็นฟังก์ชัน component */
const AdminLayout: (props: { children: React.ReactNode }) => Promise<React.ReactElement> =
  AdminLayoutImport;

/** ตอบ response แบบ JSON ตาม envelope §1.1 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** ตั้ง fetch ตอบ session แบบต่าง ๆ — roles: บทบาทของผู้ใช้จำลอง */
function mockMeResponse(options: {
  status: number;
  roles?: string[];
  displayName?: string;
  mfaVerified?: boolean | null;
  body?: unknown;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      options.body !== undefined
        ? jsonResponse(options.status, options.body)
        : jsonResponse(options.status, {
            data: {
              id: "u-1",
              email: "staff@example.com",
              displayName: options.displayName ?? "เจ้าหน้าที่ทดสอบ",
              roles: options.roles ?? [],
              ...(options.mfaVerified === undefined
                ? {}
                : { mfaVerified: options.mfaVerified }),
            },
          }),
    ),
  );
}

/** จับข้อผิดพลาด NEXT_REDIRECT จาก layout */
async function catchRedirect(): Promise<{ digest?: unknown }> {
  try {
    await AdminLayout({ children: null });
    return {};
  } catch (error) {
    return { digest: (error as { digest?: unknown }).digest };
  }
}

describe("AdminLayout (session จริงจาก GET /api/v1/me)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("เจ้าหน้าที่ (staff:content) → แสดง shell ชื่อจริง + บทบาทไทย + ไม่ redirect", async () => {
    mockMeResponse({
      status: 200,
      roles: ["staff:content"],
      displayName: "ดิลดา ใจดี",
      mfaVerified: true,
    });
    const element = await AdminLayout({ children: null });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("ดิลดา ใจดี");
    expect(html).toContain("บทบาท: เจ้าหน้าที่ดูแลเนื้อหา");
    expect(html).toContain("ยืนยัน MFA แล้ว");
    expect(html).not.toContain("ขออภัย ติดต่อระบบหลังบ้านไม่ได้ในขณะนี้");
  });

  it("ผู้เรียน (citizen) → redirect /login (NEXT_REDIRECT)", async () => {
    mockMeResponse({ status: 200, roles: ["citizen"] });
    const { digest } = await catchRedirect();
    expect(String(digest)).toContain("NEXT_REDIRECT");
    expect(String(digest)).toContain("/login");
  });

  it("ไม่มี session (401) → redirect /login", async () => {
    mockMeResponse({ status: 401, body: {} });
    const { digest } = await catchRedirect();
    expect(String(digest)).toContain("NEXT_REDIRECT");
    expect(String(digest)).toContain("/login");
  });

  it("403 (MFA ยังไม่ผ่าน) → redirect /login", async () => {
    mockMeResponse({ status: 403, body: {} });
    const { digest } = await catchRedirect();
    expect(String(digest)).toContain("NEXT_REDIRECT");
    expect(String(digest)).toContain("/login");
  });

  it("BFF ล่ม (fetch throw) → แผงระบบขัดข้อง role=alert และไม่ redirect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const element = await AdminLayout({ children: null });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="alert"');
    expect(html).toContain("ขออภัย ติดต่อระบบหลังบ้านไม่ได้ในขณะนี้");
    expect(html).not.toContain("บทบาท:");
  });

  it("BFF 5xx → แผงระบบขัดข้อง (fail-closed)", async () => {
    mockMeResponse({ status: 503, body: {} });
    const element = await AdminLayout({ children: null });
    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="alert"');
    expect(html).toContain("ขออภัย ติดต่อระบบหลังบ้านไม่ได้ในขณะนี้");
  });

  it("mfaVerified ขาดหาย → ไม่แสดง badge ตัดสินแทน (แสดงเป็นกลาง)", async () => {
    mockMeResponse({ status: 200, roles: ["staff:viewer"], mfaVerified: null });
    const element = await AdminLayout({ children: null });
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("ยืนยัน MFA แล้ว");
    expect(html).not.toContain("ยังไม่ยืนยัน MFA");
    expect(html).toContain("โหมดดูอย่างเดียว (staff:viewer)");
  });
});
