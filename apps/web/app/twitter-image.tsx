// Site-wide Twitter/X card — same artwork as the Open Graph card (HOMEPAGE.md §6).
import { OG_ALT, OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from '@/lib/og'

export const alt = OG_ALT
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default function Image() {
  return renderOgImage()
}
