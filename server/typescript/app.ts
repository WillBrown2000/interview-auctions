import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response } from "express";
import type { Db } from "./db";

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
// Row mapping
//
// The database is snake_case and the API is camelCase. Keeping the two
// vocabularies separate means a column rename is a migration plus one mapper,
// not a change to the public contract.
// ============================================================

interface ListingRow {
	id: string;
	title: string;
	description: string;
	category: Category;
	starting_price: number;
	current_bid: number;
	current_bidder: string | null;
	status: Status;
	ends_at: string;
	image_url: string;
}

interface BidRow {
	id: string;
	listing_id: string;
	bidder: string;
	amount: number;
	placed_at: string;
}

function toListing(row: ListingRow): Listing {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		category: row.category,
		startingPrice: row.starting_price,
		currentBid: row.current_bid,
		currentBidder: row.current_bidder,
		status: row.status,
		endsAt: row.ends_at,
		imageUrl: row.image_url,
	};
}

function toBid(row: BidRow): Bid {
	return {
		id: row.id,
		listingId: row.listing_id,
		bidder: row.bidder,
		amount: row.amount,
		placedAt: row.placed_at,
	};
}

// ============================================================
// Errors
// ============================================================

/** An error carrying the status the client should see. */
class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

class BadRequest extends HttpError {
	constructor(message: string) {
		super(400, message);
	}
}

function sendError(res: Response, err: unknown) {
	if (err instanceof HttpError) {
		return res.status(err.status).json({ error: err.message });
	}
	throw err;
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

// Sort keys map to column names through this table rather than being
// interpolated from the request. The value reaching the SQL string is always
// one of these literals, never user input.
const SORT_COLUMNS = {
	endsAt: "ends_at",
	currentBid: "current_bid",
	title: "title",
} as const;

type SortField = keyof typeof SORT_COLUMNS;

const SORT_FIELDS = Object.keys(SORT_COLUMNS) as SortField[];

// Express types a repeated query param (?page=1&page=2) as an array. Rather
// than silently picking one, treat it as a client error.
function singleString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new BadRequest(`${name} must be provided at most once`);
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
		throw new BadRequest(`${name} must be a positive integer`);
	}
	return parsed;
}

function parseNumber(value: unknown, name: string): number | undefined {
	const raw = singleString(value, name);
	if (raw === undefined || raw === "") return undefined;

	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw new BadRequest(`${name} must be a number`);
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
		throw new BadRequest(`${name} must be one of: ${allowed.join(", ")}`);
	}
	return raw as T;
}

interface ListingsQuery {
	where: string;
	params: Record<string, string | number>;
	orderBy: string;
	page: number;
	pageSize: number;
}

function parseListingsQuery(query: Request["query"]): ListingsQuery {
	const category = parseEnum(query.category, "category", CATEGORIES);
	const status = parseEnum(query.status, "status", STATUSES);
	const minPrice = parseNumber(query.minPrice, "minPrice");
	const maxPrice = parseNumber(query.maxPrice, "maxPrice");
	const q = singleString(query.q, "q")?.trim().toLowerCase();

	if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
		throw new BadRequest("minPrice must be less than or equal to maxPrice");
	}

	const clauses: string[] = [];
	const params: Record<string, string | number> = {};

	if (category) {
		clauses.push("category = @category");
		params.category = category;
	}
	if (status) {
		clauses.push("status = @status");
		params.status = status;
	}
	if (minPrice !== undefined) {
		clauses.push("current_bid >= @minPrice");
		params.minPrice = minPrice;
	}
	if (maxPrice !== undefined) {
		clauses.push("current_bid <= @maxPrice");
		params.maxPrice = maxPrice;
	}
	if (q) {
		clauses.push(
			"(lower(title) LIKE @q ESCAPE '\\' OR lower(description) LIKE @q ESCAPE '\\')",
		);
		// A literal % or _ in a search term would otherwise act as a wildcard.
		params.q = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
	}

	const sort =
		parseEnum<SortField>(query.sort, "sort", SORT_FIELDS) ?? "endsAt";
	const order =
		parseEnum(query.order, "order", ["asc", "desc"] as const) ?? "asc";

	// Ties broken by id so the ordering is total. Without this, two rows that
	// compare equal can come back in a different order between requests, and a
	// client paging through sees one twice while missing another.
	const orderBy = `${SORT_COLUMNS[sort]} ${order === "asc" ? "ASC" : "DESC"}, id ASC`;

	const page = parsePositiveInt(query.page, "page", 1);
	const pageSize = Math.min(
		parsePositiveInt(query.pageSize, "pageSize", DEFAULT_PAGE_SIZE),
		MAX_PAGE_SIZE,
	);

	return {
		where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
		params,
		orderBy,
		page,
		pageSize,
	};
}

// ============================================================
// App
// ============================================================

