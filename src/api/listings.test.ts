import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createListing,
	getBidHistory,
	getListings,
	placeBid,
} from "./listings";

function mockFetch(response: {
	ok?: boolean;
	status?: number;
	body?: unknown;
	throws?: boolean;
}) {
	const fn = vi.fn(async (..._args: unknown[]) => ({
		ok: response.ok ?? true,
		status: response.status ?? 200,
		json: async () => {
			if (response.throws) throw new Error("not json");
			return response.body ?? {};
		},
	}));
	vi.stubGlobal("fetch", fn);
	return fn;
}

/** The query string the last fetch was called with. */
function lastQuery(fn: ReturnType<typeof mockFetch>): URLSearchParams {
	const url = fn.mock.calls[0][0] as string;
	return new URLSearchParams(url.split("?")[1] ?? "");
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getListings", () => {
	it("returns the paginated envelope", async () => {
		const body = { data: [], pagination: { page: 1, totalItems: 0 } };
		mockFetch({ body });

		await expect(getListings()).resolves.toEqual(body);
	});

	it("sends the query parameters it was given", async () => {
		const fn = mockFetch({ body: { data: [], pagination: {} } });

		await getListings({ page: 2, pageSize: 6, category: "tractor" });

		const query = lastQuery(fn);
		expect(query.get("page")).toBe("2");
		expect(query.get("pageSize")).toBe("6");
		expect(query.get("category")).toBe("tractor");
	});

	it("omits empty values rather than sending them", async () => {
		// "" is how the selects spell "no filter". The server rejects an
		// unrecognised enum value, so sending it through would 400 the request
		// the moment someone cleared a dropdown.
		const fn = mockFetch({ body: { data: [], pagination: {} } });

		await getListings({ category: "", status: "", q: "", minPrice: "" });

		expect([...lastQuery(fn).keys()]).toEqual([]);
	});

	it("keeps a zero, which is a real bound rather than an absence", async () => {
		const fn = mockFetch({ body: { data: [], pagination: {} } });

		await getListings({ minPrice: 0 });

		expect(lastQuery(fn).get("minPrice")).toBe("0");
	});

	it("surfaces the server's error message", async () => {
		mockFetch({
			ok: false,
			status: 400,
			body: { error: "page must be a positive integer" },
		});

		await expect(getListings({ page: 0 })).rejects.toThrow(
			"page must be a positive integer",
		);
	});

	it("falls back to a generic message when the body isn't JSON", async () => {
		// A proxy returning an HTML error page shouldn't surface as a parser
		// exception the UI can't display.
		mockFetch({ ok: false, status: 502, throws: true });

		await expect(getListings()).rejects.toThrow("Failed to fetch listings");
	});
});

describe("placeBid", () => {
	it("posts the bidder and amount as JSON", async () => {
		const fn = mockFetch({ body: { id: "listing-1" } });

		await placeBid("listing-1", "Jane Smith", 52_000);

		const [url, init] = fn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/listings/listing-1/bids");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			bidder: "Jane Smith",
			amount: 52_000,
		});
	});

	it("returns the updated listing", async () => {
		const listing = { id: "listing-1", currentBid: 52_000 };
		mockFetch({ body: listing });

		await expect(placeBid("listing-1", "Jane", 52_000)).resolves.toEqual(
			listing,
		);
	});

	it("surfaces a rejection message", async () => {
		mockFetch({
			ok: false,
			status: 400,
			body: { error: "Bid must be greater than the current bid of $52,000" },
		});

		await expect(placeBid("listing-1", "Jane", 100)).rejects.toThrow(
			/greater than the current bid/,
		);
	});

	it("reads FastAPI's detail field as well as the Express error field", async () => {
		// The project ships two interchangeable backends that name their error
		// field differently. Handling both keeps the client honest about that.
		mockFetch({
			ok: false,
			status: 400,
			body: { detail: "Listing not found" },
		});

		await expect(placeBid("nope", "Jane", 100)).rejects.toThrow(
			"Listing not found",
		);
	});
});

describe("getBidHistory", () => {
	it("returns the bids", async () => {
		const bids = [{ id: "bid-1", amount: 52_000 }];
		mockFetch({ body: bids });

		await expect(getBidHistory("listing-1")).resolves.toEqual(bids);
	});

	it("requests the listing's bids endpoint", async () => {
		const fn = mockFetch({ body: [] });

		await getBidHistory("listing-1");

		expect(fn.mock.calls[0][0] as string).toBe("/api/listings/listing-1/bids");
	});

	it("throws when the listing does not exist", async () => {
		mockFetch({ ok: false, status: 404, body: { error: "Listing not found" } });

		await expect(getBidHistory("nope")).rejects.toThrow("Listing not found");
	});
});

describe("createListing", () => {
	it("posts the title", async () => {
		const fn = mockFetch({ body: { id: "new" } });

		await createListing({ title: "2020 Kubota M7-172" });

		const [url, init] = fn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/listings");
		expect(JSON.parse(init.body as string)).toEqual({
			title: "2020 Kubota M7-172",
		});
	});

	it("surfaces a validation error", async () => {
		mockFetch({ ok: false, status: 400, body: { error: "Title is required" } });

		await expect(createListing({ title: "" })).rejects.toThrow(
			"Title is required",
		);
	});
});
