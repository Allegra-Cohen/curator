// Keeping the standalone windows (?view=sources, ?view=scope) and the main app in
// step. Each is a separate document running its own React app, so a run started in
// the Sources window is invisible to the queue in the main window until something
// says so.
//
// `BroadcastChannel` rather than `postMessage` via `window.opener`: the opener
// relationship is fragile — it's absent when a window is opened directly by url or
// restored by the browser, and stale once the main window is reloaded. A named
// channel is symmetric, same-origin by construction, and doesn't care who opened
// whom.

/** What happened, coarse enough that neither side needs to know the other's state. */
export type FieldGuideEvent =
  /** Documents entered the review queue (a discovery run, a followed source polled). */
  | 'documents-ingested'
  /** A document was categorised, dismissed, or restored — changes a source's
   *  accept rate, which is the number the Sources window exists to show. */
  | 'documents-changed'
  /** A person or organization was edited, retyped or deleted somewhere. Any window
   *  showing them (the pivots, the entity list) is now stale. */
  | 'entities-changed'
  /** This entity is gone from the graph; payload is its id. Distinct from
   *  `entities-changed`, which also fires on an edit or a create and so can't carry
   *  an id meaning "drop every reference to this". A refetch alone isn't enough:
   *  what a window has to do with a deleted node is forget it, and only the deleter
   *  knows which one it was. */
  | 'entity-deleted'
  /** Open this entity's card in the main window. The only event that asks for
   *  something rather than reporting it:
   *  the Entities window has no card of its own, deliberately — corrections belong
   *  where the graph is, beside the pivots the change moves. */
  | 'open-entity'

const CHANNEL = 'field-guide'

const supported = typeof BroadcastChannel !== 'undefined'

export function notify(event: FieldGuideEvent, payload?: string) {
  if (!supported) return
  const ch = new BroadcastChannel(CHANNEL)
  ch.postMessage({ event, payload })
  ch.close()
}

/** Subscribe until the returned function is called. */
export function onFieldGuideEvent(
  handler: (e: FieldGuideEvent, payload?: string) => void,
): () => void {
  if (!supported) return () => {}
  const ch = new BroadcastChannel(CHANNEL)
  ch.onmessage = (m) => {
    const d = m.data as { event: FieldGuideEvent; payload?: string }
    handler(d.event, d.payload)
  }
  return () => ch.close()
}
