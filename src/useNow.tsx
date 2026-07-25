import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

/**
 * A single clock for the whole page, corrected against the server.
 *
 * Two problems this solves.
 *
 * One timer, not one per card. A setInterval inside each card means one
 * interval per rendered listing, each with its own cleanup to get wrong, and
 * an unmount that misses one leaks it for the life of the session. Here there
 * is exactly one interval no matter how many cards are on screen.
 *
 * The server owns the deadline. endsAt comes from the server, so comparing it
 * against an uncorrected Date.now() measures the gap between the auction's
 * clock and the browser's. A laptop running four minutes fast shows every
 * auction ending four minutes early, and a bidder who trusts it loses a lot
 * they thought they still had time for. The offset below is measured once from
 * a response's Date header and applied to every countdown.
 */

interface Clock {
	/** Server-corrected wall clock, in milliseconds. */
	now: number;
	/** Difference between the server's clock and this browser's. */
	offsetMs: number;
}

const ClockContext = createContext<Clock>({ now: Date.now(), offsetMs: 0 });

/**
 * How often the clock advances.
 *
 * One second is the finest granularity anything displays. Components that only
 * need minutes still re-render every second, which is wasteful in principle;
 * at the number of cards on a page it costs less than the machinery to avoid
 * it would. If the page grew to hundreds of visible rows, this is the first
 * thing to make band-aware.
 */
const TICK_MS = 1_000;

export function ClockProvider({ children }: { children: ReactNode }) {
	const [offsetMs, setOffsetMs] = useState(0);
	const [now, setNow] = useState(() => Date.now());

	// Measure the skew once. Every HTTP response already carries a Date header,
	// so this needs no dedicated endpoint and no ongoing traffic -- unlike
	// streaming the countdown itself, which would spend a persistent connection
	// to deliver a number the client can compute.
	useEffect(() => {
		let cancelled = false;

		(async () => {
			try {
				const started = Date.now();
				const res = await fetch("/api/listings?pageSize=1", {
					method: "HEAD",
				});
				const header = res.headers.get("Date");
				if (!header || cancelled) return;

				const serverTime = Date.parse(header);
				if (Number.isNaN(serverTime)) return;

				// The Date header was generated somewhere inside the round trip.
				// Assuming the midpoint leaves at most half the round-trip time of
				// error, which is far below the one-second display granularity.
				const roundTrip = Date.now() - started;
				setOffsetMs(serverTime + roundTrip / 2 - Date.now());
			} catch {
				// An uncorrected clock is a worse countdown, not a broken one.
				// Falling back to local time beats failing to render.
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(id);
	}, []);

	return (
		<ClockContext.Provider value={{ now: now + offsetMs, offsetMs }}>
			{children}
		</ClockContext.Provider>
	);
}

/** Server-corrected current time, advancing once a second. */
export function useNow(): number {
	return useContext(ClockContext).now;
}

/** Exposed for diagnostics — how far this browser's clock is from the server's. */
export function useClockOffset(): number {
	return useContext(ClockContext).offsetMs;
}
