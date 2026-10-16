import Link from "next/link";
import { NavIcon } from "@/components/NavIcon";
import type { NavIconName } from "@/lib/nav";
import type { HomeContent } from "@/lib/home-content";

/** Pieces shared by the five home patterns. */

export function HomeActions({ content, className = "" }: { content: HomeContent; className?: string }) {
  return (
    <div className={`hm-actions ${className}`.trim()}>
      <Link href={content.ctaPrimary.href} className="btn btn-primary">
        {content.ctaPrimary.label}
      </Link>
      <Link href={content.ctaSecondary.href} className="btn btn-secondary">
        {content.ctaSecondary.label}
      </Link>
    </div>
  );
}

export function HomeTile({ icon }: { icon: NavIconName }) {
  return (
    <span className="hm-tile" aria-hidden="true">
      <NavIcon name={icon} size={20} />
    </span>
  );
}

export function Arrow({ className = "hm-arrow" }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg className="hm-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
