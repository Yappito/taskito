import { LoginForm } from "@/components/auth/login-form";
import { getSafeRedirectPath } from "@/lib/safe-redirect";
import { getOidcLoginProviders } from "@/server/services/oidc-provider-settings";

/** Login page with stable server-rendered callback handling. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const oidcProviders = await getOidcLoginProviders();

  return <LoginForm callbackUrl={getSafeRedirectPath(resolvedSearchParams.callbackUrl)} oidcProviders={oidcProviders} />;
}
