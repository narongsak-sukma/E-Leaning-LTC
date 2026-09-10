/**
 * Unit tests: src/lib/certificates/issue.ts — issue + eligible queue (Wave D · 0019-r1)
 *
 * 0019-r1 (gate r1 B2/B8): issueCertificate = RPC `admin_issue_certificate` เดียว
 * (ตรวจ enrollment/attempt/ซ้ำ + สุ่มรหัส + INSERT + CERT_ISSUE audit ทั้งหมดใน TX
 * ฝั่ง DB) — BFF เหลือ PDF pipeline (พัง = คงใบ + WARN ตาม D36-O6) ·
 * listEligibleAttempts สแกนเป็น chunk: ตัด "ออกใบแล้ว" ก่อนตัดหน้า (B8) — chunk
 * แรกออกใบหมดทั้งก้อนต้องไปต่อได้ ไม่ใช่หน้าว่างเปล่าซ่อนคนเก่ากว่า
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("./pdf", () => ({ renderCertificatePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { AppError } from "@/lib/errors";
import { renderCertificatePdf } from "./pdf";
import { issueCertificate, listEligibleAttempts } from "./issue";
import { certLogger } from "./shared";

type Row = Record<string, unknown>;
type Resolve = { data: unknown; error: null } | { data: null; error: Record<string, unknown> };
type RpcResult = { data: unknown; error: Record<string, unknown> | null };

const STAFF_ID = "a0000000-0000-4000-8000-000000000001";
const ENROLL_ID = "e0000000-0000-4000-8000-000000000001";
const USER_ID = "f0000000-0000-4000-8000-000000000001";
const COURSE_ID = "b0000000-0000-4000-8000-000000000001";
const CERT_ID = "c0000000-0000-4000-8000-000000000001";
const MEDIA_ID = "90000000-0000-4000-8000-000000000001";
const T1 = "2026-09-08T04:00:00+00:00";
/** ขนาด chunk ของการสแกนคิว — mirror ค่าคงที่ของ issue.ts (ตรวจผ่าน limit ที่จับได้) */
const CHUNK_SIZE = 200;
/** เพดาน chunk ต่อคำขอ — mirror ค่าคงที่ของ issue.ts */
const MAX_CHUNKS = 50;

interface BuilderState {
  table: string;
  select?: string;
  eq: Array<[string, unknown]>;
  or?: string;
  limit: unknown[];
  inserted?: unknown;
  updated?: unknown;
}

interface FakeSpec {
  rpc?: () => RpcResult;
  read?: (table: string, st: BuilderState) => Resolve;
  onInsert?: (table: string, payload: Row) => Resolve;
  upload?: () => Resolve;
}

const OK: Resolve = { data: null, error: null };

function makeBuilder(table: string, spec: FakeSpec, st: BuilderState) {
  const builder: Record<string, unknown> = {
    select: vi.fn((s: string) => {
      st.select = s;
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      st.eq.push([column, value]);
      return builder;
    }),
    not: vi.fn(() => builder),
    filter: vi.fn(() => builder),
    or: vi.fn((f: string) => {
      st.or = f;
      return builder;
    }),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn((n: unknown) => {
      st.limit.push(n);
      return builder;
    }),
    update: vi.fn((payload: unknown) => {
      st.updated = payload;
      return builder;
    }),
    insert: vi.fn((payload: unknown) => {
      st.inserted = payload;
      return builder;
    }),
    maybeSingle: vi.fn(async () => resolveFor(table, st, spec)),
    single: vi.fn(async () => resolveFor(table, st, spec)),
    then: (res: (v: Resolve) => unknown) => res(resolveFor(table, st, spec)),
  };
  return builder;
}

function resolveFor(table: string, st: BuilderState, spec: FakeSpec): Resolve {
  if (st.inserted !== undefined) {
    return spec.onInsert?.(table, st.inserted as Row) ?? OK;
  }
  return spec.read?.(table, st) ?? OK;
}

function serviceClient(spec: FakeSpec) {
  const rpc = vi.fn(async () => spec.rpc?.() ?? { data: null, error: null });
  const uploads: Array<{ bucket: string; path: string; contentType?: string | undefined }> = [];
  const builderLog: BuilderState[] = [];
  const client = {
    from: vi.fn((table: string) => {
      const st: BuilderState = { table, eq: [], limit: [] };
      builderLog.push(st);
      return makeBuilder(table, spec, st);
    }),
    rpc,
    storage: {
      from: (bucket: string) => ({
        upload: vi.fn(async (path: string, _body: unknown, meta: { contentType?: string }) => {
          uploads.push({ bucket, path, contentType: meta?.contentType });
          return spec.upload?.() ?? OK;
        }),
      }),
    },
  };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { rpc, uploads, builderLog };
}

