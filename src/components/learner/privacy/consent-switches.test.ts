/**
 * consent-switches.test — behavioral test ของ ConsentSwitches (D-p5-13 item 2 · lane E)
 * (แบบแผน notification-bell.test.ts — node env: เรียก component ตรง ๆ + state shim)
 *
 * ลำดับ useState ของ ConsentSwitches (ผูกกับ test): 1 phase · 2 items · 3 pendingType ·
 * 4 status
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stateShim = vi.hoisted(() => ({
  useState: (initial: unknown): unknown => [initial, (): void => {}],
  useEffect: (): void => {},
  useRef: (initial: unknown): { current: unknown } => ({ current: initial }),
  useCallback: (fn: unknown): unknown => fn,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => stateShim.useState(initial),
    useEffect: (): void => stateShim.useEffect(),
    useRef: (initial: unknown) => stateShim.useRef(initial),
    useCallback: (fn: unknown) => stateShim.useCallback(fn),
  };
});

import { CONSENT_LABELS, ConsentSwitches, deriveConsentState } from "./consent-switches";

/** node ใน element tree ที่ JSX สร้าง */
interface ElementNode {
  type: unknown;
  props: { children?: unknown } & Record<string, unknown>;
}

let stateSlots: { value: unknown }[] = [];
let stateCursor = 0;

stateShim.useState = (initial: unknown): unknown => {
  const slot = stateSlots[stateCursor] ?? { value: initial };
  stateSlots[stateCursor] = slot;
  stateCursor += 1;
  return [
    slot.value,
    (value: unknown): void => {
      slot.value =
        typeof value === "function" ? (value as (prev: unknown) => unknown)(slot.value) : value;
    },
  ];
};

function renderSwitches(): ElementNode {
  stateCursor = 0;
  return ConsentSwitches() as unknown as ElementNode;
}

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

/** กดปุ่มผ่าน onClick (cast จาก unknown — props เป็น Record<string, unknown>) */
function clickElement(element: ElementNode | undefined): void {
  (element?.props.onClick as (() => void) | undefined)?.();
}

function findByTestId(tree: ElementNode, testId: string): ElementNode | undefined {
  return elementsOf(tree).find((element) => element.props["data-testid"] === testId);
}

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

