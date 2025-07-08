import type { Metadata } from "next";
import "./globals.css";
import { QueryProvider } from '@/providers/query-provider';

export const metadata: Metadata = {
  title: "VH Health Admin Portal",
  description: "Admin portal for VH Health",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          {children}
        </QueryProvider>
      </body>
    </html>
  );
}