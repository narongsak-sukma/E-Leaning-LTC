/**
 * license-resubmit-form.test — behavioral test ของ LicenseResubmitForm (D-p5-4 · lane E)
 * (node env: เรียก component ตรง ๆ + state shim — ลำดับ useState ผูกกับ test:
 * 1 licenseNo · 2 file · 3 busy · 4 fieldError · 5 formError)
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

import { LICENSE_FILE_ACCEPT, LicenseResubmitForm } from "./license-resubmit-form";

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

function renderForm(): ElementNode {
  stateCursor = 0;
  return LicenseResubmitForm({ onSubmitted: onSubmittedMock }) as unknown as ElementNode;
}

let onSubmittedCalls = 0;
function onSubmittedMock(): void {
  onSubmittedCalls += 1;
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

/** พิมพ์ลงช่องเลขใบอนุญาตผ่าน onChange */
function typeLicenseNo(tree: ElementNode, value: string): void {
  const input = findByTestId(tree, "license-no-input");
  (input?.props.onChange as ((event: unknown) => void) | undefined)?.({ target: { value } });
}

/** เลือกไฟล์ผ่าน onChange ของ input file */
function chooseFile(tree: ElementNode, file: File | null): void {
  const input = findByTestId(tree, "license-file-input");
  const files = file === null ? null : [file];
  (input?.props.onChange as ((event: unknown) => void) | undefined)?.({ target: { files } });
}

/** ส่งฟอร์มผ่าน onSubmit (root ของ component คือ <form>) */
function submitForm(tree: ElementNode): void {
  const form = elementsOf(tree).find((element) => element.type === "form");
  (form?.props.onSubmit as ((event: unknown) => void) | undefined)?.({
    preventDefault: (): void => {},
  });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function okAck(): Response {
  return new Response(JSON.stringify({ data: null }), {
    status: 202,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

function pdfFile(): File {
  return new File(["pdf-bytes"], "license.pdf", { type: "application/pdf" });
}

describe("LicenseResubmitForm — validation ก่อนส่ง", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
    onSubmittedCalls = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("เริ่มต้น: ฟอร์มพร้อม · accept ตามกฎไฟล์ · ปุ่มส่งยังกดได้", () => {
    const tree = renderForm();
    expect(findByTestId(tree, "license-no-input")).toBeDefined();
    const fileInput = findByTestId(tree, "license-file-input");
    expect(fileInput?.props.accept).toBe(".jpg,.jpeg,.png,.pdf");
    expect(LICENSE_FILE_ACCEPT).toBe(".jpg,.jpeg,.png,.pdf");
    const submit = findByTestId(tree, "license-submit");
    expect(submit?.props.disabled).toBe(false);
    expect(textOf(submit as ElementNode)).toBe("ส่งคำขอ");
    expect(findByTestId(tree, "license-form-error")).toBeUndefined();
  });

  it("เลขไม่ครบ 6-9 หลัก → ข้อความไทย role=alert · ไม่เรียก fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderForm();
    typeLicenseNo(tree, "12345");
    submitForm(renderForm());
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSubmittedCalls).toBe(0);
    const error = findByTestId(renderForm(), "license-form-error");
    expect(textOf(error as ElementNode)).toBe("เลขที่ใบอนุญาตต้องเป็นตัวเลข 6-9 หลัก");
    expect(error?.props.role).toBe("alert");
  });

  it("ไม่แนบไฟล์ → ข้อความไทย", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderForm();
    typeLicenseNo(tree, "1234567");
    submitForm(renderForm());
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textAll(renderForm())).toContain("กรุณาแนบไฟล์หลักฐาน (JPG, PNG หรือ PDF)");
  });

  it("ไฟล์ชนิดไม่อนุญาต → ข้อความไทย", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderForm();
    typeLicenseNo(tree, "1234567");
    chooseFile(tree, new File(["MZ"], "v.exe", { type: "application/x-msdownload" }));
    submitForm(renderForm());
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textAll(renderForm())).toContain("ชนิดไฟล์ต้องเป็น JPG, PNG หรือ PDF เท่านั้น");
  });

  it("busy ค้าง → กดส่งไม่ทำอะไร", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stateSlots[2] = { value: true };
    const tree = renderForm();
    typeLicenseNo(tree, "1234567");
    chooseFile(tree, pdfFile());
    submitForm(renderForm());
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LicenseResubmitForm — ส่งคำขอผ่าน BFF", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
    onSubmittedCalls = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ส่งสำเร็จ (202) → PUT multipart license_no+file · รีเซ็ตฟอร์ม + onSubmitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okAck());
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderForm();
    typeLicenseNo(tree, "1234567");
    chooseFile(tree, pdfFile());
    submitForm(renderForm());
    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v1/me/license");
    expect(init.method).toBe("PUT");
    const form = init.body as FormData;
    expect(form.get("license_no")).toBe("1234567");
    expect((form.get("file") as File).name).toBe("license.pdf");

    const after = renderForm();
    expect(findByTestId(after, "license-no-input")?.props.value).toBe("");
    expect(findByTestId(after, "license-form-error")).toBeUndefined();
    expect(onSubmittedCalls).toBe(1);
  });

  it("409 (มี pending) → ข้อความ envelope role=alert · คงค่าที่กรอก · ไม่เรียก onSubmitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(409, "ERR-CONFLICT-001", "มีคำขอที่ยังถูกตรวจสอบอยู่"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderForm();
    typeLicenseNo(tree, "1234567");
    chooseFile(tree, pdfFile());
    submitForm(renderForm());
    await drain();

    const error = findByTestId(renderForm(), "license-form-error");
    expect(textOf(error as ElementNode)).toBe("มีคำขอที่ยังถูกตรวจสอบอยู่");
    expect(error?.props.role).toBe("alert");
    expect(findByTestId(renderForm(), "license-no-input")?.props.value).toBe("1234567");
    expect(onSubmittedCalls).toBe(0);
  });

  it("network ล้ม → ข้อความกลางไทย (ไม่ crash)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    const tree = renderForm();
    typeLicenseNo(tree, "1234567");
    chooseFile(tree, pdfFile());
    submitForm(renderForm());
    await drain();
    expect(textAll(renderForm())).toContain("ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง");
  });
});
