/**
 * request fingerprint hash — server utility ร่วม (Wave G P2 · D76)
 *
 * ที่มา: private `userAgentHashOf` ใน src/app/api/v1/certificates/[code]/route.ts —
 * สกัดออกมา export เป็น utility ร่วมเพื่อให้ BFF ที่ audit PII_ACCESS เรียกใช้ร่วมกัน
 * (**คงพฤติกรรมเดิมเป๊ะ — ห้ามเปลี่ยน hash logic ตาม D76** · route เดิม import กลับ
 * แล้วพฤติกรรมทั้งหมดคงเดิม: ไม่มี header = null · ช่องว่างล้วน = null · trim ก่อน hash)
 *
 * ฝั่ง ip_hash ใช้ `ipHashOf` จาก @/lib/auth/password-reset (PB-13 — export อยู่แล้ว
 * ตาม D76 "ipHashOf import จากเดิม") — ไม่ย้าย/ไม่ทำซ้ำนิยาม
 */
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/config";

/** user_agent_hash = sha256(ua + salt) — r9-O1: header เป็นค่าอิสระของ anon
 *  (ใส่อีเมล/เบอร์โทรได้) จึงห้ามเก็บข้อความดิบลงตาราง append-only · ใช้ salt
 *  ชุดเดียวกับ ipHashOf (PB-13 ครอบทั้งสองค่า) */
export function userAgentHashOf(request: Request): string | null {
  const raw = request.headers.get("user-agent");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const { ipHashSalt, supabaseAnonKey } = getConfig();
  const salt = ipHashSalt ?? supabaseAnonKey;
  return createHash("sha256").update(trimmed + salt).digest("hex");
}
