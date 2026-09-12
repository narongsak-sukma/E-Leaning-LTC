/**
 * notification-bell.test — behavioral test ระดับ component/unit ของ NotificationBell
 * (แบบแผน logout-button.test.ts — node env ไม่มี DOM: เรียก component ตรง ๆ โดย mock
 * useState ของ react ด้วยตัวเก็บ state จำลอง · useEffect ไม่ทำงานในการเรนเดอร์ตรง จึงแยก
 * ทดสอบการโหลดเลขไม่อ่านที่ loadUnreadCount() (mock fetch ที่ขอบเขต global) และ
 * พฤติกรรมป้ายที่ badgeLabelOf() (pure) + เรนเดอร์ตาม state ที่กำหนดค่าล่วงหน้า)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ตัวยึดตำแหน่งของ useState — vi.mock ถูก hoist ก่อนประกาศตัวแปรระดับ module
 * จึงอ้างผ่าน object นี้ (ตัวจริงติดตั้งท้ายไฟล์ ก่อน test ทำงาน)
 */
const stateShim = vi.hoisted(() => ({
  useState: (initial: unknown): unknown => [initial, (): void => {}],
  useEffect: (): void => {},
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => stateShim.useState(initial),
    // useEffect ไม่ทำงานในการเรนเดอร์ตรง (node env ไม่มี renderer) — no-op กัน invalid hook call
    useEffect: (): void => stateShim.useEffect(),
  };
});

import {
  UNREAD_BADGE_MAX,
  UNREAD_POLL_INTERVAL_MS,
  NotificationBell,
  badgeLabelOf,
  loadUnreadCount,
} from "./notification-bell";

/** node ใน element tree ที่ React.createElement สร้าง (เอาเฉพาะที่ test ต้องอ่าน) */
interface ElementNode {
  type: unknown;
  props: { children?: unknown } & Record<string, unknown>;
}

/** state จำลองของ component — slot ตามลำดับการเรียก useState และค้างข้าม "render" */
let stateSlots: { value: unknown }[] = [];
let stateCursor = 0;

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
function renderBell(): ElementNode {
  stateCursor = 0;
  return NotificationBell() as unknown as ElementNode;
}

/** เก็บทุก element ใน tree (เดิน children แบบเรียกซ้ำ) */
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

function elementsOf(tree: ElementNode): ElementNode[] {
  const found: ElementNode[] = [];
  collectElements(tree, found);
  return found;
}

/** หา element ตาม data-testid — ไม่พบ = undefined */
function findByTestId(tree: ElementNode, testId: string): ElementNode | undefined {
  return elementsOf(tree).find((element) => element.props["data-testid"] === testId);
}

/** รวมข้อความทั้งหมดใต้ element เป็น string เดียว */
function textOf(node: ElementNode): string {
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

/** response 200 {data:...} ของ envelope §1.1 — เหมือนที่ BFF ตอบจริง */
function okEnvelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** response error envelope §1.3 ของ BFF */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** แถวแจ้งเตือนจำลองสำหรับ payload — รูปตาม contract ของ lane B */
function itemFixture(overrides?: { read?: boolean }): Record<string, unknown> {
  return {
    id: "3f1d0e58-8f3c-4d5a-9a2b-000000000001",
    recipient_id: "5f1d0e58-8f3c-4d5a-9a2b-000000000009",
    topic: "exam.result",
    title: "ผลสอบของท่านพร้อมแล้ว",
    body: "ท่านสอบผ่าน",
    severity: "success",
    ref_type: "assessment_attempt",
    ref_id: "7f1d0e58-8f3c-4d5a-9a2b-000000000002",
    created_at: "2026-09-12T02:00:00Z",
    read_at: overrides?.read === true ? "2026-09-12T03:00:00Z" : null,
  };
}

describe("badgeLabelOf — ป้ายเลขไม่อ่าน", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  it("0 หรือยังไม่รู้ค่า = ซ่อนป้าย (null)", () => {
    expect(badgeLabelOf(0)).toBeNull();
    expect(badgeLabelOf(null)).toBeNull();
  });

  it("ค่าปกติแสดงเป็นเลข · เกิน 99 = 99+", () => {
    expect(badgeLabelOf(1)).toBe("1");
    expect(badgeLabelOf(99)).toBe("99");
    expect(UNREAD_BADGE_MAX).toBe(99);
    expect(badgeLabelOf(100)).toBe("99+");
    expect(badgeLabelOf(150)).toBe("99+");
  });

  it("UNREAD_POLL_INTERVAL_MS = 60 วินาที", () => {
    expect(UNREAD_POLL_INTERVAL_MS).toBe(60_000);
  });
});

describe("loadUnreadCount — โหลดเลขไม่อ่านผ่าน BFF (mock fetch ที่ขอบเขต global)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** window จำลอง — api.ts ต้องมี window.location.origin ฝั่ง browser (node env ไม่มีให้เอง) */
  function stubBrowserWindow(): string {
    const location = { origin: "http://learner.test.local" };
    vi.stubGlobal("window", { location });
    return location.origin;
  }

  beforeEach(() => {
    stubBrowserWindow();
  });

  it("200 → คืน unread_count จาก GET ?limit=1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({ items: [itemFixture()], unread_count: 3, next_cursor: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUnreadCount()).resolves.toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://learner.test.local/api/v1/me/notifications?limit=1");
    expect(init.method).toBe("GET");
  });

  it("500 envelope → ApiError ข้อความไทยจาก envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(500, "ERR-SYS-002", "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUnreadCount()).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "ขออภัย ระบบขัดข้องชั่วคราว กรุณาลองใหม่",
    });
  });

  it("payload ผิดสัญญา (ไม่มี data) → ERR-SYS-001 fail-closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], unread_count: 0, next_cursor: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUnreadCount()).rejects.toMatchObject({
      name: "ApiError",
      code: "ERR-SYS-001",
    });
  });

  it("network ล้ม (fetch throw) → ApiError ข้อความกลางไทย", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadUnreadCount()).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    });
  });
});

describe("NotificationBell — การเรนเดอร์ตาม state (เรียก component ตรง ๆ)", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ยังไม่รู้ค่า (null) → กระดิ่งลิงก์ไป /my/notifications · ไม่มีป้าย", () => {
    const tree = renderBell();
    const button = findByTestId(tree, "bell-button");
    expect(button).toBeDefined();
    expect(button?.props["href"]).toBe("/my/notifications");
    expect(button?.props["aria-label"]).toBe("การแจ้งเตือน");
    expect(findByTestId(tree, "bell-count")).toBeUndefined();
  });

  it("count = 7 → ป้าย 7 + aria-label บอกจำนวน (screen reader)", () => {
    stateSlots[0] = { value: 7 };
    const tree = renderBell();
    const badge = findByTestId(tree, "bell-count");
    expect(badge).toBeDefined();
    expect(textOf(badge as ElementNode)).toBe("7");
    const button = findByTestId(tree, "bell-button");
    expect(button?.props["aria-label"]).toBe("การแจ้งเตือน — ยังไม่ได้อ่าน 7 รายการ");
  });

  it("count = 0 → ซ่อนป้าย · count = 150 → ป้าย 99+", () => {
    stateSlots[0] = { value: 0 };
    expect(findByTestId(renderBell(), "bell-count")).toBeUndefined();

    stateSlots[0] = { value: 150 };
    const overflowTree = renderBell();
    const badge = findByTestId(overflowTree, "bell-count");
    expect(badge).toBeDefined();
    expect(textOf(badge as ElementNode)).toBe("99+");
  });
});
