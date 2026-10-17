import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Shield, KeyRound, Sparkles, AlertCircle, CheckCircle } from 'lucide-react';
import { RoleType } from '../types';

export const PersonaBanner: React.FC<{ onOpenLicenseModal: () => void }> = ({ onOpenLicenseModal }) => {
  const { currentUser, switchPersona } = useApp();
  const [expanded, setExpanded] = useState(false);

  const getRoleBadge = (role: RoleType) => {
    switch (role) {
      case 'lawyer':
        return { label: 'ทนายความ (CLE)', color: 'bg-amber-500 text-slate-950 font-semibold' };
      case 'citizen':
        return { label: 'ประชาชนทั่วไป', color: 'bg-blue-600 text-white' };
      case 'instructor':
        return { label: 'วิทยากร', color: 'bg-purple-600 text-white' };
      case 'staff:registrar':
        return { label: 'นายทะเบียน', color: 'bg-emerald-600 text-white' };
      case 'staff:exam':
        return { label: 'ฝ่ายวัดผลข้อสอบ', color: 'bg-cyan-600 text-white' };
      case 'super_admin':
        return { label: 'ผู้ดูแลสูงสุด (Super Admin)', color: 'bg-rose-600 text-white' };
      default:
        return { label: role, color: 'bg-slate-600 text-white' };
    }
  };

  const badge = getRoleBadge(currentUser.currentRole);

  return (
    <div className="bg-slate-900 border-b border-slate-800 text-slate-300 text-xs py-2 px-4 shadow-inner">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 font-medium text-slate-400">
            <Shield className="w-3.5 h-3.5 text-amber-400" />
            <span>โหมดจำลองผู้ใช้ (RBAC Preview):</span>
          </span>
          <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${badge.color}`}>
            {badge.label}
          </span>
          <span className="font-semibold text-white ml-1">{currentUser.name}</span>
          
          {currentUser.lawyerLicenseNumber ? (
            <span className="bg-slate-800 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 flex items-center gap-1">
              <CheckCircle className="w-3 h-3 text-emerald-400" />
              <span>ใบอนุญาต ท. {currentUser.lawyerLicenseNumber}</span>
            </span>
          ) : (
            <button
              onClick={onOpenLicenseModal}
              className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 px-2 py-0.5 rounded border border-amber-500/40 flex items-center gap-1 text-[11px] font-medium transition-colors"
            >
              <KeyRound className="w-3 h-3" />
              <span>+ ผูกเลขที่ใบอนุญาตว่าความ</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400 hidden md:inline">สลับสิทธิ์ทดสอบ:</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => switchPersona('lawyer')}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${currentUser.currentRole === 'lawyer' ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            >
              ทนายความ
            </button>
            <button
              onClick={() => switchPersona('citizen')}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${currentUser.currentRole === 'citizen' ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            >
              ประชาชน
            </button>
            <button
              onClick={() => switchPersona('instructor')}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${currentUser.currentRole === 'instructor' ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            >
              วิทยากร
            </button>
            <button
              onClick={() => switchPersona('registrar')}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${currentUser.currentRole === 'staff:registrar' ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            >
              นายทะเบียน
            </button>
            <button
              onClick={() => switchPersona('superAdmin')}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${currentUser.currentRole === 'super_admin' ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            >
              Admin
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
