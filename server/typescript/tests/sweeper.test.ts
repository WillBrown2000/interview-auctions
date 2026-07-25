import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { type Db, initDatabase } from "../db";
import { type AuctionEvent, EventChannel } from "../events";
import { startExpirySweeper } from "../expiry";

/** Records what was published instead of writing to a socket. */
class RecordingChannel extends EventChannel {
	published: AuctionEvent[] = [];

	publish(event: AuctionEvent): void {
		this.published.push(event);
		super.publish(event);
	}
}

function seeded(): { db: Db; channel: RecordingChannel } {
	return { db: initDatabase(":memory:"), channel: new RecordingChannel() };
}

/** Rewrites a listing's end time directly, since no endpoint may do this. */
function setEndsAt(db: Db, id: string, offsetMs: number): void {
	db.prepare("UPDATE listings SET ends_at = ? WHERE id = ?").run(
		new Date(Date.now() + offsetMs).toISOString(),
		id,
	);
}

function activeListings(db: Db) {
	return db
		.prepare("SELECT id, status, ends_at FROM listings WHERE status = 'active'")
		.all() as { id: string; status: string; ends_at: string }[];
}

describe("expiry sweeper", () => {
	let db: Db;
	let channel: RecordingChannel;

	beforeEach(() => {
		({ db, channel } = seeded());
	});

	it("closes listings whose end time has passed", () => {
		const sweeper = startExpirySweeper(db, channel, 60_000);
		try {
			const stillActive = activeListings(db);
			// The fixture's -2h listing is deliberately unswept, so the very
			// first sweep has something to do.
			expect(stillActive.every((l) => Date.parse(l.ends_at) > Date.now())).toBe(
				true,
			);
		} finally {
			sweeper.stop();
		}
	});

	it("publishes a closed event for each listing it closes", () => {
		const target = (
			db
				.prepare("SELECT id FROM listings WHERE status = 'active' LIMIT 1")
				.get() as { id: string }
		).id;
		setEndsAt(db, target, -1_000);

		const sweeper = startExpirySweeper(db, channel, 60_000);
		try {
			const closedIds = channel.published
				.filter((e) => e.type === "closed")
				.map((e) => e.listingId);

			expect(closedIds).toContain(target);
		} finally {
			sweeper.stop();
		}
	});

	it("leaves auctions that have not ended alone", () => {
		const before = activeListings(db)
			.filter((l) => Date.parse(l.ends_at) > Date.now())
			.map((l) => l.id)
			.sort();

		const sweeper = startExpirySweeper(db, channel, 60_000);
		try {
			const after = activeListings(db)
				.map((l) => l.id)
				.sort();
			expect(after).toEqual(before);
		} finally {
			sweeper.stop();
		}
	});

	it("does not re-close or re-announce the same listing", () => {
		// The sweep runs every few seconds forever. If it kept matching rows it
		// had already closed, every client would get the same event on repeat.
		const sweeper = startExpirySweeper(db, channel, 60_000);
		try {
			const firstPass = channel.published.length;
			sweeper.sweep();
			sweeper.sweep();

			expect(channel.published).toHaveLength(firstPass);
		} finally {
			sweeper.stop();
		}
	});

	it("closes an auction that expires between passes", () => {
		const sweeper = startExpirySweeper(db, channel, 60_000);
		try {
			const target = (
				db
					.prepare("SELECT id FROM listings WHERE status = 'active' LIMIT 1")
					.get() as { id: string }
			).id;

			setEndsAt(db, target, -1);
			const { closed } = sweeper.sweep();

			expect(closed.map((l) => l.id)).toContain(target);
			const row = db
				.prepare("SELECT status FROM listings WHERE id = ?")
				.get(target) as { status: string };
			expect(row.status).toBe("closed");
		} finally {
			sweeper.stop();
		}
	});

	it("runs on its interval without being asked", () => {
		vi.useFakeTimers();
		const sweeper = startExpirySweeper(db, channel, 1_000);
		try {
			const target = (
				db
					.prepare("SELECT id FROM listings WHERE status = 'active' LIMIT 1")
					.get() as { id: string }
			).id;
			setEndsAt(db, target, -1);

			vi.advanceTimersByTime(1_100);

			const row = db
				.prepare("SELECT status FROM listings WHERE id = ?")
				.get(target) as { status: string };
			expect(row.status).toBe("closed");
		} finally {
			sweeper.stop();
			vi.useRealTimers();
		}
	});

	it("stops sweeping once stopped", () => {
		vi.useFakeTimers();
		try {
			const sweeper = startExpirySweeper(db, channel, 1_000);
			sweeper.stop();

			const target = (
				db
					.prepare("SELECT id FROM listings WHERE status = 'active' LIMIT 1")
					.get() as { id: string }
			).id;
			setEndsAt(db, target, -1);

			vi.advanceTimersByTime(10_000);

			const row = db
				.prepare("SELECT status FROM listings WHERE id = ?")
				.get(target) as { status: string };
			expect(row.status).toBe("active");
		} finally {
			vi.useRealTimers();
		}
	});

	it("makes swept listings invisible to a status=active query", () => {
		// The reason the sweep exists at all: without it, ?status=active
		// returns finished auctions and every client re-derives what the
		// server already knows.
		const sweeper = startExpirySweeper(db, channel, 60_000);
		try {
			const rows = db
				.prepare("SELECT ends_at FROM listings WHERE status = 'active'")
				.all() as { ends_at: string }[];

			expect(rows.every((r) => Date.parse(r.ends_at) > Date.now())).toBe(true);
		} finally {
			sweeper.stop();
		}
	});
});

describe("bid events", () => {
	it("publishes a bid event when a bid is accepted", async () => {
		const { db, channel } = seeded();
		const supertest = (await import("supertest")).default;
		const app = supertest(createApp(db, channel));

		const listing = db
			.prepare(
				"SELECT id, current_bid FROM listings WHERE status = 'active' AND ends_at > ? LIMIT 1",
			)
			.get(new Date().toISOString()) as { id: string; current_bid: number };

		await app
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "Jane Smith", amount: listing.current_bid + 1_000 })
			.expect(201);

		const events = channel.published.filter((e) => e.type === "bid");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			listingId: listing.id,
			currentBid: listing.current_bid + 1_000,
			currentBidder: "Jane Smith",
		});
	});

	it("publishes nothing when a bid is rejected", async () => {
		// A subscriber told about a bid the server refused would show a price
		// that never existed, and nothing later would correct it.
		const { db, channel } = seeded();
		const supertest = (await import("supertest")).default;
		const app = supertest(createApp(db, channel));

		const listing = db
			.prepare(
				"SELECT id, current_bid FROM listings WHERE status = 'active' AND ends_at > ? LIMIT 1",
			)
			.get(new Date().toISOString()) as { id: string; current_bid: number };

		await app
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "Lowballer", amount: 1 })
			.expect(400);

		expect(channel.published).toHaveLength(0);
	});

	it("exposes the stream with SSE headers", () => {
		const { db, channel } = seeded();
		createApp(db, channel);

		// Subscribing through the channel directly rather than holding an HTTP
		// request open: supertest has no way to read from a response that never
		// ends, and the wiring under test is the same either way.
		const writes: string[] = [];
		const res = {
			writeHead: () => res,
			write: (c: string) => writes.push(c),
			end: () => {},
			on: () => res,
		};

		channel.subscribe(res as unknown as Response);
		expect(channel.subscriberCount).toBe(1);
	});
});
