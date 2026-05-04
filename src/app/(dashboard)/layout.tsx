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
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || "T";

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--color-bg)" }}>
      <aside
        className="fixed inset-y-0 left-0 z-40 hidden w-72 flex-col border-r px-4 py-5 lg:flex"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--color-bg-elevated) 92%, var(--color-accent)) 0%, var(--color-bg-elevated) 42%, var(--color-bg) 100%)",
          borderColor: "var(--color-border)",
        }}
      >
        <Link href="/" className="group rounded-2xl border p-4 transition-colors" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
          <div className="flex items-center gap-3">
            <span
              className="grid h-11 w-11 place-items-center rounded-2xl text-sm font-bold text-white"
              style={{ background: "linear-gradient(135deg, var(--color-accent), var(--color-info))" }}
            >
              T
            </span>
            <div>
              <div className="text-base font-bold" style={{ color: "var(--color-text)" }}>Taskito</div>
              <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>Project command center</div>
            </div>
          </div>
        </Link>

        <nav className="mt-6 space-y-2 text-sm">
          <Link
            href="/"
            className="flex items-center justify-between rounded-2xl px-3 py-3 font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text)" }}
          >
            <span>Workspace</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" }}>
              Live
            </span>
          </Link>
          <Link
            href="/settings"
            className="flex items-center justify-between rounded-2xl px-3 py-3 font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            <span>Settings</span>
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Profile</span>
          </Link>
        </nav>

        <div className="mt-6 rounded-3xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
          <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>Focus</p>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
            Use search for task jumps, board for delivery, and graph for dependency risk.
          </p>
        </div>

        <div className="mt-auto rounded-3xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <div className="flex items-center gap-3">
            <Avatar name={session.user?.name} email={session.user?.email} image={session.user?.image} size="md" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold" style={{ color: "var(--color-text)" }}>{userLabel}</div>
              <div className="text-xs capitalize" style={{ color: "var(--color-text-muted)" }}>{session.user?.role ?? "member"}</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-72">
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
              className="grid h-9 w-9 place-items-center rounded-xl text-xs font-bold text-white lg:hidden"
              style={{ background: "linear-gradient(135deg, var(--color-accent), var(--color-info))" }}
            >
              {userInitial}
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
