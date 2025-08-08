// src/app/layout.tsx
import '../../instrumentation-client';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { PageErrorBoundary } from '@/components/PageErrorBoundary';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'VH Admin Portal',
  description: 'Virtual Hospital Admin Portal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <PageErrorBoundary>{children}</PageErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}
