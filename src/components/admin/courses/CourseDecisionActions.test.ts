/**
 * unit tests — courses/CourseDecisionActions (Wave E Phase 5 · lane F · handoff)
 * pure helpers: return comment >= 10 · body/path per endpoint · buttons per status
 */
import { describe, expect, it } from "vitest";

import {
  buildCourseDecisionBody,
  courseActionPath,
  courseActionsForStatus,
  courseReturnCommentValid,
  COURSE_RETURN_COMMENT_MIN_LENGTH,
} from "./CourseDecisionActions";

describe("courseReturnCommentValid", () => {
  it("trim >= 10 -> true, short/blank -> false", () => {
    expect(courseReturnCommentValid("โครงสร้างหน่วยการเรียนยังขาดหน่วยที่ 3 โปรดเพิ่ม")).toBe(true);
    expect(courseReturnCommentValid("   โครงสร้างยังขาด   ")).toBe(true);
    expect(courseReturnCommentValid("สั้นเกิน")).toBe(false);
    expect(courseReturnCommentValid("          ")).toBe(false);
    expect(COURSE_RETURN_COMMENT_MIN_LENGTH).toBe(10);
  });
});

describe("buildCourseDecisionBody", () => {
  it("return trims comment, publish/unpublish no comment key", () => {
    expect(buildCourseDecisionBody("return", "  โครงสร้างยังขาดหน่วยที่ 3  ")).toEqual({
      action: "return",
      comment: "โครงสร้างยังขาดหน่วยที่ 3",
    });
    expect(buildCourseDecisionBody("publish", "")).toEqual({ action: "publish" });
    expect(buildCourseDecisionBody("unpublish", "")).toEqual({ action: "unpublish" });
    expect(Object.keys(buildCourseDecisionBody("publish", "x")).includes("comment")).toBe(false);
  });
});

describe("courseActionPath", () => {
  it("encodes id", () => {
    expect(courseActionPath("c 1")).toBe("/api/v1/admin/courses/c%201");
  });
});

describe("courseActionsForStatus", () => {
  it("draft/pending_review -> publish+return", () => {
    expect(courseActionsForStatus("draft")).toEqual(["publish", "return"]);
    expect(courseActionsForStatus("pending_review")).toEqual(["publish", "return"]);
  });
  it("published -> unpublish only · archived/unknown -> none", () => {
    expect(courseActionsForStatus("published")).toEqual(["unpublish"]);
    expect(courseActionsForStatus("archived")).toEqual([]);
    expect(courseActionsForStatus("frozen")).toEqual([]);
  });
});
