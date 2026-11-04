import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ScopePanel from './components/ScopePanel'
import EntitiesPanel from './components/EntitiesPanel'
import SourcesPanel from './components/SourcesPanel'
import ArtifactsPanel from './components/ArtifactsPanel'
import './styles.css'

// Standalone views open in their own window (?view=scope, ?view=sources,
// ?view=entities, ?view=artifacts). A query
// param rather than a router: these are leaf pages with no nested routes, and a
// router would be a dependency plus a rewrite of App's shell for no gain. All are
// curator-authored content — prose you write, sources you keep, remarks you leave —
// which is why none belongs in the main three-column working surface.
//
// `?view=viewer` is the exception in kind: not a curator leaf page but the READER'S
// whole view, reached by toggling the word in the header rather than opening a new
// window. It rides the same param mechanism because that mechanism already exists.
const view = new URLSearchParams(window.location.search).get('view')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {view === 'scope' ? <ScopePanel />
      : view === 'sources' ? <SourcesPanel />
      : view === 'entities' ? <EntitiesPanel />
      : view === 'artifacts' ? <ArtifactsPanel />
      : <App />}
  </React.StrictMode>,
)
