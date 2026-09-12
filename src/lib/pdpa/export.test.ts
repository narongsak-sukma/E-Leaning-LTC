/**
 * export.test — lib/pdpa/export (IDENT-008/SEC-011 · D-p5-7 · #90)
 *
 * fake Supabase client (thenable builder — await chain คืนผลที่ตั้งค่าไว้) — จุดหลัก:
 * - composePersonalDataExport: ครบ 9 chunks + chunk_count 9 · lesson_progress อ่าน
 *   ผ่าน in(enrollment_id) · notifications embed notification · ก้อนใดล้ม = throw
 * - processDataExportJob: upload path `pdpa-exports/{uid}/{job}.json` → media_assets
 *   (status ready · uploaded_by = เจ้าของ) → complete RPC (p_chunks 9) · ทุกทางล้ม =
 *   fail RPC ด้วย static reason ไม่มี PII + ไม่ throw
 * - runPersonalDataExportLoop: claim จนว่าง/ครบ cap · drift = break fail-closed
 */
vi.hoisted(() => {
  process.env.PUBLIC_BASE_URL = "https://elearning.lawyerthai.test";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-role-key";
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import {
  composePersonalDataExport,
  exportStoragePath,
  PDPA_EXPORT_BUCKET,
  PDPA_EXPORT_MAX_JOBS_PER_TICK,
  processDataExportJob,
  runPersonalDataExportLoop,
} from "@/lib/pdpa/export";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: vi.fn() }));

const JOB_ID = "d0000000-0000-4000-8000-000000000002";
const JOB_ID_2 = "d0000000-0000-4000-8000-000000000003";
const USER_ID = "b0000000-0000-4000-8000-000000000001";
const MEDIA_ID = "e0000000-0000-4000-8000-000000000004";

type Result = { data: unknown; error: { message: string } | null };

interface ClientSpec {
  tables?: Record<string, Result>;
  uploadError?: { message: string } | null;
  mediaError?: { message: string } | null;
  claimQueue?: Result[];
  claimForever?: boolean;
  completeError?: { message: string } | null;
  failError?: { message: string } | null;
}

interface Capture {
  uploads: { path: string; body: Uint8Array; contentType: string | undefined }[];
  mediaInserts: Record<string, unknown>[];
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  inCalls: { col: string; values: unknown[] }[];
  selectCalls: { table: string; cols: string }[];
}

