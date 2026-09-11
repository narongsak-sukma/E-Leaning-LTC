/**
 * transport — ชั้นขนส่ง JSON กลางของฝั่งแอป (ผู้เรียน/การสอบ/ประกาศนียบัตร) เมื่อเรียก BFF
 * (Wave E · PB-19 — รวมศูนย์แกน transport ที่เคยซ้ำ 3 สำเนาใน learning.ts / certificates.ts /
 * exam-api.ts ให้เหลือจุดเดียว กัน drift แบบเดียวกับที่ C-11 รวมศูนย์ response และ parser
 * ของ RPC ไว้ที่ไฟล์ชุดนี้ src/lib/api/)
 *
 * - แกนที่รวมศูนย์: absolute-origin + cookie forward (ขา server) + header x-ltc-bff-internal
 *   **เฉพาะฝั่ง server** (guard `typeof window` — ขาในของ BFF: middleware เห็น header นี้แล้ว
 *   จะไม่หมุน token ใน request นั้น เพราะ Set-Cookie ของขาในไม่มีทางถึง browser —
 *   gate-cleanup r1 M1) + `cache: no-store` + แกะ error envelope §1.3 → ApiError
 *   (code/message ไทยจาก BFF · parse body ไม่ได้/network fail → ERR-SYS-001 แบบ fail-closed)
 * - แกะ envelope ด้วยเช็คแบบมือ (isRecord + typeof) ไม่ใช้ zod — คงพฤติกรรมเดิมของ 3 สำเนา
 *   เป๊ะ และควบคุม fail-closed รายกรณีเอง (D43 L1: zod v4 parent ไม่ cascade strict)
 * - โมดูลนี้ฝั่ง "ผู้เรียก" ใช้ร่วม client + server ได้ (เช่น logout keepalive จาก browser) —
 *   ส่วนที่ server-only คือขาประกาศ x-ltc-bff-internal ข้างต้นเท่านั้น · ฝั่ง "ผู้รับ" (route
 *   handlers ของ BFF) ใช้ชุด response.ts / rpc-errors.ts ของ C-11 ในไดเรกทอรีเดียวกัน
 * - ผู้ใช้ปัจจุบัน: learning.ts (re-export ApiError / FetchCallOptions), certificates.ts
 *   (เรียกตรง), exam-api.ts (ห่อ fetchJson แล้ว map ApiError → ExamApiError ของตน)
 */

/** ตัวเลือกกลางของการเรียก API ผ่าน transport — ใช้ร่วม client + server */
export interface TransportCallOptions {
  /** origin สัมบูรณ์ เช่น https://learn.lawcouncil.go.th — บังคับเมื่อเรียกจากฝั่ง server */
  readonly origin?: string;
  /** ค่า header Cookie ที่ forward จาก request ปัจจุบัน (server เท่านั้น) */
  readonly cookieHeader?: string;
}

/**
 * error ฝั่ง client ของ transport กลาง — code อ้างทะเบียน src/lib/errors (API-SPECIFICATION
 * §1.3) · ข้อความไทยมาจาก error envelope ของ BFF · learning.ts re-export คลาสนี้ต่อในชื่อ
 * เดิม (ApiError — ตำแหน่ง import ของ consumer ทุกตัวไม่เปลี่ยน) ส่วน exam-api.ts map
 * เป็น ExamApiError ของตนเองต่อหลังเรียก
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

/** ข้อความกลางเมื่อ BFF ไม่ได้แนบข้อความมาให้ (envelope เสีย/parse ไม่ได้/network ล้ม) */
const TRANSPORT_FALLBACK_MESSAGE = "ไม่สามารถติดต่อระบบได้ กรุณาลองใหม่อีกครั้ง";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** องค์ประกอบของ request — superset ของทั้ง 3 สำเนาเดิม (method · body · keepalive · headers เสริม) */
export interface TransportRequestInit {
  readonly method: "GET" | "POST";
  /** payload ของ POST — JSON.stringify เองเมื่อไม่เป็น undefined (POST ไม่มี body ได้ เช่น enroll) */
  readonly body?: unknown;
  /** true = ขอ keepalive ต่อ fetch (heartbeat วิดีโอ/logout ที่ต้องยิงแล้วปล่อยหน้าได้) */
  readonly keepalive?: boolean;
  /**
   * header เสริมราย call (เช่น Idempotency-Key ของเส้นการสอบ §3.5) — merge **เป็นลำดับสุดท้าย**
   * (Object.assign ทับ default ได้ ตามพฤติกรรมเดิมของ examRequest)
   */
  readonly headers?: Record<string, string>;
}

