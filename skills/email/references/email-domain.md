# Email on your own domain

What works in production (6x7.gr, October 2026): domain at Papaki, ImprovMX free plan forwards every `@6x7.gr` address (a catch-all) to one Gmail, Resend sends the apps' emails, and Gmail "Send mail as" over Google's own SMTP lets the owner reply as `hello@6x7.gr`. Sections marked **new, untested in production** are written from provider docs, not from that setup.

The pieces do not clash: forwarding uses MX records on the main domain; Resend uses `send.<domain>` (return path) and a `resend._domainkey` DKIM record.

## 1. DNS: where to paste records

Open the registrar's DNS page for the domain and add each record exactly. The **name/host** is the part before the domain: `@` (or empty) for the domain itself, `_dmarc` for DMARC. Never type the full domain in the name field: many registrars add it again (`_dmarc.example.com.example.com`).

- **Papaki** (used for 6x7.gr): the domain's DNS management page in the Papaki account. Record type is "Τύπος εγγραφής", name is "Όνομα / Host / Alias", the value is the destination field; MX records also take a priority. Papaki answers on `dns1.papaki.gr` / `dns2.papaki.gr`; changes showed up within minutes for 6x7.gr.
- **Cloudflare** (new, untested in production): Dashboard > the domain > DNS > Records > Add record. Mail records (MX, TXT) are never proxied; for the website's Vercel records choose "DNS only" (grey cloud). Cloudflare Email Routing is a free alternative to ImprovMX; turn on one or the other, not both (they both want the MX records).
- **Any other registrar**: look for "DNS", "DNS records", "Advanced DNS" or "Zone editor". If the domain's nameservers point somewhere else (Cloudflare, Vercel), edit records there instead; `email-check.mjs` reads the live answer, so it shows which one counts.

After each change run `email-check.mjs <domain>` again. Most changes show within 5 to 30 minutes; allow up to a day before calling it broken.

## 2. Receive: ImprovMX catch-all to Gmail

1. The student signs up at improvmx.com with the Gmail that should receive (free plan: forwarding only, no sending).
2. Add the domain in ImprovMX. Turn on the catch-all (`*` alias) to the Gmail address so every `<anything>@<domain>` arrives. Add named aliases too (6x7.gr has `hello@`, `filippos@`, `admin@`) so they keep working if the catch-all is ever switched off.
3. Add at the registrar:
   - `MX  @  mx1.improvmx.com  priority 10`
   - `MX  @  mx2.improvmx.com  priority 20`
   - `TXT @  v=spf1 include:spf.improvmx.com ~all` . If the domain already has a `v=spf1` line, add `include:spf.improvmx.com` to that line instead: two SPF lines break both.
4. Remove any old MX records for the domain only if the student confirms nothing else receives mail there.
5. Test: from a different account, send to `hello@<domain>` and to a made-up `test123@<domain>` (proves the catch-all). Both should arrive in Gmail within a few minutes; check Spam the first time and mark "Not spam".

## 3. Reply as that address in Gmail ("Send mail as")

Proven, free route (6x7.gr): Google's own SMTP with an app password.

1. Google account: 2-Step Verification on (myaccount.google.com/security). Without it, app passwords are not offered.
2. myaccount.google.com/apppasswords > create one named "<domain> mail". Google shows a 16-character code once. The student keeps it on screen for the next step only; never in chat.
3. Gmail on a computer: Settings > See all settings > Accounts and Import > "Send mail as" > Add another email address. Name: their name. Address: `hello@<domain>`. Untick "Treat as an alias" (replies then go to that address, which ImprovMX forwards back).
4. SMTP server `smtp.gmail.com`, port `587`, TLS, username: the full Gmail address, password: the app password.
5. Gmail sends a confirmation code to `hello@<domain>`; it arrives through ImprovMX. Paste it.
6. Optional: "When replying: reply from the same address the message was sent to". Repeat 3 to 5 for other aliases.

Alternative when the domain already sends through Resend: SMTP `smtp.resend.com`, port 465, username `resend`, a Resend sending-only key as password; see `/shipyard:launch` `references/gmail-send-as.md`. That route signs mail with the domain's own DKIM, which aligns better with DMARC.

### Why Gmail send-as needs a line in SPF

In plain words: SPF is a public list, kept in the domain's DNS, of the mail servers allowed to send as `@<domain>`. When Gmail sends as `hello@<domain>` through smtp.gmail.com, the mail leaves from Google's servers. If Google is not on that list, the receiver sees "a server not on the list sent this", and that is a common reason for mail landing in Spam. Google also signs these emails with its own key (DKIM for gmail.com), not the domain's, so the SPF list is the only thing that can vouch for them.

The fix is one word added to the domain's one existing SPF line, nothing removed:
`v=spf1 include:spf.improvmx.com include:_spf.google.com ~all`
Only add it if the student uses Gmail "Send mail as" through smtp.gmail.com. The student (or you, with their yes) edits that TXT line at the registrar; never make a second `v=spf1` line. Afterwards send one email to another account and check Gmail "Show original" for `SPF: PASS` and `DMARC: PASS`. **New, untested in production**: 6x7.gr's SPF does not include Google as of October 2026.

## 4. SPF, DKIM and DMARC

- **SPF** (which servers may send as the domain): exactly one TXT line on `@` starting `v=spf1`, with one `include:` per service that sends as `@<domain>` (ImprovMX, Google if using Gmail SMTP). Max 10 DNS lookups in total. Resend does not need to be here when it sends from `send.<domain>`; its own SPF lives on that subdomain.
- **DKIM** (a signature proving the mail was not changed): Resend gives a `resend._domainkey` TXT record when the domain is added (`launch-email.mjs` prints it). ImprovMX free does not sign outgoing mail (it does not send).
- **DMARC** (what receivers do when SPF/DKIM fail, and where reports go): `TXT _dmarc  v=DMARC1; p=none; rua=mailto:dmarc@<domain>`. With the catch-all, reports land in Gmail; make a Gmail filter to label them. 6x7.gr runs `p=none`. After two weeks of clean reports move to `p=quarantine` (new, untested in production for 6x7.gr).

## 5. Deliverability test

1. `email-check.mjs <domain>`: all ticks.
2. Receive: send to two addresses at the domain from an outside account (section 2, step 5).
3. Send: from Gmail as `hello@<domain>` and from the app (or `notify.mjs ... --kind custom`), write to the check address at mail-tester.com and to a Gmail and an Outlook.com account. Aim for 9/10 or better; fix whatever it names first.
4. Gmail > the received message > three dots > "Show original": SPF, DKIM and DMARC should say PASS. A DMARC FAIL with SPF PASS usually means the sending service is missing from the SPF line or is signing with its own domain.
5. New domains: a few emails a day to people who expect them for the first weeks; ask a couple to reply or mark "Not spam".

## If something fails

- Mail to the domain bounces: no MX (check 1) or ImprovMX does not show the domain as verified yet; wait 30 minutes and recheck.
- Gmail confirmation code never arrives: forwarding is not working yet (fix section 2 first) or it is in Spam.
- "Username and password not accepted" in Gmail: use an app password, not the normal Google password; 2-Step Verification must be on.
- Two SPF lines: merge them. `email-check.mjs` flags this.
