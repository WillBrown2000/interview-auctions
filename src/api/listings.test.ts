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

	it("falls back to a readable message when the body has no error field", async () => {
		// A proxy or load balancer returning its own error page is JSON-shaped
		// at best; the UI still needs something to put in front of a bidder.
		mockFetch({ ok: false, status: 502, body: { unexpected: true } });

		await expect(placeBid("nope", "Jane", 100)).rejects.toThrow(
			"Failed to place bid",
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
	it("posts the fields as multipart", async () => {
		const fn = mockFetch({ body: { id: "new" } });

		await createListing({
			title: "2020 Kubota M7-172",
			description: "Low hours.",
			category: "tractor",
			startingPrice: "45000",
			endsAt: "2026-09-01T12:00",
		});

		const [url, init] = fn.mock.calls[0] as [string, RequestInit];
		const body = init.body as FormData;

		expect(url).toBe("/api/listings");
		expect(init.method).toBe("POST");
		expect(body.get("title")).toBe("2020 Kubota M7-172");
		expect(body.get("description")).toBe("Low hours.");
		expect(body.get("category")).toBe("tractor");
		expect(body.get("startingPrice")).toBe("45000");
		expect(body.get("endsAt")).toBe("2026-09-01T12:00");
	});

	it("omits fields the seller left blank", async () => {
		// Empty means "not specified". Sending it would fail validation for a
		// field the user simply didn't touch.
		const fn = mockFetch({ body: { id: "new" } });

		await createListing({ title: "Minimal", description: "", category: "" });

		const body = (fn.mock.calls[0] as [string, RequestInit])[1]
			.body as FormData;
		expect(body.get("title")).toBe("Minimal");
		expect(body.get("description")).toBeNull();
		expect(body.get("category")).toBeNull();
	});

	it("attaches a photo when one is chosen", async () => {
		const fn = mockFetch({ body: { id: "new" } });
		const file = new File(["binary"], "tractor.png", { type: "image/png" });

		await createListing({ title: "With Photo", image: file });

		const body = (fn.mock.calls[0] as [string, RequestInit])[1]
			.body as FormData;
		expect(body.get("image")).toBe(file);
	});

	it("surfaces a validation error", async () => {
		mockFetch({ ok: false, status: 400, body: { error: "Title is required" } });

		await expect(createListing({ title: "" })).rejects.toThrow(
			"Title is required",
		);
	});
});
