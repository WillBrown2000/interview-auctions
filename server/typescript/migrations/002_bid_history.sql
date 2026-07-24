-- Bid history.
--
-- Bids are immutable events: nothing here is ever updated or deleted, only
-- appended. That's what makes listings.current_bid safe to keep as a cached
-- projection -- it can always be recomputed by re-reading this table.

CREATE TABLE bids (
	id         TEXT PRIMARY KEY,
	listing_id TEXT NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
	bidder     TEXT NOT NULL,
	amount     REAL NOT NULL CHECK (amount > 0),
	placed_at  TEXT NOT NULL
);

-- The only query this table serves is "bids for one listing, newest first".
-- Leading with listing_id makes that a range scan over one listing rather
-- than a scan of every bid ever placed, and the descending placed_at means
-- the index supplies the ordering instead of a sort step.
--
-- Ties on placed_at are broken by rowid at query time: several bids can land
-- inside the same millisecond, so the timestamp alone is not a total order.
CREATE INDEX bids_listing_placed_idx ON bids (listing_id, placed_at DESC);

-- Deliberately absent: a users table. `bidder` is free text typed into a form
-- with no authentication behind it, so a users table today would hold
-- unverified names and buy a join. When auth arrives it becomes migration
-- 003 -- create users, backfill from distinct bidder values, add bids.user_id
-- as a foreign key, drop this column.
