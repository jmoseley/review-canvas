// Dev mode: install Review Lens as a user-scoped extension wired for HMR.
//
//   1. esbuild watches src/server and writes the bundle straight into
//      ~/.copilot/extensions/review-lens/extension.mjs
//   2. a `.dev.json` marker is written next to it ({ apiPort, rendererUrl });
//      the extension sees the marker, listens on the fixed apiPort, and
//      `open()` returns the Vite URL instead of its own
//   3. Vite serves the renderer with HMR and proxies /api + /events (SSE)
//      to the fixed apiPort (see vite.config.ts)
//
// Renderer edits hot-reload instantly. Server edits rebuild the installed
// bundle automatically but need an extension reload to take effect (run
// `/reload-extensions` or the extensions_reload tool in Copilot).

import { context } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { serverBuildOptions } from "./build-server.mjs";

const API_PORT = 43117;
const RENDERER_URL = "http://localhost:5173/";

const installDir = join(
	process.env.COPILOT_HOME || join(homedir(), ".copilot"),
	"extensions",
	"review-lens",
);
const markerPath = join(installDir, ".dev.json");

await mkdir(installDir, { recursive: true });
await writeFile(
	markerPath,
	`${JSON.stringify({ apiPort: API_PORT, rendererUrl: RENDERER_URL }, null, 2)}\n`,
);
console.log(`[dev] wrote dev marker ${markerPath}`);

const ctx = await context({
	...serverBuildOptions,
	outfile: join(installDir, "extension.mjs"),
	plugins: [
		{
			name: "notify",
			setup(build) {
				build.onEnd((result) => {
					if (result.errors.length) return;
					console.log(
						`[dev] server bundle rebuilt → ${installDir}/extension.mjs (reload extensions to apply)`,
					);
				});
			},
		},
	],
});
await ctx.watch();

console.log(`[dev] starting Vite on ${RENDERER_URL} (proxying API to :${API_PORT})`);
const vite = spawn("npx", ["vite"], { stdio: "inherit" });

async function cleanup() {
	await ctx.dispose().catch(() => {});
	vite.kill();
	// Remove the marker so a stale fixed-port/Vite URL never leaks into a
	// non-dev session. The installed bundle keeps working for API/tools but
	// serves a "renderer not built" page until you build or share properly.
	await rm(markerPath, { force: true }).catch(() => {});
	console.log("\n[dev] removed dev marker; reload extensions to leave dev mode");
	process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log(`
[dev] Review Lens dev mode ready:
  • extension installed (user scope): ${installDir}
  • reload extensions in Copilot to pick it up (extensions_reload)
  • then open the review-lens canvas — it will load ${RENDERER_URL} with HMR
`);
