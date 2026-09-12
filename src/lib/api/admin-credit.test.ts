/**
 * เทส src/lib/api/admin-credit.ts — data layer หลังบ้าน credit bank
 *
 * - pure helpers ทุกตัว (ป้ายไทย/โทน/ฟอร์แมต/URL builder) — node env ไม่ render
 * - data functions ทั้ง 5 ผ่าน stub global fetch (Node Response จริง) — ตรวจ URL ·
 *   method · header · body serialization และการแกะ envelope แบบ fail-closed
 *   (แถวผิดสัญญา → ApiError ERR-SYS-001 · error envelope §1.3 → ApiError code จริง)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_RULE_STATUSES,
  CreditAdjustmentResource,
  CreditLedgerRowResource,
  CreditRuleResource,
  adjustCredit,
  createCreditRule,
  creditLedgerApiUrl,
  creditRuleStatusThai,
  creditRuleStatusTone,
  formatCreditDateThai,
  formatCreditDateTimeThai,
  formatSignedCredit,
  ledgerEntryTone,
  ledgerEntryTypeThai,
  listCreditLedger,
  listCreditRules,
  listCreditRulesApiUrl,
  updateCreditRuleStatus,
} from "@/lib/api/admin-credit";

/** Response JSON จริงของ Node — envelope §1.1/§1.2 ตามสัญญา */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** แถวกฎครบตามสัญญา (camelCase) — ใช้ทั้งเทส success และ drift */
const RULE_OK = {
  id: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d01",
  code: "CR-LTC-001",
  name: "ผ่านหลักสูตรนิติศึกษา",
  courseId: null,
  creditType: "general",
  credits: 12,
  validDays: null,
  carryOver: false,
  requiredCreditsPerCycle: null,
  priority: 100,
  renewalCycle: null,
  effectiveFrom: "2026-01-01T00:00:00Z",
  effectiveTo: null,
  status: "draft",
  createdAt: "2026-09-01T00:00:00Z",
};

const FETCH_STUB = vi.fn<(...args: unknown[]) => Promise<Response>>();

beforeEach(() => {
  FETCH_STUB.mockReset();
  vi.stubGlobal("fetch", FETCH_STUB);
});

describe("ป้ายภาษาไทย + โทน (pure)", () => {
  it("ป้ายสถานะกฎครบทุกค่า enum และไม่คืนรหัสดิบ", () => {
    expect(creditRuleStatusThai("draft")).toBe("ฉบับร่าง");
    expect(creditRuleStatusThai("active")).toBe("ใช้งาน");
    expect(creditRuleStatusThai("retired")).toBe("ปลดระวัง");
  });

  it("โทนสถานะตรง DS §5.6 — draft warning · active success · retired danger", () => {
    expect(creditRuleStatusTone("draft")).toBe("warning");
    expect(creditRuleStatusTone("active")).toBe("success");
    expect(creditRuleStatusTone("retired")).toBe("danger");
  });

  it("ป้ายประเภทรายการ ledger ครบ 4 ค่า enum (มี expiry)", () => {
    expect(ledgerEntryTypeThai("accrual")).toBe("ได้รับ credit");
    expect(ledgerEntryTypeThai("adjustment")).toBe("ปรับโดยเจ้าหน้าที่");
    expect(ledgerEntryTypeThai("reversal")).toBe("ย้อนสถานะ (เพิกถอนใบ)");
    expect(ledgerEntryTypeThai("expiry")).toBe("หมดอายุ");
  });

  it("โทนรายการ ledger — accrual เขียว adjustment เหลือง reversal แดง expiry เทา", () => {
    expect(ledgerEntryTone("accrual")).toBe("success");
    expect(ledgerEntryTone("adjustment")).toBe("warning");
    expect(ledgerEntryTone("reversal")).toBe("danger");
    expect(ledgerEntryTone("expiry")).toBe("neutral");
  });

  it("formatSignedCredit — บวกมี + ลบมี − ทศนิยมแสดงเท่าที่จำเป็น", () => {
    expect(formatSignedCredit(12)).toBe("+12");
    expect(formatSignedCredit(12.5)).toBe("+12.5");
    expect(formatSignedCredit(12.05)).toBe("+12.05");
    expect(formatSignedCredit(-3)).toBe("-3");
    expect(formatSignedCredit(-0.5)).toBe("-0.5");
    expect(formatSignedCredit(0)).toBe("0");
  });

  it("ฟอร์แมตวันเวลา/วันที่ พ.ศ. ไทย (ทดสอบปีกัน TZ drift)", () => {
    expect(formatCreditDateTimeThai("2026-08-12T07:00:00Z")).toContain("2569");
    expect(formatCreditDateThai("2026-08-12T00:00:00Z")).toContain("2569");
  });
});

