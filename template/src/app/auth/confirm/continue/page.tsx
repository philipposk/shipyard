import type { Metadata } from "next";
import Link from "next/link";
import { parseConfirmParams } from "@/lib/auth/confirm-link.mjs";
import { BRAND } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Continue",
  robots: { index: false, follow: false },
};

const COPY: Record<string, { title: string; button: string }> = {
  recovery: { title: "Set a new password", button: "Continue" },
  signup: { title: "Confirm your email", button: "Confirm my email" },
  email: { title: "Confirm your email", button: "Confirm my email" },
  magiclink: { title: `Sign in to ${BRAND.name}`, button: "Sign in" },
};

/** The page an emailed link opens. Nothing happens until the person presses the button (see /auth/confirm). */
export default async function ConfirmContinuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const link = parseConfirmParams({ get: (name: string) => (typeof raw[name] === "string" ? (raw[name] as string) : null) });

  if (!link) {
    return (
      <main className="mx-auto w-full max-w-[420px] p-4">
        <div className="card card-pad">
          <h1 className="page-title">This link does not work</h1>
          <p className="muted">It may be incomplete. Go back to sign in and ask for a new one.</p>
          <Link href="/sign-in" className="btn btn-primary">
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  const copy = COPY[link.type] ?? { title: "Continue", button: "Continue" };
  return (
    <main className="mx-auto w-full max-w-[420px] p-4">
      <form method="post" action="/auth/confirm" className="card card-pad">
        <h1 className="page-title">{copy.title}</h1>
        <input type="hidden" name="token_hash" value={link.tokenHash} />
        <input type="hidden" name="type" value={link.type} />
        {link.next ? <input type="hidden" name="next" value={link.next} /> : null}
        <button type="submit" className="btn btn-primary">
          {copy.button}
        </button>
      </form>
    </main>
  );
}
