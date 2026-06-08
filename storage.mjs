// Durable per-user state for Review Lens, keyed by a stable *domain ID*
// (repoRoot + baseRef + headSha) — never by instanceId. Survives iframe
// reloads, extension reloads, and fresh instanceIds.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STORAGE_VERSION = 1;
const cache = new Map(); // domainId -> record

function storageRoot() {
	const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
	return join(home, "extensions", "review-lens", "artifacts");
}

export function domainId(repoRoot, baseRef, headSha) {
	return `${repoRoot}::${baseRef}..${headSha}`;
}

function fileFor(domain) {
	const hash = createHash("sha1").update(domain).digest("hex").slice(0, 16);
	return join(storageRoot(), `${hash}.json`);
}

function emptyRecord(domain) {
	return {
		version: STORAGE_VERSION,
		domain,
		dispositions: {}, // legacy per-snapshot review state (migrated into the ledger)
		tour: null, // { steps, current, generatedAt }
		base: null, // user base override
	};
}

export async function loadRecord(domain) {
	if (cache.has(domain)) return cache.get(domain);
	let record = emptyRecord(domain);
	try {
		const raw = JSON.parse(await readFile(fileFor(domain), "utf8"));
		if (raw?.version === STORAGE_VERSION) {
			record = { ...record, ...raw, domain };
		}
	} catch (err) {
		if (err?.code !== "ENOENT") {
			// Corrupt file: start fresh rather than crash the provider.
		}
	}
	cache.set(domain, record);
	return record;
}

export async function saveRecord(domain) {
	const record = cache.get(domain);
	if (!record) return;
	await mkdir(storageRoot(), { recursive: true });
	await writeFile(fileFor(domain), `${JSON.stringify(record, null, 2)}\n`);
}

export async function setDisposition(domain, key, state) {
	const record = await loadRecord(domain);
	if (state === null) {
		delete record.dispositions[key];
	} else {
		record.dispositions[key] = { state, at: new Date().toISOString() };
	}
	await saveRecord(domain);
	return record;
}

export async function patchRecord(domain, patch) {
	const record = await loadRecord(domain);
	Object.assign(record, patch);
	await saveRecord(domain);
	return record;
}

// --- Review ledger -----------------------------------------------------------
//
// The ledger records per-file review state keyed by *base scope only*
// (repoRoot + baseRef), NOT head. That's what lets a file stay "reviewed"
// across new commits: each entry stores a content fingerprint, and the caller
// decides staleness by comparing the stored fingerprint to the file's current
// one. Keeping head out of the key means new commits don't wipe review state.

const ledgerCache = new Map(); // ledgerKey -> ledger

export function ledgerId(repoRoot, baseRef) {
	return `${repoRoot}::${baseRef}`;
}

function ledgerFileFor(key) {
	const hash = createHash("sha1").update(`ledger:${key}`).digest("hex").slice(0, 16);
	return join(storageRoot(), `ledger-${hash}.json`);
}

function emptyLedger(key) {
	return { version: STORAGE_VERSION, key, files: {} };
	// files[path] = { state, sha, mergeBase, at }
}

export async function loadLedger(repoRoot, baseRef) {
	const key = ledgerId(repoRoot, baseRef);
	if (ledgerCache.has(key)) return ledgerCache.get(key);
	let ledger = emptyLedger(key);
	try {
		const raw = JSON.parse(await readFile(ledgerFileFor(key), "utf8"));
		if (raw?.version === STORAGE_VERSION && raw.files) {
			ledger = { ...ledger, ...raw, key };
		}
	} catch {
		// Missing or corrupt: start fresh.
	}
	ledgerCache.set(key, ledger);
	return ledger;
}

export async function saveLedger(repoRoot, baseRef) {
	const key = ledgerId(repoRoot, baseRef);
	const ledger = ledgerCache.get(key);
	if (!ledger) return;
	await mkdir(storageRoot(), { recursive: true });
	await writeFile(ledgerFileFor(key), `${JSON.stringify(ledger, null, 2)}\n`);
}

// Record (or clear) the review state for one file at a given fingerprint.
// fingerprint = { sha, mergeBase }.
export async function setFileReview(repoRoot, baseRef, path, state, fingerprint) {
	const ledger = await loadLedger(repoRoot, baseRef);
	if (state === null) {
		delete ledger.files[path];
	} else {
		ledger.files[path] = {
			state,
			sha: fingerprint?.sha ?? null,
			mergeBase: fingerprint?.mergeBase ?? null,
			at: new Date().toISOString(),
		};
	}
	await saveLedger(repoRoot, baseRef);
	return ledger;
}

// Move a ledger entry when a file is renamed but its content is unchanged.
export function renameLedgerEntry(ledger, oldPath, newPath) {
	if (!ledger.files[oldPath] || ledger.files[newPath]) return false;
	ledger.files[newPath] = ledger.files[oldPath];
	delete ledger.files[oldPath];
	return true;
}
