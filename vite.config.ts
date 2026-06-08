import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// In dev mode, scripts/dev.mjs writes a marker with the extension's fixed API
// port; we proxy /api and /events (SSE) to it so the HMR page talks to the
// live extension process.
function devApiTarget(): string {
	try {
		const marker = JSON.parse(
			readFileSync(
				join(
					process.env.COPILOT_HOME || join(homedir(), ".copilot"),
					"extensions",
					"review-lens",
					".dev.json",
				),
				"utf8",
			),
		);
		if (marker.apiPort) return `http://127.0.0.1:${marker.apiPort}`;
	} catch {
		// no marker — fall back to the default dev API port
	}
	return "http://127.0.0.1:43117";
}

export default defineConfig({
	root: "src/renderer",
	plugins: [react(), viteSingleFile()],
	build: {
		outDir: "../../dist",
		emptyOutDir: false,
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			// ^/api/ (not /api): a bare "/api" prefix would also swallow the
			// renderer's own /api.ts module request and 404 the module graph.
			"^/api/": { target: devApiTarget(), changeOrigin: true },
			"^/events$": { target: devApiTarget(), changeOrigin: true },
		},
	},
});
