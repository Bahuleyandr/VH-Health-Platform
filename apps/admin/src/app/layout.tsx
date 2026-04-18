// app/layout.tsx  (Server Component: no "use client")
import './globals.css';
import { Providers } from './providers';
import { Toaster } from 'sonner';
import { ServiceWorkerCleanup } from '@/components/ServiceWorkerCleanup';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerCleanup />
        <Providers>{children}</Providers>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
