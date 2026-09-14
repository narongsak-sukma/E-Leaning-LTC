/**
 * fixture ของครอบครัว 8o (r30 §2-D89-4 CC·8o): PATCH /api/v1/admin/users/:id
 * (manifest `app:PATCH:/api/v1/admin/users/:uuid` · singleDispatch=false —
 * users.ts:595-615 retry ≤3 หลัง transient · RPC admin_set_user_active 0038)
 *
 * actor = super_admin (user:disable · RBAC §2) + โทเคน aal2 (RPC บังคับ aal2) ·
 * target = ผู้ใช้เป้าหมายที่จะถูกปิดใช้งาน (assert is_active + USER_DISABLE audit)
 */
import { setTimeout as sleep } from "node:timers/promises";

import { psqlScalar, createTestUser, restCall, type TestUser } from "../integration/helpers.js";
import { mintAal2Token } from "../integration/helpers-aal2.js";
import {
  httpWrite,
  invocationClose,
  invocationState,
  ledgerWrite,
  manualClearPoison,
  type HttpWriteResult,
} from "../integration/test-io.js";
import { awaitStuckWaiter, auditSafeRunTail } from "./barrier-harness.js";
import { APP_URL } from "./qb-patch-fixture.js";

export interface UserActiveFixture {
  readonly actor: TestUser;
  /** โทเคน aal2 ของ actor (mintAal2Token — RPC 0038 บังคับ aal2) */
  readonly token: string;
  readonly targetId: string;
}

/** สร้าง actor super_admin + target ครั้งเดียวต่อไฟล์ (unique ต่อรอบ) */
export async function ensureUserActiveFixture(prefix: string): Promise<UserActiveFixture> {
  const actor = await createTestUser(`${prefix}-admin`, "super_admin");
  const token = await mintAal2Token(actor);
  const target = await createTestUser(`${prefix}-target`);
  return { actor, token, targetId: target.id };
}

export function userPatchUrl(targetId: string): string {
  return `${APP_URL}/api/v1/admin/users/${targetId}`;
}

export async function userIsActive(targetId: string): Promise<boolean | null> {
  const raw = await psqlScalar(`select is_active::text from public.profiles where id = '${targetId}';`);
  if (raw === null || raw === "") return null;
  return raw.trim() === "true";
}

/** จำนวนแถว USER_DISABLE ของ target (audit append-only — เพิ่มขึ้นเมื่อ RPC commit) */
export async function userDisableAuditCount(targetId: string): Promise<number> {
  const raw = await psqlScalar(
    `select count(*) from public.audit_logs where entity_id = '${targetId}' and action = 'USER_DISABLE';`,
  );
  return Number(raw ?? "0");
}

/** หา waiter ใหม่ (≠ pid ที่แยกไว้) ที่ติดคิวหลัง coordinator บน relation —
 *  ใช้ตรวจ "waiter-2 โผล่ก่อน clean window" ใน 8o(ก) observation poll */
export async function findOtherBlockedWaiter(
  relation: string,
  blockerPids: readonly number[],
  excludePid: number,
): Promise<{ pid: number; mode: string } | null> {
  const raw = await psqlScalar(
    `select l.pid::text || '|' || l.mode from pg_locks l
     where l.locktype = 'relation'
       and l.relation = '${relation}'::regclass
       and l.granted = false
       and l.pid <> ${excludePid}
       and ${blockerPids[0] ?? 0} = any(pg_blocking_pids(l.pid))
     limit 1;`,
  );
  if (raw === null || raw === "") return null;
  const [pidRaw, mode] = raw.split("|");
  const pid = Number(pidRaw);
  if (!Number.isFinite(pid)) return null;
  return { pid, mode: mode ?? "?" };
}

export function freshRunTail(prefix: string): string {
  return auditSafeRunTail(prefix);
}

/** อุ่น pool ของ rest ก่อน dispatch จริง (หลักฐาน w8ong-adhoc2/3): terminateBackend
 *  ใน scenario ก่อนหน้าฆ่า pooled connection แบบไม่สะอาด → PostgREST v12
 *  db-pool-automatic-recovery รีไซเคิล pool ทั้งก้อน (~1-2 วิ · rest log
 *  "Successfully connected" + "Config reloaded" ×9/2 ชม.) → RPC ที่ชนะ window
 *  นั้นโดน 503 ก่อนถึงมือ users.ts → route ตายเร็ว ไม่มี waiter ให้ handshake —
 *  ping RPC เบาที่ auth path ใช้อยู่แล้ว (my_roles) จนได้ 2xx = pool มี
 *  connection ใช้ได้ ค่อยเริ่ม scenario · host เรียกผ่าน Kong ต้องใช้ path
 *  /rest/v1/rpc/... (strip_path — kong.yml:44) ไม่ใช่ /rpc ตรงๆ (404) */
