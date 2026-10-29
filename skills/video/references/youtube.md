# YouTube (and other video sites)

The video goes on the student's own channel, so the student uploads it and decides when the world can see it. You prepare everything else.

## Before the upload

- Upload the master render from `video/out/` (full quality), rendered with `video-render.mjs ... --youtube`: it sets the loudness YouTube expects (renders come out about -26 against -14) and renders at 1440p, which YouTube plays back with a better codec, so the app's text stays sharp. The web copy in `public/video/` is squeezed under 10 MB for the website and looks worse on a big screen.
- Write the details in `video/videos.json`, one entry per video: `file` (the master's name), `title`, `description`, `tags`, `language` and `captions` (the `.vtt` file, or none). The description ends with "Narrated with an AI voice." and the app's address. Show the file to the student and wait for a yes.
- The script's rules apply to the title and description too: benefits only, nothing a stranger would not care about, no claim the app cannot back up.

## The upload

1. The student opens YouTube Studio signed in to their channel and drags the mp4 from `video/out/` into the upload window. Browser tools that upload files for an agent often stop at about 10 MB, so this drag is theirs. A dragged file waits as a draft ("Edit draft"; phone videos under the Shorts tab), and you can fill in its details from there.
2. Visibility: **Private** first. They watch it once on YouTube, on a phone too, then choose Unlisted or Public themselves.
3. Details: paste them from `videos.json`. If you can operate their browser and they say yes, you may fill in the fields. Never press Publish or change the visibility for them.
4. Subtitles:
   - The video already shows its words in the picture (the silent cut, or a phone cut with captions): turn off (unpublish) YouTube's automatic subtitles for that video. Otherwise a viewer who turns subtitles on sees the words twice. They appear minutes to hours after publishing, so they are usually not there yet at upload time: note the video IDs and come back later (`studio.youtube.com/video/<ID>/translations`, the ⋮ menu next to the automatic track, Unpublish). The student does it, or you do it in their browser with their yes.
   - The voiced cut without words in the picture: upload its `.vtt` file as the subtitles, in the language the video speaks. Its timing comes from the voice step, so it is closer than YouTube's own guess.
5. Under "Show more", YouTube asks about AI use, including realistic AI sounds: an AI voice counts, so the answer is yes. Check the category (it starts as a default) and the video language. Keep "Narrated with an AI voice." in the description.
6. Right after upload YouTube plays the video only in low quality (240p or 360p) until its HD processing finishes, which can take from minutes to an hour. Tell the student, so they don't think the render is blurry. Nobody can set the quality viewers start with.

## Never

- Never delete or replace a published video for the student, even a wrong one. Say what is wrong and ask them to do it in Studio. Deleting loses the video's views and links, and it cannot be undone.
- Never change the channel's settings, monetisation or default upload settings.
- Never upload a video that shows a real customer's data or a real account.
