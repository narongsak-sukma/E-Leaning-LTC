/**
 * token-claims — อ่าน claim จาก access token ของ GoTrue แบบ decode ในเครื่อง
 * (gate r1 M4/B1 ของ Wave G P1)
 *
 * - ใช้อ่าน **ตัวตน/หลักฐาน method** จาก token ที่ GoTrue ตรวจไปแล้วใน request
 *   เดียวกัน (PUT user / logout ผ่านไป = token นั้น valid ณ ตอนนั้น) — ต่างจาก
 *   `session.user` ใน cookie ที่เป็น JSON ฝังตัวแก้/ปลอมได้โดยไม่ผ่าน GoTrue
 * - **ไม่ใช่การตรวจลายเซ็น** (JWT ของ GoTrue เป็น HS256 ฝั่ง server เท่านั้นถอดได้ —
 *   ที่นี่แค่ decode payload) — ความถูกต้องของ token มาจากการที่ GoTrue ใช้มันผ่าน
 *   จริงใน request เดียวกัน เท่านั้น
 * - ห้าม log ค่า token/claim ทั้งฟัลด้วยเด็ดขาด (SDS §6.2)
 * - pure module (ไม่ import server-only) — unit test เรียกตรงได้
 */

/** uuid v4 เท่านั้น (ตรงแบบแผน sessionIdFromAccessToken ของ logout-all.ts) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** decode payload ของ JWT — ผิดรูป/ไม่ใช่ JSON = null (ไม่ throw) */
function payloadOf(accessToken: string): Record<string, unknown> | null {
  const part = accessToken.split(".")[1] ?? "";
  if (part === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    );
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** claim `sub` (user id) — uuid จริงเท่านั้น ไม่ใช่ = null */
export function subFromAccessToken(accessToken: string): string | null {
  const sub = payloadOf(accessToken)?.["sub"];
  return typeof sub === "string" && UUID_RE.test(sub) ? sub : null;
}

/**
 * ชุด method ของ claim `amr` (วิธีที่ได้มาซึ่ง session นี้) — null = decode ไม่ได้
 * หรือไม่มี amr · GoTrue v2.164 ใช้ค่าเช่น `password` · `otp` (ลิงก์ recovery/
 * magic link) · `totp` (probe จริง 2026-09-14: recovery = `otp` · refresh คง
 * method เดิมไว้)
 */
export function amrMethodsFromAccessToken(accessToken: string): readonly string[] | null {
  const amr = payloadOf(accessToken)?.["amr"];
  if (!Array.isArray(amr)) {
    return null;
  }
  const methods: string[] = [];
  for (const entry of amr) {
    if (typeof entry === "object" && entry !== null && "method" in entry) {
      const method = (entry as { method: unknown }).method;
      if (typeof method === "string") {
        methods.push(method);
      }
    }
  }
  return methods;
}
