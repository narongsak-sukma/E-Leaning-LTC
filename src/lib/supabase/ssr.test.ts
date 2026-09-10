/**
 * unit tests — src/lib/supabase/ssr.ts (mock @supabase/ssr + next/headers ตามแบบ errors.test.ts)
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("../config", () => ({
  getConfig: () => ({
    supabaseUrl: "https://unit-test.supabase.co",
    supabaseAnonKey: "anon-key-unit-test",
  }),
}));

import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createSupabaseSsrClient } from "./ssr";

const createServerClientMock = vi.mocked(createServerClient);
const cookiesMock = vi.mocked(cookies);

/** cookie store จำลองของ Next 15 (await cookies()) */
function makeCookieStore() {
  const entries: { name: string; value: string; options?: Record<string, unknown> }[] = [];
  return {
    entries,
    getAll: () => entries.map(({ name, value }) => ({ name, value })),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      // exactOptionalPropertyTypes: ห้าม push `options: undefined` — แยกสาขาแทน
      entries.push(options === undefined ? { name, value } : { name, value, options });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("ส่ง url/key จาก config ให้ @supabase/ssr ตรงกัน (ห้าม hardcode)", async () => {
  const store = makeCookieStore();
  cookiesMock.mockResolvedValue(store as never);
  await createSupabaseSsrClient();
  expect(createServerClientMock).toHaveBeenCalledWith(
    "https://unit-test.supabase.co",
    "anon-key-unit-test",
    expect.anything(),
  );
});

it("getAll อ่าน session จาก cookie ของ request", async () => {
  const store = makeCookieStore();
  store.entries.push({ name: "sb-auth-token", value: "token-value" });
  cookiesMock.mockResolvedValue(store as never);
  await createSupabaseSsrClient();
  const options = createServerClientMock.mock.calls[0]?.[2] as {
    cookies: { getAll: () => { name: string; value: string }[] };
  };
  expect(options.cookies.getAll()).toEqual([{ name: "sb-auth-token", value: "token-value" }]);
});

it("setAll เขียน cookie กลับผ่าน cookie store พร้อม flags บังคับ (httpOnly+sameSite=lax+path)", async () => {
  const store = makeCookieStore();
  cookiesMock.mockResolvedValue(store as never);
  await createSupabaseSsrClient();
  const options = createServerClientMock.mock.calls[0]?.[2] as { cookies: CookieMethodsServer };
  options.cookies.setAll?.([{ name: "sb-auth-token", value: "new-token", options: { httpOnly: true } }], {});
  // NODE_ENV=test → secure=false; flags อื่นบังคับเสมอ (SSD §5.1 — library default httpOnly:false)
  expect(store.entries).toEqual([
    {
      name: "sb-auth-token",
      value: "new-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: false },
    },
  ]);
});

it("setAll บังคับ httpOnly=true ทับ options ของ library (regression: @supabase/ssr ตั้ง httpOnly:false)", async () => {
  const store = makeCookieStore();
  cookiesMock.mockResolvedValue(store as never);
  await createSupabaseSsrClient();
  const options = createServerClientMock.mock.calls[0]?.[2] as { cookies: CookieMethodsServer };
  // จำลอง default จริงของ library (dist/utils/constants.js: httpOnly: false, sameSite: "lax")
  options.cookies.setAll?.([{ name: "sb-auth-token", value: "t", options: { httpOnly: false, sameSite: "lax" } }], {});
  expect(store.entries[0]?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
});

it("setAll บังคับ path=/ ทับ options ของ library (ห้าม scope cookie แคบกว่าทั้ง BFF)", async () => {
  const store = makeCookieStore();
  cookiesMock.mockResolvedValue(store as never);
  await createSupabaseSsrClient();
  const options = createServerClientMock.mock.calls[0]?.[2] as { cookies: CookieMethodsServer };
  options.cookies.setAll?.([{ name: "sb-auth-token", value: "t", options: { path: "/auth" } }], {});
  expect(store.entries[0]?.options).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax" });
});

it("setAll ไม่พังเมื่ออยู่ใน context ที่ set cookie ไม่ได้ (Server Component read-only)", async () => {
  const store = makeCookieStore();
  store.set = () => {
    throw new Error("Cookies can only be modified in a Server Action or Route Handler");
  };
  cookiesMock.mockResolvedValue(store as never);
  await createSupabaseSsrClient();
  const options = createServerClientMock.mock.calls[0]?.[2] as { cookies: CookieMethodsServer };
  expect(() => options.cookies.setAll?.([{ name: "sb", value: "v", options: {} }], {})).not.toThrow();
});

it("สร้าง client ใหม่ทุกครั้งที่เรียก (ห้ามแชร์ข้าม request)", async () => {
  const store = makeCookieStore();
  cookiesMock.mockResolvedValue(store as never);
  createServerClientMock
    .mockReturnValueOnce({ tag: "first" } as never)
    .mockReturnValueOnce({ tag: "second" } as never);
  const first = await createSupabaseSsrClient();
  const second = await createSupabaseSsrClient();
  expect(createServerClientMock).toHaveBeenCalledTimes(2);
  expect(first).toEqual({ tag: "first" });
  expect(second).toEqual({ tag: "second" });
});
