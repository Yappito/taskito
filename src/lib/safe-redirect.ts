const SAFE_REDIRECT_BASE = "https://taskito.local";

function isSafeRelativePath(value: string) {
  return value.startsWith("/") && !value.startsWith("//") && !/[\u0000-\u001f\u007f]/.test(value);
}

export function getSafeRedirectPath(value: string | null | undefined, fallback = "/") {
  const safeFallback = isSafeRelativePath(fallback) ? fallback : "/";

  if (!value || !isSafeRelativePath(value)) {
    return safeFallback;
  }

  try {
    const parsed = new URL(value, SAFE_REDIRECT_BASE);
    if (parsed.origin !== SAFE_REDIRECT_BASE) {
      return safeFallback;
    }

    const redirectPath = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return isSafeRelativePath(redirectPath) ? redirectPath : safeFallback;
  } catch {
    return safeFallback;
  }
}
