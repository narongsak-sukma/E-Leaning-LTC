/**
 * scripts/js-modules.d.ts — ให้ import ไฟล์ .mjs ของ scripts/ จากเทสได้ (TS7016)
 *
 * ตัว script เป็น JavaScript (ไม่มี types ในตัว) — เทสที่ import (เช่น
 * wave-h-battery-audit-guards) รับ any แล้ว cast เป็น structural type ที่ประกาศ
 * เองในไฟล์เทส ซึ่งเป็นที่อยู่จริงของสัญญานั้น (คู่กับ direct-run guard ของ script)
 */
declare module "*.mjs";
