/**
 * reports/catalog — ทะเบียนรายงานของหน้า /admin/reports (Wave E Phase 5 · lane F · ADM-004)
 *
 * ทะเบียนเดียวของ lane F สำหรับรายงาน 3 ประเภท (spec แถว 226 — ADM-004):
 * enrollments · assessments · credits — ชื่อ/คำอธิบายไทย + path ส่งออก CSV จริง
 * (GET /api/v1/admin/reports/{type}/export?format=csv) + บทบาทที่เห็นการ์ด
 */
export type ReportCard = {
  type: "enrollments" | "assessments" | "credits";
  /** ชื่อรายงาน (ไทยก่อน) */
  titleTh: string;
  /** คำอธิบายสั้น + บอกบทบาทที่ใช้ได้ */
  descriptionTh: string;
  /** path ส่งออก CSV (แนบ from/to/courseId ต่อยอดได้ตาม route จริง) */
  exportPath: string;
  /** บทบาทที่เห็นการ์ดนี้ (matrix §2.4 report:export — D12-23) */
  roles: readonly string[];
};

/** ทะเบียนรายงาน 3 ประเภท — path ตรงตาม route จริง (spec แถว 226) */
export const REPORT_CARDS: readonly ReportCard[] = [
  {
    type: "enrollments",
    titleTh: "รายงานการลงทะเบียน",
    descriptionTh: "รายการลงทะเบียนเรียนทั้งหมด — เจ้าหน้าที่ทั่วไป/ทะเบียน",
    exportPath: "/api/v1/admin/reports/enrollments/export?format=csv",
    roles: ["staff:viewer", "staff:registrar", "super_admin"],
  },
  {
    type: "assessments",
    titleTh: "รายงานผลสอบ",
    descriptionTh: "ผลสอบรายบุคคล/รายชุดข้อสอบ — เจ้าหน้าที่สอบ",
    exportPath: "/api/v1/admin/reports/assessments/export?format=csv",
    roles: ["staff:exam", "super_admin"],
  },
  {
    type: "credits",
    titleTh: "รายงานเครดิตกฎหมาย",
    descriptionTh: "รายงานเครดิตกฎหมายที่ออก — ทะเบียน",
    exportPath: "/api/v1/admin/reports/credits/export?format=csv",
    roles: ["staff:registrar", "super_admin"],
  },
];
