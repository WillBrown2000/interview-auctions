import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { type Listing, createApp } from "../app";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A fresh app, and therefore a fresh copy of the seed data, per call.
 *
 * Every test gets its own store. Bids placed in one test can't be seen by
 * another, so the suite has no ordering dependency and individual tests can be
 * run in isolation.
 */
export function api() {
	return supertest(createApp());
}

/** The seed on disk, so tests assert against the data rather than restating it. */
export const seed: Listing[] = JSON.parse(
	readFileSync(join(__dirname, "..", "data", "listings.json"), "utf-8"),
);

export const activeListing = seed.find((l) => l.status === "active") as Listing;
export const closedListing = seed.find((l) => l.status === "closed") as Listing;

export const MISSING_ID = "00000000-0000-4000-8000-000000000000";

interface ListingsResponse {
	data: Listing[];
	pagination: {
		page: number;
		pageSize: number;
		totalItems: number;
		totalPages: number;
		hasMore: boolean;
	};
}

/** GET /api/listings with a query string, asserting a 200. */
export async function fetchListings(query = ""): Promise<ListingsResponse> {
	const res = await api().get(`/api/listings?${query}`).expect(200);
	return res.body;
}

/** Walk every page and return the ids in the order the client would see them. */
export async function walkAllPages(
	pageSize: number,
	query = "",
): Promise<string[]> {
	const ids: string[] = [];
	let page = 1;
	// Bounded so a hasMore bug fails the test instead of hanging the suite.
	for (let guard = 0; guard < 50; guard++) {
		const body = await fetchListings(
			`${query}&page=${page}&pageSize=${pageSize}`,
		);
		ids.push(...body.data.map((l) => l.id));
		if (!body.pagination.hasMore) return ids;
		page++;
	}
	throw new Error("hasMore never went false — pagination does not terminate");
}
