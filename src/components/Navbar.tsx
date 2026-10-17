import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  BookOpen, 
  Award, 
  CreditCard, 
  CheckCircle2, 
  ShieldCheck, 
  FileText, 
  Bell, 
  UserCheck, 
  Scale, 
  GraduationCap, 
  ChevronDown,
  Layers,
  Sparkles
} from 'lucide-react';

export const Navbar: React.FC = () => {
  const { 
    currentUser, 
    activeTab, 
    setActiveTab, 
    notifications, 
    markNotificationsAsRead,
    switchPersona 
  } = useApp();

  const [showNotifMenu, setShowNotifMenu] = useState(false);
  const [showPersonaMenu, setShowPersonaMenu] = useState(false);

  const unreadCount = notifications.filter(n => !n.read).length;
  const isLawyer = currentUser.currentRole === 'lawyer' || currentUser.roles.includes('lawyer');
  const isStaffOrAdmin = ['staff:registrar', 'staff:exam', 'staff:content', 'staff:viewer', 'super_admin'].includes(currentUser.currentRole);
  const isInstructor = currentUser.currentRole === 'instructor' || currentUser.roles.includes('instructor');

  return (
    <header className="sticky top-0 z-40 bg-slate-900 border-b border-slate-800 text-white shadow-md">
      {/* Top institutional strip */}
      <div className="bg-gradient-to-r from-amber-600 via-amber-500 to-amber-600 text-slate-950 text-xs py-1 px-4 font-medium flex justify-between items-center">
        <div className="flex items-center gap-2">
          <Scale className="w-3.5 h-3.5" />
          <span>สภาทนายความ ในพระบรมราชูปถัมภ์ · Lawyers Council of Thailand Under The Royal Patronage</span>
        </div>
        <div className="hidden md:flex items-center gap-4 text-xs">
          <span>ระบบมาตรฐานสากล Continuing Legal Education (CLE)</span>
          <span className="bg-slate-950/20 px-2 py-0.5 rounded text-[11px] font-semibold">Thai-First Platform</span>
        </div>
      </div>

      {/* Main Navbar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand Logo */}
          <div 
            onClick={() => setActiveTab('catalog')}
            className="flex items-center gap-3 cursor-pointer group"
          >
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-lg border border-amber-400/30 group-hover:scale-105 transition-transform">
              <Scale className="w-6 h-6 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-heading font-bold text-lg tracking-wide text-white">LTC E-Learning</span>
                <span className="bg-amber-500/20 text-amber-300 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 font-semibold">CLE BANK</span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">ระบบอบรมและสะสมหน่วยกิตสภาทนายความ</p>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="hidden lg:flex items-center gap-1">
            <button
              onClick={() => setActiveTab('catalog')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'catalog' 
                  ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>หลักสูตร</span>
            </button>

            <button
              onClick={() => setActiveTab('my-learning')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'my-learning' 
                  ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <GraduationCap className="w-4 h-4" />
              <span>ห้องเรียนของฉัน</span>
            </button>

            {isLawyer && (
              <button
                onClick={() => setActiveTab('credit-bank')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'credit-bank' 
                    ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <CreditCard className="w-4 h-4" />
                <span>Credit Bank</span>
                <span className="bg-amber-400/20 text-amber-300 text-[10px] px-1 rounded font-bold">
                  {currentUser.creditsEarned} น.ก.
                </span>
              </button>
            )}

            <button
              onClick={() => setActiveTab('certificates')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'certificates' 
                  ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Award className="w-4 h-4" />
              <span>ประกาศนียบัตร</span>
            </button>

            <button
              onClick={() => setActiveTab('verify')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === 'verify' 
                  ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>ตรวจสอบวุฒิบัตร</span>
            </button>

            {isInstructor && (
              <button
                onClick={() => setActiveTab('instructor-studio')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'instructor-studio' 
                    ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                    : 'text-amber-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <FileText className="w-4 h-4" />
                <span>อาจารย์/ข้อสอบ</span>
              </button>
            )}

            {isStaffOrAdmin && (
              <button
                onClick={() => setActiveTab('admin-portal')}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'admin-portal' 
                    ? 'bg-amber-500 text-slate-950 font-semibold shadow-sm' 
                    : 'text-emerald-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>Admin & Audit</span>
              </button>
            )}
          </nav>

          {/* Right Section: Persona Selector + Notifications + User Avatar */}
          <div className="flex items-center gap-3">
            {/* Persona Switcher Quick Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowPersonaMenu(!showPersonaMenu)}
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 transition-colors"
                title="สลับบทบาททดสอบระบบ"
              >
                <Layers className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">บทบาท:</span>
                <span className="text-amber-300 font-semibold capitalize">
                  {currentUser.currentRole.replace('staff:', '')}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {showPersonaMenu && (
                <div className="absolute right-0 mt-2 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-2 z-50 text-slate-200">
                  <div className="px-3 py-2 border-b border-slate-800 text-xs font-medium text-slate-400 flex items-center justify-between">
                    <span>สลับบทบาททดสอบ (RBAC)</span>
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                  <div className="py-1">
                    <button
                      onClick={() => { switchPersona('lawyer'); setShowPersonaMenu(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2.5 text-xs ${currentUser.currentRole === 'lawyer' ? 'text-amber-400 font-semibold bg-slate-800/60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-amber-400" />
                      <div>
                        <div>ทนายความ (Lawyer)</div>
                        <div className="text-[10px] text-slate-400 font-normal">เลขที่ 4521/2561 · CLE Bank</div>
                      </div>
                    </button>

                    <button
                      onClick={() => { switchPersona('citizen'); setShowPersonaMenu(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2.5 text-xs ${currentUser.currentRole === 'citizen' ? 'text-amber-400 font-semibold bg-slate-800/60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      <div>
                        <div>ประชาชน (Citizen)</div>
                        <div className="text-[10px] text-slate-400 font-normal">เรียนฟรี · กฎหมายสาธารณะ</div>
                      </div>
                    </button>

                    <button
                      onClick={() => { switchPersona('instructor'); setShowPersonaMenu(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2.5 text-xs ${currentUser.currentRole === 'instructor' ? 'text-amber-400 font-semibold bg-slate-800/60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-purple-400" />
                      <div>
                        <div>วิทยากร (Instructor)</div>
                        <div className="text-[10px] text-slate-400 font-normal">สร้างหลักสูตร · ธนาคารข้อสอบ</div>
                      </div>
                    </button>

                    <button
                      onClick={() => { switchPersona('registrar'); setShowPersonaMenu(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2.5 text-xs ${currentUser.currentRole === 'staff:registrar' ? 'text-amber-400 font-semibold bg-slate-800/60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      <div>
                        <div>นายทะเบียน (Staff:Registrar)</div>
                        <div className="text-[10px] text-slate-400 font-normal">อนุมัติวุฒิบัตร · ตรวจใบอนุญาต</div>
                      </div>
                    </button>

                    <button
                      onClick={() => { switchPersona('examStaff'); setShowPersonaMenu(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2.5 text-xs ${currentUser.currentRole === 'staff:exam' ? 'text-amber-400 font-semibold bg-slate-800/60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-cyan-400" />
                      <div>
                        <div>ฝ่ายวัดผล (Staff:Exam)</div>
                        <div className="text-[10px] text-slate-400 font-normal">ควบคุมกติกาและการประเมินผล</div>
                      </div>
                    </button>

                    <button
                      onClick={() => { switchPersona('superAdmin'); setShowPersonaMenu(false); }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2.5 text-xs ${currentUser.currentRole === 'super_admin' ? 'text-amber-400 font-semibold bg-slate-800/60' : ''}`}
                    >
                      <span className="w-2 h-2 rounded-full bg-rose-400" />
                      <div>
                        <div>ผู้ดูแลระบบ (Super Admin)</div>
                        <div className="text-[10px] text-slate-400 font-normal">Audit Log · สิทธิ์ทุกฟังก์ชัน</div>
                      </div>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Notification Bell */}
            <div className="relative">
              <button
                onClick={() => {
                  setShowNotifMenu(!showNotifMenu);
                  if (!showNotifMenu) markNotificationsAsRead();
                }}
                className="p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 relative transition-colors"
                title="การแจ้งเตือน"
              >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-amber-500 rounded-full ring-2 ring-slate-900" />
                )}
              </button>

              {showNotifMenu && (
                <div className="absolute right-0 mt-2 w-80 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-3 z-50 text-slate-200">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <span className="text-xs font-semibold text-white">การแจ้งเตือน</span>
                    <span className="text-[11px] text-amber-400 font-medium">ทั้งหมด ({notifications.length})</span>
                  </div>
                  <div className="mt-2 space-y-2 max-h-72 overflow-y-auto">
                    {notifications.map(n => (
                      <div 
                        key={n.id} 
                        onClick={() => {
                          if (n.linkTab) setActiveTab(n.linkTab);
                          setShowNotifMenu(false);
                        }}
                        className="p-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 cursor-pointer transition-colors"
                      >
                        <div className="text-xs font-medium text-slate-100">{n.title}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">{n.message}</div>
                        <div className="text-[10px] text-amber-400/80 mt-1">{n.timestamp}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* User Profile Pill */}
            <div className="flex items-center gap-2 pl-2 border-l border-slate-800">
              <img 
                src={currentUser.avatar} 
                alt={currentUser.name} 
                className="w-8 h-8 rounded-full border border-amber-500/50 object-cover"
              />
              <div className="hidden xl:block text-left">
                <div className="text-xs font-medium text-white flex items-center gap-1">
                  <span>{currentUser.name}</span>
                  {currentUser.licenseStatus === 'verified' && (
                    <span title="ทนายความยืนยันตัวตนแล้ว">
                      <UserCheck className="w-3.5 h-3.5 text-amber-400" />
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-slate-400">
                  {currentUser.lawyerLicenseNumber ? `เลขที่ ${currentUser.lawyerLicenseNumber}` : currentUser.email}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile nav bar */}
      <div className="lg:hidden border-t border-slate-800 px-3 py-2 flex items-center justify-around bg-slate-950/80 text-xs">
        <button
          onClick={() => setActiveTab('catalog')}
          className={`flex flex-col items-center gap-1 ${activeTab === 'catalog' ? 'text-amber-400 font-bold' : 'text-slate-400'}`}
        >
          <BookOpen className="w-4 h-4" />
          <span>หลักสูตร</span>
        </button>
        <button
          onClick={() => setActiveTab('my-learning')}
          className={`flex flex-col items-center gap-1 ${activeTab === 'my-learning' ? 'text-amber-400 font-bold' : 'text-slate-400'}`}
        >
          <GraduationCap className="w-4 h-4" />
          <span>เรียนต่อ</span>
        </button>
        {isLawyer && (
          <button
            onClick={() => setActiveTab('credit-bank')}
            className={`flex flex-col items-center gap-1 ${activeTab === 'credit-bank' ? 'text-amber-400 font-bold' : 'text-slate-400'}`}
          >
            <CreditCard className="w-4 h-4" />
            <span>Credit</span>
          </button>
        )}
        <button
          onClick={() => setActiveTab('certificates')}
          className={`flex flex-col items-center gap-1 ${activeTab === 'certificates' ? 'text-amber-400 font-bold' : 'text-slate-400'}`}
        >
          <Award className="w-4 h-4" />
          <span>วุฒิบัตร</span>
        </button>
        <button
          onClick={() => setActiveTab('verify')}
          className={`flex flex-col items-center gap-1 ${activeTab === 'verify' ? 'text-amber-400 font-bold' : 'text-slate-400'}`}
        >
          <CheckCircle2 className="w-4 h-4" />
          <span>Verify</span>
        </button>
      </div>
    </header>
  );
};
