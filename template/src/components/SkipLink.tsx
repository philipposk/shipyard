"use client";

const TARGET_ID = "main-content";

export function SkipLink() {
  return (
    <a
      href={`#${TARGET_ID}`}
      className="skip-link"
      onClick={(event) => {
        const main = document.getElementById(TARGET_ID);
        if (!main) return;
        event.preventDefault();
        main.focus();
        main.scrollIntoView({ block: "start" });
      }}
    >
      Skip to content
    </a>
  );
}
