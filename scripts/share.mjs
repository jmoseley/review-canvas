// Build and share Review Lens as a private GitHub gist in the exact format the
// GitHub app's share_extension / install_extension flow uses:
//   - one flat layer of files (subdir paths would encode `/` as `\`; our build
//     artifact is already flat: extension.mjs + index.html)
//   - a copilot-extension.json manifest: { "name": "...", "version": 1 }
//   - UTF-8 text only, ~1 MB per file
//
// Note: the app's own share flow skips `dist/`, which is exactly where our
// build lands — so we assemble the gist payload explicitly from the build
// output instead of sharing a folder.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "review-lens";

console.log("[share] building…");
execFileSync("npm", ["run", "build"], { stdio: "inherit" });

const files = {
	"copilot-extension.json": `${JSON.stringify({ name: NAME, version: 1 }, null, 2)}\n`,
	"extension.mjs": await readFile("dist/extension.mjs", "utf8"),
	"index.html": await readFile("dist/index.html", "utf8"),
};

for (const [name, content] of Object.entries(files)) {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > 1024 * 1024) {
		console.error(`[share] ${name} is ${(bytes / 1024).toFixed(0)} KB — exceeds the ~1 MB gist file cap`);
		process.exit(1);
	}
}

const payload = {
	description: `Copilot extension: ${NAME}`,
	public: false,
	files: Object.fromEntries(
		Object.entries(files).map(([name, content]) => [name, { content }]),
	),
};

const tmp = await mkdtemp(join(tmpdir(), "review-lens-share-"));
const payloadPath = join(tmp, "gist.json");
await writeFile(payloadPath, JSON.stringify(payload));

console.log("[share] creating private gist…");
try {
	const out = execFileSync(
		"gh",
		["api", "gists", "--method", "POST", "--input", payloadPath, "--jq", ".html_url"],
		{ encoding: "utf8" },
	).trim();
	console.log(`[share] done: ${out}`);
	console.log(`[share] install it via the install_extension tool or "Install extension from gist" with that URL.`);
} finally {
	await rm(tmp, { recursive: true, force: true });
}
