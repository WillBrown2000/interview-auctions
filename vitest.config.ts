import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the dev-server proxy config doesn't apply to
// tests, and so the backend's own Vitest setup stays independent of this one.
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/test-setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			reportsDirectory: "coverage",
			include: ["src/**/*.{ts,tsx}"],
			exclude: [
				// Entry point: three lines of createRoot with nothing to assert.
				"src/main.tsx",
				"src/test-setup.ts",
				"src/**/*.test.{ts,tsx}",
				// Type-only, erased at compile time — no statements to cover.
				"src/types.ts",
			],
		},
	},
});
