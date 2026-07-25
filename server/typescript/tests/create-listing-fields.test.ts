import { describe, expect, it } from "vitest";
import { api } from "./helpers";

/**
 * The seller-supplied fields, and the line between those and the ones the
 * server decides.
 *
 * That line is the whole design: a caller who could set their own id could
 * overwrite an existing listing, and one who could set currentBidder could
 * open a lot already won.
 */
describe("POST /api/listings — seller-supplied fields", () => {
	describe("starting price", () => {
		it("accepts a reserve and opens bidding at it", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Reserved Lot", startingPrice: 45_000 })
				.expect(201);

			expect(res.body.startingPrice).toBe(45_000);
			// Bidding opens at the reserve, so the first bid has to beat it.
			expect(res.body.currentBid).toBe(45_000);
		});

		it("makes the first bid beat the reserve", async () => {
			const app = api();
			const created = await app
				.post("/api/listings")
				.send({ title: "Reserved Lot", startingPrice: 45_000 })
				.expect(201);

			await app
				.post(`/api/listings/${created.body.id}/bids`)
				.send({ bidder: "Lowballer", amount: 44_000 })
				.expect(400);

			await app
				.post(`/api/listings/${created.body.id}/bids`)
				.send({ bidder: "Winner", amount: 45_001 })
				.expect(201);
		});

		it("allows a zero reserve, which means no reserve", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "No Reserve", startingPrice: 0 })
				.expect(201);

			expect(res.body.startingPrice).toBe(0);
		});

		it("defaults to zero when omitted", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Unpriced" })
				.expect(201);

			expect(res.body.startingPrice).toBe(0);
		});

		it.each([
			["a negative price", -100],
			["a non-numeric price", "not a number"],
		])("rejects %s", async (_label, startingPrice) => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Bad Price", startingPrice })
				.expect(400);

			expect(res.body.error).toMatch(/starting price/i);
		});
	});

	describe("end date", () => {
		it("accepts an explicit end date and time", async () => {
			const endsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
			const res = await api()
				.post("/api/listings")
				.send({ title: "Timed Lot", endsAt })
				.expect(201);

			expect(res.body.endsAt).toBe(endsAt);
		});

		it("defaults to a week out when omitted", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Default Timing" })
				.expect(201);

			const days = (Date.parse(res.body.endsAt) - Date.now()) / 86_400_000;
			expect(days).toBeGreaterThan(6.9);
			expect(days).toBeLessThan(7.1);
		});

		it("rejects an end date in the past", async () => {
			// An auction created already closed can never take a bid, so this is
			// a typo rather than an intention.
			const res = await api()
				.post("/api/listings")
				.send({
					title: "Already Over",
					endsAt: new Date(Date.now() - 86_400_000).toISOString(),
				})
				.expect(400);

			expect(res.body.error).toMatch(/must be in the future/i);
		});

		it("rejects an end date more than a year out", async () => {
			// Almost always a mistyped year.
			const res = await api()
				.post("/api/listings")
				.send({
					title: "Far Future",
					endsAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
				})
				.expect(400);

			expect(res.body.error).toMatch(/within a year/i);
		});

		it("rejects an unparseable date", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Nonsense Date", endsAt: "next tuesday-ish" })
				.expect(400);

			expect(res.body.error).toMatch(/not a valid date/i);
		});

		it("accepts the local datetime format a browser input sends", async () => {
			// <input type="datetime-local"> sends "2026-08-01T14:30" with no
			// zone, which is the seller's local time and what they meant.
			const local = new Date(Date.now() + 2 * 86_400_000)
				.toISOString()
				.slice(0, 16);

			await api()
				.post("/api/listings")
				.send({ title: "Local Time", endsAt: local })
				.expect(201);
		});
	});

	describe("category and description", () => {
		it("accepts a category", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "A Combine", category: "combine" })
				.expect(201);

			expect(res.body.category).toBe("combine");
		});

		it("rejects an unknown category", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Spaceship", category: "spaceship" })
				.expect(400);

			expect(res.body.error).toMatch(/category must be one of/i);
		});

		it("accepts and trims a description", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Described", description: "  Low hours.  " })
				.expect(201);

			expect(res.body.description).toBe("Low hours.");
		});

		it("caps the description length", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "Verbose", description: "x".repeat(2_001) })
				.expect(400);

			expect(res.body.error).toMatch(/2000 characters or fewer/i);
		});

		it("caps the title length", async () => {
			const res = await api()
				.post("/api/listings")
				.send({ title: "x".repeat(201) })
				.expect(400);

			expect(res.body.error).toMatch(/200 characters or fewer/i);
		});
	});

	describe("what the server owns", () => {
		it("ignores a caller-supplied id, bid, bidder and status", async () => {
			const res = await api()
				.post("/api/listings")
				.send({
					title: "Nice Try",
					id: "attacker-chosen",
					currentBid: 999_999,
					currentBidder: "Me",
					status: "closed",
					startingPrice: 1_000,
				})
				.expect(201);

			expect(res.body.id).not.toBe("attacker-chosen");
			expect(res.body.currentBid).toBe(1_000);
			expect(res.body.currentBidder).toBeNull();
			expect(res.body.status).toBe("active");
		});

		it("does not reject a request for sending extra fields", async () => {
			// Ignoring them is friendlier than a 400. A client sending keys the
			// server doesn't honour isn't broken, it just doesn't get to pick.
			await api()
				.post("/api/listings")
				.send({ title: "Extra Keys", nonsense: true })
				.expect(201);
		});
	});
});

