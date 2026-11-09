# shadcn components in a Shipyard app (without breaking the look)

Shipyard apps get their colours from theme packs and switch mode with `data-theme` on `<html>`. A plain `npx shadcn init` writes a static token block that breaks that.

## What a naive init breaks

- It redefines `--muted`, `--accent`, `--card`, `--border` (names Shipyard already uses,
  with different meanings) as fixed `oklch()` values, so accents, muted text and card
  surfaces freeze to shadcn's neutral palette and every pack loses its colours.
- It adds a `.dark { ... }` block, but Shipyard apps mark dark mode with
  `data-theme="dark"`, so the block is dead code and `dark:` variants never activate.
- It adds its own font (Geist) that fights the app's `--app-font` system.

## The recipe

1. **Remove** the generated token block inside `:root` (the `oklch` values) and the trailing
   `.dark { ... }` block.
2. **Keep** `components.json`, the `cn` util (`export { cn } from "cn"`), the
   `@import "tw-animate-css";` and `@import "shadcn/tailwind.css";` lines.
3. **Key the dark variant to Shipyard's attribute**, not a class:

   ```css
   @custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
   ```

4. **Map shadcn's tokens onto Shipyard's variables** in `@theme inline`. `inline` keeps the
   `var()` references runtime-resolved, so pack and mode switches flow through automatically:

   ```css
   @theme inline {
     --color-background: var(--background);
     --color-foreground: var(--foreground);
     --color-card: var(--card);
     --color-card-foreground: var(--foreground);
     --color-popover: var(--card);
     --color-popover-foreground: var(--foreground);
     --color-primary: var(--accent);          /* the app's one accent colour */
     --color-primary-foreground: var(--accent-contrast);
     --color-secondary: var(--accent-soft);
     --color-secondary-foreground: var(--foreground);
     --color-muted: var(--card);              /* bg-muted = a surface, NOT the muted text colour */
     --color-muted-foreground: var(--muted);  /* text-muted-foreground = Shipyard's muted text */
     --color-accent: var(--accent-soft);
     --color-accent-foreground: var(--accent);
     --color-destructive: var(--danger);
     --color-destructive-foreground: var(--danger-contrast);
     --color-border: var(--border);
     --color-input: var(--border);
     --color-ring: var(--focus);
     --color-sidebar: var(--card);
     --color-sidebar-foreground: var(--foreground);
     --color-sidebar-border: var(--border);
     --color-sidebar-accent: var(--accent-soft);
     --color-sidebar-accent-foreground: var(--accent);
     --color-sidebar-primary: var(--accent);
     --color-sidebar-primary-foreground: var(--accent-contrast);
     --color-sidebar-ring: var(--focus);
     --radius-sm: calc(var(--radius) * 0.75);
     --radius-md: var(--radius);
     --radius-lg: calc(var(--radius) * 1.25);
     --radius-xl: calc(var(--radius) * 1.5);
     --radius-2xl: calc(var(--radius) * 1.75);
     --radius-3xl: calc(var(--radius) * 2);
     --radius-4xl: calc(var(--radius) * 2.5);
   }
   ```

   Watch the two name collisions: shadcn's `--muted` is a BACKGROUND surface while Shipyard's
   `--muted` is a TEXT colour, and shadcn's `--accent` is a soft hover background while
   Shipyard's `--accent` is the brand colour. Map them as above, never rename Shipyard's.

5. Extend the existing `@theme inline` block in `globals.css`. Do not add a second one, and do not set `--font-sans` again (the template already maps it to `--app-font`).

## Verification

After integrating, check all of these in a browser:

- Every pack this app actually has, in light, dark and Auto. The template's control is the cycle button `ThemeToggle` (`aria-label` starts with `Theme:`), not a radio group.
- `bg-primary` controls follow the pack accent; `text-muted-foreground` stays readable.
- `dark:` variants change with the mode switch (they follow `data-theme`, not a class).
- `npm run check:design`, `npm test`, `npm run build` still pass.

## Notes on shadcn v4

- Primitive library is `@base-ui/react` (not Radix), styles via `class-variance-authority`,
  class joining via the `cn` package. No `clsx`/`tailwind-merge` boilerplate.
- The shadcn MCP server config for VSCode is `.vscode/mcp.json`
  (`npx shadcn@latest mcp init --client vscode`); it is editor config and safe to commit.
- AI builders (v0 and friends) generate plausible-looking but broken integrations. Treat
  their output as a draft: delete the token block, apply this recipe, then run the checks.
