import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { initDatabase } from "./db";
import { startDemoRefresher } from "./demo-refresher";
import { EventChannel } from "./events";
import { startExpirySweeper } from "./expiry";
import { describeTelemetry, log, metrics } from "./telemetry";

const PORT = 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));

describeTelemetry();

// Migrations run at boot. At this size that's simply convenient; on a real
// deployment migrating from the app process is a bad default -- several
// instances starting at once all try to migrate, and a failed migration takes
// the service down with it. It belongs in a deploy step that runs once.
const db = initDatabase(join(__dirname, "data", "auction.db"), (message) =>
	log.info("db.migrate", { message }),
);

// One channel shared by the request handlers (which publish bids), the sweeper
// (closures) and the demo refresher (reopenings).
const channel = new EventChannel();

const sweeper = startExpirySweeper(db, channel);

// A development fixture: one listing that reopens roughly once a minute so the
// countdown's last seconds and the realtime updates behind them are always a
// few seconds away. DEMO_REFRESH=off turns it off.
const refresher =
	process.env.DEMO_REFRESH === "off" ? null : startDemoRefresher(db, channel);

if (refresher) {
	log.info("demo.refresher_started", { listingId: refresher.listingId });
}

const server = createApp(db, channel).listen(PORT, () => {
	log.info("server.started", { port: PORT, url: `http://localhost:${PORT}` });
});

// Open SSE streams are long-lived by design, so server.close() would otherwise
// wait on connections that are never going to end by themselves.
const shutdown = () => {
	log.info("server.shutting_down");
	sweeper.stop();
	refresher?.stop();
	channel.closeAll();

	// Last chance to ship buffered metrics before the process goes away.
	void metrics.flush().finally(() => {
		server.close(() => {
			db.close();
			process.exit(0);
		});
	});
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
