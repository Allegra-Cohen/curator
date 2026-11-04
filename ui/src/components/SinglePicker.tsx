import { useState } from 'react'

export interface PickerOption { id: string; label: string }

interface Props {
  /** What's currently chosen, or null. Rendered as a chip; the ✕ clears it. */
  value: PickerOption | null
  /** The corpus to search. Already loaded by the caller — these lists are small
   *  and local, so filtering here costs nothing and avoids a round trip per key. */
  options: PickerOption[]
  onPick: (o: PickerOption) => void
  onClear: () => void
  placeholder: string
  disabled?: boolean
  /** Offer "+ New …" for a name that isn't in `options`. Omit for pick-only
   *  fields — sources are a deliberate act elsewhere, not something to conjure
   *  from a text box. */
  onCreate?: (name: string) => void
  createLabel?: (query: string) => string
  /** Extra classes on the chip, so a caller can carry the app's type colours
   *  (`chip organization`, say) rather than this component knowing about kinds. */
  chipClass?: string
}

// A single-valued search box, shaped after the authors/concepts search in
// DetailsPanel — same .concept-search + .search-results markup, so a result row
// reads identically wherever you meet one.
//
// Single-valued is the whole difference, and it's why the chip REPLACES the box
// rather than sitting above it as it does for authors: with the box still open on
// a field that holds one value, picking a second silently discards the first, and
// nothing on screen says so. Clearing is the ✕, which is the same gesture that
// removes a credit.
export default function SinglePicker({
  value, options, onPick, onClear, placeholder, disabled,
  onCreate, createLabel, chipClass = '',
}: Props) {
  const [query, setQuery] = useState('')

  if (value) {
    return (
      <div className="chips">
        <span className={`chip ${chipClass}`}>
          <span className="chip-label">{value.label}</span>
          <button className="chip-x" title="Clear" disabled={disabled}
                  onClick={onClear}>×</button>
        </span>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const matches = q
    ? options.filter((o) => o.label.toLowerCase().includes(q)).slice(0, 6)
    : []
  // An exact hit means the typed name resolves to the option below rather than
  // reading as a new one — so don't also offer to create it.
  const exact = options.some((o) => o.label.trim().toLowerCase() === q)

  const pick = (o: PickerOption) => { setQuery(''); onPick(o) }
  const create = () => { const n = query.trim(); setQuery(''); onCreate!(n) }

  return (
    <div className="concept-search">
      <input
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (matches.length > 0) pick(matches[0])
            else if (onCreate && q && !exact) create()
          }
          if (e.key === 'Escape') setQuery('')
        }}
        placeholder={placeholder}
      />
      {q && (
        <ul className="search-results">
          {matches.map((o) => (
            <li key={o.id}><button onClick={() => pick(o)}>{o.label}</button></li>
          ))}
          {matches.length === 0 && !onCreate && (
            <li className="no-match">No match.</li>
          )}
          {onCreate && !exact && (
            <li>
              <button className="create-option" onClick={create}>
                {createLabel ? createLabel(query.trim()) : `+ New “${query.trim()}”…`}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
