import { NextResponse } from "next/server";
import { serverSignup } from "@/lib/auth/server-signup";
import { normalizeEmail, passwordProblem } from "@/lib/validate.mjs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });

  const problem = passwordProblem(body?.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const result = await serverSignup(email, body.password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // needsConfirmation: "verified" mode, the person must open the link we emailed before they can sign in.
  return NextResponse.json({ ok: true, userId: result.userId, needsConfirmation: result.needsConfirmation });
}
