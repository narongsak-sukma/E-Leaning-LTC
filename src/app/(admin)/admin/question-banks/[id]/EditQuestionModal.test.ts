/**
 * unit tests — EditQuestionModal logic (Wave G P2 · lane W2)
 * ครอบ: client lifecycle ของ edit GET ตาม D74 (เปิด = fetch no-store · ปิด = ล้าง ·
 * late response ไม่แสดง · auth ล้ม = ล้าง+ฟ้อง) · parse resource fail-closed ·
 * options ตาม D79 (option เดิมส่ง id เดิม · แถวใหม่ไม่มี id · ลบไม่ได้ · body ไม่มี status)
 * (logic ทั้งหมดถูก export เป็น pure function — เทสใน node env ได้)
 */
import { describe, expect, it } from "vitest";

import { AdminApiError } from "@/lib/exam-admin.client";

import { ADMIN_REQUEST_CACHE } from "./api-client";
import {
  EDIT_LOAD_MESSAGES,
  EDIT_MODAL_IDLE,
  EDIT_OPTIONS_DELETE_HINT,
  addEditOption,
  buildQuestionPatchBody,
  editFormFromResource,
  editLoadOutcomeFromError,
  editLoadOutcomeFromResponse,
  editModalClose,
  editModalDeny,
  editModalOpenFor,
  editModalResolveLoad,
  editModalSaveApiValidation,
  editModalSaveError,
  editModalSaveStart,
  editModalSaveSuccess,
  editModalSaveValidationError,
  markEditSingleCorrect,
  parseEditQuestionResource,
  parseSavedVersion,
  updateEditOption,
  type EditModalState,
  type EditQuestionFormState,
  type EditQuestionResource,
} from "./EditQuestionModal";

/* ─── builders — resource และฟอร์มที่ถูกต้อง (ใช้ร่วมทุกชุดเทส) ─── */

const RESOURCE_BASE: EditQuestionResource = {
  id: "q-1",
  bankId: "b-1",
  type: "single_choice",
  difficulty: "easy",
  questionText: "ข้อใดกล่าวถูกต้อง",
  explanation: "เพราะข้อ ก. ถูกต้อง",
  points: 5,
  status: "active",
  tags: ["กฎหมาย"],
  version: 3,
  createdAt: "2026-01-15T03:00:00Z",
  options: [
    { id: "opt-1", optionText: "ตัวเลือก ก.", sortOrder: 0, isCorrect: true },
    { id: "opt-2", optionText: "ตัวเลือก ข.", sortOrder: 1, isCorrect: false },
  ],
};

function resourceWith(overrides: Partial<EditQuestionResource>): EditQuestionResource {
  return { ...RESOURCE_BASE, ...overrides };
}

function formWith(overrides: Partial<EditQuestionFormState>): EditQuestionFormState {
  return {
    type: "single_choice",
    difficulty: "easy",
    questionText: "ข้อใดกล่าวถูกต้อง",
    explanation: "",
    points: "5",
    tagsText: "กฎหมาย",
    options: [
      { id: "opt-1", optionText: "ตัวเลือก ก.", isCorrect: true, sortOrder: "0" },
      { id: "opt-2", optionText: "ตัวเลือก ข.", isCorrect: false, sortOrder: "1" },
    ],
    ...overrides,
  };
}

describe("D74 — เปิด modal = ล้าง + ระบุ request ใหม่ · fetch ต้อง no-store", () => {
  it("ADMIN_REQUEST_CACHE = no-store (cache ของ edit GET ทุกครั้ง)", () => {
    expect(ADMIN_REQUEST_CACHE).toBe("no-store");
  });

  it("editModalOpenFor: phase loading · resource/form ว่าง · ผูก qid+requestId", () => {
    const state = editModalOpenFor("q-1", 7);
    expect(state.phase).toBe("loading");
    expect(state.qid).toBe("q-1");
    expect(state.requestId).toBe(7);
    expect(state.resource).toBeNull();
    expect(state.form).toBeNull();
    expect(state.errorMessage).toBeNull();
  });

  it("เปิดซ้ำ (requestId +1) — state ก่อนหน้าไม่หลุดมาใหม่", () => {
    const first = editModalOpenFor("q-1", 1);
    const reopened = editModalOpenFor("q-2", 2);
    expect(reopened.qid).toBe("q-2");
    expect(reopened.requestId).toBe(2);
    expect(reopened.resource).toBeNull();
    expect(first.requestId).not.toBe(reopened.requestId);
  });
});

