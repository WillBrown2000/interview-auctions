/**
 * Generates a large, realistic dataset for exercising pagination and filters.
 *
 *   npm run seed:demo          300 listings
 *   npm run seed:demo -- 500   500 listings
 *
 * Deliberately a script rather than a migration. Migrations describe the shape
 * of the database and have to run everywhere, including production; this is a
 * development fixture. Putting 300 generated tractors in 001_initial.sql would
 * mean shipping them to every environment that ever migrates.
 *
 * Deliberately not run at boot either. The eight hand-written listings in
 * data/listings.json are the baseline the tests assert against, and a server
 * that silently invented 300 more on startup would make that baseline
 * impossible to get back to.
 *
 * Output is deterministic: same count in, same database out. Reproducible
 * fixtures mean "it breaks on page 7" is something someone else can reproduce.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Db, initDatabase } from "../db";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_COUNT = 300;

// ============================================================
// Deterministic randomness
// ============================================================

/**
 * mulberry32 — a small seeded PRNG.
 *
 * Math.random() would make every run produce a different database, so a bug
 * found on page 7 couldn't be reproduced by anyone else. A fixed seed makes
 * the fixture a known quantity.
 */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const random = rng(20260724);

const pick = <T>(items: readonly T[]): T =>
	items[Math.floor(random() * items.length)];

const between = (min: number, max: number): number =>
	min + random() * (max - min);

const intBetween = (min: number, max: number): number =>
	Math.floor(between(min, max + 1));

// ============================================================
// Vocabulary
// ============================================================

type Category = "tractor" | "combine" | "implement" | "attachment";

const EQUIPMENT: Record<Category, { makes: string[]; models: string[] }> = {
	tractor: {
		makes: [
			"John Deere",
			"Case IH",
			"New Holland",
			"Kubota",
			"Massey Ferguson",
			"Fendt",
			"Claas",
		],
		models: [
			"8R 340",
			"Magnum 340",
			"T7.270",
			"M7-172",
			"8S.265",
			"1050 Vario",
			"Axion 960",
		],
	},
	combine: {
		makes: ["John Deere", "Case IH", "New Holland", "Claas", "Gleaner"],
		models: ["S780", "Axial-Flow 250", "CR10.90", "Lexion 8900", "S97"],
	},
	implement: {
		makes: [
			"Kinze",
			"Landoll",
			"Great Plains",
			"Sunflower",
			"Salford",
			"Krause",
		],
		models: [
			"1050 Grain Cart",
			"7431 Cultivator",
			"8560 Drill",
			"6631 Disc",
			"570 Vertical Till",
			"8005 Ripper",
		],
	},
	attachment: {
		makes: ["Frontier", "MacDon", "Woods", "Bush Hog", "Land Pride"],
		models: [
			"RC2060 Cutter",
			"FD75 Draper Header",
			"BB84 Box Blade",
			"2615 Batwing",
			"RCR1872 Cutter",
		],
	},
};

const CONDITIONS = [
	"Well maintained with complete service records.",
	"Single owner, shed kept, no known issues.",
	"Recently serviced. New tires and hydraulic hoses.",
	"Field ready. Minor cosmetic wear consistent with use.",
	"Fleet unit, regularly serviced on schedule.",
	"Low hours for year. Original paint throughout.",
];

const FEATURES = [
	"GPS guidance and autosteer",
	"climate controlled cab",
	"precision ag package",
	"front axle suspension",
	"upgraded hydraulic capacity",
	"heavy duty drawbar",
	"variable rate control",
];

const FIRST_NAMES = [
	"James",
	"Mary",
	"Robert",
	"Patricia",
	"John",
	"Jennifer",
	"Michael",
	"Linda",
	"David",
	"Elizabeth",
	"William",
	"Barbara",
	"Richard",
	"Susan",
	"Joseph",
	"Jessica",
	"Thomas",
	"Sarah",
	"Charles",
	"Karen",
	"Daniel",
	"Nancy",
	"Matthew",
	"Lisa",
	"Anthony",
	"Betty",
	"Mark",
	"Margaret",
	"Donald",
	"Sandra",
];
const LAST_NAMES = [
	"Smith",
	"Johnson",
	"Williams",
	"Brown",
	"Jones",
	"Garcia",
	"Miller",
	"Davis",
	"Rodriguez",
	"Martinez",
	"Hernandez",
	"Lopez",
	"Wilson",
	"Anderson",
	"Thomas",
	"Taylor",
	"Moore",
	"Jackson",
	"Martin",
	"Lee",
	"Thompson",
	"White",
	"Harris",
	"Clark",
	"Lewis",
	"Walker",
	"Hall",
	"Young",
	"Allen",
	"King",
];

