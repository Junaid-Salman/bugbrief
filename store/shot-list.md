# Screenshots (three, captured by the owner)

Final size 1280x800, full bleed, no device frame. The originals were 1296x684; they were cropped to 8:5 around the popup and scaled to 1280x800 with ffmpeg (`crop=1094:684:150:0,scale=1280:800`).

1. `shot-1.png`: the popup on the demo shop, first step (Record), idle.
2. `shot-2.png`: recording (1 error, 1 failed request, Chrome's debugging banner), element already picked.
3. `shot-3.png`: the Preview step with the "9 values redacted" badge, the screenshot warning and the Markdown preview.

Only the demo shop's fake data is shown. `npm run store:check` fails if no `shot-N.png` exists.
