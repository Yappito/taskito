"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Skeleton, SkeletonGroup } from "@/components/ui";
import { AppearanceSettingsSection } from "@/components/settings/appearance-settings";
import { PersonalAiSettings } from "@/components/settings/personal-ai-settings";
import { ProfileSettings } from "@/components/settings/profile-settings";

const StorageSettings = dynamic(
  () => import("@/components/settings/storage-settings").then((m) => m.StorageSettings),
  { ssr: false, loading: () => <TabLoading /> }
);
const ProjectManagement = dynamic(
  () => import("@/components/settings/project-management").then((m) => m.ProjectManagement),
  { ssr: false, loading: () => <TabLoading /> }
);
const UserManagement = dynamic(
  () => import("@/components/settings/user-management").then((m) => m.UserManagement),
  { ssr: false, loading: () => <TabLoading /> }
);
const GroupManagement = dynamic(
  () => import("@/components/settings/group-management").then((m) => m.GroupManagement),
  { ssr: false, loading: () => <TabLoading /> }
);
const AuthProviderSettings = dynamic(
  () => import("@/components/settings/auth-provider-settings").then((m) => m.AuthProviderSettings),
  { ssr: false, loading: () => <TabLoading /> }
);

const allTabs = ["profile", "appearance", "ai", "storage", "projects", "users", "groups", "auth"] as const;
type SettingsTab = (typeof allTabs)[number];
const memberTabs: SettingsTab[] = ["profile", "appearance", "ai"];

function TabLoading() {
  return (
    <div className="py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
      Loading...
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <SkeletonGroup className="space-y-4">
      <Skeleton className="h-9 w-40 rounded-lg" />
      <Skeleton className="h-12 rounded-xl" />
      <Skeleton className="h-72 rounded-2xl" />
    </SkeletonGroup>
  );
}

/** Settings page — tab shell; each tab is a component under components/settings */
export default function SettingsPage() {
  const { data: currentUser, isLoading } = trpc.user.me.useQuery();
  const [tab, setTab] = useState<SettingsTab>("profile");

  if (isLoading || !currentUser) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <SettingsSkeleton />
      </div>
    );
  }

  const isAdmin = currentUser.role === "admin";
  const tabs: SettingsTab[] = isAdmin ? [...allTabs] : memberTabs;
  // Members never get admin tabs; resolve instead of resetting via effect.
  const effectiveTab: SettingsTab = tabs.includes(tab) ? tab : "profile";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1
        className="text-2xl font-bold mb-6"
        style={{ color: "var(--color-text)" }}
      >
        Settings
      </h1>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex gap-1 overflow-x-auto rounded-lg p-1 mb-6"
        style={{ backgroundColor: "var(--color-bg-muted)" }}
      >
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={effectiveTab === t}
            onClick={() => setTab(t)}
            className="min-w-fit flex-1 rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors whitespace-nowrap"
            style={
              effectiveTab === t
                ? {
                    backgroundColor: "var(--color-surface)",
                    color: "var(--color-text)",
                    boxShadow: "var(--shadow-sm)",
                  }
                : { color: "var(--color-text-secondary)" }
            }
          >
            {t === "profile" ? "Profile" : t}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {effectiveTab === "profile" && <ProfileSettings key={currentUser.id} currentUser={currentUser} />}
        {effectiveTab === "appearance" && <AppearanceSettingsSection />}
        {effectiveTab === "ai" && <PersonalAiSettings currentUserRole={currentUser.role} />}
        {effectiveTab === "storage" && isAdmin && <StorageSettings />}
        {effectiveTab === "projects" && isAdmin && <ProjectManagement />}
        {effectiveTab === "users" && isAdmin && <UserManagement currentUserId={currentUser.id} />}
        {effectiveTab === "groups" && isAdmin && <GroupManagement />}
        {effectiveTab === "auth" && isAdmin && <AuthProviderSettings />}
      </div>
    </div>
  );
}
