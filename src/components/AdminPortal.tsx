import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  ShieldCheck, 
  History, 
  Search, 
  Filter, 
  UserCheck, 
  Award, 
  CheckCircle2, 
  AlertTriangle,
  Download,
  Users,
  Layers,
  Database,
  X,
  Check,
  Eye,
  Plus,
  KeyRound,
  FileSpreadsheet,
  BarChart3,
  TrendingUp,
  Settings2
} from 'lucide-react';
import { AuditLogEntry, CourseCategory, RoleType, UserProfile } from '../types';

interface PendingLicenseRequest {
  id: string;
  name: string;
  email: string;
  citizenId: string;
  licenseNumber: string;
  submittedAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

export const AdminPortal: React.FC = () => {
  const { 
    auditLogs, 
    currentUser, 
    courses, 
    certificates, 
    creditLedger, 
    addAuditLog, 
    allUsers, 
    updateUserRoles, 
    addCreditAdjustment 
  } = useApp();

  const [activeSubTab, setActiveSubTab] = useState<'audit' | 'license-queue' | 'user-roles' | 'manual-credit' | 'overview'>('audit');
  const [searchLog, setSearchLog] = useState('');
  const [filterAction, setFilterAction] = useState('all');
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);

  // Manual Credit Modal Form State
  const [selectedUserForCredit, setSelectedUserForCredit] = useState(allUsers[0]?.id || '');
  const [adjustCredits, setAdjustCredits] = useState(4);
  const [adjustCategory, setAdjustCategory] = useState<CourseCategory>('procedural');
  const [adjustTitle, setAdjustTitle] = useState('การสัมมนาวิชาการสภาทนายความประจำภาค');
  const [adjustReason, setAdjustReason] = useState('เข้าร่วมการสัมมนาทางวิชาการและส่งเอกสารรับรองครบถ้วน');
  const [creditAdjustMsg, setCreditAdjustMsg] = useState(false);

  // User Role Edit Modal State
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<RoleType[]>([]);

  // Pending License Requests Queue
  const [pendingRequests, setPendingRequests] = useState<PendingLicenseRequest[]>([
    {
      id: 'req-01',
      name: 'ทนายเกรียงไกร นิติธรรม',
      email: 'kriangkrai.law@gmail.com',
      citizenId: '1-1004-99823-11-2',
      licenseNumber: '7821/2563',
      submittedAt: '16 ต.ค. 2569 14:20',
      status: 'pending',
    },
    {
      id: 'req-02',
      name: 'ทนายประเสริฐ ยุติธรรมวิสุทธิ์',
      email: 'prasert.justice@lawyer.in.th',
      citizenId: '3-1002-88129-45-6',
      licenseNumber: '3310/2558',
      submittedAt: '17 ต.ค. 2569 09:15',
      status: 'pending',
    },
    {
      id: 'req-03',
      name: 'ทนายณัฐริกา รักษ์นิติ',
      email: 'nattarika.law@gmail.com',
      citizenId: '5-1001-44589-22-1',
      licenseNumber: '5540/2565',
      submittedAt: '17 ต.ค. 2569 11:30',
      status: 'pending',
    },
  ]);

