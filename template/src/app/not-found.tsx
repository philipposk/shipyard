import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { BRAND } from "@/lib/constants";

export default function NotFound() {
  return (
    <AppShell>
      <div className="text-center py-12">
        <p className="text-6xl font-bold mb-2" style={{ color: "var(--accent)" }}>404</p>
        <h1 className="page-title mb-2">Page not found</h1>
        <p className="text-sm mb-6 muted">This page does not exist in {BRAND.name}.</p>
        <Link href="/" className="btn btn-primary">
          Back home
        </Link>
      </div>
    </AppShell>
  );
}
