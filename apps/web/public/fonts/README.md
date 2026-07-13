# Bundled fonts

## `symbols-nerd-mono.woff2`

A **subset** of **Hack Nerd Font Mono** (regular), containing only the icon/symbol glyph ranges used to
render terminal pane-output (ADR-0016): Powerline separators (`U+E0A0–E0D7`), Font Awesome
(`U+F000–F2FF`), and Font Logos (`U+F300–F381`). Latin text is intentionally excluded — it comes from
IBM Plex Mono; this font is loaded only as a fallback for the Nerd-Font Private-Use-Area glyphs that no
standard monospace font can render. Loaded lazily via a `unicode-range`-scoped `@font-face` in
`app/globals.css`, so the browser fetches it only when such a glyph is actually displayed.

### Provenance & license

- **Hack** — a typeface by Source Foundry, licensed under the permissive **Hack Open Font License**
  (MIT-style) plus the **Bitstream Vera License**. https://github.com/source-foundry/Hack
- **Nerd Fonts** — the icon patch by Ryan L McIntyre, **MIT License**.
  https://github.com/ryanoasis/nerd-fonts

Both licenses permit redistribution, modification (subsetting), and bundling. Regenerate the subset with:

```
pyftsubset HackNerdFontMono-Regular.ttf \
  --unicodes="U+E0A0-E0D7,U+F000-F2FF,U+F300-F381" \
  --flavor=woff2 --no-hinting --desubroutinize \
  --output-file=symbols-nerd-mono.woff2
```
