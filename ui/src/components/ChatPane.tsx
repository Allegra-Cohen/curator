import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { renderMarkdown } from '../markdown'
import type { AssistantMessage } from '../types'

// A node link in a chat reply is clickable ONLY when it carries a paragraph number
// (a #p<N> suffix -- see links.ts). That's deliberate, not incidental: the model is
// told never to show a raw id, so it never writes a node: link of its own -- the
// only thing that ever does is find_evidence's evidence table, built entirely by
// code (assistant/evidence_table_markdown.py), never typed by Claude. Gating on the
// paragraph number rather than "any node: link" is the belt-and-suspenders version
// of that guarantee: even if something else in a reply someday carried a bare
// node: link, it would still degrade to plain text here, same as it does today.
//
// Paragraph 0 is a reserved value, not a real paragraph (those are always 1 and up)
// -- it's how the "couldn't be read" / "no matching evidence" lists in a table link
// to a document with nothing to scroll to. `paragraph !== undefined` already treats
// 0 as present (0 !== undefined), so no change is needed here; see `onOpen` below
// for where 0 is told apart from a real paragraph.
const linkLabel = (_id: string, paragraph?: number) => (paragraph !== undefined ? 'quote' : null)

interface ChatPaneProps {
  openDocumentTitle: string | null
  openDocumentInQueue: boolean | null
  openDocumentId: string | null
  openConceptName: string | null
  openConceptId: string | null
  /** A quote's document + paragraph number, from clicking one in an evidence
   *  table. Opens the Document Viewer there -- see App.tsx's openQuote. */
  onOpenQuote: (documentId: string, paragraph: number) => void
  /** A document mentioned by title only in an evidence table (couldn't be read,
   *  or nothing matched) -- from clicking one of those links (paragraph 0, see
   *  linkLabel above). Just opens the document, nothing to scroll to. */
  onOpenDocument: (documentId: string) => void
}

// The curation assistant's chat -- read-only for now (see
// writeups/design/CURATION_ASSISTANT_DESIGN.md): it can answer questions
// about the queue and the approved graph, but can't change anything, even
// if asked.
//
// One ongoing thread per environment, saved server-side after every message
// (conversation_store.py), so it's still there after a page refresh. Typing
// "/clear" starts a fresh thread instead of sending a message to the
// assistant -- the old thread is kept on disk, just no longer shown here.
export default function ChatPane(props: ChatPaneProps) {
  const {
    openDocumentTitle, openDocumentInQueue, openDocumentId,
    openConceptName, openConceptId, onOpenQuote, onOpenDocument,
  } = props

  // Only a paragraph-bearing link ever reaches this (linkLabel above already
  // filtered out anything else, so `paragraph` is never actually undefined here).
  // Paragraph 0 means "open the document, no paragraph to scroll to" (see linkLabel
  // above); a real paragraph number scrolls there via onOpenQuote as before.
  const onOpen = (id: string, paragraph?: number) => {
    if (paragraph === 0) onOpenDocument(id)
    else if (paragraph !== undefined) onOpenQuote(id, paragraph)
  }

  const [history, setHistory] = useState<AssistantMessage[] | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Loads whatever thread is already current for this environment, so
  // reopening the box (or refreshing the page) shows where you left off.
  useEffect(() => {
    api.assistantConversation()
      .then((t) => setHistory(t.history))
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [history, sending])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return

    if (text.toLowerCase() === '/clear') {
      setSending(true); setError(null)
      try {
        const t = await api.assistantNewThread()
        setHistory(t.history)
        setInput('')
      } catch (e) { setError(String(e)) } finally { setSending(false) }
      return
    }

    setSending(true); setError(null); setInput('')
    try {
      const reply = await api.assistantMessage({
        message: text,
        open_document_title: openDocumentTitle,
        open_document_in_queue: openDocumentInQueue,
        open_document_id: openDocumentId,
        open_concept_name: openConceptName,
        open_concept_id: openConceptId,
      })
      setHistory(reply.history)
    } catch (e) {
      setError(String(e))
      setInput(text)   // give the message back so it isn't lost
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="chat-body">
      <div className="chat-messages">
        {history === null && <p className="muted chat-empty">Loading…</p>}
        {history !== null && history.length === 0 && (
          <p className="muted chat-empty">
            Ask about the queue or the approved graph. Type /clear to start a fresh conversation.
          </p>
        )}
        {history?.map((m, i) => (
          <div key={i} className={`chat-msg chat-msg-${m.role}`}>
            {m.role === 'assistant'
              ? <div className="md-body">{renderMarkdown(m.content, linkLabel, onOpen)}</div>
              : m.content}
          </div>
        ))}
        {sending && <div className="chat-msg chat-msg-assistant chat-msg-pending">…</div>}
        <div ref={bottomRef} />
      </div>
      {error && <p className="error chat-error">{error}</p>}
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the assistant… (/clear to start over)"
          rows={2}
          disabled={sending}
        />
        <button className="chat-send" onClick={send} disabled={sending || !input.trim()}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
