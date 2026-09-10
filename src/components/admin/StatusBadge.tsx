import type { CourseStatus } from "@/lib/fixtures/admin";

/**
 * Badge สถานะ — DESIGN-SYSTEM §5.6 (พื้น/สีตัวอักษร/จุดไข่ปลา ตามโทน)
 * สีทุกคู่อ้างตาราง contrast §2.5 (≥ 4.5:1)
 */

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_BADGE_CLASS: Record<BadgeTone, string> = {
  success: "bg-success-50 text-success-600",
  warning: "bg-warning-50 text-warning-600",
  danger: "bg-danger-50 text-danger-600",
  info: "bg-brand-50 text-brand-700",
  neutral: "bg-mist-100 text-ink-500",
};

const TONE_DOT_CLASS: Record<BadgeTone, string> = {
  success: "bg-success-600",
  warning: "bg-warning-600",
  danger: "bg-danger-600",
  info: "bg-brand-700",
  neutral: "bg-ink-500",
};

export function StatusBadge({
  label,
  tone,
  withDot = true,
}: {
  label: string;
  tone: BadgeTone;
  withDot?: boolean | undefined;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold ${TONE_BADGE_CLASS[tone]}`}
    >
      {withDot ? (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${TONE_DOT_CLASS[tone]}`}
        />
      ) : null}
      {label}
    </span>
  );
}

/** แผนที่สถานะหลักสูตร → badge (ข้อความไทย + โทนสีตาม §5.6) */
const COURSE_STATUS_BADGE: Record<
  CourseStatus,
  { label: string; tone: BadgeTone; withDot: boolean }
> = {
  draft: { label: "ร่าง", tone: "info", withDot: true },
  pending_review: { label: "รอตรวจ", tone: "warning", withDot: true },
  published: { label: "เผยแพร่แล้ว", tone: "success", withDot: true },
  archived: { label: "เก็บเข้าคลัง", tone: "neutral", withDot: false },
};

export function CourseStatusBadge({ status }: { status: CourseStatus }) {
  const meta = COURSE_STATUS_BADGE[status];
  return <StatusBadge label={meta.label} tone={meta.tone} withDot={meta.withDot} />;
}
