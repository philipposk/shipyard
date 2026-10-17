import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { SUPABASE_SCHEMA } from "@/lib/supabase/schema.mjs";
import { ensureProfile } from "@/lib/auth/ensure-profile";
import { parseProfileInput } from "@/lib/validate.mjs";

/**
 * Supabase for this request: the login cookie normally, or an `Authorization: Bearer <access token>` header
 * (used by scripts and the Shipyard verify tool). Either way every query runs as that user, under the privacy rules (RLS).
 */
async function supabaseForRequest(request: Request) {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return createSupabaseServer();
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
    db: { schema: SUPABASE_SCHEMA },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
  });
}

async function currentUser(request: Request) {
  const supabase = await supabaseForRequest(request);
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const {
    data: { user },
  } = await supabase.auth.getUser(bearer);
  return { supabase, user };
}

export async function GET(request: Request) {
  const { supabase, user } = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const read = () => supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  let { data: profile } = await read();
  // No row yet (the app has no sign-up trigger, for example when it shares a Supabase project): create it.
  if (!profile && (await ensureProfile(user.id, user.email))) profile = (await read()).data;

  return NextResponse.json({ profile, user: { id: user.id, email: user.email } });
}

export async function PATCH(request: Request) {
  const { supabase, user } = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = parseProfileInput(await request.json().catch(() => null));
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // Only these columns are ever written. is_admin is not here, and the database refuses it anyway.
  const values = { ...parsed.value, onboarding_complete: true };
  const save = () => supabase.from("profiles").update(values).eq("id", user.id).select().maybeSingle();
  let updated = await save();
  // No row yet: create it with the server key, then save again.
  if (!updated.error && !updated.data && (await ensureProfile(user.id, user.email))) updated = await save();
  if (updated.error) return NextResponse.json({ error: "Could not save your profile. Try again." }, { status: 400 });
  if (updated.data) return NextResponse.json({ profile: updated.data });

  // Last resort when the server key is not available: create the row with the person's own login.
  const created = await supabase.from("profiles").insert({ id: user.id, ...values }).select().single();
  if (created.error) return NextResponse.json({ error: "Could not save your profile. Try again." }, { status: 400 });
  return NextResponse.json({ profile: created.data });
}
