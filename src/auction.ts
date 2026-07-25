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
	// A pending listing hasn't ended -- it hasn't started. Checking that first
	// keeps "not open yet" from being reported as "over", which would tell a
	// buyer the opposite of the truth.
	if (isPending(listing, now)) return false;
	return listing.status !== "active" || Date.parse(listing.endsAt) <= now;
}

/**
 * Catalogued, visible, not yet open for bidding.
 *
 * Same shape of reasoning as hasEnded: the stored status is what the server
 * got round to writing, and startsAt is the actual schedule. A listing can sit
 * marked pending with its start time already passed, in the window before the
 * sweep opens it — and it can be freshly created as pending with the sweep yet
 * to run. Both halves have to agree before the UI calls it open.
 */
export function isPending(listing: Listing, now: number = Date.now()): boolean {
	return listing.status === "pending" && Date.parse(listing.startsAt) > now;
}

/** Milliseconds until bidding opens, or 0 if it already has. */
export function opensIn(listing: Listing, now: number = Date.now()): number {
	return Math.max(0, Date.parse(listing.startsAt) - now);
}
