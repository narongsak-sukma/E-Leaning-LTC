import React from 'react';
import { Certificate } from '../types';
import { 
  X, 
  Printer, 
  Download, 
  CheckCircle2, 
  Scale, 
  Award, 
  QrCode, 
  Share2, 
  Copy, 
  ExternalLink 
} from 'lucide-react';

interface CertificateModalProps {
  certificate: Certificate | null;
  onClose: () => void;
}

export const CertificateModal: React.FC<CertificateModalProps> = ({
  certificate,
  onClose,
}) => {
  if (!certificate) return null;

  const handlePrint = () => {
    window.print();
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(certificate.certificateNumber);
    alert(`คัดลอกรหัสวุฒิบัตร ${certificate.certificateNumber} เรียบร้อยแล้ว`);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative bg-white rounded-2xl max-w-4xl w-full overflow-hidden shadow-2xl border border-slate-300">
        {/* Top Control Bar */}
        <div className="bg-slate-900 text-white px-6 py-3.5 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Award className="w-5 h-5 text-amber-400" />
            <span className="font-heading font-semibold text-sm">
              วุฒิบัตรอิเล็กทรอนิกส์ (Digital Certificate) — สภาทนายความ ในพระบรมราชูปถัมภ์
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handlePrint}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>พิมพ์วุฒิบัตร</span>
            </button>
            <button
              onClick={handleCopyCode}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>คัดลอกรหัส</span>
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* The Printable Certificate Container */}
        <div className="p-8 sm:p-12 bg-amber-50/20 print:p-0 print:bg-white flex items-center justify-center">
          <div className="w-full bg-white border-[10px] border-double border-amber-700/60 p-8 sm:p-14 rounded-lg shadow-xl relative overflow-hidden text-center">
            {/* Corner Decorative Ornaments */}
            <div className="absolute top-3 left-3 w-8 h-8 border-t-2 border-l-2 border-amber-600" />
            <div className="absolute top-3 right-3 w-8 h-8 border-t-2 border-r-2 border-amber-600" />
            <div className="absolute bottom-3 left-3 w-8 h-8 border-b-2 border-l-2 border-amber-600" />
            <div className="absolute bottom-3 right-3 w-8 h-8 border-b-2 border-r-2 border-amber-600" />

            {/* Emblem / Seal */}
            <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-amber-600 to-amber-800 flex items-center justify-center shadow-md mb-4 border-2 border-amber-400 text-white">
              <Scale className="w-10 h-10" />
            </div>

            <div className="text-amber-800 text-xs font-semibold tracking-widest uppercase mb-1">
              LAWYERS COUNCIL OF THAILAND UNDER THE ROYAL PATRONAGE
            </div>
            <h1 className="font-heading font-bold text-xl sm:text-2xl text-slate-900 tracking-wide mb-1">
              สภาทนายความ ในพระบรมราชูปถัมภ์
            </h1>
            <p className="text-xs text-slate-500 mb-6 font-serif italic">
              วุฒิบัตรรับรองการพัฒนาวิชาชีพทางกฎหมายต่อเนื่อง (Certificate of Continuing Legal Education)
            </p>

            <div className="text-xs text-slate-600 mb-2">
              วุฒิบัตรฉบับนี้ให้ไว้เพื่อแสดงว่า
            </div>

            <div className="text-2xl sm:text-3xl font-heading font-bold text-slate-900 mb-2 border-b-2 border-amber-500/40 pb-2 inline-block px-8">
              {certificate.userName}
            </div>

            {certificate.lawyerLicenseNumber && (
              <div className="text-xs text-amber-900 font-semibold mb-4">
                ทนายความผู้มีใบอนุญาตว่าความ เลขที่ {certificate.lawyerLicenseNumber}
              </div>
            )}

            <div className="text-xs text-slate-600 mb-2 max-w-xl mx-auto leading-relaxed">
              ได้ผ่านการฝึกอบรมและสอบวัดผลตามมาตรฐานหลักสูตรพัฒนาวิชาชีพทางกฎหมายต่อเนื่อง
            </div>

            <div className="text-lg sm:text-xl font-heading font-bold text-amber-900 mb-4 px-4 py-1.5 bg-amber-50/80 rounded-lg inline-block border border-amber-200">
              « {certificate.courseTitle} »
            </div>

            <div className="flex items-center justify-center gap-6 text-xs text-slate-700 font-medium mb-8">
              <span className="flex items-center gap-1.5">
                <Award className="w-4 h-4 text-amber-600" />
                <span>ได้รับการรับรอง: <strong>+{certificate.creditsAwarded} CLE หน่วยกิต</strong></span>
              </span>
              <span>•</span>
              <span>วันที่ออกวุฒิบัตร: <strong>{certificate.issueDate}</strong></span>
            </div>

            {/* Bottom Row: Signatures and QR Code */}
            <div className="pt-6 border-t border-slate-200 flex flex-wrap items-end justify-between gap-6 text-left">
              {/* QR Verification */}
              <div className="flex items-center gap-3">
                {/* SVG QR Code generator */}
                <div className="w-16 h-16 bg-slate-900 p-1.5 rounded-lg border border-slate-800 text-white flex flex-col items-center justify-center shadow-inner">
                  <QrCode className="w-10 h-10 text-amber-400" />
                  <span className="text-[8px] font-mono text-slate-300">SCAN VERIFY</span>
                </div>
                <div className="text-[11px]">
                  <div className="font-semibold text-slate-900">รหัสตรวจสอบวุฒิบัตร:</div>
                  <div className="font-mono font-bold text-amber-800">{certificate.certificateNumber}</div>
                  <div className="text-[10px] text-emerald-600 flex items-center gap-0.5 mt-0.5">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>สถานะ: ถูกต้องสมบูรณ์ (Valid)</span>
                  </div>
                </div>
              </div>

              {/* Signatures */}
              <div className="flex items-center gap-8 text-center text-xs">
                <div>
                  <div className="font-serif italic font-bold text-slate-800 mb-1">
                    ศ.ดร. นันทิวัฒน์ ธรรมาภิบาล
                  </div>
                  <div className="w-32 border-b border-slate-400 mx-auto mb-1" />
                  <div className="text-[10px] text-slate-500">นายกสภาทนายความ</div>
                </div>

                <div>
                  <div className="font-serif italic font-bold text-slate-800 mb-1">
                    {certificate.signatureRegistrar}
                  </div>
                  <div className="w-32 border-b border-slate-400 mx-auto mb-1" />
                  <div className="text-[10px] text-slate-500">นายทะเบียนสภาทนายความ</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span>
            ระบบตรวจสอบวุฒิบัตรสาธารณะ: https://ltc-elearning.org/verify?code={certificate.certificateNumber}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-medium transition-colors"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>
  );
};
