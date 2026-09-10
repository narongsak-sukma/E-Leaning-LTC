/**
 * stub ของ package "server-only" สำหรับ vitest (PB-5)
 * package จริงจะ throw ถ้า module ถูกโหลดฝั่ง client — ใน unit test (node, ไม่มี bundler)
 * จึงแทนด้วยโมดูลเปล่า ให้ `import "server-only"` ผ่านได้โดยไม่ทำอะไร
 * (vi.mock("server-only") ที่มีอยู่ในไฟล์ test เดิมยังทำงานปกติ — ไม่ชนกับ alias นี้)
 */
export {};
