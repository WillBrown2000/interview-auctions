import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express, { type Request, type Response } from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Types
// ============================================================

export type Category = "tractor" | "combine" | "implement" | "attachment";
export type Status = "active" | "closed" | "pending";

export interface Listing {
	id: string;
	title: string;
	description: string;
	category: Category;
	startingPrice: number;
	currentBid: number;
	currentBidder: string | null;
	status: Status;
	endsAt: string;
	imageUrl: string;
}

export interface Bid {
	id: string;
	listingId: string;
	bidder: string;
	amount: number;
	placedAt: string;
}

interface BidRequest {
	bidder: string;
	amount: number;
}

interface CreateListingRequest {
	title: string;
}

// ============================================================
// In-memory store — seeded from data/listings.json
// ============================================================

// The store is created per-app rather than living at module scope. Two reasons:
// a module-level array is shared by every importer, so tests would leak bids
// into each other and pass or fail depending on execution order; and a fresh
// seed read makes "restart the server to reset the data" explicit rather than
// incidental.
interface Store {
	listings: Listing[];
	// Bids indexed by listing id. Every read of this data is "the bids for one
	// listing", so indexing by that key keeps reads O(bids on the listing)
	// rather than scanning a flat table. This is the in-memory stand-in for the
	// (listing_id, placed_at) index the table would carry in a database.
	//
	// Each array stays in insertion order, oldest first, and is reversed at
	// read time. Appending is O(1); the reverse only touches the listing being
	// read, and the copy is needed anyway so callers can't mutate the store.
	bidsByListing: Map<string, Bid[]>;
}

function createStore(): Store {
	return {
		listings: JSON.parse(
			readFileSync(join(__dirname, "data", "listings.json"), "utf-8"),
		),
		bidsByListing: new Map(),
	};
}

function recordBid(
	store: Store,
	listingId: string,
	bidder: string,
	amount: number,
): Bid {
	const bid: Bid = {
		id: randomUUID(),
		listingId,
		bidder,
		amount,
		placedAt: new Date().toISOString(),
	};

	const existing = store.bidsByListing.get(listingId);
	if (existing) {
		existing.push(bid);
	} else {
		store.bidsByListing.set(listingId, [bid]);
	}

	return bid;
}

// Newest first. Returns a copy, so callers can't mutate the stored history.
function bidHistoryFor(store: Store, listingId: string): Bid[] {
	return [...(store.bidsByListing.get(listingId) ?? [])].reverse();
}

// ============================================================
// Query parsing: filtering, sorting, pagination
// ============================================================

const DEFAULT_PAGE_SIZE = 20;
// Without a ceiling, ?pageSize=1000000 lets any caller ask the server to
// serialise the entire table in one response.
const MAX_PAGE_SIZE = 100;

const CATEGORIES: Category[] = [
	"tractor",
	"combine",
	"implement",
	"attachment",
];
const STATUSES: Status[] = ["active", "closed", "pending"];
const SORT_FIELDS = ["endsAt", "currentBid", "title"] as const;

type SortField = (typeof SORT_FIELDS)[number];

// Express types a repeated query param (?page=1&page=2) as an array. Rather
// than silently picking one, treat it as a client error.
function singleString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`${name} must be provided at most once`);
	}
	return value;
}

