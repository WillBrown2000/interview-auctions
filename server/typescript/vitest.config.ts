import { defineConfig } from "vitest/config";

// Without a config here, Vitest walks up and picks up the frontend's
// vite.config.ts, loading the React plugin into a Node-only test run.
export default defineConfig({
	test: {
		environment: "node",
		// The request logger writes a line per request. Useful in a running
		// server, noise in a test run -- and it would drown the actual failure
		// output. Tests that care about logging assert on the sink directly.
		env: { LOG_LEVEL: "warn" },
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			reportsDirectory: "coverage",
			include: ["*.ts"],
			exclude: [
				// Boot wiring: binds a port and registers signal handlers, so
				// running it in a test suite starts a real server.
				"index.ts",
				"vitest.config.ts",
				// Development fixtures, not application code.
				"scripts/**",
			],
		},
	},
});
