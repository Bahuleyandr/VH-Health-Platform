// src/app/layout.tsx
import '../../instrumentation-client';  // Fixed path - one level up since instrumentation-client.ts is in root
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';  // Import your existing globals.css
import { Providers } from './providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'VH Admin Portal',
  description: 'Virtual Hospital Admin Portal',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}