/** fake service client — from() ต่อตาราง + storage upload + rpc ตาม spec */
function mockServiceClient(spec: ClientSpec = {}): { client: SupabaseClient; capture: Capture } {
  const tables = spec.tables ?? {};
  const capture: Capture = { uploads: [], mediaInserts: [], rpcCalls: [], inCalls: [], selectCalls: [] };
  const mediaResult = (): Result =>
    spec.mediaError === undefined || spec.mediaError === null
      ? ok({ id: MEDIA_ID })
      : { data: null, error: spec.mediaError };

  const raw = {
    from: (table: string) => {
      const result: Result = tables[table] ?? { data: [], error: null };
      const isMedia = table === "media_assets";
      const b = {
        select: (cols?: string) => {
          capture.selectCalls.push({ table, cols: cols ?? "*" });
          return b;
        },
        eq: () => b,
        in: (col: string, values: readonly unknown[]) => {
          capture.inCalls.push({ col, values: [...values] });
          return b;
        },
        maybeSingle: async () => result,
        single: async () => result,
        insert: (values: Record<string, unknown>) => {
          if (isMedia) {
            capture.mediaInserts.push(values);
          }
          return { select: () => ({ single: async () => (isMedia ? mediaResult() : result) }) };
        },
        then: (
          onFulfilled?: (value: Result) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return b;
    },
    storage: {
      from: () => ({
        upload: async (path: string, body: Uint8Array, opts?: { contentType?: string }) => {
          capture.uploads.push({ path, body, contentType: opts?.contentType });
          return { data: { path }, error: spec.uploadError ?? null };
        },
      }),
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      capture.rpcCalls.push({ fn, args: args ?? {} });
      if (fn === "claim_data_export_job") {
        if (spec.claimQueue !== undefined && spec.claimQueue.length > 0) {
          return spec.claimQueue.shift();
        }
        if (spec.claimForever === true) {
          return { data: { jobId: JOB_ID, userId: USER_ID }, error: null };
        }
        return { data: { jobId: null }, error: null };
      }
      if (fn === "complete_data_export_job") {
        return { data: { jobId: JOB_ID, status: "done" }, error: spec.completeError ?? null };
      }
      if (fn === "fail_data_export_job") {
        return { data: null, error: spec.failError ?? null };
      }
      return { data: null, error: null };
    },
  };
  const client = raw as unknown as SupabaseClient;
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client);
  return { client, capture };
}

function ok(data: unknown): Result {
  return { data, error: null };
}

function fail(message: string): Result {
  return { data: null, error: { message } };
}

beforeEach(() => {
  vi.mocked(createSupabaseServiceRoleClient).mockReset();
});

describe("exportStoragePath + ค่าคงที่", () => {
  it("path ตามสัญญา pdpa-exports/{user_id}/{job_id}.json + cap 10", () => {
    expect(PDPA_EXPORT_BUCKET).toBe("pdpa-exports");
    expect(PDPA_EXPORT_MAX_JOBS_PER_TICK).toBe(10);
    expect(exportStoragePath(USER_ID, JOB_ID)).toBe(`pdpa-exports/${USER_ID}/${JOB_ID}.json`);
  });
});

describe("composePersonalDataExport", () => {
  it("ครบ 9 chunks — chunk_count 9 + schema tag + generated_at/job_id/user_id", async () => {
    const { client } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID, email: "u@example.test" }) },
    });

    const doc = await composePersonalDataExport(client, USER_ID, JOB_ID);

    expect(doc["schema"]).toBe("ltc.pdpa-export.v1");
    expect(doc["chunk_count"]).toBe(9);
    expect(doc["job_id"]).toBe(JOB_ID);
    expect(doc["user_id"]).toBe(USER_ID);
    expect(doc["generated_at"]).toBeTypeOf("string");
    const chunks = doc["chunks"] as Record<string, unknown>;
    expect(Object.keys(chunks).length).toBe(9);
    for (const key of [
      "profile",
      "consents",
      "enrollments",
      "lesson_progress",
      "quiz_attempts",
      "assessment_attempts",
      "certificates",
      "credit_ledger",
      "notifications",
    ]) {
      expect(chunks[key]).toBeDefined();
    }
  });

  it("lesson_progress อ่านผ่าน in(enrollment_id, ids) จาก enrollments ที่พบ", async () => {
    const { client, capture } = mockServiceClient({
      tables: {
        profiles: ok({ id: USER_ID }),
        enrollments: ok([{ id: "en-1" }, { id: "en-2" }]),
      },
    });

    const doc = await composePersonalDataExport(client, USER_ID, JOB_ID);

    const chunks = doc["chunks"] as Record<string, unknown>;
    expect(chunks["lesson_progress"]).toEqual([]);
    expect(capture.inCalls).toEqual([{ col: "enrollment_id", values: ["en-1", "en-2"] }]);
  });

  it("notifications embed notification (select แบบ n-to-1)", async () => {
    const { client, capture } = mockServiceClient({
      tables: {
        profiles: ok({ id: USER_ID }),
        notification_recipients: ok([{ id: "nr-1", user_id: USER_ID }]),
      },
    });

    const doc = await composePersonalDataExport(client, USER_ID, JOB_ID);

    const sel = capture.selectCalls.find((s) => s.table === "notification_recipients");
    expect(sel?.cols).toBe("*, notification:notifications(*)");
    const chunks = doc["chunks"] as Record<"notifications", unknown>;
    expect(chunks.notifications).toEqual([{ id: "nr-1", user_id: USER_ID }]);
  });

  it("profiles read ล้ม → throw export_read_failed:profiles", async () => {
    const { client } = mockServiceClient({ tables: { profiles: fail("SQLSTATE XX000") } });

    await expect(composePersonalDataExport(client, USER_ID, JOB_ID)).rejects.toThrow(
      "export_read_failed:profiles",
    );
  });

  it("consents read ล้ม → throw export_read_failed:consents", async () => {
    const { client } = mockServiceClient({ tables: { consents: fail("SQLSTATE XX000") } });

    await expect(composePersonalDataExport(client, USER_ID, JOB_ID)).rejects.toThrow(
      "export_read_failed:consents",
    );
  });

  it("lesson_progress read ล้ม → throw export_read_failed:lesson_progress", async () => {
    const { client } = mockServiceClient({
      tables: {
        profiles: ok({ id: USER_ID }),
        enrollments: ok([{ id: "en-1" }]),
        lesson_progress: fail("SQLSTATE XX000"),
      },
    });

    await expect(composePersonalDataExport(client, USER_ID, JOB_ID)).rejects.toThrow(
      "export_read_failed:lesson_progress",
    );
  });
});

