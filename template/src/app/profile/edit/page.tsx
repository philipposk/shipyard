import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/session";
import { ensureProfile } from "@/lib/auth/ensure-profile";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Your profile" };

export default async function ProfileEditPage() {
  const user = await getSessionUser();
  let profile: { display_name: string | null; bio: string | null; onboarding_complete: boolean } | null = null;
  if (user) {
    const supabase = await createSupabaseServer();
    const read = () =>
      supabase.from("profiles").select("display_name, bio, onboarding_complete").eq("id", user.id).maybeSingle();
    let { data } = await read();
    // No row yet (the app has no sign-up trigger, for example when it shares a Supabase project): create it.
    if (!data && (await ensureProfile(user.id, user.email))) data = (await read()).data;
    profile = data;
  }
  const finished = profile?.onboarding_complete === true;

  return (
    // While the profile is unfinished the navigation stays hidden so there is one clear thing to do.
    <AppShell signedIn nav={finished} userLabel={user?.email ?? undefined}>
      <h1 className="page-title mb-6">{finished ? "Edit your profile" : "Complete your profile"}</h1>
      <ProfileForm initialName={profile?.display_name ?? ""} initialBio={profile?.bio ?? ""} finished={finished} />
    </AppShell>
  );
}
