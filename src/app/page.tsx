// src/app/page.tsx
import { redirect } from 'next/navigation';

export default function HomePage() {
  // Permanently redirect the root path to the login page.
  redirect('/login');
  
  // This part will never be reached, but it's good practice
  // to return null or a simple component.
  return null;
}
