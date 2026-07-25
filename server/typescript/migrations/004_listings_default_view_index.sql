-- Indexes for the two orderings the listings page actually asks for.
--
-- The landing page is: active listings, soonest to close, first page.
--
--     SELECT * FROM listings
--      WHERE status = 'active'
--      ORDER BY ends_at ASC, id ASC
--      LIMIT ? OFFSET ?
--
-- 001 gave listings separate indexes on status and ends_at, and SQLite uses
-- one index per table per query. So it filtered on status and then sorted the
-- survivors:
--
--     SEARCH listings USING INDEX listings_status_idx (status=?)
--     USE TEMP B-TREE FOR ORDER BY          <-- sorts every active listing
--
-- That temp B-tree sorts the whole matching set to hand back a page of six.
-- Invisible at 300 rows and the first thing to hurt at 300,000: the work grows
-- with the number of active auctions, not with the size of the page.
--
-- Ordering the columns filter-then-sort lets one index serve both. status is
-- an equality match so it leads; ends_at then runs in order within it, which
-- is the ORDER BY for free. id is included because the query's tiebreak is
-- (ends_at, id) -- without it SQLite still needs a sort to settle rows that
-- share an end time.
CREATE INDEX listings_status_ends_at_idx ON listings (status, ends_at, id);

-- Redundant now: status is the leading column above, so anything this served
-- is served there. Keeping it would mean a second index to write on every
-- insert for no read benefit.
DROP INDEX listings_status_idx;

-- The same tiebreak problem, one level down. "Any status, ending soonest" is a
-- real view -- it's what the status filter falls back to -- and an index on
-- ends_at alone couldn't order (ends_at, id), so the planner ignored it and
-- scanned the table with a sort on top. With id appended it scans the index in
-- order instead, and the sort disappears.
DROP INDEX listings_ends_at_idx;
CREATE INDEX listings_ends_at_idx ON listings (ends_at, id);

-- listings_category_idx is left alone. It serves the category filter, and the
-- sort for that case now rides the ends_at index above.
