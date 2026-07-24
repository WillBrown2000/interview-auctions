import { describe, expect, it } from "vitest";
import {
	activeListing,
	api,
	closedListing,
	expiredListing,
	seed,
} from "./helpers";

/**
 * An auction stops accepting bids when its end time passes, not when someone
 * remembers to flip its status.
 *
 * The original endpoint only checked `status !== "active"`. Status is a stored
 * field that something has to write; endsAt is the actual contract with the
 * bidder. Between the moment an auction ends and the moment anything notices,
 * a listing sits there marked active with its end time in the past -- and it
 * was accepting bids months after closing.
 */
describe("bidding on an auction that has ended", () => {
	const bid = (amount: number, bidder = "Late Bidder") => ({ bidder, amount });

	it("rejects a bid on a listing whose end time has passed", async () => {
		const res = await api()
			.post(`/api/listings/${expiredListing.id}/bids`)
			.send(bid(expiredListing.currentBid + 50_000))
			.expect(400);

		expect(res.body.error).toMatch(/ended|closed|no longer/i);
	});

	it("does not record a bid placed after the end time", async () => {
		const app = api();
		await app
			.post(`/api/listings/${expiredListing.id}/bids`)
			.send(bid(expiredListing.currentBid + 50_000))
			.expect(400);

		const history = await app
			.get(`/api/listings/${expiredListing.id}/bids`)
			.expect(200);

		expect(history.body).toEqual([]);
	});

	it("leaves the winning bid intact when a late bid is refused", async () => {
		// The failure Will hit: a listing that ended in April was still taking
		// bids, so its "winner" was whoever posted most recently rather than
		// whoever won before the clock ran out.
		const app = api();
		await app
			.post(`/api/listings/${expiredListing.id}/bids`)
			.send(bid(999_999, "Necromancer"))
			.expect(400);

		const res = await app.get(`/api/listings/${expiredListing.id}`);
		expect(res.body.currentBid).toBe(expiredListing.currentBid);
		expect(res.body.currentBidder).toBe(expiredListing.currentBidder);
	});

	it("rejects the late bid even though the listing is still marked active", async () => {
		// Guards against a fix that only sweeps statuses on a timer: until the
		// sweep runs, status still says active and the endsAt check is the only
		// thing standing between a closed auction and a new bid.
		const res = await api().get(`/api/listings/${expiredListing.id}`);
		expect(res.body.status).toBe("active");
		expect(Date.parse(res.body.endsAt)).toBeLessThan(Date.now());

		await api()
			.post(`/api/listings/${expiredListing.id}/bids`)
			.send(bid(expiredListing.currentBid + 1))
			.expect(400);
	});

	it("still accepts bids on a listing that has not ended", async () => {
		// The other half: an over-eager expiry check that rejects everything
		// would pass every test above.
		await api()
			.post(`/api/listings/${activeListing.id}/bids`)
			.send(bid(activeListing.currentBid + 1_000, "In Time"))
			.expect(201);
	});

	it("accepts a bid on the auction closing soonest, while it is still open", async () => {
		// The tightest live window in the fixture -- 45 seconds out. Confirms
		// the boundary is "has the end time passed", not "is it nearly over".
		const soonest = seed
			.filter((l) => l.status === "active" && l.endsInHours > 0)
			.sort((a, b) => a.endsInHours - b.endsInHours)[0];

		await api()
			.post(`/api/listings/${soonest.id}/bids`)
			.send(bid(soonest.currentBid + 500, "Sniper"))
			.expect(201);
	});

	it("still rejects bids on an explicitly closed listing", async () => {
		// The pre-existing status check has to survive the new one.
		const res = await api()
			.post(`/api/listings/${closedListing.id}/bids`)
			.send(bid(closedListing.currentBid + 10_000))
			.expect(400);

		expect(res.body.error).toMatch(/not currently active|ended|closed/i);
	});
});
