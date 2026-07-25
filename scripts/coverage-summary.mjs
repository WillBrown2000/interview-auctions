#!/usr/bin/env node
/**
 * Prints one coverage table for both halves of the project.
 *
 * The frontend and the API are separate packages with separate Vitest runs, so
 * `--coverage` on either only ever tells half the story. This reads both
 * json-summary reports and shows them together, which is the number that
 * actually answers "how covered is this repo".
 *
 * Run via `make coverage`, which produces the reports first.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const REPORTS = [
	{ name: "Frontend", path: join(root, "coverage/coverage-summary.json") },
	{
		name: "API",
		path: join(root, "server/typescript/coverage/coverage-summary.json"),
	},
];

const METRICS = ["statements", "branches", "functions", "lines"];

function read(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8")).total;
	} catch {
		return null;
	}
}

// 90 is the line between "covered" and "mostly covered" here; below 75 is
// flagged outright. Colour only — nothing exits non-zero, because a coverage
// number is a prompt to look, not a build failure.
function colour(pct) {
	if (pct >= 90) return `\x1b[32m${pct.toFixed(2).padStart(6)}%\x1b[0m`;
	if (pct >= 75) return `\x1b[33m${pct.toFixed(2).padStart(6)}%\x1b[0m`;
	return `\x1b[31m${pct.toFixed(2).padStart(6)}%\x1b[0m`;
}

const rows = [];
const totals = Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));

for (const report of REPORTS) {
	const summary = read(report.path);
	if (!summary) {
		rows.push({ name: report.name, missing: true });
		continue;
	}

	for (const metric of METRICS) {
		totals[metric].covered += summary[metric].covered;
		totals[metric].total += summary[metric].total;
	}

	rows.push({ name: report.name, summary });
}

const header = `${"".padEnd(12)}${METRICS.map((m) => m.slice(0, 10).padStart(11)).join("")}`;

console.log(`\n\x1b[1mCoverage\x1b[0m\n`);
console.log(header);
console.log("-".repeat(header.length));

for (const row of rows) {
	if (row.missing) {
		console.log(`${row.name.padEnd(12)}  no report - run \`make coverage\``);
		continue;
	}
	const cells = METRICS.map((m) => colour(row.summary[m].pct)).join("    ");
	console.log(`${row.name.padEnd(12)}${cells}`);
}

console.log("-".repeat(header.length));

const combined = METRICS.map((m) => {
	const { covered, total } = totals[m];
	return colour(total === 0 ? 100 : (covered / total) * 100);
}).join("    ");

console.log(`${"Combined".padEnd(12)}${combined}`);

const lines = totals.lines;
console.log(
	`\n${lines.covered}/${lines.total} lines covered across both packages.`,
);
console.log("HTML reports: coverage/index.html, server/typescript/coverage/index.html\n");
