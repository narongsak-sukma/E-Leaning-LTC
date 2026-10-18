import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  attachSessionCookie,
  clearSessionCookie,
  createSessionRecord,
  resolveServerSession,
} from "@/lib/auth/server-session";
import {
  appendAuditLog,
  getActiveRolesForUser,
  getUserNetCredits,
  getVerifiedLicenseForUser,
  readDb,
  writeDb,
} from "@/lib/db/store";
import { hasBackofficeAccess, requiresMfa } from "@/lib/domain/ltc-logic";
import {
  authenticateWithSupabaseAuth,
  ensureSupabaseSeeded,
  upsertSupabaseAuthUser,
} from "@/lib/supabase/server";

const EMAIL_ALIASES: Record<string, string> = {
  "lawyer@ltc.or.th": "thanakorn@ltc.or.th",
  "citizen@ltc.or.th": "piyaporn@ltc.or.th",
  "courseadmin@ltc.or.th": "content@ltc.or.th",
  "auditor@ltc.or.th": "viewer@ltc.or.th",
};

export async function GET(req: NextRequest) {
  const db = readDb();
  const supabaseStatus = await ensureSupabaseSeeded(db);
  const session = await resolveServerSession(req, db);

  const demoPersonas = db.profiles.map((p) => {
    const roles = getActiveRolesForUser(db, p.id);
    const lic = getVerifiedLicenseForUser(db, p.id);
    return {
      id: p.id,
      displayName: p.displayName,
      email: p.email,
      roles,
      licenseNo: lic?.licenseNo ?? null,
      mfaEnabled: p.mfaEnabled,
      portalType: hasBackofficeAccess(roles) ? "backoffice" : "frontoffice",
    };
  });

  if (!session) {
    return NextResponse.json({
      authenticated: false,
      session: null,
      demoPersonas,
      supabaseStatus,
    });
  }

  const unreadNotifications = db.notifications.filter(
    (n) => n.userId === session.user.id,
  );
  const netCredits = getUserNetCredits(db, session.user.id);

  return NextResponse.json({
    authenticated: true,
    session: {
      token: session.token,
      portal: session.portal,
      aal: session.aal,
      requiresMfaChallenge: session.requiresMfaChallenge,
      user: {
        id: session.user.id,
        displayName: session.user.displayName,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        email: session.user.email,
        phone: session.user.phone,
        preferredLocale: session.user.preferredLocale,
        mfaEnabled: session.user.mfaEnabled,
      },
      roles: session.roles,
      verifiedLicense: session.verifiedLicense,
      netCredits,
      notifications: unreadNotifications,
    },
    demoPersonas,
    supabaseStatus,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "login");
  const db = readDb();

  if (action === "logout") {
    const token =
      req.headers.get("x-ltc-session") ||
      req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
      db.sessions = db.sessions.filter((s) => s.token !== token);
      writeDb(db);
    }
    const res = NextResponse.json({ ok: true });
    return clearSessionCookie(res);
  }

  if (action === "login") {
    const rawId = String(body.identifier || body.email || "")
      .trim()
      .toLowerCase();
    const identifier = EMAIL_ALIASES[rawId] || rawId;
    const password = String(body.password || "").trim();
    const portal: "frontoffice" | "backoffice" =
      body.portal === "backoffice" ? "backoffice" : "frontoffice";

    if (!identifier || !password) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณากรอกอีเมลหรือเลขใบอนุญาต และรหัสผ่านให้ครบถ้วน",
          },
        },
        { status: 422 },
      );
    }

    let matchedProfile = db.profiles.find(
      (p) => p.email.toLowerCase() === identifier && p.isActive && !p.deletedAt,
    );

    if (!matchedProfile) {
      const lic = db.lawyerLicenses.find(
        (l) => l.licenseNo === identifier && l.status === "verified",
      );
      if (lic) {
        matchedProfile = db.profiles.find(
          (p) => p.id === lic.userId && p.isActive && !p.deletedAt,
        );
      }
    }

    const validPasswords = new Set([
      matchedProfile?.passwordHash,
      "Password123!",
      "Lawyer@2569",
      "Citizen@2569",
      "Admin@2569",
      "Registrar@2569",
      "Content@2569",
      "Course@2569",
      "Instructor@2569",
    ]);

    if (!matchedProfile || !validPasswords.has(password)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-AUTH-002",
            message: "อีเมล/เลขใบอนุญาต หรือรหัสผ่านไม่ถูกต้อง",
          },
        },
        { status: 401 },
      );
    }

    const roles = getActiveRolesForUser(db, matchedProfile.id);

    if (portal === "backoffice" && !hasBackofficeAccess(roles)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-ADM-001",
            message:
              "บัญชีนี้เป็นบัญชีผู้เรียน (Frontoffice) ไม่มีสิทธิ์เข้าใช้งานระบบบริหารจัดการ (Backoffice)",
          },
        },
        { status: 403 },
      );
    }

    const needsMfa = requiresMfa(roles);
    const token = createSessionRecord(db, matchedProfile.id, portal, "aal1");

    // Authenticate & verify JWT against SUPABASE_JWKS_URL
    await ensureSupabaseSeeded(db);
    const supaAuth = await authenticateWithSupabaseAuth(
      matchedProfile.email,
      matchedProfile.passwordHash || "Password123!",
    );

    appendAuditLog(db, {
      eventType: portal === "backoffice" ? "BACKOFFICE_LOGIN" : "FRONTOFFICE_LOGIN",
      actorUserId: matchedProfile.id,
      actorName: matchedProfile.displayName,
      actorRole: roles.join(","),
      targetTable: "sessions",
      targetId: matchedProfile.id,
      summaryTh: `เข้าสู่ระบบผ่านพอร์ทัล ${portal === "backoffice" ? "Backoffice (เจ้าหน้าที่/ผู้สอน)" : "Frontoffice (ผู้เรียน)"}${supaAuth.ok ? ` · ยืนยัน Supabase JWT (kid: ${supaAuth.jwksKid})` : ""}`,
    });
    writeDb(db);

    const res = NextResponse.json({
      ok: true,
      token,
      portal,
      requiresMfaStepUp: needsMfa,
      mfaHintCode: needsMfa ? "123456" : null,
      supabaseJwtVerified: supaAuth.ok,
      supabaseJwksKid: supaAuth.jwksKid ?? null,
      user: {
        id: matchedProfile.id,
        displayName: matchedProfile.displayName,
        email: matchedProfile.email,
      },
      roles,
    });
    return attachSessionCookie(res, token);
  }

  if (action === "verify_mfa") {
    const otpCode = String(body.otpCode || "").trim();
    const session = await resolveServerSession(req, db);
    if (!session) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-AUTH-001",
            message: "กรุณาเข้าสู่ระบบก่อนยืนยันรหัส MFA",
          },
        },
        { status: 401 },
      );
    }

    if (!/^\d{6}$/.test(otpCode)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "รหัส OTP ต้องเป็นตัวเลข 6 หลัก",
          },
        },
        { status: 422 },
      );
    }

    if (
      otpCode !== session.user.mfaSecret &&
      otpCode !== "123456" &&
      otpCode !== "256900"
    ) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-AUTH-005",
            message: "รหัส OTP ไม่ถูกต้อง (รหัสทดสอบคือ 123456)",
          },
        },
        { status: 400 },
      );
    }

    const sessionRow = db.sessions.find((s) => s.token === session.token);
    if (sessionRow) {
      sessionRow.aal = "aal2";
    }

    appendAuditLog(db, {
      eventType: "MFA_STEP_UP_AAL2",
      actorUserId: session.user.id,
      actorName: session.user.displayName,
      actorRole: session.roles.join(","),
      targetTable: "sessions",
      targetId: session.user.id,
      summaryTh: `ยืนยันตัวตนสองชั้น (MFA Step-up AAL2) สำเร็จ สำหรับสิทธิ์ ${session.roles.join(", ")}`,
    });
    writeDb(db);

    return NextResponse.json({
      ok: true,
      aal: "aal2",
      roles: session.roles,
    });
  }

  if (action === "register") {
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "").trim();
    const roleTrack = body.roleTrack === "lawyer" ? "lawyer" : "citizen";
    const licenseNo = String(body.licenseNo || "").trim();
    const pdpaAccepted = Boolean(body.pdpaAccepted);

    if (!firstName || !lastName || !email || !password) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณากรอกชื่อ นามสกุล อีเมล และรหัสผ่านให้ครบถ้วน",
          },
        },
        { status: 422 },
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร",
          },
        },
        { status: 422 },
      );
    }

    if (!pdpaAccepted) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณายอมรับนโยบายคุ้มครองข้อมูลส่วนบุคคล (PDPA) ก่อนสมัครสมาชิก",
          },
        },
        { status: 422 },
      );
    }

    if (roleTrack === "lawyer" && !/^\d{4,7}$/.test(licenseNo)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "กรุณาระบุเลขที่ใบอนุญาตว่าความ (ตัวเลข 4–7 หลัก) เพื่อส่งคำขอตรวจสอบ",
          },
        },
        { status: 422 },
      );
    }

    if (db.profiles.some((p) => p.email.toLowerCase() === email)) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-VAL-001",
            message: "อีเมลนี้มีในระบบแล้ว กรุณาเข้าสู่ระบบ",
          },
        },
        { status: 409 },
      );
    }

    const nowIso = new Date().toISOString();
    const newUserId = `u-user-${Date.now()}`;
    const displayName = `${firstName} ${lastName}`;

    db.profiles.push({
      id: newUserId,
      displayName,
      firstName,
      lastName,
      email,
      passwordHash: password,
      phone: phone || null,
      preferredLocale: "th",
      pdpaConsentedAt: nowIso,
      isActive: true,
      deletedAt: null,
      mfaEnabled: false,
      mfaSecret: "123456",
      createdAt: nowIso,
    });

    db.roleAssignments.push({
      id: `ra-${Date.now()}`,
      userId: newUserId,
      role: "citizen",
      grantedBy: null,
      grantedAt: nowIso,
      revokedAt: null,
      reason: "สมัครสมาชิกใหม่ (Baseline Citizen Role)",
    });

    if (roleTrack === "lawyer" && licenseNo) {
      const appId = `lapp-${Date.now()}`;
      db.licenseApplications.unshift({
        id: appId,
        userId: newUserId,
        licenseNo,
        evidenceNote: `ยื่นพร้อมการสมัครสมาชิกใหม่ (${displayName})`,
        status: "pending",
        submittedAt: nowIso,
        decidedBy: null,
        decidedAt: null,
        rejectedReason: null,
        resultingLicenseId: null,
      });

      appendAuditLog(db, {
        eventType: "LICENSE_BIND_REQUEST",
        actorUserId: newUserId,
        actorName: displayName,
        actorRole: "citizen",
        targetTable: "license_applications",
        targetId: appId,
        summaryTh: `สมัครสมาชิกใหม่และยื่นคำขอผูกเลขใบอนุญาต ทล. ${licenseNo} รอนายทะเบียนอนุมัติ`,
      });
    }

    const token = createSessionRecord(db, newUserId, "frontoffice", "aal1");
    await upsertSupabaseAuthUser({
      email,
      password,
      displayName,
      ltcProfileId: newUserId,
      roles: ["citizen"],
    });
    writeDb(db);

    const res = NextResponse.json({
      ok: true,
      token,
      portal: "frontoffice",
      requiresMfaStepUp: false,
      user: {
        id: newUserId,
        displayName,
        email,
      },
      roles: ["citizen"],
    });
    return attachSessionCookie(res, token);
  }

  if (action === "switch_demo") {
    const rawUserId = String(body.userId || "");
    const userIdMap: Record<string, string> = {
      "u-admin-001": "u-superadmin-001",
      "u-courseadmin-001": "u-content-001",
      "u-auditor-001": "u-viewer-001",
    };
    const userId = userIdMap[rawUserId] || rawUserId;

    const targetUser = db.profiles.find((p) => p.id === userId && p.isActive);
    if (!targetUser) {
      return NextResponse.json(
        {
          error: {
            code: "ERR-NF-001",
            message: "ไม่พบบัญชีทดสอบที่เลือก",
          },
        },
        { status: 404 },
      );
    }

    const roles = getActiveRolesForUser(db, targetUser.id);
    const isBackoffice = hasBackofficeAccess(roles);
    const portal: "frontoffice" | "backoffice" =
      body.portal === "backoffice" || isBackoffice ? "backoffice" : "frontoffice";
    const aal =
      body.autoVerifyMfa === true && requiresMfa(roles) ? "aal2" : "aal1";

    const token = createSessionRecord(db, targetUser.id, portal, aal);
    const res = NextResponse.json({
      ok: true,
      token,
      portal,
      aal,
      requiresMfaStepUp: requiresMfa(roles) && aal !== "aal2",
      mfaHintCode: "123456",
      user: {
        id: targetUser.id,
        displayName: targetUser.displayName,
        email: targetUser.email,
      },
      roles,
    });
    return attachSessionCookie(res, token);
  }

  return NextResponse.json(
    {
      error: {
        code: "ERR-VAL-001",
        message: "คำสั่ง auth ไม่ถูกต้อง",
      },
    },
    { status: 400 },
  );
}
