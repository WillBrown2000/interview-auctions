import { describe, expect, it } from "vitest";
import { MISSING_ID, activeListing, api, seed } from "./helpers";

describe("GET /api/listings/:id/bids", () => {
	const place = (app: ReturnType<typeof api>, amount: number, bidder: string) =>
		app
			.post(`/api/listings/${activeListing.id}/bids`)
			.send({ bidder, amount })
			.expect(201);

	describe("empty vs. missing", () => {
		// The requirement that a listing with no bids is a different case from
		// a listing that does not exist. Returning [] for both would be the
		// easy mistake, and it tells a client nothing about which happened.
		it("returns 200 and an empty array for a real listing with no bids", async () => {
			const res = await api()
				.get(`/api/listings/${activeListing.id}/bids`)
				.expect(200);

			expect(res.body).toEqual([]);
		});

		it("returns 404 for a listing that does not exist", async () => {
			const res = await api()
				.get(`/api/listings/${MISSING_ID}/bids`)
				.expect(404);

			expect(res.body.error).toMatch(/not found/i);
		});
	});

	describe("recording", () => {
		it("records an accepted bid", async () => {
			const app = api();
			const amount = activeListing.currentBid + 1_000;
			await place(app, amount, "Jane Smith");

			const res = await app
				.get(`/api/listings/${activeListing.id}/bids`)
				.expect(200);

			expect(res.body).toHaveLength(1);
			expect(res.body[0]).toMatchObject({
				listingId: activeListing.id,
				bidder: "Jane Smith",
				amount,
			});
			expect(res.body[0].id).toEqual(expect.any(String));
			expect(Date.parse(res.body[0].placedAt)).not.toBeNaN();
		});

		it("does not record a rejected bid", async () => {
			const app = api();
			await app
				.post(`/api/listings/${activeListing.id}/bids`)
				.send({ bidder: "Lowballer", amount: 1 })
				.expect(400);

			const res = await app.get(`/api/listings/${activeListing.id}/bids`);
			expect(res.body).toEqual([]);
		});

		it("stores the trimmed bidder name", async () => {
			const app = api();
			await place(app, activeListing.currentBid + 1, "  Jane Smith  ");

			const res = await app.get(`/api/listings/${activeListing.id}/bids`);
			expect(res.body[0].bidder).toBe("Jane Smith");
		});
	});

	describe("ordering", () => {
		it("returns bids newest first", async () => {
			const app = api();
			const base = activeListing.currentBid;
			await place(app, base + 1_000, "first");
			await place(app, base + 2_000, "second");
			await place(app, base + 3_000, "third");

			const res = await app.get(`/api/listings/${activeListing.id}/bids`);

			expect(res.body.map((b: { bidder: string }) => b.bidder)).toEqual([
				"third",
				"second",
				"first",
			]);
		});

		it("orders by insertion, not by timestamp string", async () => {
			// Several bids can land inside the same millisecond, which makes
			// placedAt useless as a sort key. Ordering comes from insertion
			// order; this asserts that holds even when the timestamps tie.
			const app = api();
			const base = activeListing.currentBid;
			for (let i = 1; i <= 8; i++) {
				await place(app, base + i, `bidder-${i}`);
			}

			const res = await app.get(`/api/listings/${activeListing.id}/bids`);
			const amounts = res.body.map((b: { amount: number }) => b.amount);

			expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
			expect(amounts[0]).toBe(base + 8);
		});
	});

	describe("isolation between listings", () => {
		it("does not leak bids from one listing into another", async () => {
			const app = api();
			const other = seed.find(
				(l) => l.status === "active" && l.id !== activeListing.id,
			) as (typeof seed)[number];

			await place(app, activeListing.currentBid + 1_000, "on-first");

			const res = await app.get(`/api/listings/${other.id}/bids`).expect(200);
			expect(res.body).toEqual([]);
		});
	});

	describe("the returned history is a copy", () => {
		it("keeps the current bid consistent with the newest history entry", async () => {
			const app = api();
			const amount = activeListing.currentBid + 7_500;
			await place(app, amount, "Consistent");

			const [listing, history] = await Promise.all([
				app.get(`/api/listings/${activeListing.id}`),
				app.get(`/api/listings/${activeListing.id}/bids`),
			]);

			expect(listing.body.currentBid).toBe(history.body[0].amount);
			expect(listing.body.currentBidder).toBe(history.body[0].bidder);
		});
	});
});
