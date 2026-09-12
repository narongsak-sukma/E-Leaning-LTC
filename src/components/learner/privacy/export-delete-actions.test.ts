/**
 * export-delete-actions.test — behavioral test ของ ExportDeleteActions
 * (D-p5-13 items 3-4 · SEC-011/IDENT-008 · lane E) — แบบแผน notification-bell.test.ts:
 * node env เรียก component ตรง ๆ + state shim · ConfirmModal (components/admin — ใช้ซ้ำ
 * read-only) เรนเดอร์ inline ได้ใน node (ไม่ใช้ portal)
 *
 * ลำดับ useState (ผูกกับ test): 1 exportBusy · 2 exportStatus · 3 deleteBusy ·
 * 4 deleteStatus · 5 dialogOpen
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

import { ConfirmModal } from "@/components/admin/ConfirmModal";

import {
  DELETE_CONFIRM_WARNING,
  DELETE_PENDING_TEXT,
  EXPORT_PENDING_TEXT,
  ExportDeleteActions,
  actionErrorText,
  envelopeMessageOf,
  GENERIC_TRANSPORT_MESSAGE,
} from "./export-delete-actions";

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

function renderActions(): ElementNode {
  stateCursor = 0;
  return ExportDeleteActions() as unknown as ElementNode;
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

/** envelope 202 {data:...} ของ export */
function ackEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 202,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** response error envelope — ใส่/ไม่ใส่ message ได้ (bare = ไม่มี code+message) */
function errorResponse(status: number, code: string, message?: string): Response {
  const envelope: Record<string, unknown> = message === undefined ? {} : { code, message };
  return new Response(JSON.stringify({ error: envelope }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** element ของ ConfirmModal (direct-call: ไม่ render ลูก — อ่าน/เรียกผ่าน props แทน) */
function modalOf(tree: ElementNode): ElementNode | undefined {
  return elementsOf(tree).find((element) => element.type === ConfirmModal);
}

function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

describe("ข้อความคงที่ตาม D-p5-13", () => {
  it("EXPORT_PENDING_TEXT ตามข้อความกำหนดเป๊ะ", () => {
    expect(EXPORT_PENDING_TEXT).toBe(
      "กำลังเตรียมไฟล์ — ระบบจะแจ้งทางอีเมลและแจ้งเตือนในระบบเมื่อพร้อม พร้อมลิงก์ดาวน์โหลดที่ใช้ได้ 7 วัน",
    );
  });

  it("DELETE_PENDING_TEXT ตามข้อความกำหนดเป๊ะ", () => {
    expect(DELETE_PENDING_TEXT).toBe(
      "โปรดตรวจอีเมลเพื่อยืนยันการลบบัญชี (ลิงก์มีอายุ 24 ชั่วโมง)",
    );
  });

  it("DELETE_CONFIRM_WARNING เตือน retention ผลสอบ/ประวัติการตรวจสอบ", () => {
    expect(DELETE_CONFIRM_WARNING).toContain("ผลการสอบและประวัติการตรวจสอบถูกเก็บตามกฎหมาย");
    expect(DELETE_CONFIRM_WARNING).toContain("ถาวร");
  });
});

describe("actionErrorText / envelopeMessageOf", () => {
  it("envelope มีข้อความเฉพาะ → ใช้ข้อความจาก BFF", () => {
    const error = { code: "HTTP_409", status: 409, message: "มีคำขอยืนยันอยู่" };
    expect(envelopeMessageOf(error)).toBe("มีคำขอยืนยันอยู่");
    expect(actionErrorText(error, "fallback")).toBe("มีคำขอยืนยันอยู่");
  });

  it("message = fallback กลางของขนส่ง → ถือว่าไม่มีข้อความเฉพาะ", () => {
    const error = { code: "HTTP_409", status: 409, message: GENERIC_TRANSPORT_MESSAGE };
    expect(envelopeMessageOf(error)).toBeNull();
    expect(actionErrorText(error, "fallback ไทย")).toBe("fallback ไทย");
  });

  it("ไม่มี message → fallback", () => {
    expect(envelopeMessageOf({})).toBeNull();
    expect(actionErrorText(undefined, "fallback")).toBe("fallback");
  });
});

describe("ExportDeleteActions — เรนเดอร์และ flow", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("เริ่มต้น: ปุ่ม export/delete อยู่ · ยังไม่มี dialog และไม่มีแผงสถานะ", () => {
    const tree = renderActions();
    expect(findByTestId(tree, "privacy-export")).toBeDefined();
    expect(findByTestId(tree, "privacy-delete")).toBeDefined();
    expect(findByTestId(tree, "privacy-export-status")).toBeUndefined();
    expect(findByTestId(tree, "privacy-delete-status")).toBeUndefined();
    expect(elementsOf(tree).some((element) => element.props.role === "dialog")).toBe(false);
  });

  it("export สำเร็จ (202) → GET /profile/export + ข้อความกำลังเตรียมไฟล์ role=status", async () => {
    stubWindow();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ackEnvelope({ jobId: "job-1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-export"));
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/profile/export");
    expect(init.method).toBe("GET");
    const after = textAll(renderActions());
    expect(after).toContain(EXPORT_PENDING_TEXT);
    const status = findByTestId(renderActions(), "privacy-export-status");
    expect(status?.props.role).toBe("status");
  });

  it("export 409 มีข้อความจาก BFF → แสดงข้อความ envelope", async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(409, "ERR-CONFLICT-001", "มีคำขอส่งออกที่ยังไม่เสร็จ"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-export"));
    await drain();
    const after = textAll(renderActions());
    expect(after).toContain("มีคำขอส่งออกที่ยังไม่เสร็จ");
    const status = findByTestId(renderActions(), "privacy-export-status");
    expect(status?.props.role).toBe("alert");
  });

  it("export 409 แบบ bare (ไม่มี code/message) → fallback ไทยตาม code HTTP_409", async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(409, "HTTP_409"));
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-export"));
    await drain();
    expect(textAll(renderActions())).toContain(
      "คุณมีคำขอส่งออกที่กำลังดำเนินการอยู่แล้ว กรุณารอการแจ้งเตือนเมื่อไฟล์พร้อม",
    );
  });

  it("export 429 แบบ bare → fallback ไทยตาม code HTTP_429", async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429, "HTTP_429"));
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-export"));
    await drain();
    expect(textAll(renderActions())).toContain(
      "ท่านเพิ่งขอส่งออกข้อมูลไป ระบบให้ขอได้ทุก 24 ชั่วโมง กรุณาลองใหม่ภายหลัง",
    );
  });

  it("ลบ: ปุ่มเปิด ConfirmModal (คำเตือน retention) · ยกเลิกปิดโดยไม่เรียก API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-delete"));
    const opened = renderActions();
    const modal = modalOf(opened);
    expect(modal).toBeDefined();
    expect(modal?.props.open).toBe(true);
    expect(modal?.props.title).toBe("ยืนยันการขอลบบัญชี");
    expect(modal?.props.description).toBe(DELETE_CONFIRM_WARNING);
    expect(modal?.props.confirmLabel).toBe("ยืนยันขอลบบัญชี");
    (modal?.props.onClose as (() => void) | undefined)?.();
    const closed = renderActions();
    expect(modalOf(closed)?.props.open).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ลบสำเร็จ (202) → POST /profile/delete + ข้อความตรวจอีเมล role=status + ปิด dialog", async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { token_expires_in_hours: 24 } }), {
        status: 202,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-delete"));
    const opened = renderActions();
    const modal = modalOf(opened);
    expect(modal?.props.open).toBe(true);
    (modal?.props.onConfirm as (() => void) | undefined)?.();
    await drain();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/profile/delete");
    expect(init.method).toBe("POST");
    const after = textAll(renderActions());
    expect(after).toContain(DELETE_PENDING_TEXT);
    const status = findByTestId(renderActions(), "privacy-delete-status");
    expect(status?.props.role).toBe("status");
    expect(modalOf(renderActions())?.props.open).toBe(false);
  });

  it("ลบ 403 guard บทบาท (bare) → fallback ไทยตาม code HTTP_403", async () => {
    stubWindow();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403, "HTTP_403"));
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderActions();
    clickElement(findByTestId(tree, "privacy-delete"));
    const opened = renderActions();
    (modalOf(opened)?.props.onConfirm as (() => void) | undefined)?.();
    await drain();
    expect(textAll(renderActions())).toContain(
      "บัญชีเจ้าหน้าที่หรือผู้สอนต้องขอลบผ่านผู้ดูแลระบบเท่านั้น",
    );
    const status = findByTestId(renderActions(), "privacy-delete-status");
    expect(status?.props.role).toBe("alert");
  });
});
