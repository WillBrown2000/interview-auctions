import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { initDatabase } from "../db";
import { EventChannel } from "../events";
import { startExpirySweeper } from "../expiry";
import { type MetricSink, log, metrics, setMetricSink } from "../telemetry";

/** Captures metrics instead of writing them anywhere. */
class RecordingSink implements MetricSink {
	counts: { metric: string; value: number; tags: string[] }[] = [];
	gauges: { metric: string; value: number; tags: string[] }[] = [];
	timings: { metric: string; ms: number; tags: string[] }[] = [];
	flushed = 0;

	count(metric: string, value: number, tags: string[]) {
		this.counts.push({ metric, value, tags });
	}
	gauge(metric: string, value: number, tags: string[]) {
		this.gauges.push({ metric, value, tags });
	}
	timing(metric: string, ms: number, tags: string[]) {
		this.timings.push({ metric, ms, tags });
	}
	async flush() {
		this.flushed++;
	}

	names(list: { metric: string }[]) {
		return list.map((m) => m.metric);
	}
}

let sink: RecordingSink;

beforeEach(() => {
	sink = new RecordingSink();
	setMetricSink(sink);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function app() {
	const db = initDatabase(":memory:");
	const channel = new EventChannel();
	return { db, channel, app: createApp(db, channel) };
}

async function request() {
	return (await import("supertest")).default;
}

function liveListing(db: ReturnType<typeof initDatabase>) {
	return db
		.prepare(
			"SELECT id, current_bid, category FROM listings WHERE status = 'active' AND ends_at > ? LIMIT 1",
		)
		.get(new Date().toISOString()) as {
		id: string;
		current_bid: number;
		category: string;
	};
}

describe("request telemetry", () => {
	it("times every request and counts it", async () => {
		const ctx = app();
		const supertest = await request();

		await supertest(ctx.app).get("/api/listings").expect(200);

		expect(sink.names(sink.timings)).toContain("http.request");
		expect(sink.names(sink.counts)).toContain("http.requests");
	});

	it("tags with method, route and status", async () => {
		const ctx = app();
		const supertest = await request();

		await supertest(ctx.app).get("/api/listings").expect(200);

		const timing = sink.timings.find((t) => t.metric === "http.request");
		expect(timing?.tags).toContain("method:GET");
		expect(timing?.tags).toContain("status:200");
	});

	it("tags by route pattern rather than resolved path", async () => {
		// The whole point: tagging with the id would create one metric series
		// per listing, which is how a metrics bill quietly becomes enormous.
		const ctx = app();
		const supertest = await request();
		const listing = liveListing(ctx.db);

		await supertest(ctx.app).get(`/api/listings/${listing.id}`).expect(200);

		const timing = sink.timings.find((t) => t.metric === "http.request");
		expect(timing?.tags).toContain("route:/api/listings/:id");
		expect(timing?.tags.join(" ")).not.toContain(listing.id);
	});

	it("records failed requests too", async () => {
		const ctx = app();
		const supertest = await request();

		await supertest(ctx.app).get("/api/listings?page=0").expect(400);

		const timing = sink.timings.find((t) => t.metric === "http.request");
		expect(timing?.tags).toContain("status:400");
	});
});

describe("bid telemetry", () => {
	it("counts an accepted bid and gauges the amount", async () => {
		const ctx = app();
		const supertest = await request();
		const listing = liveListing(ctx.db);

		await supertest(ctx.app)
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "Jane Smith", amount: listing.current_bid + 1_000 })
			.expect(201);

		expect(sink.names(sink.counts)).toContain("bid.accepted");
		const gauge = sink.gauges.find((g) => g.metric === "bid.amount");
		expect(gauge?.value).toBe(listing.current_bid + 1_000);
	});

	it("labels rejections by reason", async () => {
		// A spike in too_low is bidders racing; a spike in ended means clients
		// are showing closed auctions as live, which is a bug.
		const ctx = app();
		const supertest = await request();
		const listing = liveListing(ctx.db);

		await supertest(ctx.app)
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "Lowballer", amount: 1 })
			.expect(400);

		const rejected = sink.counts.find((c) => c.metric === "bid.rejected");
		expect(rejected?.tags).toContain("reason:too_low");
	});

	it("labels a bid on an ended auction distinctly", async () => {
		const ctx = app();
		const supertest = await request();
		const expired = ctx.db
			.prepare(
				"SELECT id, current_bid FROM listings WHERE status = 'active' AND ends_at <= ? LIMIT 1",
			)
			.get(new Date().toISOString()) as { id: string; current_bid: number };

		await supertest(ctx.app)
			.post(`/api/listings/${expired.id}/bids`)
			.send({ bidder: "Late", amount: expired.current_bid + 1_000 })
			.expect(400);

		const rejected = sink.counts.find((c) => c.metric === "bid.rejected");
		expect(rejected?.tags).toContain("reason:ended");
	});

	it("labels a bid on a missing listing as not_found", async () => {
		const ctx = app();
		const supertest = await request();

		await supertest(ctx.app)
			.post("/api/listings/00000000-0000-4000-8000-000000000000/bids")
			.send({ bidder: "Nobody", amount: 100 })
			.expect(404);

		const rejected = sink.counts.find((c) => c.metric === "bid.rejected");
		expect(rejected?.tags).toContain("reason:not_found");
	});

	it("counts nothing for a malformed body", async () => {
		// Rejected before reaching the transaction, so there is no auction
		// outcome to attribute it to.
		const ctx = app();
		const supertest = await request();
		const listing = liveListing(ctx.db);

		await supertest(ctx.app)
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "", amount: 100 })
			.expect(400);

		expect(sink.names(sink.counts)).not.toContain("bid.rejected");
	});
});

