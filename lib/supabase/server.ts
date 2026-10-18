import crypto from "node:crypto";
import type { LtcDatabase } from "@/lib/db/store";
import { getActiveRolesForUser } from "@/lib/db/store";

export interface SupabaseServerConfig {
  url: string;
  publishableKey: string;
  secretKey: string;
  jwksUrl: string;
  enabled: boolean;
}

export function getSupabaseServerConfig(): SupabaseServerConfig {
  const url = (
    process.env.SUPABASE_URL || "https://eaoauzqbaapaoblljfcc.supabase.co"
  ).replace(/\/$/, "");
  const publishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";
  const secretKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";
  const jwksUrl =
    process.env.SUPABASE_JWKS_URL ||
    `${url}/auth/v1/.well-known/jwks.json`;

  const enabled = Boolean(
    url &&
      secretKey &&
      secretKey !== "YOUR_SUPABASE_SECRET_KEY" &&
      !secretKey.startsWith("YOUR_"),
  );

  return {
    url,
    publishableKey,
    secretKey,
    jwksUrl,
    enabled,
  };
}

interface JwkKey {
  kid: string;
  kty: string;
  alg: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
  key_ops?: string[];
  ext?: boolean;
}

let cachedJwks: { keys: JwkKey[]; fetchedAt: number } | null = null;

export async function fetchSupabaseJwks(): Promise<JwkKey[]> {
  const cfg = getSupabaseServerConfig();
  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAt < 5 * 60 * 1000) {
    return cachedJwks.keys;
  }
  try {
    const res = await fetch(cfg.jwksUrl, {
      headers: cfg.publishableKey ? { apikey: cfg.publishableKey } : undefined,
      cache: "no-store",
    });
    if (!res.ok) return cachedJwks?.keys || [];
    const data = (await res.json()) as { keys?: JwkKey[] };
    const keys = Array.isArray(data.keys) ? data.keys : [];
    cachedJwks = { keys, fetchedAt: now };
    return keys;
  } catch {
    return cachedJwks?.keys || [];
  }
}

/**
 * Verifies a Supabase Auth JWT (ES256 P-256) against SUPABASE_JWKS_URL
 */
export async function verifySupabaseJwt(
  token: string,
): Promise<{
  valid: boolean;
  payload: Record<string, any> | null;
  kid?: string;
}> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { valid: false, payload: null };

    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8"),
    );
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );

    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return { valid: false, payload: null };
    }

    const keys = await fetchSupabaseJwks();
    const jwk =
      keys.find((k) => k.kid === header.kid) ||
      keys.find((k) => k.alg === header.alg) ||
      keys[0];

    if (!jwk) {
      return { valid: false, payload: null };
    }

    const publicKey = crypto.createPublicKey({
      key: jwk as any,
      format: "jwk",
    });

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
    const signature = Buffer.from(sigB64, "base64url");

    const verified = crypto.verify(
      "sha256",
      signingInput,
      {
        key: publicKey,
        dsaEncoding: "ieee-p1363",
      },
      signature,
    );

    return {
      valid: verified,
      payload: verified ? payload : null,
      kid: jwk.kid,
    };
  } catch {
    return { valid: false, payload: null };
  }
}

/**
 * Authenticates email/password against Supabase Auth (/auth/v1/token?grant_type=password)
 * and verifies the resulting JWT using SUPABASE_JWKS_URL.
 */
