import { createSupabaseBrowser } from "@/lib/supabase/client";

/**
 * Google refuses to sign people in inside a phone app's built-in browser. In the phone app, "Continue with
 * Google" opens the phone's own browser instead and comes back to the app on this address.
 * Written by Shipyard add-shell. The address must stay the same as the app id in mobile/capacitor.config.json.
 */
export const APP_CALLBACK = "__APP_ID__://auth/callback";

type CapacitorGlobal = { isNativePlatform?: () => boolean };

/** True only inside the phone app (the Capacitor shell). Always false in a normal browser. */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/** `<app id>://auth/callback?code=...` becomes `https://<your site>/auth/callback?code=...`, or null for any other address. */
export function toWebCallback(raw: string, origin: string): string | null {
  if (!raw.startsWith(APP_CALLBACK)) return null;
  const hashAt = raw.indexOf("#");
  const queryAt = raw.indexOf("?");
  const target = new URL("/auth/callback", origin);
  if (queryAt !== -1) {
    const query = hashAt > queryAt ? raw.slice(queryAt + 1, hashAt) : raw.slice(queryAt + 1);
    new URLSearchParams(query).forEach((value, key) => {
      target.searchParams.append(key, value);
    });
  }
  if (hashAt !== -1) target.hash = raw.slice(hashAt);
  return target.toString();
}

/**
 * Starts Google sign-in in the phone's browser. Returns true when it took over (inside the phone app),
 * false when the normal web sign-in should run.
 */
export async function signInGoogleNative(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { data, error } = await createSupabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: APP_CALLBACK, skipBrowserRedirect: true },
    });
    if (error || !data?.url) throw error ?? new Error("No sign-in address came back.");
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url: data.url });
  } catch (err) {
    console.error("Google sign-in could not start in the phone app.", err);
  }
  return true;
}
