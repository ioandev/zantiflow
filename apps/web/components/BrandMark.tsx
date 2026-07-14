// The zantiflow logo mark — the decorative 22×22 brand icon shown next to the "zantiflow" wordmark
// in the top bar, homepage nav, and error shell. Extracted here (ADR-0015) so the markup — and the
// one legitimate `no-img-element` exception — lives in a single place instead of being duplicated.
//
// It stays a raw <img>, not `next/image`: the source is a fixed, tiny static SVG (public/icon.svg)
// that Next's image optimizer does not resize or re-encode, so `<Image>` would add machinery for no
// benefit. It's decorative (empty alt + aria-hidden) — the adjacent wordmark carries the name.
export function BrandMark() {
  // eslint-disable-next-line @next/next/no-img-element -- static SVG icon; next/image adds nothing
  return <img className="brand-logo" src="/icon.svg" width={22} height={22} alt="" aria-hidden="true" />
}