export async function authenticateWithSupabaseAuth(
  email: string,
  password: string,
): Promise<{
  ok: boolean;
  supabaseUserId?: string;
  accessToken?: string;
  jwtPayload?: Record<string, any> | null;
  jwksKid?: string;
}> {
  const cfg = getSupabaseServerConfig();
  if (!cfg.enabled) {
    return { ok: false };
  }
  const apiKeyToUse = cfg.publishableKey || cfg.secretKey;
  try {
    const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: apiKeyToUse,
        Authorization: `Bearer ${apiKeyToUse}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
    if (!res.ok) {
      return { ok: false };
    }
    const data = await res.json();
    const accessToken = data?.access_token;
    if (!accessToken) {
      return { ok: false };
    }
    const verified = await verifySupabaseJwt(accessToken);
    return {
      ok: verified.valid,
      supabaseUserId: data?.user?.id || verified.payload?.sub,
      accessToken,
      jwtPayload: verified.payload,
      jwksKid: verified.kid,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Creates or updates a user in Supabase Auth via Admin API (/auth/v1/admin/users)
 */
export async function upsertSupabaseAuthUser(params: {
  email: string;
  password: string;
  displayName: string;
  ltcProfileId: string;
  roles: string[];
}): Promise<{ ok: boolean; supabaseUserId?: string }> {
  const cfg = getSupabaseServerConfig();
  if (!cfg.enabled) return { ok: false };

  try {
    const createRes = await fetch(`${cfg.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: cfg.secretKey,
        Authorization: `Bearer ${cfg.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: params.email,
        password: params.password,
        email_confirm: true,
        user_metadata: {
          display_name: params.displayName,
          ltc_profile_id: params.ltcProfileId,
        },
        app_metadata: {
          roles: params.roles,
          provider: "email",
        },
      }),
      cache: "no-store",
    });

    if (createRes.ok) {
      const created = await createRes.json();
      return { ok: true, supabaseUserId: created?.id };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

const BUCKET_ID = "ltc-db-state";
const OBJECT_KEY = "ltc-elearning-db-v2.json";

/**
 * Pushes the latest LtcDatabase snapshot to Supabase Storage (private bucket)
 */
export async function pushDbStateToSupabase(db: LtcDatabase): Promise<boolean> {
  const cfg = getSupabaseServerConfig();
  if (!cfg.enabled) return false;

  try {
    const res = await fetch(
      `${cfg.url}/storage/v1/object/${BUCKET_ID}/${OBJECT_KEY}`,
      {
        method: "POST",
        headers: {
          apikey: cfg.secretKey,
          Authorization: `Bearer ${cfg.secretKey}`,
          "Content-Type": "application/json",
          "x-upsert": "true",
        },
        body: JSON.stringify(db),
        cache: "no-store",
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pulls the persisted LtcDatabase snapshot from Supabase Storage if present
 */
export async function pullDbStateFromSupabase(): Promise<LtcDatabase | null> {
  const cfg = getSupabaseServerConfig();
  if (!cfg.enabled) return null;

  try {
    const res = await fetch(
      `${cfg.url}/storage/v1/object/${BUCKET_ID}/${OBJECT_KEY}`,
      {
        method: "GET",
        headers: {
          apikey: cfg.secretKey,
          Authorization: `Bearer ${cfg.secretKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const parsed = (await res.json()) as LtcDatabase;
    if (parsed && Array.isArray(parsed.profiles) && Array.isArray(parsed.courses)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

let seededOnce = false;

/**
 * Idempotently seeds the 9 canonical LTC users into Supabase Auth and uploads
 * the initial database state to Supabase Storage if not yet present.
 */
export async function ensureSupabaseSeeded(db: LtcDatabase): Promise<{
  enabled: boolean;
  url: string;
  jwksVerified: boolean;
  authUsersCount: number;
  storageSynced: boolean;
}> {
  const cfg = getSupabaseServerConfig();
  if (!cfg.enabled) {
    return {
      enabled: false,
      url: cfg.url,
      jwksVerified: false,
      authUsersCount: 0,
      storageSynced: false,
    };
  }

  const keys = await fetchSupabaseJwks();
  const jwksVerified = keys.length > 0;

  try {
    // Check existing Supabase Auth users
    const listRes = await fetch(`${cfg.url}/auth/v1/admin/users?per_page=50`, {
      headers: {
        apikey: cfg.secretKey,
        Authorization: `Bearer ${cfg.secretKey}`,
      },
      cache: "no-store",
    });
    const listData = listRes.ok ? await listRes.json() : { users: [] };
    const existingUsers: any[] = Array.isArray(listData.users)
      ? listData.users
      : [];
    const existingEmails = new Set(
      existingUsers.map((u) => String(u.email || "").toLowerCase()),
    );

    if (!seededOnce) {
      seededOnce = true;
      // Ensure private storage bucket exists
      await fetch(`${cfg.url}/storage/v1/bucket`, {
        method: "POST",
        headers: {
          apikey: cfg.secretKey,
          Authorization: `Bearer ${cfg.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: BUCKET_ID,
          name: BUCKET_ID,
          public: false,
        }),
      }).catch(() => {});

      // Seed missing LTC profiles into Supabase Auth
      for (const profile of db.profiles) {
        if (!existingEmails.has(profile.email.toLowerCase())) {
          const roles = getActiveRolesForUser(db, profile.id);
          await upsertSupabaseAuthUser({
            email: profile.email,
            password: profile.passwordHash || "Password123!",
            displayName: profile.displayName,
            ltcProfileId: profile.id,
            roles,
          });
          existingEmails.add(profile.email.toLowerCase());
        }
      }
    }

    const existingRemoteDb = await pullDbStateFromSupabase();
    let storageSynced = Boolean(existingRemoteDb);
    if (!existingRemoteDb) {
      storageSynced = await pushDbStateToSupabase(db);
    }

    return {
      enabled: true,
      url: cfg.url,
      jwksVerified,
      authUsersCount: existingEmails.size,
      storageSynced,
    };
  } catch {
    return {
      enabled: true,
      url: cfg.url,
      jwksVerified,
      authUsersCount: 0,
      storageSynced: false,
    };
  }
}
