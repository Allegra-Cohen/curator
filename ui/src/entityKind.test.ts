import { describe, expect, it } from 'vitest'
import { guessKind } from './entityKind'

// The guess only has to be right often enough to be worth showing, because it's
// shown: a wrong kind is on the chip before Save and one click fixes it. What it
// must never do is be *systematically* wrong in the direction that hurt — filing
// institutions as people, which is what produced 1022 orphan person nodes.
describe('guessKind', () => {
  it('reads institutions as organizations', () => {
    for (const name of [
      'Center for Humane Technology',
      'Centre for Effective Altruism',
      'MIT Media Lab',
      'Stanford University',
      'Mozilla Foundation',
      'Data & Society',
      'The Atlantic',
      'Anthropic, PBC',
      'DeepMind Technologies Ltd.',
      'AI Now Institute',
      'Partnership on AI',
    ]) {
      expect(guessKind(name), name).toBe('organization')
    }
  })

  it('reads human names as people', () => {
    for (const name of [
      'Julie Guirado',
      'Haley Nahman',
      'Jane Q. Doe',
      'J. Doe',
      'Ada Lovelace',
      'Tristan Harris',
      'Yoshua Bengio',
      'Kate Crawford',
      // A surname that happens to be a common noun elsewhere must not trip it.
      'Amy Fields',
      'Robert Church',
    ]) {
      expect(guessKind(name), name).toBe('person')
    }
  })

  it('falls back to person on an empty or punctuation-only name', () => {
    // Never reached in practice — blank names are filtered before proposal — but
    // the fallback has to be the reversible one either way.
    expect(guessKind('')).toBe('person')
    expect(guessKind('   ')).toBe('person')
  })

  it('is case- and punctuation-insensitive', () => {
    expect(guessKind('center for humane technology')).toBe('organization')
    expect(guessKind('OPENAI, INC.')).toBe('organization')
  })
})
