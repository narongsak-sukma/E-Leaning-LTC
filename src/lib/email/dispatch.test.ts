/**
 * dispatch.test — unit ของ email worker (Wave E Phase 4 · D-p4-7/D-p4-8)
 *
 * mock service client + provider (ไม่ยิงของจริง) — จุดหลัก: flow claim→render→send→
 * complete ครั้งเดียวต่อ batch · จบเมื่อ claim ว่าง/ครบ maxBatches · fail-loud ของ
 * template/var · drift fail-closed · ห้าม log to_email/payload
 */
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_ANON_KEY = "stub-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { senderStub, getConfigMock } = vi.hoisted(() => ({
  senderStub: vi.fn(),
  getConfigMock: vi.fn(),
}));

// gate r2 B5: getConfig ของจริง cache ค่าแรกที่อ่าน (env แก้ระหว่างไฟล์ไม่มีผล) —
// mock ที่ตัวฟังก์ชันจึงตั้ง base URL ต่อเคสได้ (fallback publicBaseUrl vs
// certPublicBaseUrl ที่ตั้งค่าจริง — adjudication-2 บังคับทดสอบทั้งคู่)
vi.mock("@/lib/config", () => ({
  getConfig: getConfigMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("./providers", () => ({
  createEmailSender: vi.fn(() => senderStub),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  ClaimedEmailRowSchema,
  EMAIL_CLAIM_BATCH_SIZE,
  renderTemplateVars,
  runEmailDispatch,
  type EmailCompleteItem,
} from "./dispatch";

/** uuid คงที่ของชุดทดสอบ */
const ID_A = "a0000000-0000-4000-8000-000000000001";
const ID_B = "a0000000-0000-4000-8000-000000000002";
const ID_C = "a0000000-0000-4000-8000-000000000003";
/** user_id ตามสัญญา payload (gate r1 B4 — ต้องเป็น UUID จริงเสมอ) */
const USER_A = "c0000000-0000-4000-8000-000000000001";
/** certificate_id ของเคส B5 (UUID ของ certificates.id — route PDF บังคับรูปนี้) */
const CERT_ID = "d0000000-0000-4000-8000-000000000001";
/** base URL fallback ของ suite (ไม่ตั้ง certPublicBaseUrl — dev ทำงานแบบนี้) */
const APP_BASE = "https://elearning.lawyerthai.test";

/** แถวคิวตามสัญญา lane A (แผน §4.7 + 0034 §4a/4b: payload = {notification_id,
 *  user_id, vars} — ตัวแปร render อยู่ใต้ vars ชื่อตามที่ tick ใส่จริง) */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID_A,
    recipient_user_id: null as string | null,
    to_email: "learner@ltc.local",
    attempts: 0,
    template_key: "exam.result.passed",
    payload: {
      notification_id: "b0000000-0000-4000-8000-000000000009",
      user_id: USER_A,
      vars: {
        full_name: "ทดสอบ ระบบ",
        course_title: "หลักสูตรทดสอบ",
        score_pct: 90,
        pass_pct: 80,
      },
    } as Record<string, unknown>,
    locale: "th",
    ...overrides,
  };
}

/** client จำลอง service-role (rpc email_claim_batch/email_complete + templates) */
function mockClient(spec: {
  batches: unknown[][];
  templates?: Record<string, unknown>;
  claimError?: { message: string } | null;
  completeError?: { message: string } | null;
}) {
  let claimIndex = 0;
  const completeCalls: unknown[] = [];
  const rpc = vi.fn(
    async (
      fn: string,
      args?: { p_limit?: number; p_results?: EmailCompleteItem[] },
    ): Promise<{ data: unknown; error: unknown }> => {
      if (fn === "email_claim_batch") {
        if (spec.claimError !== undefined && spec.claimError !== null) {
          return { data: null, error: spec.claimError };
        }
        const batch = spec.batches[claimIndex] ?? [];
        claimIndex += 1;
        return { data: batch, error: null };
      }
      if (fn === "email_complete") {
        completeCalls.push(args?.p_results ?? []);
        return { data: null, error: spec.completeError ?? null };
      }
      return { data: null, error: null };
    },
  );
  const from = vi.fn(() => {
    const filters: Record<string, unknown> = {};
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((col: string, value: unknown) => {
        filters[col] = value;
        return builder;
      }),
      maybeSingle: vi.fn(async () => {
        const key = `${String(filters["template_key"])}` + `|${String(filters["locale"])}`;
        return { data: spec.templates?.[key] ?? null, error: null };
    }),
    };
    return builder;
  });
  const client = { rpc, from };
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);
  return { rpc, from, completeCalls };
}

/** template row ตามคอลัมน์ notification_templates */
function tpl(subjectTpl: string, bodyTpl: string): Record<string, unknown> {
  return { subject_tpl: subjectTpl, body_tpl: bodyTpl };
}

beforeEach(() => {
  vi.clearAllMocks();
  senderStub.mockReset();
  senderStub.mockResolvedValue({ ok: true });
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
  // default: ไม่ตั้ง certPublicBaseUrl — base ลิงก์ใบประกาศฯ ตกไป publicBaseUrl
  getConfigMock.mockReset();
  getConfigMock.mockReturnValue({ publicBaseUrl: APP_BASE, certPublicBaseUrl: null });
});

describe("runEmailDispatch — flow หลัก claim→render→send→complete", () => {
  it("2 แถว → send ครบ → complete ครั้งเดียวต่อ batch + สรุป {claimed:2, sent:2, failed:0}", async () => {
    const { rpc, completeCalls } = mockClient({
      batches: [[row(), row({ id: ID_B })], []],
      templates: {
        "exam.result.passed|th": tpl("ผลสอบ {{course_title}}", "คุณ{{full_name}} ได้ {{score_pct}}/{{pass_pct}}"),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 2, sent: 2, failed: 0 });
    // claim = 2 ครั้ง (ครั้งสองได้ [] จึงจบ) · complete = 1 ครั้ง พร้อมผล ok ครบ
    expect(rpc).toHaveBeenNthCalledWith(1, "email_claim_batch", { p_limit: EMAIL_CLAIM_BATCH_SIZE });
    expect(completeCalls).toEqual([
      [
        { id: ID_A, ok: true },
        { id: ID_B, ok: true },
      ],
    ]);
  });

  it("claim ว่างรอบแรก → จบทันที (ไม่ complete)", async () => {
    const { rpc } = mockClient({ batches: [[]] });
    const payload = await runEmailDispatch();
    expect(payload).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("certificate.issued + verify_code + certificate_id → ลิงก์สองเส้นคนละตัวระบุ: verify=verify_code · PDF=UUID (gate r2 B5a — route PDF บังคับ UUID)", async () => {
    const CODE = "LTC-VERIFY-2026-ABCD";
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            template_key: "certificate.issued",
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: USER_A,
              vars: {
                full_name: "ทดสอบ ระบบ",
                course_title: "หลักสูตรทดสอบ",
                cert_no: "LTC-2569-000123",
                verify_code: CODE,
                certificate_id: CERT_ID,
              },
            },
          }),
        ],
        [],
      ],
      templates: {
        "certificate.issued|th": tpl(
          "ใบประกาศ {{course_title}}",
          "ตรวจสอบ: {{verify_url}} PDF: {{pdf_url}} เลขที่ {{cert_no}} คุณ{{full_name}}",
        ),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(senderStub).toHaveBeenCalledTimes(1);
    const firstCall = senderStub.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sentBody = (firstCall?.[0] as { body: string }).body;
    // verify = หน้าสาธารณะตาม verify_code · PDF = certificates.id (UUID) —
    // สลับกันไม่ได้: route PDF ตอบ 400 ให้ nanoid ทันที (API-SPEC §3.6)
    expect(sentBody).toContain(`${APP_BASE}/verify/${CODE}`);
    expect(sentBody).toContain(`${APP_BASE}/api/v1/certificates/${CERT_ID}/pdf`);
    expect(sentBody).not.toContain(`${APP_BASE}/api/v1/certificates/${CODE}/pdf`);
    expect(completeCalls).toEqual([[{ id: ID_A, ok: true }]]);
  });

  it("certificate.revoked + ตัวระบุครบ → ฉีดลิงก์คู่เดียวกันให้อีเมลเพิกถอน (gate r2 B5b — AC ครอบทั้งออกใบ/เพิกถอน)", async () => {
    const CODE = "LTC-VERIFY-2026-REVK";
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            template_key: "certificate.revoked",
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: USER_A,
              vars: {
                full_name: "ทดสอบ ระบบ",
                cert_no: "LTC-2569-000123",
                verify_code: CODE,
                certificate_id: CERT_ID,
              },
            },
          }),
        ],
        [],
      ],
      templates: {
        "certificate.revoked|th": tpl(
          "แจ้งเพิกถอน เลขที่ {{cert_no}}",
          "ถูกเพิกถอน ตรวจสอบ: {{verify_url}} PDF: {{pdf_url}}",
        ),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    const firstCall = senderStub.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sentBody = (firstCall?.[0] as { body: string }).body;
    expect(sentBody).toContain(`${APP_BASE}/verify/${CODE}`);
    expect(sentBody).toContain(`${APP_BASE}/api/v1/certificates/${CERT_ID}/pdf`);
    expect(completeCalls).toEqual([[{ id: ID_A, ok: true }]]);
  });

  it("ตั้ง certPublicBaseUrl จริง → ลิงก์ทั้งสองเส้นใช้โดเมน certificate ไม่ใช่ publicBaseUrl (adjudication-2 — ทดสอบสอง base)", async () => {
    const CODE = "LTC-VERIFY-2026-CONF";
    getConfigMock.mockReturnValue({
      publicBaseUrl: APP_BASE,
      certPublicBaseUrl: "https://cert.lawyerthai.test",
    });
    mockClient({
      batches: [
        [
          row({
            template_key: "certificate.issued",
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: USER_A,
              vars: {
                full_name: "ทดสอบ ระบบ",
                course_title: "หลักสูตรทดสอบ",
                cert_no: "LTC-2569-000123",
                verify_code: CODE,
                certificate_id: CERT_ID,
              },
            },
          }),
        ],
        [],
      ],
      templates: {
        "certificate.issued|th": tpl(
          "ใบประกาศ {{course_title}}",
          "ตรวจสอบ: {{verify_url}} PDF: {{pdf_url}}",
        ),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    const firstCall = senderStub.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sentBody = (firstCall?.[0] as { body: string }).body;
    expect(sentBody).toContain(`https://cert.lawyerthai.test/verify/${CODE}`);
    expect(sentBody).toContain(
      `https://cert.lawyerthai.test/api/v1/certificates/${CERT_ID}/pdf`,
    );
    expect(sentBody).not.toContain(APP_BASE);
  });

  it("send fail → complete รับ {ok:false,error} + นับ failed", async () => {
    senderStub.mockResolvedValue({ ok: false, error: "smtp_econnrefused" });
    const { completeCalls } = mockClient({
      batches: [[row()], []],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "smtp_econnrefused" }]]);
  });
});

