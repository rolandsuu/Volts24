export type DevBypassUser = {
  id: string;
  email: string;
  isDevBypass: true;
};

export function isAuthDisabledForDev() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.AUTH_DISABLED_FOR_DEV === "true"
  );
}

export function createDevBypassUser(): DevBypassUser {
  return {
    id: "local-dev",
    email: "local-dev@blooclip.local",
    isDevBypass: true,
  };
}

export function isDevBypassUser(
  user: { isDevBypass?: boolean } | null | undefined
) {
  return user?.isDevBypass === true;
}

export function getUserOwnershipId(
  user: { id: string; isDevBypass?: boolean }
) {
  return isDevBypassUser(user) ? undefined : user.id;
}
