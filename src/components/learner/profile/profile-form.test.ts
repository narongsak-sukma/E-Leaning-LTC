/**
 * profile-form.test — behavioral test ระดับ component/unit ของ ProfileForm
 * (แบบแผน notification-bell.test.ts — node env ไม่มี DOM: เรียก component ตรง ๆ โดย mock
 * useState/useEffect/useRef/useCallback ของ react ด้วยตัวเก็บ state จำลอง · ทดสอบ
 * validateProfileForm (pure) + เรนเดอร์ตาม state ที่กำหนดค่าล่วงหน้า + save flow)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ตัวยึดตำแหน่งของ hooks — vi.mock ถูก hoist ก่อนประกาศตัวแปรระดับ module จึงอ้างผ่าน
 * object นี้ (ตัวจริงติดตั้งท้ายไฟล์ ก่อน test ทำงาน)
 */
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
    // useEffect ไม่ทำงานในการเรนเดอร์ตรง (node env ไม่มี renderer) — no-op กัน invalid hook call
    useEffect: (): void => stateShim.useEffect(),
    // useRef/useCallback ต้อง mock ด้วย — hooks อื่นที่ไม่ผ่าน renderer จะ throw invalid hook call
    useRef: (initial: unknown) => stateShim.useRef(initial),
    useCallback: (fn: unknown) => stateShim.useCallback(fn),
  };
});

import { LOCALE_OPTIONS, ProfileForm, validateProfileForm } from "./profile-form";

/** node ใน element tree ที่ React.createElement (JSX) สร้าง (เอาเฉพาะที่ test ต้องอ่าน) */
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
function renderForm(): ElementNode {
  stateCursor = 0;
  return ProfileForm() as unknown as ElementNode;
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

/** ข้อความทั้ง tree — สำหรับ assert ข้อความใด ๆ ที่ต้องมี/ต้องไม่มี */
function textAll(tree: ElementNode): string {
  return elementsOf(tree).map(textOf).join("\n");
}

/** รอ async flow (fetch mock resolve เป็น microtask + setTimeout drain) */
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

/** window จำลอง — api.ts resolve origin จาก window.location.origin (node ไม่มีให้เอง) */
function stubWindow(): void {
  vi.stubGlobal("window", { location: { origin: "http://learner.test.local" } });
}

/** กดปุ่มผ่าน onClick (cast จาก unknown) */
function clickElement(element: ElementNode | undefined): void {
  (element?.props.onClick as (() => void) | undefined)?.();
}

/** ส่งฟอร์มผ่าน onSubmit (cast จาก unknown) */
function submitForm(tree: ElementNode): void {
  const form = elementsOf(tree).find((element) => element.type === "form");
  (form?.props.onSubmit as ((event: unknown) => void) | undefined)?.({
    preventDefault: (): void => {},
  });
}

/** profile จำลองตาม MeProfile หลัง GET /me */
function profileFixture(overrides?: Partial<{ firstName: string | null; lastName: string | null }>): Record<string, unknown> {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    email: "learner@test.local",
    displayName: "สมชาย ใจดี",
    roles: ["citizen"],
    mfaVerified: false,
    preferredLocale: "th",
    firstName: overrides?.firstName ?? null,
    lastName: overrides?.lastName ?? null,
  };
}

/** draft จำลอง (slot 3) */
function draftFixture(): Record<string, unknown> {
  return { displayName: "สมชาย ใจดี", phone: "0812345678", preferredLocale: "th" };
}

/** เติม slot "ready" ครบ 6 ช่อง (ตามลำดับ useState ของ ProfileForm) */
function seedReadyState(profile: Record<string, unknown>, draft: Record<string, unknown>): void {
  stateSlots[0] = { value: "ready" };
  stateSlots[1] = { value: profile };
  stateSlots[2] = { value: draft };
  stateSlots[3] = { value: false };
  stateSlots[4] = { value: null };
  stateSlots[5] = { value: {} };
}

