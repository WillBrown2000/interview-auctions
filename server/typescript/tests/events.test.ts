import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AuctionEvent, EventChannel } from "../events";

/**
 * A stand-in for an Express Response holding an open SSE stream.
 *
 * The channel only ever calls writeHead, write, end, and on — small enough
 * surface that a fake is clearer than starting a real HTTP server, and it
 * makes "what did the client receive" directly inspectable.
 */
function fakeResponse() {
	const handlers: Record<string, (() => void)[]> = {};
	const written: string[] = [];

	const res = {
		headers: null as Record<string, string> | null,
		ended: false,
		writeHead(_status: number, headers: Record<string, string>) {
			res.headers = headers;
			return res;
		},
		write(chunk: string) {
			if (res.ended) throw new Error("write after end");
			written.push(chunk);
			return true;
		},
		end() {
			res.ended = true;
		},
		on(event: string, handler: () => void) {
			(handlers[event] ??= []).push(handler);
			return res;
		},
		/** Simulates the client going away. */
		emit(event: string) {
			for (const h of handlers[event] ?? []) h();
		},
		written,
		/** Everything written except heartbeats and the connect comment. */
		get events() {
			return written.filter((c) => !c.startsWith(":"));
		},
	};

	return res;
}

const BID: AuctionEvent = {
	type: "bid",
	listingId: "listing-1",
	currentBid: 52_000,
	currentBidder: "Jane Smith",
	placedAt: "2026-07-24T12:00:00.000Z",
};

const CLOSED: AuctionEvent = {
	type: "closed",
	listingId: "listing-2",
	endsAt: "2026-07-24T12:00:00.000Z",
};

describe("EventChannel", () => {
	let channel: EventChannel;

	beforeEach(() => {
		channel = new EventChannel();
	});

	describe("subscribing", () => {
		it("sends the SSE content type", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);

			expect(res.headers?.["Content-Type"]).toBe("text/event-stream");
		});

		it("disables caching and proxy buffering", () => {
			// Without X-Accel-Buffering, nginx holds events until its buffer
			// fills, which looks exactly like a stream that never delivers.
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);

			expect(res.headers?.["Cache-Control"]).toBe("no-cache");
			expect(res.headers?.["X-Accel-Buffering"]).toBe("no");
		});

		it("writes immediately so the client's onopen fires", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);

			expect(res.written[0]).toMatch(/^:/);
		});

		it("counts subscribers", () => {
			expect(channel.subscriberCount).toBe(0);
			channel.subscribe(fakeResponse() as unknown as Response);
			channel.subscribe(fakeResponse() as unknown as Response);
			expect(channel.subscriberCount).toBe(2);
		});
	});

	describe("publishing", () => {
		it("formats an event as SSE frames", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);
			channel.publish(BID);

			expect(res.events).toHaveLength(1);
			expect(res.events[0]).toBe(
				`event: bid\ndata: ${JSON.stringify(BID)}\n\n`,
			);
		});

		it("names the event type so clients can listen selectively", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);
			channel.publish(CLOSED);

			expect(res.events[0].startsWith("event: closed\n")).toBe(true);
		});

		it("delivers to every subscriber", () => {
			// The requirement that multiple bidders can connect at once.
			const clients = [fakeResponse(), fakeResponse(), fakeResponse()];
			for (const c of clients) channel.subscribe(c as unknown as Response);

			channel.publish(BID);

			for (const c of clients) {
				expect(c.events).toHaveLength(1);
				expect(JSON.parse(c.events[0].split("data: ")[1])).toEqual(BID);
			}
		});

		it("delivers nothing when nobody is listening", () => {
			expect(() => channel.publish(BID)).not.toThrow();
		});

		it("keeps events in the order they were published", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);

			channel.publish(BID);
			channel.publish(CLOSED);

			expect(res.events.map((e) => e.split("\n")[0])).toEqual([
				"event: bid",
				"event: closed",
			]);
		});
	});

	describe("disconnection", () => {
		it("stops writing to a client that closed", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);

			res.emit("close");
			channel.publish(BID);

			expect(channel.subscriberCount).toBe(0);
			expect(res.events).toHaveLength(0);
		});

		it("drops a client whose socket errors", () => {
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);

			res.emit("error");

			expect(channel.subscriberCount).toBe(0);
		});

		it("keeps delivering to the others when one disconnects", () => {
			// A leaked subscriber would keep receiving writes to a dead socket;
			// dropping the wrong one would silently cut off a live bidder.
			const gone = fakeResponse();
			const alive = fakeResponse();
			channel.subscribe(gone as unknown as Response);
			channel.subscribe(alive as unknown as Response);

			gone.emit("close");
			channel.publish(BID);

			expect(channel.subscriberCount).toBe(1);
			expect(alive.events).toHaveLength(1);
		});

		it("drops a subscriber whose write throws", () => {
			// The socket can die between the close event and the next publish.
			const res = fakeResponse();
			channel.subscribe(res as unknown as Response);
			res.ended = true;

			expect(() => channel.publish(BID)).not.toThrow();
			expect(channel.subscriberCount).toBe(0);
		});
	});

	describe("heartbeat", () => {
		it("writes a comment periodically to keep proxies from reaping the connection", () => {
			vi.useFakeTimers();
			try {
				const res = fakeResponse();
				channel.subscribe(res as unknown as Response);
				const before = res.written.length;

				vi.advanceTimersByTime(26_000);

				const pings = res.written
					.slice(before)
					.filter((c) => c === ": ping\n\n");
				expect(pings.length).toBeGreaterThanOrEqual(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("stops once the last subscriber leaves", () => {
			vi.useFakeTimers();
			try {
				const res = fakeResponse();
				channel.subscribe(res as unknown as Response);
				res.emit("close");
				const after = res.written.length;

				vi.advanceTimersByTime(60_000);

				expect(res.written).toHaveLength(after);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("closeAll", () => {
		it("ends every stream and forgets them", () => {
			const clients = [fakeResponse(), fakeResponse()];
			for (const c of clients) channel.subscribe(c as unknown as Response);

			channel.closeAll();

			expect(channel.subscriberCount).toBe(0);
			for (const c of clients) expect(c.ended).toBe(true);
		});
	});
});
