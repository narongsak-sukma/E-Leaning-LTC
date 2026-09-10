/**
 * Skeleton — DS §5.13
 * บล็อก mist-200 มุม md + shimmer (gradient เคลื่อนที่ 1.5s loop — ช้ากว่า 300ms ตามเกณฑ์)
 * ทุกชิ้น aria-hidden + คอนเทนเนอร์ aria-busy="true"
 */

const SHIMMER_KEYFRAMES = {
  __html: `
  @keyframes ltc-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
`,
};

/** สี/gradient ใช้ design token จาก @theme เท่านั้น (globals.css) */
const SHIMMER_CLASSES = [
  "rounded-md bg-mist-200",
  "[background-image:linear-gradient(90deg,var(--color-mist-200)_0%,var(--color-mist-100)_50%,var(--color-mist-200)_100%)]",
  "[background-size:200%_100%]",
  "[animation:ltc-shimmer_1.5s_ease-in-out_infinite]",
  "motion-reduce:[animation:none]",
].join(" ");

/** บล็อก skeleton พื้นฐาน — ประกอบเป็นรูปทรงอื่นได้ */
export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`${SHIMMER_CLASSES} ${className ?? ""}`} />
  );
}

/** ต้นแบบ DS §5.13: การ์ดหลักสูตร = ปก + 2 บรรทัดชื่อ + แถว metadata */
export function CourseCardSkeleton() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-[14px] border border-mist-200 bg-white shadow-card">
      <SkeletonBlock className="aspect-video w-full rounded-none" />
      <div className="flex flex-col gap-2.5 p-5">
        <SkeletonBlock className="h-5 w-4/5" />
        <SkeletonBlock className="h-5 w-3/5" />
        <SkeletonBlock className="mt-2 h-4 w-2/5" />
      </div>
    </div>
  );
}

/** กริด skeleton ของหน้าแคตตาล็อก — ครอบด้วย role="status" + aria-busy */
export function CourseCardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      aria-hidden="true"
      className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }, (_, i) => (
        <CourseCardSkeleton key={i} />
      ))}
      <style dangerouslySetInnerHTML={SHIMMER_KEYFRAMES} />
    </div>
  );
}
