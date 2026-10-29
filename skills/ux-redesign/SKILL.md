---
name: ux-redesign
description: "Rethink how an app works on a phone (or computer): too many buttons, several AI assistants in different places, confusing navigation, a busy live or detail screen, long flows. Use for \"UX\", \"redesign the mobile app\", \"simplify the UI\", \"mockups\", \"too many buttons\", \"merge the assistants\", \"new layout\", \"/shipyard:ux-redesign\". Not for colours and fonts (use design)."
---

# Shipyard UX redesign

> Part of the Shipyard plugin. If it was installed by itself (for example through skills.sh, ClawHub, Hermes, pi or aiden) and Shipyard's `scripts/` folder is not on this computer, install the full plugin first by following https://github.com/philipposk/shipyard/blob/main/INSTALL.md. Steps 1 to 5 need only a browser and Node; step 6 builds in the student's own repo.

You turn a cluttered app into a calm one: an audit from the code, real user workflows with step counts, patterns from similar products, 6 to 12 phone mockups the student can look at, and then small pull requests behind a beta switch so the old layout keeps working. Colours and fonts belong to the `design` skill; this skill moves, merges and removes things.

## Rules (always)

- Read the code before proposing anything. Every claim in the audit names the file it came from.
- Every proposal comes with a step count: current vs proposed, per workflow.
- Show mockups and get a yes before building. Never merge; the student merges.
- A look (theme) changes how things look. A layout changes where things are and what is shown. Keep them as two separate settings (see `references/patterns.md`, "Themes vs layout").
- Say which skills and tools you actually ran, and which you skipped and why.

## 1. Audit from code

Write `ux-audit.md` in a scratch folder (not the repo). List, with file paths:
- Navigation: every bottom-bar item, sidebar entry, header button, per screen size.
- AI entry points: every place the user can ask an AI (tabs, widgets, floating buttons, live panels). More than one is the most common problem.
- Creation entry points: upload, record, paste link, import, connect. Count how many places each appears.
- Sheets, modals, drawers, and what opens them.
- The busiest screens (live, detail, editor): count visible controls at 390x844.
Read the app's `DESIGN.md` / `PRODUCT.md` if present.

## 2. People and workflows

3 to 4 personas, 5 to 6 workflows (for example: record a meeting and get the action items; upload a file; paste a link; ask across everything; find an old item; share). For each: current steps (counted from the code) and proposed steps. Put it in a table; the totals are the headline.

## 3. Look at similar products

Web research, not memory, for 4 to 6 products that solve the same problem (not only direct competitors: AI chat apps, notes apps, task apps). For each, one pattern worth copying and its source link. Mark anything from memory as such. `references/patterns.md` has the patterns that held up last time.

## 4. Principles

Write 5 to 7 principles the mockups must obey, starting from the defaults in `references/patterns.md` (one AI entry point scoped to context with citations; Home, +, Actions bar plus an avatar drawer; one + sheet with smart defaults; a calm live screen with at most 5 controls; summary-first detail screens; processing screens that are useful while waiting). Drop any that do not fit this app.

## 5. Mockups

Static HTML, one file per screen, phone frame 390x844, the app's real colours from its CSS tokens. Name them `01-home.html` ... Then screenshot each with Playwright and build `index.html` showing all screens with a one-line reason under each and the workflow table. Script: `references/shot.mjs`. Look at every PNG yourself before sending.

If the Superdesign CLI is installed and signed in, generate 2 to 3 of the screens there as a second opinion and link the project. If its setup step fails, say so and continue with the HTML.

For ideas, use an ideation skill (for example ce-ideate or brainstorming) if installed; a light single pass is fine when usage is tight. Say which.

Send: the index link or screenshots, the step-count table, and a short "what changes" list. Ask which direction to build.

## 6. Build behind a beta switch

- First PR: groundwork only (lint/test scripts, shared helpers the later PRs need).
- Add a setting "New layout (beta)", off by default, separate from the theme picker. One attribute on `<html>` (for example `data-layout="v2"`) set before paint, so there is no flash.
- One PR per principle, stacked in order: one AI, navigation, + sheet, live screen, detail screen, cross-item list (Actions), then desktop.
- Each PR: unit tests, type check, build, the app's end-to-end tests (note failures that also fail on main), phone screenshots at 390x844 in the PR body, and what was and was not tested (for example "not tried on a real phone").
- Review each PR before opening it (a code-review skill, or by hand against the diff if the skill's files are missing; say which), then verification-before-completion.

## 7. Common mistakes

See `references/patterns.md`, "Pitfalls". Check each before saying a PR is ready.

## 8. Lessons from the first phone test (Catchy v2, Oct 2026)

- **Legacy widgets leak into the new layout.** Anything mounted outside React (a vendored chat bubble on `<body>`, a shadow-DOM host) survives the layout switch, so you get two AIs on screen. Call the widget's own `destroy()` on unmount, *and* add a CSS backstop scoped to the new layout (`html[data-layout="v2"] #widget-root{display:none!important}`). Test it by asserting both exist.
- **Sheets must be keyboard-safe.**
  - Make them opaque, not translucent over the page.
  - Size them from `visualViewport` (a `--vh` var updated on `resize` and `scroll`), not `100vh`/`dvh`, so the input stays above the iOS keyboard.
  - Hide the bottom bar and FAB while open (`html.sheet-open`).
  - Screenshot with a simulated keyboard (shrink the viewport height) as well as without.
- **`[hidden]` loses to your own `display:` rules.** A collapsible group with `display:revert`/`flex` never collapses. Add `.x[hidden]{display:none}` and test the toggle.
- **Tab switches must feel instant.**
  - Use the framework's client links, not plain `<a>`.
  - Light the tab optimistically and add `loading.tsx` skeletons.
  - Measure before and after at 390px with 4x CPU throttle: time until the tab is lit and until the page has painted.
- **Settings information architecture** (Linear, Notion, Slack, ChatGPT, Claude all converge on this):
  - Grouped sections (Preferences / AI / Account).
  - On phones, a drill-in list (`/settings` *is* the list; each section has `‹ Settings` + title).
  - On desktop, a left sidebar. Never a long horizontal tab strip.
  - Appearance is its own section.
  - Content that isn't a setting (templates, libraries) belongs in the main navigation.
- **Theme customisation:**
  - Offer a few knobs (accent, background presets, text tone, font, size, radius, density), as Radix Themes and the ChatGPT appearance editor do, rather than every token.
  - Save them to the account (auth metadata, no migration) and render them as a sanitised `<style>` on the server, so there is no flash.
  - Warn on low contrast.
- **Copy that assumes context:** "Open the app" inside the app, or a help link that leaves the app. Grep the i18n files for it.
- **Connect / setup steps:** one instruction line, one copy block (copy icon in the corner → "Copied"), and "More details" for the rest.
- **Helper scripts that `git checkout` files** (screenshot shims that patch layout or middleware) silently drop your uncommitted edits to those files. Commit first, or re-check `git diff` after turning the shim off.
