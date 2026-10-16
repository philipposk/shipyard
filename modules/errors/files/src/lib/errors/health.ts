import "server-only";
import { errorsResult, errorsUnreadable } from "./core.mjs";
import { countOpenProblems } from "./store";

/** Added to the admin Health page's list of checks (src/lib/health/checks.ts) when the errors module is added. */
export const errorsHealthChecks = [
  {
    id: "errors-24h",
    label: "Errors in the last 24 hours",
    run: async () => {
      try {
        return errorsResult(await countOpenProblems(24));
      } catch {
        return errorsUnreadable();
      }
    },
  },
];
