function normalizeIpHeaderValue(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized || /[\u0000-\u001f\u007f,]/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function getClientIpFromHeaders(headers: Pick<Headers, "get">) {
  const realIp = normalizeIpHeaderValue(headers.get("x-real-ip"));
  if (realIp) {
    return realIp;
  }

  const forwardedFor = headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((entry) => normalizeIpHeaderValue(entry))
    .filter((entry): entry is string => Boolean(entry));

  return forwardedFor?.at(-1) ?? "unknown";
}
