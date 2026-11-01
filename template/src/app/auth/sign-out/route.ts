import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { SITE_SLUG } from "@/lib/constants";

/** Sign-out is a POST (a button), so a link or an image on another site cannot sign anyone out. */
export async function POST(request: Request) {
  const supabase = await createSupabaseServer();
  // Local: other apps on the shared Supabase project and other devices keep their sessions.
  await supabase.auth.signOut({ scope: "local" });
  // 303 turns the POST into a GET of the home page.
  const res = NextResponse.redirect(new URL("/", request.url), 303);
  res.cookies.delete(`${SITE_SLUG}_onboarded`);
  return res;
}
