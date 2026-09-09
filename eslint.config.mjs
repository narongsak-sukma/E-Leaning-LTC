import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

/**
 * Custom rule (SDS §5.1): ห้าม env ที่ขึ้นต้น NEXT_PUBLIC_ ซึ่งชื่อมี SERVICE_ROLE
 *
 * เหตุผล: service-role key ห้ามอยู่ฝั่ง browser — ตัวแปรที่ขึ้นต้น NEXT_PUBLIC_ ถูก inline
 * เข้า browser bundle ทุกครั้ง จึงถือว่าเป็นการรั่วไหลของ secret โดยตรงแม้ค่าจะยังไม่ถูกตั้ง
 * (บังคับคู่กับ secrets scan ใน CI ตาม SDS §5.1)
 */
const noPublicServiceRoleRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "ห้าม env ที่ขึ้นต้น NEXT_PUBLIC_ ซึ่งชื่อมี SERVICE_ROLE (SDS §5.1)",
      recommended: true,
    },
    schema: [],
    messages: {
      banned:
        'ห้ามใช้ env รูปแบบ NEXT_PUBLIC_*SERVICE_ROLE* (พบ "{{name}}") — service-role key ห้ามอยู่ฝั่ง browser (SDS §5.1)',
    },
  },
  create(context) {
    const BANNED = /^NEXT_PUBLIC_[A-Z0-9_]*SERVICE_ROLE/;
    const isTestFile = /\.test\.[cm]?[jt]sx?$/.test(context.filename ?? "");

    return {
      MemberExpression(node) {
        // จับ process.env.NAME และ process.env["NAME"]
        const target = node.object;
        const isProcessEnv =
          target &&
          target.type === "MemberExpression" &&
          target.object.type === "Identifier" &&
          target.object.name === "process" &&
          (target.property.type === "Identifier"
            ? target.property.name === "env"
            : target.property.value === "env");
        if (!isProcessEnv) {
          return;
        }
        const name =
          node.property.type === "Identifier"
            ? node.property.name
            : node.property.value;
        if (typeof name === "string" && BANNED.test(name)) {
          context.report({ node, messageId: "banned", data: { name } });
        }
      },
      Literal(node) {
        // จับการประกาศชื่อตัวแปรเป็น string literal (เช่น const KEY = "NEXT_PUBLIC_...SERVICE_ROLE")
        // ข้ามไฟล์ทดสอบ (*.test.ts) เพื่อให้เขียน test ของ guard ได้
        if (isTestFile) {
          return;
        }
        const value = node.value;
        if (typeof value === "string" && BANNED.test(value)) {
          context.report({ node, messageId: "banned", data: { name: value } });
        }
      },
    };
  },
};

const ltcPlugin = {
  rules: { "no-public-service-role": noPublicServiceRoleRule },
};

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    plugins: { ltc: ltcPlugin },
    rules: {
      "ltc/no-public-service-role": "error",
    },
  },
];

export default eslintConfig;
