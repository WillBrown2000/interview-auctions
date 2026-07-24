import { defineConfig } from "vitest/config";

// Without a config here, Vitest walks up and picks up the frontend's
// vite.config.ts, loading the React plugin into a Node-only test run.
export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
