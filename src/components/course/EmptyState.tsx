/**
 * Empty State — DS §5.12
 * กล่องกึ่งกลาง: ไอคอนใหญ่ 48px (mist-300 · ตกแต่ง) + หัวข้อ + คำอธิบาย 1 ประโยค + ปุ่ม action นำทาง
 * (ห้ามปล่อยพื้นที่ว่างเปล่าโดยไม่บอกทางออก)
 */

import { GraduationCapIcon } from "@/components/course/icons";

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  /** ใช้เมื่อ action นำทางไปหน้าอื่น */
  actionHref?: string;
  /** ใช้เมื่อ action เป็นพฤติกรรมในหน้า (เช่น ล้างตัวกรอง) */
  onAction?: () => void;
}) {
  const className =
    "mt-6 inline-flex items-center gap-2 rounded-[10px] border-[1.5px] border-brand-600 bg-white px-[18px] py-2.5 font-heading font-semibold text-brand-700 hover:bg-brand-50";
  return (
    <div className="rounded-[14px] border border-mist-200 bg-white px-6 py-14 text-center shadow-card">
      <div className="mx-auto flex w-fit items-center justify-center rounded-full bg-mist-100 p-5 text-mist-300">
        <GraduationCapIcon size={48} />
      </div>
      <p className="mt-6 font-heading text-lg font-semibold text-ink-900">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-500">{description}</p>
      {actionHref !== undefined ? (
        <a className={className} href={actionHref}>
          {actionLabel}
        </a>
      ) : (
        <button className={className} type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
