import { describe, expect, it } from "vitest";
import { api } from "./helpers";

/**
 * The create endpoint shipped with the project and was never covered.
 *
 * It only accepts a title; everything else is the server's to decide. That
 * split is the interesting part — a client that could set its own id,
 * currentBid or status could mint a listing already "won" at a dollar.
 */
describe("POST /api/listings", () => {
	it("creates a listing from a title", async () => {
		const res = await api()
			.post("/api/listings")
			.send({ title: "2020 Kubota M7-172" })
			.expect(201);

		expect(res.body).toMatchObject({
			title: "2020 Kubota M7-172",
			currentBid: 0,
			currentBidder: null,
			status: "active",
		});
		expect(res.body.id).toEqual(expect.any(String));
	});

	it("assigns the id server-side", async () => {
		// A caller-supplied id lets someone overwrite an existing listing.
		const res = await api()
			.post("/api/listings")
			.send({ title: "Test", id: "attacker-chosen-id" })
			.expect(201);

		expect(res.body.id).not.toBe("attacker-chosen-id");
	});

	it("ignores a caller-supplied current bid", async () => {
		const res = await api()
			.post("/api/listings")
			.send({ title: "Test", currentBid: 1, currentBidder: "Me" })
			.expect(201);

		expect(res.body.currentBid).toBe(0);
		expect(res.body.currentBidder).toBeNull();
	});

	it("defaults the end date a week out", async () => {
		const res = await api()
			.post("/api/listings")
			.send({ title: "Test" })
			.expect(201);

		const days = (Date.parse(res.body.endsAt) - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThan(7.1);
	});

	it("trims the title", async () => {
		const res = await api()
			.post("/api/listings")
			.send({ title: "   2020 Kubota M7-172   " })
			.expect(201);

		expect(res.body.title).toBe("2020 Kubota M7-172");
	});

	it.each([
		["a missing title", {}],
		["an empty title", { title: "" }],
		["a whitespace-only title", { title: "   " }],
		["a non-string title", { title: 42 }],
	])("rejects %s", async (_label, body) => {
		const res = await api().post("/api/listings").send(body).expect(400);
		expect(res.body.error).toMatch(/title is required/i);
	});

	it("makes the new listing immediately retrievable", async () => {
		const app = api();
		const created = await app
			.post("/api/listings")
			.send({ title: "Findable Listing" })
			.expect(201);

		const fetched = await app
			.get(`/api/listings/${created.body.id}`)
			.expect(200);

		expect(fetched.body).toEqual(created.body);
	});

	it("includes the new listing in the paginated collection", async () => {
		const app = api();
		await app.post("/api/listings").send({ title: "Countable" }).expect(201);

		const res = await app.get("/api/listings?pageSize=100").expect(200);
		expect(res.body.pagination.totalItems).toBe(9);
		expect(
			res.body.data.some((l: { title: string }) => l.title === "Countable"),
		).toBe(true);
	});

	it("starts a new listing with no bid history", async () => {
		const app = api();
		const created = await app
			.post("/api/listings")
			.send({ title: "Fresh" })
			.expect(201);

		const history = await app
			.get(`/api/listings/${created.body.id}/bids`)
			.expect(200);

		expect(history.body).toEqual([]);
	});

	it("accepts a bid on a newly created listing", async () => {
		// Its currentBid starts at 0, so any positive amount should win it.
		const app = api();
		const created = await app
			.post("/api/listings")
			.send({ title: "Biddable" })
			.expect(201);

		await app
			.post(`/api/listings/${created.body.id}/bids`)
			.send({ bidder: "First Bidder", amount: 1 })
			.expect(201);
	});
});
