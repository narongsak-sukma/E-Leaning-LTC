/**
 * tests — signup-consents (Wave F · D-f-3 · migration 0043)
 *
 * Pure helper: checkbox -> consents_granted payload for signUp options.data.
 * Trigger (0043) writes public.consents rows when email gets confirmed.
 */
import { describe, expect, it } from "vitest";
import {
  buildSignupConsents,
  SIGNUP_CONSENT_POLICY_VERSION,
} from "./signup-consents";

/** FormData helper — set only the ticked fields with value "on". */
function formDataWith(ticked: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [name, value] of Object.entries(ticked)) {
    fd.set(name, value);
  }
  return fd;
}

describe("buildSignupConsents", () => {
  it("none ticked -> [] (default form state, no consent)", () => {
    expect(buildSignupConsents(formDataWith(), SIGNUP_CONSENT_POLICY_VERSION)).toEqual([]);
  });

  it("marketing only -> [marketing]", () => {
    expect(
      buildSignupConsents(formDataWith({ marketingConsent: "on" }), SIGNUP_CONSENT_POLICY_VERSION),
    ).toEqual([{ key: "marketing", version: SIGNUP_CONSENT_POLICY_VERSION }]);
  });

  it("email_notify only -> [email_notify]", () => {
    expect(
      buildSignupConsents(formDataWith({ emailNotifyConsent: "on" }), SIGNUP_CONSENT_POLICY_VERSION),
    ).toEqual([{ key: "email_notify", version: SIGNUP_CONSENT_POLICY_VERSION }]);
  });

  it("both -> fixed order [marketing, email_notify]", () => {
    expect(
      buildSignupConsents(
        formDataWith({ marketingConsent: "on", emailNotifyConsent: "on" }),
        SIGNUP_CONSENT_POLICY_VERSION,
      ),
    ).toEqual([
      { key: "marketing", version: SIGNUP_CONSENT_POLICY_VERSION },
      { key: "email_notify", version: SIGNUP_CONSENT_POLICY_VERSION },
    ]);
  });

  it("junk values (yes/true) are not accepted - only exact \"on\"", () => {
    const fd = formDataWith({ marketingConsent: "yes", emailNotifyConsent: "true" });
    expect(buildSignupConsents(fd, SIGNUP_CONSENT_POLICY_VERSION)).toEqual([]);
  });

  it("mixed junk and \"on\" for the same field -> only \"on\" counts", () => {
    const fd = new FormData();
    fd.set("marketingConsent", "on");
    fd.append("emailNotifyConsent", "yes");
    fd.append("emailNotifyConsent", "on");
    expect(buildSignupConsents(fd, SIGNUP_CONSENT_POLICY_VERSION)).toEqual([
      { key: "marketing", version: SIGNUP_CONSENT_POLICY_VERSION },
      { key: "email_notify", version: SIGNUP_CONSENT_POLICY_VERSION },
    ]);
  });

  it("version passthrough", () => {
    const version = "2026.09";
    expect(buildSignupConsents(formDataWith({ marketingConsent: "on" }), version)).toEqual([
      { key: "marketing", version },
    ]);
  });
});

describe("SIGNUP_CONSENT_POLICY_VERSION format (DB regex 0043)", () => {
  it("matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$", () => {
    expect(SIGNUP_CONSENT_POLICY_VERSION).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/);
  });
});