/** jsonb ที่ cert_issue_core คืน (ผ่าน admin_issue_certificate) */
function coreRow(): Row {
  return {
    id: CERT_ID,
    cert_no: "LTC-2026-000123",
    verify_code: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
    enrollment_id: ENROLL_ID,
    user_id: USER_ID,
    course_id: COURSE_ID,
    holder_name: "สมชาย ใจดี",
    course_title: "หลักสูตรทดสอบ",
    issued_at: T1,
  };
}

/** spec มาตรฐาน: RPC สำเร็จ + PDF pipeline สำเร็จตลอด */
function happySpec(): FakeSpec {
  return {
    rpc: () => ({ data: coreRow(), error: null }),
    onInsert: (table) => (table === "media_assets" ? { data: { id: MEDIA_ID }, error: null } : OK),
    upload: () => OK,
  };
}

/** spy warn ของ certLogger — ใช้พิสูจน์ว่า WARN ไม่พา PII เข้า log */
let warnCalls: Array<{ message: string; fields: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  warnCalls = [];
  vi.spyOn(certLogger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
    warnCalls.push({ message, fields: fields ?? {} });
    return certLogger;
  });
});

describe("issueCertificate — RPC admin_issue_certificate (B2)", () => {
  it("happy path: map core jsonb → IssuedCertificate ครบ + PDF ผูกสำเร็จ · RPC ครั้งเดียว", async () => {
    const ctx = serviceClient(happySpec());
    const cert = await issueCertificate({
      actorId: STAFF_ID,
      enrollmentId: ENROLL_ID,
      requestId: "req-1",
    });
    expect(cert).toEqual({
      id: CERT_ID,
      certNo: "LTC-2026-000123",
      verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXX",
      enrollmentId: ENROLL_ID,
      userId: USER_ID,
      courseId: COURSE_ID,
      holderNameSnapshot: "สมชาย ใจดี",
      courseTitleSnapshot: "หลักสูตรทดสอบ",
      creditSnapshot: null,
      status: "valid",
      issuedAt: T1,
      pdfMediaId: MEDIA_ID,
    });
    // B2: mutation+audit ทั้งหมดใน RPC เดียว — BFF ไม่เขียน append_audit_event เอง
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc).toHaveBeenCalledWith("admin_issue_certificate", {
      p_actor_user_id: STAFF_ID,
      p_enrollment_id: ENROLL_ID,
      p_request_id: "req-1",
    });
    const upload = ctx.uploads[0];
    expect(upload?.bucket).toBe("certificates");
    expect(upload?.path).toBe("certificates-pdf/LTC-2026-000123.pdf");
    expect(upload?.contentType).toBe("application/pdf");
  });

  it("requestId ไม่ระบุ → p_request_id เป็น null · PostgREST wrap array → แกะแถวได้", async () => {
    const ctx = serviceClient({ ...happySpec(), rpc: () => ({ data: [coreRow()], error: null }) });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.id).toBe(CERT_ID);
    expect(ctx.rpc).toHaveBeenCalledWith("admin_issue_certificate", {
      p_actor_user_id: STAFF_ID,
      p_enrollment_id: ENROLL_ID,
      p_request_id: null,
    });
  });

  it.each([
    ["ไม่พบข้อมูลที่ต้องการ (ERR-NF-001|enrollment_not_found)", "ERR-NF-001", "enrollment_not_found"],
    ["ข้อมูลไม่ถูกต้อง: ผู้เรียนยังไม่จบหลักสูตรนี้ (ERR-VAL-001|enrollment_not_completed)", "ERR-VAL-001", "enrollment_not_completed"],
    ["ข้อมูลไม่ถูกต้อง: มีใบ valid อยู่แล้ว (ERR-VAL-001|valid_certificate_exists)", "ERR-VAL-001", "valid_certificate_exists"],
    ["ข้อมูลไม่ถูกต้อง: ไม่พบผลสอบที่ผ่านเกณฑ์ (ERR-VAL-001|no_passed_attempt)", "ERR-VAL-001", "no_passed_attempt"],
    ["ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-001|cert_code_retry_exhausted)", "ERR-SYS-001", "cert_code_retry_exhausted"],
    ["ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง (ERR-SYS-002|cert_profile_lookup_failed)", "ERR-SYS-002", "cert_profile_lookup_failed"],
  ])("RPC error มีป้าย → map ตรง: %s", async (message, code, reason) => {
    serviceClient({ rpc: () => ({ data: null, error: { message } }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect(error, message).toBeInstanceOf(AppError);
    expect((error as AppError).code, message).toBe(code);
    expect((error as AppError).details, message).toEqual({ reason });
  });

  it("RPC error ไม่มีป้าย → ERR-SYS-002 opaque (ไม่ leak SQL)", async () => {
    serviceClient({ rpc: () => ({ data: null, error: { code: "XX000", message: "boom" } }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_issue_rpc_failed" });
  });

  it("RPC สำเร็จแต่ data null → ERR-SYS-002 (contract mismatch)", async () => {
    serviceClient({ rpc: () => ({ data: null, error: null }) });
    const error = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID }).catch(
      (e: unknown) => e,
    );
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_rpc_contract_mismatch" });
  });
});

describe("issueCertificate — PDF/Storage พัง = คงใบ + pdf_media_id null + WARN (D36-O6)", () => {
  it("upload ล้มเหลว → pdfMediaId null + WARN certificate_pdf_upload_failed", async () => {
    serviceClient({ ...happySpec(), upload: () => ({ data: null, error: { message: "bucket not found" } }) });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.status).toBe("valid");
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_upload_failed");
  });

  it("media_assets insert ล้มเหลว → WARN certificate_media_insert_failed", async () => {
    serviceClient({
      ...happySpec(),
      onInsert: () => ({ data: null, error: { message: "contract" } }),
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_media_insert_failed");
  });

  it("ผูก pdf_media_id ล้มเหลว → WARN certificate_pdf_link_update_failed + คงใบ", async () => {
    serviceClient({
      ...happySpec(),
      read: (table) => (table === "certificates" ? { data: null, error: { message: "rls" } } : OK),
    });
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.status).toBe("valid");
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_link_update_failed");
  });

  it("render โยน error → WARN certificate_pdf_render_failed + ยังออกใบได้", async () => {
    serviceClient(happySpec());
    vi.mocked(renderCertificatePdf).mockRejectedValueOnce(new Error("font missing"));
    const cert = await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(cert.pdfMediaId).toBeNull();
    expect(warnCalls.map((w) => w.message)).toContain("certificate_pdf_render_failed");
  });

  it("WARN ทุกข้อความไม่พา PII — อนุญาตเฉพาะ route/user_id (holder_name ห้ามเข้า log)", async () => {
    serviceClient({ ...happySpec(), upload: () => ({ data: null, error: { message: "x" } }) });
    await issueCertificate({ actorId: STAFF_ID, enrollmentId: ENROLL_ID });
    expect(warnCalls.length).toBeGreaterThan(0);
    for (const w of warnCalls) {
      expect(Object.keys(w.fields).sort()).toEqual(["route", "user_id"]);
      expect(JSON.stringify(w)).not.toContain("สมชาย");
    }
  });
});

describe("listEligibleAttempts — คิวงานแบบ chunk (B8: ตัด 'ออกใบแล้ว' ก่อนตัดหน้า)", () => {
  /** แถว attempt ผ่านเกณฑ์ seq กำหนด id/enrollment_id และเวลาส่ง (เรียงจากใหม่ไปเก่า) */
  function attemptRow(seq: number): Row {
    const suffix = String(seq).padStart(12, "0");
    return {
      id: `d0000000-0000-4000-8000-${suffix}`,
      enrollment_id: `e0000000-0000-4000-8000-${suffix}`,
      user_id: USER_ID,
      score_pct: 90,
      submitted_at: new Date(Date.UTC(2026, 8, 1) - seq * 60_000).toISOString(),
      attempt_no: 1,
      profiles: { first_name: "สมชาย", last_name: "ใจดี", display_name: "นายสมชาย" },
      enrollments: { course_id: COURSE_ID, status: "completed", deleted_at: null },
    };
  }

  /** read handler แบบมีหน้า: attempts หน้าที่ n = attemptPages[n] · certificates หน้าที่ n = certPages[n] */
  function chunkedReader(attemptPages: Row[][], certPages: Row[][]) {
    let attemptCall = 0;
    let certCall = 0;
    return (table: string): Resolve => {
      if (table === "assessment_attempts") {
        const page = attemptPages[attemptCall];
        attemptCall += 1;
        return { data: page ?? [], error: null };
      }
      if (table === "certificates") {
        const page = certPages[certCall];
        certCall += 1;
        return { data: page ?? [], error: null };
      }
      return OK;
    };
  }

  it("แถวผ่านเกณฑ์ → map เป็น resource (ชื่อจาก first+last) + ไม่มี valid cert → อยู่ในคิว", async () => {
    serviceClient({ read: chunkedReader([[attemptRow(1)]], [[]]) });
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
    expect(page.data).toHaveLength(1);
    const first = page.data[0];
    expect(first?.attemptId).toBe("d0000000-0000-4000-8000-000000000001");
    expect(first?.holderName).toBe("สมชาย ใจดี");
    expect(first?.courseId).toBe(COURSE_ID);
  });

  it("enrollment ที่มีใบ valid แล้ว → ถูก anti-join ตัดออกจากคิว", async () => {
    const row = attemptRow(1);
    serviceClient({
      read: chunkedReader([[row]], [[{ enrollment_id: row["enrollment_id"] }]]),
    });
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.data).toEqual([]);
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("ได้เกิน limit → hasMore + nextCursor (extra row สำหรับ buildPage)", async () => {
    serviceClient({ read: chunkedReader([[attemptRow(1), attemptRow(2), attemptRow(3)]], [[]]) });
    const page = await listEligibleAttempts({ limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBeTruthy();
  });

  it("B8: chunk แรกออกใบหมดทั้ง 200 → ไปต่อถึง chunk สอง ได้คนเก่ากว่า ไม่ใช่หน้าว่าง", async () => {
    const chunk1 = Array.from({ length: CHUNK_SIZE }, (_, i) => attemptRow(i + 1));
    const chunk2 = [attemptRow(201), attemptRow(202), attemptRow(203)];
    const ctx = serviceClient({
      read: chunkedReader(
        [chunk1, chunk2],
        [
          chunk1.map((r) => ({ enrollment_id: r["enrollment_id"] })), // ทั้ง chunk แรกออกใบแล้ว
          [], // chunk สองยังไม่มีใบ
        ],
      ),
    });
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.data).toHaveLength(3); // แบบเดิม (limit ก่อน filter) คืน 0 แถว — pin พฤติกรรมใหม่
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
    expect(page.data[0]?.attemptId).toBe("d0000000-0000-4000-8000-000000000201");
    // สแกน 2 chunk จริง และ chunk สองเลื่อน cursor พ้นแถวสุดท้ายของ chunk แรก (รวมแถวที่ถูกตัด)
    const attemptBuilders = ctx.builderLog.filter((st) => st.table === "assessment_attempts");
    expect(attemptBuilders).toHaveLength(2);
    expect(attemptBuilders[0]?.or).toBeUndefined();
    expect(attemptBuilders[1]?.or).toContain("submitted_at.lt.");
  });

  it("เพดานการไล่คิว: คิวยาวเป็นใบทั้งหมด → หยุดที่ MAX_CHUNKS (10,000 แถว) ไม่วนไม่รู้จบ", async () => {
    let rounds = 0;
    let currentChunk: Row[] = [];
    serviceClient({
      read: (table: string): Resolve => {
        if (table === "assessment_attempts") {
          rounds += 1;
          currentChunk = Array.from({ length: CHUNK_SIZE }, (_, i) => attemptRow((rounds - 1) * CHUNK_SIZE + i + 1));
          return { data: currentChunk, error: null };
        }
        if (table === "certificates") {
          return { data: currentChunk.map((r) => ({ enrollment_id: r["enrollment_id"] })), error: null };
        }
        return OK;
      },
    });
    const page = await listEligibleAttempts({ limit: 20 });
    expect(page.data).toEqual([]);
    expect(page.page).toEqual({ nextCursor: null, hasMore: false });
    expect(rounds).toBe(MAX_CHUNKS);
  });

  it("query ของ eligible ผูก !inner + filter ตาม SDS §3.4a · limit เป็นขนาด chunk ไม่ใช่ limit+1", async () => {
    const ctx = serviceClient({ read: chunkedReader([[]], []) });
    await listEligibleAttempts({ limit: 5 });
    const q = ctx.builderLog.find((st) => st.table === "assessment_attempts");
    expect(q?.select).toContain("profiles!inner(");
    expect(q?.select).toContain("enrollments!inner(");
    expect(q?.limit).toEqual([CHUNK_SIZE]);
    expect(q?.eq).toEqual(
      expect.arrayContaining([
        ["passed", true],
        ["status", "passed"],
        ["enrollments.status", "completed"],
      ]),
    );
  });

  it("query คิวล้ม → ERR-SYS-002 cert_eligible_query_failed", async () => {
    serviceClient({
      read: (table) =>
        table === "assessment_attempts"
          ? { data: null, error: { code: "XX000", message: "boom" } }
          : OK,
    });
    const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_eligible_query_failed" });
  });

  it("anti-join lookup ล้ม → ERR-SYS-002 cert_eligible_validcert_lookup_failed", async () => {
    serviceClient({
      read: (table) =>
        table === "certificates"
          ? { data: null, error: { code: "XX000", message: "boom" } }
          : table === "assessment_attempts"
            ? { data: [attemptRow(1)], error: null }
            : OK,
    });
    const error = await listEligibleAttempts({ limit: 20 }).catch((e: unknown) => e);
    expect((error as AppError).code).toBe("ERR-SYS-002");
    expect((error as AppError).details).toEqual({ reason: "cert_eligible_validcert_lookup_failed" });
  });
});
