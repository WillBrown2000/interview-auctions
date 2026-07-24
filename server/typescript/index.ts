import { createApp } from "./app";

const PORT = 3001;

// Entry point only. The app itself lives in app.ts and is never bound to a
// port there, so tests can mount it with supertest without needing one free.
createApp().listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}`);
});
