import React from 'react';
import { useApp } from '../context/AppContext';
import { X, Printer, Scale, Award, ShieldCheck, CheckCircle2 } from 'lucide-react';

interface TranscriptModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const TranscriptModal: React.FC<TranscriptModalProps> = ({ isOpen, onClose }) => {
  const { currentUser, creditLedger } = useApp();

  if (!isOpen) return null;

  const totalCredits = currentUser.creditsEarned;
  const ethicsCredits = creditLedger.filter(c => c.category === 'ethics').reduce((s, c) => s + c.credits, 0);
  const substantiveCredits = creditLedger.filter(c => c.category === 'substantive').reduce((s, c) => s + c.credits, 0);
  const proceduralCredits = creditLedger.filter(c => c.category === 'procedural').reduce((s, c) => s + c.credits, 0);
  const emergingTechCredits = creditLedger.filter(c => c.category === 'emerging_tech').reduce((s, c) => s + c.credits, 0);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative bg-white rounded-2xl max-w-4xl w-full overflow-hidden shadow-2xl border border-slate-300">
        {/* Top Control Bar */}
        <div className="bg-slate-900 text-white px-6 py-3 flex items-center justify-between border-b border-slate-800 print:hidden">
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-amber-400" />
            <span className="font-heading font-semibold text-sm">
              ใบทรานสคริปต์สะสมหน่วยกิต (Official CLE Transcript) — สภาทนายความ
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handlePrint}
              className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors shadow-sm"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>พิมพ์เอกสาร (Print Transcript)</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* The Printable Official Transcript Sheet */}
        <div className="p-8 sm:p-12 bg-white text-slate-900 print:p-0">
          {/* Header */}
          <div className="text-center border-b-2 border-slate-900 pb-6 mb-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-slate-900 flex items-center justify-center text-amber-400 mb-3 shadow">
              <Scale className="w-9 h-9" />
            </div>
            <div className="text-xs uppercase tracking-widest text-slate-600 font-semibold mb-1">
              LAWYERS COUNCIL OF THAILAND UNDER THE ROYAL PATRONAGE
            </div>
            <h1 className="font-heading font-bold text-xl sm:text-2xl text-slate-950">
              สภาทนายความ ในพระบรมราชูปถัมภ์
            </h1>
            <div className="text-sm font-semibold text-amber-800 mt-1">
              ใบรายงานผลการศึกษาและสะสมหน่วยกิตวิชาชีพต่อเนื่อง (Continuing Legal Education Transcript)
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              เลขที่เอกสาร: TR-2026-CLE-{Math.floor(10000 + Math.random() * 90000)} · ออก ณ วันที่ 17 ตุลาคม 2569
            </div>
          </div>

          {/* Student Info Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs mb-6">
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">ชื่อ-นามสกุล ผู้ถือใบอนุญาต</span>
              <strong className="text-slate-900 text-sm">{currentUser.name}</strong>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">เลขที่ใบอนุญาตว่าความ</span>
              <strong className="text-amber-800 font-mono text-sm">ท. {currentUser.lawyerLicenseNumber || '4521/2561'}</strong>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">รอบการสะสมหน่วยกิต</span>
              <strong className="text-slate-900 text-sm">{currentUser.currentCycle}</strong>
            </div>
            <div>
              <span className="text-slate-500 block text-[10px] uppercase">สถานะใบอนุญาต</span>
              <span className="inline-flex items-center gap-1 text-emerald-700 font-bold text-xs">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>ปกติ (Active)</span>
              </span>
            </div>
          </div>

          {/* Credit Summary Summary Cards */}
          <div className="grid grid-cols-4 gap-3 text-center mb-6">
            <div className="p-3 border border-slate-200 rounded-lg bg-amber-50/50">
              <div className="text-[10px] text-slate-500 font-medium">จริยธรรมบังคับ (ขั้นต่ำ 6)</div>
              <div className="text-lg font-bold text-amber-800 mt-0.5">{ethicsCredits} น.ก.</div>
            </div>
            <div className="p-3 border border-slate-200 rounded-lg bg-slate-50">
              <div className="text-[10px] text-slate-500 font-medium">กฎหมายสารบัญญัติ</div>
              <div className="text-lg font-bold text-slate-800 mt-0.5">{substantiveCredits} น.ก.</div>
            </div>
            <div className="p-3 border border-slate-200 rounded-lg bg-slate-50">
              <div className="text-[10px] text-slate-500 font-medium">การว่าความ/วิธีสบัญญัติ</div>
              <div className="text-lg font-bold text-slate-800 mt-0.5">{proceduralCredits} น.ก.</div>
            </div>
            <div className="p-3 border border-slate-200 rounded-lg bg-slate-50">
              <div className="text-[10px] text-slate-500 font-medium">เทคโนโลยีกฎหมาย & PDPA</div>
              <div className="text-lg font-bold text-slate-800 mt-0.5">{emergingTechCredits} น.ก.</div>
            </div>
          </div>

          {/* Ledger Table */}
          <div className="border border-slate-300 rounded-lg overflow-hidden mb-6">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-700 border-b border-slate-300 font-bold text-[11px]">
                <tr>
                  <th className="py-2.5 px-3">วันที่</th>
                  <th className="py-2.5 px-3">รายวิชา / กิจกรรมวิชาการ</th>
                  <th className="py-2.5 px-3">หมวดหมู่วิชา</th>
                  <th className="py-2.5 px-3 text-center">หน่วยกิต</th>
                  <th className="py-2.5 px-3">เลขที่วุฒิบัตรรับรอง</th>
                  <th className="py-2.5 px-3 text-center">ผลการประเมิน</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {creditLedger.map((item, idx) => (
                  <tr key={item.id} className="text-[11px]">
                    <td className="py-2 px-3 text-slate-500 whitespace-nowrap">{item.date}</td>
                    <td className="py-2 px-3 font-medium text-slate-900">{item.courseTitle}</td>
                    <td className="py-2 px-3 text-slate-600">
                      {item.category === 'ethics' ? 'จริยธรรม (บังคับ)' : item.category === 'substantive' ? 'สารบัญญัติ' : item.category === 'procedural' ? 'วิธีสบัญญัติ' : 'เทคโนโลยี'}
                    </td>
                    <td className="py-2 px-3 text-center font-bold text-amber-800">+{item.credits}</td>
                    <td className="py-2 px-3 font-mono text-[10px] text-slate-600">{item.certificateNumber || '-'}</td>
                    <td className="py-2 px-3 text-center font-semibold text-emerald-700">ผ่านเกณฑ์ (Pass)</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 font-bold text-xs border-t border-slate-300">
                <tr>
                  <td colSpan={3} className="py-2.5 px-3 text-right">รวมหน่วยกิตสะสมสุทธิ (Total Cumulative Credits):</td>
                  <td className="py-2.5 px-3 text-center text-amber-800 text-sm">+{totalCredits} น.ก.</td>
                  <td colSpan={2} className="py-2.5 px-3 text-emerald-700">
                    {totalCredits >= 30 ? '✓ ครบตามเกณฑ์ต่ออายุใบอนุญาต (30 หน่วยกิต)' : `ขาดอีก ${30 - totalCredits} หน่วยกิต`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Signatures & Certification Seal */}
          <div className="pt-8 border-t border-slate-300 flex items-end justify-between text-xs">
            <div className="space-y-1 text-slate-500 text-[10px]">
              <div>ระบบรับรองคุณวุฒิดิจิทัล สภาทนายความ ในพระบรมราชูปถัมภ์</div>
              <div>สามารถตรวจสอบความถูกต้องได้ที่: https://ltc-elearning.org/verify</div>
              <div>เอกสารนี้ออกโดยระบบอิเล็กทรอนิกส์ที่มีผลสมบูรณ์ตาม พ.ร.บ. ธุรกรรมทางอิเล็กทรอนิกส์</div>
            </div>

            <div className="text-center">
              <div className="font-serif italic font-bold text-slate-800 text-sm mb-1">
                คุณกาญจนา นิติการ
              </div>
              <div className="w-48 border-b border-slate-400 mx-auto mb-1" />
              <div className="font-semibold text-slate-800 text-[11px]">นายทะเบียนสภาทนายความ</div>
              <div className="text-[10px] text-slate-500">สำนักงานทะเบียน สภาทนายความแห่งประเทศไทย</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-3 print:hidden">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg text-xs font-medium"
          >
            ปิดหน้าต่าง
          </button>
          <button
            onClick={handlePrint}
            className="px-5 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-2 shadow"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>พิมพ์รายงาน</span>
          </button>
        </div>
      </div>
    </div>
  );
};