describe("processDataExportJob — ทางหลัก done", () => {
  it("pipeline ครบ → done + upload path/contentType + media row + complete args", async () => {
    const { client, capture } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID }) },
    });

    const outcome = await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID });

    expect(outcome).toBe("done");
    expect(capture.uploads.length).toBe(1);
    expect(capture.uploads[0]?.path).toBe(`pdpa-exports/${USER_ID}/${JOB_ID}.json`);
    expect(capture.uploads[0]?.contentType).toBe("application/json");
    const doc = JSON.parse(new TextDecoder().decode(capture.uploads[0]?.body)) as Record<string, unknown>;
    expect(doc["schema"]).toBe("ltc.pdpa-export.v1");
    expect(doc["chunk_count"]).toBe(9);
    const media = capture.mediaInserts[0];
    expect(media?.["provider"]).toBe("supabase_storage");
    expect(media?.["media_type"]).toBe("document");
    expect(media?.["bucket"]).toBe("pdpa-exports");
    expect(media?.["storage_path"]).toBe(`pdpa-exports/${USER_ID}/${JOB_ID}.json`);
    expect(media?.["mime_type"]).toBe("application/json");
    expect(media?.["status"]).toBe("ready");
    expect(media?.["uploaded_by"]).toBe(USER_ID);
    expect(typeof media?.["size_bytes"]).toBe("number");
    const complete = capture.rpcCalls.find((c) => c.fn === "complete_data_export_job");
    expect(complete?.args).toEqual({
      p_job_id: JOB_ID,
      p_file_media_id: MEDIA_ID,
      p_chunks: 9,
      p_request_id: null,
    });
  });

  it("ระบุ requestId → complete รับ p_request_id ตรง", async () => {
    const { client, capture } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID }) },
    });

    await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID }, "req-e15-1");

    const complete = capture.rpcCalls.find((c) => c.fn === "complete_data_export_job");
    expect(complete?.args).toMatchObject({ p_request_id: "req-e15-1" });
  });
});

