// src/app/(public)/login/page.tsx

import dynamic from 'next/dynamic';

const LoginClient = dynamic(() => import('./LoginClient'), { ssr: false });

export default function Page() {
  return <LoginClient />;
}
