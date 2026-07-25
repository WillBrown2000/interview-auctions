import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuctionEvent, useAuctionEvents } from "./useAuctionEvents";

/**
 * A stand-in for the browser's EventSource.
 *
 * jsdom doesn't implement it, and a real one would need a server. This records
 * what the hook subscribed to and lets a test push frames at it.
 */
class FakeEventSource {
	static instances: FakeEventSource[] = [];

	url: string;
	closed = false;
	onopen: (() => void) | null = null;
	listeners: Record<string, ((e: MessageEvent) => void)[]> = {};

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
	}

	addEventListener(type: string, handler: (e: MessageEvent) => void) {
		(this.listeners[type] ??= []).push(handler);
	}

	removeEventListener(type: string, handler: (e: MessageEvent) => void) {
		this.listeners[type] = (this.listeners[type] ?? []).filter(
			(h) => h !== handler,
		);
	}

	close() {
		this.closed = true;
	}

	/** Delivers a frame the way the server would. */
	emit(type: string, data: unknown) {
		const event = { data: JSON.stringify(data) } as MessageEvent;
		for (const handler of this.listeners[type] ?? []) handler(event);
	}

	/** Delivers a frame that isn't valid JSON. */
	emitRaw(type: string, data: string) {
		const event = { data } as MessageEvent;
		for (const handler of this.listeners[type] ?? []) handler(event);
	}

	static latest() {
		return FakeEventSource.instances[FakeEventSource.instances.length - 1];
	}

	static reset() {
		FakeEventSource.instances = [];
	}
}

function Subscriber(props: {
	onEvent: (e: AuctionEvent) => void;
	onReconnect?: () => void;
}) {
	useAuctionEvents(props);
	return null;
}

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useAuctionEvents", () => {
	it("opens one stream", () => {
		render(<Subscriber onEvent={() => {}} />);

		expect(FakeEventSource.instances).toHaveLength(1);
		expect(FakeEventSource.latest().url).toBe("/api/events");
	});

	it("delivers bid events", () => {
		const onEvent = vi.fn();
		render(<Subscriber onEvent={onEvent} />);

		const event = {
			type: "bid",
			listingId: "listing-1",
			currentBid: 52_000,
			currentBidder: "Jane Smith",
			placedAt: "2026-07-24T12:00:00.000Z",
		};
		act(() => FakeEventSource.latest().emit("bid", event));

		expect(onEvent).toHaveBeenCalledWith(event);
	});

	it("delivers closed events", () => {
		const onEvent = vi.fn();
		render(<Subscriber onEvent={onEvent} />);

		act(() =>
			FakeEventSource.latest().emit("closed", {
				type: "closed",
				listingId: "listing-1",
				endsAt: "2026-07-24T12:00:00.000Z",
			}),
		);

		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "closed" }),
		);
	});

	it("delivers updated events", () => {
		const onEvent = vi.fn();
		render(<Subscriber onEvent={onEvent} />);

		act(() =>
			FakeEventSource.latest().emit("updated", {
				type: "updated",
				listingId: "listing-1",
				status: "active",
				endsAt: "2026-07-24T12:00:00.000Z",
				currentBid: 25_000,
				currentBidder: null,
			}),
		);

		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ type: "updated" }),
		);
	});

	it("survives a malformed frame", () => {
		// A bad frame shouldn't take the stream down with it.
		const onEvent = vi.fn();
		render(<Subscriber onEvent={onEvent} />);

		expect(() =>
			act(() => FakeEventSource.latest().emitRaw("bid", "not json")),
		).not.toThrow();
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("closes the stream on unmount", () => {
		// Without this, StrictMode's double-mount leaks a connection per cycle
		// and the browser's per-origin cap does the rest.
		const { unmount } = render(<Subscriber onEvent={() => {}} />);
		const source = FakeEventSource.latest();

		unmount();

		expect(source.closed).toBe(true);
	});

	it("does not reopen the stream when its callback identity changes", () => {
		// A new inline arrow every render would otherwise tear down and rebuild
		// the connection continuously, dropping events each time.
		const { rerender } = render(<Subscriber onEvent={() => {}} />);
		rerender(<Subscriber onEvent={() => {}} />);
		rerender(<Subscriber onEvent={() => {}} />);

		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it("uses the latest callback rather than the one it opened with", () => {
		const first = vi.fn();
		const second = vi.fn();
		const { rerender } = render(<Subscriber onEvent={first} />);
		rerender(<Subscriber onEvent={second} />);

		act(() =>
			FakeEventSource.latest().emit("bid", { type: "bid", listingId: "x" }),
		);

		expect(second).toHaveBeenCalled();
		expect(first).not.toHaveBeenCalled();
	});

	it("does not call onReconnect for the first connection", () => {
		// The data was just fetched; refetching immediately would be wasted.
		const onReconnect = vi.fn();
		render(<Subscriber onEvent={() => {}} onReconnect={onReconnect} />);

		act(() => FakeEventSource.latest().onopen?.());

		expect(onReconnect).not.toHaveBeenCalled();
	});

	it("calls onReconnect when the stream comes back", () => {
		// Events during the gap are gone, so the client refetches rather than
		// relying on server-side replay.
		const onReconnect = vi.fn();
		render(<Subscriber onEvent={() => {}} onReconnect={onReconnect} />);

		act(() => FakeEventSource.latest().onopen?.());
		act(() => FakeEventSource.latest().onopen?.());

		expect(onReconnect).toHaveBeenCalledTimes(1);
	});

	it("works without an onReconnect handler", () => {
		render(<Subscriber onEvent={() => {}} />);

		expect(() => {
			act(() => FakeEventSource.latest().onopen?.());
			act(() => FakeEventSource.latest().onopen?.());
		}).not.toThrow();
	});
});
