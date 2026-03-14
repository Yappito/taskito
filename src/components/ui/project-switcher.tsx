"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
import type { ProjectSwitcherOption } from "@/lib/types";

interface ProjectSwitcherProps {
  currentProjectSlug: string;
  projects: ProjectSwitcherOption[];
  disabled?: boolean;
}

/** Project selector that navigates between project-scoped routes. */
export function ProjectSwitcher({
  currentProjectSlug,
  projects,
  disabled = false,
}: ProjectSwitcherProps) {
  const router = useRouter();

  return (
    <div className="min-w-[15rem]">
      <label htmlFor="project-switcher" className="sr-only">
        Select project
      </label>
      <Select
        id="project-switcher"
        aria-label="Select project"
        value={currentProjectSlug}
        disabled={disabled}
        onChange={(event) => {
          const nextSlug = event.target.value;
          if (nextSlug === currentProjectSlug) return;
          router.push(`/${nextSlug}`);
        }}
        className="h-10 rounded-xl border-0 pr-9 text-sm font-semibold shadow-none"
        style={{
          backgroundColor: "var(--color-surface)",
          color: "var(--color-text)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.slug}>
            {project.key} - {project.name}
          </option>
        ))}
      </Select>
    </div>
  );
}