import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hasEnded, isPending, opensIn } from "../auction";
import type { Listing } from "../types";
import { ClockProvider } from "../useNow";
import ListingCard from "./ListingCard";
import ListingDetail from "./ListingDetail";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

function listing(overrides: Partial<Listing> = {}): Listing {
	return {
		id: "listing-1",
		title: "2023 Fendt 1050 Vario Tractor",
		description: "Catalogued for the upcoming sale.",
		category: "tractor",
		startingPrice: 415_000,
		currentBid: 415_000,
		currentBidder: null,
		status: "pending",
		startsAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
		endsAt: new Date(NOW + 96 * 60 * 60 * 1000).toISOString(),
		imageUrl: "",
		...overrides,
	};
}

describe("isPending", () => {
	it("is true for a pending listing whose start time is ahead", () => {
		expect(isPending(listing(), NOW)).toBe(true);
	});

	it("is false once the start time has passed", () => {
		// The window between a lot's start time arriving and the sweep opening
		// it. Both halves have to agree before the UI calls it open, but the
		// clock is what decides it is no longer *pending*.
		const started = listing({ startsAt: new Date(NOW - 1_000).toISOString() });
		expect(isPending(started, NOW)).toBe(false);
	});

	it("is false for an active listing", () => {
		expect(isPending(listing({ status: "active" }), NOW)).toBe(false);
	});

	it("is false for a closed listing", () => {
		expect(isPending(listing({ status: "closed" }), NOW)).toBe(false);
	});
});

describe("hasEnded and pending together", () => {
	it("does not report a pending listing as ended", () => {
		// The bug this guards: hasEnded treated anything not "active" as over,
		// so a lot that had not opened yet read "Ended" -- the opposite of the
		// truth, on the listing a buyer most needs to understand.
		expect(hasEnded(listing(), NOW)).toBe(false);
	});

	it("reports a pending listing whose end time somehow passed as ended", () => {
		const stale = listing({
			startsAt: new Date(NOW - 10_000).toISOString(),
			endsAt: new Date(NOW - 5_000).toISOString(),
		});
		expect(hasEnded(stale, NOW)).toBe(true);
	});
});

describe("opensIn", () => {
	it("counts down to the start time", () => {
		expect(opensIn(listing(), NOW)).toBe(2 * 60 * 60 * 1000);
	});

	it("is zero once bidding has opened", () => {
		const open = listing({ startsAt: new Date(NOW - 1_000).toISOString() });
		expect(opensIn(open, NOW)).toBe(0);
	});
});

function showCard(l: Listing) {
	return render(
		<ClockProvider>
			<ListingCard listing={l} isSelected={false} onClick={() => {}} />
		</ClockProvider>,
	);
}

function showDetail(l: Listing) {
	return render(
		<ClockProvider>
			<ListingDetail listing={l} onBidSuccess={() => {}} />
		</ClockProvider>,
	);
}

describe("a pending listing on a card", () => {
	const soon = () =>
		listing({ startsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() });

	it("counts down to when it opens, not when it closes", () => {
		showCard(soon());
		expect(screen.getByText(/opens in/i)).toBeInTheDocument();
	});

	it("is labelled as not open yet", () => {
		showCard(soon());
		expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
	});

	it("is not greyed out as if it had ended", () => {
		const { container } = showCard(soon());
		expect(container.querySelector(".listing-card--closed")).toBeNull();
		expect(screen.queryByText("Ended")).not.toBeInTheDocument();
	});
});

describe("a pending listing in the detail panel", () => {
	const soon = () =>
		listing({ startsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() });

	it("offers no bid form", () => {
		// The server refuses these bids, so putting inputs on screen only
		// invites someone to fill them in and be told no.
		showDetail(soon());
		expect(
			screen.queryByRole("button", { name: /submit bid/i }),
		).not.toBeInTheDocument();
	});

	it("says when it opens and what it opens at", () => {
		const { container } = showDetail(soon());
		const panel = container.querySelector(".auction-result") as HTMLElement;

		expect(panel.textContent).toMatch(/bidding not open yet/i);
		expect(panel.textContent).toMatch(/opens in/i);
		expect(panel.textContent).toContain("$415,000");
	});

	it("shows the opening time as its own field", () => {
		showDetail(soon());
		expect(screen.getByText(/bidding opens/i)).toBeInTheDocument();
	});

	it("badges it as pending rather than active or closed", () => {
		const { container } = showDetail(soon());
		expect(container.querySelector(".status-badge--pending")).not.toBeNull();
		expect(container.querySelector(".status-badge--closed")).toBeNull();
	});

	it("shows the auction result once it has opened and closed", () => {
		const done = listing({
			status: "closed",
			startsAt: new Date(Date.now() - 86_400_000).toISOString(),
			endsAt: new Date(Date.now() - 1_000).toISOString(),
			currentBidder: "Jane Smith",
			currentBid: 480_000,
		});

		const { container } = showDetail(done);
		const panel = container.querySelector(".auction-result") as HTMLElement;
		expect(panel.textContent).toMatch(/won by/i);
	});
});
