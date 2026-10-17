import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Certificate } from '../types';
import { 
  CheckCircle2, 
  XCircle, 
  Search, 
  ShieldCheck, 
  Award, 
  Calendar, 
  Scale, 
  QrCode,
  FileCheck2
} from 'lucide-react';

export const VerifyCertificate: React.FC<{ onViewCertificate: (cert: Certificate) => void }> = ({
  onViewCertificate,
}) => {
  const { verifyCertificateCode, certificates } = useApp();
  const [inputCode, setInputCode] = useState('');
  const [searched, setSearched] = useState(false);
  const [resultCert, setResultCert] = useState<Certificate | null>(null);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCode.trim()) return;

    const cert = verifyCertificateCode(inputCode.trim());
    setResultCert(cert);
    setSearched(true);
  };

  const handleQuickTest = (code: string) => {
    setInputCode(code);
    const cert = verifyCertificateCode(code);
    setResultCert(cert);
    setSearched(true);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8 pb-16">
      {/* Header Card */}
      <div className="text-center space-y-3">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-amber-700 text-slate-950 flex items-center justify-center mx-auto shadow-lg border border-amber-400/40">
          <ShieldCheck className="w-8 h-8" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-heading font-bold text-slate-900">
          ระบบตรวจสอบความถูกต้องวุฒิบัตร (Public Certificate Verification)
        </h1>
        <p className="text-xs sm:text-sm text-slate-600 max-w-xl mx-auto leading-relaxed">
          บริการสาธารณะสำหรับประชาชน ศาล และหน่วยงานภายนอก ในการตรวจสอบความถูกต้องแท้จริงของวุฒิบัตรและชั่วโมงการพัฒนาวิชาชีพของทนายความ สภาทนายความ ในพระบรมราชูปถัมภ์
        </p>
      </div>

      {/* Verification Search Box */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm">
        <form onSubmit={handleSearch} className="space-y-4">
          <label className="block text-xs font-bold text-slate-700">
            กรอกรหัสวุฒิบัตร (Certificate Code) หรือสแกน QR Code
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="ตัวอย่างเช่น: LTC-2025-CLE-04821"
                value={inputCode}
                onChange={(e) => setInputCode(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 text-slate-900 uppercase"
              />
            </div>
            <button
              type="submit"
              className="px-6 py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors shadow flex items-center justify-center gap-2"
            >
              <FileCheck2 className="w-4 h-4 text-amber-400" />
              <span>ตรวจสอบข้อมูล</span>
            </button>
          </div>
        </form>

        {/* Quick Test Chips */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-400">ทดสอบรหัสตัวอย่าง:</span>
          {certificates.slice(0, 3).map(c => (
            <button
              key={c.id}
              onClick={() => handleQuickTest(c.certificateNumber)}
              className="text-[11px] font-mono bg-slate-100 hover:bg-amber-100 text-slate-700 hover:text-amber-800 px-2 py-0.5 rounded transition-colors"
            >
              {c.certificateNumber}
            </button>
          ))}
        </div>
      </div>

      {/* Result Display */}
      {searched && (
        <div className="animate-in fade-in slide-in-from-top-4 duration-300">
          {resultCert ? (
            <div className="bg-white rounded-2xl border-2 border-emerald-500 p-6 sm:p-8 shadow-lg overflow-hidden relative">
              <div className="absolute top-0 right-0 bg-emerald-500 text-white text-[11px] font-bold px-4 py-1 rounded-bl-xl flex items-center gap-1 shadow-sm">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>สถานะ: วุฒิบัตรถูกต้องแท้จริง</span>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                  <Award className="w-7 h-7" />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-mono font-bold text-amber-800">
                    รหัสวุฒิบัตร: {resultCert.certificateNumber}
                  </div>
                  <h3 className="font-heading font-bold text-lg text-slate-900">
                    {resultCert.courseTitle}
                  </h3>
                  <div className="text-xs text-slate-500">
                    ออกโดย: สภาทนายความ ในพระบรมราชูปถัมภ์ (ฝ่ายพัฒนาวิชาชีพต่อเนื่อง)
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs">
                <div>
                  <span className="text-slate-400">ผู้ได้รับวุฒิบัตร:</span>
                  <div className="font-semibold text-slate-900 text-sm mt-0.5">{resultCert.userName}</div>
                </div>

                {resultCert.lawyerLicenseNumber && (
                  <div>
                    <span className="text-slate-400">เลขที่ใบอนุญาตว่าความ:</span>
                    <div className="font-mono font-semibold text-amber-800 text-sm mt-0.5">
                      ท. {resultCert.lawyerLicenseNumber}
                    </div>
                  </div>
                )}

                <div>
                  <span className="text-slate-400">หน่วยกิตที่ผ่านการรับรอง:</span>
                  <div className="font-bold text-emerald-700 text-sm mt-0.5">
                    +{resultCert.creditsAwarded} CLE หน่วยกิต
                  </div>
                </div>

                <div>
                  <span className="text-slate-400">วันที่ออกวุฒิบัตร:</span>
                  <div className="font-semibold text-slate-800 text-sm mt-0.5">{resultCert.issueDate}</div>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-4 pt-4 border-t border-slate-200">
                <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <Scale className="w-4 h-4 text-amber-600" />
                  <span>นายทะเบียนรับรอง: {resultCert.signatureRegistrar}</span>
                </div>

                <button
                  onClick={() => onViewCertificate(resultCert)}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors shadow-sm"
                >
                  <Award className="w-4 h-4" />
                  <span>แสดงใบประกาศนียบัตรฉบับเต็ม</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border-2 border-rose-400 p-8 text-center shadow-lg">
              <div className="w-14 h-14 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center mx-auto mb-3">
                <XCircle className="w-8 h-8" />
              </div>
              <h3 className="font-heading font-bold text-lg text-slate-900">
                ไม่พบข้อมูลวุฒิบัตรในระบบทะเบียน
              </h3>
              <p className="text-xs text-slate-600 mt-2 max-w-md mx-auto">
                รหัสวุฒิบัตร <strong>"{inputCode}"</strong> อาจไม่ถูกต้อง หรือยังไม่ได้รับการอนุมัติจากนายทะเบียน กรุณาตรวจสอบตัวอักษรพิมพ์ใหญ่-เล็กและลองใหม่อีกครั้ง
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
