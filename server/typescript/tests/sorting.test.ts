import { describe, expect, it } from "vitest";
import { api, fetchListings } from "./helpers";

const isAscending = (values: (string | number)[]) =>
	values.every((v, i) => i === 0 || values[i - 1] <= v);

const isDescending = (values: (string | number)[]) =>
	values.every((v, i) => i === 0 || values[i - 1] >= v);

describe("GET /api/listings — sorting", () => {
	it("sorts by soonest-ending by default", async () => {
		// An auction site's useful default. Also the reason the default is not
		// "whatever order the seed file happened to be in".
		const { data } = await fetchListings("pageSize=100");

		expect(isAscending(data.map((l) => l.endsAt))).toBe(true);
	});

	describe("endsAt", () => {
		it("sorts ascending", async () => {
			const { data } = await fetchListings(
				"sort=endsAt&order=asc&pageSize=100",
			);
			expect(isAscending(data.map((l) => l.endsAt))).toBe(true);
		});

		it("sorts descending", async () => {
			const { data } = await fetchListings(
				"sort=endsAt&order=desc&pageSize=100",
			);
			expect(isDescending(data.map((l) => l.endsAt))).toBe(true);
		});
	});

	describe("currentBid", () => {
		it("sorts ascending", async () => {
			const { data } = await fetchListings(
				"sort=currentBid&order=asc&pageSize=100",
			);
			expect(isAscending(data.map((l) => l.currentBid))).toBe(true);
		});

		it("sorts descending", async () => {
			const { data } = await fetchListings(
				"sort=currentBid&order=desc&pageSize=100",
			);
			expect(isDescending(data.map((l) => l.currentBid))).toBe(true);
		});

		it("sorts numerically rather than lexicographically", async () => {
			// The classic slip: as strings, "4200" sorts after "320000".
			const { data } = await fetchListings(
				"sort=currentBid&order=asc&pageSize=100",
			);
			const bids = data.map((l) => l.currentBid);

			expect(bids[0]).toBe(Math.min(...bids));
			expect(bids[bids.length - 1]).toBe(Math.max(...bids));
		});
	});

	describe("title", () => {
		it("sorts ascending", async () => {
			const { data } = await fetchListings("sort=title&order=asc&pageSize=100");
			expect(isAscending(data.map((l) => l.title.toLowerCase()))).toBe(true);
		});

		it("sorts descending", async () => {
			const { data } = await fetchListings(
				"sort=title&order=desc&pageSize=100",
			);
			expect(isDescending(data.map((l) => l.title.toLowerCase()))).toBe(true);
		});
	});

	describe("invalid parameters", () => {
		it.each([
			["sort=nonsense", /sort must be one of/i],
			["order=sideways", /order must be one of/i],
		])("rejects ?%s with 400", async (query, message) => {
			const res = await api().get(`/api/listings?${query}`).expect(400);
			expect(res.body.error).toMatch(message);
		});
	});
});
