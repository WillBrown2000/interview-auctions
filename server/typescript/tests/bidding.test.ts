import { describe, expect, it } from "vitest";
import { MISSING_ID, activeListing, api, closedListing } from "./helpers";

/**
 * Task 0 regression net.
 *
 * The original bug was a single inverted operator (`>=` where `<=` belonged)
 * in the bid comparison, which both rejected every valid raise and accepted
 * every lowball. The boundary cases below are what pin it down: testing only
 * "higher wins" would still pass with `<`, which silently allows a tie.
 */
describe("POST /api/listings/:id/bids", () => {
	const bid = (amount: number, bidder = "Test Bidder") => ({ bidder, amount });

	describe("the comparison against the current bid", () => {
		it("accepts a bid above the current bid", async () => {
			const above = activeListing.currentBid + 1_000;
			const res = await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(above, "Winner"))
				.expect(201);

			expect(res.body.currentBid).toBe(above);
			expect(res.body.currentBidder).toBe("Winner");
		});

		it("rejects a bid below the current bid", async () => {
			const res = await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(100))
				.expect(400);

			expect(res.body.error).toMatch(/greater than the current bid/i);
		});

		it("rejects a bid exactly equal to the current bid", async () => {
			// The boundary. `<` instead of `<=` passes every other test here.
			await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(activeListing.currentBid))
				.expect(400);
		});

		it("accepts a bid one cent above the current bid", async () => {
			await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(activeListing.currentBid + 0.01))
				.expect(201);
		});
	});

	describe("validation", () => {
		it.each([
			["a missing bidder", { amount: 999_999 }],
			["an empty bidder", { bidder: "", amount: 999_999 }],
			["a whitespace-only bidder", { bidder: "   ", amount: 999_999 }],
		])("rejects %s", async (_label, body) => {
			const res = await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(body)
				.expect(400);

			expect(res.body.error).toMatch(/bidder/i);
		});

		it.each([
			["zero", 0],
			["a negative amount", -5],
		])("rejects %s", async (_label, amount) => {
			const res = await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(amount))
				.expect(400);

			expect(res.body.error).toMatch(/positive number/i);
		});

		it.each([
			["a string amount", "50000"],
			["a null amount", null],
			["a missing amount", undefined],
		])("rejects %s", async (_label, amount) => {
			await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send({ bidder: "Test Bidder", amount })
				.expect(400);
		});

		it("trims surrounding whitespace from the bidder name", async () => {
			const res = await api()
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(activeListing.currentBid + 1, "  Jane Smith  "))
				.expect(201);

			expect(res.body.currentBidder).toBe("Jane Smith");
		});
	});

	describe("listing state", () => {
		it("rejects a bid on a closed listing", async () => {
			const res = await api()
				.post(`/api/listings/${closedListing.id}/bids`)
				.send(bid(closedListing.currentBid + 10_000))
				.expect(400);

			expect(res.body.error).toMatch(/not currently active/i);
		});

		it("returns 404 for a listing that does not exist", async () => {
			await api()
				.post(`/api/listings/${MISSING_ID}/bids`)
				.send(bid(999_999))
				.expect(404);
		});

		it("leaves the listing untouched when a bid is rejected", async () => {
			// A partial fix that validates but writes anyway would pass every
			// status-code assertion above and still corrupt the auction.
			const app = api();
			await app
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(1, "Lowballer"))
				.expect(400);

			const res = await app
				.get(`/api/listings/${activeListing.id}`)
				.expect(200);

			expect(res.body.currentBid).toBe(activeListing.currentBid);
			expect(res.body.currentBidder).toBe(activeListing.currentBidder);
		});

		it("requires each successive bid to beat the one before it", async () => {
			const app = api();
			const first = activeListing.currentBid + 5_000;

			await app
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(first, "First"))
				.expect(201);

			// Above the seeded price but below the standing bid.
			await app
				.post(`/api/listings/${activeListing.id}/bids`)
				.send(bid(first - 1, "Second"))
				.expect(400);

			const res = await app.get(`/api/listings/${activeListing.id}`);
			expect(res.body.currentBidder).toBe("First");
		});
	});
});
