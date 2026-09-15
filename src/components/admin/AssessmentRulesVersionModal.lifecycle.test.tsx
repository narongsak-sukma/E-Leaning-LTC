// @vitest-environment jsdom
/**
 * lifecycle test แบบ interactive ของโมดัลกติกา — D91 [#94] ปิด SYSTEM-TEST §5.1:13
 *
 * §5.1:13: "lifecycle แบบ interactive ของโมดัลกติกา (handleSubmit → subscription →
 * effect → read-back) ยังไม่มีเทสระดับ component-render — เทสปัจจุบันขับ pure fn
 * จริง + registry/subscription จริง + SSR renderToString ของ component จริง แต่
 * effect รันเฉพาะ client แบบ interactive ที่ต้อง jsdom/RTL"
 *
 * ไฟล์นี้คือ "ไฟล์ใหม่ src/**" ที่ขอ jsdom (limitation 10) — ประกาศ env ผ่าน
 * docblock บรรทัดแรก ไม่แตะ environment ของ suite อื่น (unit .test.ts ทั้งหลายคง
 * node · include แยก unit/IT ไม่ชน — vitest.config.ts)
 *
 * พิสูจน์ห่วงโซ่เต็มแบบ interactive ด้วย component จริง + registry singleton จริง:
 * 1. handleSubmit → POST ตาย network (AdminApiError status 0) → uncertainSave ล็อก
 *    ปุ่ม + applyDeferredRulesOutcome ลง registry + notify
 * 2. subscription → useSyncExternalStore ปลุก render → effect กลาง
 *    (deferredRegistryReaction = start_read_back) เริ่ม GET read-back เอง —
 *    ไม่มีการเรียกตรงจาก handler (resolvingId ล็อกปุ่มด้วยเหตุผล "กำลังตรวจสอบ")
 * 3. read-back ตอบ version ใหม่ (committed_expected) → registry.resolve →
 *    outcome_resolved ปลดล็อก + prefill จากกติกาเซิร์ฟเวอร์จริง + notice ไทย
 * 4. สาย fail-closed: read-back ไม่ ok (503) = คงล็อก + ปุ่ม "ตรวจสอบอีกครั้ง"
 *    + ห้ามวนตรวจอัตโนมัติ (retryNoticeVisible หน่วง effect — รอผู้ใช้กดเอง)
 *    → กดแล้วอ่านได้จริง no_rules → not_committed ปลดล็อกให้บันทึกใหม่
 * 5. สาย deferred: ปิดโมดัลกลาง POST → เปิดใหม่ — in-flight รอดการปิด (select
 *    ล็อกจนคำขอจบ) → ผล uncertain มาถึงหลังเปิดใหม่ (epoch ไม่ตรง = ห้ามเขียน
 *    state รอบเก่า) → notify ปลุก effect → เลือกชุดเดิม → effect เริ่ม read-back
 *    เอง → committed_expected → ปลดล็อก + prefill
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/navigation";

import {
  AdminApiError,
  postAdminJson,
  TRANSPORT_FALLBACK_MESSAGE,
} from "@/lib/exam-admin.client";
import {
  AssessmentRulesVersionModal,
  unresolvedRulesRegistry,
  type AssessmentOption,
  type AssessmentRulesPrefill,
} from "./AssessmentRulesVersionModal";

// component จริงเรียก useRouter ตอน render — mock ทั้ง module (คืนค่าผ่าน
// mockReturnValue ใน beforeEach เพื่อถือ spy refresh ต่อเทส) · postAdminJson
// mock เฉพาะตัว (เก็บ AdminApiError/TRANSPORT_FALLBACK_MESSAGE/unwrapDataEnvelope
// ของจริงไว้ — pure ที่ component ใช้ต่อต้องเป็นของจริง)
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
vi.mock("@/lib/exam-admin.client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exam-admin.client")>();
  return { ...actual, postAdminJson: vi.fn() };
});

// React 19 + RTL นอก jest: ต้องตั้ง act environment เองก่อน render
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A1 = "11111111-1111-4111-8111-111111111111";

/** กติกา version 4 ที่หน้า RSC ส่งมา (props) — เวลา 90 นาที · ผ่าน 75% */
const PREFILL_V4: AssessmentRulesPrefill = {
  version: 4,
  timeLimitMinutes: 90,
  questionCount: 25,
  passPct: 75,
  maxAttempts: 2,
  cooldownMinutes: 720,
  shuffleQuestions: false,
  shuffleOptions: true,
  requireCourseComplete: false,
  selection: { bank_ids: ["b00000000-0000-4000-8000-000000000001"], per_difficulty: 2 },
  proctoringMode: "none",
  examReviewMode: "never",
};

