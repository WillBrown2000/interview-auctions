import type { Bid, Category, Listing, ListingQuery, Paginated } from "../types";

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

export interface NewListing {
	title: string;
	description?: string;
	category?: Category | "";
	/** The reserve — what bidding opens at. */
	startingPrice?: string;
	/** Local datetime from the form; the server treats it as the seller's zone. */
	startsAt?: string;
	endsAt?: string;
	image?: File | null;
}

export async function createListing(data: NewListing): Promise<Listing> {
	// Always multipart, whether or not there's a photo. The alternative is
	// branching on the presence of a file and maintaining two encodings of the
	// same request; the server accepts both, so the client only needs one.
	const form = new FormData();
	form.set("title", data.title);

	for (const key of [
		"description",
		"category",
		"startingPrice",
		"startsAt",
		"endsAt",
	] as const) {
		const value = data[key];
		// Empty means "not specified" — sending it would fail the server's
		// validation for a field the user simply left alone.
		if (value) form.set(key, value);
	}

	if (data.image) form.set("image", data.image);

	// No Content-Type header: the browser sets it, and only the browser knows
	// the multipart boundary it generated.
	const res = await fetch("/api/listings", { method: "POST", body: form });
	if (!res.ok) throw await errorFrom(res, "Failed to create listing");
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
