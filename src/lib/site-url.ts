import { headers } from "next/headers";

export async function getRequestOrigin() {
  const headerStore = await headers();
  const origin = headerStore.get("origin");

  if (origin) {
    return origin;
  }

  const forwardedHost = headerStore.get("x-forwarded-host");
  const host = forwardedHost ?? headerStore.get("host");

  if (host) {
    const protocol = headerStore.get("x-forwarded-proto") ?? "http";
    return `${protocol}://${host}`;
  }

  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}