export async function warmRestPool(accessToken: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await restCall("POST", "/rest/v1/rpc/my_roles", { token: accessToken }, {});
    if (res.status < 300) return;
    if (Date.now() > deadline) {
      throw new Error(`${label}: warmRestPool ไม่ได้ 2xx ภายใน 10s (last ${res.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** ผลของ parkedPatchOrRetry — patch ที่กำลัง park อยู่บน SRE ของ coordinator */
export interface ParkedPatch {
  /** AbortController ของ dispatch ปัจจุบัน — abort จุดเดียวของ scenario */
  readonly ac: AbortController;
  /** promise ดิบของ dispatch ที่ parked (ค้างจนกว่าจะปล่อย SRE) */
  readonly patchRaw: Promise<HttpWriteResult>;
  /** กระจกผลลัพธ์แบบข้อความ — "responded" | "thrown:…" */
  readonly outcome: Promise<string>;
  readonly waiter: { readonly pid: number; readonly mode: string };
  /** จำนวน dispatch จริงที่ใช้จนเกิด park (ทุกครั้งลง ledger) */
  readonly tries: number;
}

/**
 * dispatch PATCH ใต้ SRE จนเกิด park จริง (handshake เจอ waiter) — ป้องกัน
 * fast-fail สิ่งแวดล้อมที่ผ่าน route เท่านั้น (หลักฐาน 2026-09-14: kong/rest
 * เห็น 503 PGRST001 "Retrying the connection." ระหว่าง pool recycle หลัง
 * terminateBackend + 400 238B ~25ms/ครั้งที่เกิดเฉพาะ ≤3s หลัง pool เสื่อม —
 * direct RPC args/โทเคนเดียวกัน park ปกติทุกครั้ง): ถ้า patch ตอบเร็วก่อนมี
 * waiter = transient ที่ users.ts retry ไม่รอด → เปิด dispatch ใหม่ใต้ invocation
 * เดิม (singleDispatch=false · ทุก dispatch ลง ledger เป็นหลักฐาน) · patch ยัง
 * ค้าง (pending) โดยไม่มี waiter = ห้าม retry (ทิ้ง response ไม่ได้) → โยนเดิม
 */
export async function parkedPatchOrRetry(input: {
  readonly url: string;
  readonly reason: string;
  readonly invocationId: string;
  readonly labelBase: string;
  readonly handshakeLabel: string;
  readonly coordinatorPid: number;
  readonly extraHeaders: Record<string, string>;
  readonly maxTries?: number;
}): Promise<ParkedPatch> {
  const maxTries = input.maxTries ?? 3;
  for (let tryNo = 1; ; tryNo += 1) {
    if (tryNo > maxTries) {
      throw new Error(
        `${input.labelBase}: dispatch ครบ ${maxTries} ครั้งไม่เกิด park (environmental fast-fail ตลอด — ดู note h8o-dispatch-fastfail ใน ledger)`,
      );
    }
    const ac = new AbortController();
    const patchRaw = httpWrite(
      "PATCH",
      input.url,
      { is_active: false, reason: `${input.reason}${tryNo > 1 ? ` — dispatch ที่ ${tryNo}` : ""}` },
      {
        invocationId: input.invocationId,
        settleMode: "scenario",
        signal: ac.signal,
        transportTarget: "app-direct",
        label: `${input.labelBase}-d${tryNo}`,
        extraHeaders: input.extraHeaders,
      },
    );
    const outcome = patchRaw.then(
      () => "responded" as const,
      (err: unknown) => `thrown:${String(err).slice(0, 80)}` as const,
    );
    let waiter: { pid: number } | null = null;
    try {
      waiter = await awaitStuckWaiter(
        {
          relation: "public.audit_logs",
          mode: "RowExclusiveLock",
          blockerPids: [input.coordinatorPid],
          deadlineMs: 10_000,
        },
        `${input.handshakeLabel}-d${tryNo}`,
      );
    } catch (err) {
      // handshake หมดเวลา — แยกสองกรณีด้วยหลักฐานจริง (D-f-13):
      // patch ตอบไปแล้ว = environmental fast-fail → retry ได้ · ยังค้าง = โยนเดิม
      const settled = await Promise.race([outcome.then(() => true), sleep(50).then(() => false)]);
      if (!settled) {
        throw err;
      }
      await ledgerWrite("note", {
        event: "h8o-dispatch-fastfail",
        label: `${input.labelBase}-d${tryNo}`,
        tryNo,
      });
      continue;
    }
    return {
      ac,
      patchRaw,
      outcome,
      waiter: { pid: waiter.pid, mode: "RowExclusiveLock" },
      tries: tryNo,
    };
  }
}

/** เคลียร์โลกหลัง scenario ล้มกลางทาง (append-only — บันทึกความจริง ไม่ลบแถว):
 *  opKey ของ 8o ทั้งครอบครัวแชร์กัน (route-normalized `:uuid`) ดังนั้น invocation
 *  ที่ค้าง 'running' จะปฏิเสธทุก run ถัดไป — crash ต้องปิดก่อน rethrow ·
 *  running → poison (event h8o-crash-recovery) + manual clear · poisoned → manual
 *  clear เท่านั้น (เช่น designed-poison ของ child ที่ wrapper ยังไม่ทัน audit —
 *  caller ที่ต้องการคง poisoned ไว้ต้องเช็คธง designed เองก่อนเรียก) · อื่นๆ ไม่แตะ */
export async function crashRecover(opKey: string, err: unknown): Promise<void> {
  const st = await invocationState(opKey);
  if (st === null) return;
  const note = String(err).slice(0, 200);
  if (st.status === "running") {
    await invocationClose(st.invocationId, opKey, "poisoned", {
      reason: "crash-recovery",
      event: "h8o-crash-recovery",
      note,
    });
    await manualClearPoison(opKey, `crash-recovery: ${String(err).slice(0, 120)}`);
    return;
  }
  if (st.status === "poisoned") {
    await manualClearPoison(opKey, `crash-recovery (poisoned): ${String(err).slice(0, 120)}`);
  }
}
