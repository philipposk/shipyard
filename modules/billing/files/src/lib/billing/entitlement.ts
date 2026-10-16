import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServer } from "@/lib/supabase/server";
import { PLANS, type Plan } from "./plans";
import { planForSubscription } from "./plans-core.mjs";

/**
 * The plan of the signed-in person. It reads their row with their own login, so the privacy rules apply and it can
 * only ever answer for the person who is asking. No row, a cancelled or unpaid subscription: the free plan.
 */
export async function getPlan(userId: string): Promise<Plan> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase
    .from("subscriptions")
    .select("plan_id, status, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();
  return planForSubscription(data, PLANS);
}

export const isPaidPlan = (plan: Plan): boolean => plan.priceCents > 0;

/**
 * Use at the top of a server route that needs a paid plan:
 *   const gate = await requirePaid();
 *   if (!gate.ok) return gate.response;
 *   // gate.user and gate.plan are set here
 */
export async function requirePaid(): Promise<{ ok: true; user: User; plan: Plan } | { ok: false; response: NextResponse }> {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Sign in first." }, { status: 401 }) };
  const plan = await getPlan(user.id);
  if (!isPaidPlan(plan)) {
    return { ok: false, response: NextResponse.json({ error: "This needs a paid plan.", upgradeUrl: "/pricing" }, { status: 402 }) };
  }
  return { ok: true, user, plan };
}