describe("URL builders", () => {
  it("listCreditRulesApiUrl — ค่า default เท่า path", () => {
    expect(listCreditRulesApiUrl()).toBe("/api/v1/admin/credit-rules?limit=20");
  });

  it("listCreditRulesApiUrl — ส่ง status/course_id/cursor ครบ", () => {
    expect(
      listCreditRulesApiUrl({ status: "active", courseId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d99", cursor: "abc", limit: 50 }),
    ).toBe("/api/v1/admin/credit-rules?status=active&course_id=0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d99&cursor=abc&limit=50");
  });

  it("listCreditRulesApiUrl — courseId/cursor ว่าง = ตัดออก (ฟอร์ม GET ส่งช่องว่าง)", () => {
    expect(
      listCreditRulesApiUrl({ status: undefined, courseId: "", cursor: "" }),
    ).toBe("/api/v1/admin/credit-rules?limit=20");
  });

  it("creditLedgerApiUrl — base มี limit", () => {
    expect(
      creditLedgerApiUrl("0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d02"),
    ).toBe("/api/v1/admin/credits/0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d02?limit=20");
  });

  it("creditLedgerApiUrl — cursor ชนะ after_* (XOR pair ฝั่ง BFF)", () => {
    expect(
      creditLedgerApiUrl("u", { cursor: "cur1", afterCreatedAt: "2026-01-01T00:00:00Z", afterId: "i" }),
    ).toBe("/api/v1/admin/credits/u?cursor=cur1&limit=20");
  });

  it("creditLedgerApiUrl — คู่ after_* ต้องส่งพร้อมกันจึงผ่าน query", () => {
    expect(
      creditLedgerApiUrl("u", { afterCreatedAt: "2026-01-01T00:00:00Z" }),
    ).toBe("/api/v1/admin/credits/u?limit=20");
  });
});

describe("listCreditRules (GET ผ่าน transport)", () => {
  it("เรียก URL/method ถูก และแกะ envelope { data, page } ได้", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [RULE_OK],
        page: { nextCursor: "n1", hasMore: true },
      }),
    );
    const page = await listCreditRules({ status: "draft" }, { origin: "http://localhost:3000" });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.status).toBe("draft");
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("n1");
    const [calledPath, calledInit] = FETCH_STUB.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(calledPath).toBeInstanceOf(URL);
    expect(calledPath.pathname).toBe("/api/v1/admin/credit-rules");
    expect(calledPath.searchParams.get("status")).toBe("draft");
    expect(calledInit.method).toBe("GET");
  });

  it("แถวผิดสัญญา (status แปลก) → ApiError ERR-SYS-001 ทั้งหน้า (fail-closed)", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [{ ...RULE_OK, status: "weird" }],
        page: { nextCursor: null, hasMore: false },
      }),
    );
    await expect(
      listCreditRules({}, { origin: "http://localhost:3000" }),
    ).rejects.toMatchObject({ name: "ApiError", code: "ERR-SYS-001" });
  });

  it("page envelope ผิดรูป (hasMore ไม่ใช่ boolean) → ERR-SYS-001", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [],
        page: { nextCursor: null, hasMore: "yes" },
      }),
    );
    await expect(
      listCreditRules({}, { origin: "http://localhost:3000" }),
    ).rejects.toMatchObject({ name: "ApiError", code: "ERR-SYS-001" });
  });

  it("network ล้ม → ERR-SYS-001 ข้อความ fallback (transport)", async () => {
    FETCH_STUB.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      listCreditRules({}, { origin: "http://localhost:3000" }),
    ).rejects.toMatchObject({ name: "ApiError", code: "ERR-SYS-001" });
  });
});