function textAll(tree: ElementNode): string {
  return elementsOf(tree).map(textOf).join("\n");
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** envelope 200 {data:...} §1.1 */
function okEnvelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** response error envelope §1.3 */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** window จำลอง — api.ts resolve origin จาก window.location.origin */
function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

/** รูป view ของ GET /profile/consents (แคบพอสำหรับ deriveConsentState) */
type ConsentsViewLike = {
  notice_acknowledgments: never[];
  consents: { type: "marketing" | "email_notify"; status: "granted" | "revoked"; updated_at: string }[];
};

/** view จำลอง — รูปตาม route จริงของ repo */
function viewFixture(consents?: ConsentsViewLike["consents"]): ConsentsViewLike {
  const rows =
    consents ??
    [{ type: "marketing", status: "granted", updated_at: "2026-09-12T02:00:00Z" }];
  return { notice_acknowledgments: [], consents: rows };
}

/** seed slot "ready" ครบ 4 ช่อง (1 phase · 2 items · 3 pendingType · 4 status) */
function seedReady(
  items: Record<string, unknown>,
  pendingType: unknown,
  status: unknown,
): void {
  stateSlots[0] = { value: "ready" };
  stateSlots[1] = { value: items };
  stateSlots[2] = { value: pendingType };
  stateSlots[3] = { value: status };
}

describe("CONSENT_LABELS — ป้ายไทยครบทั้ง 2 type", () => {
  it("marketing/email_notify มี label+hint", () => {
    expect(CONSENT_LABELS.marketing.label).toBe("รับข่าวสารและกิจกรรมการอบรม");
    expect(CONSENT_LABELS.email_notify.label).toBe("รับการแจ้งเตือนทางอีเมล");
    expect(CONSENT_LABELS.marketing.hint.length).toBeGreaterThan(0);
    expect(CONSENT_LABELS.email_notify.hint.length).toBeGreaterThan(0);
  });
});

describe("deriveConsentState — missing type = ปิด (conservative)", () => {
  it("ไม่มีแถว → ทุก type ปิด (granted:false, updatedAt:null)", () => {
    const state = deriveConsentState({ consents: [] });
    expect(state.marketing).toEqual({ granted: false, updatedAt: null });
    expect(state.email_notify.granted).toBe(false);
    expect(state.email_notify.updatedAt).toBeNull();
  });

  it("แถว granted → granted:true + เวลา · แถว revoked → ปิด", () => {
    const state = deriveConsentState({
      consents: [
        { type: "marketing", status: "granted", updated_at: "2026-09-12T02:00:00Z" },
        { type: "email_notify", status: "revoked", updated_at: "2026-09-12T03:00:00Z" },
      ],
    });
    expect(state.marketing).toEqual({ granted: true, updatedAt: "2026-09-12T02:00:00Z" });
    expect(state.email_notify.granted).toBe(false);
  });
});

describe("ConsentSwitches — เรนเดอร์ตาม state", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("phase เริ่มต้น → role=status กำลังโหลด", () => {
    const tree = renderSwitches();
    expect(textAll(tree)).toContain("กำลังโหลดความยินยอม...");
  });

  it("phase=error → role=alert + retry เรียก GET ใหม่", async () => {
    stateSlots[0] = { value: "error" };
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(viewFixture()));
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderSwitches();
    expect(textAll(tree)).toContain("โหลดความยินยอมไม่สำเร็จ");
    const retry = findByTestId(tree, "consents-retry");
    expect(retry).toBeDefined();
    clickElement(retry);
    await drain();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/profile/consents");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");
  });

  it("ready: สวิตช์ 2 ตัว aria-checked ตาม state · ป้าย+คำอธิบายครบ", () => {
    seedReady(deriveConsentState(viewFixture()), null, null);
    const tree = renderSwitches();
    const marketingToggle = findByTestId(tree, "consent-toggle-marketing");
    const emailToggle = findByTestId(tree, "consent-toggle-email_notify");
    expect(marketingToggle?.props["aria-checked"]).toBe(true);
    expect(emailToggle?.props["aria-checked"]).toBe(false);
    expect(textAll(tree)).toContain("รับข่าวสารและกิจกรรมการอบรม");
    expect(textAll(tree)).toContain("รับการแจ้งเตือนทางอีเมล");
  });

  it("toggle → PATCH {type, action} + อัปเดตจาก response + ข้อความสำเร็จ role=status", async () => {
    stubWindow();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okEnvelope({ type: "marketing", status: "revoked" }));
    vi.stubGlobal("fetch", fetchMock);
    seedReady(deriveConsentState(viewFixture()), null, null);
    const tree = renderSwitches();
    const toggle = findByTestId(tree, "consent-toggle-marketing");
    clickElement(toggle);
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const patch = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(patch[1].method).toBe("PATCH");
    expect(String(patch[0])).toContain("/api/v1/profile/consents");
    const body = JSON.parse(String(patch[1].body)) as Record<string, unknown>;
    expect(body).toEqual({ type: "marketing", action: "revoke" });
    const after = textAll(renderSwitches());
    expect(after).toContain("บันทึกความยินยอมเรียบร้อยแล้ว");
    const rerendered = findByTestId(renderSwitches(), "consent-toggle-marketing");
    expect(rerendered?.props["aria-checked"]).toBe(false);
  });

  it("toggle ล้ม (500) → คงสถานะเดิม + ข้อความ error role=alert", async () => {
    stubWindow();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(500, "ERR-SYS-002", "เปลี่ยนความยินยอมไม่ได้ในขณะนี้"),
      );
    vi.stubGlobal("fetch", fetchMock);
    seedReady(deriveConsentState(viewFixture()), null, null);
    const tree = renderSwitches();
    const toggle = findByTestId(tree, "consent-toggle-marketing");
    clickElement(toggle);
    await drain();
    const after = textAll(renderSwitches());
    expect(after).toContain("เปลี่ยนความยินยอมไม่ได้ในขณะนี้");
    const rerendered = findByTestId(renderSwitches(), "consent-toggle-marketing");
    expect(rerendered?.props["aria-checked"]).toBe(true);
  });

  it("มี pending ค้าง → คลิกซ้ำไม่ส่ง PATCH (กันซ้อนทีละ type)", async () => {
    stubWindow();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    seedReady(deriveConsentState(viewFixture()), "email_notify", null);
    const tree = renderSwitches();
    const toggle = findByTestId(tree, "consent-toggle-marketing");
    clickElement(toggle);
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
