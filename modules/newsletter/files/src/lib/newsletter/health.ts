import "server-only";
import { sendingResult, secretResult } from "./core.mjs";

/** Added to the admin Health page's list of checks (src/lib/health/checks.ts) when the newsletter module is added. */
export const newsletterHealthChecks = [
  {
    id: "newsletter-sending",
    label: "Newsletter: sending",
    run: async () => sendingResult(process.env),
  },
  {
    id: "newsletter-links",
    label: "Newsletter: unsubscribe links",
    run: async () => secretResult(process.env),
  },
];
