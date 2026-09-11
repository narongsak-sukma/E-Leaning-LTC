/**
 * Unit tests: src/lib/certificates/pdf.ts — render with real Sarabun TTFs from src/assets/fonts
 */
import { describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({
  certPublicBaseUrl: "https://elearning.lawyerthai.test" as string | null,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    logLevel: "info",
    certPublicBaseUrl: configState.certPublicBaseUrl,
  }),
}));
vi.mock("server-only", () => ({}));

import QRCode from "qrcode";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { generateVerifyCode } from "./shared";
import { qrUrlOf, renderCertificatePdf } from "./pdf";

describe("qrUrlOf / formatThaiDate contract", () => {
  it("QR payload = ${certPublicBaseUrl}/verify/${verify_code} — ไม่มี PII", () => {
    expect(qrUrlOf("https://elearning.lawyerthai.test", "CODE123")).toBe(
      "https://elearning.lawyerthai.test/verify/CODE123",
    );
  });
});

describe("renderCertificatePdf — ฟอนต์จริง + QR จริง", () => {
  it("เรนเดอร์ PDF จริง: %PDF header + ฟอนต์ Sarabun (FontFile2) + QR PNG", async () => {
    const toBufferSpy = vi.spyOn(QRCode, "toBuffer");
    const bytes = await renderCertificatePdf({
      certNo: "LTC-2026-000001",
      verifyCode: "kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXXXX",
      holderName: "นายสมชาย ใจดี",
      courseTitle: "หลักสูตรจรรยาบรรณทนายความ",
      issuedAt: new Date("2026-09-08T04:00:00Z"),
    });

    expect(toBufferSpy).toHaveBeenCalledTimes(1);
    const [payload, opts] = toBufferSpy.mock.calls[0] ?? [];
    expect(payload).toBe("https://elearning.lawyerthai.test/verify/kRE7eSampleVerifyCode43CharsLongXXXXXXXXXXXXX");
    expect((opts as { errorCorrectionLevel?: string } | undefined)?.errorCorrectionLevel).toBe("M");

    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);

    // pdf-lib เขียน dict ใน object stream (compressed) → ตรวจโครงสร้างผ่าน pdf-lib เอง
    const loaded = await PDFDocument.load(bytes);
    let fontFile2Count = 0;
    let imageCount = 0;
    const fontNames: string[] = [];
    for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
      // stream object (ฟอนต์/รูป) เก็บ dict ไว้ข้างใน — unwrap ก่อนตรวจ
      const dict = obj instanceof PDFDict ? obj : (obj as { dict?: PDFDict }).dict;
      if (dict === undefined || !(dict instanceof PDFDict)) continue;
      if (dict.get(PDFName.of("FontFile2")) !== undefined) fontFile2Count += 1;
      if (dict.get(PDFName.of("Type"))?.toString() === "/Font") {
        fontNames.push(dict.get(PDFName.of("BaseFont"))?.toString() ?? "");
      }
      if (dict.get(PDFName.of("Subtype"))?.toString() === "/Image") imageCount += 1;
    }
    expect(fontFile2Count).toBe(2);
    expect(fontNames.join(" ")).toContain("Sarabun");
    expect(imageCount).toBeGreaterThanOrEqual(1);
    toBufferSpy.mockRestore();
  });

  it("verify_code 43 อักขระจริงจาก shared เรนเดอร์ได้ + QR ความยาวจริง", async () => {
    const { generateVerifyCode } = await import("./shared");
    const bytes = await renderCertificatePdf({
      certNo: "LTC-2026-000002",
      verifyCode: generateVerifyCode(),
      holderName: "นางสาวสมหญิง รักเรียน",
      courseTitle: "หลักสูตรกฎหมายที่จำเป็นต่อชีวิตประจำวัน",
      issuedAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF-")).toBe(true);
  });

  it("ไม่มี CERT_PUBLIC_BASE_URL → fail-closed ERR-SYS-002 (cert_public_base_url_missing)", async () => {
    configState.certPublicBaseUrl = null;
    try {
      await renderCertificatePdf({
        certNo: "LTC-2026-000003",
        verifyCode: generateVerifyCode(),
        holderName: "นายสมชาย ใจดี",
        courseTitle: "หลักสูตรทดสอบ",
        issuedAt: new Date("2026-09-08T04:00:00Z"),
      });
      expect.unreachable("ต้อง throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ERR-SYS-002");
    } finally {
      configState.certPublicBaseUrl = "https://elearning.lawyerthai.test";
    }
  });
});

