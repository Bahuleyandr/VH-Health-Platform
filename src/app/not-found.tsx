// /src/app/not-found.tsx
import Link from 'next/link';

export default function NotFound() {
  return (
    <div>
      <h1>404 – Page Not Found</h1>
      <p>The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link href="/">Go back home</Link>
    </div>
  );
}
