"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_THEME } from "@/lib/theme";

type Theme = "light" | "dark" | "system";

const NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Auto" };
const EVENT = "themechange";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private windows can block storage; the app's default look is used.
  }
  return DEFAULT_THEME;
}

/** Same rule as the inline script in layout.tsx, so the page and the button never disagree. */
function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

function setTheme(theme: Theme) {
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Not saved, but it still changes for this visit.
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  // "Auto" follows the phone or computer setting while the page is open.
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onOS = () => {
    if (readTheme() === "system") applyTheme("system");
    onChange();
  };
  mq.addEventListener("change", onOS);
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    mq.removeEventListener("change", onOS);
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const Icon = ({ theme }: { theme: Theme }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {theme === "light" ? (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ) : theme === "dark" ? (
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
    ) : (
      <>
        <rect x="2" y="4" width="20" height="13" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    )}
  </svg>
);

/** Cycles Light, Dark, Auto. The choice is remembered in this browser. */
export function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => DEFAULT_THEME as Theme);
  const label = LABEL[theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT[theme])}
      className="btn btn-ghost px-3"
      aria-label={`Theme: ${label}. Press to change.`}
      title={`Theme: ${label}`}
    >
      <Icon theme={theme} />
      {showLabel ? <span>{label}</span> : null}
    </button>
  );
}
