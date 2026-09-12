/**
 * SeverityIcon — ไอคอนความรุนแรงของแจ้งเตือน (NTF-001 · lane D)
 *
 * 4 ระดับตาม contract ของ GET /me/notifications — ใช้ token สีของ repo (brand/success/
 * warning/danger) · inline SVG แบบเดียวกับ src/components/course/icons.tsx (DS §5.14 ·
 * Lucide style · stroke 1.8 · currentColor · aria-hidden)
 */
import type { NotifSeverity } from "./api";

/** ชุดสไตล์ต่อ severity — วงกลมพื้นหลังอ่อน + ไอคอนสีเข้ม (ไม่ใช้ UI library ใหม่) */
const SEVERITY_STYLES: Record<
  NotifSeverity,
  { readonly wrapper: string; readonly label: string; readonly icon: "info" | "check" | "warn" | "error" }
> = {
  info: {
    wrapper: "bg-brand-50 text-brand-600",
    label: "ข้อมูล",
    icon: "info",
  },
  success: {
    wrapper: "bg-success-50 text-success-600",
    label: "สำเร็จ",
    icon: "check",
  },
  warning: {
    wrapper: "bg-warning-50 text-warning-600",
    label: "เตือน",
    icon: "warn",
  },
  error: {
    wrapper: "bg-danger-50 text-danger-600",
    label: "ด่วน",
    icon: "error",
  },
};

export function SeverityIcon({
  severity,
  wrapperClassName = "",
}: {
  severity: NotifSeverity;
  /** คลาสเสริมของ wrapper จากผู้เรียก (เช่น self-start ตอนใช้ในแถวรายการ) */
  wrapperClassName?: string;
}) {
  const style = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info;
  return (
    <span
      role="img"
      aria-label={`การแจ้งเตือนประเภท${style.label}`}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${style.wrapper} ${wrapperClassName}`}
    >
      {style.icon === "check" ? (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
          <path d="M21.8 10A10 10 0 1 1 17 3.34" />
          <path d="m9 11 3 3L22 4" />
        </svg>
      ) : style.icon === "warn" ? (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      ) : style.icon === "error" ? (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ) : (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable={false}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      )}
    </span>
  );
}
