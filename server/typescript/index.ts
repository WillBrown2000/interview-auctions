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

	if (bid.amount >= listing.currentBid) {
		return res.status(400).json({
			error: `Bid must be greater than the current bid of $${listing.currentBid.toLocaleString()}`,
		});
	}

	listing.currentBid = bid.amount;
	listing.currentBidder = bid.bidder.trim();

	return res.status(201).json(listing);
});

app.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}`);
});
