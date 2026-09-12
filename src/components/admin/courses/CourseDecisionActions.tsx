"use client";

/**
 * CourseDecisionActions — ปุ่ม/โมดัลตัดสินหลักสูตรต่อแถว (Wave E Phase 5 · lane F · ให้ lead ติดตั้ง)
 *
 * - เผยแพร่ (publish) / ยกเลิกการเผยแพร่ (unpublish) / ส่งกลับแก้ไข (return — บังคับ comment ≥10)
 *   → PATCH /api/v1/admin/courses/{id} body { action: "publish"|"unpublish"|"return", comment? }
 *   (RPC admin_decide_course — สิทธิ์ตัดสินจริงที่ BFF เสมอ)
 * - ปุ่มแสดงตามสถานะ: publish/return เฉพาะ draft|pending_review · unpublish เฉพาะ published
 * - pure helpers export เพื่อ unit test ใน node (แบบ UserActions)
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConfirmModal } from "@/components/admin/ConfirmModal";
import { AdminApiError } from "@/lib/exam-admin.client";
import { patchAdminJson } from "@/components/admin/users/api-client";

/** ความยาวขั้นต่ำของเหตุผล "ส่งกลับแก้ไข" (RPC admin_decide_course — return บังคับ comment ≥10) */
export const COURSE_RETURN_COMMENT_MIN_LENGTH = 10;

/** pure — comment ผ่านเงื่อนไข — trim แล้วยาว ≥10 */
export function courseReturnCommentValid(comment: string): boolean {
  return comment.trim().length >= COURSE_RETURN_COMMENT_MIN_LENGTH;
}

/** pure — บอดี้ของ PATCH ตัดสินหลักสูตร — return แนบ comment บังคับ · publish/unpublish ไม่แนบ */
export function buildCourseDecisionBody(
  action: "publish" | "unpublish" | "return",
  comment: string,
): { action: "publish" } | { action: "unpublish" } | { action: "return"; comment: string } {
  if (action === "return") {
    return { action: "return", comment: comment.trim() };
  }
  return { action };
}

/** pure — path ของ PATCH ตัดสินหลักสูตร */
export function courseActionPath(courseId: string): string {
  return `/api/v1/admin/courses/${encodeURIComponent(courseId)}`;
}

/** pure — ปุ่มที่แสดงตามสถานะหลักสูตร (publish/return สำหรับ draft/pending_review · unpublish สำหรับ published) */
export function courseActionsForStatus(status: string): readonly ("publish" | "unpublish" | "return")[] {
  if (status === "draft" || status === "pending_review") {
    return ["publish", "return"];
  }
  if (status === "published") {
    return ["unpublish"];
  }
  return [];
}

/** ป้ายไทยต่อ action (ปุ่ม + ยืนยันในโมดัล) */
export const COURSE_ACTION_LABEL: Record<"publish" | "unpublish" | "return", string> = {
  publish: "เผยแพร่",
  unpublish: "ยกเลิกการเผยแพร่",
  return: "ส่งกลับแก้ไข",
};

/** แผงข้อผิดพลาดในโมดัล — ข้อความไทยจาก envelope ของ BFF */
function ErrorPanel({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-3 rounded-[10px] bg-danger-50 px-3 py-2 text-sm text-danger-600">
      {message}
    </p>
  );
}

export type CourseDecisionActionsProps = {
  courseId: string;
  courseTitle: string;
  status: string;
  /** คำนวณฝั่ง server จาก session จริง (staff:content, super_admin — สิทธิ์จริงตัดสินที่ BFF) */
  canDecide: boolean;
};

/** ปุ่ม + โมดัลตัดสินหลักสูตรต่อแถว */
export function CourseDecisionActions({
  courseId,
  courseTitle,
  status,
  canDecide,
}: CourseDecisionActionsProps) {
  const router = useRouter();
  const [modal, setModal] = useState<"publish" | "unpublish" | "return" | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const actions = courseActionsForStatus(status);

  function resetAndCloseFull() {
    setModal(null);
    setComment("");
    setError(null);
    setSubmitting(false);
  }

  async function submitDecision(action: "publish" | "unpublish" | "return") {
    setSubmitting(true);
    setError(null);
    try {
      await patchAdminJson(courseActionPath(courseId), buildCourseDecisionBody(action, comment));
      resetAndCloseFull();
      router.refresh();
    } catch (caught: unknown) {
      setSubmitting(false);
      setError(caught instanceof AdminApiError ? caught.message : "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
    }
  }

  if (canDecide === false || actions.length === 0) {
    return null;
  }

  const modalOpen = modal !== null;
  const currentAction = modal ?? "publish";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          onClick={() => setModal(action)}
          className={
            action === "publish"
              ? "rounded-[10px] border border-brand-600 bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50"
              : "rounded-[10px] border border-mist-300 bg-white px-3 py-1.5 text-sm font-semibold text-ink-600 hover:bg-mist-100"
          }
        >
          {COURSE_ACTION_LABEL[action]}
          <span className="sr-only">หลักสูตร {courseTitle}</span>
        </button>
      ))}

      <ConfirmModal
        open={modalOpen}
        onClose={() => (submitting ? undefined : resetAndCloseFull())}
        title={`${COURSE_ACTION_LABEL[currentAction]} · ${courseTitle}`}
        description={
          currentAction === "publish"
            ? "หลักสูตรจะปรากฏในแคตตาล็อกและลงทะเบียนได้ทันที"
            : currentAction === "unpublish"
              ? "หลักสูตรจะถูกซ่อนจากแคตตาล็อกทันที — ผู้เรียนที่ลงทะเบียนไว้ยังเข้าเรียนต่อได้"
              : "หลักสูตรจะกลับไปเป็นร่าง — ระบุความเห็นเพื่อให้ผู้ทำหลักสูตรแก้ไข"
        }
        confirmLabel={COURSE_ACTION_LABEL[currentAction]}
        confirmDisabled={
          (currentAction === "return" && courseReturnCommentValid(comment) === false) || submitting
        }
        confirmDisabledReason={
          submitting
            ? "กำลังส่งข้อมูล โปรดรอสักครู่"
            : currentAction === "return" && courseReturnCommentValid(comment) === false
              ? "ระบุความเห็นให้ยาวอย่างน้อย 10 ตัวอักษรก่อนยืนยัน"
              : undefined
        }
        onConfirm={() => void submitDecision(currentAction)}
      >
        {modal === "return" ? (
          <div>
            <label htmlFor="course-return-comment" className="block text-sm font-medium text-ink-700">
              ความเห็นส่งกลับ (บังคับ)
            </label>
            <textarea
              id="course-return-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              rows={3}
              maxLength={500}
              className="mt-1 w-full rounded-[10px] border border-mist-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-ink-500">
              ความเห็นจะถูกบันทึกในบันทึกการตรวจสอบ (audit) — ยาวอย่างน้อย 10 ตัวอักษร
            </p>
          </div>
        ) : null}
        {error !== null ? <ErrorPanel message={error} /> : null}
      </ConfirmModal>
    </div>
  );
}
