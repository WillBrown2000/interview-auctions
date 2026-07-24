import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");
const SEED_FILE = join(__dirname, "data", "listings.json");

export type Db = Database.Database;

export function openDatabase(file: string): Db {
	const db = new Database(file);

	// Off by default in SQLite, for backwards compatibility. The bids ->
	// listings reference is only actually enforced with this on.
	db.pragma("foreign_keys = ON");

	// Write-ahead logging: readers don't block the writer. Irrelevant at this
	// size, but it's the setting you want the moment more than one request is
	// in flight, and the default (rollback journal) is not.
	if (file !== ":memory:") {
		db.pragma("journal_mode = WAL");
	}

	return db;
}

/**
 * Applies any migration in ./migrations that hasn't been applied yet.
 *
 * Hand-rolled rather than pulled from a library: it's small enough to read in
 * one sitting, and the behaviour that matters (ordering, atomicity, what
 * counts as "already applied") is explicit rather than a framework's default.
 *
 * Rules:
 *   - files are ordered by filename, so the numeric prefix is the sequence
 *   - each file runs inside a transaction, so a failure part-way through a
 *     migration leaves the database on the previous version rather than
 *     half-migrated
 *   - the filename is recorded in schema_migrations, which is itself how
 *     "already applied" is decided -- there is no checksum, so editing a
 *     migration that has already run does nothing. Add a new file instead.
 */
export function migrate(
	db: Db,
	log: (message: string) => void = () => {},
): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name        TEXT PRIMARY KEY,
			applied_at  TEXT NOT NULL
		)
	`);

	const applied = new Set(
		db
			.prepare("SELECT name FROM schema_migrations")
			.all()
			.map((row) => (row as { name: string }).name),
	);

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	const record = db.prepare(
		"INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
	);

	for (const file of files) {
		if (applied.has(file)) continue;

		const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

		// The migration and the record of it are one unit. Applying the SQL
		// but failing to record it would re-run the migration on next boot.
		db.transaction(() => {
			db.exec(sql);
			record.run(file, new Date().toISOString());
		})();

		log(`migrated: ${file}`);
	}
}

interface SeedListing {
	id: string;
	title: string;
	description: string;
	category: string;
	startingPrice: number;
	currentBid: number;
	currentBidder: string | null;
	status: string;
	/**
	 * Hours from seed time until the auction closes. Negative means it has
	 * already ended.
	 *
	 * The fixture stores an offset rather than an absolute timestamp because
	 * absolute dates rot: the original seed shipped with every auction ending
	 * in April, so by the time anyone ran it, every listing had closed and a
	 * countdown had nothing to count. An offset is correct whenever it's run.
	 */
	endsInHours: number;
	imageUrl: string;
}

/**
 * Loads data/listings.json into an empty listings table.
 *
 * Seeding is separate from migration on purpose. Migrations describe the
 * shape of the database and must run everywhere; seed data is a development
 * fixture. Folding the fixture into 001 would insert eight tractors into
 * production.
 */
export function seedIfEmpty(
	db: Db,
	log: (message: string) => void = () => {},
): void {
	const { count } = db
		.prepare("SELECT COUNT(*) AS count FROM listings")
		.get() as {
		count: number;
	};
	if (count > 0) return;

	const seed: SeedListing[] = JSON.parse(readFileSync(SEED_FILE, "utf-8"));

	const insert = db.prepare(`
		INSERT INTO listings (
			id, title, description, category, starting_price,
			current_bid, current_bidder, status, ends_at, image_url
		) VALUES (
			@id, @title, @description, @category, @startingPrice,
			@currentBid, @currentBidder, @status, @endsAt, @imageUrl
		)
	`);

	const now = Date.now();

	db.transaction((rows: SeedListing[]) => {
		for (const { endsInHours, ...row } of rows) {
			insert.run({
				...row,
				endsAt: new Date(now + endsInHours * 60 * 60 * 1000).toISOString(),
			});
		}
	})(seed);

	log(`seeded ${seed.length} listings`);
}

/** An open, migrated, seeded database. */
export function initDatabase(
	file: string,
	log: (message: string) => void = () => {},
): Db {
	const db = openDatabase(file);
	migrate(db, log);
	seedIfEmpty(db, log);
	return db;
}