describe("POST /api/listings — photo upload", () => {
	// A 1x1 PNG. Small enough to inline, and a real image rather than a text
	// file wearing the right content type.
	const PNG = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);

	it("accepts a photo and points the listing at it", async () => {
		const res = await api()
			.post("/api/listings")
			.field("title", "With Photo")
			.field("startingPrice", "12000")
			.attach("image", PNG, "tractor.png")
			.expect(201);

		expect(res.body.imageUrl).toBe(`/api/listings/${res.body.id}/image`);
		// Multipart sends everything as a string; it should still arrive typed.
		expect(res.body.startingPrice).toBe(12_000);
	});

	it("serves the photo back with its content type", async () => {
		const app = api();
		const created = await app
			.post("/api/listings")
			.field("title", "Served")
			.attach("image", PNG, "tractor.png")
			.expect(201);

		const res = await app.get(created.body.imageUrl).expect(200);

		expect(res.headers["content-type"]).toMatch(/image\/png/);
		expect(Buffer.from(res.body)).toEqual(PNG);
	});

	it("keeps the bytes out of the listing payload", async () => {
		// The reason images live in their own table. Every list query is
		// SELECT * FROM listings, and inlining the blob would drag megabytes
		// through memory to render six cards.
		const app = api();
		await app
			.post("/api/listings")
			.field("title", "Heavy")
			.attach("image", PNG, "tractor.png")
			.expect(201);

		const res = await app.get("/api/listings?pageSize=100").expect(200);

		// Listings carry a URL to the photo, never the bytes.
		for (const listing of res.body.data) {
			expect(Object.keys(listing).sort()).toEqual([
				"category",
				"currentBid",
				"currentBidder",
				"description",
				"endsAt",
				"id",
				"imageUrl",
				"startingPrice",
				"startsAt",
				"status",
				"title",
			]);
		}
		expect(JSON.stringify(res.body).length).toBeLessThan(200_000);
	});

	it("revalidates with an ETag instead of refetching the bytes", async () => {
		const app = api();
		const created = await app
			.post("/api/listings")
			.field("title", "Cacheable")
			.attach("image", PNG, "tractor.png")
			.expect(201);

		const first = await app.get(created.body.imageUrl).expect(200);
		const etag = first.headers.etag;
		expect(etag).toBeTruthy();

		await app.get(created.body.imageUrl).set("If-None-Match", etag).expect(304);
	});

	it("returns 404 for a listing that has no photo", async () => {
		const app = api();
		const created = await app
			.post("/api/listings")
			.send({ title: "No Photo" })
			.expect(201);

		expect(created.body.imageUrl).toBe("");
		await app.get(`/api/listings/${created.body.id}/image`).expect(404);
	});

	it("returns 404 for a listing that does not exist", async () => {
		await api()
			.get("/api/listings/00000000-0000-4000-8000-000000000000/image")
			.expect(404);
	});

	it("ignores the client's filename entirely", async () => {
		// The URL is derived from the listing id, so a name like
		// "../../etc/passwd" has nowhere to go.
		const res = await api()
			.post("/api/listings")
			.field("title", "Renamed")
			.attach("image", PNG, "../../etc/passwd.png")
			.expect(201);

		expect(res.body.imageUrl).not.toContain("passwd");
		expect(res.body.imageUrl).not.toContain("..");
	});

	it("gives each listing its own photo", async () => {
		const app = api();
		const first = await app
			.post("/api/listings")
			.field("title", "First")
			.attach("image", PNG, "same.png")
			.expect(201);
		const second = await app
			.post("/api/listings")
			.field("title", "Second")
			.attach("image", PNG, "same.png")
			.expect(201);

		expect(first.body.imageUrl).not.toBe(second.body.imageUrl);
		await app.get(first.body.imageUrl).expect(200);
		await app.get(second.body.imageUrl).expect(200);
	});

	it("rejects a file that isn't an image", async () => {
		const res = await api()
			.post("/api/listings")
			.field("title", "Not An Image")
			.attach("image", Buffer.from("#!/bin/sh\nrm -rf /"), {
				filename: "evil.sh",
				contentType: "application/x-sh",
			})
			.expect(400);

		expect(res.body.error).toMatch(/unsupported image type/i);
	});

	it("rejects a file over the size limit", async () => {
		const tooBig = Buffer.alloc(3 * 1024 * 1024, 0);
		const res = await api()
			.post("/api/listings")
			.field("title", "Too Big")
			.attach("image", tooBig, {
				filename: "huge.png",
				contentType: "image/png",
			})
			.expect(400);

		expect(res.body.error).toMatch(/2MB or smaller/i);
	});

	it("stores no image when the listing itself is rejected", async () => {
		// The listing and its photo are written in one transaction, so a
		// rejected listing can't leave an orphaned image row behind.
		const app = api();
		await app
			.post("/api/listings")
			.field("title", "")
			.attach("image", PNG, "orphan.png")
			.expect(400);

		const res = await app.get("/api/listings?pageSize=100").expect(200);
		expect(res.body.data.some((l: { title: string }) => l.title === "")).toBe(
			false,
		);
	});

	it("still accepts plain JSON", async () => {
		// multer only touches multipart, so the JSON path is untouched -- worth
		// pinning, since every other caller of this endpoint uses it.
		const res = await api()
			.post("/api/listings")
			.send({ title: "JSON Still Works", startingPrice: 500 })
			.expect(201);

		expect(res.body.startingPrice).toBe(500);
	});
});
