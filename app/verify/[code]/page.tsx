"use client";

import React from "react";
import { useParams } from "next/navigation";
import { CertificateVerifyView } from "@/components/ltc/CertificateVerifyView";

export default function VerifyByCodePage() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(params?.code || "LTC-2026-483920");
  return <CertificateVerifyView initialCode={code} />;
}
