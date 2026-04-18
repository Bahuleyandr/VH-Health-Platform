// src/components/ApiFetchGuard.tsx
"use client";

import { useEffect } from "react";
import { installApiFetchGuard } from "@/lib/install-api-fetch-guard";

export default function ApiFetchGuard() {
  useEffect(() => {
    // Auth is carried via the httpOnly auth_token cookie — no token callback.
    installApiFetchGuard();
  }, []);

  return null;
}
