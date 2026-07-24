import { describe, expect, it } from "vitest";
import { api, fetchListings, seed, walkAllPages } from "./helpers";

const TOTAL = seed.length;

describe("GET /api/listings — pagination", () => {
	describe("defaults", () => {
		it("returns the first page with the default page size when no params are given", async () => {
			const { data, pagination } = await fetchListings();

			expect(pagination.page).toBe(1);
			expect(pagination.pageSize).toBe(20);
			expect(pagination.totalItems).toBe(TOTAL);
			expect(data).toHaveLength(Math.min(TOTAL, 20));
		});

		it("returns the envelope shape, not a bare array", async () => {
			// This is the breaking change to the response. Asserting it here
			// means the shape can't quietly revert.
			const res = await api().get("/api/listings").expect(200);

			expect(Array.isArray(res.body)).toBe(false);
			expect(res.body).toHaveProperty("data");
			expect(res.body).toHaveProperty("pagination");
		});
	});

	describe("slicing", () => {
		it("returns the requested page size", async () => {
			const { data, pagination } = await fetchListings("page=1&pageSize=3");

			expect(data).toHaveLength(3);
			expect(pagination.pageSize).toBe(3);
		});

		it("returns a partial final page", async () => {
			// 8 items at 3 per page: the last page holds 2.
			const { data, pagination } = await fetchListings("page=3&pageSize=3");

			expect(data).toHaveLength(TOTAL - 6);
			expect(pagination.hasMore).toBe(false);
		});

		it("reports the correct totals on every page", async () => {
			for (const page of [1, 2, 3]) {
				const { pagination } = await fetchListings(`page=${page}&pageSize=3`);
				expect(pagination.totalItems).toBe(TOTAL);
				expect(pagination.totalPages).toBe(Math.ceil(TOTAL / 3));
			}
		});

		it("sets hasMore true on every page but the last", async () => {
			expect(
				(await fetchListings("page=1&pageSize=3")).pagination.hasMore,
			).toBe(true);
			expect(
				(await fetchListings("page=2&pageSize=3")).pagination.hasMore,
			).toBe(true);
			expect(
				(await fetchListings("page=3&pageSize=3")).pagination.hasMore,
			).toBe(false);
		});

		it("returns an empty page rather than a 404 past the end", async () => {
			// Asking for a page beyond the data is a legitimate request that
			// happens to match nothing -- the same as a filter matching nothing.
			const { data, pagination } = await fetchListings("page=99&pageSize=3");

			expect(data).toEqual([]);
			expect(pagination.hasMore).toBe(false);
			expect(pagination.totalItems).toBe(TOTAL);
		});
	});

	describe("completeness — the property that actually matters", () => {
		it("covers every listing exactly once when walking all pages", async () => {
			// The real pagination bug is never a wrong count, it's an item that
			// appears on two pages or on none. Only walking the whole set finds
			// it.
			const paged = await walkAllPages(3);
			const everything = seed.map((l) => l.id);

			expect(paged).toHaveLength(TOTAL);
			expect(new Set(paged).size).toBe(TOTAL);
			expect([...paged].sort()).toEqual([...everything].sort());
		});

		it("covers every listing exactly once at a page size of 1", async () => {
			const paged = await walkAllPages(1);

			expect(new Set(paged).size).toBe(TOTAL);
		});

		it("returns a stable order across identical requests", async () => {
			// Without a total ordering, two listings that compare equal can swap
			// between requests, and a client paging through sees one twice while
			// missing the other. The sort has an id tiebreak for exactly this.
			const first = await walkAllPages(3);
			const second = await walkAllPages(3);

			expect(second).toEqual(first);
		});

		it("keeps pages disjoint when the sort key has ties", async () => {
			// Every seeded listing shares the same status, so sorting by a field
			// with no natural uniqueness is the worst case for a partial order.
			const paged = await walkAllPages(2, "sort=title&order=desc");

			expect(new Set(paged).size).toBe(TOTAL);
		});
	});

	describe("limits", () => {
		it("clamps an oversized page size instead of rejecting it", async () => {
			const { pagination } = await fetchListings("pageSize=100000");

			expect(pagination.pageSize).toBe(100);
		});
	});

	describe("invalid parameters", () => {
		it.each([
			["page=0", /page must be a positive integer/i],
			["page=-1", /page must be a positive integer/i],
			["page=abc", /page must be a positive integer/i],
			["page=1.5", /page must be a positive integer/i],
			["pageSize=0", /pageSize must be a positive integer/i],
			["pageSize=-10", /pageSize must be a positive integer/i],
		])("rejects ?%s with 400", async (query, message) => {
			const res = await api().get(`/api/listings?${query}`).expect(400);
			expect(res.body.error).toMatch(message);
		});

		it("rejects a repeated parameter rather than guessing which one to use", async () => {
			const res = await api().get("/api/listings?page=1&page=2").expect(400);
			expect(res.body.error).toMatch(/at most once/i);
		});

		it("treats an empty parameter as absent", async () => {
			const { pagination } = await fetchListings("page=&pageSize=");

			expect(pagination.page).toBe(1);
			expect(pagination.pageSize).toBe(20);
		});
	});
});