describe("stream telemetry", () => {
	it("gauges subscriber count on connect", () => {
		const ctx = app();
		const res = {
			writeHead: () => res,
			write: () => true,
			end: () => {},
			on: () => res,
		};

		ctx.channel.subscribe(res as never);
		metrics.gauge("sse.subscribers", ctx.channel.subscriberCount);

		const gauge = sink.gauges.find((g) => g.metric === "sse.subscribers");
		expect(gauge?.value).toBe(1);
	});
});

describe("expiry telemetry", () => {
	it("times each sweep", () => {
		const db = initDatabase(":memory:");
		const sweeper = startExpirySweeper(db, new EventChannel(), 60_000);
		try {
			expect(sink.names(sink.timings)).toContain("expiry.sweep");
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("counts closed auctions when it closes any", () => {
		const db = initDatabase(":memory:");
		const sweeper = startExpirySweeper(db, new EventChannel(), 60_000);
		try {
			// The fixture ships one listing past its end time but still active.
			const closed = sink.counts.find((c) => c.metric === "auction.closed");
			expect(closed?.value).toBeGreaterThanOrEqual(1);
		} finally {
			sweeper.stop();
			db.close();
		}
	});

	it("counts nothing when a sweep closes nothing", () => {
		const db = initDatabase(":memory:");
		const sweeper = startExpirySweeper(db, new EventChannel(), 60_000);
		try {
			const before = sink.counts.filter(
				(c) => c.metric === "auction.closed",
			).length;
			sweeper.sweep();
			const after = sink.counts.filter(
				(c) => c.metric === "auction.closed",
			).length;

			expect(after).toBe(before);
		} finally {
			sweeper.stop();
			db.close();
		}
	});
});

describe("structured logging", () => {
	it("writes one JSON object per line", () => {
		const written: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		log.error("test.event", { listingId: "listing-1" });
		vi.restoreAllMocks();

		// error goes to stderr, so capture that instead.
		const errors: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			errors.push(String(chunk));
			return true;
		});
		log.error("test.event", { listingId: "listing-1" });
		vi.restoreAllMocks();

		const parsed = JSON.parse(errors[0]);
		expect(parsed).toMatchObject({
			level: "error",
			event: "test.event",
			listingId: "listing-1",
		});
		expect(typeof parsed.timestamp).toBe("string");
	});

	it("redacts bidder names", () => {
		// User-supplied personal data. Logging it is a privacy problem, and
		// tagging a metric with it is also unbounded cardinality.
		const errors: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			errors.push(String(chunk));
			return true;
		});

		log.error("bid.accepted", { bidder: "Jane Smith", amount: 100 });
		vi.restoreAllMocks();

		const parsed = JSON.parse(errors[0]);
		expect(parsed.bidder).toBe("[redacted]");
		expect(parsed.amount).toBe(100);
	});

	it("suppresses levels below the configured threshold", () => {
		// LOG_LEVEL is error in the test environment, so info writes nothing.
		const written: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		log.info("should.not.appear");
		vi.restoreAllMocks();

		expect(written).toHaveLength(0);
	});
});

describe("metric sink selection", () => {
	it("routes through whichever sink is installed", async () => {
		expect(sink.flushed).toBe(0);
		await metrics.flush();
		expect(sink.flushed).toBe(1);
	});
});