describe("createCreditRule (POST ผ่าน transport)", () => {
  it("serialize เฉพาะ key ที่ส่ง (exactOptionalPropertyTypes-safe) และแกะ data", async () => {
    FETCH_STUB.mockResolvedValueOnce(jsonResponse(201, { data: RULE_OK }));
    const created = await createCreditRuleInput();
    expect(created.id).toBe(RULE_OK.id);
    const [, init] = FETCH_STUB.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent["code"]).toBe("CR-LTC-002");
    expect(sent["credits"]).toBe(6);
    expect("courseId" in sent).toBe(false); // ไม่ได้ระบุ = ไม่ส่ง key (ไม่ส่ง null แทน)
    expect(sent["carryOver"]).toBe(true);
  });

  it("error envelope §1.3 → ApiError code/message ไทยจาก BFF", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          code: "ERR-VAL-001",
          message: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
          details: { fields: ["code"] },
        },
      }),
    );
    await expect(createCreditRuleInput()).rejects.toMatchObject({
      name: "ApiError",
      code: "ERR-VAL-001",
      message: "ข้อมูลที่ส่งมาไม่ถูกต้อง",
    });
  });
});

describe("updateCreditRuleStatus (PATCH — patchJson เฉพาะตน)", () => {
  it("ส่ง method PATCH + body { status } และแกะ resource", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(200, { data: { ...RULE_OK, status: "active" } }),
    );
    const updated = await updateCreditRuleStatus(RULE_OK.id, "active", {
      origin: "http://localhost:3000",
    });
    expect(updated.status).toBe("active");
    const [calledPath, init] = FETCH_STUB.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(calledPath.pathname).toBe(`/api/v1/admin/credit-rules/${RULE_OK.id}`);
    expect(JSON.parse(String(init.body))).toEqual({ status: "active" });
  });

  it("forward cookie ขา server + header x-ltc-bff-internal (mirror transport)", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(200, { data: { ...RULE_OK, status: "retired" } }),
    );
    await updateCreditRuleStatus(RULE_OK.id, "retired", {
      origin: "http://localhost:3000",
      cookieHeader: "session=abc",
    });
    const [, init] = FETCH_STUB.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe("session=abc");
    expect(headers["x-ltc-bff-internal"]).toBe("1");
  });

  it("transition ผิด (BFF 400) → ApiError ข้อความไทยเจาะจงจาก envelope", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          code: "ERR-VAL-001",
          message: "เปลี่ยนสถานะกฎเครดิตไม่ได้: ทำได้เฉพาะเผยแพร่จากฉบับร่าง (ร่าง→ใช้งาน) หรือปลดระวัง (ใช้งาน→ปลดระวัง)",
        },
      }),
    );
    await expect(
      updateCreditRuleStatus(RULE_OK.id, "retired", { origin: "http://localhost:3000" }),
    ).rejects.toMatchObject({ code: "ERR-VAL-001" });
  });
});

describe("adjustCredit (POST adjustments)", () => {
  it("ส่ง body camelCase ครบ 5 ฟิลด์ และแกะ resource", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(201, {
        data: {
          id: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d10",
          userId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d11",
          renewalCycleId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d12",
          creditType: "general",
          amount: -3,
          reason: "ปรับยอดตามมติคณะกรรมการ",
          createdAt: "2026-09-10T00:00:00Z",
        },
      }),
    );
    const adj = await adjustCredit(
      {
        userId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d11",
        cycleId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d12",
        creditType: "general",
        amount: -3,
        reason: "ปรับยอดตามมติคณะกรรมการ",
      },
      { origin: "http://localhost:3000" },
    );
    expect(adj.amount).toBe(-3);
    const [, init] = FETCH_STUB.mock.calls[0] as unknown as [URL, RequestInit];
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent["userId"]).toBe("0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d11");
    expect(sent["cycleId"]).toBe("0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d12");
    expect(sent["amount"]).toBe(-3);
  });
});