export function createApp(db: Db) {
	const app = express();

	app.use(cors({ origin: "http://localhost:5173" }));
	app.use(express.json());

	const findListing = db.prepare("SELECT * FROM listings WHERE id = ?");
	const insertListing = db.prepare(`
		INSERT INTO listings (
			id, title, description, category, starting_price,
			current_bid, current_bidder, status, ends_at, image_url
		) VALUES (
			@id, @title, @description, @category, @startingPrice,
			@currentBid, @currentBidder, @status, @endsAt, @imageUrl
		)
	`);
	const updateCurrentBid = db.prepare(
		"UPDATE listings SET current_bid = ?, current_bidder = ? WHERE id = ?",
	);
	const insertBid = db.prepare(`
		INSERT INTO bids (id, listing_id, bidder, amount, placed_at)
		VALUES (@id, @listingId, @bidder, @amount, @placedAt)
	`);
	// placed_at leads because the index supplies that ordering; rowid breaks
	// ties, since several bids can share a millisecond and insertion order is
	// the truth.
	const selectBids = db.prepare(
		"SELECT * FROM bids WHERE listing_id = ? ORDER BY placed_at DESC, rowid DESC",
	);

	/**
	 * Read the listing, validate against it, then write both the bid and the
	 * denormalised current_bid -- as one transaction.
	 *
	 * The read and the write have to be atomic. Otherwise two bids arriving
	 * together can both read the same current_bid, both conclude they win, and
	 * the second silently overwrites the first: a lost update. The transaction
	 * is what makes "must beat the current bid" hold under load rather than
	 * only when requests happen to arrive one at a time.
	 */
	const placeBid = db.transaction(
		(listingId: string, bidder: string, amount: number): Listing => {
			const row = findListing.get(listingId) as ListingRow | undefined;
			if (!row) throw new HttpError(404, "Listing not found");

			if (row.status !== "active") {
				throw new BadRequest("This listing is not currently active");
			}

			// Status is a stored field that something has to write; ends_at is
			// the actual contract with the bidder. Between an auction ending and
			// anything noticing, a listing sits marked active with its end time
			// in the past -- so the timestamp has to be checked directly rather
			// than trusting status to have been swept.
			//
			// Read inside the transaction, alongside the bid comparison, so a
			// bid can't slip past an expiry that lands mid-request.
			if (Date.parse(row.ends_at) <= Date.now()) {
				throw new BadRequest("This auction has ended");
			}

			if (amount <= row.current_bid) {
				throw new BadRequest(
					`Bid must be greater than the current bid of $${row.current_bid.toLocaleString()}`,
				);
			}

			updateCurrentBid.run(amount, bidder, listingId);
			insertBid.run({
				id: randomUUID(),
				listingId,
				bidder,
				amount,
				placedAt: new Date().toISOString(),
			});

			return toListing({ ...row, current_bid: amount, current_bidder: bidder });
		},
	);

	// GET /api/listings
	//
	// Paginated and filterable. NOTE: this is a breaking change to the response
	// shape -- it used to return a bare array and now returns {data, pagination}.
	// See the "Pagination" section of the README for why the break was taken
	// here rather than versioning the route.
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
		let parsed: ListingsQuery;
		try {
			parsed = parseListingsQuery(req.query);
		} catch (err) {
			return sendError(res, err);
		}

		const { where, params, orderBy, page, pageSize } = parsed;

		// Counting and slicing are separate statements over the same predicate,
		// so totalItems describes the filtered set rather than the table. The
		// count runs in SQL rather than by loading every match and measuring the
		// resulting array.
		const { total } = db
			.prepare(`SELECT COUNT(*) AS total FROM listings ${where}`)
			.get(params) as { total: number };

		const rows = db
			.prepare(
				`SELECT * FROM listings ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`,
			)
			.all({
				...params,
				limit: pageSize,
				offset: (page - 1) * pageSize,
			}) as ListingRow[];

		return res.json({
			data: rows.map(toListing),
			pagination: {
				page,
				pageSize,
				totalItems: total,
				totalPages: Math.ceil(total / pageSize),
				// Derived rather than left to the client: "is there more" is a
				// question about the server's data, and off-by-one errors in that
				// arithmetic are a classic source of infinite scroll bugs.
				hasMore: (page - 1) * pageSize + rows.length < total,
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

		insertListing.run(listing);
		return res.status(201).json(listing);
	});

	// GET /api/listings/:id
	app.get("/api/listings/:id", (req: Request, res: Response) => {
		const row = findListing.get(req.params.id) as ListingRow | undefined;
		if (!row) {
			return res.status(404).json({ error: "Listing not found" });
		}
		return res.json(toListing(row));
	});

	// POST /api/listings/:id/bids
	app.post("/api/listings/:id/bids", (req: Request, res: Response) => {
		const bid = req.body as BidRequest;

		// Shape validation sits outside the transaction: it needs no database
		// state, and a malformed body shouldn't open one.
		if (
			!bid.bidder ||
			typeof bid.bidder !== "string" ||
			bid.bidder.trim() === ""
		) {
			return res.status(400).json({ error: "Bidder name is required" });
		}

		if (
			typeof bid.amount !== "number" ||
			Number.isNaN(bid.amount) ||
			bid.amount <= 0
		) {
			return res
				.status(400)
				.json({ error: "Bid amount must be a positive number" });
		}

		try {
			const listing = placeBid(req.params.id, bid.bidder.trim(), bid.amount);
			return res.status(201).json(listing);
		} catch (err) {
			return sendError(res, err);
		}
	});

	// GET /api/listings/:id/bids — bid history, newest first.
	//
	// A listing with no bids and a listing that doesn't exist are different
	// answers to different questions, so they get different statuses: an unknown
	// id is 404, while a real listing that nobody has bid on is a successful
	// request that happens to return an empty collection.
	app.get("/api/listings/:id/bids", (req: Request, res: Response) => {
		const row = findListing.get(req.params.id) as ListingRow | undefined;
		if (!row) {
			return res.status(404).json({ error: "Listing not found" });
		}

		const bids = selectBids.all(req.params.id) as BidRow[];
		return res.json(bids.map(toBid));
	});

	return app;
}
