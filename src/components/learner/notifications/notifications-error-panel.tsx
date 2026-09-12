/**
 * NotificationsErrorPanel — แผง error ไทยของหน้าแจ้งเตือน (lane D · fail-closed)
 *
 * BFF ยังไม่ deploy / network ล้ม / ข้อมูลผิดรูป — แสดงข้อความอธิบาย + ปุ่ม "ลองอีกครั้ง"
 * (ไม่ crash ไม่แสดง stack หรือข้อความภาษาอังกฤษดิบ ๆ) — แบบเดียวกับ ErrorPanel ของ /my/credits
 */
export function NotificationsErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-5 rounded-[14px] border border-danger-200 bg-danger-50 p-6 text-center"
    >
      <p className="font-heading text-base font-semibold text-danger-700">
        โหลดการแจ้งเตือนไม่สำเร็จ
      </p>
      <p className="mt-1 text-sm text-danger-600">
        ขออภัย ติดต่อระบบไม่ได้ในขณะนี้ กรุณาลองอีกครั้ง หากยังมีปัญหากรุณาติดต่อเจ้าหน้าที่
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-[10px] border border-brand-600 bg-white px-[18px] py-2 font-heading text-sm font-semibold text-brand-700 hover:bg-brand-50"
      >
        ลองอีกครั้ง
      </button>
    </div>
  );
}
