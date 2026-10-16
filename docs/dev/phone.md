# Lantern on a phone

The owner opens Lantern on an iPhone (Safari) anywhere, while the PC is on, through
**Tailscale**: a private network between their own devices. Nothing is exposed to
the internet.

## How a phone reaches Lantern

- Lantern still listens on `127.0.0.1:4321` only.
- Settings → Phone → **Switch on** runs `tailscale serve --bg --https=443 http://127.0.0.1:4321`. Tailscale then answers `https://<pc>.<tailnet>.ts.net/` and passes each request on to Lantern from this computer, adding `Tailscale-User-Login`.
- `server/src/platform/phone.js` `remoteOk(req)` lets such a request past the guard only when all of these hold:
  - phone access is on;
  - the request comes from loopback;
  - the host is `*.ts.net`;
  - the login is on the allowed list (the account signed in to Tailscale on this PC when phone access was switched on);
  - the Origin, if present, is that https address.
- Everything else meets the normal guard (this computer's own address only).
- `GET /api/phone` returns the status for the settings page: installed, signedIn, login, url, serving, enabled. `PUT /api/phone {enabled}` switches it on or off, and only from the PC itself.
- Course files (`/packs/<id>/…`) answer byte ranges (206), which Safari needs to play and seek audio.

## What "works on the phone" means

Everything the PC does, at phone size. You can:
- move through the hub and the course;
- read lessons;
- watch videos (Watch and Step-by-step);
- answer questions and see full worked solutions;
- hear explanations: video narration and Lantern's voice;
- use the calculator, the reference sheet, notes, study sessions, progress and settings;
- chat with Lantern.

## Design rules for small screens

- **Targets:** iPhone Safari 17+ at 375–430 CSS px wide, in portrait first and landscape second. Also check 360 px (small Android) and iPad 768/1024.
- **Layout:** a single column below about 700 px. No horizontal page scroll, ever. Wide content (tables, long formulas, figures) scrolls inside its own box or scales to fit.
- **Touch:**
  - Touch targets are ≥ 44×44 px.
  - Nothing depends on hover.
  - No double-tap zoom traps: `touch-action: manipulation` on buttons.
- **Inputs:** font-size ≥ 16 px, or iOS zooms the page when you tap into one. Use `inputmode="decimal"` for numeric answers. The answer box and its unit fit on one line.
- **Safe areas:** respect `env(safe-area-inset-*)` (notch and home bar). The viewport meta has `viewport-fit=cover`. Use `100dvh`, not `100vh`.
- **Navigation:**
  - The lesson rail becomes a slide-in drawer (☰).
  - Sticky headers stay thin.
  - The assistant panel and notes become full-screen sheets with a clear close button.
  - Floating buttons don't cover content or the iOS home bar.
- **Type:** body text 16–18 px; the reading-size slider still works.
- **Media (iOS):**
  - Audio only starts from a tap.
  - Unlock the audio element on the first tap.
  - Never autoplay on load.
  - Video audio: Opus in WebM where the browser says "probably", otherwise the Opus-in-MP4 copy (`.mp4` next to each `.webm`).
- **Video player on a phone:**
  - Portrait: split scenes stack (figure above, working below) or switch to tabs, and stay legible.
  - Fullscreen (or landscape) gives the full stage.
  - Controls are ≥ 44 px, and captions don't cover the working.
- **Performance:** a page of formula cards or a long reading must not stutter. Build heavy things when they are opened (as the cards already do).
- **Dark and light palettes** both work.

## Testing on a phone-sized browser

- Playwright: WebKit with `devices['iPhone 15']` (closest to Safari), plus Chromium with `devices['Pixel 7']`. See `scripts/qa-phone.mjs`.
- On the real phone, open the URL from Settings → Phone.
