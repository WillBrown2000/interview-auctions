import type { Response } from "express";

/**
 * Server-sent events: one broadcast channel, many subscribers.
 *
 * SSE rather than WebSockets because every message travels server -> client.
 * Bids already arrive over POST, so a client -> server channel would be built
 * and never used, and bidirectionality is WebSocket's entire justification.
 * SSE also reconnects on its own, where WebSocket reconnection is code you
 * write and then have to test.
 *
 * The channel is global rather than per-listing. "All auctions should update
 * with real time highest bidder" means a client needs events for lots it is
 * not currently looking at, so filtering server-side by a single subscribed
 * listing would defeat the requirement. Subscribers receive everything and
 * apply what matches data they hold.
 *
 * That is the scaling limit worth naming: every bid reaches every connection.
 * At this size it is nothing. The next step would be sharding by listing, or a
 * fan-out service between the API and the clients, once one process no longer
 * holds every subscriber.
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
	 * A listing changed in a way a bid or a closure doesn't describe.
	 *
	 * Carries the whole mutable surface rather than a diff, so a client can
	 * apply it without knowing which field moved. The case that needs it today
	 * is a listing reopening — going from closed back to active with a new end
	 * time — which no other event can express.
	 *
	 * It's also the shape anti-snipe extension would use: a bid inside the
	 * final moments pushes endsAt out, and every connected client has to be
	 * told, or they count down to a deadline that no longer exists.
	 */
	| {
			type: "updated";
			listingId: string;
			status: string;
			endsAt: string;
			currentBid: number;
			currentBidder: string | null;
	  };

/**
 * Idle connections get closed by proxies and load balancers, typically
 * somewhere around 30-60 seconds. A comment line is valid SSE that clients
 * ignore, which keeps the connection warm without inventing an event type
 * consumers would have to know about.
 */
const HEARTBEAT_MS = 25_000;

export class EventChannel {
	private subscribers = new Set<Response>();
	private heartbeat: NodeJS.Timeout | null = null;

	/** Attaches a response as an SSE stream until the client disconnects. */
	subscribe(res: Response): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// Nginx buffers proxied responses by default, which holds events
			// until the buffer fills — indistinguishable from a broken stream.
			"X-Accel-Buffering": "no",
		});

		// Flush the headers so the browser fires EventSource.onopen now rather
		// than when the first event happens to arrive.
		res.write(": connected\n\n");

		this.subscribers.add(res);
		this.startHeartbeat();

		// Both events fire in practice depending on how the socket died; Set
		// makes the double delete harmless.
		res.on("close", () => this.unsubscribe(res));
		res.on("error", () => this.unsubscribe(res));
	}

	private unsubscribe(res: Response): void {
		this.subscribers.delete(res);
		if (this.subscribers.size === 0) this.stopHeartbeat();
	}

	/** Sends an event to every connected subscriber. */
	publish(event: AuctionEvent): void {
		const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

		for (const res of this.subscribers) {
			try {
				res.write(payload);
			} catch {
				// A write to a socket that died between the close event and now.
				// Dropping the subscriber is the whole remedy.
				this.unsubscribe(res);
			}
		}
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	private startHeartbeat(): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			for (const res of this.subscribers) {
				try {
					res.write(": ping\n\n");
				} catch {
					this.unsubscribe(res);
				}
			}
		}, HEARTBEAT_MS);

		// Without this the interval alone keeps the process alive, so the server
		// would refuse to exit on Ctrl-C once anyone had ever connected.
		this.heartbeat.unref();
	}

	private stopHeartbeat(): void {
		if (!this.heartbeat) return;
		clearInterval(this.heartbeat);
		this.heartbeat = null;
	}

	/** Ends every stream. Used when shutting the server down and in tests. */
	closeAll(): void {
		this.stopHeartbeat();
		for (const res of this.subscribers) {
			try {
				res.end();
			} catch {
				// Already gone.
			}
		}
		this.subscribers.clear();
	}
}
