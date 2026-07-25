import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { initDatabase } from "../db";
import { EventChannel } from "../events";

/**
 * The remaining seams: the SSE route itself, and the error path that only
 * fires on a bug rather than on bad input.
 */
describe("GET /api/events", () => {
	it("subscribes the request to the channel and streams SSE headers", async () => {
		const db = initDatabase(":memory:");
		const channel = new EventChannel();
		const app = createApp(db, channel);

		// Driven through the real router with a hand-built request/response
		// pair. Supertest can't help here: it waits for a response to finish,
		// and this one is designed never to.
		const { createServer } = await import("node:http");
		const server = createServer(app);

		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as { port: number }).port;

		const controller = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
			signal: controller.signal,
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
		expect(res.headers.get("cache-control")).toMatch(/no-cache/);
		expect(channel.subscriberCount).toBe(1);

		// Reading one event proves the stream actually delivers, not just that
		// the headers looked right.
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		channel.publish({
			type: "closed",
			listingId: "listing-1",
			endsAt: new Date().toISOString(),
		});

		const decoder = new TextDecoder();
		let received = "";
		while (!received.includes("event: closed")) {
			const { value, done } = await reader.read();
			if (done) break;
			received += decoder.decode(value, { stream: true });
		}

		expect(received).toContain("event: closed");
		expect(received).toContain('"listingId":"listing-1"');

		controller.abort();
		await new Promise((r) => setTimeout(r, 50));

		// The subscriber is released when the client goes away; without this
		// every disconnect would leak a response object for the process's life.
		expect(channel.subscriberCount).toBe(0);

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		db.close();
	});

	it("drops a subscriber whose heartbeat write fails", () => {
		vi.useFakeTimers();
		try {
			const channel = new EventChannel();
			let alive = true;
			const res = {
				writeHead: () => res,
				write: () => {
					if (!alive) throw new Error("socket closed");
					return true;
				},
				end: () => {},
				on: () => res,
			};

			channel.subscribe(res as unknown as Response);
			expect(channel.subscriberCount).toBe(1);

			// The socket dies without ever emitting 'close' — a half-open
			// connection, which is what the heartbeat is there to discover.
			alive = false;
			vi.advanceTimersByTime(26_000);

			expect(channel.subscriberCount).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("unexpected errors", () => {
	it("does not swallow an error that isn't an HTTP error", async () => {
		// sendError deliberately rethrows anything it doesn't recognise rather
		// than reporting a programming mistake to the client as a 400. This
		// pins that: a broken query surfaces as a 500, not a polite message.
		const db = initDatabase(":memory:");
		const channel = new EventChannel();
		const app = createApp(db, channel);

		// Break the table out from under a prepared statement.
		db.exec("DROP TABLE bids");

		const supertest = (await import("supertest")).default;
		const listing = db
			.prepare(
				"SELECT id, current_bid FROM listings WHERE status = 'active' AND ends_at > ? LIMIT 1",
			)
			.get(new Date().toISOString()) as { id: string; current_bid: number };

		const res = await supertest(app)
			.post(`/api/listings/${listing.id}/bids`)
			.send({ bidder: "Jane", amount: listing.current_bid + 1_000 });

		expect(res.status).toBe(500);
		db.close();
	});
});