describe("listCreditLedger (GET ledger keyset)", () => {
  it("แกะ page + parse แถว ledger ได้", async () => {
    FETCH_STUB.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          {
            id: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d20",
            cycleNo: 2,
            entryType: "adjustment",
            creditType: "general",
            amount: -3,
            sourceType: "manual_adjustment",
            reason: "ปรับยอด",
            createdBy: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d21",
            createdAt: "2026-09-10T00:00:00Z",
          },
        ],
        page: { nextCursor: null, hasMore: false },
      }),
    );
    const page = await listCreditLedger(
      "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d02",
      { limit: 50 },
      { origin: "http://localhost:3000" },
    );
    expect(page.data[0]!.entryType).toBe("adjustment");
    expect(page.hasMore).toBe(false);
    const calledPath = FETCH_STUB.mock.calls[0]![0] as URL;
    expect(calledPath.searchParams.get("limit")).toBe("50");
  });
});

/** ตัวช่วยเรียก createCreditRule ด้วย input ตัวอย่าง (กันละเมิด exactOptionalPropertyTypes ในเทส) */
async function createCreditRuleInput() {
  return createCreditRule(
    {
      code: "CR-LTC-002",
      name: "ผ่านหลักสูตรจริยธรรม",
      credits: 6,
      carryOver: true,
    },
    { origin: "http://localhost:3000" },
  );
}

describe("zod outbound schema (fail-closed ตรงกับ resource ของ BFF)", () => {
  it("CreditRuleResource แถวถูกต้อง parse ผ่าน", () => {
    expect(CreditRuleResource.safeParse(RULE_OK).success).toBe(true);
  });

  it("CreditRuleResource strict — key แปลกปลอมต้องไม่ผ่าน", () => {
    const parsed = CreditRuleResource.safeParse({ ...RULE_OK, isAdmin: true });
    expect(parsed.success).toBe(false);
  });

  it("CREDIT_RULE_STATUSES ครบ 3 ค่า lifecycle", () => {
    expect([...CREDIT_RULE_STATUSES]).toEqual(["draft", "active", "retired"]);
  });

  it("CreditLedgerRowResource strict — แถวถูกต้องผ่าน · key แปลกไม่ผ่าน", () => {
    const row = {
      id: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d30",
      cycleNo: 1,
      entryType: "accrual",
      creditType: "general",
      amount: 12,
      sourceType: "assessment_attempt",
      reason: null,
      createdBy: null,
      createdAt: "2026-09-10T00:00:00Z",
    };
    expect(CreditLedgerRowResource.safeParse(row).success).toBe(true);
    expect(CreditLedgerRowResource.safeParse({ ...row, cycleNo: 0 }).success).toBe(false);
    expect(CreditLedgerRowResource.safeParse({ ...row, extra: 1 }).success).toBe(false);
  });

  it("CreditAdjustmentResource strict — reason สั้นกว่า 10 ต้องไม่ผ่าน", () => {
    const row = {
      id: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d31",
      userId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d32",
      renewalCycleId: "0b4c9a86-9b6f-4a3e-9a5d-1f2a3b4c5d33",
      creditType: "general",
      amount: 5,
      reason: "สั้น",
      createdAt: "2026-09-10T00:00:00Z",
    };
    expect(CreditAdjustmentResource.safeParse(row).success).toBe(false);
    expect(
      CreditAdjustmentResource.safeParse({ ...row, reason: "ปรับยอดตามมติประชุม" }).success,
    ).toBe(true);
  });
});
