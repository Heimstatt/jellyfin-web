# Task: a better PDF reader in jellyfin-web

This fork exists for one job. Read this file fully before you start.

## Context

We run Jellyfin 10.11.11 at home and read magazines (PDF) and books (EPUB/PDF) from it. The Jellyfin library overview is
fine, but the built-in reader is not usable on a phone. The official Jellyfin iOS and Android apps render the server's web
client, so improving the reader here improves it everywhere we read.

## Where the code is

- Base branch: `base-v10.11.11` (= upstream tag `v10.11.11`). Work on a new branch from it.
- PDF reader: `src/plugins/pdfPlayer/` (pdfjs-dist 3.11.174). Today it renders one page fitted to the screen. There is no zoom
  and no scrolling. Turning pages works only by tapping the left/right half or pressing the arrow keys, so magazine text is unreadable on a phone.
- EPUB reader: `src/plugins/bookPlayer/` (epubjs 0.3.93). Comics: `src/plugins/comicsPlayer/`.

## Must have (PDF reader)

1. Pinch-to-zoom and double-tap zoom, panning while zoomed, sharp re-render on zoom (no upscaled bitmap).
2. "Fit width" and "fit page" modes; a continuous vertical scroll mode besides page flipping.
3. Two-page spread on wide screens / landscape, with the cover page shown alone.
4. Page thumbnail overview to jump to a page.
5. Swipe to turn pages on touch devices; keep keyboard navigation.
6. Progress reporting and resume work exactly as today (the `PositionTicks` logic must keep working).
7. Preload neighbouring pages, keep memory bounded for large PDFs.

## Nice to have (only after the above is solid)

The same basics in the EPUB reader: font size, light/dark, swipe.

## Limits

- Change only the reader plugins and what they directly need. No server changes, no other pages or navigation.
- Reuse pdf.js rather than writing a renderer. New dependencies only with GPL-2.0-compatible licenses, bundled
  (no CDN, no external network calls).
- Follow the existing code style. `npm run lint` and `npm run build:production` must pass.

## Deliver

- A pull request in **Heimstatt/jellyfin-web** against `base-v10.11.11`.
  Do **not** open issues or pull requests against `jellyfin/jellyfin-web` or comment anywhere upstream.
- PR description: what is done, what is not, added libraries with licenses, and how to test it on a phone.
- Do not include this file in your changes.