describe("D74 — ปิด modal = ล้าง state กลับสู่ idle", () => {
  it("editModalClose → idle สนิท ทั้ง resource และ form", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    expect(loaded.form).not.toBeNull();
    const closed = editModalClose();
    expect(closed).toEqual(EDIT_MODAL_IDLE);
    expect(closed.resource).toBeNull();
    expect(closed.form).toBeNull();
    expect(closed.phase).toBe("idle");
  });

  it("ปิดจาก phase saved/denied/error ก็ idle สนิทเช่นกัน", () => {
    expect(editModalClose()).toEqual(EDIT_MODAL_IDLE);
  });
});

describe("D74 — late response ของข้อเก่าต้องไม่แสดงบน modal ข้อใหม่", () => {
  it("resolve ด้วย requestId เก่า → state ไม่เปลี่ยน (คืน object เดิม)", () => {
    const current = editModalOpenFor("q-2", 2);
    const stale = editModalResolveLoad(
      current,
      "q-2",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    expect(stale).toBe(current);
  });

  it("resolve ด้วย qid อื่น → state ไม่เปลี่ยน", () => {
    const current = editModalOpenFor("q-2", 2);
    const stale = editModalResolveLoad(
      current,
      "q-1",
      2,
      { ok: true, resource: RESOURCE_BASE },
    );
    expect(stale).toBe(current);
  });

  it("late response ที่เป็น error ก็ถูกทิ้งเช่นกัน", () => {
    const current = editModalOpenFor("q-2", 2);
    const stale = editModalResolveLoad(
      current,
      "q-2",
      1,
      { ok: false, kind: "server" },
    );
    expect(stale).toBe(current);
  });

  it("resolve ตอนไม่ได้ loading (เช่น closed/idle) → ไม่แตะ state", () => {
    const current = editModalOpenFor("q-1", 3);
    const after = editModalResolveLoad(
      editModalClose(),
      "q-1",
      3,
      { ok: true, resource: RESOURCE_BASE },
    );
    expect(after).toEqual(EDIT_MODAL_IDLE);
    expect(current.phase).toBe("loading");
  });

  it("resolve ถูกต้อง (qid+requestId ตรง + loading) → ready พร้อมฟอร์ม", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 5),
      "q-1",
      5,
      { ok: true, resource: RESOURCE_BASE },
    );
    expect(loaded.phase).toBe("ready");
    expect(loaded.resource).not.toBeNull();
    expect(loaded.form).not.toBeNull();
    expect(loaded.form?.questionText).toBe("ข้อใดกล่าวถูกต้อง");
    expect(loaded.form?.options[0]?.id).toBe("opt-1");
  });
});

