# Bundled fonts

These files are the Latin subsets served by Google Fonts (`fonts.gstatic.com`). They were downloaded on 2026-09-25 from the URLs that the Google Fonts CSS API (`fonts.googleapis.com/css2`) returns.

Every family is licensed under the **SIL Open Font License 1.1** (https://openfontlicense.org). You may bundle and redistribute the fonts with software, but you may not sell a font on its own. Under the licence's reserved font name rules, a modified font must be renamed. These files are unmodified.

| File | Family | Weights | Size | Upstream |
|---|---|---|---|---|
| `ibm-plex-mono-400.woff2` | IBM Plex Mono | 400 | 14.7 KB | github.com/IBM/plex |
| `ibm-plex-mono-600.woff2` | IBM Plex Mono | 600 | 15.6 KB | github.com/IBM/plex |
| `jetbrains-mono-var.woff2` | JetBrains Mono | 100–800 (variable) | 31.4 KB | github.com/JetBrains/JetBrainsMono |
| `fira-code-var.woff2` | Fira Code | 300–700 (variable) | 36.3 KB | github.com/tonsky/FiraCode |
| `cascadia-code-var.woff2` | Cascadia Code | 200–700 (variable) | 48.6 KB | github.com/microsoft/cascadia-code |
| `source-code-pro-var.woff2` | Source Code Pro | 200–900 (variable) | 22.0 KB | github.com/adobe-fonts/source-code-pro |
| `atkinson-hyperlegible-400.woff2` | Atkinson Hyperlegible | 400 | 17.2 KB | brailleinstitute.org / Google Fonts |
| `atkinson-hyperlegible-700.woff2` | Atkinson Hyperlegible | 700 | 17.5 KB | brailleinstitute.org / Google Fonts |
| `fraunces-var.woff2` | Fraunces | 100–900 (variable) | 67.3 KB | github.com/undercasetype/Fraunces |
| `outfit-var.woff2` | Outfit (Latin) | 100–900 (variable) | 31.5 KB | github.com/Outfitio/Outfit-Fonts (SIL OFL 1.1) |

The total is about 300 KB. `../fonts.css` declares all of them.

The standalone single-file studio does not embed these fonts. It links the same families from Google Fonts, and the browser downloads only the faces that are actually used.
