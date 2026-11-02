# Social media: brand profiles and posting

Set up the app's own accounts, fill them in, and post in the right format for each platform. Example used below: Catchy, a meeting-notes app at catchy.6x7.gr. Never put passwords, codes or private details in the repo or in posts; logins go in the keys file only.

## Rules (always)

- **Instagram is posted from a real phone.** Automation (your browser on a server) may only read Instagram: check posts, comments, profile. It never posts, deletes, comments or edits. See "Lessons learned".
- At most about 3 posts per day per account, with gaps of an hour or more. A new account gets fewer.
- Never the same comment twice. Vary the words; put a link in a comment only where it is the norm, and not on every post.
- Only claim features that are in the code today. Read the app's code or open the live app before writing a feature post.
- Before posting any screenshot, look at every pixel for prices that aren't live, real names, emails, tokens, private meetings or test data. Demo data leaks.
- Honest comments from the maker's personal account are fine if they say who you are ("I built this, ..."). Never pretend to be a stranger or a happy customer.
- Try every step yourself first. Hand the student a step only after you tried it and it failed, and say exactly what you tried.

## 1. Set up the profiles

Use one email per brand (for example `hello@<domain>` through the domain's catch-all) for every account. Before saying "the code email isn't arriving", search all mail labels and filters (a catch-all often files it under a label, not the inbox).

| Platform | How to create | Notes |
|---|---|---|
| X | New account with the brand email | Handle: short, same as other platforms if free. |
| Instagram | Create **on the phone app**, or create on web and log in on the phone the same day | Switch to a Professional (Creator/Business) account. Username changes on web go through Accounts Center. |
| Facebook | A **Page** made from the student's personal profile (Pages > Create) | Pages can't exist without a personal admin. Add a second admin if possible. |
| LinkedIn | A **Company page** from the student's personal profile | Needs a personal account with some history. Add the website and logo. |
| YouTube | A **brand channel** under the brand Google account | Set the handle (@name), banner, links. Channel must have content before it looks real. |
| Reddit | Account made by the student in their own browser | Reddit blocks automated browsers. Build karma by commenting before any post; read each subreddit's self-promotion rules. |

What to fill in on every profile:
- **Name**: the product name. **Handle**: the same everywhere you can (`@catchyapp`, or `@catchy6x7` if taken).
- **Logo**: one square image, readable at 40 px, same on all platforms. Banner/cover where there is one.
- **Bio**: one line of what it does for whom, plus the free offer (for example "AI meeting notes. Free: 120 min/month, no card"). No prices that aren't live yet.
- **Link**: the website. On Instagram the link and pinned posts can only be set in the phone app.
- **Pin**: your best intro post (a demo video or a how-to carousel) on X, Facebook and LinkedIn; Instagram pins from the app.
- Link all the profiles from the website footer (and `sameAs` in the site's JSON-LD).

## 2. What to post, and in what format

Good first posts: a 30-60 s demo, a how-to carousel (step 1, 2, 3), a features carousel, one card per feature, carousels per audience (for example professionals, students, developers), short clips of real use. Use the app's current look; re-shoot screenshots after a redesign.

| Format | Size | Platform notes |
|---|---|---|
| Carousel / cards | 1080x1350 (4:5) | Keep all slides one theme (all dark or all light). |
| Reel / Short / vertical video | 1080x1920 (9:16) | Under 60 s for Shorts. |
| Long video | 16:9, 1440p upload | YouTube. |

Per platform:
- **Instagram**: carousel = one post with up to 10 images. In the crop step pick **Original** (4:5), not the square default, or the sides get cut off. Same for reels: check the crop before sharing. Don't post a single slide from a carousel alone; a lone slide with a "swipe" arrow looks broken.
- **Facebook Page**: organic Page posts can't be swipe carousels (only ads can); several photos show as a grid. Post a **slideshow reel** instead: the slides as a video, 2-3 s each, with royalty-free music (a silent reel looks broken).
- **LinkedIn**: carousels are **document posts**. Export the slides as one PDF and upload as a document. Several photos show as a grid, not a carousel.
- **X**: one image, or up to 4. Use one summary image for a carousel. X rejects AV1 video and some audio formats: re-encode to H.264 + AAC (`ffmpeg -i in -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart out.mp4`).
- **YouTube**: upload at high bitrate, ideally 1440p (`-vf scale=-2:1440 -c:v libx264 -crf 14 -preset slow`). A low-bitrate 1080p upload can stay stuck at 240-360p for viewers. New channels have a daily upload cap (about 10); spread uploads over days. Vertical under 60 s becomes a Short.
- Always end with the website, or "link in bio" on Instagram (and only after the bio link is really set).

## 3. Instagram 3x3 grid

Nine tiles that join into one picture on the profile.
- Design one 3240x4320 image (3 columns x 3 rows of 1080x1440 tiles). The profile grid shows each post as a **center 3:4 crop**, so keep text away from the tile edges, and make each tile still make sense on its own in the feed.
- Export each tile as 1080x1350 (4:5) with the 3:4 part centered.
- **Post in reverse order**: bottom-right tile first, top-left last. New posts land top-left.
- Post all nine from the phone, spread over a day or two (see cadence). Posting nine in a row from a new account looks like spam.

## 4. Cadence

- New account, first two weeks: 1-2 posts a day, mixed formats, plus a few genuine comments on others' posts.
- After that: up to about 3 posts a day per account, hours apart.
- Schedule with the platform's own scheduler (Meta Business Suite, LinkedIn, X) rather than bursts.
- Fixing a mistake: delete and repost one at a time, not ten in a row.

## Lessons learned / don'ts

From a real launch where the brand Instagram got locked after one evening:
- **What got the account flagged** ("confirm you're human", then a lock and an appeal): in one session on a brand-new account, about 8 deletes, about 6 reposts, the same link comment on every post, uploads pushed through the page's hidden file inputs by script, a server (datacenter) IP the account had never seen, and switching the browser to a fake iPhone user-agent mid-session. Facebook, LinkedIn and X took the same posts without complaint because those were tied to an old personal account.
- So: **post Instagram from the student's real phone**. Hand them a Drive folder with numbered files, captions and the order. Automation only reads.
- Web Instagram can't edit the bio link, pin posts or archive posts. Faking a phone browser doesn't unlock them; it only adds risk. Ask the student to do these in the app.
- Reddit blocks automated browsers. The student posts and replies themselves; you draft.
- Demo data shipped a "Pro tier" price into posted slides before payments were live. Every slide had to be replaced. Check screenshots first.
- A few slides were made in light mode in a dark set and looked like blank white images. Check the whole set side by side before posting.
- Facebook photo "carousels" showed as grids and the first slideshow reels had no music. Use the formats in section 2.
- YouTube long videos played at 240p for days because of a low-bitrate upload. Re-encode at 1440p and re-upload.
- Duplicate clips with different captions got posted three times. Keep a list of what went where (file, platform, link) and check it before posting.
- "The code email isn't arriving" was wrong: it had arrived under a mail label. Check labels and filters first.
