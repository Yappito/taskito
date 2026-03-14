import { auth, signOut } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { SearchModal } from "@/components/ui/search-modal";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/** Dashboard layout — requires authentication */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--color-bg)" }}>
      {/* Top navbar */}
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{
          backgroundColor: "var(--color-bg-overlay)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-lg font-bold"
              style={{ color: "var(--color-text)" }}
            >
              Taskito
            </Link>
            {session.user?.role === "admin" && (
              <Link
                href="/settings"
                className="text-sm transition-colors hover:opacity-80"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Settings
              </Link>
            )}
          </div>
          <div className="flex items-center gap-3">
            <SearchModal />
            <ThemeToggle />
            <span
              className="text-sm"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {session.user?.name ?? session.user?.email}
            </span>
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
                  backgroundColor: "var(--color-bg-muted)",
                  color: "var(--color-text-secondary)",
                }}
              >
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main>{children}</main>
    </div>
  );
}
