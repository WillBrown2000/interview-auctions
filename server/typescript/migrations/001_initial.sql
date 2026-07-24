-- The schema as the app originally shipped: listings only.
--
-- Kept as its own migration rather than folded into a single "create
-- everything" file so the history reflects what actually happened -- bid
-- history arrived later, in 002.

CREATE TABLE listings (
	id             TEXT PRIMARY KEY,
	title          TEXT NOT NULL,
	description    TEXT NOT NULL DEFAULT '',
	category       TEXT NOT NULL
	                 CHECK (category IN ('tractor', 'combine', 'implement', 'attachment')),
	starting_price REAL NOT NULL DEFAULT 0,

	-- Denormalised: both are a projection of the newest accepted bid. They
	-- predate the bids table and the API contract exposes them, so they stay,
	-- written in the same transaction as the bid that changes them.
	current_bid    REAL NOT NULL DEFAULT 0,
	current_bidder TEXT,

	status         TEXT NOT NULL DEFAULT 'active'
	                 CHECK (status IN ('active', 'closed', 'pending')),
	ends_at        TEXT NOT NULL,
	image_url      TEXT NOT NULL DEFAULT ''
);

-- The listings endpoint filters on status and category and sorts by ends_at.
-- At eight rows SQLite ignores these; they exist so the query plan doesn't
-- change shape once the table is real.
CREATE INDEX listings_status_idx   ON listings (status);
CREATE INDEX listings_category_idx ON listings (category);
CREATE INDEX listings_ends_at_idx  ON listings (ends_at);
