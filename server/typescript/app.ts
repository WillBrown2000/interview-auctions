import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response } from "express";
import type { Db } from "./db";
import { EventChannel } from "./events";
import { log, metrics } from "./telemetry";
import {
	describeUploadError,
	imageUrlFor,
	uploadListingImage,
} from "./uploads";

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
	title?: unknown;
	description?: unknown;
	category?: unknown;
	/** The reserve — what bidding opens at. */
	startingPrice?: unknown;
	endsAt?: unknown;
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

/**
 * A low-cardinality label for why a bid was refused.
 *
 * Derived from the message rather than carried on the error so the wording can
 * change without silently renaming a metric. There are few enough cases that
 * matching is safe, and the fallback keeps an unrecognised one from becoming
 * an untagged mystery.
 */
function reasonFor(err: HttpError): string {
	if (err.status === 404) return "not_found";
	if (/has ended/i.test(err.message)) return "ended";
	if (/not currently active/i.test(err.message)) return "not_active";
	if (/greater than the current bid/i.test(err.message)) return "too_low";
	return "other";
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
// Creating a listing
// ============================================================

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2_000;
const DEFAULT_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
/** A year out. Past this, the seller has almost certainly mistyped the year. */
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Multipart sends every field as a string, JSON preserves types. Rather than
 * having two paths, everything is normalised through here.
 */
function asString(value: unknown, name: string, max: number): string {
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") {
		throw new BadRequest(`${name} must be text`);
	}
	const trimmed = value.trim();
	if (trimmed.length > max) {
		throw new BadRequest(`${name} must be ${max} characters or fewer`);
	}
	return trimmed;
}

function buildListing(body: CreateListingRequest, hasImage: boolean): Listing {
	const title = asString(body.title, "Title", MAX_TITLE);
	if (!title) throw new BadRequest("Title is required");

	const description = asString(
		body.description,
		"Description",
		MAX_DESCRIPTION,
	);

	const category =
		parseEnum(body.category, "category", CATEGORIES) ?? "implement";

	// The reserve. Zero is allowed and means no reserve, which is a real thing
	// sellers do -- so the check is "not negative" rather than "positive".
	let startingPrice = 0;
	if (body.startingPrice !== undefined && body.startingPrice !== "") {
		startingPrice = Number(body.startingPrice);
		if (!Number.isFinite(startingPrice) || startingPrice < 0) {
			throw new BadRequest("Starting price must be a number of 0 or more");
		}
	}

	// datetime-local sends "2026-08-01T14:30" with no zone, which Date parses
	// as the seller's local time. That is what they meant by it.
	let endsAt = new Date(Date.now() + DEFAULT_DURATION_MS);
	if (body.endsAt !== undefined && body.endsAt !== "") {
		if (typeof body.endsAt !== "string") {
			throw new BadRequest("End date must be a date and time");
		}
		const parsed = new Date(body.endsAt);
		if (Number.isNaN(parsed.getTime())) {
			throw new BadRequest("End date is not a valid date and time");
		}
		if (parsed.getTime() <= Date.now()) {
			// An auction created already closed can never take a bid, which is
			// almost certainly a typo rather than an intention.
			throw new BadRequest("End date must be in the future");
		}
		if (parsed.getTime() > Date.now() + MAX_DURATION_MS) {
			throw new BadRequest("End date must be within a year");
		}
		endsAt = parsed;
	}

	return {
		id: randomUUID(),
		title,
		description,
		category,
		startingPrice,
		// Bidding opens at the reserve, so the first bid has to beat it. Derived
		// here rather than accepted from the client for the same reason id is.
		currentBid: startingPrice,
		currentBidder: null,
		status: "active",
		endsAt: endsAt.toISOString(),
		// Points at the endpoint that streams the blob back. Assigned here so the
		// id is generated once and both the row and the URL agree on it.
		imageUrl: "",
	};
}

// ============================================================
// App
// ============================================================

