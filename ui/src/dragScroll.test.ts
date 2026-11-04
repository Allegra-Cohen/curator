// The autoscroll ramp. Pure maths, so this is the one part of dragging that can
// be pinned without a browser — the wiring in OntologyPanel is not covered here
// and is not covered anywhere, because jsdom has no layout to measure.

import { describe, it, expect } from 'vitest'
import { edgeVelocity, EDGE_ZONE, MAX_SPEED } from './dragScroll'

// A list occupying y = 100..500, comfortably taller than two edge zones.
const TOP = 100
const BOTTOM = 500
const v = (y: number) => edgeVelocity(y, TOP, BOTTOM)

describe('autoscroll velocity', () => {
  it('holds still through the middle of the list', () => {
    expect(v(300)).toBe(0)
    expect(v(TOP + EDGE_ZONE + 1)).toBe(0)
    expect(v(BOTTOM - EDGE_ZONE - 1)).toBe(0)
  })

  it('is zero exactly at the zone boundary, so the list never twitches', () => {
    // The boundary belongs to the still region: entering the zone has to be a
    // deliberate move toward the edge, not a pixel of jitter.
    expect(v(TOP + EDGE_ZONE)).toBe(0)
    expect(v(BOTTOM - EDGE_ZONE)).toBe(0)
  })

  it('scrolls up near the top and down near the bottom', () => {
    expect(v(TOP + 1)).toBeLessThan(0)
    expect(v(BOTTOM - 1)).toBeGreaterThan(0)
  })

  it('ramps linearly from the boundary to the edge', () => {
    // Halfway into the zone is half speed. This is what makes the list creep when
    // you are merely near the edge and move properly when you are against it.
    expect(v(TOP + EDGE_ZONE / 2)).toBeCloseTo(-MAX_SPEED / 2)
    expect(v(BOTTOM - EDGE_ZONE / 2)).toBeCloseTo(MAX_SPEED / 2)
    expect(v(TOP)).toBeCloseTo(-MAX_SPEED)
    expect(v(BOTTOM)).toBeCloseTo(MAX_SPEED)
  })

  it('clamps past the edges instead of accelerating away', () => {
    // Dragging well above or below the list must not scroll faster than pressing
    // against its edge — otherwise a flick toward the window edge launches it.
    expect(v(TOP - 500)).toBeCloseTo(-MAX_SPEED)
    expect(v(BOTTOM + 500)).toBeCloseTo(MAX_SPEED)
  })

  it('picks the nearer edge when a short list has overlapping zones', () => {
    // 60px tall, so both zones cover the whole thing. Direction must still follow
    // which edge the curator is reaching toward.
    const short = (y: number) => edgeVelocity(y, 0, 60)
    expect(short(5)).toBeLessThan(0)      // near the top
    expect(short(55)).toBeGreaterThan(0)  // near the bottom
  })

  it('does nothing when there is no list to scroll', () => {
    expect(edgeVelocity(50, 100, 100)).toBe(0)
    expect(edgeVelocity(50, 100, 40)).toBe(0)
  })
})
