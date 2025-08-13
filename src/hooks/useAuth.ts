// src/hooks/useAuth.ts
import { useUser } from "@/contexts/UserContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function useAuth(redirectTo = "/login", redirectIfFound = false) {
  const { user, loading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (!loading) {
      if (!user && !redirectIfFound) {
        router.push(redirectTo);
      }

      if (user && redirectIfFound) {
        router.push(redirectTo);
      }
    }
  }, [user, loading, redirectTo, redirectIfFound, router]);

  return { user, loading };
}
