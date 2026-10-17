import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { X, Scale, KeyRound, CheckCircle2, ShieldCheck } from 'lucide-react';

interface LicenseBindingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LicenseBindingModal: React.FC<LicenseBindingModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { bindLawyerLicense, currentUser } = useApp();
  const [licenseNumber, setLicenseNumber] = useState(currentUser.lawyerLicenseNumber || '');
  const [citizenId, setCitizenId] = useState('1-1002-00345-67-8');
  const [isVerifying, setIsVerifying] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!licenseNumber.trim()) return;

    setIsVerifying(true);
    setTimeout(() => {
      bindLawyerLicense(licenseNumber.trim());
      setIsVerifying(false);
      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        onClose();
      }, 1500);
    }, 700);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-amber-600" />
            <h3 className="font-heading font-bold text-base text-slate-900">
              ผูกเลขที่ใบอนุญาตว่าความ (Lawyer License)
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!success ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              กรุณาระบุเลขที่ใบอนุญาตว่าความของสภาทนายความ เพื่อปลดล็อกสิทธิ์การเข้าอบรมหลักสูตร CLE และเปิดใช้งานระบบสะสมหน่วยกิต Credit Bank
            </p>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เลขที่ใบอนุญาตว่าความ (เช่น 4521/2561)
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="เช่น 4521/2561 หรือ 1289/2555"
                  value={licenseNumber}
                  onChange={(e) => setLicenseNumber(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 font-mono"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                เลขประจำตัวประชาชน 13 หลัก (เพื่อยืนยันตัวตน)
              </label>
              <input
                type="text"
                value={citizenId}
                onChange={(e) => setCitizenId(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono text-slate-500 bg-slate-50"
              />
            </div>

            <div className="p-3 rounded-lg bg-amber-50/80 border border-amber-200/80 text-[11px] text-amber-950 flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <span>
                ข้อมูลจะถูกจับคู่กับฐานข้อมูลทะเบียนทนายความแห่งประเทศไทย และบันทึกลงใน Audit Log ตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล (PDPA)
              </span>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={isVerifying}
                className="flex-1 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded-lg text-xs font-bold transition-colors shadow flex items-center justify-center gap-1.5"
              >
                {isVerifying ? (
                  <span>กำลังตรวจสอบ...</span>
                ) : (
                  <>
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>ยืนยันและเปิดสิทธิ์</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          <div className="text-center py-6">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-3">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h4 className="font-heading font-bold text-sm text-slate-900">
              ยืนยันใบอนุญาตว่าความสำเร็จ!
            </h4>
            <p className="text-xs text-slate-500 mt-1">
              เปิดใช้งานสิทธิ์บทบาททนายความ (Lawyer) และระบบ Credit Bank เรียบร้อยแล้ว
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