/**
 * กติกา version 5 ที่เซิร์ฟเวอร์ตอบตอน read-back — เวลา 120 นาที · ผ่าน 80%
 * (ต่างจาก props ชัดเจน เพื่อพิสูจน์ว่า prefill หลัง resolve มาจาก read-back
 * จริง ไม่ใช่ props เก่าของหน้า)
 */
const SERVER_RULES_V5 = {
  version: 5,
  timeLimitMinutes: 120,
  questionCount: 25,
  passPct: 80,
  maxAttempts: 2,
  cooldownMinutes: 720,
  shuffleQuestions: false,
  shuffleOptions: true,
  requireCourseComplete: false,
  selection: { bank_ids: ["b00000000-0000-4000-8000-000000000001"], per_difficulty: 2 },
  proctoringMode: "none",
  examReviewMode: "never",
};

const OPTIONS: readonly AssessmentOption[] = [
  { id: A1, label: "กฎหมายมูลฐาน 2568", currentVersion: 4, currentRules: PREFILL_V4 },
];

/** response ปลอมของ GET read-back — component อ่านแค่ ok/json (สัญญาเดียวกับ fetch จริง) */
function readBackResponse(rules: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => ({ data: [{ rules }] }) };
}

const openButton = () =>
  screen.getByRole("button", { name: "+ เพิ่มกติกา version ใหม่" }) as HTMLButtonElement;
const confirmButton = () =>
  screen.getByRole("button", { name: "บันทึกกติกา version ใหม่" }) as HTMLButtonElement;
const cancelButton = () => screen.getByRole("button", { name: "ยกเลิก" }) as HTMLButtonElement;

/** select ของชุดข้อสอบ — หาผ่าน option "— เลือกชุดข้อสอบ —" ที่มีเพียงตัวเดียว
 * (FieldRow ซ้อนข้อความ label ใน span — แตะผ่าน getByLabelText ไม่ได้ทุกรูปแบบ) */
function assessmentSelect(): HTMLSelectElement {
  const anchor = screen.getByRole("option", { name: "— เลือกชุดข้อสอบ —" });
  const select = anchor.closest("select");
  if (select === null) throw new Error("ไม่พบ <select> ของชุดข้อสอบ");
  return select;
}

function renderModal() {
  return render(<AssessmentRulesVersionModal assessmentOptions={OPTIONS} allowRules={true} />);
}

/** เปิดโมดัล + เลือกชุดข้อสอบ A1 (prefill v4 จาก props) */
function openAndSelect() {
  fireEvent.click(openButton());
  fireEvent.change(assessmentSelect(), { target: { value: A1 } });
}

const postMock = vi.mocked(postAdminJson);
const fetchMock = vi.fn();
let refreshSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  postMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  refreshSpy = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    refresh: refreshSpy,
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  unresolvedRulesRegistry.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  unresolvedRulesRegistry.clear();
});

