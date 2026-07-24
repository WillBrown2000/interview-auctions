import type { Listing } from "./types";

/**
 * An auction is over when the server has closed it, or when its end time has
 * passed regardless of what status still says.
 *
 * Both halves matter. Status is what the server has gotten around to writing;
 * endsAt is the actual deadline. A listing can sit marked "active" with its
 * end time in the past, and the UI should already be treating it as finished
 * — the server refuses bids on it either way.
 *
 * `now` is a parameter so a countdown can pass the timestamp it's already
 * ticking on, instead of every caller reading the clock separately.
 */
export function hasEnded(listing: Listing, now: number = Date.now()): boolean {
	return listing.status !== "active" || Date.parse(listing.endsAt) <= now;
}
