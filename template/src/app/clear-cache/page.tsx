"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Step = { label: string; done: boolean };

export default function ClearCachePage() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void (async () => {
      const progress: Step[] = [];

      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
        progress.push({ label: "Service workers removed", done: true });
      }

      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        progress.push({ label: "Browser caches cleared", done: true });
      }

      setSteps(progress);
      setDone(true);
      window.setTimeout(() => window.location.replace("/"), 2000);
    })();
  }, []);

  return (
    <main id="main-content" className="max-w-lg mx-auto px-6 py-12 text-center">
      <h1 className="page-title mb-4">Clearing site data</h1>
      <ul className="space-y-2 text-sm mb-8">
        {steps.map((step) => (
          <li key={step.label}>{step.done ? "✓" : "…"} {step.label}</li>
        ))}
      </ul>
      {done && <p className="text-sm" style={{ color: "var(--muted)" }}>Redirecting…</p>}
      <p className="mt-8 text-xs" style={{ color: "var(--muted)" }}>
        <Link href="/" className="underline" style={{ color: "var(--accent)" }}>Open home</Link>
      </p>
    </main>
  );
}