describe("processDataExportJob — ล้มเหลวทุกทาง → fail RPC (ไม่ throw)", () => {
  it("compose ล้ม → failed + fail RPC reason export_compose_failed + ไม่ upload", async () => {
    const { client, capture } = mockServiceClient({ tables: { profiles: fail("SQLSTATE XX000") } });

    const outcome = await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID });

    expect(outcome).toBe("failed");
    expect(capture.uploads.length).toBe(0);
    const failCall = capture.rpcCalls.find((c) => c.fn === "fail_data_export_job");
    expect(failCall?.args).toEqual({ p_job_id: JOB_ID, p_error: "export_compose_failed" });
  });

  it("upload ล้ม → failed + reason export_upload_failed + ไม่แทรก media", async () => {
    const { client, capture } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID }) },
      uploadError: { message: "bucket missing" },
    });

    const outcome = await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID });

    expect(outcome).toBe("failed");
    expect(capture.mediaInserts.length).toBe(0);
    const failCall = capture.rpcCalls.find((c) => c.fn === "fail_data_export_job");
    expect(failCall?.args).toEqual({ p_job_id: JOB_ID, p_error: "export_upload_failed" });
  });

  it("media insert ล้ม → failed + reason export_media_insert_failed + ไม่ complete", async () => {
    const { client, capture } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID }) },
      mediaError: { message: "insert failed" },
    });

    const outcome = await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID });

    expect(outcome).toBe("failed");
    const complete = capture.rpcCalls.find((c) => c.fn === "complete_data_export_job");
    expect(complete).toBeUndefined();
    const failCall = capture.rpcCalls.find((c) => c.fn === "fail_data_export_job");
    expect(failCall?.args).toEqual({ p_job_id: JOB_ID, p_error: "export_media_insert_failed" });
  });

  it("complete ล้ม → failed + reason export_complete_failed + fail RPC เรียก", async () => {
    const { client, capture } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID }) },
      completeError: { message: "rpc failed" },
    });

    const outcome = await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID });

    expect(outcome).toBe("failed");
    const failCall = capture.rpcCalls.find((c) => c.fn === "fail_data_export_job");
    expect(failCall?.args).toEqual({ p_job_id: JOB_ID, p_error: "export_complete_failed" });
  });

  it("fail RPC เองล้มด้วย → ยังคืน failed (ไม่ throw ทิ้งคิว)", async () => {
    const { client, capture } = mockServiceClient({
      tables: { profiles: fail("SQLSTATE XX000") },
      failError: { message: "db down" },
    });

    const outcome = await processDataExportJob(client, { jobId: JOB_ID, userId: USER_ID });

    expect(outcome).toBe("failed");
    expect(capture.rpcCalls.filter((c) => c.fn === "fail_data_export_job").length).toBe(1);
  });
});

describe("runPersonalDataExportLoop", () => {
  it("claim 2 job — ทั้งคู่ compose ล้ม → {claimed:2, done:0, failed:2} แล้วคิวว่างหยุด", async () => {
    mockServiceClient({
      tables: { profiles: fail("SQLSTATE XX000") },
      claimQueue: [ok({ jobId: JOB_ID, userId: USER_ID }), ok({ jobId: JOB_ID_2, userId: USER_ID })],
    });

    const summary = await runPersonalDataExportLoop();

    expect(summary).toEqual({ claimed: 2, done: 0, failed: 2 });
  });

  it("cap ต่อ tick — claim ไม่ว่างเสมอ + maxJobs 3 → claimed 3 แล้วหยุด", async () => {
    const { capture } = mockServiceClient({
      tables: { profiles: ok({ id: USER_ID }) },
      claimForever: true,
    });

    const summary = await runPersonalDataExportLoop({ maxJobs: 3 });

    expect(summary).toEqual({ claimed: 3, done: 3, failed: 0 });
    expect(capture.rpcCalls.filter((c) => c.fn === "claim_data_export_job").length).toBe(3);
  });

  it("claim drift (jobId ไม่ใช่ uuid) → break fail-closed claimed 0", async () => {
    const { capture } = mockServiceClient({
      claimQueue: [ok({ jobId: "not-a-uuid", userId: USER_ID })],
    });

    const summary = await runPersonalDataExportLoop();

    expect(summary).toEqual({ claimed: 0, done: 0, failed: 0 });
    expect(capture.rpcCalls.filter((c) => c.fn === "fail_data_export_job").length).toBe(0);
  });

  it("claim RPC error → break {0,0,0}", async () => {
    mockServiceClient({ claimQueue: [fail("SQLSTATE XX000")] });

    const summary = await runPersonalDataExportLoop();

    expect(summary).toEqual({ claimed: 0, done: 0, failed: 0 });
  });
});
