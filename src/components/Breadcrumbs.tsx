// src/components/Breadcrumbs.tsx
"use client";

import styles from "@/app/(with-auth)/dashboard/Dashboard.module.css"; // adjust the path if your alias differs
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Breadcrumbs() {
  const pathname = usePathname() || "/";
  const segments = pathname.split("/").filter(Boolean);

  // Treat /dashboard as the app's "home" (don't show it as a crumb)
  const isDashboardRoot = segments[0] === "dashboard";
  const trail = isDashboardRoot ? segments.slice(1) : segments;

  const formatName = (path: string) =>
    decodeURIComponent(path)
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  // Build href for each crumb (still includes hidden "dashboard" in the URL)
  const hrefFor = (i: number) =>
    "/" +
    (isDashboardRoot
      ? ["dashboard", ...trail.slice(0, i + 1)].join("/")
      : trail.slice(0, i + 1).join("/"));

  return (
    <nav className={styles.breadcrumb} aria-label="Breadcrumb">
      <ol className={styles.bcList}>
        {/* Home */}
        <li className={styles.bcItem}>
          <Link
            href={isDashboardRoot ? "/dashboard" : "/"}
            className={styles.bcLink}
          >
            <svg
              className={styles.bcHomeIcon}
              fill="currentColor"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
            </svg>
            <span>Home</span>
          </Link>
        </li>

        {/* Dynamic segments */}
        {trail.map((seg, i) => {
          const isLast = i === trail.length - 1;
          return (
            <li className={styles.bcItem} key={`${seg}-${i}`}>
              {/* Separator */}
              <svg
                className={styles.bcSep}
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                  clipRule="evenodd"
                />
              </svg>

              {isLast ? (
                <span className={styles.bcCurrent} aria-current="page">
                  {formatName(seg)}
                </span>
              ) : (
                <Link href={hrefFor(i)} className={styles.bcLink}>
                  {formatName(seg)}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
