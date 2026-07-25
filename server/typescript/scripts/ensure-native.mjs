#!/usr/bin/env node
/**
 * Checks that the native SQLite binding actually loaded, and repairs it if not.
 *
 * better-sqlite3 ships prebuilt binaries for most platforms. x64 macOS on Node
 * 20 isn't one of them, so there it compiles from source — and on recent Xcode
 * Command Line Tools the C++ standard headers aren't on the default include
 * path. The build dies with:
 *
 *     fatal error: 'climits' file not found
 *
 * buried in a hundred lines of node-gyp output, which is not a useful thing to
 * hand someone who just cloned the repo. Pointing the compiler at the SDK's
 * libc++ headers fixes it.
 *
 * This runs as a postinstall. better-sqlite3 is an optionalDependency so that a
 * failed build doesn't abort the install before we get a chance to fix it.
 *
 * Exit codes: 0 if the binding works (already, or after a repair), 1 with
 * instructions if it can't be fixed here.
 */

import { execFileSync } from "node:child_process";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

/**
 * Whether the binding loads, checked in a child process.
 *
 * Not with require() here: once a load has failed in this process, requiring
 * again after a rebuild doesn't pick up the newly written .node file, so the
 * check reports failure on a binding that is actually fine. A fresh process has
 * no such state.
 *
 * Constructing a Database is the real test — the module can resolve and still
 * fail on the dlopen of a binary built for another architecture.
 */
function loads() {
	try {
		execFileSync(
			process.execPath,
			[
				"-e",
				"const D = require('better-sqlite3'); new D(':memory:').close();",
			],
			{ cwd: process.cwd(), stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

/** The SDK's libc++ include directory, or null if this isn't macOS. */
function macSdkIncludePath() {
	if (process.platform !== "darwin") return null;
	try {
		const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return sdk ? `${sdk}/usr/include/c++/v1` : null;
	} catch {
		return null;
	}
}

if (loads()) process.exit(0);

console.log(
	`${YELLOW}better-sqlite3 did not build. Attempting to repair.${OFF}`,
);

const includePath = macSdkIncludePath();

if (!includePath) {
	console.error(`
${RED}Could not build the native SQLite binding.${OFF}

This is only automatic on macOS. On other platforms, install a C++ toolchain
and run:

    npm rebuild better-sqlite3 --build-from-source
`);
	process.exit(1);
}

console.log(`${DIM}  using C++ headers from ${includePath}${OFF}`);

try {
	execFileSync(
		"npm",
		["install", "better-sqlite3", "--build-from-source", "--no-save"],
		{
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				CPLUS_INCLUDE_PATH: [includePath, process.env.CPLUS_INCLUDE_PATH]
					.filter(Boolean)
					.join(":"),
			},
		},
	);
} catch (err) {
	const detail = err?.stderr?.toString().trim().split("\n").slice(-6).join("\n");
	console.error(`
${RED}Repair failed.${OFF}

${DIM}${detail ?? String(err)}${OFF}

Try, from server/typescript:

    export CPLUS_INCLUDE_PATH="$(xcrun --sdk macosx --show-sdk-path)/usr/include/c++/v1"
    npm rebuild better-sqlite3 --build-from-source

If that still fails, the Command Line Tools may be incomplete:

    xcode-select --install
`);
	process.exit(1);
}

if (!loads()) {
	console.error(
		`${RED}Rebuilt, but the binding still won't load. See the README's troubleshooting section.${OFF}`,
	);
	process.exit(1);
}

console.log(`${GREEN}  repaired — native SQLite binding is working.${OFF}`);