describe("D74 — authorization ล้ม = ล้าง state + ฟ้องภาษาไทย", () => {
  it("edit GET ตอบ 401/403 → outcome denied", () => {
    expect(editLoadOutcomeFromError(new AdminApiError("ERR-RBAC-001", 403, "x"))).toEqual({
      ok: false,
      kind: "denied",
    });
    expect(editLoadOutcomeFromError(new AdminApiError("ERR-AUTH-001", 401, "x"))).toEqual({
      ok: false,
      kind: "denied",
    });
  });

  it("error อื่น (500/transport) → outcome server (ไม่ใช่ denied)", () => {
    expect(editLoadOutcomeFromError(new AdminApiError("ERR-SYS-001", 0, "x"))).toEqual({
      ok: false,
      kind: "server",
    });
    expect(editLoadOutcomeFromError(new Error("boom"))).toEqual({ ok: false, kind: "server" });
  });

  it("resolve denied → phase denied · resource/form ถูกล้าง · ข้อความไทย", () => {
    const denied = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: false, kind: "denied" },
    );
    expect(denied.phase).toBe("denied");
    expect(denied.resource).toBeNull();
    expect(denied.form).toBeNull();
    expect(denied.errorMessage).toBe(EDIT_LOAD_MESSAGES.denied);
  });

  it("PATCH ตอบ 401/403 ระหว่างบันทึก → editModalDeny ล้าง resource+form ทิ้ง", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const saving = editModalSaveStart(loaded);
    expect(saving.phase).toBe("saving");
    const denied = editModalDeny(saving);
    expect(denied.phase).toBe("denied");
    expect(denied.resource).toBeNull();
    expect(denied.form).toBeNull();
    expect(denied.errorMessage).toBe(EDIT_LOAD_MESSAGES.denied);
  });

  it("editModalDeny ตอน idle → ไม่แตะ state", () => {
    expect(editModalDeny(EDIT_MODAL_IDLE)).toEqual(EDIT_MODAL_IDLE);
  });
});

describe("editLoadOutcomeFromResponse — แมป response ของ edit GET", () => {
  it("200 + envelope ถูกต้อง → resource ที่ parse แล้ว", () => {
    const outcome = editLoadOutcomeFromResponse(200, { data: { ...RESOURCE_BASE } });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.resource.id).toBe("q-1");
    }
  });

  it("200 แต่ body ผิดรูป → kind server (fail-closed)", () => {
    expect(editLoadOutcomeFromResponse(200, null)).toEqual({ ok: false, kind: "server" });
    expect(editLoadOutcomeFromResponse(200, { data: { id: "q-1" } })).toEqual({
      ok: false,
      kind: "server",
    });
  });

  it("404 → not-found · 500 → server", () => {
    expect(editLoadOutcomeFromResponse(404, null)).toEqual({ ok: false, kind: "not-found" });
    expect(editLoadOutcomeFromResponse(500, null)).toEqual({ ok: false, kind: "server" });
  });
});

