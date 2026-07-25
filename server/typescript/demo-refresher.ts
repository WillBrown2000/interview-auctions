import { randomUUID } from "node:crypto";
import type { Db } from "./db";
import type { EventChannel } from "./events";
import { log } from "./telemetry";

/**
 * Keeps one listing perpetually about to expire.
 *
 * Without it, seeing the countdown's final seconds or the live flip to Ended
 * means reseeding and racing the clock. This lot resets itself on a loop, so
 * the interesting states are always a few seconds away — which matters most
 * for anyone opening the app for the first time to review it.
 *
 * It exercises the whole chain rather than just the display: the sweeper
 * notices the expiry and publishes `closed`, the refresher reopens it and
 * publishes `updated`, and both reach every connected browser over SSE. If
 * realtime is broken, this listing visibly stops moving.
 *
 * A development aid, and honest about it — the title says so, and
 * DEMO_REFRESH=off disables it. Nothing else in the app depends on it.
 */

const TITLE = "Minute Refreshing Item";

const DEFAULT_LIVE_MS = 60_000;
/** Ended long enough to be noticed before it reopens. */
const DEFAULT_ENDED_MS = 20_000;

export interface DemoRefresher {
	listingId: string;
	/** Reopens the listing immediately. Returns its new end time. */
	refresh(): string;
	stop(): void;
}

export function startDemoRefresher(
	db: Db,
	channel: EventChannel,
	options: { liveMs?: number; endedMs?: number } = {},
): DemoRefresher {
	const liveMs = options.liveMs ?? DEFAULT_LIVE_MS;
	const endedMs = options.endedMs ?? DEFAULT_ENDED_MS;

	const insertRow = db.prepare(`
		INSERT INTO listings (
			id, title, description, category, starting_price,
			current_bid, current_bidder, status, ends_at, image_url
		) VALUES (
			@id, @title, @description, 'implement', 25000,
			25000, NULL, 'active', @endsAt, @imageUrl
		)
	`);

	const create = (id: string) => {
		insertRow.run({
			id,
			title: TITLE,
			description:
				"A development fixture. This lot reopens roughly once a minute so the countdown's final seconds, the switch to its ended state, and the realtime updates behind both can be watched without waiting for a real auction to close.",
			endsAt: new Date(Date.now() + liveMs).toISOString(),
			imageUrl: "https://placehold.co/400x300?text=Minute+Refreshing+Item",
		});
	};

	// Found by title so restarts reuse the same row instead of adding one
	// every boot.
	const existing = db
		.prepare("SELECT id FROM listings WHERE title = ?")
		.get(TITLE) as { id: string } | undefined;

	const listingId = existing?.id ?? randomUUID();

	if (!existing) create(listingId);

	// Bids are cleared each cycle. They accumulate otherwise, and since each
	// bid must beat the last, an afternoon of cycles would leave a starting
	// price in the millions.
	const clearBids = db.prepare("DELETE FROM bids WHERE listing_id = ?");
	const reopen = db.prepare(`
		UPDATE listings
		   SET ends_at = @endsAt,
		       status = 'active',
		       current_bid = starting_price,
		       current_bidder = NULL
		 WHERE id = @id
	`);
	const read = db.prepare(
		"SELECT status, ends_at, current_bid, current_bidder FROM listings WHERE id = ?",
	);

	const exists = db.prepare("SELECT 1 FROM listings WHERE id = ?");

	const refresh = (): string => {
		const endsAt = new Date(Date.now() + liveMs).toISOString();

		db.transaction(() => {
			// The row can go away underneath this -- `npm run seed:demo` clears
			// the table, and anything that deletes listings would do the same.
			// The old code assumed it was there forever and read undefined off
			// the result, which threw inside the interval and took the process
			// down with it. Putting it back is the right answer for a fixture:
			// the point is that it's always available to look at.
			if (!exists.get(listingId)) create(listingId);

			clearBids.run(listingId);
			reopen.run({ id: listingId, endsAt });
		})();

		const row = read.get(listingId) as {
			status: string;
			ends_at: string;
			current_bid: number;
			current_bidder: string | null;
		};

		// Clients already holding this listing think it's closed. Only an event
		// tells them otherwise -- without this the card stays greyed out until
		// something else triggers a refetch.
		channel.publish({
			type: "updated",
			listingId,
			status: row.status,
			endsAt: row.ends_at,
			currentBid: row.current_bid,
			currentBidder: row.current_bidder,
		});

		return endsAt;
	};

	refresh();

	// Wrapped because an exception thrown from a timer callback is unhandled
	// and terminates the process. A development fixture should never be able to
	// take the server with it -- if this breaks, the right outcome is a log
	// line and a server that carries on serving auctions.
	const timer = setInterval(() => {
		try {
			refresh();
		} catch (err) {
			log.error("demo.refresh_failed", {
				listingId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}, liveMs + endedMs);

	// A development fixture should never be the reason the process won't exit.
	timer.unref();

	return {
		listingId,
		refresh,
		stop: () => clearInterval(timer),
	};
}

export const DEMO_REFRESHER_TITLE = TITLE;
