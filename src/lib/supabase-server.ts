import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabasePublicConfig } from "./supabase-config.ts";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabasePublishableKey } = getSupabasePublicConfig();

  return createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll().map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
        }));
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies; route handlers and proxy can.
        }
      },
    },
  });
}
