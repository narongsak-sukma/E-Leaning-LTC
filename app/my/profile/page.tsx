"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Save, CheckCircle2 } from "lucide-react";
import { LearnerShell } from "@/components/ltc/LearnerShell";

export default function LearnerProfilePage() {
  const [data, setData] = useState<any>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const res = await fetch("/api/v1/learner");
    if (res.ok) {
      const d = await res.json();
      setData(d);
      setFirstName(d.user?.firstName || "");
      setLastName(d.user?.lastName || "");
      setPhone(d.user?.phone || "");
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSavedMsg(null);
    const res = await fetch("/api/v1/learner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_profile",
        firstName,
        lastName,
        phone,
      }),
    });
    if (res.ok) {
      setSavedMsg("บันทึกข้อมูลโปรไฟล์และชื่อที่จะปรากฏบนประกาศนียบัตรเรียบร้อยแล้ว");
      await loadData();
    }
  }

  return (
    <LearnerShell
      user={data?.user ?? null}
      roles={data?.roles ?? []}
      verifiedLicense={data?.verifiedLicense ?? null}
      netCredits={data?.creditMeter?.netCredits ?? 0}
      requiredCredits={data?.creditMeter?.requiredCredits ?? 12}
    >
      <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 space-y-6">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-[#7a5b14]">
            PROFILE & PDPA CONSENT · ข้อมูลส่วนบุคคลและการตั้งค่า
          </div>
          <h1 className="text-2xl font-bold text-[#0b1f3a] mt-1">
            ข้อมูลผู้เรียนสำหรับออกประกาศนียบัตรดิจิทัล
          </h1>
        </div>

        {savedMsg && (
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700" />
            <span>{savedMsg}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4 max-w-xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="prof-first"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                ชื่อจริง (ปรากฏบนใบประกาศ)
              </label>
              <input
                id="prof-first"
                type="text"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="prof-last"
                className="block text-xs font-semibold text-slate-700 mb-1"
              >
                นามสกุล
              </label>
              <input
                id="prof-last"
                type="text"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="prof-phone"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              เบอร์โทรศัพท์ติดต่อ
            </label>
            <input
              id="prof-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm"
            />
          </div>

          <button
            type="submit"
            className="px-5 py-2.5 rounded-xl bg-[#0b1f3a] text-white text-xs font-semibold hover:bg-[#132f54] inline-flex items-center gap-2 cursor-pointer"
          >
            <Save className="w-4 h-4 text-[#e2b857]" />
            <span>บันทึกข้อมูลส่วนตัว</span>
          </button>
        </form>
      </div>
    </LearnerShell>
  );
}
