import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import supertest from "supertest";
import { type Listing, createApp } from "../app";
import { initDatabase } from "../db";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A fresh app on a fresh in-memory database, migrated and seeded, per call.
 *
 * ":memory:" gives every test its own private database that never touches
 * disk. Bids written by one test are invisible to the next, so the suite has
 * no ordering dependency and any test can be run alone. It also means the
 * tests exercise the real migrations -- if a migration is broken, the suite
 * fails rather than testing against a schema built some other way.
 */
export function api() {
	return supertest(createApp(initDatabase(":memory:")));
}

/**
 * The seed on disk, so tests assert against the data rather than restating it.
 *
 * The fixture carries endsInHours (an offset from seed time) rather than an
 * absolute endsAt, so the actual timestamp is only known once seeded.
 */
export type SeedListing = Omit<Listing, "endsAt"> & { endsInHours: number };

export const seed: SeedListing[] = JSON.parse(
	readFileSync(join(__dirname, "..", "data", "listings.json"), "utf-8"),
);

/** Open for bidding: active, and comfortably in the future. */
export const activeListing = seed.find(
	(l) => l.status === "active" && l.endsInHours > 1,
) as SeedListing;

/**
 * Past its end time but still flagged active — an auction nothing has swept
 * up yet. The case where status alone is not enough to decide if a bid is
 * allowed.
 */
export const expiredListing = seed.find(
	(l) => l.status === "active" && l.endsInHours < 0,
) as SeedListing;

export const closedListing = seed.find(
	(l) => l.status === "closed",
) as SeedListing;

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
