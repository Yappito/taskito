"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

const LAST_PROJECT_SLUG_KEY = "taskito-last-project-slug";
const RESERVED_SEGMENTS = new Set(["api", "login", "no-access", "settings"]);

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
  const { data: projects } = trpc.project.list.useQuery(undefined, {
    enabled: !!currentProjectSlug,
  });
  const currentProject = projects?.find((project) => project.slug === currentProjectSlug);
  const title = currentProject?.name ?? "Taskito";
  const description = currentProject?.description?.trim() || (!currentProjectSlug ? "Plan, deliver, inspect, and recover work from one workspace." : null);

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
    <>
      <Link
        href={href}
        className="truncate text-lg font-bold"
        style={{ color: "var(--color-text)" }}
      >
        {title}
      </Link>
      {description && (
        <span className="hidden max-w-xl truncate text-xs md:block" style={{ color: "var(--color-text-muted)" }}>
          {description}
        </span>
      )}
    </>
  );
}
