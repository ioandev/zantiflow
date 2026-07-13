'use client'

// The marketing homepage (HOMEPAGE.md). Rendered server-side for SEO/social crawlers (which send no
// session cookie). On the client we look up the current session: signed-in visitors are NOT redirected
// away — they can browse the page, and the header + primary CTAs reflect that they're logged in.
import { useEffect, useState } from 'react'
import type { Me } from '@/lib/types'
import { getMe } from '@/lib/api'
import { HomeNav } from './HomeNav'
import { Hero } from './Hero'
import { ProblemStrip } from './ProblemStrip'
import { HowItWorks } from './HowItWorks'
import { Features } from './Features'
import { Privacy } from './Privacy'
import { Pricing } from './Pricing'
import { FinalCta } from './FinalCta'
import { HomeFooter } from './HomeFooter'

export function Homepage() {
  const [me, setMe] = useState<Me | null>(null)
  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  return (
    <div className="hp">
      <HomeNav me={me} />
      <div className="hp-container">
        <Hero me={me} />
        <ProblemStrip />
        <HowItWorks />
        <Features />
        <Privacy />
        <Pricing />
        <FinalCta me={me} />
      </div>
      <HomeFooter />
    </div>
  )
}
