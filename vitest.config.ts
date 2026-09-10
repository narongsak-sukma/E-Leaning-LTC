import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * vitest — unit test ของ shared kernel (src/lib/**) + component logic
 * include เฉพาะ *.test.ts ใน src — e2e (Playwright) จะเพิ่มภายหลังตาม TEST-PLAN
 *
 * alias `@` ให้ตรง tsconfig paths ("@/*": ["./src/*"]) — component test
 * ที่ import "@/components/..." จะได้ resolve เหมือน Next จริง (D26)
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
