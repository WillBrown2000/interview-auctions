-- Listing photos, stored in the database rather than on disk.
--
-- Local disk breaks the moment there is more than one process: a second
-- instance serves 404s for anything the first one accepted. Keeping the bytes
-- here means the database file is the whole state -- delete it and the photos
-- go with it, which is also what makes `make reset` actually reset.
--
-- SQLite is well suited to this at these sizes. Its own benchmarks put the
-- crossover at roughly 100KB, below which reading a blob out of the database
-- beats opening a file, and it stays competitive to about a megabyte. The
-- upload cap is 2MB (see uploads.ts), so the tail of that range is the worst
-- case rather than the norm.
--
-- The real answer past one machine is object storage with the API handing out
-- a presigned URL so the bytes never pass through it. That's a different
-- shape, not a larger version of this one.

-- A separate table, not a column on listings. Every list query is
-- `SELECT * FROM listings`, and with the blob inline that would pull megabytes
-- of image data through memory to render a page of six cards. Splitting it
-- means photo bytes are only read when a photo is actually requested.
CREATE TABLE listing_images (
	-- One photo per listing, so the listing id is the natural key. A separate
	-- id would invite a second row nothing knows how to choose between.
	listing_id   TEXT PRIMARY KEY REFERENCES listings (id) ON DELETE CASCADE,
	content_type TEXT NOT NULL,
	byte_size    INTEGER NOT NULL,
	data         BLOB NOT NULL,
	created_at   TEXT NOT NULL
);
