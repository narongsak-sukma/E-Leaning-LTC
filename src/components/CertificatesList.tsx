import React from 'react';
import { useApp } from '../context/AppContext';
import { Certificate } from '../types';
import { Award, CheckCircle2, Download, ExternalLink, QrCode, FileText } from 'lucide-react';

export const CertificatesList: React.FC<{ onViewCertificate: (cert: Certificate) => void }> = ({
  onViewCertificate,
}) => {
  const { certificates, currentUser, setActiveTab } = useApp();

  const userCertificates = certificates.filter(c => c.userId === currentUser.id);

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full mb-1">
            <Award className="w-3.5 h-3.5" />
            <span>ระบบวุฒิบัตรอิเล็กทรอนิกส์</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-heading font-bold text-slate-900">
            ประกาศนียบัตรและวุฒิบัตรของฉัน ({userCertificates.length} ฉบับ)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            วุฒิบัตรทุกฉบับได้รับการลงนามดิจิทัลและสามารถตรวจสอบความถูกต้องได้แบบสาธารณะ
          </p>
        </div>

        <button
          onClick={() => setActiveTab('verify')}
          className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold flex items-center gap-2 transition-colors shadow-sm"
        >
          <CheckCircle2 className="w-4 h-4 text-amber-400" />
          <span>ตรวจสอบวุฒิบัตรด้วยรหัส</span>
        </button>
      </div>

      {/* Grid of Certificates */}
      {userCertificates.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {userCertificates.map(cert => (
            <div
              key={cert.id}
              className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col justify-between"
            >
              <div className="p-5 border-b border-slate-100 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs font-bold text-amber-800 bg-amber-100/80 px-2.5 py-0.5 rounded">
                    {cert.certificateNumber}
                  </span>
                  <span className="text-[11px] text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    <span>รับรองแล้ว</span>
                  </span>
                </div>

                <h3 className="font-heading font-bold text-base text-slate-900 line-clamp-2">
                  {cert.courseTitle}
                </h3>
              </div>

              <div className="p-5 text-xs space-y-2 text-slate-600">
                <div className="flex justify-between">
                  <span className="text-slate-400">ผู้รับวุฒิบัตร:</span>
                  <span className="font-semibold text-slate-800">{cert.userName}</span>
                </div>
                {cert.lawyerLicenseNumber && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">เลขที่ใบอนุญาต:</span>
                    <span className="font-mono font-medium text-slate-800">ท. {cert.lawyerLicenseNumber}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-400">หน่วยกิตที่ได้รับ:</span>
                  <span className="font-bold text-amber-700">+{cert.creditsAwarded} CLE หน่วยกิต</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">วันที่ออกวุฒิบัตร:</span>
                  <span className="text-slate-700">{cert.issueDate}</span>
                </div>
              </div>

              <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
                <button
                  onClick={() => onViewCertificate(cert)}
                  className="flex-1 py-2 px-3 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors shadow-sm"
                >
                  <Award className="w-3.5 h-3.5" />
                  <span>ดูวุฒิบัตรฉบับเต็ม</span>
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(cert.certificateNumber);
                    alert(`คัดลอกรหัส ${cert.certificateNumber} แล้ว`);
                  }}
                  className="py-2 px-3 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded-lg text-xs font-medium transition-colors"
                  title="คัดลอกรหัสเพื่อส่งตรวจสอบ"
                >
                  คัดลอกรหัส
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <Award className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <h3 className="font-heading font-semibold text-base text-slate-700">ยังไม่มีวุฒิบัตรในบัญชีนี้</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
            เข้าเรียนในหลักสูตรและสอบผ่านเกณฑ์วัดผลเพื่อรับใบประกาศนียบัตรดิจิทัลและสะสมหน่วยกิต
          </p>
          <button
            onClick={() => setActiveTab('catalog')}
            className="mt-4 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold"
          >
            เลือกหลักสูตรเพื่อเริ่มเรียน
          </button>
        </div>
      )}
    </div>
  );
};
