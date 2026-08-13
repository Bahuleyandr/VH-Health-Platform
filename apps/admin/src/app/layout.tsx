// app/layout.tsx  (Server Component: no "use client")
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "sonner";
import { LegacyPwaRetirement } from "@/components/LegacyPwaRetirement";

// Force dynamic (per-request) rendering for every route (audit finding M9 /
// #19). The nonce CSP emitted by src/middleware.ts is per-request; Next can
// only stamp that nonce onto its inline + chunk <script> tags when the page is
// rendered at request time. Statically prerendered pages would ship WITHOUT
// the nonce, so a strict `script-src 'nonce-…' 'strict-dynamic'` policy (no
// 'unsafe-inline') would block every script. Dynamic rendering is what makes
// the nonce CSP functional and lets us drop the ingress 'unsafe-inline'
// fallback. The admin portal is a low-traffic, auth-gated internal tool whose
// data is already client-fetched (TanStack Query), so losing the static shell
// cache is immaterial.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <LegacyPwaRetirement />
        <Providers>{children}</Providers>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
