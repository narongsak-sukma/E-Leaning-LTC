/**
 * errors — ทะเบียน error code กลาง (API-SPECIFICATION §2) — single source ชุดเดียวของ
 * { code, HTTP status, ข้อความไทย } ทุก endpoint ต้องอ้างจากที่นี่เท่านั้น
 * ห้ามคิด code นอกทะเบียร์ (SDS §6.1, D13-F12)
 */
export const ERROR_REGISTRY = {
  "ERR-AUTH-001": {
    httpStatus: 401,
    message: "ต้องเข้าสู่ระบบก่อนใช้บริการนี้",
  },
  "ERR-AUTH-002": {
    httpStatus: 401,
    message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
  },
  "ERR-AUTH-003": {
    httpStatus: 423,
    message: "บัญชีถูกล็อกชั่วคราว กรุณาลองใหม่ภายหลัง",
  },
  "ERR-AUTH-004": {
    httpStatus: 403,
    message: "กรุณายืนยันตัวตนสองชั้น (MFA) ก่อนดำเนินการต่อ",
  },
  "ERR-AUTH-005": {
    httpStatus: 400,
    message: "ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุ",
  },
  "ERR-RBAC-001": {
    httpStatus: 403,
    message: "คุณไม่มีสิทธิ์ดำเนินการนี้",
  },
  "ERR-VAL-001": {
    httpStatus: 400,
    message: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
  },
  "ERR-VAL-002": {
    httpStatus: 400,
    "message": "รูปแบบ Idempotency-Key ไม่ถูกต้อง",
  },
  "ERR-NF-001": {
    httpStatus: 404,
    message: "ไม่พบข้อมูลที่ต้องการ",
  },
  "ERR-RATE-001": {
    httpStatus: 429,
    message: "มีการเรียกใช้บ่อยเกินไป กรุณารอสักครู่",
  },
  "ERR-IDM-001": {
    httpStatus: 409,
    message: "คำขอนี้ถูกประมวลผลแล้ว (Idempotency-Key ซ้ำแต่ body ต่าง)",
  },
  "ERR-SYS-001": {
    httpStatus: 500,
    message: "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่",
  },
  "ERR-SYS-002": {
    httpStatus: 503,
    message: "ระบบไม่พร้อมให้บริการชั่วคราว",
  },
  "ERR-PRF-001": {
    httpStatus: 422,
    message: "เลขที่ใบอนุญาตนี้ถูกผูกกับบัญชีอื่นแล้ว",
  },
  "ERR-PRF-002": {
    httpStatus: 422,
    message: "เลขที่ใบอนุญาตไม่ผ่านการตรวจสอบรูปแบบ",
  },
  "ERR-CRS-001": {
    httpStatus: 404,
    message: "ไม่พบหลักสูตร หรือหลักสูตรยังไม่เผยแพร่",
  },
  "ERR-ENR-001": {
    httpStatus: 409,
    message: "คุณลงทะเบียนหลักสูตรนี้แล้ว",
  },
  "ERR-ENR-002": {
    httpStatus: 422,
    message: "หลักสูตรนี้จำกัดเฉพาะทนายความที่ยืนยันใบอนุญาตแล้ว",
  },
  "ERR-LRN-001": {
    httpStatus: 403,
    message: "ต้องลงทะเบียนหลักสูตรก่อนเรียน",
  },
  "ERR-LRN-002": {
    httpStatus: 422,
    message: "ยังเรียนบทก่อนหน้าไม่ครบตามเงื่อนไข",
  },
  "ERR-ASM-001": {
    httpStatus: 422,
    message: "คุณใช้จำนวนครั้งการสอบครบตามกติกาแล้ว",
  },
  "ERR-ASM-002": {
    httpStatus: 409,
    message: "มีการสอบที่ยังไม่จบอยู่แล้ว",
  },
  "ERR-ASM-003": {
    httpStatus: 404,
    message: "ไม่พบรอบการสอบ หรือรอบนี้ปิดแล้ว",
  },
  "ERR-ASM-004": {
    httpStatus: 422,
    message: "หมดเวลาสอบแล้ว ระบบไม่รับคำตอบเพิ่ม",
  },
  "ERR-ASM-005": {
    httpStatus: 422,
    message: "บันทึกคำตอบไม่ได้เพราะส่งข้อสอบแล้ว",
  },
  "ERR-ASM-006": {
    httpStatus: 403,
    message: "คุณไม่ใช่เจ้าของรอบการสอบนี้",
  },
  "ERR-CERT-001": {
    httpStatus: null,
    retired: true,
    message: "(ยกเลิกการใช้ — คงรหัสไว้ในทะเบียน) เดิม 404 ไม่พบประกาศนียบัตรจากรหัสอ้างอิงนี้",
  },
  "ERR-CERT-002": {
    httpStatus: null,
    retired: true,
    message: "(ยกเลิกการใช้ — คงรหัสไว้ในทะเบียน) เดิม 410 ถูกลบตาม retention",
  },
  "ERR-CRD-001": {
    httpStatus: 422,
    message: "กฎเครดิตนี้มีผลใช้งานแล้ว แก้ไขต้องสร้างฉบับใหม่",
  },
  "ERR-CRD-002": {
    httpStatus: 422,
    message: "การปรับ credit ต้องระบุเหตุผล",
  },
  "ERR-ADM-001": {
    httpStatus: 403,
    message: "การกระทำนี้ต้องใช้สิทธิ์เจ้าหน้าที่ระดับสูงขึ้น",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_REGISTRY;

export interface ErrorDefinition {
  readonly code: ErrorCode;
  readonly httpStatus: number | null;
  readonly message: string;
  readonly retired: boolean;
}

/** อ่านนิยามของ code จากทะเบียน (http status + ข้อความไทย default) */
export function errorDefinition(code: ErrorCode): ErrorDefinition {
  const def = ERROR_REGISTRY[code];
  return {
    code,
    httpStatus: def.httpStatus,
    message: def.message,
    retired: "retired" in def ? def.retired : false,
  };
}

/** AppError — error ที่คาดเดาได้ของระบบ อ้าง code จากทะเบียนเท่านั้น (ห้ามสร้าง code ใหม่) */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | null;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const def = ERROR_REGISTRY[code];
    super(options.message ?? def.message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = def.httpStatus;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export interface AppErrorOptions {
  /** override ข้อความได้เฉพาะกรณีที่ doc ระบุให้ปรับตามบริบท — default คือข้อความกลางของ code */
  message?: string;
  /** ฟิลด์เสริมที่ไม่มี PII เท่านั้น (SDS §6.1) */
  details?: Record<string, unknown>;
}

/** error envelope ตาม API-SPEC §1.3 / SDS §6.1 — message ไทยเสมอ */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: { readonly request_id?: string } & Record<string, unknown>;
  };
}

export function toErrorBody(err: AppError, requestId?: string): ErrorEnvelope {
  const details: Record<string, unknown> = {};
  if (requestId !== undefined) {
    details.request_id = requestId;
  }
  for (const [key, value] of Object.entries(err.details ?? {})) {
    if (key !== "request_id") {
      details[key] = value;
    }
  }
  return {
    error: { code: err.code, message: err.message, details },
  };
}

/** แปลง throw ที่ไม่รู้จักเป็น ERR-SYS-001 แบบ opaque — ห้าม leak stack/SQL ออกนอกเครื่อง (SDS §6.1) */
export function fromUnknown(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  return new AppError("ERR-SYS-001");
}