describe("parseEditQuestionResource — fail-closed ทุกฟิลด์", () => {
  it("resource ครบถ้วน → parse ผ่าน", () => {
    const parsed = parseEditQuestionResource({ data: { ...RESOURCE_BASE } });
    expect(parsed).not.toBeNull();
    expect(parsed?.options[0]?.isCorrect).toBe(true);
  });

  it("ไม่มี envelope { data } → null", () => {
    expect(parseEditQuestionResource(null)).toBeNull();
    expect(parseEditQuestionResource({})).toBeNull();
    expect(parseEditQuestionResource({ data: "nope" })).toBeNull();
  });

  it("ฟิลด์จำเป็นขาด/ผิดชนิด → null (id/type/points/version/createdAt)", () => {
    expect(
      parseEditQuestionResource({ data: resourceWith({ id: "" }) }),
    ).toBeNull();
    expect(
      parseEditQuestionResource({ data: resourceWith({ type: "essay" as never }) }),
    ).toBeNull();
    expect(
      parseEditQuestionResource({ data: resourceWith({ points: 1.5 }) }),
    ).toBeNull();
    expect(
      parseEditQuestionResource({ data: resourceWith({ version: 0 }) }),
    ).toBeNull();
    expect(
      parseEditQuestionResource({ data: resourceWith({ createdAt: "not-a-date" }) }),
    ).toBeNull();
  });

  it("explanation: null ได้ · ขาดคีย์ = ผิด contract → null", () => {
    expect(
      parseEditQuestionResource({ data: resourceWith({ explanation: null }) }),
    ).not.toBeNull();
    const missing = { ...RESOURCE_BASE } as Record<string, unknown>;
    delete missing["explanation"];
    expect(parseEditQuestionResource({ data: missing })).toBeNull();
  });

  it("tags ไม่ใช่ array ของ string → null", () => {
    expect(
      parseEditQuestionResource({ data: resourceWith({ tags: [1, 2] as never }) }),
    ).toBeNull();
  });

  it("options ว่าง → null", () => {
    expect(parseEditQuestionResource({ data: resourceWith({ options: [] }) })).toBeNull();
  });

  it("option ขาด isCorrect → null (EditQuestionResource ต้องมีเฉลยทุกแถว)", () => {
    const missingIsCorrect = [
      { id: "opt-1", optionText: "ตัวเลือก ก.", sortOrder: 0, isCorrect: true },
      { id: "opt-2", optionText: "ตัวเลือก ข.", sortOrder: 1 },
    ];
    expect(
      parseEditQuestionResource({ data: resourceWith({ options: missingIsCorrect as never }) }),
    ).toBeNull();
  });

  it("option ที่ sortOrder นอกช่วง 0-999 → null", () => {
    const outOfRange = [
      { id: "opt-1", optionText: "ตัวเลือก ก.", sortOrder: 1000, isCorrect: true },
      { id: "opt-2", optionText: "ตัวเลือก ข.", sortOrder: 1, isCorrect: false },
    ];
    expect(
      parseEditQuestionResource({ data: resourceWith({ options: outOfRange as never }) }),
    ).toBeNull();
  });

  it("editFormFromResource — points/sortOrder เป็นสตริง · tags คั่นด้วย , · คง id เดิม", () => {
    const form = editFormFromResource(RESOURCE_BASE);
    expect(form.points).toBe("5");
    expect(form.tagsText).toBe("กฎหมาย");
    expect(form.options.map((option) => option.id)).toEqual(["opt-1", "opt-2"]);
    expect(form.options[0]?.sortOrder).toBe("0");
  });
});