/** ผลสำเร็จแบบดิบ — ผู้เรียก (learning/certificates) ตรวจสัญญาข้อมูลเองต่อจากตรงนี้ */
export interface TransportResult {
  readonly status: number;
  /** body ที่ parse แล้ว · 204 หรือ parse ไม่ได้ = null */
  readonly body: unknown;
}

function resolveOrigin(options?: TransportCallOptions): string {
  if (options?.origin !== undefined && options.origin.length > 0) {
    return options.origin;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  throw new Error("ต้องระบุ origin ใน TransportCallOptions เมื่อเรียก API จากฝั่ง server (RSC)");
}

/**
 * เรียก BFF แบบ JSON — จุดรวม transport ของทุก data layer ฝั่ง UI (PB-19)
 *
 * - origin: options.origin ก่อน แล้ว window.location.origin (browser) — server ไม่ส่ง = throw
 *   (programming error ของ RSC ไม่ใช่ error envelope)
 * - headers: `accept` เสมอ · POST เพิ่ม `content-type: application/json; charset=utf-8` ·
 *   cookieHeader (ยาว > 1) ส่งต่อเป็น `cookie` · ขา server (`typeof window === "undefined"`)
 *   ประกาศ `x-ltc-bff-internal: 1` (ขาใน — middleware ไม่หมุน token) · headers เสริมราย call
 *   มาทับท้ายเสมอ
 * - fetch: credentials same-origin + cache no-store · body เป็น JSON · keepalive ตาม option
 * - ผล: 204 → { status: 204, body: null } (ไม่อ่าน body — เช่น POST /auth/logout) · 2xx อื่น →
 *   { status, body } ดิบ · non-2xx / parse ไม่ได้ / network → ApiError (code จาก envelope
 *   §1.3 ถ้ามี ไม่งั้น `HTTP_<status>` · message จาก envelope ถ้ามี ไม่งั้นข้อความกลางไทย)
 */
export async function fetchJson(
  path: string,
  init: TransportRequestInit,
  options?: TransportCallOptions,
): Promise<TransportResult> {
  const origin = resolveOrigin(options);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.method === "POST") {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (options?.cookieHeader !== undefined && options.cookieHeader.length > 1) {
    headers.cookie = options.cookieHeader;
  }
  // ขาเรียกจาก server (RSC) ประกาศตัวเป็นขาใน — middleware เห็น header นี้แล้วจะไม่หมุน
  // token (Set-Cookie ของขาในไม่มีทางถึง browser — หมุนตรงนั้น = ทิ้ง rotation กลางอากาศ)
  // · เฉพาะฝั่ง server (guard typeof window) — โมดูลนี้ client ใช้ร่วมด้วย และขาบราวเซอร์คือขานอก
  if (typeof window === "undefined") {
    headers["x-ltc-bff-internal"] = "1";
  }
  if (init.headers !== undefined) {
    Object.assign(headers, init.headers);
  }
  const requestInit: RequestInit = {
    method: init.method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  };
  if (init.method === "POST" && init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }
  if (init.keepalive === true) {
    requestInit.keepalive = true;
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), requestInit);
  } catch {
    throw new ApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE);
  }
  if (response.status === 204) {
    return { status: 204, body: null };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = isRecord(body) && isRecord(body["error"]) ? body["error"] : null;
    const code =
      envelope !== null && typeof envelope["code"] === "string" && envelope["code"].length > 0
        ? envelope["code"]
        : `HTTP_${response.status}`;
    const message =
      envelope !== null &&
      typeof envelope["message"] === "string" &&
      envelope["message"].length > 0
        ? envelope["message"]
        : TRANSPORT_FALLBACK_MESSAGE;
    throw new ApiError(code, response.status, message);
  }
  return { status: response.status, body };
}