describe("validateProfileForm — ตรวจฟอร์มฝั่ง client (mirror กฎ BFF)", () => {
  it("ค่าถูกต้องครบ → {} (ผ่าน)", () => {
    expect(
      validateProfileForm({ displayName: "สมชาย", phone: "0812345678", preferredLocale: "th" }),
    ).toEqual({});
  });

  it("display_name ว่าง/ช่องว่างเท่านั้น → ข้อความไทย", () => {
    expect(validateProfileForm({ displayName: "", phone: "", preferredLocale: "th" }).displayName).toBe(
      "กรุณากรอกชื่อที่ใช้แสดง",
    );
    expect(
      validateProfileForm({ displayName: "   ", phone: "", preferredLocale: "th" }).displayName,
    ).toBe("กรุณากรอกชื่อที่ใช้แสดง");
  });

  it("display_name ยาวเกิน 100 → ข้อความไทย", () => {
    expect(
      validateProfileForm({ displayName: "ก".repeat(101), phone: "", preferredLocale: "th" })
        .displayName,
    ).toBe("ชื่อที่ใช้แสดงยาวได้ไม่เกิน 100 อักขระ");
  });

  it("phone เว้นได้ · กรอกผิดรูปแบบ → ข้อความไทย", () => {
    expect(validateProfileForm({ displayName: "ก", phone: "", preferredLocale: "th" }).phone).toBeUndefined();
    expect(
      validateProfileForm({ displayName: "ก", phone: "abc", preferredLocale: "th" }).phone,
    ).toBe("เบอร์โทรศัพท์ต้องเป็นตัวเลข 7-20 หลัก (ใส่ + วงเล็บ หรือขีดได้)");
  });

  it("preferred_locale นอก th/en → ข้อความไทย", () => {
    expect(
      validateProfileForm({ displayName: "ก", phone: "", preferredLocale: "jp" }).preferredLocale,
    ).toBe("กรุณาเลือกภาษาที่ต้องการ");
  });
});

describe("LOCALE_OPTIONS", () => {
  it("มี th/en ครบตาม CHECK preferred_locale IN ('th','en')", () => {
    expect(LOCALE_OPTIONS.map((option) => option.value)).toEqual(["th", "en"]);
    expect(LOCALE_OPTIONS.map((option) => option.label)).toEqual(["ไทย", "อังกฤษ"]);
  });
});

