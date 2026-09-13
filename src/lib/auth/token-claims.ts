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
 * - gate r2 MINOR-2: `accessTokenFromAuthCookie` อ่าน token จาก cookie ตรง ๆ
 *   (รองจาก SDK getSession ที่อาจยิง refresh ผ่าน network ก่อนนับ quota)
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

// ─── อ่าน access token จาก cookie ตรง ๆ (gate r2 MINOR-2) ────────────────────

/**
 * สูตรชื่อ cookie ของ ssr.ts:169 (supabase-js) — `sb-<host ต้นทาง>-auth-token`
 * (dev = http://kong:8000 → `sb-kong-auth-token`)
 */
export function authCookieBaseName(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]!}-auth-token`;
}

/** แยก cookie header เป็น map (ชื่อ → ค่า) — ทนช่องว่างรอบ ๆ และค่าที่มี '='  */
function cookieMapOf(cookieHeader: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== "") {
      map.set(name, value);
    }
  }
  return map;
}

/**
 * access token จาก auth cookie โดยไม่ผ่าน SDK — getSession() ของ @supabase/ssr
 * เช็ค `expires_at` และยิง refresh ผ่าน network เมื่อใกล้หมดอายุ (auth-js
 * GoTrueClient) จึงใช้เป็น "การอ่านคีย์รองก่อนนับ quota" ไม่ได้ · อ่านเองแทน:
 * ค่า cookie ของ @supabase/ssr (cookieEncoding base64) = `base64-` + base64url
 * ของ JSON session · session ยาวโดนแบ่งเป็น chunk `<base>.0`, `<base>.1`, ...
 * — SDK ใส่ prefix `base64-` **ครั้งเดียวก่อนแบ่ง chunk** (cookies.ts:
 * `encoded = BASE64_PREFIX + …` แล้ว createChunks) ดังนั้น prefix อยู่ที่หัว
 * ของ chunk `.0` เท่านั้น · การอ่านตาม SDK (chunker combineChunks): อ่าน `.0`
 * เรียงขึ้นไปจนพบเลขที่หาย **หยุด** ที่ช่องว่างแรก
 * - ผิดรูป/ไม่มี cookie/decode ไม่ได้ = null (ไม่ throw) — ผู้เรียก fallback เอง
 */
export function accessTokenFromAuthCookie(
  cookieHeader: string | null,
  supabaseUrl: string,
): string | null {
  if (cookieHeader === null || cookieHeader === "") {
    return null;
  }
  const base = authCookieBaseName(supabaseUrl);
  const map = cookieMapOf(cookieHeader);
  let encoded: string | null = null;
  if (map.has(base)) {
    encoded = map.get(base) ?? null;
  } else {
    // chunked — อ่าน `.0`, `.1`, ... ตามลำดับจนพบเลขที่หาย (แบบ combineChunks
    // ของ SDK — หยุดที่ช่องว่างแรก ไม่รวมเลขกระโดด) แล้วต่อค่าดิบทั้งหมดก่อน
    // strip prefix ครั้งเดียว (prefix อยู่ที่หัว chunk .0 เท่านั้น)
    const chunks: string[] = [];
    for (let i = 0; ; i += 1) {
      const chunk = map.get(`${base}.${i}`);
      if (chunk === undefined) {
        break;
      }
      chunks.push(chunk);
    }
    if (chunks.length > 0) {
      encoded = chunks.join("");
    }
  }
  if (encoded === null) {
    return null;
  }
  const body = encoded.startsWith("base64-") ? encoded.slice("base64-".length) : encoded;
  if (body === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const token = (parsed as Record<string, unknown>)["access_token"];
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}
