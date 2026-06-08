// Per-line syntax highlighting for the diff pane. Uses highlight.js core with
// a hand-picked language set to keep the single-file bundle lean. Lines are
// highlighted individually (diff hunks aren't valid multi-line programs), with
// the language inferred from the file extension; unknown extensions fall back
// to plain escaped text.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const EXT_TO_LANG: Record<string, string> = {
	bash: "bash",
	sh: "bash",
	zsh: "bash",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	css: "css",
	go: "go",
	ini: "ini",
	toml: "ini",
	java: "java",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	kt: "kotlin",
	kts: "kotlin",
	md: "markdown",
	markdown: "markdown",
	php: "php",
	py: "python",
	rb: "ruby",
	rs: "rust",
	scss: "scss",
	sql: "sql",
	swift: "swift",
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	html: "xml",
	htm: "xml",
	svg: "xml",
	xml: "xml",
	vue: "xml",
	yaml: "yaml",
	yml: "yaml",
};

const BASENAME_TO_LANG: Record<string, string> = {
	dockerfile: "bash",
	makefile: "bash",
	".bashrc": "bash",
	".zshrc": "bash",
};

export function languageForPath(path: string): string | null {
	const base = path.split("/").pop()?.toLowerCase() ?? "";
	if (BASENAME_TO_LANG[base]) return BASENAME_TO_LANG[base];
	const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
	return EXT_TO_LANG[ext] ?? null;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/**
 * Highlight one line of code as HTML. `language` of null (or a highlight
 * failure) falls back to plain escaping, so output is always safe to inject.
 */
export function highlightLine(code: string, language: string | null): string {
	if (!language) return escapeHtml(code);
	try {
		return hljs.highlight(code, { language, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(code);
	}
}
