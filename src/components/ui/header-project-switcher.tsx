"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { ProjectSwitcher } from "@/components/ui/project-switcher";

const RESERVED_SEGMENTS = new Set(["api", "login", "no-access", "settings"]);

function getProjectSlugFromPath(pathname: string) {
  const [firstSegment] = pathname.split("/").filter(Boolean);
  if (!firstSegment || RESERVED_SEGMENTS.has(firstSegment)) {
    return null;
  }

  return firstSegment;
}

export function HeaderProjectSwitcher() {
  const pathname = usePathname();
  const currentProjectSlug = useMemo(() => getProjectSlugFromPath(pathname), [pathname]);
  const { data: projects, isLoading } = trpc.project.list.useQuery(undefined, {
    enabled: !!currentProjectSlug,
  });
  const currentProject = projects?.find((project) => project.slug === currentProjectSlug);

  if (!currentProjectSlug) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ProjectSwitcher
        currentProjectSlug={currentProjectSlug}
        projects={(projects ?? []).map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          key: project.key,
        }))}
        disabled={isLoading || !projects?.length}
      />
      {currentProject && (
        <>
          <span
            className="rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" }}
          >
            {currentProject.key}
          </span>
          <span className="hidden text-xs sm:inline" style={{ color: "var(--color-text-muted)" }}>
            /{currentProject.slug}
          </span>
        </>
      )}
    </div>
  );
}
