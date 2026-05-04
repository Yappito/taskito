import { LoginForm } from "@/components/auth/login-form";
import { getSafeRedirectPath } from "@/lib/safe-redirect";

/** Login page with stable server-rendered callback handling. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const resolvedSearchParams = await searchParams;

  return <LoginForm callbackUrl={getSafeRedirectPath(resolvedSearchParams.callbackUrl)} />;
}
