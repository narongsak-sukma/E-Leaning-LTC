/**
 * Badge สถานะ — DS §5.6
 * ทุกคู่สี ผ่าน contrast ตามตาราง DS §2.5 (≥ 4.5:1)
 */

import type { ReactNode } from "react";

import type { CourseStatus } from "@/lib/fixtures/catalog";

export type BadgeTone = "success" | "warning" | "danger" | "brand" | "neutral" | "gold";

const TONE_CLASSES: Record<BadgeTone, { base: string; dot: string; hasDot: boolean }> = {
  success: { base: "bg-success-50 text-success-600", dot: "bg-success-600", hasDot: true },
  warning: { base: "bg-warning-50 text-warning-600", dot: "bg-warning-600", hasDot: true },
  danger: { base: "bg-danger-50 text-danger-600", dot: "bg-danger-600", hasDot: true },
  brand: { base: "bg-brand-50 text-brand-700", dot: "bg-brand-700", hasDot: true },
  neutral: { base: "bg-mist-100 text-ink-500", dot: "bg-ink-500", hasDot: false },
  gold: { base: "bg-gold-100 text-gold-700", dot: "bg-gold-700", hasDot: false },
};

export function Badge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: ReactNode;
}) {
  const toneClasses = TONE_CLASSES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold ${toneClasses.base}`}
    >
      {toneClasses.hasDot ? (
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
      ) : null}
      {children}
    </span>
  );
}

/** แผนที่สถานะหลักสูตร → ถ้อยคำ/โทน badge (DS §5.6) */
const COURSE_STATUS_BADGE: Record<CourseStatus, { label: string; tone: BadgeTone }> = {
  published: { label: "เปิดรับ", tone: "success" },
  pending_review: { label: "รอตรวจ", tone: "warning" },
  draft: { label: "ฉบับร่าง", tone: "neutral" },
  archived: { label: "ปิดรับ", tone: "neutral" },
};

export function CourseStatusBadge({ status }: { status: CourseStatus }) {
  const badge = COURSE_STATUS_BADGE[status];
  return (
    <Badge tone={badge.tone}>{badge.label}</Badge>
  );
}
