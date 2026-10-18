/**
 * Server-Side Session & BFF Guard — LTC E-Learning
 *
 * Enforces:
 * - Cookie (`ltc_session_token`) or `x-ltc-session` / `Authorization: Bearer` token resolution
 * - RBAC permission checks via `authorizeAction` (deny-by-default)
 * - MFA step-up (`aal2`) verification for privileged roles (`instructor`, `staff:*`, `super_admin`)
 */
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  type AalLevel,
  type Permission,
  type Role,
  authorizeAction,
  requiresMfa,
} from "@/lib/domain/ltc-logic";
import {
  type DbLawyerLicense,
  type DbProfile,
  type LtcDatabase,
  getActiveRolesForUser,
  getVerifiedLicenseForUser,
  readDb,
  writeDb,
} from "@/lib/db/store";

export const SESSION_COOKIE_NAME = "ltc_session_token";

export interface ResolvedSessionContext {
  token: string;
  portal: "frontoffice" | "backoffice";
  aal: AalLevel;
  user: DbProfile;
  roles: Role[];
  verifiedLicense: DbLawyerLicense | null;
  requiresMfaChallenge: boolean;
}

export async function resolveServerSession(
  req?: NextRequest,
  existingDb?: LtcDatabase,
): Promise<ResolvedSessionContext | null> {
  const db = existingDb ?? readDb();
  let token: string | undefined;

  if (req) {
    token =
      req.headers.get("x-ltc-session") ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      req.cookies.get(SESSION_COOKIE_NAME)?.value;
  }

  if (!token) {
    try {
      const cookieStore = await cookies();
      token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    } catch {
      // Ignore outside request context
    }
  }

  if (!token) return null;

  const sessionRow = db.sessions.find((s) => s.token === token);
  if (!sessionRow) return null;

  if (new Date(sessionRow.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  const user = db.profiles.find(
    (p) => p.id === sessionRow.userId && p.isActive && !p.deletedAt,
  );
  if (!user) return null;

  const roles = getActiveRolesForUser(db, user.id);
  const verifiedLicense = getVerifiedLicenseForUser(db, user.id);
  const needsMfa = requiresMfa(roles) && sessionRow.aal !== "aal2";

  return {
    token: sessionRow.token,
    portal: sessionRow.portal,
    aal: sessionRow.aal,
    user,
    roles,
    verifiedLicense,
    requiresMfaChallenge: needsMfa,
  };
}

export function createSessionRecord(
  db: LtcDatabase,
  userId: string,
  portal: "frontoffice" | "backoffice",
  aal: AalLevel,
): string {
  const token = `ltc_${portal}_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7); // 7 days

  db.sessions.push({
    token,
    userId,
    aal,
    portal,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  });
  writeDb(db);
  return token;
}

export function attachSessionCookie(
  res: NextResponse,
  token: string,
): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

export function verifyGuardPermission(
  session: ResolvedSessionContext | null,
  permission: Permission,
):
  | { ok: true; session: ResolvedSessionContext }
  | { ok: false; response: NextResponse } {
  const decision = authorizeAction({
    userId: session?.user.id ?? null,
    roles: session?.roles ?? [],
    aal: session?.aal ?? "aal1",
    permission,
  });

  if (!decision.allowed || !session) {
    const errCode = !decision.allowed ? decision.errorCode : "ERR-RBAC-001";
    const errMsg = !decision.allowed
      ? decision.message
      : "ไม่มีสิทธิ์ดำเนินการนี้";
    const status = !decision.allowed ? decision.httpStatus : 403;
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: errCode,
            message: errMsg,
            requiredPermission: permission,
          },
        },
        { status },
      ),
    };
  }

  return { ok: true, session };
}
