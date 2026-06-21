import { redirect } from "next/navigation";

import { getAuthenticatedUser, getSafeNextPath } from "@/lib/auth";
import { getRequestOrigin } from "@/lib/site-url";
import { createSupabaseServerClient } from "@/lib/supabase-server";

type LoginPageProps = {
  searchParams: Promise<{
    next?: string | string[];
    sent?: string | string[];
    email?: string | string[];
    error?: string | string[];
  }>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function sendMagicLink(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const next = getSafeNextPath(formData.get("next"));

  if (!email) {
    redirect(`/login?error=Email is required&next=${encodeURIComponent(next)}`);
  }

  const origin = await getRequestOrigin();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(
        next
      )}`,
    },
  });

  if (error) {
    redirect(
      `/login?error=${encodeURIComponent(
        error.message
      )}&next=${encodeURIComponent(next)}`
    );
  }

  redirect(
    `/login?sent=1&email=${encodeURIComponent(
      email
    )}&next=${encodeURIComponent(next)}`
  );
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = getSafeNextPath(firstParam(params.next));
  const user = await getAuthenticatedUser();

  if (user) {
    redirect(next);
  }

  const sent = firstParam(params.sent) === "1";
  const email = firstParam(params.email);
  const error = firstParam(params.error);

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 text-black">
      <section className="w-full max-w-sm space-y-6">
        <div className="space-y-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-black text-sm font-semibold text-white">
            B
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Sign in to Blooclip
            </h1>
            <p className="mt-2 text-sm leading-6 text-black/55">
              Use your email to keep video jobs and reopen them later.
            </p>
          </div>
        </div>

        <form action={sendMagicLink} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <label htmlFor="email" className="sr-only">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="h-11 w-full rounded-md border border-black/15 px-3 text-sm outline-none transition focus:border-black"
          />
          <button
            type="submit"
            className="h-11 w-full rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/80"
          >
            Send sign-in link
          </button>
        </form>

        {sent && (
          <p className="rounded-md border border-black/10 bg-black/[0.025] p-3 text-sm leading-6 text-black/65">
            Check {email ?? "your inbox"} for a Blooclip sign-in link.
          </p>
        )}

        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
