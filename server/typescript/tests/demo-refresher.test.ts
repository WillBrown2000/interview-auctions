import { describe, expect, it, vi } from "vitest";
import { type Db, initDatabase } from "../db";
import { DEMO_REFRESHER_TITLE, startDemoRefresher } from "../demo-refresher";
import { type AuctionEvent, EventChannel } from "../events";

class RecordingChannel extends EventChannel {
	published: AuctionEvent[] = [];
	publish(event: AuctionEvent): void {
		this.published.push(event);
		super.publish(event);
	}
}

function listingRow(db: Db, id: string) {
	return db.prepare("SELECT * FROM listings WHERE id = ?").get(id) as {
		title: string;
		status: string;
		ends_at: string;
		current_bid: number;
		starting_price: number;
		current_bidder: string | null;
	};
}

describe("demo refresher", () => {
	it("creates its listing if it is missing", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			const row = listingRow(db, refresher.listingId);
			expect(row.title).toBe(DEMO_REFRESHER_TITLE);
			expect(row.status).toBe("active");
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("reuses the existing listing rather than adding one per restart", () => {
		// Found by title, so a server restarted twenty times still has one.
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();

		const first = startDemoRefresher(db, channel);
		first.stop();
		const second = startDemoRefresher(db, channel);
		second.stop();

		try {
			const count = db
				.prepare("SELECT COUNT(*) c FROM listings WHERE title = ?")
				.get(DEMO_REFRESHER_TITLE) as { c: number };

			expect(count.c).toBe(1);
			expect(second.listingId).toBe(first.listingId);
		} finally {
			db.close();
		}
	});

	it("opens with a deadline in the future", () => {
		const db = initDatabase(":memory:");
		const refresher = startDemoRefresher(db, new RecordingChannel(), {
			liveMs: 60_000,
		});

		try {
			const row = listingRow(db, refresher.listingId);
			expect(Date.parse(row.ends_at)).toBeGreaterThan(Date.now());
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("announces each reopening so connected clients learn about it", () => {
		// Clients already showing this listing think it is closed. Nothing but
		// an event tells them otherwise.
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			const updates = channel.published.filter((e) => e.type === "updated");
			expect(updates).toHaveLength(1);
			expect(updates[0]).toMatchObject({
				listingId: refresher.listingId,
				status: "active",
			});
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("reopens a listing the sweeper has closed", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			db.prepare("UPDATE listings SET status = 'closed' WHERE id = ?").run(
				refresher.listingId,
			);

			refresher.refresh();

			expect(listingRow(db, refresher.listingId).status).toBe("active");
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("resets the price each cycle so it cannot climb forever", () => {
		// Every bid has to beat the last. Without a reset, an afternoon of
		// cycles leaves a starting price in the millions.
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			const start = listingRow(db, refresher.listingId).starting_price;
			db.prepare(
				"UPDATE listings SET current_bid = ?, current_bidder = ? WHERE id = ?",
			).run(start * 10, "Somebody", refresher.listingId);

			refresher.refresh();

			const row = listingRow(db, refresher.listingId);
			expect(row.current_bid).toBe(start);
			expect(row.current_bidder).toBeNull();
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("clears the previous cycle's bids", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			db.prepare(
				"INSERT INTO bids (id, listing_id, bidder, amount, placed_at) VALUES (?,?,?,?,?)",
			).run(
				"bid-1",
				refresher.listingId,
				"Jane",
				99_999,
				new Date().toISOString(),
			);

			refresher.refresh();

			const count = db
				.prepare("SELECT COUNT(*) c FROM bids WHERE listing_id = ?")
				.get(refresher.listingId) as { c: number };
			expect(count.c).toBe(0);
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("reopens on its own schedule", () => {
		vi.useFakeTimers();
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel, {
			liveMs: 1_000,
			endedMs: 500,
		});

		try {
			const before = channel.published.length;
			vi.advanceTimersByTime(1_600);
			expect(channel.published.length).toBeGreaterThan(before);
		} finally {
			refresher.stop();
			vi.useRealTimers();
			db.close();
		}
	});

	it("stops when told to", () => {
		vi.useFakeTimers();
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();

		try {
			const refresher = startDemoRefresher(db, channel, {
				liveMs: 1_000,
				endedMs: 500,
			});
			refresher.stop();
			const after = channel.published.length;

			vi.advanceTimersByTime(10_000);

			expect(channel.published).toHaveLength(after);
		} finally {
			vi.useRealTimers();
			db.close();
		}
	});

	it("recreates its listing if something deletes it", () => {
		// `npm run seed:demo` clears the listings table. The refresher used to
		// keep an id it assumed was there forever, read undefined off the next
		// query, and throw inside its own interval -- which is unhandled and
		// takes the process down.
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			db.exec("DELETE FROM bids");
			db.exec("DELETE FROM listings");

			expect(() => refresher.refresh()).not.toThrow();

			const row = listingRow(db, refresher.listingId);
			expect(row.title).toBe(DEMO_REFRESHER_TITLE);
			expect(row.status).toBe("active");
		} finally {
			refresher.stop();
			db.close();
		}
	});

	it("keeps the server alive when a cycle fails", () => {
		// Whatever goes wrong in a development fixture, the answer is a log
		// line and a server that carries on serving auctions.
		vi.useFakeTimers();
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel, {
			liveMs: 1_000,
			endedMs: 500,
		});

		try {
			// Closing the database makes every statement throw from inside the
			// timer callback.
			db.close();

			expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
		} finally {
			refresher.stop();
			vi.useRealTimers();
		}
	});

	it("does not disturb the rest of the fixture", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const refresher = startDemoRefresher(db, channel);

		try {
			const others = db
				.prepare("SELECT COUNT(*) c FROM listings WHERE title != ?")
				.get(DEMO_REFRESHER_TITLE) as { c: number };
			expect(others.c).toBe(8);
		} finally {
			refresher.stop();
			db.close();
		}
	});
});
