// Site-wide Open Graph card. Placed at the app root so every route inherits it (HOMEPAGE.md §6).
import { OG_ALT, OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from '@/lib/og'

export const alt = OG_ALT
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default function Image() {
  return renderOgImage()
}
