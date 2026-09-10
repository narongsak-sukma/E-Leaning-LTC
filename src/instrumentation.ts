/**
 * instrumentation — Next.js bootstrap hook (PB-9)
 *
 * register() ถูกเรียกครั้งเดียวตอน server instance ใหม่เริ่มทำงาน — เป็นจุด
 * "ตรวจ env ครบตอน boot" ตาม SDS §7.1: config ที่ผิดนโยบายของ environment จริง
 * (เช่น APP_ENV=prod ขาด CURSOR_HMAC_SECRET — PB-9) พังตั้งแต่ตอน bootstrap
 * แทนที่จะรอไปพังที่ request แรก
 *
 * ข้อสังเกตด้านการรับประกัน: ถ้า Next.js รุ่นที่ใช้งานกลืน error ของ register()
 * process อาจยังขึ้นมา — การพังจึงต้องมีชั้นสำรองที่ตรวจได้: /api/health เรียก
 * getConfig() เหมือนกันและตอบ 503 เมื่อ config invalid (route นั้น + test ประกอบ)
 * และ getConfig() ยัง throw ที่ call site ทุกที่อยู่ดี (fail-closed เสมอ)
 *
 * รันเฉพาะ nodejs runtime — edge (middleware) ตรวจเมื่อตัวเองเรียก getConfig()
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getConfig } = await import("./lib/config");
    getConfig();
  }
}
