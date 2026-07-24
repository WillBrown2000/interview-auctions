import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { initDatabase } from "./db";

const PORT = 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Migrations run at boot. At this size that's simply convenient; on a real
// deployment migrating from the app process is a bad default -- several
// instances starting at once all try to migrate, and a failed migration takes
// the service down with it. It belongs in a deploy step that runs once.
const db = initDatabase(join(__dirname, "data", "auction.db"), (message) =>
	console.log(message),
);

createApp(db).listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}`);
});
