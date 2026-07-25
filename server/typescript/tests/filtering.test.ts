import { describe, expect, it } from "vitest";
import { api, fetchListings, seed } from "./helpers";

const countWhere = (predicate: (l: (typeof seed)[number]) => boolean) =>
	seed.filter(predicate).length;

describe("GET /api/listings — filtering", () => {
	describe("category", () => {
		it.each([
			"tractor",
			"combine",
			"implement",
			"attachment",
		] as const)("returns only %s listings", async (category) => {
			const { data, pagination } = await fetchListings(
				`category=${category}&pageSize=100`,
			);

			expect(data.length).toBeGreaterThan(0);
			expect(data.every((l) => l.category === category)).toBe(true);
			expect(pagination.totalItems).toBe(
				countWhere((l) => l.category === category),
			);
		});
	});

	describe("status", () => {
		it("returns pending listings", async () => {
			// `pending` means catalogued but not open for bidding yet.
			const { data, pagination } = await fetchListings("status=pending");

			expect(pagination.totalItems).toBeGreaterThan(0);
			expect(data.every((l) => l.status === "pending")).toBe(true);
		});

		it("returns only active listings", async () => {
			const { data, pagination } = await fetchListings(
				"status=active&pageSize=100",
			);

			expect(data.every((l) => l.status === "active")).toBe(true);
			expect(pagination.totalItems).toBe(
				countWhere((l) => l.status === "active"),
			);
		});

		it("returns an empty result for a valid combination nothing matches", async () => {
			// Every filter here is legal and every value exists on its own; the
			// combination just has no rows. Chosen so adding a fixture listing
			// can't accidentally satisfy it -- an earlier version paired two
			// enums and started matching the moment a pending combine was added.
			const { data, pagination } = await fetchListings(
				"status=pending&minPrice=99999999",
			);

			expect(data).toEqual([]);
			expect(pagination.totalItems).toBe(0);
			expect(pagination.totalPages).toBe(0);
			expect(pagination.hasMore).toBe(false);
		});
	});

	describe("q — text search", () => {
		it("matches on the title", async () => {
			const { data } = await fetchListings("q=John%20Deere");

			expect(data.length).toBeGreaterThan(0);
			expect(data.every((l) => /john deere/i.test(l.title))).toBe(true);
		});

		it("matches on the description, not just the title", async () => {
			const { data } = await fetchListings("q=hydraulic&pageSize=100");

			expect(data.length).toBeGreaterThan(0);
			// At least one hit must come from the description alone, otherwise
			// this passes against a title-only implementation.
			expect(data.some((l) => !/hydraulic/i.test(l.title))).toBe(true);
		});

		it("is case insensitive", async () => {
			const lower = await fetchListings("q=tractor&pageSize=100");
			const upper = await fetchListings("q=TRACTOR&pageSize=100");

			expect(upper.pagination.totalItems).toBe(lower.pagination.totalItems);
			expect(upper.pagination.totalItems).toBeGreaterThan(0);
		});

		it("returns an empty result when nothing matches", async () => {
			const { data, pagination } = await fetchListings("q=zzzznotathing");

			expect(data).toEqual([]);
			expect(pagination.totalItems).toBe(0);
		});
	});

	describe("price bounds", () => {
		it("treats minPrice as inclusive", async () => {
			const lowest = Math.min(...seed.map((l) => l.currentBid));
			const { data } = await fetchListings(`minPrice=${lowest}&pageSize=100`);

			expect(data.some((l) => l.currentBid === lowest)).toBe(true);
		});

		it("treats maxPrice as inclusive", async () => {
			const highest = Math.max(...seed.map((l) => l.currentBid));
			const { data } = await fetchListings(`maxPrice=${highest}&pageSize=100`);

			expect(data.some((l) => l.currentBid === highest)).toBe(true);
		});

		it("applies both bounds together", async () => {
			const { data, pagination } = await fetchListings(
				"minPrice=50000&maxPrice=200000&pageSize=100",
			);

			expect(
				data.every((l) => l.currentBid >= 50_000 && l.currentBid <= 200_000),
			).toBe(true);
			expect(pagination.totalItems).toBe(
				countWhere((l) => l.currentBid >= 50_000 && l.currentBid <= 200_000),
			);
		});
	});

	describe("composition with sorting and pagination", () => {
		it("reports totals for the filtered set, not the whole collection", async () => {
			// The mistake this catches: filtering the page after slicing, which
			// leaves totalItems describing everything and the page counts wrong.
			const { pagination } = await fetchListings(
				"category=implement&pageSize=2",
			);
			const expected = countWhere((l) => l.category === "implement");

			expect(pagination.totalItems).toBe(expected);
			expect(pagination.totalPages).toBe(Math.ceil(expected / 2));
			expect(pagination.totalItems).toBeLessThan(seed.length);
		});

		it("applies the filter, then the sort, then the page", async () => {
			const { data } = await fetchListings(
				"category=implement&sort=currentBid&order=desc&pageSize=2&page=1",
			);

			expect(data).toHaveLength(2);
			expect(data.every((l) => l.category === "implement")).toBe(true);
			expect(data[0].currentBid).toBeGreaterThanOrEqual(data[1].currentBid);

			const all = seed
				.filter((l) => l.category === "implement")
				.map((l) => l.currentBid)
				.sort((a, b) => b - a);
			expect(data[0].currentBid).toBe(all[0]);
		});

		it("pages through a filtered set without gaps or repeats", async () => {
			const seen: string[] = [];
			let page = 1;
			for (;;) {
				const { data, pagination } = await fetchListings(
					`category=implement&pageSize=1&page=${page}`,
				);
				seen.push(...data.map((l) => l.id));
				if (!pagination.hasMore) break;
				page++;
			}

			const expected = seed
				.filter((l) => l.category === "implement")
				.map((l) => l.id);
			expect(new Set(seen).size).toBe(expected.length);
			expect([...seen].sort()).toEqual([...expected].sort());
		});
	});

	describe("invalid parameters", () => {
		it.each([
			["category=spaceship", /category must be one of/i],
			["status=vanished", /status must be one of/i],
			["minPrice=abc", /minPrice must be a number/i],
			["maxPrice=abc", /maxPrice must be a number/i],
		])("rejects ?%s with 400", async (query, message) => {
			const res = await api().get(`/api/listings?${query}`).expect(400);
			expect(res.body.error).toMatch(message);
		});

		it("rejects a price range that cannot match anything", async () => {
			// minPrice above maxPrice is always empty. Returning [] would be
			// technically correct and would hide a caller's transposed params.
			const res = await api()
				.get("/api/listings?minPrice=100&maxPrice=5")
				.expect(400);

			expect(res.body.error).toMatch(/less than or equal/i);
		});
	});
});
