import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  CreditCard, 
  Award, 
  CheckCircle2, 
  Clock, 
  Calendar, 
  ShieldCheck, 
  Printer, 
  FileCheck, 
  AlertCircle,
  ExternalLink,
  Download,
  Scale,
  Sparkles
} from 'lucide-react';
import { Certificate } from '../types';
import { TranscriptModal } from './TranscriptModal';

export const CreditBank: React.FC<{ onViewCertificate: (cert: Certificate) => void }> = ({ onViewCertificate }) => {
  const { currentUser, creditLedger, certificates, setActiveTab } = useApp();
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [showRenewalModal, setShowRenewalModal] = useState(false);
  const [renewalSubmitted, setRenewalSubmitted] = useState(false);
  const [showTranscriptModal, setShowTranscriptModal] = useState(false);

  // User credit metrics
  const targetCredits = currentUser.creditsRequired || 30;
  const earnedCredits = currentUser.creditsEarned || 0;
  const progressPercent = Math.min(100, Math.round((earnedCredits / targetCredits) * 100));
  const isEligibleForRenewal = earnedCredits >= targetCredits;

  // Calculate credits per category
  const ethicsCredits = creditLedger
    .filter(c => c.category === 'ethics')
    .reduce((sum, c) => sum + c.credits, 0);

  const substantiveCredits = creditLedger
    .filter(c => c.category === 'substantive')
    .reduce((sum, c) => sum + c.credits, 0);

  const proceduralCredits = creditLedger
    .filter(c => c.category === 'procedural')
    .reduce((sum, c) => sum + c.credits, 0);

  const emergingTechCredits = creditLedger
    .filter(c => c.category === 'emerging_tech')
    .reduce((sum, c) => sum + c.credits, 0);

  const filteredLedger = filterCategory === 'all'
    ? creditLedger
    : creditLedger.filter(c => c.category === filterCategory);

  const handlePrintTranscript = () => {
    setShowTranscriptModal(true);
  };

  const handleFindCert = (certNo?: string) => {
    if (!certNo) return;
    const cert = certificates.find(c => c.certificateNumber === certNo);
    if (cert) {
      onViewCertificate(cert);
    } else {
      setActiveTab('verify');
    }
  };

  return (
    <div className="space-y-8 pb-16">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-amber-950 border border-slate-800 rounded-2xl p-6 sm:p-8 text-white shadow-xl">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="bg-amber-500 text-slate-950 text-xs font-bold px-2.5 py-0.5 rounded">
                LTC CREDIT BANK
              </span>
              <span className="text-xs text-amber-300 font-semibold flex items-center gap-1">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>สถานะใบอนุญาต: ยืนยันแล้ว (Active)</span>
              </span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-heading font-bold text-white">
              ธนาคารหน่วยกิต (Credit Bank) เพื่อการต่ออายุใบอนุญาต
            </h1>
            <p className="text-xs sm:text-sm text-slate-300">
              ทนายความ: <strong className="text-white">{currentUser.name}</strong> · เลขที่ใบอนุญาตว่าความ: <strong className="text-amber-300">ท. {currentUser.lawyerLicenseNumber || '4521/2561'}</strong> · {currentUser.currentCycle}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handlePrintTranscript}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-medium flex items-center gap-2 transition-colors"
            >
              <Printer className="w-4 h-4" />
              <span>พิมพ์ใบทรานสคริปต์ (Transcript)</span>
            </button>

            <button
              onClick={() => setShowRenewalModal(true)}
              className={`px-5 py-2 rounded-xl text-xs font-bold flex items-center gap-2 shadow-md transition-all ${
                isEligibleForRenewal
                  ? 'bg-amber-500 hover:bg-amber-600 text-slate-950'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              <FileCheck className="w-4 h-4" />
              <span>ยื่นคำขอต่ออายุใบอนุญาต</span>
            </button>
          </div>
        </div>

        {/* Big Progress Meter */}
        <div className="mt-8 bg-slate-900/80 border border-slate-800 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <span className="text-xs font-semibold text-slate-300">
              ความคืบหน้าการสะสมหน่วยกิตรวมในรอบ 3 ปี (เกณฑ์มาตรฐาน 30 หน่วยกิต)
            </span>
            <span className="text-sm font-bold text-amber-400">
              {earnedCredits} / {targetCredits} หน่วยกิต ({progressPercent}%)
            </span>
          </div>

          <div className="w-full bg-slate-800 rounded-full h-3.5 overflow-hidden p-0.5 border border-slate-700">
            <div 
              className="bg-gradient-to-r from-amber-500 to-yellow-400 h-full rounded-full transition-all duration-700 shadow-sm"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          <div className="flex items-center justify-between mt-2 text-[11px] text-slate-400">
            <span>
              {isEligibleForRenewal ? (
                <span className="text-emerald-400 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>หน่วยกิตครบตามเกณฑ์มาตรฐาน พร้อมยื่นต่ออายุใบอนุญาตได้ทันที</span>
                </span>
              ) : (
                <span>ต้องการอีก {targetCredits - earnedCredits} หน่วยกิต เพื่อต่อใบอนุญาตว่าความ</span>
              )}
            </span>
            <span>วันหมดอายุรอบปัจจุบัน: {currentUser.licenseExpiryDate || '31 ธ.ค. 2570'}</span>
          </div>
        </div>
      </div>

      {/* Category Breakdown Cards */}
      <div>
        <h2 className="text-base font-heading font-bold text-slate-900 mb-4 flex items-center gap-2">
          <Award className="w-5 h-5 text-amber-600" />
          <span>รายละเอียดหน่วยกิตแยกตามหมวดหมู่วิชา (Curriculum Categories)</span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Ethics */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span className="font-semibold text-amber-800 bg-amber-50 px-2 py-0.5 rounded">
                ★ วิชาบังคับ
              </span>
              <span className="font-bold text-slate-700">{ethicsCredits} / 6 น.ก.</span>
            </div>
            <h3 className="font-heading font-bold text-sm text-slate-900 mb-1">
              จริยธรรมและมรรยาททนายความ
            </h3>
            <p className="text-[11px] text-slate-500 mb-3">
              เกณฑ์บังคับขั้นต่ำ 6 หน่วยกิตต่อรอบ
            </p>
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div 
                className="bg-amber-600 h-full rounded-full" 
                style={{ width: `${Math.min(100, (ethicsCredits / 6) * 100)}%` }} 
              />
            </div>
          </div>

          {/* Substantive */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span className="font-semibold text-blue-800 bg-blue-50 px-2 py-0.5 rounded">
                สารบัญญัติ
              </span>
              <span className="font-bold text-slate-700">{substantiveCredits} / 10 น.ก.</span>
            </div>
            <h3 className="font-heading font-bold text-sm text-slate-900 mb-1">
              กฎหมายสารบัญญัติ (แพ่ง/อาญา)
            </h3>
            <p className="text-[11px] text-slate-500 mb-3">
              เกณฑ์แนะนำ 10 หน่วยกิต
            </p>
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div 
                className="bg-blue-600 h-full rounded-full" 
                style={{ width: `${Math.min(100, (substantiveCredits / 10) * 100)}%` }} 
              />
            </div>
          </div>

          {/* Procedural */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span className="font-semibold text-indigo-800 bg-indigo-50 px-2 py-0.5 rounded">
                วิธีสบัญญัติ
              </span>
              <span className="font-bold text-slate-700">{proceduralCredits} / 8 น.ก.</span>
            </div>
            <h3 className="font-heading font-bold text-sm text-slate-900 mb-1">
              การว่าความและวิธีพิจารณา
            </h3>
            <p className="text-[11px] text-slate-500 mb-3">
              เกณฑ์แนะนำ 8 หน่วยกิต
            </p>
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div 
                className="bg-indigo-600 h-full rounded-full" 
                style={{ width: `${Math.min(100, (proceduralCredits / 8) * 100)}%` }} 
              />
            </div>
          </div>

          {/* Tech & Special */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
              <span className="font-semibold text-purple-800 bg-purple-50 px-2 py-0.5 rounded">
                นวัตกรรม & PDPA
              </span>
              <span className="font-bold text-slate-700">{emergingTechCredits} / 6 น.ก.</span>
            </div>
            <h3 className="font-heading font-bold text-sm text-slate-900 mb-1">
              เทคโนโลยีกฎหมาย & PDPA
            </h3>
            <p className="text-[11px] text-slate-500 mb-3">
              เกณฑ์แนะนำ 6 หน่วยกิต
            </p>
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div 
                className="bg-purple-600 h-full rounded-full" 
                style={{ width: `${Math.min(100, (emergingTechCredits / 6) * 100)}%` }} 
              />
            </div>
          </div>
        </div>
      </div>

      {/* Credit Ledger Table (Immutable) */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-heading font-bold text-sm text-slate-900">
              สมุดบัญชีหน่วยกิตสะสม (Immutable Credit Ledger)
            </h3>
            <p className="text-[11px] text-slate-500">
              บันทึกแบบ Append-only ได้รับการรับรองทางทะเบียนโดยสภาทนายความ
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setFilterCategory('all')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${filterCategory === 'all' ? 'bg-slate-900 text-white' : 'bg-white border text-slate-600'}`}
            >
              ทั้งหมด
            </button>
            <button
              onClick={() => setFilterCategory('ethics')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${filterCategory === 'ethics' ? 'bg-slate-900 text-white' : 'bg-white border text-slate-600'}`}
            >
              จริยธรรม
            </button>
            <button
              onClick={() => setFilterCategory('substantive')}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${filterCategory === 'substantive' ? 'bg-slate-900 text-white' : 'bg-white border text-slate-600'}`}
            >
              สารบัญญัติ
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-100 text-slate-600 border-b border-slate-200 uppercase font-semibold text-[10px]">
              <tr>
                <th className="py-3 px-4">วันที่บันทึก</th>
                <th className="py-3 px-4">หลักสูตร / กิจกรรมวิชาการ</th>
                <th className="py-3 px-4">ประเภท</th>
                <th className="py-3 px-4 text-center">หน่วยกิต</th>
                <th className="py-3 px-4">เลขที่วุฒิบัตร</th>
                <th className="py-3 px-4">ผู้อนุมัติ</th>
                <th className="py-3 px-4 text-center">สถานะ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredLedger.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-3 px-4 text-slate-500 whitespace-nowrap">{item.date}</td>
                  <td className="py-3 px-4 font-medium text-slate-900">
                    <div>{item.courseTitle}</div>
                  </td>
                  <td className="py-3 px-4 text-slate-600">
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-medium">
                      {item.type === 'course_cle' ? 'หลักสูตรออนไลน์' : item.type === 'seminar' ? 'สัมมนาวิชาการ' : 'ปรับยอดทางทะเบียน'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-center font-bold text-amber-700">
                    +{item.credits}
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px] text-slate-600">
                    {item.certificateNumber ? (
                      <button
                        onClick={() => handleFindCert(item.certificateNumber)}
                        className="text-amber-700 hover:underline flex items-center gap-1 font-semibold"
                      >
                        <span>{item.certificateNumber}</span>
                        <ExternalLink className="w-3 h-3" />
                      </button>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-slate-600 text-[11px]">{item.approvedBy}</td>
                  <td className="py-3 px-4 text-center">
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      <span>อนุมัติแล้ว</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* License Renewal Modal */}
      {showRenewalModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200">
            {!renewalSubmitted ? (
              <div>
                <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mx-auto mb-4">
                  <Scale className="w-6 h-6" />
                </div>
                <h3 className="font-heading font-bold text-lg text-center text-slate-900">
                  ยื่นคำขอต่ออายุใบอนุญาตว่าความออนไลน์
                </h3>
                <p className="text-xs text-center text-slate-600 mt-1 mb-4">
                  สภาทนายความ ในพระบรมราชูปถัมภ์ (ฝ่ายทะเบียนทนายความ)
                </p>

                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs space-y-2 mb-4">
                  <div className="flex justify-between">
                    <span className="text-slate-500">ผู้ยื่นคำขอ:</span>
                    <span className="font-semibold text-slate-800">{currentUser.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">เลขที่ใบอนุญาต:</span>
                    <span className="font-mono font-bold text-amber-700">ท. {currentUser.lawyerLicenseNumber || '4521/2561'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">หน่วยกิตสะสมในระบบ:</span>
                    <span className="font-bold text-emerald-700">{earnedCredits} หน่วยกิต (เกณฑ์ขั้นต่ำ 30)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">วิชาจริยธรรมและมรรยาท:</span>
                    <span className="font-semibold text-slate-800">{ethicsCredits} หน่วยกิต (ผ่านเกณฑ์)</span>
                  </div>
                </div>

                <div className="text-[11px] text-slate-500 bg-amber-50/80 p-3 rounded-lg border border-amber-200 text-amber-950 mb-6">
                  หมายเหตุ: เมื่อยื่นคำขอแล้ว ระบบจะส่งรายงาน Credit Bank Transcript เข้าสู่ระบบนายทะเบียนสภาทนายความเพื่อตรวจสอบและออกใบอนุญาตฉบับใหม่
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setShowRenewalModal(false)}
                    className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold"
                  >
                    ยกเลิก
                  </button>
                  <button
                    onClick={() => setRenewalSubmitted(true)}
                    className="flex-1 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-bold shadow-sm"
                  >
                    ยืนยันการยื่นคำขอ
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-3">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <h3 className="font-heading font-bold text-lg text-slate-900">
                  ยื่นคำขอต่ออายุใบอนุญาตสำเร็จ
                </h3>
                <p className="text-xs text-slate-600 mt-2 max-w-sm mx-auto">
                  ระบบได้ส่งข้อมูล Credit Bank ไปยังสำนักงานทะเบียนสภาทนายความเรียบร้อยแล้ว เลขที่รับคำขอ: <strong>REQ-2026-RNW-0941</strong>
                </p>
                <button
                  onClick={() => {
                    setShowRenewalModal(false);
                    setRenewalSubmitted(false);
                  }}
                  className="mt-6 px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold"
                >
                  ปิดหน้าต่าง
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Transcript Modal */}
      <TranscriptModal
        isOpen={showTranscriptModal}
        onClose={() => setShowTranscriptModal(false)}
      />
    </div>
  );
};
