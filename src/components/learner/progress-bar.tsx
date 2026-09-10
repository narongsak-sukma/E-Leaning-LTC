/**
 * ProgressBar — DESIGN-SYSTEM §5.4 (Progress Bar)
 *
 * - track `mist-200` สูง 8px มุม full · fill `brand-600` (พื้นมืดใช้ fill `gold-300` ตาม prototype 04)
 * - ป้ายเปอร์เซ็นต์ `tabular-nums` · `role="progressbar"` + aria-valuenow + aria-label ภาษาไทย
 */
export function ProgressBar({
  percent,
  label,
  onDark = false,
}: {
  percent: number;
  label: string;
  onDark?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={onDark ? "text-brand-100" : "text-ink-500"}>{label}</span>
        <span
          className={`font-semibold tabular-nums ${onDark ? "text-white" : "text-ink-700"}`}
        >
          {clamped}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={`${label} ${clamped} เปอร์เซ็นต์`}
        className={`mt-1.5 h-2 w-full overflow-hidden rounded-full ${
          onDark ? "bg-white/15" : "bg-mist-200"
        }`}
      >
        <div
          className={`h-full rounded-full ${onDark ? "bg-gold-300" : "bg-brand-600"}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
