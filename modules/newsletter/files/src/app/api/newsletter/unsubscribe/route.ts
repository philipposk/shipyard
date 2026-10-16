import { NextResponse } from "next/server";
import { looksLikeToken } from "@/lib/newsletter/core.mjs";
import { unsubscribeByToken } from "@/lib/newsletter/store";

export const runtime = "nodejs";

// Unsubscribe without signing in: the secret token in the link is the key. src/proxy.ts lets this path through.
// There is no same-site check on purpose: mail programs (Gmail, Apple Mail, Yahoo) call it themselves.

function tokenFrom(request: Request): string {
  return (new URL(request.url).searchParams.get("token") ?? "").trim();
}

// Opening the link in a browser (or a mail scanner opening it) only shows the page with the button.
// It never unsubscribes on its own, so a scanner can not remove someone by accident.
export async function GET(request: Request) {
  const token = tokenFrom(request);
  const target = new URL("/unsubscribe", request.url);
  if (token) target.searchParams.set("token", token);
  return NextResponse.redirect(target, 303);
}

// One click: the "Unsubscribe" button of mail programs sends "List-Unsubscribe=One-Click" here (RFC 8058),
// and the button on the /unsubscribe page does the same.
export async function POST(request: Request) {
  const token = tokenFrom(request);
  if (!looksLikeToken(token)) return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
  try {
    const result = await unsubscribeByToken(token);
    if (result === "invalid") return NextResponse.json({ error: "This link is not valid." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not unsubscribe you just now. Try again in a minute." }, { status: 500 });
  }
}
