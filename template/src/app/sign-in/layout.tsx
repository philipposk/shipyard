import type { Metadata } from "next";
import { Suspense } from "react";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<main className="p-6 text-center">Loading…</main>}>{children}</Suspense>;
}