const CATEGORIES = Object.keys(EQUIPMENT) as Category[];

// ============================================================
// Generation
// ============================================================

interface GeneratedBid {
	id: string;
	listingId: string;
	bidder: string;
	amount: number;
	placedAt: string;
}

interface GeneratedListing {
	id: string;
	title: string;
	description: string;
	category: Category;
	startingPrice: number;
	currentBid: number;
	currentBidder: string | null;
	status: "active" | "closed" | "pending";
	endsAt: string;
	imageUrl: string;
	bids: GeneratedBid[];
}

const BASE_PRICE: Record<Category, [number, number]> = {
	tractor: [45_000, 420_000],
	combine: [90_000, 650_000],
	implement: [8_000, 120_000],
	attachment: [1_500, 65_000],
};

function generate(count: number, now: number): GeneratedListing[] {
	const listings: GeneratedListing[] = [];

	for (let i = 0; i < count; i++) {
		const category = pick(CATEGORIES);
		const { makes, models } = EQUIPMENT[category];
		const year = intBetween(2008, 2025);
		const title = `${year} ${pick(makes)} ${pick(models)}`;

		const [lo, hi] = BASE_PRICE[category];
		// Round to something a person would actually type.
		const startingPrice = Math.round(between(lo, hi) / 500) * 500;

		// Spread across a year in both directions so filtering by status and
		// sorting by end date both have something to work with.
		const endsInHours = between(-2_000, 6_000);
		const endsAt = new Date(now + endsInHours * 3_600_000).toISOString();
		const ended = endsInHours <= 0;

		// A tenth of future auctions are still pending.
		//
		// Of the ended ones, most are closed -- but roughly one in eight keeps
		// status "active". Those are auctions past their end time that nothing
		// has swept yet, and that window is real in any system where expiry is
		// a background job. It's also the case the UI has to derive rather than
		// trust, so the fixture needs to contain some.
		const status = ended
			? random() < 0.125
				? "active"
				: "closed"
			: random() < 0.1
				? "pending"
				: "active";

		// Roughly a third of lots attract no bids at all -- the empty-history
		// case has to be common enough to hit while clicking around.
		const bidCount = random() < 0.34 ? 0 : intBetween(1, 12);

		const listing: GeneratedListing = {
			id: randomUUID(),
			title,
			description: `${pick(CONDITIONS)} Equipped with ${pick(FEATURES)} and ${pick(FEATURES)}. ${intBetween(120, 9_500).toLocaleString()} hours.`,
			category,
			startingPrice,
			currentBid: startingPrice,
			currentBidder: null,
			status,
			endsAt,
			imageUrl: `https://placehold.co/400x300?text=${encodeURIComponent(title)}`,
			bids: [],
		};

		// Bids climb from the starting price and land before the auction ends,
		// oldest first. currentBid/currentBidder are then the last of them --
		// the same invariant the API maintains when a bid is placed for real.
		let amount = startingPrice;
		let placedAt = now + (endsInHours - between(24, 400)) * 3_600_000;

		for (let b = 0; b < bidCount; b++) {
			amount = Math.round((amount * between(1.01, 1.09)) / 100) * 100;
			placedAt += between(0.5, 20) * 3_600_000;
			const bidder = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;

			listing.bids.push({
				id: randomUUID(),
				listingId: listing.id,
				bidder,
				amount,
				placedAt: new Date(placedAt).toISOString(),
			});

			listing.currentBid = amount;
			listing.currentBidder = bidder;
		}

		listings.push(listing);
	}

	return listings;
}

// ============================================================
// Showcase listings
// ============================================================

/**
 * Fixed lots that always land in a known state, one per countdown band.
 *
 * The randomly generated set will usually contain something in each band, but
 * "usually" is no good for checking the UI. These guarantee that after every
 * reseed there is a listing closing in 45 seconds, one in 5 minutes, one in an
 * hour, and so on — so the seconds format, the urgent styling, and the live
 * flip to Ended are all reachable without waiting or hunting.
 *
 * They sort to the front under the default ordering (soonest first), so
 * they're on page one.
 */
const SHOWCASE: {
	label: string;
	endsInMinutes: number;
	status: "active" | "closed";
	bids: number;
}[] = [
	{
		label: "ENDED — swept, sold",
		endsInMinutes: -2 * 60,
		status: "closed",
		bids: 5,
	},
	{
		label: "ENDED — swept, no bids",
		endsInMinutes: -90,
		status: "closed",
		bids: 0,
	},
	// Past its end time but still stored active: the window between an auction
	// ending and a sweep noticing. The UI has to derive this, not trust status.
	{
		label: "ENDED — not yet swept",
		endsInMinutes: -20,
		status: "active",
		bids: 3,
	},
	// Expires while you watch it — the live flip to Ended, no reload.
	{ label: "45 seconds", endsInMinutes: 0.75, status: "active", bids: 7 },
	{ label: "5 minutes", endsInMinutes: 5, status: "active", bids: 4 },
	{ label: "next hour", endsInMinutes: 58, status: "active", bids: 9 },
	{ label: "5 hours", endsInMinutes: 5 * 60, status: "active", bids: 2 },
	{ label: "next day", endsInMinutes: 23 * 60, status: "active", bids: 6 },
	{ label: "3 days", endsInMinutes: 3 * 24 * 60, status: "active", bids: 0 },
];

