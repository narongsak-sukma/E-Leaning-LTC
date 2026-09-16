import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * vitest — unit test ของ shared kernel (src/lib/**) + component logic
 * include เฉพาะ *.test.ts ใน src — e2e (Playwright) จะเพิ่มภายหลังตาม TEST-PLAN
 *
 * alias `@` ให้ตรง tsconfig paths ("@/*": ["./src/*"]) — component test
 * ที่ import "@/components/..." จะได้ resolve เหมือน Next จริง (D26)
 *
 * PB-2: esbuild.jsx = "automatic" — .tsx ที่ถูก transform ใน vitest ใช้ jsx-runtime อัตโนมัติ
 * (เดิม tsconfig jsx:"preserve" ทำให้ .tsx ต้องมี global React — ดู (admin)/layout.test.ts)
 * PB-5: alias "server-only" → tests/stubs/server-only.ts — test ที่ import module ฝั่ง server
 * ผ่านได้โดยไม่ต้อง vi.mock("server-only") ในทุกไฟล์ (mock เดิมคงอยู่ได้ ไม่ชนกัน)
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // D91 [#94]: unit รวมไฟล์เทส interactive ของ component (.test.tsx) ด้วย — แต่ละ
    // ไฟล์ .tsx ประกาศ environment เองผ่าน docblock `// @vitest-environment jsdom`
    // (limitation 10: jsdom เฉพาะไฟล์ใหม่ src/** ไฟล์อื่นคง node) · include แยก unit/IT
    // ไม่ชน — integration/barrier config ครอบเฉพาะ tests/** ไม่แตะ src/** ตัวนี้
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
