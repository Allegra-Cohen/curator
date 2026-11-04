/// <reference types="vite/client" />

// Vite's ambient types, for the asset imports it resolves at build time — today just
// `src/assets/eye.png` in Viewer.tsx (PUBLISHING_PLAN.md §2b). Without this line an
// `import eyeUrl from '../assets/eye.png'` has no declared type and `tsc --noEmit`
// fails, even though the build itself is fine.
//
// The eye is IMPORTED rather than served from a `public/` path on purpose: an import
// goes through Vite, so the emitted URL picks up the blog build's
// `base: '/field-guides/fgttfo/'` automatically. A literal `/eye.png` would resolve
// to the blog's ROOT and 404 in the published viewer, while working in dev — the
// silent kind of break.
