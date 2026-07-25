import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { type Db, initDatabase } from "../db";
import { type AuctionEvent, EventChannel } from "../events";
import { startExpirySweeper } from "../expiry";
import { api, pendingListing } from "./helpers";

/**
 * `pending` means catalogued but not open for bidding yet.
 *
 * It shipped in the status enum with nothing able to set it and nothing able
 * to leave it — there was an end time and no start time, so "hasn't opened"
 * was a state the model could name and never reach. These cover both halves of
 * giving it a meaning: refusing bids before the window, and opening on time.
 */

class RecordingChannel extends EventChannel {
	published: AuctionEvent[] = [];
	publish(event: AuctionEvent): void {
		this.published.push(event);
		super.publish(event);
	}
}

function setStartsAt(db: Db, id: string, offsetMs: number): void {
	db.prepare("UPDATE listings SET starts_at = ? WHERE id = ?").run(
		new Date(Date.now() + offsetMs).toISOString(),
		id,
	);
}

describe("bidding before an auction opens", () => {
	it("refuses a bid on a pending listing", async () => {
		const res = await api()
			.post(`/api/listings/${pendingListing.id}/bids`)
			.send({ bidder: "Eager", amount: pendingListing.currentBid + 10_000 })
			.expect(400);

		expect(res.body.error).toMatch(/not opened yet|not currently active/i);
	});

	it("refuses even when the status says active but the clock disagrees", async () => {
		// The mirror of the expiry case. Status is what something got round to
		// writing; starts_at is the actual schedule. Between a lot being
		// created and the sweep noticing, the timestamp is the only truth.
		const db = initDatabase(":memory:");
		const supertest = (await import("supertest")).default;
		const app = supertest(createApp(db));

		const listing = db
			.prepare(
				"SELECT id, current_bid FROM listings WHERE status = 'active' LIMIT 1",
			)
			.get() as { id: string; current_bid: number };

		setStartsAt(db, listing.id, 60_000);

		const res = await app
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "Early", amount: listing.current_bid + 1_000 })
			.expect(400);

		expect(res.body.error).toMatch(/not opened yet/i);
		db.close();
	});

	it("records no bid history for a refused early bid", async () => {
		const app = api();
		await app
			.post(`/api/listings/${pendingListing.id}/bids`)
			.send({ bidder: "Eager", amount: pendingListing.currentBid + 10_000 })
			.expect(400);

		const history = await app
			.get(`/api/listings/${pendingListing.id}/bids`)
			.expect(200);
		expect(history.body).toEqual([]);
	});

	it("still lists pending auctions so they can be browsed", async () => {
		// The whole point of a preview window: visible, just not biddable.
		const res = await api().get("/api/listings?status=pending").expect(200);

		expect(res.body.pagination.totalItems).toBeGreaterThan(0);
		expect(
			res.body.data.every((l: { status: string }) => l.status === "pending"),
		).toBe(true);
	});

	it("exposes when bidding opens", async () => {
		const res = await api()
			.get(`/api/listings/${pendingListing.id}`)
			.expect(200);

		expect(Date.parse(res.body.startsAt)).toBeGreaterThan(Date.now());
		expect(Date.parse(res.body.endsAt)).toBeGreaterThan(
			Date.parse(res.body.startsAt),
		);
	});
});

