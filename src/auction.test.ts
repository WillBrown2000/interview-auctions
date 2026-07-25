import { describe, expect, it } from "vitest";
import { hasEnded } from "./auction";
import type { Listing } from "./types";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

function listing(overrides: Partial<Listing> = {}): Listing {
	return {
		id: "listing-1",
		title: "2019 John Deere 8R 340 Tractor",
		description: "",
		category: "tractor",
		startingPrice: 100_000,
		currentBid: 100_000,
		currentBidder: null,
		status: "active",
		startsAt: new Date(0).toISOString(),
		endsAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
		imageUrl: "",
		...overrides,
	};
}

/**
 * Both halves of hasEnded matter, and each covers a case the other misses.
 * Status is what the server got around to writing; endsAt is the deadline.
 */
describe("hasEnded", () => {
	it("is false for an active listing ending in the future", () => {
		expect(hasEnded(listing(), NOW)).toBe(false);
	});

	it("is true once the end time has passed, even while still marked active", () => {
		// The bug this exists for: an auction past its deadline that nothing
		// has swept still says "active" in the database.
		const ended = listing({
			status: "active",
			startsAt: new Date(0).toISOString(),
			endsAt: new Date(NOW - 1000).toISOString(),
		});

		expect(hasEnded(ended, NOW)).toBe(true);
	});

	it("is true for a closed listing whose end time has not arrived", () => {
		// The other direction: a lot pulled early. The stored status wins even
		// though the clock has not run out.
		const closed = listing({
			status: "closed",
			startsAt: new Date(0).toISOString(),
			endsAt: new Date(NOW + 86_400_000).toISOString(),
		});

		expect(hasEnded(closed, NOW)).toBe(true);
	});

	it("is true for a pending listing", () => {
		// Anything not open for bidding counts as not biddable here — the
		// server refuses bids on pending lots too.
		expect(hasEnded(listing({ status: "pending" }), NOW)).toBe(true);
	});

	it("treats the exact end instant as ended", () => {
		// Matches the server, which rejects bids when endsAt <= now. If the two
		// disagreed on the boundary the UI would offer a bid the API refuses.
		const atBoundary = listing({ endsAt: new Date(NOW).toISOString() });

		expect(hasEnded(atBoundary, NOW)).toBe(true);
	});

	it("is not ended one millisecond before the deadline", () => {
		const almost = listing({ endsAt: new Date(NOW + 1).toISOString() });

		expect(hasEnded(almost, NOW)).toBe(false);
	});

	it("defaults to the current time when none is given", () => {
		const past = listing({
			endsAt: new Date(Date.now() - 5_000).toISOString(),
		});
		const future = listing({
			endsAt: new Date(Date.now() + 60_000).toISOString(),
		});

		expect(hasEnded(past)).toBe(true);
		expect(hasEnded(future)).toBe(false);
	});
});
