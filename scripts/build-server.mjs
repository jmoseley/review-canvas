// Bundle the extension server to a single dist/extension.mjs. The SDK import
// stays external: the Copilot runtime injects a module-resolver hook that maps
// @github/copilot-sdk/* to its own version-matched copy, so bundling (or
// vendoring) it would break version compatibility.

import { build } from "esbuild";

export const serverBuildOptions = {
	entryPoints: ["src/server/extension.ts"],
	outfile: "dist/extension.mjs",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	external: ["@github/copilot-sdk", "@github/copilot-sdk/*"],
	sourcemap: false,
	logLevel: "info",
};

if (import.meta.url === `file://${process.argv[1]}`) {
	await build(serverBuildOptions);
}
