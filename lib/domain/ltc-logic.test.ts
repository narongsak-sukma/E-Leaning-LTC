import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeAction,
  buildPublicVerificationResponse,
  canReviewExamAnswers,
  computeCreditMeterState,
  computeNetCredits,
  gradeExamAttempt,
  hasBackofficeAccess,
  requiresMfa,
} from "./ltc-logic.ts";

describe("LTC E-Learning Pure Domain Logic", () => {
  it("enforces RBAC permission matrix and mandatory MFA aal2 for staff/instructor roles", () => {
    // Unauthenticated user -> ERR-AUTH-001 (401)
    const unauth = authorizeAction({
      userId: null,
      roles: [],
      aal: "aal1",
      permission: "course:view",
    });
    assert.equal(unauth.allowed, false);
    if (!unauth.allowed) {
      assert.equal(unauth.errorCode, "ERR-AUTH-001");
      assert.equal(unauth.httpStatus, 401);
    }

    // Citizen does NOT require MFA and can enroll
    assert.equal(requiresMfa(["citizen"]), false);
    assert.equal(hasBackofficeAccess(["citizen", "lawyer"]), false);
    const citizenEnroll = authorizeAction({
      userId: "u-citizen",
      roles: ["citizen"],
      aal: "aal1",
      permission: "enroll:create",
    });
    assert.equal(citizenEnroll.allowed, true);

    // Staff registrar requires MFA (aal2) -> aal1 fails closed with ERR-AUTH-004 (403)
    assert.equal(requiresMfa(["staff:registrar"]), true);
    assert.equal(hasBackofficeAccess(["staff:registrar"]), true);
    const staffNoMfa = authorizeAction({
      userId: "u-reg",
      roles: ["staff:registrar"],
      aal: "aal1",
      permission: "license:verify",
    });
    assert.equal(staffNoMfa.allowed, false);
    if (!staffNoMfa.allowed) {
      assert.equal(staffNoMfa.errorCode, "ERR-AUTH-004");
      assert.equal(staffNoMfa.httpStatus, 403);
    }

    // Staff registrar with aal2 can verify licenses but cannot delete courses
    const staffWithMfa = authorizeAction({
      userId: "u-reg",
      roles: ["staff:registrar"],
      aal: "aal2",
      permission: "license:verify",
    });
    assert.equal(staffWithMfa.allowed, true);

    const staffForbidden = authorizeAction({
      userId: "u-reg",
      roles: ["staff:registrar"],
      aal: "aal2",
      permission: "course:delete",
    });
    assert.equal(staffForbidden.allowed, false);
    if (!staffForbidden.allowed) {
      assert.equal(staffForbidden.errorCode, "ERR-RBAC-001");
    }
  });

  it("grades exam attempts accurately with module breakdown and enforces D84 review invariant", () => {
    const questions = [
      { id: "q1", moduleTitle: "โมดูล 1 · พื้นฐานกฎหมายไทย", points: 1, correctOptionId: "opt-1a" },
      { id: "q2", moduleTitle: "โมดูล 1 · พื้นฐานกฎหมายไทย", points: 1, correctOptionId: "opt-2b" },
      { id: "q3", moduleTitle: "โมดูล 2 · สัญญาในชีวิตประจำวัน", points: 2, correctOptionId: "opt-3c" },
    ];
    const grade = gradeExamAttempt(
      questions,
      { q1: "opt-1a", q2: "opt-wrong", q3: "opt-3c" },
      70,
    );
    assert.equal(grade.earnedPoints, 3);
    assert.equal(grade.totalPoints, 4);
    assert.equal(grade.scorePercent, 75);
    assert.equal(grade.passed, true);
    assert.equal(grade.moduleBreakdown.length, 2);
    assert.equal(grade.moduleBreakdown[0]?.percent, 50);
    assert.equal(grade.moduleBreakdown[1]?.percent, 100);

    // D84 invariant: cannot review while an attempt is in progress or when reviewMode='never'
    assert.equal(
      canReviewExamAnswers({
        hasInProgressAttempt: true,
        reviewMode: "after_final_attempt",
        attemptsUsed: 1,
        maxAttempts: 3,
        hasPassedAttempt: true,
      }),
      false,
    );
    assert.equal(
      canReviewExamAnswers({
        hasInProgressAttempt: false,
        reviewMode: "never",
        attemptsUsed: 3,
        maxAttempts: 3,
        hasPassedAttempt: true,
      }),
      false,
    );
    assert.equal(
      canReviewExamAnswers({
        hasInProgressAttempt: false,
        reviewMode: "after_final_attempt",
        attemptsUsed: 1,
        maxAttempts: 3,
        hasPassedAttempt: true,
      }),
      true,
    );
  });

  it("computes Credit Bank net ledger credits and meter status per DESIGN-SYSTEM §5.4", () => {
    const net = computeNetCredits([
      { id: "1", entryType: "accrual", creditsDelta: 6 },
      { id: "2", entryType: "accrual", creditsDelta: 3.5 },
      { id: "3", entryType: "reversal", creditsDelta: -3.5 },
      { id: "4", entryType: "adjustment", creditsDelta: 2 },
    ]);
    assert.equal(net, 8);

    // 8 / 12 credits = 66% -> success tone, no premature "ครบ" badge
    const state66 = computeCreditMeterState(8, 12, 120);
    assert.equal(state66.percent, 66);
    assert.equal(state66.remainingCredits, 4);
    assert.equal(state66.tone, "success");
    assert.equal(state66.badgeText, null);

    // 11 / 12 credits = 91% -> "ใกล้ครบเป้า"
    const state91 = computeCreditMeterState(11, 12, 120);
    assert.equal(state91.badgeText, "ใกล้ครบเป้า");

    // 12 / 12 credits = 100% -> "ครบเป้าหมายรอบ"
    const state100 = computeCreditMeterState(12, 12, 10);
    assert.equal(state100.percent, 100);
    assert.equal(state100.badgeText, "ครบเป้าหมายรอบ");
  });

  it("redacts PII from public certificate verification response per PDPA", () => {
    const pub = buildPublicVerificationResponse({
      id: "cert-1",
      verificationCode: "LTC-2026-483920",
      userId: "user-secret-uuid",
      recipientName: "ธนกร วัฒนกุล",
      recipientEmail: "thanakorn@example.com",
      recipientPhone: "0812345678",
      recipientLicenseNo: "25891",
      courseId: "course-1",
      courseTitleTh: "กฎหมายที่ประชาชนควรรู้",
      creditsAwarded: 3,
      issuedAt: "2026-09-08T08:20:00.000Z",
      status: "valid",
      revokedReason: null,
    });

    assert.equal(pub.verificationCode, "LTC-2026-483920");
    assert.equal(pub.recipientName, "ธนกร วัฒนกุล");
    assert.equal("recipientEmail" in pub, false);
    assert.equal("recipientPhone" in pub, false);
    assert.equal("recipientLicenseNo" in pub, false);
    assert.equal("userId" in pub, false);
  });
});