function parsePositiveInt(
	value: unknown,
	name: string,
	fallback: number,
): number {
	const raw = singleString(value, name);
	if (raw === undefined || raw === "") return fallback;

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function parseNumber(value: unknown, name: string): number | undefined {
	const raw = singleString(value, name);
	if (raw === undefined || raw === "") return undefined;

	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${name} must be a number`);
	}
	return parsed;
}

function parseEnum<T extends string>(
	value: unknown,
	name: string,
	allowed: readonly T[],
): T | undefined {
	const raw = singleString(value, name);
	if (raw === undefined || raw === "") return undefined;

	if (!allowed.includes(raw as T)) {
		throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
	}
	return raw as T;
}

function applyFilters(source: Listing[], query: Request["query"]): Listing[] {
	const category = parseEnum(query.category, "category", CATEGORIES);
	const status = parseEnum(query.status, "status", STATUSES);
	const minPrice = parseNumber(query.minPrice, "minPrice");
	const maxPrice = parseNumber(query.maxPrice, "maxPrice");
	const q = singleString(query.q, "q")?.trim().toLowerCase();

	if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
		throw new Error("minPrice must be less than or equal to maxPrice");
	}

	return source.filter((listing) => {
		if (category && listing.category !== category) return false;
		if (status && listing.status !== status) return false;
		if (minPrice !== undefined && listing.currentBid < minPrice) return false;
		if (maxPrice !== undefined && listing.currentBid > maxPrice) return false;
		if (q) {
			const haystack = `${listing.title} ${listing.description}`.toLowerCase();
			if (!haystack.includes(q)) return false;
		}
		return true;
	});
}

function applySort(source: Listing[], query: Request["query"]): Listing[] {
	const sort =
		parseEnum<SortField>(query.sort, "sort", SORT_FIELDS) ?? "endsAt";
	const order =
		parseEnum(query.order, "order", ["asc", "desc"] as const) ?? "asc";
	const direction = order === "asc" ? 1 : -1;

	// Sorting a copy: Array.prototype.sort mutates, and `source` is the store
	// itself when no filter narrowed it.
	return [...source].sort((a, b) => {
		let result: number;
		if (sort === "currentBid") {
			result = a.currentBid - b.currentBid;
		} else {
			// endsAt is ISO-8601 with a fixed offset, so lexicographic order
			// matches chronological order and no Date parsing is needed.
			result = a[sort].localeCompare(b[sort]);
		}

		// Ties broken by id so the order is total. Without this, two listings
		// that compare equal could swap places between requests and a client
		// paging through would see one twice and miss another.
		return result !== 0 ? result * direction : a.id.localeCompare(b.id);
	});
}

// ============================================================
// App
// ============================================================

export function createApp() {
	const store = createStore();
	const { listings } = store;

	const app = express();

	app.use(cors({ origin: "http://localhost:5173" }));
	app.use(express.json());

	// GET /api/listings
	//
	// Paginated and filterable. NOTE: this is a breaking change to the response
	// shape -- it used to return a bare array and now returns {data, pagination}.
	// See the "Pagination" section of the README for why I took the break here
	// rather than versioning the route.
	//
	// Query params (all optional):
	//   page       1-based, default 1
	//   pageSize   default 20, capped at MAX_PAGE_SIZE
	//   category   tractor | combine | implement | attachment
	//   status     active | closed | pending
	//   q          case-insensitive substring match on title and description
	//   minPrice   inclusive lower bound on currentBid
	//   maxPrice   inclusive upper bound on currentBid
	//   sort       endsAt | currentBid | title   (default: endsAt)
	//   order      asc | desc                    (default: asc)
	app.get("/api/listings", (req: Request, res: Response) => {
		let filtered: Listing[];
		let page: number;
		let pageSize: number;

		try {
			filtered = applyFilters(listings, req.query);
			filtered = applySort(filtered, req.query);
			page = parsePositiveInt(req.query.page, "page", 1);
			pageSize = Math.min(
				parsePositiveInt(req.query.pageSize, "pageSize", DEFAULT_PAGE_SIZE),
				MAX_PAGE_SIZE,
			);
		} catch (err) {
			return res
				.status(400)
				.json({ error: err instanceof Error ? err.message : "Invalid query" });
		}

		// Filtering happens before slicing, so totalItems describes the filtered
		// set rather than the whole table. A client filtering by category sees the
		// page count for that category, not for everything.
		const totalItems = filtered.length;
		const totalPages = Math.ceil(totalItems / pageSize);
		const start = (page - 1) * pageSize;
		const data = filtered.slice(start, start + pageSize);

		return res.json({
			data,
			pagination: {
				page,
				pageSize,
				totalItems,
				totalPages,
				// Derived rather than left to the client: "is there more" is a
				// question about the server's data, and off-by-one errors in that
				// arithmetic are a classic source of infinite scroll bugs.
				hasMore: start + data.length < totalItems,
			},
		});
	});

	// POST /api/listings
	app.post("/api/listings", (req: Request, res: Response) => {
		const { title } = req.body as CreateListingRequest;

		if (!title || typeof title !== "string" || title.trim() === "") {
			return res.status(400).json({ error: "Title is required" });
		}

		const listing: Listing = {
			id: randomUUID(),
			title: title.trim(),
			description: "",
			category: "implement",
			startingPrice: 0,
			currentBid: 0,
			currentBidder: null,
			status: "active",
			endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
			imageUrl: "",
		};

		listings.push(listing);
		return res.status(201).json(listing);
	});

	// GET /api/listings/:id
	app.get("/api/listings/:id", (req: Request, res: Response) => {
		const listing = listings.find((l) => l.id === req.params.id);
		if (!listing) {
			return res.status(404).json({ error: "Listing not found" });
		}
		return res.json(listing);
	});

	// POST /api/listings/:id/bids
	app.post("/api/listings/:id/bids", (req: Request, res: Response) => {
		const listing = listings.find((l) => l.id === req.params.id);
		if (!listing) {
			return res.status(404).json({ error: "Listing not found" });
		}

		if (listing.status !== "active") {
			return res
				.status(400)
				.json({ error: "This listing is not currently active" });
		}

		const bid = req.body as BidRequest;

		if (
			!bid.bidder ||
			typeof bid.bidder !== "string" ||
			bid.bidder.trim() === ""
		) {
			return res.status(400).json({ error: "Bidder name is required" });
		}

		if (
			typeof bid.amount !== "number" ||
			isNaN(bid.amount) ||
			bid.amount <= 0
		) {
			return res
				.status(400)
				.json({ error: "Bid amount must be a positive number" });
		}

		if (bid.amount <= listing.currentBid) {
			return res.status(400).json({
				error: `Bid must be greater than the current bid of $${listing.currentBid.toLocaleString()}`,
			});
		}

		const bidder = bid.bidder.trim();

		listing.currentBid = bid.amount;
		listing.currentBidder = bidder;
		recordBid(store, listing.id, bidder, bid.amount);

		return res.status(201).json(listing);
	});

	// GET /api/listings/:id/bids — bid history, newest first.
	//
	// A listing with no bids and a listing that doesn't exist are different
	// answers to different questions, so they get different statuses: an unknown
	// id is 404, while a real listing that nobody has bid on is a successful
	// request that happens to return an empty collection.
	app.get("/api/listings/:id/bids", (req: Request, res: Response) => {
		const listing = listings.find((l) => l.id === req.params.id);
		if (!listing) {
			return res.status(404).json({ error: "Listing not found" });
		}

		return res.json(bidHistoryFor(store, listing.id));
	});

	return app;
}
