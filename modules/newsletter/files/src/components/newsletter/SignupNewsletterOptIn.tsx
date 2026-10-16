"use client";

import { useEffect, useState } from "react";
import { SIGNUP_MODE } from "@/lib/constants";
import { clearPendingOptIn, savePendingOptIn } from "@/lib/newsletter/intent";

/**
 * The optional "email me updates" box on the sign-up form. Unticked by default.
 * The tick is kept in this browser, tied to the email typed, and applied once the person is signed in.
 */
export function SignupNewsletterOptIn({ email }: { email: string }) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (checked && email.includes("@")) savePendingOptIn(email);
    else clearPendingOptIn();
  }, [checked, email]);

  // Before sign-ups need a confirmed email, a tick would not prove the address is theirs, so the box is not shown.
  if (SIGNUP_MODE !== "verified") return null;

  return (
    <label className="flex items-start gap-3 min-h-[44px] cursor-pointer text-sm">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
      <span>Email me product updates (optional)</span>
    </label>
  );
}
