import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, migrate, openDatabase, seedIfEmpty } from "../db";

/** The migrations on disk, in the order they are applied. */
function migrationFiles(): string[] {
	return readdirSync(new URL("../migrations", import.meta.url))
		.filter((f) => f.endsWith(".sql"))
		.sort();
}

function migrationCount(): number {
	return migrationFiles().length;
}

const temps: string[] = [];

function tempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "auction-db-"));
	temps.push(dir);
	return join(dir, "test.db");
}

afterEach(() => {
	while (temps.length) {
		rmSync(temps.pop() as string, { recursive: true, force: true });
	}
});

describe("openDatabase", () => {
	it("enforces foreign keys", () => {
		// Off by default in SQLite. Without it the bids -> listings reference is
		// documentation rather than a constraint.
		const db = openDatabase(":memory:");
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		db.close();
	});

	it("uses WAL for a file-backed database", () => {
		// Readers don't block the writer — the setting you want the moment more
		// than one request is in flight.
		const db = openDatabase(tempDbPath());
		expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
		db.close();
	});

	it("leaves an in-memory database on its default journal", () => {
		// WAL needs a file to write alongside; there is nothing to gain here.
		const db = openDatabase(":memory:");
		expect(db.pragma("journal_mode", { simple: true })).not.toBe("wal");
		db.close();
	});

	it("rejects a bid referencing a listing that does not exist", () => {
		const db = initDatabase(":memory:");
		expect(() =>
			db
				.prepare(
					"INSERT INTO bids (id, listing_id, bidder, amount, placed_at) VALUES (?,?,?,?,?)",
				)
				.run("b1", "no-such-listing", "Nobody", 100, new Date().toISOString()),
		).toThrow(/FOREIGN KEY/i);
		db.close();
	});
});

describe("migrate", () => {
	it("records each migration it applies", () => {
		const db = openDatabase(":memory:");
		migrate(db);

		const applied = db
			.prepare("SELECT name FROM schema_migrations ORDER BY name")
			.all() as { name: string }[];

		// Compared against the directory so adding a migration doesn't mean
		// editing this test, and so a file that fails to apply is caught.
		expect(applied.map((r) => r.name)).toEqual(migrationFiles());
		db.close();
	});

	it("creates the tables the app needs", () => {
		const db = openDatabase(":memory:");
		migrate(db);

		const tables = (
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as { name: string }[]
		).map((r) => r.name);

		expect(tables).toContain("listings");
		expect(tables).toContain("bids");
		db.close();
	});

	it("is idempotent", () => {
		// It runs on every boot. A second pass re-executing CREATE TABLE would
		// throw and take the server down on restart.
		const db = openDatabase(":memory:");
		migrate(db);

		expect(() => migrate(db)).not.toThrow();
		// Counted against the directory rather than a literal, so adding a
		// migration doesn't require editing this test.
		expect(
			(
				db.prepare("SELECT COUNT(*) c FROM schema_migrations").get() as {
					c: number;
				}
			).c,
		).toBe(migrationCount());
		db.close();
	});

	it("reports what it applied, and stays quiet on a second pass", () => {
		const db = openDatabase(":memory:");
		const first: string[] = [];
		migrate(db, (m) => first.push(m));

		const second: string[] = [];
		migrate(db, (m) => second.push(m));

		expect(first).toHaveLength(migrationCount());
		expect(second).toHaveLength(0);
		db.close();
	});

	it("survives a restart against the same file", () => {
		const path = tempDbPath();
		const first = initDatabase(path);
		first.close();

		const messages: string[] = [];
		const second = initDatabase(path, (m) => messages.push(m));

		// Nothing to migrate and nothing to seed the second time around.
		expect(messages).toHaveLength(0);
		expect(
			(second.prepare("SELECT COUNT(*) c FROM listings").get() as { c: number })
				.c,
		).toBe(8);
		second.close();
	});
});

describe("seedIfEmpty", () => {
	it("loads the fixture into an empty table", () => {
		const db = openDatabase(":memory:");
		migrate(db);
		seedIfEmpty(db);

		expect(
			(db.prepare("SELECT COUNT(*) c FROM listings").get() as { c: number }).c,
		).toBe(8);
		db.close();
	});

	it("does nothing when listings already exist", () => {
		// Seeding is a development convenience. Re-running it against a
		// populated database would duplicate every row on every boot.
		const db = initDatabase(":memory:");
		const messages: string[] = [];

		seedIfEmpty(db, (m) => messages.push(m));

		expect(messages).toHaveLength(0);
		expect(
			(db.prepare("SELECT COUNT(*) c FROM listings").get() as { c: number }).c,
		).toBe(8);
		db.close();
	});

	it("resolves the fixture's relative offsets into timestamps", () => {
		// The fixture stores endsInHours rather than a date so it can't go
		// stale; the seeder is what turns that into an actual deadline.
		const db = initDatabase(":memory:");
		const rows = db.prepare("SELECT ends_at FROM listings").all() as {
			ends_at: string;
		}[];

		expect(rows).toHaveLength(8);
		for (const row of rows) {
			expect(Number.isNaN(Date.parse(row.ends_at))).toBe(false);
		}
		// Some in the future, some already past — both cases exist in the
		// fixture on purpose.
		const now = Date.now();
		expect(rows.some((r) => Date.parse(r.ends_at) > now)).toBe(true);
		expect(rows.some((r) => Date.parse(r.ends_at) <= now)).toBe(true);
		db.close();
	});

	it("does not store the offset column on the row", () => {
		const db = initDatabase(":memory:");
		const row = db.prepare("SELECT * FROM listings LIMIT 1").get() as Record<
			string,
			unknown
		>;

		expect(row).not.toHaveProperty("endsInHours");
		expect(row).toHaveProperty("ends_at");
		db.close();
	});
});
