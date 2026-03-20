// src/components/ApiFetchGuard.tsx
"use client";

import { installApiFetchGuard } from "@/lib/install-api-fetch-guard";
import { useEffect } from "react";

export default function ApiFetchGuard() {
  useEffect(() => {
    installApiFetchGuard(() => {
      try {
        return localStorage.getItem("adminToken") ?? undefined;
      } catch {
        return undefined;
      }
    });
  }, []);

  return null;
}
