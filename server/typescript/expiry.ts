import type { Db } from "./db";
import type { EventChannel } from "./events";
import { log, metrics } from "./telemetry";

/**
 * Moves auctions past their end time into a closed state, and announces it.
 *
 * Why this exists at all, given the bid endpoint already refuses late bids:
 * that check protects correctness, but it leaves the stored data wrong. A
 * listing sits marked "active" with its deadline in the past, so
 * `?status=active` returns finished auctions and every client has to re-derive
 * what the server already knows. The sweep makes the stored state true.
 *
 * Why the bid check still has to exist, given this sweep: a sweep has an
 * interval, and that interval is exactly the window in which a late bid would
 * be accepted. The sweep is for tidiness and queryability; the comparison
 * inside the bid transaction is what is load-bearing. Neither replaces the
 * other.
 *
 * On not blocking: this is a single indexed UPDATE, not a scan and not a
 * per-row loop. better-sqlite3 is synchronous, so it does occupy the event
 * loop for the duration of the statement — the reason to keep it one
 * set-based statement rather than reading rows and updating them one by one.
 * At a size where the sweep itself got slow, it would move to a worker or to
 * an out-of-process job, which is also where it belongs once more than one
 * instance is running: every instance sweeping the same table is redundant
 * work and a lock fight.
 */

const DEFAULT_INTERVAL_MS = 5_000;

export interface Sweeper {
	/** Runs one pass immediately. Returns the listings it closed. */
	sweep(): { id: string; endsAt: string }[];
	stop(): void;
}

export function startExpirySweeper(
	db: Db,
	channel: EventChannel,
	intervalMs: number = DEFAULT_INTERVAL_MS,
): Sweeper {
	// RETURNING lets the update report what it changed, so finding the expired
	// rows and closing them is one statement instead of a select followed by an
	// update — which would race with a bid landing between the two.
	const closeExpired = db.prepare(`
		UPDATE listings
		   SET status = 'closed'
		 WHERE status = 'active'
		   AND ends_at <= @now
		RETURNING id, ends_at AS endsAt
	`);

	const sweep = () => {
		const startedAt = Date.now();

		const closed = closeExpired.all({ now: new Date().toISOString() }) as {
			id: string;
			endsAt: string;
		}[];

		for (const listing of closed) {
			channel.publish({
				type: "closed",
				listingId: listing.id,
				endsAt: listing.endsAt,
			});
		}

		// Timed on every pass, not just the ones that close something. The
		// sweep runs on the event loop, so its duration is the number worth
		// watching -- a slow sweep delays every request behind it.
		metrics.timing("expiry.sweep", Date.now() - startedAt);

		if (closed.length > 0) {
			metrics.count("auction.closed", [], closed.length);
			log.info("auction.expired", {
				count: closed.length,
				listingIds: closed.map((l) => l.id),
			});
		}

		return closed;
	};

	sweep();
	const timer = setInterval(sweep, intervalMs);

	// The sweeper should not be the reason the process refuses to exit.
	timer.unref();

	return {
		sweep,
		stop: () => clearInterval(timer),
	};
}