describe("runEmailDispatch — template/var/drift fail-closed", () => {
  it("template หาย → template_missing (ok:false) — ไม่เรียก provider", async () => {
    const { completeCalls } = mockClient({
      batches: [[row()], []],
      templates: {},
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "template_missing" }]]);
  });

  it("verify_code มีแต่ certificate_id ขาด → ไม่ฉีดลิงก์ → template_var_missing + ห้ามเรียก provider (gate r2 B5a — ไม่มีทางส่งเมล์ลิงก์ PDF ผิดตัวระบุ)", async () => {
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            template_key: "certificate.issued",
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: USER_A,
              vars: {
                full_name: "ทดสอบ ระบบ",
                course_title: "หลักสูตรทดสอบ",
                cert_no: "LTC-2569-000123",
                verify_code: "LTC-VERIFY-2026-HALF",
              },
            },
          }),
        ],
        [],
      ],
      templates: {
        "certificate.issued|th": tpl(
          "ใบประกาศ {{course_title}}",
          "ตรวจสอบ: {{verify_url}} PDF: {{pdf_url}}",
        ),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(senderStub).not.toHaveBeenCalled();
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "template_var_missing" }]]);
  });

  it("certificate_id ไม่ใช่ UUID (nanoid หลุดมาแทน — รูปบั๊ก r1 เดิม) → fail เหมือนกัน ไม่ส่งเมล์ PDF ชี้ 400", async () => {
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            template_key: "certificate.issued",
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: USER_A,
              vars: {
                full_name: "ทดสอบ ระบบ",
                course_title: "หลักสูตรทดสอบ",
                cert_no: "LTC-2569-000123",
                verify_code: "LTC-VERIFY-2026-ABCD",
                certificate_id: "LTC-VERIFY-2026-ABCD",
              },
            },
          }),
        ],
        [],
      ],
      templates: {
        "certificate.issued|th": tpl(
          "ใบประกาศ {{course_title}}",
          "ตรวจสอบ: {{verify_url}} PDF: {{pdf_url}}",
        ),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(senderStub).not.toHaveBeenCalled();
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "template_var_missing" }]]);
  });

  it("var ที่ template ต้องการแต่ payload ไม่มี → template_var_missing (fail-loud)", async () => {
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: USER_A,
              vars: { full_name: "ทดสอบ ระบบ" },
            },
          }),
        ],
        [],
      ],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}} และ {{pass_pct}}"),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "template_var_missing" }]]);
  });

  it("แถว payload แบน (ไม่มี vars ซ้อน) → row_contract_drift — ไม่พยายามเดาจาก payload แบน (seam A↔C: tick ใส่ vars ซ้อนเสมอ)", async () => {
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              full_name: "ทดสอบ ระบบ",
              course_title: "หลักสูตรทดสอบ",
            },
          }),
        ],
        [],
      ],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "row_contract_drift" }]]);
  });

  it("payload notification_id ไม่ใช่ UUID → row_contract_drift + ห้ามเรียก provider (gate r1 B4 — ส่งก่อนแล้วค่อยพบว่า complete ไม่ได้)", async () => {
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            payload: {
              notification_id: "bad",
              user_id: USER_A,
              vars: { full_name: "ทดสอบ ระบบ", course_title: "หลักสูตรทดสอบ" },
            },
          }),
        ],
        [],
      ],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(senderStub).not.toHaveBeenCalled();
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "row_contract_drift" }]]);
  });

  it("payload user_id ไม่ใช่ UUID (null) → row_contract_drift + ห้ามเรียก provider (gate r1 B4)", async () => {
    const { completeCalls } = mockClient({
      batches: [
        [
          row({
            payload: {
              notification_id: "b0000000-0000-4000-8000-000000000009",
              user_id: null,
              vars: { full_name: "ทดสอบ ระบบ", course_title: "หลักสูตรทดสอบ" },
            },
          }),
        ],
        [],
      ],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(senderStub).not.toHaveBeenCalled();
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "row_contract_drift" }]]);
  });

  it("แถว drift (id valid แต่คีย์เกิน) → รายงาน row_contract_drift เข้าคิว", async () => {
    const { completeCalls } = mockClient({
      batches: [[{ ...row(), extra_key: 1 }], []],
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completeCalls).toEqual([[{ id: ID_A, ok: false, error: "row_contract_drift" }]]);
  });

  it("แถว drift (id เสีย) → นับ failed แต่ไม่รายงาน complete (id รายงานไม่ได้)", async () => {
    const { completeCalls } = mockClient({
      batches: [[{ broken: 1 }], []],
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 0, failed: 1 });
    expect(completeCalls).toEqual([]);
  });
});

