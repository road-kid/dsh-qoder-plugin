import { describe, expect, it } from 'vitest'
import { QUOTA_CSS } from '../src/client/quota-styles.ts'

/**
 * The theme rounds every corner with a superellipse (`--dsw-corner-shape`),
 * which deforms a circular or capsule radius into a squircle. The official
 * components opt out per shape by pairing `corner-shape: round` with the
 * radius, and this stylesheet must do the same: a switch knob that is not a
 * true circle reads as a different control than the host's own toggles.
 *
 * Pinned here because the convention is invisible in review — the rule still
 * looks correct, and only the rendered shape is wrong — and because three
 * sites had already been missed before the switch knob was reported.
 */

/** One declaration block per entry, keyed by its selector list. */
function declarations(css: string): ReadonlyArray<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = []
  const pattern = /([^{}]+)\{([^{}]*)\}/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    out.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' })
  }
  return out
}

/** A shape that is meant to read as a circle or a capsule. */
const ROUND_RADIUS = /border-radius:\s*(?:50%|999px)/u

describe('stylesheet round shapes', () => {
  const rules = declarations(QUOTA_CSS)
  const round = rules.filter(rule => ROUND_RADIUS.test(rule.body))

  it('finds the round shapes it is meant to guard', () => {
    // A guard that silently matches nothing would pass forever.
    expect(round.length).toBeGreaterThanOrEqual(8)
  })

  it('pairs every circle and capsule radius with corner-shape: round', () => {
    const missing = round
      .filter(rule => !/corner-shape:\s*round/u.test(rule.body))
      .map(rule => rule.selector)
    expect(missing).toEqual([])
  })

  it('gives the switch knob its own true-circle opt-out', () => {
    const thumb = rules.find(rule => rule.selector === '.qdp-switchThumb')
    expect(thumb).toBeDefined()
    expect(thumb?.body).toMatch(/border-radius:\s*50%/u)
    expect(thumb?.body).toMatch(/corner-shape:\s*round/u)
  })
})
