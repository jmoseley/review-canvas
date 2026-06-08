# Review Lens

A Copilot CLI canvas extension for understanding large, AI-generated change
slices: decomposition, a risk-routed file map, and a guided review tour over the
workspace diff.

## Layout

| File | Role |
| --- | --- |
| `extension.mjs` | Wiring: shared loopback server, per-domain overview cache, iframe + SSE, chat-dock bridge. |
| `git.mjs` | Deterministic git layer (diffs, base resolution, co-change groups). |
| `analysis.mjs` | Heuristics: decomposition, fan-in, file scoring, suspicion flags. |
| `prompts.mjs` | Agent-delegation prompts (review tour). |
| `storage.mjs` | Durable per-user state keyed by a stable domain ID. |
| `renderer/` | Canvas UI (`index.html`, `style.css`, `app.js`). |

Runtime state is written to `~/.copilot/extensions/review-lens/artifacts` and is
not tracked here (see `.gitignore`).

## Developing

Edit the modules above, then reload extensions in Copilot CLI to pick up changes.
