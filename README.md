# Interview Auctions

A farm equipment auction platform. React + Vite frontend, Express + SQLite API.

---

## Quick start

Two terminals. The API needs to be running before the frontend is useful.

**Terminal 1 — API** (http://localhost:3001)

```bash
cd server/typescript
npm install
npm run dev
```

First run creates the database, applies migrations, and seeds eight listings:

```
migrated: 001_initial.sql
migrated: 002_bid_history.sql
seeded 8 listings
Server running at http://localhost:3001
```

**Terminal 2 — frontend** (http://localhost:5173)

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` to port 3001.

### Node version

Node **20.19+** (Vite 7 requires it). An `.nvmrc` is committed:

```bash
nvm use
```

### Tests

```bash
cd server/typescript
npm test
```

77 tests covering bidding rules, bid history, pagination, filtering, and
sorting. Each test runs against its own in-memory database, so they're
independent and order-insensitive.

---

## Which backend

The project shipped with two equivalent backends and asked for one to be
chosen. **This work uses TypeScript/Express** (`server/typescript`).

`server/python` is left exactly as delivered — it still has the original
bidding bug and none of the features below. Leaving it untouched seemed better
than half-migrating it: a backend carrying the bug fix but not bid history or
pagination is more confusing than one that's obviously untouched.

---

## Database

SQLite, via `better-sqlite3`. The file lives at
`server/typescript/data/auction.db` and is gitignored — it's rebuilt from the
migrations plus `data/listings.json` on first boot.

To start over, delete it and restart the server:

```bash
rm server/typescript/data/auction.db*
npm run dev
```

### Migrations

Hand-rolled, in `server/typescript/migrations/`. Numbered `.sql` files applied
in filename order, each inside a transaction, with applied filenames recorded
in a `schema_migrations` table.

```
001_initial.sql       listings
002_bid_history.sql   bids
```

It's about forty lines in `db.ts`. Knex or Drizzle would both do this, but the
behaviour that matters — ordering, atomicity, what counts as already applied —
is short enough to state directly, and a dependency in a codebase this size is
something you have to justify.

**To add a migration:** create the next numbered file. Don't edit one that has
already run — "applied" is tracked by filename with no checksum, so editing an
applied migration silently does nothing on machines that already have it.

**Deliberately not there yet: a `users` table.** `bidder` is free text typed
into a form with no authentication behind it, so a users table today would hold
unverified names and buy a join. When auth arrives it's migration 003 — create
`users`, backfill from distinct bidder values, add `bids.user_id` as a foreign
key, drop the text column.

Migrations currently run at boot. That's fine at this size and wrong in
production — several instances starting at once all race to migrate, and a
failed migration takes the service down with it. It belongs in a deploy step
that runs once.

---

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/listings` | paginated, filterable, sortable |
| `POST` | `/api/listings` | create (title only) |
| `GET` | `/api/listings/:id` | one listing |
| `POST` | `/api/listings/:id/bids` | place a bid |
| `GET` | `/api/listings/:id/bids` | bid history, newest first |

### `GET /api/listings`

| Param | | |
|---|---|---|
| `page` | 1-based | default `1` |
| `pageSize` | | default `20`, max `100` |
| `category` | `tractor` `combine` `implement` `attachment` | |
| `status` | `active` `closed` `pending` | |
| `q` | substring match on title + description | case-insensitive |
| `minPrice` / `maxPrice` | inclusive bounds on `currentBid` | |
| `sort` | `endsAt` `currentBid` `title` | default `endsAt` |
| `order` | `asc` `desc` | default `asc` |

```json
{
  "data": [ … ],
  "pagination": {
    "page": 1, "pageSize": 20,
    "totalItems": 8, "totalPages": 1, "hasMore": false
  }
}
```

Invalid parameters return `400` naming the parameter rather than being
coerced — `page=abc` is a caller bug, and quietly serving page 1 hides it.

---

## Notes on the work

### The response shape of `GET /api/listings` is a breaking change

It used to return a bare array. Anything doing `listings.map(...)` on the
response breaks.

With real clients I wouldn't do this in place — either `/api/v2/listings` with
v1 deprecated on a published timeline, or return the envelope only when
pagination params are present. I took the break because this app has exactly
one consumer, it lives in this repo, and it's updated in the same commit. The
dual-shape option in particular buys compatibility at the cost of an endpoint
whose return type depends on its input, which is worse to consume and worse to
type.

### Sort ordering is total

Every sort breaks ties on `id`. Without that, two rows comparing equal can come
back in a different order between requests, and a client paging through sees
one row twice while missing another. That's the pagination bug that only shows
up once there's real data.

### `currentBid` is denormalised

`listings.current_bid` and `current_bidder` are a cached projection of the
newest bid. They predate the `bids` table and the API exposes them, so they
stayed — written in the same transaction as the bid that changes them. The
alternative is deriving them from history on every read: always correct, more
work per request. A test asserts the two agree so they can't drift silently.

### Bids are placed in a transaction

Read-validate-write is atomic. Otherwise two bids arriving together both read
the same `current_bid`, both conclude they win, and the second overwrites the
first — a lost update. The transaction is what makes "must beat the current
bid" hold under load rather than only when requests happen to arrive one at a
time.

### Empty and missing are different

`GET /api/listings/:id/bids` returns `200 []` for a real listing nobody has bid
on, and `404` for a listing that doesn't exist. Returning `[]` for both tells
the client nothing about which happened.

---

## Troubleshooting

**`better-sqlite3` fails to build with `fatal error: 'climits' file not found`**

macOS with a Command Line Tools SDK missing its C++ headers. Point the build at
a complete SDK:

```bash
export SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
export CPLUS_INCLUDE_PATH="$SDKROOT/usr/include/c++/v1"
npm install
```

If `MacOSX.sdk` is itself the broken one, name a versioned SDK from
`/Library/Developer/CommandLineTools/SDKs/` directly. Prebuilt binaries cover
most platforms, so this only bites when compiling from source — Intel macOS on
Node 20, for instance.

**Port already in use** — the API expects 3001 and the frontend 5173. Change
the proxy target in `vite.config.ts` if you move the API.
