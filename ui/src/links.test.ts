// The client link parser MUST stay in lockstep with graph/links.py — the server
// rebuilds `cites` edges from the same syntax the editor writes, so any drift between
// the two regexes means the References list and the actual edges disagree.
// These cases mirror tests/test_artifacts.py's parser tests; if you change one file,
// change both.
import { describe, it, expect } from 'vitest'
import { makeLink, parseLinks } from './links'

describe('node link parsing', () => {
  it('keeps the anchor the curator highlighted', () => {
    const uid = '0f3a91c8-1111-2222-3333-444455556666'
    const [c] = parseLinks(`…which [this survey](node:${uid}) settled.`)
    expect(c.anchor).toBe('this survey')
    expect(c.rawId).toBe(uid)
  })

  it('reports every occurrence, positions included', () => {
    const uid = '0f3a91c8-1111-2222-3333-444455556666'
    // Positional, not deduped — the editor dedups for the references list itself.
    // Two sentences pointing at one paper are two links here.
    const links = parseLinks(`[one](node:${uid}) and again [two](node:${uid})`)
    expect(links.length).toBe(2)
    expect(links[0].start).toBe(0)
    expect(links[1].anchor).toBe('two')
  })

  it('still reads the legacy doc: scheme', () => {
    // Bodies written before one scheme replaced it are still in the guide. It means
    // exactly what `node:` means — look this id up — and nothing writes it now.
    const uid = '0f3a91c8-1111-2222-3333-444455556666'
    const [c] = parseLinks(`[an older link](doc:${uid})`)
    expect(c.rawId).toBe(uid)
  })

  it('surfaces a malformed id rather than dropping it', () => {
    const [c] = parseLinks('[broken](node:not-a-uuid)')
    // The editor decides it is broken by failing to resolve the id, not by the
    // parser refusing it — a mangled link still has a position worth flagging.
    expect(c.rawId).toBe('not-a-uuid')
  })

  it('round-trips with makeCitation', () => {
    const uid = '7b2e0000-0000-4000-8000-000000000000'
    const [c] = parseLinks(makeLink('as shown', uid))
    expect(c.anchor).toBe('as shown')
    expect(c.rawId).toBe(uid)
  })

  it('has no paragraph number by default', () => {
    const uid = '7b2e0000-0000-4000-8000-000000000000'
    const [c] = parseLinks(makeLink('as shown', uid))
    expect(c.paragraph).toBeUndefined()
  })

  it('reads a #p<N> paragraph suffix, and round-trips it through makeLink', () => {
    const uid = '0f3a91c8-1111-2222-3333-444455556666'
    const [c] = parseLinks(`[quote](node:${uid}#p12)`)
    expect(c.rawId).toBe(uid)
    expect(c.paragraph).toBe(12)

    const [c2] = parseLinks(makeLink('quote', uid, 12))
    expect(c2.paragraph).toBe(12)
  })
})
