// src/components/ApiFetchGuard.tsx
"use client";

import { useEffect } from "react";
import { installApiFetchGuard } from "@/lib/install-api-fetch-guard";

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
