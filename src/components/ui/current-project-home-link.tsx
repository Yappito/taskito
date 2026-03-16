"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LAST_PROJECT_SLUG_KEY = "taskito-last-project-slug";
const RESERVED_SEGMENTS = new Set(["api", "login", "settings"]);

function getProjectSlugFromPath(pathname: string) {
  const [firstSegment] = pathname.split("/").filter(Boolean);
  if (!firstSegment || RESERVED_SEGMENTS.has(firstSegment)) {
    return null;
  }

  return firstSegment;
}

export function CurrentProjectHomeLink() {
  const pathname = usePathname();
  const currentProjectSlug = useMemo(() => getProjectSlugFromPath(pathname), [pathname]);
  const [href, setHref] = useState("/");

  useEffect(() => {
    if (currentProjectSlug) {
      window.localStorage.setItem(LAST_PROJECT_SLUG_KEY, currentProjectSlug);
      setHref(`/${currentProjectSlug}`);
      return;
    }

    const lastProjectSlug = window.localStorage.getItem(LAST_PROJECT_SLUG_KEY);
    setHref(lastProjectSlug ? `/${lastProjectSlug}` : "/");
  }, [currentProjectSlug]);

  return (
    <Link
      href={href}
      className="text-lg font-bold"
      style={{ color: "var(--color-text)" }}
    >
      Taskito
    </Link>
  );
}