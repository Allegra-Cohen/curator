/** Guess whether a scraped author name is a person or an organization.
 *
 *  Needed because scraped authors are now credited by default: a chip the curator
 *  never touches still becomes a node at Save, and a node has to have a kind. The
 *  alternative — default everything to `person` — is the exact failure this whole
 *  area was rebuilt to stop, the one that made "Center for Humane Technology" a
 *  human with eleven papers.
 *
 *  This is a guess and is treated as one: the chip prints the kind it picked, so a
 *  wrong answer is visible before Save rather than discoverable afterwards, and one
 *  click corrects it. That visibility is what makes a heuristic acceptable here at
 *  all — the rule elsewhere is that the machine never invents a node type, and this
 *  keeps to it by never being the last word.
 *
 *  Deliberately token matching, not scoring. A confidence number would invite a
 *  threshold, and a threshold is a second thing to tune that nobody can see.
 */

export type EntityKind = 'person' | 'organization'

/** Words that only appear in the name of a body, never in a human's.
 *
 *  Kept to nouns that name an institution outright. Words like "media", "news" or
 *  "digital" were considered and left out: they're descriptive, they show up in
 *  publication titles a person might be filed under, and a false organization is
 *  the more annoying error to correct — a person carries an ORCID and an
 *  affiliation, so retyping them costs more than reclassifying a body does.
 */
const ORG_WORDS = new Set([
  'academy', 'agency', 'alliance', 'assoc', 'association', 'bureau', 'center',
  'centre', 'clinic', 'coalition', 'collective', 'college', 'committee', 'company',
  'consortium', 'corporation', 'council', 'department', 'federation', 'forum',
  'foundation', 'fund', 'group', 'hospital', 'initiative', 'institute',
  'institution', 'lab', 'laboratory', 'labs', 'library', 'ministry', 'museum',
  'network', 'observatory', 'office', 'organisation', 'organization', 'partnership',
  'press', 'programme', 'project', 'school', 'society', 'studio', 'team', 'trust',
  'union', 'university',
])

/** Legal suffixes, which are decisive wherever they appear. Matched after the
 *  trailing punctuation a name carries them with ("Anthropic, PBC."). */
const ORG_SUFFIXES = new Set([
  'co', 'corp', 'gmbh', 'inc', 'llc', 'llp', 'ltd', 'pbc', 'plc', 'sa', 'ug',
])

const WORD = /[^\p{L}\p{N}]+/u

/** The kind to file a name under when nobody has said. */
export function guessKind(name: string): EntityKind {
  const words = name.toLowerCase().split(WORD).filter(Boolean)
  if (words.length === 0) return 'person'
  if (words.some((w) => ORG_WORDS.has(w))) return 'organization'
  if (words.some((w) => ORG_SUFFIXES.has(w))) return 'organization'
  // "The" only ever leads a body: nobody is called "The Jane Doe", and a
  // publication that leads with it ("The Atlantic") has no other tell.
  if (words[0] === 'the') return 'organization'
  // An ampersand joins parties, not given names — "Smith & Sons", never a person.
  if (/&/.test(name)) return 'organization'
  return 'person'
}