describe("runEmailDispatch — ขอบเขต batch + RPC ล้ม", () => {
  it("maxBatches=2 → claim จำกัด 2 รอบ แม้คิวยังมีแถว", async () => {
    const { rpc } = mockClient({
      batches: [[row()], [row({ id: ID_B })], [row({ id: ID_C })]],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
    });
    const summary = await runEmailDispatch({ maxBatches: 2 });
    expect(summary).toEqual({ claimed: 2, sent: 2, failed: 0 });
    expect(rpc).toHaveBeenCalledTimes(4); // claim ×2 + complete ×2
    expect(rpc).toHaveBeenNthCalledWith(1, "email_claim_batch", { p_limit: 20 });
  });

  it("claim RPC error → หยุด + คืนสรุปย่อย (ไม่ throw)", async () => {
    const { rpc } = mockClient({ batches: [[row()]], claimError: { message: "rpc down" } });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("complete RPC error → log แล้วไปต่อ (สรุปยังนับ sent จาก provider)", async () => {
    const { completeCalls } = mockClient({
      batches: [[row()], []],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
      completeError: { message: "complete down" },
    });
    const summary = await runEmailDispatch();
    expect(summary).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(completeCalls).toHaveLength(1);
  });
});

describe("no-leak — ห้าม log to_email/payload", () => {
  it("console.log ทั้งรอบ ไม่มี to_email/ค่า payload ใด ๆ", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockClient({
      batches: [
        [
          row({
            payload: {
              ...(row().payload as Record<string, unknown>),
              vars: {
                ...((row().payload as { vars: Record<string, unknown> }).vars),
                course_title: "ลับ",
              },
            },
          }),
        ],
        [],
      ],
      templates: {
        "exam.result.passed|th": tpl("หัว {{course_title}}", "เนื้อ {{full_name}}"),
      },
    });
    await runEmailDispatch();
    for (const call of logSpy.mock.calls) {
      const line = call.map(String).join(" ");
      expect(line).not.toContain("learner@ltc.local");
      expect(line).not.toContain("ลับ");
    }
    logSpy.mockRestore();
  });
});

describe("renderTemplateVars / ClaimedEmailRowSchema — unit ย่อย", () => {
  it("แทน var ครบ (string/number) + var เกินไม่เป็นไร", () => {
    const rendered = renderTemplateVars(
      "คุณ{{full_name}} ได้ {{score_pct}} คะแนน",
      { full_name: "สมชาย", score_pct: 90, extra: "เกิน" },
    );
    expect(rendered.text).toBe("คุณสมชาย ได้ 90 คะแนน");
    expect(rendered.missing).toEqual([]);
  });

  it("var หาย = รายงาน missing ไม่แทนด้วยค่าว่าง", () => {
    const rendered = renderTemplateVars("หัว {{course_title}}", { first_name: "x" });
    expect(rendered.text).toBe("หัว {{course_title}}");
    expect(rendered.missing).toEqual(["course_title"]);
  });

  it("ClaimedEmailRowSchema strict — คีย์เกิน → fail", () => {
    const parsed = ClaimedEmailRowSchema.safeParse({
      ...row(),
      extra: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("ClaimedEmailRowSchema — locale นอก th/en → fail", () => {
    const parsed = ClaimedEmailRowSchema.safeParse(row({ locale: "jp" }));
    expect(parsed.success).toBe(false);
  });
});
