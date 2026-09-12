/**
 * providers.test — unit ของ provider ทั้ง 3 (console|smtp|resend) — Wave E Phase 4
 *
 * จุดหลัก: provider routing ตาม config · payload ของ resend (endpoint/Bearer/body) ·
 * smtp transport จาก config (auth เมื่อมีคู่ user+password เท่านั้น) · catch ทุกอย่าง
 * (ไม่ throw แม้ provider ล้ม) · **ไม่มี to_email/payload ใน log/wire** — mock
 * nodemailer/fetch ทั้งหมด (ไม่ยิงของจริง)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn() },
}));

import nodemailer from "nodemailer";
import {
  buildEmailHtml,
  consoleProvider,
  createEmailSender,
  escapeHtml,
  normalizeSubject,
  RESEND_ENDPOINT,
  resendProvider,
  smtpProvider,
  sha256Hex,
  type EmailMessage,
  type EmailProviderConfig,
} from "./providers";

/** stub config ของ provider — แคบตาม EmailProviderConfig */
function providerConfig(overrides: Partial<EmailProviderConfig> = {}): EmailProviderConfig {
  return {
    emailProvider: "console",
    smtp: null,
    emailFrom: "ทดสอบระบบ <no-reply@ltc.local>",
    resendApiKey: null,
    logLevel: "info",
    ...overrides,
  };
}

/** ข้อความทดสอบ — to_email ปลอม */
function msg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: "learner@ltc.local",
    subject: "ผลสอบ — ผ่านเกณฑ์",
    body: "ยินดีด้วย คุณทดสอบ ได้คะแนน 90/80\nรายละเอียดในระบบ",
    ...overrides,
  };
}

/** stub transport ของ nodemailer (จับ sendMail ทั้งหมด — ไม่ยิงของจริง) */
function transportStub(behavior?: { reject?: Error }) {
  const sendMail = vi.fn<(mail: unknown) => Promise<{ messageId: string }>>(
    async () => ({ messageId: "<stub@ltc.local>" }),
  );
  if (behavior?.reject !== undefined) {
    sendMail.mockRejectedValue(behavior.reject);
  }
  const transport = { sendMail };
  vi.mocked(nodemailer.createTransport).mockReturnValue(transport as never);
  return { sendMail, transport };
}

/** stub fetch (resend — จับ request ทั้งหมด — ไม่ยิงของจริง) */
function fetchStub(behavior?: { status?: number; ok?: boolean; reject?: Error }) {
  const fetchMock = vi.fn<
    (input: unknown, init?: unknown) => Promise<{ ok: boolean; status: number }>
  >(async () => ({
    ok: behavior?.ok ?? true,
    status: behavior?.status ?? 200,
  }));
  if (behavior?.reject !== undefined) {
    fetchMock.mockRejectedValue(behavior.reject);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildEmailHtml / escapeHtml / normalizeSubject — html wrapper", () => {
  it("html มี doctype + meta charset utf-8 + lang th", () => {
    const html = buildEmailHtml("หัวเรื่อง", "เนื้อความ");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('lang="th"');
  });

  it("escape <script> ใน subject/body กัน HTML injection", () => {
    const html = buildEmailHtml("<script>alert(1)</script>", "<b>โจมตี</b>");
    expect(html).not.toContain("<b>โจมตี</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("แปลง \n เป็น <br> ใน html", () => {
    const html = buildEmailHtml("หัว", "บรรทัด 1\nบรรทัด 2");
    expect(html).toContain("บรรทัด 1<br>บรรทัด 2");
  });

  it("normalizeSubject ตัด line break (กัน header injection)", () => {
    expect(normalizeSubject("a\r\nBCC: x\nb")).toBe("a BCC: x b");
  });

  it("escapeHtml ครบ 5 อักขระ", () => {
    expect(escapeHtml(`<>"'&`)).toBe("&lt;&gt;&quot;&#39;&amp;");
  });

  it("sha256Hex คงเส้นคงวา + ไม่มี to_email ค้างใน hash input", () => {
    expect(sha256Hex("learner@ltc.local")).toBe(sha256Hex("learner@ltc.local"));
  });
});

describe("consoleProvider — log บรรทัดเดียวไม่มี to_email", () => {
  it("ok เสมอ + log JSON บรรทัดเดียว ไม่มี to_email/subject/body/payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = consoleProvider("info");
    const result = await send(msg());
    expect(result.ok).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]?.[0]);
    // parse เป็น JSON ได้ + ไม่มี PII ใด ๆ ในบรรทัด log
    expect(line).not.toContain("learner@ltc.local");
    expect(line).not.toContain("ผลสอบ");
    expect(line).not.toContain("ยินดีด้วย");
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry["level"]).toBe("info");
    expect(entry["msg"]).toBe("email_console_delivery");
    expect(entry["route"]).toBe("email/console");
    expect(entry["request_id"]).toBe(sha256Hex("learner@ltc.local").slice(0, 16));
    logSpy.mockRestore();
  });

  it("log ผ่าน allowlist ของ logger — ฟิลด์นอก allowlist ถูกตัดทิ้ง", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = consoleProvider("debug");
    await send(msg({ to: "other@ltc.local" }));
    const entry = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(entry).every((k) =>
      ["ts", "level", "msg", "request_id", "route", "user_id", "duration_ms", "status"].includes(k),
    )).toBe(true);
    logSpy.mockRestore();
  });
});