  const handleApproveRequest = (req: PendingLicenseRequest) => {
    setPendingRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: 'approved' } : r));
    addAuditLog('LICENSE_APPROVAL', req.licenseNumber, `นายทะเบียนอนุมัติใบอนุญาตว่าความให้แก่ ${req.name} (${req.licenseNumber})`);
    alert(`อนุมัติใบอนุญาตว่าความ ${req.licenseNumber} ให้แก่ ${req.name} เรียบร้อยแล้ว`);
  };

  const handleRejectRequest = (req: PendingLicenseRequest) => {
    setPendingRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: 'rejected' } : r));
    addAuditLog('LICENSE_REJECT', req.licenseNumber, `นายทะเบียนปฏิเสธคำขอของ ${req.name} เนื่องจากข้อมูลไม่ตรงกับสารบบ`, 'WARNING');
  };

  const handleManualCreditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUserForCredit || !adjustTitle.trim()) return;

    addCreditAdjustment(
      selectedUserForCredit,
      Number(adjustCredits),
      adjustCategory,
      adjustTitle,
      adjustReason
    );

    setCreditAdjustMsg(true);
    setTimeout(() => setCreditAdjustMsg(false), 3000);
  };

  const openRoleEditor = (user: UserProfile) => {
    setEditingUser(user);
    setSelectedRoles([...user.roles]);
  };

  const toggleRoleSelection = (role: RoleType) => {
    setSelectedRoles(prev => 
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );
  };

  const handleSaveRoles = () => {
    if (editingUser) {
      updateUserRoles(editingUser.id, selectedRoles);
      setEditingUser(null);
    }
  };

  const filteredLogs = auditLogs.filter(log => {
    if (filterAction !== 'all' && !log.action.includes(filterAction)) {
      return false;
    }
    if (searchLog.trim()) {
      const q = searchLog.toLowerCase();
      const matchDetails = log.details.toLowerCase().includes(q);
      const matchUser = log.userName.toLowerCase().includes(q);
      const matchAction = log.action.toLowerCase().includes(q);
      const matchResource = log.targetResource.toLowerCase().includes(q);
      if (!matchDetails && !matchUser && !matchAction && !matchResource) {
        return false;
      }
    }
    return true;
  });

  const availableRoles: { role: RoleType; label: string; desc: string }[] = [
    { role: 'citizen', label: 'ประชาชน (Citizen)', desc: 'เข้าอบรมหลักสูตรสาธารณะ' },
    { role: 'lawyer', label: 'ทนายความ (Lawyer)', desc: 'อบรม CLE และสะสม Credit Bank' },
    { role: 'instructor', label: 'วิทยากร (Instructor)', desc: 'สร้างหลักสูตรและออกข้อสอบ' },
    { role: 'staff:registrar', label: 'นายทะเบียน (Registrar)', desc: 'อนุมัติใบอนุญาตและวุฒิบัตร' },
    { role: 'staff:exam', label: 'ฝ่ายวัดผล (Exam Staff)', desc: 'ดูแลและอนุมัติชุดข้อสอบ' },
    { role: 'staff:viewer', label: 'ฝ่ายรายงาน (Viewer)', desc: 'อ่านข้อมูลและ Export รายงาน' },
    { role: 'super_admin', label: 'ผู้ดูแลสูงสุด (Super Admin)', desc: 'ควบคุมระบบและ RBAC' },
  ];

  return (
    <div className="space-y-6 pb-16">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 px-2.5 py-0.5 rounded-full mb-1">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>ศูนย์ควบคุมผู้ดูแลระบบและนายทะเบียน (Staff Back-Office)</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-heading font-bold text-slate-900">
            ระบบตรวจสอบและบันทึกความปลอดภัย (Audit Trail & Control)
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            บทบาทปัจจุบัน: <strong>{currentUser.currentRole}</strong> ({currentUser.name}) · มาตรฐาน OWASP ASVS L2 / PDPA Compliance
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex flex-wrap bg-slate-100 p-1 rounded-xl text-xs font-medium">
          <button
            onClick={() => setActiveSubTab('audit')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeSubTab === 'audit'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Audit Log ({auditLogs.length})
          </button>
          <button
            onClick={() => setActiveSubTab('license-queue')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeSubTab === 'license-queue'
                ? 'bg-white text-amber-800 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            คิวตรวจใบอนุญาต ({pendingRequests.filter(r => r.status === 'pending').length})
          </button>
          <button
            onClick={() => setActiveSubTab('user-roles')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeSubTab === 'user-roles'
                ? 'bg-white text-indigo-800 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            จัดการสิทธิ์ RBAC ({allUsers.length})
          </button>
          <button
            onClick={() => setActiveSubTab('manual-credit')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeSubTab === 'manual-credit'
                ? 'bg-white text-emerald-800 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ปรับยอดหน่วยกิต
          </button>
          <button
            onClick={() => setActiveSubTab('overview')}
            className={`px-3 py-1.5 rounded-lg transition-all ${
              activeSubTab === 'overview'
                ? 'bg-white text-cyan-800 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            รายงานสถิติ
          </button>
        </div>
      </div>

      {activeSubTab === 'overview' ? (
        /* Overview Dashboard & Analytics */
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
                <span>หลักสูตรในระบบ</span>
                <Layers className="w-4 h-4 text-blue-500" />
              </div>
              <div className="text-2xl font-heading font-bold text-slate-900 mt-2">
                {courses.length} หลักสูตร
              </div>
              <div className="text-[11px] text-emerald-600 font-medium mt-1">
                ✓ เผยแพร่แล้วทั้งหมด
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
                <span>วุฒิบัตรที่ออกทั้งหมด</span>
                <Award className="w-4 h-4 text-amber-500" />
              </div>
              <div className="text-2xl font-heading font-bold text-amber-600 mt-2">
                {certificates.length} ฉบับ
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                ลงนามดิจิทัลโดยนายทะเบียน
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
                <span>รายการใน Credit Ledger</span>
                <TrendingUp className="w-4 h-4 text-emerald-500" />
              </div>
              <div className="text-2xl font-heading font-bold text-blue-600 mt-2">
                {creditLedger.length} ธุรกรรม
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                Immutable Ledger (Append-only)
              </div>
            </div>

            <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-400 font-medium">
                <span>บันทึกความปลอดภัย</span>
                <ShieldCheck className="w-4 h-4 text-purple-500" />
              </div>
              <div className="text-2xl font-heading font-bold text-purple-600 mt-2">
                {auditLogs.length} เหตุการณ์
              </div>
              <div className="text-[11px] text-emerald-600 font-medium mt-1">
                100% Traceability
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="font-heading font-bold text-base text-slate-900">
              สถานะความพร้อมระบบสภาทนายความ (System Architecture & Compliance)
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
                  <Database className="w-4 h-4 text-blue-600" />
                  <span>สถาปัตยกรรมข้อมูล</span>
                </div>
                <p className="text-slate-600 leading-relaxed">
                  ฐานข้อมูลพร้อมรองรับ Supabase PostgreSQL + RLS ทุกตาราง และ In-Memory dev stack ใน AI Studio
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>RBAC & Least Privilege</span>
                </div>
                <p className="text-slate-600 leading-relaxed">
                  แยกสิทธิ์ชัดเจนระหว่าง Citizen, Lawyer, Instructor, Staff:Registrar, Staff:Exam และ Super Admin
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
                  <UserCheck className="w-4 h-4 text-amber-600" />
                  <span>PDPA & Audit Protection</span>
                </div>
                <p className="text-slate-600 leading-relaxed">
                  ห้ามแก้ไขหรือลบ Audit Log โดยเด็ดขาด จัดเก็บแบบ Append-only ป้องกันข้อมูลสูญหายหรือถูกดัดแปลง
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : activeSubTab === 'license-queue' ? (
        /* License Approval Queue */
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-200">
            <div>
              <h3 className="font-heading font-bold text-base text-slate-900">
                คำขอผูกและยืนยันใบอนุญาตว่าความ (Registrar License Verification Queue)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                นายทะเบียนตรวจสอบเทียบเคียงกับสารบบทนายความแห่งประเทศไทย ก่อนเปิดสิทธิ์บทบาท Lawyer
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600 border-b border-slate-200 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">เวลาที่ยื่นคำขอ</th>
                  <th className="py-2.5 px-3">ชื่อ-นามสกุล</th>
                  <th className="py-2.5 px-3">เลขประจำตัวประชาชน</th>
                  <th className="py-2.5 px-3">เลขที่ใบอนุญาตว่าความ</th>
                  <th className="py-2.5 px-3">อีเมล</th>
                  <th className="py-2.5 px-3 text-center">สถานะ</th>
                  <th className="py-2.5 px-3 text-center">ดำเนินการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pendingRequests.map(req => (
                  <tr key={req.id} className="hover:bg-slate-50">
                    <td className="py-3 px-3 text-slate-500">{req.submittedAt}</td>
                    <td className="py-3 px-3 font-semibold text-slate-900">{req.name}</td>
                    <td className="py-3 px-3 font-mono text-slate-600">{req.citizenId}</td>
                    <td className="py-3 px-3 font-mono font-bold text-amber-800">ท. {req.licenseNumber}</td>
                    <td className="py-3 px-3 text-slate-600">{req.email}</td>
                    <td className="py-3 px-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        req.status === 'pending'
                          ? 'bg-amber-100 text-amber-800'
                          : req.status === 'approved'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}>
                        {req.status === 'pending' ? 'รอนายทะเบียนตรวจ' : req.status === 'approved' ? 'อนุมัติแล้ว' : 'ปฏิเสธ'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center">
                      {req.status === 'pending' ? (
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleApproveRequest(req)}
                            className="p-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs flex items-center gap-1"
                            title="อนุมัติใบอนุญาต"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>อนุมัติ</span>
                          </button>
                          <button
                            onClick={() => handleRejectRequest(req)}
                            className="p-1.5 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded-lg text-xs"
                            title="ปฏิเสธคำขอ"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-slate-400 text-[11px]">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeSubTab === 'user-roles' ? (
        /* User & Role Management (Super Admin) */
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-200">
            <div>
              <h3 className="font-heading font-bold text-base text-slate-900">
                ระบบจัดการสิทธิ์ผู้ใช้งาน (User & Role Management - RBAC)
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                กำหนดและปรับปรุงบทบาทผู้ใช้ตามหลักสิทธิ์เท่าที่จำเป็น (Least Privilege)
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600 border-b border-slate-200 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">ผู้ใช้งาน</th>
                  <th className="py-2.5 px-3">อีเมล</th>
                  <th className="py-2.5 px-3">เลขที่ใบอนุญาต</th>
                  <th className="py-2.5 px-3">บทบาททั้งหมด (Roles)</th>
                  <th className="py-2.5 px-3">หน่วยกิตสะสม</th>
                  <th className="py-2.5 px-3 text-center">จัดการสิทธิ์</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {allUsers.map(user => (
                  <tr key={user.id} className="hover:bg-slate-50">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <img src={user.avatar} alt={user.name} className="w-7 h-7 rounded-full object-cover border" />
                        <span className="font-semibold text-slate-900">{user.name}</span>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-slate-600">{user.email}</td>
                    <td className="py-3 px-3 font-mono text-amber-800">
                      {user.lawyerLicenseNumber ? `ท. ${user.lawyerLicenseNumber}` : '-'}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap gap-1">
                        {user.roles.map(r => (
                          <span key={r} className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-semibold border">
                            {r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 px-3 font-bold text-amber-700">
                      {user.creditsEarned} น.ก.
                    </td>
                    <td className="py-3 px-3 text-center">
                      <button
                        onClick={() => openRoleEditor(user)}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold flex items-center gap-1 mx-auto"
                      >
                        <Settings2 className="w-3.5 h-3.5 text-amber-600" />
                        <span>แก้ไขสิทธิ์</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeSubTab === 'manual-credit' ? (
        /* Manual Credit Adjustment (Registrar) */
        <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm max-w-2xl">
          <div className="pb-4 border-b border-slate-200 mb-6">
            <h3 className="font-heading font-bold text-base text-slate-900">
              การปรับปรุงยอดหน่วยกิตพิเศษ (Manual Credit Adjustment)
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              เฉพาะนายทะเบียนสภาทนายความ: บันทึกหน่วยกิตจากการสัมมนาภายนอก งานวิจัย หรือการอบรมพิเศษ
            </p>
          </div>

          {creditAdjustMsg && (
            <div className="mb-6 p-4 rounded-xl bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>บันทึกหน่วยกิตพิเศษเข้าสู่ Credit Ledger และบันทึก Audit Log สำเร็จ</span>
            </div>
          )}

          <form onSubmit={handleManualCreditSubmit} className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                เลือกทนายความผู้รับหน่วยกิต
              </label>
              <select
                value={selectedUserForCredit}
                onChange={(e) => setSelectedUserForCredit(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {allUsers.filter(u => u.roles.includes('lawyer')).map(u => (
                  <option key={u.id} value={u.id}>
                    {u.name} (ใบอนุญาต ท. {u.lawyerLicenseNumber || 'ไม่ระบุ'})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  จำนวนหน่วยกิตที่เพิ่ม (Credits)
                </label>
                <input
                  type="number"
                  min="1"
                  max="15"
                  value={adjustCredits}
                  onChange={(e) => setAdjustCredits(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                  required
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  หมวดหมู่วิชา
                </label>
                <select
                  value={adjustCategory}
                  onChange={(e) => setAdjustCategory(e.target.value as CourseCategory)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="ethics">จริยธรรมและมรรยาท (บังคับ)</option>
                  <option value="substantive">กฎหมายสารบัญญัติ</option>
                  <option value="procedural">วิธีสบัญญัติและการว่าความ</option>
                  <option value="emerging_tech">เทคโนโลยีกฎหมาย & PDPA</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                ชื่อกิจกรรม / การสัมมนาทางวิชาการ
              </label>
              <input
                type="text"
                value={adjustTitle}
                onChange={(e) => setAdjustTitle(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                เหตุผลและเอกสารประกอบการอนุมัติ (Administrative Justification)
              </label>
              <textarea
                rows={3}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                required
              />
            </div>

            <div className="pt-4 border-t border-slate-100 flex justify-end">
              <button
                type="submit"
                className="px-6 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-bold transition-colors shadow flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>อนุมัติและบันทึกลง Ledger</span>
              </button>
            </div>
          </form>
        </div>
      ) : (
        /* Audit Log System Table */
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden space-y-4 p-5">
          {/* Search & Action Filters */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="ค้นหากิจกรรม, ผู้กระทำ, ไอพี หรือทรัพยากร..."
                value={searchLog}
                onChange={(e) => setSearchLog(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20"
              />
            </div>

            <div className="flex items-center gap-2">
              <select
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value)}
                className="px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white text-slate-700"
              >
                <option value="all">ทุกกิจกรรม (All Actions)</option>
                <option value="AUTH">การยืนยันตัวตน (Auth)</option>
                <option value="COURSE">หลักสูตร (Courses)</option>
                <option value="EXAM">การสอบวัดผล (Exams)</option>
                <option value="CERT">วุฒิบัตร (Certificates)</option>
                <option value="CREDIT">Credit Bank</option>
                <option value="LICENSE">ใบอนุญาตว่าความ</option>
              </select>

              <button
                onClick={() => {
                  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(auditLogs, null, 2));
                  const downloadAnchor = document.createElement('a');
                  downloadAnchor.setAttribute("href", dataStr);
                  downloadAnchor.setAttribute("download", `ltc_audit_log_${Date.now()}.json`);
                  document.body.appendChild(downloadAnchor);
                  downloadAnchor.click();
                  downloadAnchor.remove();
                }}
                className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export JSON</span>
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600 border-b border-slate-200 uppercase font-semibold text-[10px]">
                <tr>
                  <th className="py-2.5 px-3">เวลา (UTC/TH)</th>
                  <th className="py-2.5 px-3">ผู้ใช้งาน</th>
                  <th className="py-2.5 px-3">บทบาท</th>
                  <th className="py-2.5 px-3">การกระทำ (Event)</th>
                  <th className="py-2.5 px-3">เป้าหมาย (Resource)</th>
                  <th className="py-2.5 px-3">IP Address</th>
                  <th className="py-2.5 px-3">สถานะ</th>
                  <th className="py-2.5 px-3">รายละเอียด</th>
                  <th className="py-2.5 px-3 text-center">ดูเจาะลึก</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.map(log => (
                  <tr key={log.id} className="hover:bg-slate-50 font-mono text-[11px] cursor-pointer" onClick={() => setSelectedLog(log)}>
                    <td className="py-2.5 px-3 text-slate-500 whitespace-nowrap">{log.timestamp}</td>
                    <td className="py-2.5 px-3 font-medium text-slate-900 font-sans">{log.userName}</td>
                    <td className="py-2.5 px-3">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px]">
                        {log.userRole}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-bold text-amber-800">{log.action}</td>
                    <td className="py-2.5 px-3 text-slate-600">{log.targetResource}</td>
                    <td className="py-2.5 px-3 text-slate-400">{log.ipAddress}</td>
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        log.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-slate-700 font-sans max-w-xs truncate" title={log.details}>
                      {log.details}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      <button 
                        onClick={(e) => { e.stopPropagation(); setSelectedLog(log); }}
                        className="p-1 hover:bg-slate-200 rounded text-slate-500"
                        title="ดูรายละเอียด JSON Payload"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Role Editor Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-amber-600" />
                <h3 className="font-heading font-bold text-base text-slate-900">
                  ปรับปรุงบทบาท: {editingUser.name}
                </h3>
              </div>
              <button onClick={() => setEditingUser(null)} className="text-slate-400 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-500">
              เลือกบทบาทที่ต้องการมอบหมายให้กับผู้ใช้นี้ (สามารถมีได้หลายบทบาทพร้อมกัน):
            </p>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {availableRoles.map(item => {
                const isChecked = selectedRoles.includes(item.role);
                return (
                  <label
                    key={item.role}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer text-xs transition-colors ${
                      isChecked ? 'bg-amber-50/70 border-amber-400' : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleRoleSelection(item.role)}
                      className="mt-0.5 rounded text-amber-600"
                    />
                    <div>
                      <div className="font-semibold text-slate-900">{item.label}</div>
                      <div className="text-[11px] text-slate-500">{item.desc}</div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                onClick={() => setEditingUser(null)}
                className="px-4 py-2 border rounded-lg text-xs font-semibold text-slate-600"
              >
                ยกเลิก
              </button>
              <button
                onClick={handleSaveRoles}
                className="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold shadow"
              >
                บันทึกการเปลี่ยนแปลง
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit Log Detail Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                <h3 className="font-heading font-bold text-base text-slate-900">
                  รายละเอียดเหตุการณ์ Audit Log (ASVS L2)
                </h3>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5 font-mono">
                <div><span className="text-slate-400">Log ID:</span> <strong className="text-slate-800">{selectedLog.id}</strong></div>
                <div><span className="text-slate-400">Timestamp:</span> <span className="text-slate-700">{selectedLog.timestamp} UTC</span></div>
                <div><span className="text-slate-400">Actor User ID:</span> <span className="text-slate-700">{selectedLog.userId}</span></div>
                <div><span className="text-slate-400">Actor Name:</span> <span className="text-slate-900 font-semibold">{selectedLog.userName}</span> ({selectedLog.userRole})</div>
                <div><span className="text-slate-400">Action:</span> <strong className="text-amber-800">{selectedLog.action}</strong></div>
                <div><span className="text-slate-400">Resource:</span> <span className="text-slate-700">{selectedLog.targetResource}</span></div>
                <div><span className="text-slate-400">Client IP:</span> <span className="text-slate-700">{selectedLog.ipAddress}</span></div>
                <div><span className="text-slate-400">Status:</span> <span className="font-bold text-emerald-700">{selectedLog.status}</span></div>
              </div>

              <div>
                <span className="text-slate-500 font-semibold">ข้อความบรรยายรายละเอียด (Description):</span>
                <p className="mt-1 p-3 bg-slate-50 rounded-lg text-slate-800 border border-slate-100">
                  {selectedLog.details}
                </p>
              </div>

              <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200 text-emerald-950 text-[11px]">
                ✓ บันทึกนี้เป็นแบบ Append-Only มีการลงลายมือชื่อดิจิทัลและไม่สามารถแก้ไขหรือลบออกจากฐานข้อมูลได้ตามกฎหมาย PDPA
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-semibold"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