export function createApp(db: Db, channel: EventChannel = new EventChannel()) {
	const app = express();

	app.use(cors({ origin: "http://localhost:5173" }));
	app.use(express.json());

	/**
	 * One structured log line and one timing metric per request.
	 *
	 * Routes are tagged by their pattern (`/api/listings/:id`) rather than the
	 * resolved path. Tagging with the actual id would mint a new metric series
	 * per listing, which is the standard way to accidentally spend a lot of
	 * money on a metrics bill.
	 *
	 * Bound to the response's `finish` event so the duration covers the whole
	 * request, and so a handler that throws is still recorded.
	 */
	app.use((req: Request, res: Response, next) => {
		const startedAt = Date.now();

		res.on("finish", () => {
			const durationMs = Date.now() - startedAt;
			// req.route is only populated once a handler has matched; falling
			// back to the raw path keeps 404s from being silently untagged.
			const route = req.route?.path ?? req.path;
			const tags = [
				`method:${req.method}`,
				`route:${route}`,
				`status:${res.statusCode}`,
			];

			metrics.timing("http.request", durationMs, tags);
			metrics.count("http.requests", tags);

			log.info("http.request", {
				method: req.method,
				path: req.path,
				route,
				status: res.statusCode,
				durationMs,
			});
		});

		next();
	});

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
	const insertImage = db.prepare(`
		INSERT INTO listing_images (listing_id, content_type, byte_size, data, created_at)
		VALUES (@listingId, @contentType, @byteSize, @data, @createdAt)
	`);
	const findImage = db.prepare(
		"SELECT content_type, byte_size, data, created_at FROM listing_images WHERE listing_id = ?",
	);

	/**
	 * Writes a listing and its photo together.
	 *
	 * One transaction because they are one thing: a listing whose imageUrl
	 * points at an image row that failed to insert would 404 its own photo
	 * forever, and nothing would notice.
	 */
	const createListing = db.transaction(
		(listing: Listing, file?: Express.Multer.File) => {
			insertListing.run(listing);
			if (file) {
				insertImage.run({
					listingId: listing.id,
					contentType: file.mimetype,
					byteSize: file.size,
					data: file.buffer,
					createdAt: new Date().toISOString(),
				});
			}
		},
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
	//
	// Accepts JSON, or multipart/form-data when a photo comes with it. multer
	// ignores anything that isn't multipart, so both content types reach the
	// same handler.
	//
	// Seller-supplied:  title, description, category, startingPrice, endsAt, image
	// Server-owned:     id, currentBid, currentBidder, status
	//
	// The split is the point. A caller who could set their own id could
	// overwrite an existing listing; one who could set currentBidder could
	// open a lot already won. Those four are decided here and any values sent
	// for them are ignored rather than rejected -- a client sending extra keys
	// isn't an error, it just doesn't get to pick.
	app.post("/api/listings", (req: Request, res: Response) => {
		uploadListingImage(req, res, (uploadErr: unknown) => {
			if (uploadErr) {
				const message = describeUploadError(uploadErr);
				if (message) return res.status(400).json({ error: message });
				throw uploadErr;
			}

			const body = req.body as CreateListingRequest;
			const file = (req as Request & { file?: Express.Multer.File }).file;

			let listing: Listing;
			try {
				listing = buildListing(body, Boolean(file));
			} catch (err) {
				return sendError(res, err);
			}

			if (file) listing.imageUrl = imageUrlFor(listing.id);

			// The listing and its photo are one unit. A listing whose imageUrl
			// points at a row that failed to insert would 404 its own image
			// forever, with nothing to notice or repair it.
			createListing(listing, file);

			metrics.count("listing.created", [`category:${listing.category}`]);
			log.info("listing.created", {
				listingId: listing.id,
				category: listing.category,
				startingPrice: listing.startingPrice,
				imageBytes: file?.size ?? 0,
			});

			return res.status(201).json(listing);
		});
	});

	// GET /api/listings/:id/image — the stored photo.
	//
	// Separate from the listing payload so a page of cards doesn't carry
	// megabytes of image data, and separate from the listings table for the
	// same reason on the read side.
	app.get("/api/listings/:id/image", (req: Request, res: Response) => {
		const row = findImage.get(req.params.id) as
			| {
					content_type: string;
					byte_size: number;
					data: Buffer;
					created_at: string;
			  }
			| undefined;

		if (!row) {
			return res.status(404).json({ error: "Image not found" });
		}

		// Photos are written once with the listing and never replaced, so an
		// ETag over the row's identity is stable. It still lets a client
		// revalidate rather than being told to cache forever, which would be
		// wrong the moment listings become editable.
		const etag = `"${req.params.id}-${row.byte_size}"`;
		if (req.headers["if-none-match"] === etag) {
			return res.status(304).end();
		}

		res.setHeader("Content-Type", row.content_type);
		res.setHeader("Content-Length", row.byte_size);
		res.setHeader("ETag", etag);
		res.setHeader("Cache-Control", "public, max-age=3600");
		return res.end(row.data);
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

			// Published after the transaction commits, never inside it. A
			// subscriber told about a bid that then rolled back would be holding
			// a price that never existed, and no later event would correct it.
			channel.publish({
				type: "bid",
				listingId: listing.id,
				currentBid: listing.currentBid,
				currentBidder: listing.currentBidder as string,
				placedAt: new Date().toISOString(),
			});

			metrics.count("bid.accepted", [`category:${listing.category}`]);
			// The amount is a gauge rather than a tag: tagging by price would be
			// one series per distinct bid.
			metrics.gauge("bid.amount", listing.currentBid, [
				`category:${listing.category}`,
			]);
			// The bidder's name is scrubbed by the logger; it's passed so the
			// redaction is visible at the call site rather than assumed.
			log.info("bid.accepted", {
				listingId: listing.id,
				amount: listing.currentBid,
				bidder: listing.currentBidder,
			});

			return res.status(201).json(listing);
		} catch (err) {
			// Rejections are counted by reason. A spike in "too_low" is bidders
			// racing each other; a spike in "ended" means clients are showing
			// auctions as live after they've closed, which is a real bug.
			if (err instanceof HttpError) {
				metrics.count("bid.rejected", [`reason:${reasonFor(err)}`]);
				log.info("bid.rejected", {
					listingId: req.params.id,
					status: err.status,
					reason: reasonFor(err),
				});
			}
			return sendError(res, err);
		}
	});

	// GET /api/events — server-sent event stream.
	//
	// One global channel rather than a per-listing subscription: clients need
	// the highest bidder on auctions they aren't currently viewing, so
	// narrowing server-side would defeat the requirement. Subscribers apply
	// only the events matching data they hold.
	//
	// No pre-flight body, no timeout, no JSON — the response stays open until
	// the client goes away.
	app.get("/api/events", (req: Request, res: Response) => {
		channel.subscribe(res);
		metrics.gauge("sse.subscribers", channel.subscriberCount);
		log.info("sse.connected", { subscribers: channel.subscriberCount });

		// Express would otherwise sit on this handler forever waiting for a
		// response to finish; the request ends when the socket closes.
		req.on("close", () => {
			res.end();
			// Emitted after the channel has dropped the subscriber, so the gauge
			// reflects reality rather than the count a moment before.
			metrics.gauge("sse.subscribers", channel.subscriberCount);
			log.info("sse.disconnected", { subscribers: channel.subscriberCount });
		});
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