describe("AssessmentRulesVersionModal lifecycle แบบ interactive (D91 · SYSTEM-TEST §5.1:13)", () => {
  it(
    "handleSubmit POST ตาย network → uncertain ลง registry → subscription/effect เริ่ม read-back เอง → committed_expected ปลดล็อก + prefill จากเซิร์ฟเวอร์",
    async () => {
      renderModal();
      openAndSelect();
      // prefill จาก props ก่อนส่ง (v4) — ฟอร์มพร้อม ปุ่มไม่ล็อก
      expect(screen.getByDisplayValue("90")).toBeTruthy();
      expect(confirmButton().disabled).toBe(false);

      // POST ตายก่อนมี response — AdminApiError status 0 = ไม่ใช่ definitive
      // rejection → ผลยังไม่แน่นอน (R2-M1/R4-M2)
      postMock.mockRejectedValueOnce(
        new AdminApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE),
      );
      // read-back ค้างด้วย promise ที่เราคุม — จับ state กลางช่วง "กำลังตรวจ" ได้
      let answerReadBack!: (response: unknown) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerReadBack = resolve;
          }),
      );
      fireEvent.click(confirmButton());

      await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
      expect(postMock).toHaveBeenCalledWith(
        `/api/v1/admin/assessments/${A1}/rules`,
        expect.objectContaining({ timeLimitMinutes: 90, passPct: 75 }),
      );

      // ห่วงโซ่ 1→2: uncertain → registry + notify → useSyncExternalStore ปลุก →
      // effect กลาง (deferredRegistryReaction=start_read_back) เริ่ม GET เอง —
      // handler ไม่ได้เรียก read-back ตรง (R5-M1 ทางเดียวผ่าน effect)
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
          `/api/v1/admin/assessments?id=${A1}`,
        );
      });

      // กลางช่วงตรวจ: ปุ่มล็อกด้วยเหตุผลของ resolvingId (หลักฐานว่า effect เป็นผู้
      // เริ่ม read-back จริง) + ข้อความ uncertain ไทยของรอบนี้ (epoch ตรง)
      await waitFor(() =>
        expect(confirmButton().title).toContain("กำลังตรวจสอบผลการบันทึกครั้งก่อน"),
      );
      expect(confirmButton().disabled).toBe(true);
      expect(screen.getByRole("alert").textContent).toContain("ไม่แน่ใจว่าบันทึกสำเร็จหรือไม่");

      // ห่วงโซ่ 3: เซิร์ฟเวอร์ตอบ version 5 (= 4+1 → committed_expected) →
      // resolve → ปลดล็อก + prefill จากกติกาเซิร์ฟเวอร์จริง + notice ไทย
      answerReadBack(readBackResponse(SERVER_RULES_V5));
      await waitFor(() => expect(confirmButton().disabled).toBe(false));
      expect(
        screen.getByText(/ยืนยันกับเซิร์ฟเวอร์แล้ว — การบันทึกกติกา version 5 สำเร็จแล้ว/),
      ).toBeTruthy();
      expect(screen.getByDisplayValue("120")).toBeTruthy(); // prefill จาก read-back ไม่ใช่ props v4
      expect(unresolvedRulesRegistry.peek(A1)).toBeUndefined(); // resolve เรียบร้อย
      expect(refreshSpy).toHaveBeenCalled(); // refresh ทุกผล (R5-M1)
    },
    20_000,
  );

  it(
    "read-back ไม่ ok (503) → fail-closed คงล็อก + ปุ่ม 'ตรวจสอบอีกครั้ง' + ห้ามวนตรวจอัตโนมัติ → กด retry ได้ no_rules → not_committed ปลดล็อกให้บันทึกใหม่",
    async () => {
      renderModal();
      openAndSelect();
      postMock.mockRejectedValueOnce(
        new AdminApiError("ERR-SYS-001", 0, TRANSPORT_FALLBACK_MESSAGE),
      );
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(readBackResponse(null, false, 503)))
        .mockImplementationOnce(() => Promise.resolve(readBackResponse(null))); // retry: rules null = no_rules
      fireEvent.click(confirmButton());

      // fail-closed: notice เตือน + ปุ่ม retry โผล่ + ปุ่มบันทึกยังล็อก + registry คงรายการ
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "ตรวจสอบอีกครั้ง" })).toBeTruthy(),
      );
      expect(screen.getByRole("status").textContent).toContain("ตรวจสอบกับเซิร์ฟเวอร์ไม่สำเร็จ");
      expect(confirmButton().disabled).toBe(true);
      expect(confirmButton().title).toContain("กด 'ตรวจสอบอีกครั้ง'");
      expect(unresolvedRulesRegistry.peek(A1)).toBeDefined();

      // ห้ามวนตรวจอัตโนมัติ — retryNoticeVisible หน่วง effect ไว้ (R5-M1: ตอน
      // เซิร์ฟเวอร์ล้ม รอผู้ใช้กดเอง ไม่งั้นวนตรวจไม่รู้จบ)
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // ผู้ใช้กด retry เอง → อ่านได้จริงและไม่มีกติกาใหม่ (no_rules = รู้ความจริงแล้ว
      // ไม่ใช่อ่านไม่ได้) → not_committed → ปลดล็อกให้บันทึกใหม่ได้
      fireEvent.click(screen.getByRole("button", { name: "ตรวจสอบอีกครั้ง" }));
      await waitFor(() => expect(confirmButton().disabled).toBe(false));
      expect(screen.getByText(/ยังไม่พบกติกา version ใหม่ของชุดนี้/)).toBeTruthy();
      expect(unresolvedRulesRegistry.peek(A1)).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
    20_000,
  );

  it(
    "ปิดโมดัลกลาง POST → เปิดใหม่: in-flight รอดการปิด (select ล็อกจนคำขอจบ) → ผล uncertain มาช้าหลังเปิดใหม่ (epoch ไม่ตรง ห้ามเขียน state รอบเก่า) → เลือกชุดเดิมแล้ว effect เริ่ม read-back เอง → ปลดล็อก",
    async () => {
      renderModal();
      openAndSelect();

      // POST ค้าง — คุมจังหวะปล่อยเองหลังปิด-เปิดโมดัลใหม่
      let answerPost!: (result: { status: number; body: unknown }) => void;
      postMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerPost = resolve;
          }),
      );
      fetchMock.mockImplementationOnce(() => Promise.resolve(readBackResponse(SERVER_RULES_V5)));
      fireEvent.click(confirmButton());
      await waitFor(() => expect(confirmButton().disabled).toBe(true));
      // gate ชั้น in-flight มีลำดับก่อนแกน submitting — กลาง POST ต้องเห็นเหตุผลของชั้นนี้
      expect(confirmButton().title).toContain("คำขอกำลังส่งอยู่");

      // ปิดกลางคัน (epoch bump + สถานะฟอร์มรีเซ็ต) — in-flight ของ A1 ต้องรอด (R4-M2)
      fireEvent.click(cancelButton());
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(unresolvedRulesRegistry.isInFlight(A1)).toBe(true);

      // เปิดใหม่: ฟอร์มเริ่มใหม่ (ยังไม่เลือกชุด) · เลือกชุดเดิม → ปุ่มบันทึกล็อก
      // ทันทีด้วยเหตุผล "คำขอกำลังส่งอยู่" — in-flight รอดการปิดโมดัลมาล็อกชุดนี้ (R4-M2)
      fireEvent.click(openButton());
      fireEvent.change(assessmentSelect(), { target: { value: A1 } });
      await waitFor(() => expect(confirmButton().disabled).toBe(true));
      expect(confirmButton().title).toContain("คำขอกำลังส่งอยู่");

      // คำขอเดิมจบแบบ uncertain (201 แต่ envelope ไม่มี data → อ่าน version ไม่ได้)
      // — epoch ไม่ตรงแล้ว: ห้ามเขียน state รอบเก่า แต่ registry ต้องลงทะเบียน +
      // notify ปลุก effect ของโมดัลที่เปิดอยู่ → เริ่ม read-back เอง (ไม่มีใครเรียกตรง)
      answerPost({ status: 201, body: { error: "no-version-here" } });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/v1/admin/assessments?id=${A1}`);
      expect(screen.queryByText(/ไม่แน่ใจว่าบันทึกสำเร็จหรือไม่/)).toBeNull(); // ui=discard

      // committed_expected → ปลดล็อก + prefill v5 + notice ไทย
      await waitFor(() => expect(confirmButton().disabled).toBe(false));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/v1/admin/assessments?id=${A1}`);
      expect(screen.getByText(/ยืนยันกับเซิร์ฟเวอร์แล้ว/)).toBeTruthy();
      expect(screen.getByDisplayValue("120")).toBeTruthy();
      expect(unresolvedRulesRegistry.peek(A1)).toBeUndefined();
    },
    20_000,
  );
});
