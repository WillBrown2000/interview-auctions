import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express, { type Request, type Response } from "express";

const PORT = 3001;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Types
// ============================================================

type Category = "tractor" | "combine" | "implement" | "attachment";
type Status = "active" | "closed" | "pending";

interface Listing {
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

interface Bid {
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

const listings: Listing[] = JSON.parse(
	readFileSync(join(__dirname, "data", "listings.json"), "utf-8"),
);

// Bids indexed by listing id. Every read of this data is "the bids for one
// listing", so indexing by that key keeps reads O(bids on the listing) instead
// of scanning a flat table. This stands in for the (listing_id, placed_at)
// index you'd put on a bids table in a real database.
//
// Each array is kept in insertion order — oldest first — and reversed at read
// time. Appending is O(1); reversing is O(n) but only touches the one listing
// being read, and the copy is needed anyway so callers can't mutate the store.
const bidsByListing = new Map<string, Bid[]>();

function recordBid(listingId: string, bidder: string, amount: number): Bid {
	const bid: Bid = {
		id: randomUUID(),
		listingId,
		bidder,
		amount,
		placedAt: new Date().toISOString(),
	};

	const existing = bidsByListing.get(listingId);
	if (existing) {
		existing.push(bid);
	} else {
		bidsByListing.set(listingId, [bid]);
	}

	return bid;
}

// Newest first. Returns a copy, so callers can't mutate the stored history.
function bidHistoryFor(listingId: string): Bid[] {
	return [...(bidsByListing.get(listingId) ?? [])].reverse();
}

// ============================================================
// App
// ============================================================

const app = express();

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// GET /api/listings
app.get("/api/listings", (_req: Request, res: Response) => {
	res.json(listings);
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

	if (typeof bid.amount !== "number" || isNaN(bid.amount) || bid.amount <= 0) {
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
	recordBid(listing.id, bidder, bid.amount);

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

	return res.json(bidHistoryFor(listing.id));
});

app.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}`);
});
