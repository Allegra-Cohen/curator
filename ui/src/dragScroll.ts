/** Autoscrolling a list while a drag hovers near its edge.
 *
 * Not a workaround for an impossibility: the wheel DOES still scroll during a
 * drag in Safari, so a curator with a spare finger was never stuck. This is the
 * edge-drag affordance on top of that — reaching the target without changing
 * input device halfway through the gesture, which is what makes a long drag feel
 * like one action rather than two.
 *
 * The maths lives here, apart from the panel, because it is the part worth
 * testing: jsdom has no layout, so a test that drove the real handler would be
 * asserting against a zero-sized rect and proving nothing.
 */

/** How close to an edge the pointer must come before the list starts moving. */
export const EDGE_ZONE = 44

/** Pixels per frame at the very edge; the ramp scales down from here to 0. */
export const MAX_SPEED = 14

/**
 * Scroll velocity for a pointer at `clientY` over a list spanning `top`..`bottom`.
 *
 * Negative scrolls up, positive scrolls down, 0 holds still. The ramp is linear
 * from the zone boundary (0) to the edge (`max`), so the list creeps when you are
 * merely near the edge and moves properly when you are pressed against it — a
 * constant speed is either too slow to cross a long list or too fast to stop on
 * the row you wanted.
 *
 * Past the edge entirely (dragging above or below the list) the velocity stays
 * clamped at `max` rather than growing, so a flick to the far side of the window
 * doesn't launch the list.
 */
export function edgeVelocity(
  clientY: number, top: number, bottom: number,
  edge: number = EDGE_ZONE, max: number = MAX_SPEED,
): number {
  if (bottom <= top) return 0            // no list to scroll
  const fromTop = clientY - top
  const fromBottom = bottom - clientY

  // A list shorter than two zones has them overlapping, and every point would be
  // "near" both edges. Whichever edge is closer wins, so the direction is still
  // the one the curator is reaching toward rather than an arbitrary tie-break.
  const nearTop = fromTop <= fromBottom

  if (nearTop) {
    if (fromTop >= edge) return 0
    const depth = Math.min(edge, edge - fromTop)   // 0 at the boundary, edge at the top
    return -max * (depth / edge)
  }
  if (fromBottom >= edge) return 0
  const depth = Math.min(edge, edge - fromBottom)
  return max * (depth / edge)
}
