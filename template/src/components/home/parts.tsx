import Link from "next/link";
import { NavIcon } from "@/components/NavIcon";
import { BRAND } from "@/lib/constants";
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

/**
 * A picture of the app: a small browser window with sample rows of the app's main screen.
 * It must read as a picture, never as a working screen: no input boxes, no buttons, only static lines and chips.
 * The whole figure is hidden from screen readers and cannot be focused or clicked (aria-hidden + inert).
 */
export function HomePreview({ content, caption = "What it looks like inside" }: { content: HomeContent; caption?: string }) {
  const { title, rows } = content.preview;
  return (
    <figure className="hm-figure" aria-hidden="true" inert>
      <div className="card hm-window">
        <div className="hm-window-bar">
          <span className="hm-window-dots">
            <span className="hm-window-dot" />
            <span className="hm-window-dot" />
            <span className="hm-window-dot" />
          </span>
          <span className="hm-window-name">{BRAND.name}</span>
        </div>
        <div className="hm-window-body">
          <p className="hm-window-title">{title}</p>
          <ul className="hm-window-rows">
            {rows.slice(0, 5).map((row) => (
              <li key={row.title} className="hm-window-row">
                <span className="hm-dot" />
                <span className="hm-window-row-title">{row.title}</span>
                <span className="hm-chip">{row.meta}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <figcaption className="hm-caption">{caption}</figcaption>
    </figure>
  );
}
