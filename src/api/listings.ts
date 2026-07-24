import type { Bid, Listing, ListingQuery, Paginated } from "../types";

async function errorFrom(res: Response, fallback: string): Promise<Error> {
	const body = await res.json().catch(() => ({}));
	return new Error(body.error || body.detail || fallback);
}

export async function getListings(
	query: ListingQuery = {},
): Promise<Paginated<Listing>> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		// Empty string is how the filter selects spell "no filter". Sending it
		// through would make the server reject the request.
		if (value !== undefined && value !== "") {
			params.set(key, String(value));
		}
	}

	const res = await fetch(`/api/listings?${params}`);
	if (!res.ok) throw await errorFrom(res, "Failed to fetch listings");
	return res.json();
}

export async function getBidHistory(listingId: string): Promise<Bid[]> {
	const res = await fetch(`/api/listings/${listingId}/bids`);
	if (!res.ok) throw await errorFrom(res, "Failed to fetch bid history");
	return res.json();
}

export async function getListing(id: string): Promise<Listing> {
	const res = await fetch(`/api/listings/${id}`);
	if (!res.ok) throw new Error("Failed to fetch listing");
	return res.json();
}

export async function createListing(data: { title: string }): Promise<Listing> {
	const res = await fetch("/api/listings", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || body.detail || "Failed to create listing");
	}
	return res.json();
}

export async function placeBid(
	listingId: string,
	bidder: string,
	amount: number,
): Promise<Listing> {
	const res = await fetch(`/api/listings/${listingId}/bids`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ bidder, amount }),
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.error || data.detail || "Failed to place bid");
	}
	return res.json();
}
