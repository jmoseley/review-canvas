// Durable per-user state for Review Lens, keyed by a stable *domain ID*
// (repoRoot + baseRef + headSha) — never by instanceId. Survives iframe
// reloads, extension reloads, and fresh instanceIds.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Disposition, TourStep } from "../shared/types.js";

const STORAGE_VERSION = 1;

/** Persisted tour shape (derived fields like per-step rollups are recomputed). */
export interface StoredTour {
	steps: TourStep[];
	current: number;
	generatedAt: string;
	mergeBase: string | null;
	files: { path: string; sha: string | null }[];
	stale?: boolean;
}

export interface StoredRecord {
	version: number;
	domain: string;
	/** Legacy per-snapshot review state (migrated into the ledger). */
	dispositions: Record<string, { state: Disposition; at?: string }>;
	tour: StoredTour | null;
	/** User base override. */
	base: string | null;
}

export interface LedgerEntry {
	state: Disposition;
	sha: string | null;
	mergeBase: string | null;
	at: string;
}

export interface Ledger {
	version: number;
	key: string;
	files: Record<string, LedgerEntry>;
}

const cache = new Map<string, StoredRecord>();

function storageRoot(): string {
	const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
	return join(home, "extensions", "review-lens", "artifacts");
}

export function domainId(repoRoot: string, baseRef: string, headSha: string): string {
	return `${repoRoot}::${baseRef}..${headSha}`;
}

function fileFor(domain: string): string {
	const hash = createHash("sha1").update(domain).digest("hex").slice(0, 16);
	return join(storageRoot(), `${hash}.json`);
}

function emptyRecord(domain: string): StoredRecord {
	return {
		version: STORAGE_VERSION,
		domain,
		dispositions: {},
		tour: null,
		base: null,
	};
}

export async function loadRecord(domain: string): Promise<StoredRecord> {
	const cached = cache.get(domain);
	if (cached) return cached;
	let record = emptyRecord(domain);
	try {
		const raw = JSON.parse(await readFile(fileFor(domain), "utf8"));
		if (raw?.version === STORAGE_VERSION) {
			record = { ...record, ...raw, domain };
		}
	} catch {
		// Missing or corrupt file: start fresh rather than crash the provider.
	}
	cache.set(domain, record);
	return record;
}

export async function saveRecord(domain: string): Promise<void> {
	const record = cache.get(domain);
	if (!record) return;
	await mkdir(storageRoot(), { recursive: true });
	await writeFile(fileFor(domain), `${JSON.stringify(record, null, 2)}\n`);
}

export async function patchRecord(
	domain: string,
	patch: Partial<StoredRecord>,
): Promise<StoredRecord> {
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

const ledgerCache = new Map<string, Ledger>();

export function ledgerId(repoRoot: string, baseRef: string): string {
	return `${repoRoot}::${baseRef}`;
}

function ledgerFileFor(key: string): string {
	const hash = createHash("sha1").update(`ledger:${key}`).digest("hex").slice(0, 16);
	return join(storageRoot(), `ledger-${hash}.json`);
}

function emptyLedger(key: string): Ledger {
	return { version: STORAGE_VERSION, key, files: {} };
}

export async function loadLedger(repoRoot: string, baseRef: string): Promise<Ledger> {
	const key = ledgerId(repoRoot, baseRef);
	const cached = ledgerCache.get(key);
	if (cached) return cached;
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

export async function saveLedger(repoRoot: string, baseRef: string): Promise<void> {
	const key = ledgerId(repoRoot, baseRef);
	const ledger = ledgerCache.get(key);
	if (!ledger) return;
	await mkdir(storageRoot(), { recursive: true });
	await writeFile(ledgerFileFor(key), `${JSON.stringify(ledger, null, 2)}\n`);
}

// Record (or clear) the review state for one file at a given fingerprint.
export async function setFileReview(
	repoRoot: string,
	baseRef: string,
	path: string,
	state: Disposition | null,
	fingerprint: { sha: string | null; mergeBase: string | null },
): Promise<Ledger> {
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
export function renameLedgerEntry(
	ledger: Ledger,
	oldPath: string,
	newPath: string,
): boolean {
	if (!ledger.files[oldPath] || ledger.files[newPath]) return false;
	ledger.files[newPath] = ledger.files[oldPath];
	delete ledger.files[oldPath];
	return true;
}