describe("the sweep that opens scheduled auctions", () => {
	it("opens a pending listing once its start time passes", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const sweeper = startExpirySweeper(db, channel, 60_000);

		try {
			const target = pendingListing.id;
			expect(
				(
					db
						.prepare("SELECT status FROM listings WHERE id = ?")
						.get(target) as {
						status: string;
					}
				).status,
			).toBe("pending");

			setStartsAt(db, target, -1_000);
			const { opened } = sweeper.sweep();

			expect(opened.map((l) => l.id)).toContain(target);
			expect(
				(
					db
						.prepare("SELECT status FROM listings WHERE id = ?")
						.get(target) as {
						status: string;
					}
				).status,
			).toBe("active");
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("announces the opening so connected clients stop showing it as pending", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const sweeper = startExpirySweeper(db, channel, 60_000);

		try {
			setStartsAt(db, pendingListing.id, -1_000);
			channel.published.length = 0;
			sweeper.sweep();

			const update = channel.published.find(
				(e) => e.type === "updated" && e.listingId === pendingListing.id,
			);
			expect(update).toMatchObject({ status: "active" });
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("carries the real opening price, not an assumed zero", () => {
		// A scheduled lot can carry a reserve, so the event has to report what
		// the listing actually opens at.
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const sweeper = startExpirySweeper(db, channel, 60_000);

		try {
			setStartsAt(db, pendingListing.id, -1_000);
			channel.published.length = 0;
			sweeper.sweep();

			const update = channel.published.find(
				(e) => e.type === "updated" && e.listingId === pendingListing.id,
			) as Extract<AuctionEvent, { type: "updated" }>;

			expect(update.currentBid).toBe(pendingListing.currentBid);
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("leaves a listing pending while its start time is still ahead", () => {
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const sweeper = startExpirySweeper(db, channel, 60_000);

		try {
			const { opened } = sweeper.sweep();
			expect(opened.map((l) => l.id)).not.toContain(pendingListing.id);
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("accepts bids once the sweep has opened it", () => {
		const db = initDatabase(":memory:");
		const sweeper = startExpirySweeper(db, new RecordingChannel(), 60_000);

		try {
			setStartsAt(db, pendingListing.id, -1_000);
			sweeper.sweep();

			return import("supertest").then((m) =>
				m
					.default(createApp(db))
					.post(`/api/listings/${pendingListing.id}/bids`)
					.send({
						bidder: "On Time",
						amount: pendingListing.currentBid + 5_000,
					})
					.expect(201),
			);
		} finally {
			sweeper.stop();
		}
	});

	it("opens and closes in the same pass when a whole window elapsed", () => {
		// Opening runs before closing, so a lot whose entire window went by
		// between two sweeps ends up closed rather than stranded as pending
		// with an end date in the past.
		const db = initDatabase(":memory:");
		const channel = new RecordingChannel();
		const sweeper = startExpirySweeper(db, channel, 60_000);

		try {
			db.prepare(
				"UPDATE listings SET starts_at = ?, ends_at = ? WHERE id = ?",
			).run(
				new Date(Date.now() - 10_000).toISOString(),
				new Date(Date.now() - 5_000).toISOString(),
				pendingListing.id,
			);

			const { opened, closed } = sweeper.sweep();

			expect(opened.map((l) => l.id)).toContain(pendingListing.id);
			expect(closed.map((l) => l.id)).toContain(pendingListing.id);
			expect(
				(
					db
						.prepare("SELECT status FROM listings WHERE id = ?")
						.get(pendingListing.id) as { status: string }
				).status,
			).toBe("closed");
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("opens on its own interval", () => {
		vi.useFakeTimers();
		const db = initDatabase(":memory:");
		const sweeper = startExpirySweeper(db, new RecordingChannel(), 1_000);

		try {
			setStartsAt(db, pendingListing.id, -1);
			vi.advanceTimersByTime(1_100);

			expect(
				(
					db
						.prepare("SELECT status FROM listings WHERE id = ?")
						.get(pendingListing.id) as { status: string }
				).status,
			).toBe("active");
		} finally {
			sweeper.stop();
			vi.useRealTimers();
			db.close();
		}
	});
});

describe("scheduling a listing at creation", () => {
	it("creates a pending listing when the start date is in the future", async () => {
		const res = await api()
			.post("/api/listings")
			.send({
				title: "Scheduled Lot",
				startsAt: new Date(Date.now() + 3_600_000).toISOString(),
			})
			.expect(201);

		expect(res.body.status).toBe("pending");
	});

	it("creates an active listing when no start date is given", async () => {
		// Bidding opens immediately, which is what every listing did before
		// there was a start time at all.
		const res = await api()
			.post("/api/listings")
			.send({ title: "Open Now" })
			.expect(201);

		expect(res.body.status).toBe("active");
		expect(Date.parse(res.body.startsAt)).toBeLessThanOrEqual(Date.now());
	});

	it("derives the status from the dates rather than trusting the client", async () => {
		// A client-supplied status could disagree with the schedule it
		// describes -- an "active" listing that opens next week.
		const res = await api()
			.post("/api/listings")
			.send({
				title: "Nice Try",
				status: "active",
				startsAt: new Date(Date.now() + 3_600_000).toISOString(),
			})
			.expect(201);

		expect(res.body.status).toBe("pending");
	});

	it("defaults the end date relative to the start date", async () => {
		const startsAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
		const res = await api()
			.post("/api/listings")
			.send({ title: "Scheduled Run", startsAt })
			.expect(201);

		const days =
			(Date.parse(res.body.endsAt) - Date.parse(startsAt)) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThan(7.1);
	});

	it("rejects a window that closes before it opens", async () => {
		const res = await api()
			.post("/api/listings")
			.send({
				title: "Backwards",
				startsAt: new Date(Date.now() + 7_200_000).toISOString(),
				endsAt: new Date(Date.now() + 3_600_000).toISOString(),
			})
			.expect(400);

		expect(res.body.error).toMatch(/after the start date/i);
	});

	it("rejects a start date more than a year out", async () => {
		const res = await api()
			.post("/api/listings")
			.send({
				title: "Far Future",
				startsAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
			})
			.expect(400);

		expect(res.body.error).toMatch(/within a year/i);
	});

	it("rejects an unparseable start date", async () => {
		const res = await api()
			.post("/api/listings")
			.send({ title: "Nonsense", startsAt: "whenever" })
			.expect(400);

		expect(res.body.error).toMatch(/not a valid date/i);
	});

	it("refuses bids on a listing scheduled at creation", async () => {
		const app = api();
		const created = await app
			.post("/api/listings")
			.send({
				title: "Not Open Yet",
				startingPrice: 1_000,
				startsAt: new Date(Date.now() + 3_600_000).toISOString(),
			})
			.expect(201);

		const res = await app
			.post(`/api/listings/${created.body.id}/bids`)
			.send({ bidder: "Eager", amount: 5_000 })
			.expect(400);

		expect(res.body.error).toMatch(/not opened yet|not currently active/i);
	});
});
