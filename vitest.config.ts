import { defineConfig } from "vitest/config";

/**
 * vitest — unit test ของ shared kernel (src/lib/**)
 * include เฉพาะ *.test.ts ใน src — e2e (Playwright) จะเพิ่มภายหลังตาม TEST-PLAN
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