describe("D79 — buildQuestionPatchBody: option เดิมส่ง id เดิม · ใหม่ไม่มี id · body ไม่มี status", () => {
  it("option เดิมทั้งหมด → body ส่ง id เดิมครบ (update)", () => {
    const built = buildQuestionPatchBody(formWith({}));
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.body.options.map((option) => option.id)).toEqual(["opt-1", "opt-2"]);
      expect("status" in built.body).toBe(false);
    }
  });

  it("แถวใหม่ (id = null) → body ไม่มีคีย์ id เลย (insert ตาม D79)", () => {
    const built = buildQuestionPatchBody(
      formWith({
        options: [
          { id: "opt-1", optionText: "ตัวเลือก ก.", isCorrect: true, sortOrder: "0" },
          { id: null, optionText: "ตัวเลือก ค. ใหม่", isCorrect: false, sortOrder: "2" },
        ],
      }),
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      const newOption = built.body.options[1];
      expect(newOption !== undefined && "id" in newOption).toBe(false);
      expect(built.body.options[0]?.id).toBe("opt-1");
    }
  });

  it("body ตรง QuestionPatchBody — ไม่มี status เด็ดขาด", () => {
    const built = buildQuestionPatchBody(formWith({}));
    if (built.ok) {
      expect("status" in built.body).toBe(false);
      expect(Object.keys(built.body)).toEqual([
        "type",
        "difficulty",
        "questionText",
        "explanation",
        "points",
        "tags",
        "options",
  ]); 
    }
  });

  it("explanation ว่าง → null · มีค่า → ตัดช่องว่าง", () => {
    const empty = buildQuestionPatchBody(formWith({ explanation: "" }));
    if (empty.ok) {
      expect(empty.body.explanation).toBeNull();
    }
    const filled = buildQuestionPatchBody(formWith({ explanation: "  คำอธิบาย  " }));
    if (filled.ok) {
      expect(filled.body.explanation).toBe("คำอธิบาย");
    }
  });

  it("แท็กตัดช่องว่าง และกรองชิ้นว่าง", () => {
    const built = buildQuestionPatchBody(formWith({ tagsText: " a ,  b ,, " }));
    if (built.ok) {
      expect(built.body.tags).toEqual(["a", "b"]);
    }
  });

  it("โจทย์ว่าง/คะแนนนอกช่วง/แท็กเกิน 20 → errors ต่อ path", () => {
    const errors = buildQuestionPatchBody(formWith({ questionText: "" , points: "0" }));
    expect(errors.ok).toBe(false);
    if (!errors.ok) {
      expect(errors.errors["questionText"]).toBeDefined();
      expect(errors.errors["points"]).toBeDefined();
    }
    const tagsError = buildQuestionPatchBody(
      formWith({ tagsText: Array.from({ length: 21 }, (_, index) => `t${index}`).join(",") }),
    );
    if (!tagsError.ok) {
      expect(tagsError.errors["tags"]).toBeDefined();
    }
  });

  it("optionText ว่าง / sortOrder 1000 → errors ต่อ path options.N.*", () => {
    const result = buildQuestionPatchBody(
      formWith({
        options: [
          { id: "opt-1", optionText: "", isCorrect: true, sortOrder: "0" },
          { id: "opt-2", optionText: "ตัวเลือก ข.", isCorrect: false, sortOrder: "1000" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors["options.0.optionText"]).toBeDefined();
      expect(result.errors["options.1.sortOrder"]).toBeDefined();
    }
  });

  it("single_choice ถูก 2 ตัว → error · multiple_choice ถูก ≥1 → ผ่าน", () => {
    const twoCorrect = buildQuestionPatchBody(
      formWith({
        options: [
          { id: "opt-1", optionText: "ก.", isCorrect: true, sortOrder: "0" },
          { id: "opt2", optionText: "ข.", isCorrect: true, sortOrder: "1" },
        ],
      }),
    );
    expect(twoCorrect.ok).toBe(false);
    const multi = buildQuestionPatchBody(
      formWith({
        type: "multiple_choice",
        options: [
          { id: "opt-1", optionText: "ก.", isCorrect: true, sortOrder: "0" },
          { id: "opt-2", optionText: "ข.", isCorrect: true, sortOrder: "1" },
        ],
      }),
    );
    expect(multi.ok).toBe(true);
  });

  it("options ว่าง → error ที่ path options", () => {
    const built = buildQuestionPatchBody(formWith({ options: [] }));
    expect(built.ok).toBe(false);
    if (built.ok === false) {
      expect(built.errors["options"]).toBeDefined();
    }
  });
});

describe("D79 — hint ลบตัวเลือก + จัดการแถวตัวเลือกในฟอร์ม", () => {
  it("hint ประจำปุ่มลบ ตรงตามแผน (D79: ลบไม่ได้)", () => {
    expect(EDIT_OPTIONS_DELETE_HINT).toBe("ลบตัวเลือกยังไม่รองรับ");
  });

  it("addEditOption — เพิ่มแถว id = null · เกิน 10 แถวไม่เพิ่ม", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const withNew = addEditOption(loaded);
    expect(withNew.form?.options.length).toBe(3);
    expect(withNew.form?.options[2]?.id).toBeNull();
    const full = Array.from({ length: 10 }, (_, index) => ({
      id: `o${index}`,
      optionText: `ตัวเลือก ${index}`,
      isCorrect: index === 0,
      sortOrder: String(index),
    }));
    const baseForm = loaded.form;
    expect(baseForm).not.toBeNull();
    if (baseForm !== null) {
      const capped = addEditOption({
        ...loaded,
        form: { ...baseForm, options: full },
      });
      expect(capped.form?.options.length).toBe(10);
    }
  });

  it("updateEditOption — แก้ข้อความ/ลำดับ โดยคง id เดิม (D79)", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const edited = updateEditOption(loaded, 1, { optionText: "แก้แล้ว", sortOrder: "7" });
    expect(edited.form?.options[1]?.id).toBe("opt-2");
    expect(edited.form?.options[1]?.optionText).toBe("แก้แล้ว");
    expect(edited.form?.options[1]?.sortOrder).toBe("7");
  });

  it("markEditSingleCorrect — เลือกถูกตัวเดียว คง id ทุกแถว", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const marked = markEditSingleCorrect(loaded, 1);
    expect(marked.form?.options.filter((option) => option.isCorrect).map((option) => option.id)).toEqual([
      "opt-2",
    ]);
    expect(marked.form?.options.map((option) => option.id)).toEqual(["opt-1", "opt-2"]);
  });

  it("updateEditOption ตอนไม่มีฟอร์ม → ไม่แตะ state", () => {
    expect(updateEditOption(EDIT_MODAL_IDLE, 0, { optionText: "x" })).toEqual(EDIT_MODAL_IDLE);
  });
});

