import { NextRequest, NextResponse } from "next/server";
import { readDb } from "@/lib/db/store";
import { buildPublicVerificationResponse } from "@/lib/domain/ltc-logic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const normalizedCode = decodeURIComponent(code || "")
    .trim()
    .toUpperCase();

  const db = readDb();
  let cert = db.certificates.find(
    (c) => c.verificationCode.toUpperCase() === normalizedCode,
  );

  // Built-in revoked demo certificate for testing revoked verification state
  if (!cert && normalizedCode === "LTC-2026-109482") {
    cert = {
      id: "cert-revoked-demo",
      verificationCode: "LTC-2026-109482",
      userId: "u-lawyer-002",
      courseId: "crs-102",
      attemptId: null,
      recipientName: "สุรเชษฐ์ ใจมั่น",
      courseTitleTh: "จรรยาบรรณวิชาชีพทนายความ",
      creditsAwarded: 4,
      issuedAt: "2026-06-15T10:00:00.000Z",
      issuedBy: "u-registrar-001",
      issueMode: "manual",
      status: "revoked",
      revokedAt: "2026-07-01T09:30:00.000Z",
      revokedBy: "u-registrar-001",
      revokedReason: "ตรวจพบการออกใบประกาศซ้ำซ้อนในรอบปีเดียวกัน จึงเพิกถอนฉบับเดิมตามระเบียบนายทะเบียน",
    };
  }

  if (!cert) {
    return NextResponse.json(
      {
        found: false,
        error: {
          code: "ERR-CERT-001",
          message: "ไม่พบข้อมูลใบประกาศนียบัตรรหัสนี้ในสารบบสภาทนายความ",
        },
        sampleValidCodes: db.certificates
          .filter((c) => c.status === "valid")
          .slice(0, 3)
          .map((c) => c.verificationCode),
      },
      { status: 404 },
    );
  }

  // Enforce PDPA-minimal public verification contract via pure domain function
  const publicView = buildPublicVerificationResponse({
    id: cert.id,
    verificationCode: cert.verificationCode,
    userId: cert.userId,
    recipientName: cert.recipientName,
    recipientEmail: "redacted@ltc.or.th",
    recipientPhone: "081-000-0000",
    recipientLicenseNo: "99999",
    courseId: cert.courseId,
    courseTitleTh: cert.courseTitleTh,
    creditsAwarded: cert.creditsAwarded,
    issuedAt: cert.issuedAt,
    status: cert.status,
    revokedReason: cert.revokedReason,
  });

  return NextResponse.json({
    found: true,
    certificate: {
      verificationCode: publicView.verificationCode,
      status: publicView.status === "valid" ? "valid" : "revoked",
      recipientName: publicView.recipientName,
      courseTitle: publicView.courseTitleTh,
      issuedAt: publicView.issuedAt,
      creditsAwarded: publicView.creditsAwarded,
      revokedAt: cert.revokedAt,
      revokedReason: cert.revokedReason,
      issuer: publicView.issuer,
    },
  });
}
