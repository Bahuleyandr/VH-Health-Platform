// src/components/Breadcrumbs.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/app/(with-auth)/dashboard/Dashboard.module.css"; // adjust the path if your alias differs
import { HomeIcon } from "@/components/icons";

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

  // For mobile: show only the last 2 items plus "..." if there are more
  const shouldCollapse = trail.length > 2;

  const renderSep = () => (
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
  );

  return (
    <nav className={styles.breadcrumb} aria-label="Breadcrumb">
      <ol className={styles.bcList}>
        {/* Home — always visible */}
        <li className={styles.bcItem}>
          <Link
            href={isDashboardRoot ? "/dashboard" : "/"}
            className={styles.bcLink}
          >
            <HomeIcon className={styles.bcHomeIcon} aria-hidden="true" />
            <span className="hidden sm:inline">Home</span>
          </Link>
        </li>

        {/* Ellipsis placeholder for mobile when trail has more than 2 segments */}
        {shouldCollapse && (
          <li className={`${styles.bcItem} ${styles.bcEllipsis}`} aria-hidden="true">
            {renderSep()}
            <span style={{ padding: '0 0.25rem', color: 'var(--muted-foreground)' }}>…</span>
          </li>
        )}

        {/* Dynamic segments */}
        {trail.map((seg, i) => {
          const isLast = i === trail.length - 1;
          // On mobile, hide all but the last 2 items (via CSS class)
          const isMobileHidden = shouldCollapse && i < trail.length - 2;

          return (
            <li
              className={`${styles.bcItem}${isMobileHidden ? ` ${styles.bcItemHidden}` : ''}`}
              key={`${seg}-${i}`}
            >
              {renderSep()}

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