describe("save flow — start/success/error/api validation", () => {
  it("start เฉพาะจาก ready · success เฉพาะจาก saving", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const saving = editModalSaveStart(loaded);
    expect(saving.phase).toBe("saving");
    const saved = editModalSaveSuccess(saving, 4);
    expect(saved.phase).toBe("saved");
    expect(saved.savedVersion).toBe(4);
    expect(editModalSaveStart(EDIT_MODAL_IDLE)).toEqual(EDIT_MODAL_IDLE);
    expect(editModalSaveSuccess(loaded, 4)).toEqual(loaded);
  });

  it("error ของ PATCH อื่น → กลับ ready คงฟอร์ม + ข้อความ", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const saving = editModalSaveStart(loaded);
    const errored = editModalSaveError(saving, "บันทึกไม่สำเร็จชั่วคราว");
    expect(errored.phase).toBe("ready");
    expect(errored.errorMessage).toBe("บันทึกไม่สำเร็จชั่วคราว");
    expect(errored.form).not.toBeNull();
    expect(editModalSaveError(loaded, "x")).toEqual(loaded);
  });

  it("ERR-VAL-001 จาก BFF → แสดงรายการฟิลด์ภาษาไทย และคงฟอร์ม", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const saving = editModalSaveStart(loaded);
    const validated = editModalSaveApiValidation(saving, ["โจทย์ต้องมี 1-8,000 ตัวอักษร"]);
    expect(validated.phase).toBe("ready");
    expect(validated.apiFieldLabels).toEqual(["โจทย์ต้องมี 1-8,000 ตัวอักษร"]);
    expect(validated.form).not.toBeNull();
  });

  it("validation error ฝั่งฟอร์ม → ผูก error ต่อ path (คง phase ready)", () => {
    const loaded = editModalResolveLoad(
      editModalOpenFor("q-1", 1),
      "q-1",
      1,
      { ok: true, resource: RESOURCE_BASE },
    );
    const withErrors = editModalSaveValidationError(loaded, { points: "คะแนนของข้อต้องเป็นตัวเลข 1-100" });
    expect(withErrors.fieldErrors["points"]).toBe("คะแนนของข้อต้องเป็นตัวเลข 1-100");
    expect(withErrors.phase).toBe("ready");
    expect(editModalSaveValidationError(EDIT_MODAL_IDLE, {})).toEqual(EDIT_MODAL_IDLE);
  });

  it("parseSavedVersion — อ่าน version จาก envelope สำเร็จ/ล้มเหลว", () => {
    expect(parseSavedVersion({ data: { id: "q-1", version: 4 } })).toBe(4);
    expect(parseSavedVersion({ data: { version: 0 } })).toBeNull();
    expect(parseSavedVersion({ data: { version: 1.5 } })).toBeNull();
    expect(parseSavedVersion({ data: {} })).toBeNull();
    expect(parseSavedVersion(null)).toBeNull();
  });
});
