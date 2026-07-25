import { hasEnded } from "../auction";
import type { Listing } from "../types";
import { useNow } from "../useNow";

/**
 * Precision follows urgency.
 *
 * "3 days left" is all anyone wants a week out, and rendering "2 days 14 hours
 * 09 minutes 41 seconds" there is noise pretending to be information. Inside
 * the last minute the opposite holds: every second matters, because that's
 * when bidding actually happens.
 *
 * The bands, in descending order of time remaining:
 *
 *   > 2 days     3 days left
 *   1h - 2 days  1d 14h left  /  6h 21m left
 *   1 - 60 min   4m 32s left
 *   < 1 min      45s left        (urgent)
 *   <= 0         Ended
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Below this, the countdown is styled as urgent. */
const URGENT_MS = 60 * SECOND;

export function formatRemaining(ms: number): string {
	if (ms <= 0) return "Ended";

	if (ms >= 2 * DAY) {
		const days = Math.floor(ms / DAY);
		return `${days} days left`;
	}

	if (ms >= DAY) {
		const days = Math.floor(ms / DAY);
		const hours = Math.floor((ms % DAY) / HOUR);
		return `${days}d ${hours}h left`;
	}

	if (ms >= HOUR) {
		const hours = Math.floor(ms / HOUR);
		const minutes = Math.floor((ms % HOUR) / MINUTE);
		return `${hours}h ${minutes}m left`;
	}

	if (ms >= MINUTE) {
		const minutes = Math.floor(ms / MINUTE);
		const seconds = Math.floor((ms % MINUTE) / SECOND);
		// Seconds padded so the label doesn't change width every tick and shove
		// the layout around.
		return `${minutes}m ${String(seconds).padStart(2, "0")}s left`;
	}

	return `${Math.floor(ms / SECOND)}s left`;
}

interface Props {
	listing: Listing;
	className?: string;
}

/**
 * Live time remaining on an auction.
 *
 * Reads the shared clock rather than owning a timer, so a page of these costs
 * one interval rather than one each. When the clock crosses endsAt this
 * re-renders as "Ended" on its own -- the requirement that a finished auction
 * reflects its closed state without a reload is satisfied by the countdown
 * itself, with no polling or socket involved.
 */
export default function Countdown({ listing, className = "" }: Props) {
	const now = useNow();

	// Goes through hasEnded so a listing the server has already closed reads
	// "Ended" even if its endsAt is somehow still in the future.
	if (hasEnded(listing, now)) {
		return (
			<span className={`countdown countdown--ended ${className}`}>Ended</span>
		);
	}

	const remaining = Date.parse(listing.endsAt) - now;
	const urgent = remaining <= URGENT_MS;

	return (
		<span
			className={`countdown ${urgent ? "countdown--urgent" : ""} ${className}`}
			// The text changes every second; without this a screen reader would
			// announce each tick. Sighted users get the live value either way.
			aria-live="off"
		>
			{formatRemaining(remaining)}
		</span>
	);
}
