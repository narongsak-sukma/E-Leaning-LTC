/**
 * logout-button.test (PB-8) — behavioral test ระดับ component/unit ของ LogoutButton
 *
 * ครอบพฤติกรรมตามที่ component สัญญาไว้ในหัวไฟล์:
 * - กดปุ่ม → POST /api/v1/auth/logout (same-origin — mock fetch ที่ขอบเขต global)
 * - 204 (สำเร็จ, รวมกรณี "ไม่มี session" ที่ route ตอบ 204 แบบ idempotent) → redirect /login
 * - 503 (auth upstream ล้ม) → ยังอยู่หน้าเดิม + แสดงข้อความไทย role=alert + ปุ่มกลับมากดซ้ำได้
 *   (ไม่ redirect ทิ้งผู้ใช้ · ไม่สำเร็จปลอม)
 * - 401 (route นี้ไม่เคยตอบ 401 — ไม่มี session = 204 ตาม spec) → ถ้าได้รับจริง (เช่น 401 จาก
 *   gateway/CSRF ที่ไม่แตะ session) ต้องไม่ redirect และแสดงข้อความไทยเช่นกัน (fail-safe)
 * - network ล้ม (fetch throw) → ทางเดียวกับ 5xx (requestJson แปลงเป็น ApiError ให้)
 *
 * หมายเหตุการทดสอบใน node env (ไม่มี DOM):
 * - JSX ของ logout-button.tsx ผ่าน jsx-runtime อัตโนมัติ (vitest esbuild jsx: "automatic" — PB-2)
 *   จึงเรนเดอร์ได้โดยไม่ต้องตั้ง global React
 * - เรียกฟังก์ชัน component ตรง ๆ โดย mock useState ของ react ด้วยตัวเก็บ state จำลอง
 *   เพื่อจับ onClick จาก element tree แล้วกดเอง (ไม่มี renderer/event จริงใน node)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ตัวยึดตำแหน่งของ useState — vi.mock ถูก hoist ก่อนประกาศตัวแปรระดับ module
 * จึงอ้างผ่าน object นี้ (ตัวจริงติดตั้งท้ายไฟล์ ก่อน test ทำงาน)
 */
const stateShim = vi.hoisted(() => ({
  useState: (initial: unknown): unknown => [initial, (): void => {}],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => stateShim.useState(initial) };
});

import { LogoutButton } from "./logout-button";

/** node ใน element tree ที่ React.createElement สร้าง (เอาเฉพาะที่ test ต้องอ่าน) */
interface ElementNode {
  type: unknown;
  props: { children?: unknown } & Record<string, unknown>;
}

/** state จำลองของ component — slot ตามลำดับการเรียก useState และค้างข้าม "render" */
let stateSlots: { value: unknown }[] = [];
let stateCursor = 0;

/** ติดตั้ง useState จำลอง — ค่าเริ่มต้นสร้างครั้งแรกที่ slot ถูกขอ แล้วค้างไว้ให้ render ถัดไป */
stateShim.useState = (initial: unknown): unknown => {
  const slot = stateSlots[stateCursor] ?? { value: initial };
  stateSlots[stateCursor] = slot;
  stateCursor += 1;
  return [
    slot.value,
    (value: unknown): void => {
      slot.value = typeof value === "function" ? (value as (prev: unknown) => unknown)(slot.value) : value;
    },
  ];
};

/** เรนเดอร์ 1 pass — เรียก component ตรง ๆ (state ค้างใน slot เดิมตามลำดับ hook) */
function renderLogoutButton(): ElementNode {
  stateCursor = 0;
  return LogoutButton({}) as unknown as ElementNode;
}

/** เก็บทุก element ใน tree (เดิน children แบบเรียกซ้ำ — รองรับ children เป็น array/nested) */
function collectElements(node: unknown, into: ElementNode[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectElements(item, into);
    }
    return;
  }
  if (typeof node !== "object" || node === null || !("props" in node)) {
    return;
  }
  const element = node as ElementNode;
  into.push(element);
  collectElements(element.props.children, into);
}

/** ปุ่ม logout ใน tree — ไม่พบ = test ล้มเหลวด้วยเหตุผลชัดเจน */
function requireButton(tree: ElementNode): ElementNode {
  const found: ElementNode[] = [];
  collectElements(tree, found);
  const button = found.find((element) => element.type === "button");
  if (button === undefined) {
    throw new Error("ไม่พบปุ่ม logout (element type=button) ใน tree");
  }
  return button;
}

/** ป้ายเตือน role=alert ใน tree — ไม่แสดง = null */
function findAlert(tree: ElementNode): ElementNode | null {
  const found: ElementNode[] = [];
  collectElements(tree, found);
  const alert = found.find((element) => element.props["role"] === "alert");
  return alert ?? null;
}

/** ป้ายเตือน role=alert — ห้ามเป็น null (ใช้เมื่อ test คาดหวังว่าต้องแสดง) */
function requireAlert(tree: ElementNode): ElementNode {
  const alert = findAlert(tree);
  if (alert === null) {
    throw new Error("ควรแสดงป้ายเตือน role=alert แต่ไม่พบใน tree");
  }
  return alert;
}

