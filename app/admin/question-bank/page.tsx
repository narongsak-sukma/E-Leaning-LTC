"use client";

import React, { useState } from "react";
import { Plus, CheckCircle2, HelpCircle } from "lucide-react";
import {
  BackofficeShell,
  useBackofficeData,
} from "@/components/ltc/BackofficeShell";

export default function AdminQuestionBankPage() {
  const { data, feedback, reload, mutate } = useBackofficeData();
  const [selectedBankId, setSelectedBankId] = useState<string>("qb-101");
  const [showAdd, setShowAdd] = useState(false);

  const [questionText, setQuestionText] = useState("");
  const [moduleTitle, setModuleTitle] = useState("โมดูล 1 · หลักกฎหมายทั่วไป");
  const [difficulty, setDifficulty] = useState<"easy" | "medium" | "hard">(
    "medium",
  );
  const [explanation, setExplanation] = useState("");
  const [opt1, setOpt1] = useState("");
  const [opt2, setOpt2] = useState("");
  const [opt3, setOpt3] = useState("");
  const [opt4, setOpt4] = useState("");
  const [correctIdx, setCorrectIdx] = useState(0);

  const banks = data?.questionBanks || [];
  const activeBank =
    banks.find((b: any) => b.id === selectedBankId) || banks[0] || null;

  async function handleAddQuestion(e: React.FormEvent) {
    e.preventDefault();
    if (!activeBank) return;
    const ok = await mutate(
      {
        action: "create_question",
        bankId: activeBank.id,
        questionText,
        moduleTitle,
        difficulty,
        explanation,
        options: [
          { text: opt1, isCorrect: correctIdx === 0 },
          { text: opt2, isCorrect: correctIdx === 1 },
          { text: opt3 || "ตัวเลือกที่ 3", isCorrect: correctIdx === 2 },
          { text: opt4 || "ตัวเลือกที่ 4", isCorrect: correctIdx === 3 },
        ],
      },
      `เพิ่มข้อสอบใหม่ลงในคลัง '${activeBank.title}' เรียบร้อยแล้ว`,
    );
    if (ok) {
      setShowAdd(false);
      setQuestionText("");
      setOpt1("");
      setOpt2("");
      setOpt3("");
      setOpt4("");
      setExplanation("");
    }
  }

  return (
    <BackofficeShell
      title="คลังข้อสอบและเกณฑ์การสอบวัดผล (Question Bank & Assessment Rules)"
      subtitle="บริหารจัดการข้อสอบปรนัย 4 ตัวเลือก เฉลยข้อกฎหมาย และนโยบายการแสดงเฉลยหลังสอบ"
      data={data}
      onRefresh={reload}
    >
      <div className="space-y-6">
        {feedback && (
          <div
            role="alert"
            className={`p-4 rounded-xl text-xs font-semibold border ${
              feedback.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-red-50 border-red-200 text-red-900"
            }`}
          >
            {feedback.message}
          </div>
        )}

        {/* Bank Selector Tabs */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {banks.map((b: any) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedBankId(b.id)}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                  activeBank?.id === b.id
                    ? "bg-[#0b1f3a] text-[#e2b857]"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {b.courseCode} · {b.title} ({b.questionCount} ข้อ)
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowAdd(!showAdd)}
            className="px-4 py-2 rounded-xl bg-[#0b1f3a] text-[#e2b857] text-xs font-bold hover:bg-[#132f54] inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>เพิ่มข้อสอบใหม่ในคลัง</span>
          </button>
        </div>

        {showAdd && activeBank && (
          <form
            onSubmit={handleAddQuestion}
            className="bg-white rounded-2xl border-2 border-[#0b1f3a] p-6 space-y-4"
          >
            <h2 className="text-base font-bold text-[#0b1f3a]">
              เพิ่มข้อสอบปรนัยในคลัง: {activeBank.title}
            </h2>

            <div>
              <label
                htmlFor="qb-qtext"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                โจทย์ข้อสอบ
              </label>
              <input
                id="qb-qtext"
                type="text"
                required
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value)}
                placeholder="ระบุคำถามข้อกฎหมาย..."
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ตัวเลือก ก (ตัวเลือกที่ถูกต้องเริ่มต้น)
                </label>
                <input
                  type="text"
                  required
                  value={opt1}
                  onChange={(e) => setOpt1(e.target.value)}
                  placeholder="ตัวเลือก ก"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ตัวเลือก ข
                </label>
                <input
                  type="text"
                  required
                  value={opt2}
                  onChange={(e) => setOpt2(e.target.value)}
                  placeholder="ตัวเลือก ข"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  ข้อที่เป็นคำตอบที่ถูกต้อง
                </label>
                <select
                  value={correctIdx}
                  onChange={(e) => setCorrectIdx(Number(e.target.value))}
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                >
                  <option value={0}>ตัวเลือก ก</option>
                  <option value={1}>ตัวเลือก ข</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  คำอธิบายข้อกฎหมายประกอบการเฉลย
                </label>
                <input
                  type="text"
                  value={explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  placeholder="เช่น อ้างอิง ป.พ.พ. มาตรา 538"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold cursor-pointer"
              >
                บันทึกข้อสอบเข้าคลัง
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-4 py-2.5 rounded-xl border border-slate-300 text-xs font-semibold text-slate-600 cursor-pointer"
              >
                ยกเลิก
              </button>
            </div>
          </form>
        )}

        {/* Questions List */}
        {activeBank && (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-bold text-[#0b1f3a]">
                  {activeBank.title} ({activeBank.questionCount} ข้อ)
                </h2>
                <p className="text-xs text-slate-500">
                  เกณฑ์ผ่านปลายหลักสูตร:{" "}
                  {activeBank.assessment?.passScorePct ?? 70}% · เวลาสอบ{" "}
                  {activeBank.assessment?.timeLimitMin ?? 60} นาที · โหมดเฉลย:{" "}
                  <code className="font-mono font-bold">
                    {activeBank.assessment?.reviewMode ?? "score_and_correct"}
                  </code>
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {(activeBank.questions || []).map((q: any, idx: number) => (
                <div
                  key={q.id}
                  className="p-5 rounded-xl border border-slate-200 space-y-3"
                >
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-bold text-[#0b1f3a]">
                      ข้อที่ {idx + 1} · {q.moduleTitle}
                    </span>
                    <span className="font-mono">
                      ความยาก: {q.difficulty} · {q.points} คะแนน
                    </span>
                  </div>
                  <div className="text-sm font-bold text-slate-900">
                    {q.questionText}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {q.options.map((opt: any) => (
                      <div
                        key={opt.id}
                        className={`p-2.5 rounded-lg border text-xs flex items-center justify-between ${
                          opt.isCorrect
                            ? "bg-emerald-50 border-emerald-300 text-emerald-950 font-semibold"
                            : "bg-slate-50 border-slate-200 text-slate-700"
                        }`}
                      >
                        <span>{opt.text}</span>
                        {opt.isCorrect && (
                          <span className="text-emerald-700 font-bold">
                            ✓ เฉลย
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-slate-600 bg-[#f0f6fc] p-3 rounded-lg">
                    <strong>คำอธิบายข้อกฎหมาย:</strong> {q.explanation}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </BackofficeShell>
  );
}
