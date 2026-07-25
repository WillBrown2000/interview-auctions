-- Gives `pending` something to mean.
--
-- The status enum shipped as active | closed | pending, but nothing ever set
-- pending and nothing could: the model had an end time and no start time, so
-- "hasn't opened yet" was a state the system could describe and never reach.
-- The only behaviour it had was incidental -- the bid endpoint refuses
-- anything that isn't active, so a pending lot rejected bids without anyone
-- having decided it should.
--
-- Reading it as the auction-house sense of the word: catalogued and visible,
-- bidding not yet open. Buyers browse and inspect during a preview window, and
-- the lot opens on a schedule. That fits the behaviour already there, and it's
-- the reading that needs the least invention.
--
--     now < starts_at            pending
--     starts_at <= now < ends_at active
--     now >= ends_at             closed
--
-- Backfilled to the epoch so every existing listing is already open. A default
-- of "now" would have re-opened closed auctions and made live ones pending for
-- an instant, which is a migration that changes data rather than shape.
ALTER TABLE listings
	ADD COLUMN starts_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

-- The sweep that opens scheduled lots is
--
--     UPDATE listings SET status = 'active'
--      WHERE status = 'pending' AND starts_at <= ?
--
-- which is the same shape as the expiry sweep and wants the same treatment:
-- equality column first, range column second, so it's a bounded scan of one
-- status rather than a scan of the table every few seconds.
CREATE INDEX listings_status_starts_at_idx ON listings (status, starts_at);