describe("smtpProvider — nodemailer transport จาก config", () => {
  it("createTransport จาก config (host/port/secure) — ไม่มี auth เมื่อไม่มีคู่ user+password", () => {
    transportStub();
    const send = smtpProvider(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "mailpit", port: 1025, user: null, password: null },
    }));
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    void send;
    expect(vi.mocked(nodemailer.createTransport).mock.calls[0]?.[0]).toMatchObject({
      host: "mailpit",
      port: 1025,
      secure: false,
    });
    const opts = vi.mocked(nodemailer.createTransport).mock.calls[0]?.[0] as { auth?: unknown };
    expect(opts.auth).toBeUndefined();
  });

  it("มี user+password ครบคู่ → สร้าง auth (dev SMTP จริง/prod)", () => {
    transportStub();
    const send = smtpProvider(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "smtp.example", port: 587, user: "dev", password: "dev" },
    }));
    void send;
    const opts = vi.mocked(nodemailer.createTransport).mock.calls[0]?.[0] as { auth?: unknown };
    expect(opts.auth).toEqual({ user: "dev", pass: "dev" });
  });

  it("sendMail ได้ from/to/subject/text/html ครบ — html มี charset utf-8", async () => {
    const { sendMail } = transportStub();
    const send = smtpProvider(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "mailpit", port: 1025, user: null, password: null },
    }));
    const message = msg();
    const result = await send(message);
    expect(result.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({
      from: "ทดสอบระบบ <no-reply@ltc.local>",
      to: "learner@ltc.local",
      subject: "ผลสอบ — ผ่านเกณฑ์",
      text: message.body,
    });
    const html = (sendMail.mock.calls[0]?.[0] as { html: string }).html;
    expect(html).toContain('<meta charset="utf-8">');
  });

  it("sendMail ล้ม → { ok:false, error } ไม่ throw (คิวไม่ตาย)", async () => {
    transportStub({ reject: Object.assign(new Error("relay denied"), { code: "ESOME" }) });
    const send = smtpProvider(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "mailpit", port: 1025, user: null, password: null },
    }));
    const result = await send(msg());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("smtp_esome");
  });

  it("error.code ไม่ตรงแบบ token ปลอดภัย → smtp_send_failed", async () => {
    transportStub({ reject: Object.assign(new Error("x"), { code: "bad code!" }) });
    const send = smtpProvider(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "mailpit", port: 1025, user: null, password: null },
    }));
    const result = await send(msg());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("smtp_send_failed");
  });

  it("smtp = null (config drift) → smtp_config_missing · emailFrom null → email_from_missing", async () => {
    const send = smtpProvider(providerConfig({ emailProvider: "smtp", smtp: null }));
    expect(await send(msg())).toEqual({ ok: false, error: "smtp_config_missing" });
    transportStub();
    const send2 = smtpProvider(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "h", port: 25, user: null, password: null },
      emailFrom: null,
    }));
    expect(await send2(msg())).toEqual({ ok: false, error: "email_from_missing" });
  });
});