function showcase(now: number): GeneratedListing[] {
	return SHOWCASE.map(({ label, endsInMinutes, status, bids: bidCount }) => {
		const category = pick(CATEGORIES);
		const { makes, models } = EQUIPMENT[category];
		const [lo, hi] = BASE_PRICE[category];
		const startingPrice = Math.round(between(lo, hi) / 500) * 500;
		const endsAt = new Date(now + endsInMinutes * 60_000).toISOString();

		const listing: GeneratedListing = {
			id: randomUUID(),
			// Prefixed so they're findable by searching "demo" in the UI.
			title: `[DEMO ${label}] ${pick(makes)} ${pick(models)}`,
			description: `Fixture listing for the "${label}" countdown band. ${pick(CONDITIONS)}`,
			category,
			startingPrice,
			currentBid: startingPrice,
			currentBidder: null,
			status,
			endsAt,
			imageUrl: `https://placehold.co/400x300?text=${encodeURIComponent(label)}`,
			bids: [],
		};

		let amount = startingPrice;
		let placedAt = now + (endsInMinutes - 600) * 60_000;

		for (let b = 0; b < bidCount; b++) {
			amount = Math.round((amount * between(1.01, 1.09)) / 100) * 100;
			placedAt += between(10, 90) * 60_000;
			const bidder = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;

			listing.bids.push({
				id: randomUUID(),
				listingId: listing.id,
				bidder,
				amount,
				placedAt: new Date(placedAt).toISOString(),
			});

			listing.currentBid = amount;
			listing.currentBidder = bidder;
		}

		return listing;
	});
}

// ============================================================
// Write
// ============================================================

function insertAll(db: Db, listings: GeneratedListing[]): void {
	const insertListing = db.prepare(`
		INSERT INTO listings (
			id, title, description, category, starting_price,
			current_bid, current_bidder, status, ends_at, image_url
		) VALUES (
			@id, @title, @description, @category, @startingPrice,
			@currentBid, @currentBidder, @status, @endsAt, @imageUrl
		)
	`);

	const insertBid = db.prepare(`
		INSERT INTO bids (id, listing_id, bidder, amount, placed_at)
		VALUES (@id, @listingId, @bidder, @amount, @placedAt)
	`);

	// One transaction for the whole load. Thousands of individual commits would
	// each pay a disk sync; this pays one.
	db.transaction((rows: GeneratedListing[]) => {
		for (const { bids, ...listing } of rows) {
			insertListing.run(listing);
			for (const bid of bids) insertBid.run(bid);
		}
	})(listings);
}

function main(): void {
	const arg = process.argv[2];
	const count = arg ? Number(arg) : DEFAULT_COUNT;

	if (!Number.isInteger(count) || count < 1) {
		console.error(`Usage: npm run seed:demo -- <count>   (got: ${arg})`);
		process.exit(1);
	}

	const db = initDatabase(join(__dirname, "..", "data", "auction.db"), (m) =>
		console.log(m),
	);

	// Clear first so the script is idempotent -- running it twice gives the
	// same database, not double the listings. Bids go first: the foreign key
	// would reject orphaning them.
	const existing = db.prepare("SELECT COUNT(*) AS n FROM listings").get() as {
		n: number;
	};
	db.exec("DELETE FROM bids");
	db.exec("DELETE FROM listings");
	console.log(`cleared ${existing.n} existing listings`);

	const now = Date.now();
	const fixed = showcase(now);
	const listings = [...fixed, ...generate(count - fixed.length, now)];
	insertAll(db, listings);

	const bidTotal = listings.reduce((sum, l) => sum + l.bids.length, 0);
	const active = listings.filter((l) => l.status === "active").length;
	const withoutBids = listings.filter((l) => l.bids.length === 0).length;

	console.log(
		[
			`seeded ${listings.length} listings (${active} active, ${withoutBids} with no bids)`,
			`seeded ${bidTotal} bids`,
			`${fixed.length} fixed [DEMO] listings, one per countdown band`,
			`${Math.ceil(listings.length / 6)} pages at the UI's page size of 6`,
		].join("\n"),
	);

	db.close();
}

main();
