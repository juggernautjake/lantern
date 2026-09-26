# Two brands, one family

Dayspring and Lantern share one design system (`client/tokens.css`). The **base** is identical in both, so they feel like siblings. The **brand** layer gives each its own colours, display face and signature, so nobody mistakes one for the other.

```html
<html data-brand="dayspring">                         <!-- dawn and sky -->
<html data-brand="lantern">                           <!-- lamplight and study -->
<html data-brand="lantern" data-theme="day">          <!-- Lantern's daytime study theme -->
<!-- on any brand: data-contrast="high" · data-motion="reduced" (the system's reduced-motion setting is followed too) -->
```

A brand can be set on any element, not only `<html>`. The demo shows both side by side.

## The shared base (identical in both apps)

- **Type:** Outfit is the body face in both apps. The steps are `--fs-xs … --fs-3xl`, and the line heights are 1.2, 1.5 and 1.7.
- **Space and shape:**
  - spacing `--sp-1 … --sp-8`
  - radii `--r-sm .6em` · `--r .9em` · `--r-lg 1.25em` · `--r-pill 2em`
- **Motion:** easing `--ease: cubic-bezier(.2,.7,.2,1)`, durations `--dur-1 … --dur-4`. Reduced motion collapses them.
- **Glass:** a 16 px blur, the same edge recipe (`--edge`, `--edge-2`) and the same two shadows.
- **Focus:** a 3 px ring in `--focus`, offset 2 px, the same shape everywhere.
- **Icons:** line icons, 1.75 stroke, round caps and joins (`.eco-icon`).
- **Semantic roles:** `--bg --bg-2 --surface --surface-2 --glass --ink --muted --dim --accent --accent-2 --accent-ink --ok --warn --danger --link --focus`. Components use only these, so every component works in either brand.
- **Components:**
  - `.eco-btn` (`.primary`, `.ghost`, `.danger`)
  - `.eco-pill`, `.eco-card`, `.eco-toast`, `.eco-dialog`
  - `.eco-whatsnew` (the shared update dialog)
  - `.eco-chip`, `[data-origin]`, `.eco-connected`, `.eco-wordmark`

## Dayspring: dawn and sky

| | |
|---|---|
| Feeling | Calm, airy, a new day. Night indigo warming into sunrise. |
| Background | `#060812` → `#0b1026`, the living sky behind everything |
| Accents | Blues and violets `#6ea8fe` `#7c8cff` `#a78bfa`; sunrise highlights rose `#ff8fa3` and gold `#ffd27a` (for highlights and celebrations only, never whole surfaces) |
| Ink | `#eef0ff` (muted `#a4abcc`) |
| Wordmark | Outfit at weight 200–300, uppercase, widely spaced (`letter-spacing .22em`): light and open |
| Signature | The gradient horizon line (`.ds-horizon`): blue → violet → rose → gold |
| Face | The round voice orb (`client/voice-orb.js`) with its moods |
| Icon | A sun rising over the horizon (`client/icons/dayspring.svg`) |

## Lantern: lamplight and study

| | |
|---|---|
| Feeling | Warm, focused, a desk lamp in a quiet room |
| Background | Deep walnut and charcoal, `#120d09` → `#1a130d` |
| Accents | Amber `#ffb547`, ember `#ff8a3d`, brass `#c9a45c`. A soft teal/green (`#8fd8cb` links, `#86d9b0` success) keeps it from being all orange. |
| Ink | Parchment `#f6ead2` (muted `#d2bf9c`) |
| Day theme | A parchment page `#f7efdd` with walnut ink `#2b1d12`. The accents darken (`#9a4a0c`) so they stay readable. |
| Display face | **Fraunces**, a warm serif (OFL), for headings and the wordmark; the body stays Outfit for the family resemblance. Fallbacks: Iowan Old Style, Palatino, Georgia. Bundle the font files for offline use. |
| Wordmark | Fraunces 600, natural case, barely spaced |
| Signature | A soft radial lamp glow behind the key content (`.ln-lampglow`), and an optional paper grain (`.ln-grain`) |
| Face | The lantern (`client/lantern-avatar.js`) |
| Icon | A lantern with a lit flame (`client/icons/lantern.svg`) |

## When they meet

Anything that crosses from one app to the other uses the **base** components, plus a small mark of where it came from:

- **`.eco-chip[data-app="lantern"]`** or **`[data-app="dayspring"]`**: a small pill with a glowing dot in the origin app's colour, in front of a title. Examples: "Lantern · Course invitation" shown inside Dayspring, or "Dayspring · Study block starting" inside Lantern.
- **`[data-origin="lantern"]`** or **`[data-origin="dayspring"]`**: a 4 px edge down the left of a card or toast, in the origin's gradient (amber → ember for Lantern, indigo → rose for Dayspring).
- **`--brand-dayspring`, `--brand-lantern`**: defined in every brand, so either app can draw the other's colour.
- **`.eco-connected`**: "Lantern connected" or "Dayspring connected", with a green dot. It's grey when the other app isn't running.
- **The shared "What's new" dialog** (`.eco-whatsnew`) has the same layout and the same three choices in both apps, in the host app's colours.

**Do:**
- Keep the host app's colours for the surface, and mark foreign content with the chip or the edge.
- Use `--accent` for the one most important action per view.
- Use Lantern's teal for links and success.
- Test both brands, the day theme, high contrast and reduced motion (the demo has switches for all of them).

**Don't:**
- Paint a whole Dayspring panel amber, or a Lantern panel indigo. The chip and the edge are enough.
- Use the sunrise rose or gold for body text or large surfaces. They're highlights.
- Use Fraunces in Dayspring, or Dayspring's wide uppercase wordmark style in Lantern.
- Put the lantern inside Dayspring, or the orb inside Lantern. Each face belongs to its own app. Use the icon plus chip for the other app.
- Rely on colour alone. The chip names the app in words.

## Accessibility

- **Contrast:**
  - Body text (`--ink`) is at least **7:1** on every background, in both brands, the day theme and high contrast.
  - Every other readable colour is at least **4.5:1**.
  - Button text on the accent is at least 4.5:1.
  - The measured table is in [contrast.md](contrast.md). Regenerate it with `npm run contrast`, which fails if any pair drops below its minimum.
- **High contrast** (`data-contrast="high"`):
  - pure black or white backgrounds
  - muted text becomes full ink
  - stronger edges and no blur
- **Reduced motion** (`data-motion="reduced"` or the system setting):
  - transitions and animations drop to near zero
  - the lantern stops flickering (its glow still follows the voice, smoothly)
  - the orb stops drifting
- **The avatars:** each one is an image with a name that says what it's doing ("Lantern: listening"), and a polite live region announces state changes.
