import { NextResponse } from "next/server";

import { isAuthDisabledForDev } from "@/lib/dev-auth";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (isAuthDisabledForDev()) {
    return NextResponse.redirect(new URL("/", request.url), {
      status: 303,
    });
  }

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  return NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
}
