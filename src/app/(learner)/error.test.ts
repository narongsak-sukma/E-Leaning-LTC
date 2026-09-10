/**
 * unit tests — error boundary ของ (learner) (PB-4)
 * เรนเดอร์ด้วย renderToStaticMarkup (node) ตาม pattern ของ (admin)/layout.test.ts —
 * ตรวจ: ข้อความไทย + role="alert" · ไม่ leak error.message/digest (SDS) · ปุ่ม "ลองใหม่" เรียก reset()
 * (component มี useEffect — จึงเรียกผ่าน Capture wrapper ใน SSR pass เพื่อให้ hook อยู่ใน context ที่ถูกต้อง)
 */
import type { ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import LearnerError from "./error";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/** เรนเดอร์ผ่าน SSR แล้วคืน html + element tree (เรียก component ใน render context — hook ถูก no-op อย่างถูกต้อง) */
function renderError(props: ErrorProps): { element: ReactElement; html: string } {
  let element: ReactElement | undefined;
  function Capture(): ReactElement {
    element = LearnerError(props);
    return element;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  if (element === undefined) throw new Error("Capture ไม่ถูกเรียกใน SSR pass");
  return { element, html };
}

/** เดิน element tree หา onClick แรกที่พบ (ปุ่ม "ลองใหม่") — static markup ไม่มี DOM ให้คลิกจริง */
function findOnClick(node: unknown): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findOnClick(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { props?: { children?: unknown; onClick?: unknown } }).props;
    if (props === undefined) return undefined;
    if (typeof props.onClick === "function") return props.onClick as () => void;
    return findOnClick(props.children);
  }
  return undefined;
}

describe("(learner)/error.tsx — error boundary ไทย (PB-4)", () => {
  const error = Object.assign(new Error("internal-detail-must-not-appear"), {
    digest: "digest-must-not-appear",
  });

  it("แสดงข้อความไทย ไม่ใช่ศัพท์เทคนิค + role=alert + ช่องทางช่วยเหลือ (DS §5.2/§9)", () => {
    const { html } = renderError({ error, reset: () => {} });
    expect(html).toContain('role="alert"');
    expect(html).toContain("เกิดข้อผิดพลาด");
    expect(html).toContain("เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง");
    expect(html).toContain("ลองใหม่");
    expect(html).toContain("0 2351 1128");
  });

  it("ไม่แสดง error.message และ digest บนหน้าจอ (SDS — ไม่ leak)", () => {
    const { html } = renderError({ error, reset: () => {} });
    expect(html).not.toContain("internal-detail-must-not-appear");
    expect(html).not.toContain("digest-must-not-appear");
  });

  it('ปุ่ม "ลองใหม่" ผูกกับ reset() ที่ส่งเข้ามา', () => {
    const reset = vi.fn();
    const { element } = renderError({ error, reset });
    const onClick = findOnClick(element);
    expect(typeof onClick).toBe("function");
    onClick?.();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
