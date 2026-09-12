/**
 * test-tree — ตัวช่วยเดิน element tree ของ Server Component ใน vitest (node env)
 *
 * โมดูลนี้ไว้ใช้เฉพาะใน test (ไม่ใช่ runtime code) — เรียก Server Component เป็น
 * ฟังก์ชันตรง ๆ ตามแบบ PB-2 แล้วเดินต้นไม้ด้วยตัวช่วยชุดนี้:
 * - resolveNode: เรียก function component element ซ้ำจนเจอ host element (component
 *   ที่เรียกตรง ๆ ไม่ได้ เช่น next/link ที่ต้องการ router context — คง element เดิมไว้
 *   ไม่พัง และ countWhere ยังอ่าน props ของ element นั้นได้ เช่น href)
 * - textOf: รวบยอดข้อความทั้งต้นไม้ — ใช้ตรวจข้อความไทยที่เรนเดอร์
 * - countWhere: นับจำนวนโหนดที่ตรงเงื่อนไข (เช่น role="progressbar", href)
 */

/** รูป element ย่อ — เฉพาะส่วนที่ตัวเดินต้นไม้ใช้ */
interface ElementLike {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

/** เรียก function component element ให้เป็น element tree ข้างใน (จนกว่าจะเจอ host element) */
export function resolveNode(node: unknown, depth = 0): unknown {
  if (depth < 10 && typeof node === "object" && node !== null && "props" in node) {
    const el = node as ElementLike;
    if (typeof el.type === "function") {
      try {
        return resolveNode((el.type as (p: Record<string, unknown>) => unknown)(el.props), depth + 1);
      } catch {
        // component ที่เรียกตรง ๆ ไม่ได้ (เช่น next/link) — คง element เดิมไว้
        return node;
      }
    }
  }
  return node;
}

/** รวบยอดข้อความทั้งต้นไม้องค์ประกอบ — ใช้ตรวจข้อความไทยที่เรนเดอร์ */
export function textOf(input: unknown): string {
  const node = resolveNode(input);
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { props: { children?: unknown } }).props;
    const children = props?.children;
    if (Array.isArray(children)) {
      return children.map(textOf).join("");
    }
    return textOf(children);
  }
  return "";
}

/** รวบนับจำนวนโหนดที่ตรงเงื่อนไข (เช่น role=progressbar) */
export function countWhere(
  input: unknown,
  match: (props: Record<string, unknown>) => boolean,
): number {
  const node = resolveNode(input);
  if (typeof node !== "object" || node === null || !("props" in node)) {
    return 0;
  }
  const el = node as ElementLike;
  let total = match(el.props) ? 1 : 0;
  const children = el.props["children"];
  if (Array.isArray(children)) {
    total += children.reduce((sum: number, child) => sum + countWhere(child, match), 0);
  } else if (typeof children === "object" && children !== null) {
    total += countWhere(children, match);
  }
  return total;
}