/** รวมข้อความทั้งหมดใต้ element เป็น string เดียว */
function textOf(node: ElementNode): string {
  const found: ElementNode[] = [];
  collectElements(node, found);
  const texts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === "string") {
      texts.push(child);
      return;
    }
    if (typeof child === "number") {
      texts.push(String(child));
      return;
    }
    if (typeof child === "object" && child !== null && "props" in child) {
      walk((child as ElementNode).props.children);
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        walk(item);
      }
    }
  };
  walk(node.props.children);
  return texts.join("");
}

/** กดปุ่ม (onClick ของ component เป็น fire-and-forget — flow ถูก flush ด้วย drain()) */
function click(tree: ElementNode): void {
  const onClick = requireButton(tree).props["onClick"];
  if (typeof onClick !== "function") {
    throw new Error("ปุ่ม logout ต้องมี onClick");
  }
  (onClick as () => void)();
}

/** รอให้ promise chain ของ click จบ (microtask ทั้งหมด drain ก่อน macrotask ถัดไป) */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** window.location จำลอง — origin สำหรับ same-origin fetch + assign จับการ redirect */
function stubWindowLocation(assign: (href: string) => void): { origin: string } {
  const location = { origin: "http://learner.test.local", assign };
  vi.stubGlobal("window", { location });
  return { origin: location.origin };
}

/** การเรียก fetch ครั้งแรก — ไม่มี = throw ด้วยเหตุผลชัดเจน */
function firstFetchCall(fetchMock: { mock: { calls: unknown[][] } }): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) {
    throw new Error("fetch ยังไม่ถูกเรียก");
  }
  return { url: String(call[0] ?? ""), init: (call[1] ?? {}) as RequestInit };
}

/** response 401/5xx แบบ error envelope §1.3 ของ BFF */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("LogoutButton (PB-8 — กด logout แล้วจบยังไงต้องชัดเจน)", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("กดปุ่ม → POST /api/v1/auth/logout · ระหว่างรอปุ่มปิดกันดับเบิลคลิก · 204 → redirect /login", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    stubWindowLocation(assign);

    const tree = renderLogoutButton();
    const button = requireButton(tree);
    expect(textOf(button)).toBe("ออกจากระบบ");
    expect(button.props["disabled"]).toBe(false);
    expect(findAlert(tree)).toBeNull();

    click(tree);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe("http://learner.test.local/api/v1/auth/logout");
    expect(init.method).toBe("POST");

    const pendingTree = renderLogoutButton();
    const pendingButton = requireButton(pendingTree);
    expect(pendingButton.props["disabled"]).toBe(true);
    expect(textOf(pendingButton)).toBe("กำลังออกจากระบบ...");
    expect(findAlert(pendingTree)).toBeNull();

    resolveFetch(new Response(null, { status: 204 }));
    await drain();

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login");
    expect(findAlert(renderLogoutButton())).toBeNull();
  });

  it("503 (auth upstream ล้ม) → ยังอยู่หน้าเดิม + ข้อความไทย role=alert + ปุ่มกลับมากดซ้ำได้", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        errorResponse(503, "ERR-SYS-002", "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่"),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    stubWindowLocation(assign);

    const tree = renderLogoutButton();
    click(tree);
    await drain();

    // ยังอยู่หน้าเดิม — ไม่ redirect ทิ้งผู้ใช้ และไม่สำเร็จปลอม
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();

    const failedTree = renderLogoutButton();
    const alert = requireAlert(failedTree);
    expect(alert.props["role"]).toBe("alert");
    expect(textOf(alert)).toContain("ออกจากระบบไม่สำเร็จ");
    expect(textOf(alert)).toContain("โปรดลองอีกครั้ง");
    const failedButton = requireButton(failedTree);
    expect(failedButton.props["disabled"]).toBe(false);
    expect(textOf(failedButton)).toBe("ออกจากระบบ");

    // ผู้ใช้กดซ้ำได้ — คราวนี้ route หาย → 204 → redirect ตามปกติ
    click(failedTree);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("401 (route ไม่เคยตอบ 401 — ไม่มี session ตอบ 204 ตาม spec) → fail-safe: ไม่ redirect + ข้อความไทย", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(401, "HTTP_401", "ไม่ได้เข้าสู่ระบบ"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    stubWindowLocation(assign);

    const tree = renderLogoutButton();
    click(tree);
    await drain();

    // session อาจยังอยู่ (401 ที่ไม่ได้มาจาก route) — ห้ามทำเหมือนสำเร็จ
    expect(assign).not.toHaveBeenCalled();
    const failedTree = renderLogoutButton();
    expect(textOf(requireAlert(failedTree))).toContain("ออกจากระบบไม่สำเร็จ");
    expect(requireButton(failedTree).props["disabled"]).toBe(false);
  });

  it("network ล้ม (fetch throw) → ทางเดียวกับ 5xx: ไม่ redirect + ข้อความไทย", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    stubWindowLocation(assign);

    const tree = renderLogoutButton();
    click(tree);
    await drain();

    expect(assign).not.toHaveBeenCalled();
    const failedTree = renderLogoutButton();
    expect(textOf(requireAlert(failedTree))).toContain("ออกจากระบบไม่สำเร็จ");
    expect(requireButton(failedTree).props["disabled"]).toBe(false);
  });
});
