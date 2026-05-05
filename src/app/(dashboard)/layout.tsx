import { auth, signOut } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { SearchModal } from "@/components/ui/search-modal";
import { NotificationCenter } from "@/components/ui/notification-center";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { CurrentProjectHomeLink } from "@/components/ui/current-project-home-link";
import { Avatar } from "@/components/ui/avatar";

/** Dashboard layout — requires authentication */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect("/login");
  const userLabel = session.user?.name ?? session.user?.email ?? "User";

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--color-bg)" }}>
      <div>
      <header
        className="sticky top-0 z-30 border-b backdrop-blur-xl"
        style={{
          backgroundColor: "var(--color-bg-overlay)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex min-h-16 flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between lg:px-6">
          <div className="flex items-center gap-3">
            <div
              className="grid h-9 w-9 place-items-center rounded-xl text-xs font-bold text-white"
              style={{ background: "linear-gradient(135deg, var(--color-accent), var(--color-info))" }}
            >
              T
            </div>
            <div className="flex flex-col">
              <CurrentProjectHomeLink />
              <span className="hidden text-xs md:block" style={{ color: "var(--color-text-muted)" }}>
                Plan, deliver, inspect, and recover work from one workspace.
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <SearchModal />
            <NotificationCenter />
            <Link
              href="/settings"
              className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-80"
              style={{
                backgroundColor: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              Settings
            </Link>
            <ThemeToggle />
            <div className="hidden items-center gap-2 rounded-full border px-2.5 py-1.5 md:flex" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
              <Avatar name={session.user?.name} email={session.user?.email} image={session.user?.image} size="sm" />
              <span
                className="max-w-40 truncate text-sm"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {userLabel}
              </span>
            </div>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button
                type="submit"
                className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-80"
                style={{
                  backgroundColor: "var(--color-surface)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                }}
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main>{children}</main>
      </div>
    </div>
  );
}