describe("resendProvider — fetch POST ตาม payload ของ Resend", () => {
  it("endpoint/Bearer/JSON body {from,to,subject,html} ถูกต้อง — ไม่มีของจริง", async () => {
    const fetchMock = fetchStub({ ok: true });
    const send = resendProvider(providerConfig({
      emailProvider: "resend",
      resendApiKey: "re_test_123",
    }));
    const message = msg();
    const result = await send(message);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer re_test_123");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["from"]).toBe("ทดสอบระบบ <no-reply@ltc.local>");
    expect(body["to"]).toEqual(["learner@ltc.local"]);
    expect(body["subject"]).toBe("ผลสอบ — ผ่านเกณฑ์");
    const html = String(body["html"]);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toContain("learner@ltc.local");
  });

  it("HTTP 500 → ok:false + static token ไม่มี body ของ Resend หลุด", async () => {
    const fetchMock = fetchStub({ ok: false, status: 500 });
    const send = resendProvider(providerConfig({
      emailProvider: "resend",
      resendApiKey: "re_test_123",
    }));
    const result = await send(msg());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("resend_http_500");
    void fetchMock;
  });

  it("fetch throw (network) → resend_network_error · abort → resend_timeout", async () => {
    const fetchMock = fetchStub({ reject: new Error("ECONNREFUSED") });
    const send = resendProvider(providerConfig({
      emailProvider: "resend",
      resendApiKey: "re_test_123",
    }));
    const result = await send(msg());
    expect(result).toEqual({ ok: false, error: "resend_network_error" });
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);
    const result2 = await send(msg());
    expect(result2).toEqual({ ok: false, error: "resend_timeout" });
  });

  it("ไม่มี RESEND_API_KEY → resend_api_key_missing · ไม่มี EMAIL_FROM → email_from_missing", async () => {
    const send = resendProvider(providerConfig({ emailProvider: "resend", resendApiKey: null }));
    expect(await send(msg())).toEqual({ ok: false, error: "resend_api_key_missing" });
    const send2 = resendProvider(providerConfig({
      emailProvider: "resend",
      resendApiKey: "re_test_123",
      emailFrom: null,
    }));
    expect(await send2(msg())).toEqual({ ok: false, error: "email_from_missing" });
  });
});

describe("createEmailSender — routing ตาม EMAIL_PROVIDER", () => {
  it("console → log email_console_delivery (ไม่มี to_email ใน log)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const send = createEmailSender(providerConfig({ emailProvider: "console" }));
    const result = await send(msg());
    expect(result.ok).toBe(true);
    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain("email_console_delivery");
    expect(line).not.toContain("learner@ltc.local");
    logSpy.mockRestore();
  });

  it("smtp → สร้าง transport จริงจาก config", async () => {
    transportStub();
    const send = createEmailSender(providerConfig({
      emailProvider: "smtp",
      smtp: { host: "mailpit", port: 1025, user: null, password: null },
    }));
    await send(msg());
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
  });

  it("resend → fetch ถูกเรียก endpoint จริง", async () => {
    fetchStub({ ok: true });
    const send = createEmailSender(providerConfig({
      emailProvider: "resend",
      resendApiKey: "re_test_123",
    }));
    const result = await send(msg());
    expect(result.ok).toBe(true);
  });
});
