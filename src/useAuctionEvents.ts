import { useEffect, useRef } from "react";

/**
 * Subscribes to the server's event stream for the lifetime of the component.
 *
 * One EventSource for the whole app, opened at the root. A connection per card
 * would mean six on a page of six, and browsers cap concurrent connections per
 * origin at around six on HTTP/1.1 — the app would starve its own API requests
 * to watch listings it could have watched over one stream.
 *
 * There is nothing React-specific about receiving a push. The handler calls
 * setState and React re-renders whatever reads that state; the transport never
 * touches the component tree.
 */

export type AuctionEvent =
	| {
			type: "bid";
			listingId: string;
			currentBid: number;
			currentBidder: string;
			placedAt: string;
	  }
	| {
			type: "closed";
			listingId: string;
			endsAt: string;
	  }
	/**
	 * A change no other event describes — carries the whole mutable surface so
	 * the client applies it without knowing which field moved. Today it's a
	 * listing reopening; it's also the shape an anti-snipe deadline extension
	 * would take.
	 */
	| {
			type: "updated";
			listingId: string;
			status: "active" | "closed" | "pending";
			endsAt: string;
			currentBid: number;
			currentBidder: string | null;
	  };

interface Options {
	onEvent: (event: AuctionEvent) => void;
	/**
	 * Called when the stream reconnects after dropping.
	 *
	 * Events that happened while disconnected are gone — SSE replay would need
	 * server-side history keyed by Last-Event-ID, which is more machinery than
	 * this needs. Refetching on reconnect closes the gap in one request and is
	 * correct regardless of how long the client was away.
	 */
	onReconnect?: () => void;
}

export function useAuctionEvents({ onEvent, onReconnect }: Options): void {
	// Held in refs so the effect depends on nothing that changes per render.
	// Listing them as dependencies would tear down and rebuild the connection
	// on every parent render, which reconnects constantly and drops events.
	const onEventRef = useRef(onEvent);
	const onReconnectRef = useRef(onReconnect);
	onEventRef.current = onEvent;
	onReconnectRef.current = onReconnect;

	useEffect(() => {
		const source = new EventSource("/api/events");

		// Tracks whether this is a fresh connection or a recovery, so the first
		// open doesn't trigger a redundant refetch of data just loaded.
		let hasConnected = false;

		source.onopen = () => {
			if (hasConnected) onReconnectRef.current?.();
			hasConnected = true;
		};

		const handle = (event: MessageEvent) => {
			try {
				onEventRef.current(JSON.parse(event.data) as AuctionEvent);
			} catch {
				// A malformed frame is not worth tearing the stream down for.
			}
		};

		source.addEventListener("bid", handle);
		source.addEventListener("closed", handle);
		source.addEventListener("updated", handle);

		// EventSource reconnects on its own with backoff, so an error is
		// informational rather than something to act on. Calling close() here
		// would disable exactly the recovery the browser is about to perform.

		return () => {
			source.removeEventListener("bid", handle);
			source.removeEventListener("closed", handle);
			source.removeEventListener("updated", handle);
			// Without this the connection survives unmount, and in StrictMode's
			// double-mount every render cycle would leak one.
			source.close();
		};
	}, []);
}
