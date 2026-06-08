# Review Lens

A Copilot canvas extension for understanding large, AI-generated change slices:
decomposition, a risk-routed file map, and a guided review tour over the
workspace diff. React + TypeScript throughout, with a shared wire contract
between the extension server and the renderer.

## Architecture

```
src/
  shared/types.ts        Wire contract (snapshot, API, SSE events) — both sides import it
  server/
    extension.ts         Entry: canvas declaration, agent tool, session wiring
    state.ts             Server-authoritative state: overview cache, chat transcript,
                         snapshot assembly + push
    http.ts              Loopback HTTP: static renderer, JSON API, SSE endpoint
    hub.ts               SSE client registry + typed event writes
    git.ts               Deterministic git facts (diff, base resolution, co-change)
    analysis.ts          Heuristics: decomposition, fan-in, risk scores, suspicion flags
    prompts.ts           Agent-delegation prompts + tour-step normalization
    storage.ts           Durable per-user records + review ledger
  renderer/
    App.tsx              Shell; client-local state is UI ephemera only
    store.ts             SSE-fed snapshot store
    api.ts               Typed fetch wrapper
    components/          IntentBar, Rail, Inspector, TourPanel, ChatDock
scripts/
  build-server.mjs       esbuild → dist/extension.mjs (SDK kept external)
  dev.mjs                npm run dev (see below)
  share.mjs              npm run share (see below)
```

**State model.** The server is authoritative: every mutating API route returns
`204` and answers by pushing one canonical `Snapshot` (overview + tour + chat
transcript + pending flags) over SSE. The renderer is a pure render of the last
snapshot; the only non-snapshot event is `chat-delta` for token streaming.

**Why SSE?** A canvas `open()` returns only a URL — the host provides no push
channel into the iframe — and SSE is the only zero-dependency transport that
also works through Vite's dev proxy. (WebSocket would need the `ws` package at
runtime, which a flat, gist-installed extension can't carry.)

**The SDK dependency.** `@github/copilot-sdk/extension` is *not* in
package.json. The Copilot runtime forks extensions through a bootstrap that
resolves that import to its own version-matched SDK copy, so the server bundle
marks it external. Typechecking resolves it via a tsconfig `paths` mapping to
the app-bundled `.d.ts` (`/Applications/GitHub Copilot.app/Contents/Resources/copilot-sdk`).

**Build artifact.** `npm run build` produces a flat, two-file extension in
`dist/`: a bundled `extension.mjs` and a single self-contained `index.html`
(Vite + `vite-plugin-singlefile`). Flatness is what makes gist sharing work.

## Workflows

```sh
npm install
npm run typecheck      # tsc over server + renderer + shared types
npm run build          # dist/extension.mjs + dist/index.html
```

### `npm run dev`

Installs the extension user-scoped (`~/.copilot/extensions/review-lens`) wired
for development:

- esbuild watches `src/server` and rewrites the installed bundle on change
  (reload extensions in Copilot to apply server changes)
- a `.dev.json` marker makes the extension listen on a fixed API port and tells
  `open()` to return the Vite dev URL
- Vite serves the renderer at `http://localhost:5173` with HMR, proxying
  `/api` + `/events` (SSE) to the extension

Ctrl-C removes the dev marker so a stale dev URL never leaks into a normal
session.

### `npm run share`

Builds and publishes the extension as a **private gist** in the same format the
GitHub app's `share_extension` / `install_extension` flow uses: flat files plus
a `copilot-extension.json` manifest (`{ "name": "review-lens", "version": 1 }`).
Requires `gh` authenticated with the `gist` scope. Install the printed URL via
the `install_extension` tool or "Install extension from gist".

## Runtime state

Review dispositions and tours persist in
`~/.copilot/extensions/review-lens/artifacts` (content-addressed review ledger
keyed by repo + base ref, so review state survives new commits). Not tracked
in this repo.
