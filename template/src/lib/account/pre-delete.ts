import "server-only";

/** What a hook gets: the person whose account is about to be deleted. */
export interface PreDeleteContext {
  userId: string;
  email: string | null;
}

/**
 * One step to run before an account is deleted, for things the database cannot clean up by itself
 * (cancel a paid subscription, remove files from another service).
 * `run` throws when it fails: the account is then NOT deleted, and the person sees `label` in the error.
 * A hook must be safe to run twice (the person may try again after a failure).
 */
export interface PreDeleteHook {
  id: string;
  /** Plain English, shown if this step fails: "cancel your subscription". */
  label: string;
  run: (ctx: PreDeleteContext) => Promise<void>;
}

/**
 * Hooks run in this order, one at a time. Modules append to the list (the billing module adds "cancel the
 * Stripe subscription"); Shipyard's add-module finds it by the name PRE_DELETE_HOOKS, so keep the name.
 * Rows in your own tables do not need a hook: a table that points at auth.users with
 * `on delete cascade` is emptied automatically when the account is deleted.
 */
export const PRE_DELETE_HOOKS: PreDeleteHook[] = [];

/** A table that holds one person's rows, and the column that says whose they are. */
export interface AccountDataTable {
  table: string;
  column: string;
}

/**
 * Where this app keeps a person's data. Used only when the app shares its Supabase project with other apps
 * (schema other than `public`): then "delete my account" must NOT delete the sign-in user (the other apps use that
 * login too), so it deletes the person's rows from these tables instead. Add every table that holds personal data:
 * `{ table: "notes", column: "user_id" }`. Modules append their own tables. `profiles` is always deleted last.
 */
export const ACCOUNT_DATA_TABLES: AccountDataTable[] = [
  { table: "items", column: "user_id" },
  { table: "profiles", column: "id" },
];
