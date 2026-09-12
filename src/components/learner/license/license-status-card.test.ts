/**
 * license-status-card.test — behavioral test ของ LicenseStatusCard (D-p5-4 · IDENT-005 · lane E)
 * (node env: เรียก component ตรง ๆ + state shim — ลำดับ useState ผูกกับ test:
 * 1 phase · 2 data · 3 afterActionMsg)
 *
 * หมายเหตุ: ฟอร์มย่อย LicenseResubmitForm ปรากฏเป็น element (ยังไม่ render ลูกใน
 * direct-call) — ตรวจด้วยชนิด element แทน subtree
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

import { formatThaiDateTime } from "./api";
import {
  APPLICATION_STATUS_LABELS,
  LicenseStatusCard,
} from "./license-status-card";
import { LicenseResubmitForm } from "./license-resubmit-form";

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

function renderCard(): ElementNode {
  stateCursor = 0;
  return LicenseStatusCard() as unknown as ElementNode;
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

function findByTestId(tree: ElementNode, testId: string): ElementNode | undefined {
  return elementsOf(tree).find((element) => element.props["data-testid"] === testId);
}

function resubmitFormOf(tree: ElementNode): ElementNode | undefined {
  return elementsOf(tree).find((element) => element.type === LicenseResubmitForm);
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

function clickElement(element: ElementNode | undefined): void {
  (element?.props.onClick as (() => void) | undefined)?.();
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function okEnvelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

const ISO_1 = "2026-09-01T02:00:00Z";
const ISO_2 = "2026-09-10T05:30:00+07:00";

/** seed slot "ready" ครบ 3 ช่อง (1 phase · 2 data · 3 afterActionMsg) */
function seedReady(view: Record<string, unknown>, afterActionMsg: unknown = null): void {
  stateSlots[0] = { value: "ready" };
  stateSlots[1] = { value: view };
  stateSlots[2] = { value: afterActionMsg };
}

describe("APPLICATION_STATUS_LABELS — ป้ายไทยครบ 3 สถานะ", () => {
  it("pending/approved/rejected มี label ไทย", () => {
    expect(APPLICATION_STATUS_LABELS.pending.label).toBe("รอเจ้าหน้าที่ตรวจสอบ");
    expect(APPLICATION_STATUS_LABELS.approved.label).toBe("ผ่านการตรวจสอบ");
    expect(APPLICATION_STATUS_LABELS.rejected.label).toBe("ไม่ผ่านการตรวจสอบ");
  });
});

describe("formatThaiDateTime", () => {
  it("รูปแบบไทย (พ.ศ.) และค่าไม่ถูกต้องคืนค่าเดิม", () => {
    expect(formatThaiDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("LicenseStatusCard — เรนเดอร์ตาม state", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("เริ่มต้น → กำลังโหลด", () => {
    expect(textAll(renderCard())).toContain("กำลังโหลดสถานะใบอนุญาต...");
  });

  it("phase=error → alert + retry เรียก GET ใหม่", async () => {
    stateSlots[0] = { value: "error" };
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        application: null,
        license: null,
        canResubmit: true,
      }),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderCard();
    expect(textAll(tree)).toContain("โหลดสถานะใบอนุญาตไม่สำเร็จ");
    clickElement(findByTestId(tree, "license-retry"));
    await drain();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/me/license");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");
  });

  it("ไม่มีใบ/ไม่เคยยื่น + canResubmit → ข้อความว่าง + ฟอร์มยื่นแสดง", () => {
    seedReady({ application: null, license: null, canResubmit: true });
    const tree = renderCard();
    expect(textAll(tree)).toContain("ยังไม่มีใบอนุญาตที่ได้รับการยืนยัน");
    expect(textAll(tree)).toContain("ยังไม่เคยยื่นคำขอ");
    expect(resubmitFormOf(tree)).toBeDefined();
    expect(findByTestId(tree, "license-application-status")).toBeUndefined();
  });

  it("pending → ป้ายรอตรวจสอบ · canResubmit=false → ไม่มีฟอร์มยื่น", () => {
    seedReady({
      application: { status: "pending", submittedAt: ISO_1, decidedAt: null, rejectedReason: null },
      license: null,
      canResubmit: false,
    });
    const tree = renderCard();
    const badge = findByTestId(tree, "license-application-status");
    expect(textOf(badge as ElementNode)).toBe("รอเจ้าหน้าที่ตรวจสอบ");
    expect(resubmitFormOf(tree)).toBeUndefined();
  });

  it("rejected + เหตุผล → แผงเหตุผลแสดงข้อความ BFF + ฟอร์มยื่นแสดง", () => {
    seedReady({
      application: {
        status: "rejected",
        submittedAt: ISO_1,
        decidedAt: ISO_2,
        rejectedReason: "เอกสารไม่ชัดเจน",
      },
      license: null,
      canResubmit: true,
    });
    const tree = renderCard();
    expect(textOf(findByTestId(tree, "license-application-status") as ElementNode)).toBe(
      "ไม่ผ่านการตรวจสอบ",
    );
    expect(textAll(tree)).toContain("เหตุผลที่ไม่ผ่านการตรวจสอบ");
    expect(textAll(tree)).toContain("เอกสารไม่ชัดเจน");
    expect(resubmitFormOf(tree)).toBeDefined();
  });

  it("approved + ใบ verified → license-current-no แสดงเลขเต็ม + ผ่านการตรวจสอบ", () => {
    seedReady({
      application: {
        status: "approved",
        submittedAt: ISO_1,
        decidedAt: ISO_2,
        rejectedReason: null,
      },
      license: { licenseNo: "1234567", verifiedAt: ISO_2 },
      canResubmit: true,
    });
    const tree = renderCard();
    expect(textOf(findByTestId(tree, "license-current-no") as ElementNode)).toBe("1234567");
    expect(textOf(findByTestId(tree, "license-application-status") as ElementNode)).toBe(
      "ผ่านการตรวจสอบ",
    );
    expect(textAll(tree)).toContain("ยืนยันเมื่อ");
    expect(resubmitFormOf(tree)).toBeDefined();
  });

  it("ยื่นฟอร์มสำเร็จ (onSubmitted) → ข้อความรอตรวจ role=status + โหลดสถานะใหม่", async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope({
        application: { status: "pending", submittedAt: ISO_1, decidedAt: null, rejectedReason: null },
        license: null,
        canResubmit: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    seedReady({ application: null, license: null, canResubmit: true });
    const tree = renderCard();
    const form = resubmitFormOf(tree);
    (form?.props.onSubmitted as (() => void) | undefined)?.();
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = textAll(renderCard());
    expect(after).toContain(
      "ส่งคำขอเรียบร้อยแล้ว — เจ้าหน้าที่จะตรวจสอบและแจ้งผลการพิจารณาให้ท่านทราบ",
    );
    const status = findByTestId(renderCard(), "license-after-action");
    expect(status?.props.role).toBe("status");
  });
});