describe("ProfileForm — เรนเดอร์ตาม state (เรียก component ตรง ๆ)", () => {
  beforeEach(() => {
    stateSlots = [];
    stateCursor = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("phase เริ่มต้น → แผงโหลด role=status", () => {
    const tree = renderForm();
    expect(textAll(tree)).toContain("กำลังโหลดข้อมูลโปรไฟล์...");
    const els = elementsOf(tree);
    const status = els.find((element) => element.props.role === "status");
    expect(status).toBeDefined();
  });

  it("phase=error → role=alert + ปุ่ม retry เรียก loadProfile ใหม่ (GET /me)", async () => {
    stateSlots[0] = { value: "error" };
    const fetchMock = vi.fn().mockResolvedValue(
      okEnvelope(profileFixture()),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);

    const tree = renderForm();
    expect(textAll(tree)).toContain("โหลดข้อมูลโปรไฟล์ไม่สำเร็จ");
    const retry = findByTestId(tree, "profile-retry");
    expect(retry).toBeDefined();
    clickElement(retry);
    await drain();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/me");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("GET");
  });

  it("phase=ready → อีเมลอ่านอย่างเดียว + ปุ่มบันทึก + ลิงก์หน้า privacy", () => {
    seedReadyState(profileFixture(), draftFixture());
    const tree = renderForm();

    const nameInput = findByTestId(tree, "profile-display-name");
    expect(nameInput).toBeDefined();
    expect(nameInput?.props.value).toBe("สมชาย ใจดี");
    const phoneInput = findByTestId(tree, "profile-phone");
    expect(phoneInput?.props.value).toBe("0812345678");
    const localeSelect = findByTestId(tree, "profile-locale");
    expect(localeSelect?.props.value).toBe("th");

    // อีเมล = อ่านอย่างเดียว (ไม่อยู่ในเขต self-edit)
    const els = elementsOf(tree);
    const emailInput = els.find((element) => element.props.id === "profile-email");
    expect(emailInput).toBeDefined();
    expect(emailInput?.props.readOnly).toBe(true);
    expect(emailInput?.props.disabled).toBe(true);

    const save = findByTestId(tree, "profile-save");
    expect(save?.props.disabled).toBe(false);
    expect(textOf(save as ElementNode)).toBe("บันทึก");

    const link = findByTestId(tree, "profile-privacy-link");
    expect(link?.props.href).toBe("/my/privacy");
    expect(textOf(link as ElementNode)).toBe("จัดการข้อมูลส่วนบุคคลและความยินยอม");
  });

  it("มี first/last_name → แผงข้อมูลนิติบุคคลอ่านอย่างเดียว + ข้อความชี้แจง · ไม่มี = ไม่แสดง", () => {
    seedReadyState(profileFixture({ firstName: "สมชาย", lastName: "ใจดี" }), draftFixture());
    const withNames = textAll(renderForm());
    expect(withNames).toContain("ชื่อ-นามสกุลตามทะเบียน (ข้อมูลนิติบุคคล)");
    expect(withNames).toContain("สมชาย ใจดี");
    expect(withNames).toContain("ข้อมูลนิติบุคคล — แก้ไขผ่านเจ้าหน้าที่ได้เท่านั้น");

    seedReadyState(profileFixture(), draftFixture());
    const withoutNames = textAll(renderForm());
    expect(withoutNames).not.toContain("ข้อมูลนิติบุคคล — แก้ไขผ่านเจ้าหน้าที่ได้เท่านั้น");
  });

  it("submit draft ไม่ผ่าน validate → แสดงข้อความรายฟิลด์ · ไม่เรียก fetch", async () => {
    const fetchMock = vi.fn();
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    seedReadyState(profileFixture(), { displayName: "  ", phone: "abc", preferredLocale: "th" });
    const tree = renderForm();

    submitForm(tree);
    await drain();

    expect(fetchMock).not.toHaveBeenCalled();
    const texts = textAll(renderForm());
    expect(texts).toContain("กรุณากรอกชื่อที่ใช้แสดง");
    expect(texts).toContain("เบอร์โทรศัพท์ต้องเป็นตัวเลข 7-20 หลัก (ใส่ + วงเล็บ หรือขีดได้)");
  });

  it("submit สำเร็จ → PATCH camelCase (phone ว่าง = ตัดออก) + ข้อความสำเร็จ + GET ซ้ำ", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okEnvelope(null)) // PATCH /me → 200
      .mockResolvedValueOnce(okEnvelope(profileFixture())); // GET /me ซ้ำ
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    seedReadyState(profileFixture(), { displayName: "สมชาย", phone: "", preferredLocale: "en" });
    renderForm();

    const tree = renderForm();
    submitForm(tree);
    await drain();

    const patchCall = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(patchCall[0])).toContain("/api/v1/me");
    expect(patchCall[1].method).toBe("PATCH");
    const body = JSON.parse(String(patchCall[1].body)) as Record<string, unknown>;
    expect(body).toEqual({ displayName: "สมชาย", preferredLocale: "en" });

    const texts = textAll(renderForm());
    expect(texts).toContain("บันทึกการเปลี่ยนแปลงโปรไฟล์เรียบร้อยแล้ว");
    const secondCall = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(secondCall[1].method).toBe("GET");
  });

  it("PATCH ล้ม (error envelope) → ข้อความ alert จาก BFF + saving คลาย", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      errorResponse(422, "ERR-VAL-001", "รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง"),
    );
    stubWindow();
    vi.stubGlobal("fetch", fetchMock);
    seedReadyState(profileFixture(), draftFixture());
    renderForm();

    const tree = renderForm();
    submitForm(tree);
    await drain();

    const texts = textAll(renderForm());
    expect(texts).toContain("รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง");
    const save = findByTestId(renderForm(), "profile-save");
    expect(save?.props.disabled).toBe(false);
  });
});
