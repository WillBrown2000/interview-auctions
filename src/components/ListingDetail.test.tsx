import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Listing } from "../types";
import { ClockProvider } from "../useNow";
import ListingDetail from "./ListingDetail";

function listing(overrides: Partial<Listing> = {}): Listing {
	return {
		id: "listing-1",
		title: "2019 John Deere 8R 340 Tractor",
		description: "High-horsepower row-crop tractor.",
		category: "tractor",
		startingPrice: 50_000,
		currentBid: 52_000,
		currentBidder: "Jane Smith",
		status: "active",
		startsAt: new Date(0).toISOString(),
		endsAt: new Date(Date.now() + 86_400_000).toISOString(),
		imageUrl: "https://example.test/tractor.png",
		...overrides,
	};
}

function show(l: Listing) {
	return render(
		<ClockProvider>
			<ListingDetail listing={l} onBidSuccess={() => {}} />
		</ClockProvider>,
	);
}

describe("ListingDetail while an auction is live", () => {
	it("offers the bid form", () => {
		show(listing());
		expect(
			screen.getByRole("button", { name: /submit bid/i }),
		).toBeInTheDocument();
	});

	it("shows the current bid and who holds it", () => {
		show(listing());
		expect(screen.getByText("$52,000")).toBeInTheDocument();
		expect(screen.getByText("Jane Smith")).toBeInTheDocument();
		expect(screen.getByText(/current bidder/i)).toBeInTheDocument();
	});

	it("shows a live countdown", () => {
		show(listing());
		expect(screen.getByText(/time remaining/i)).toBeInTheDocument();
	});

	it("reads the status as active", () => {
		show(listing());
		expect(screen.getByText("active")).toBeInTheDocument();
	});
});

describe("ListingDetail once an auction has ended", () => {
	const ended = () =>
		listing({ endsAt: new Date(Date.now() - 1_000).toISOString() });

	it("removes the bid form rather than disabling it", () => {
		// The server refuses these bids. Leaving the inputs on screen invites
		// someone to fill them in and be told no.
		show(ended());
		expect(
			screen.queryByRole("button", { name: /submit bid/i }),
		).not.toBeInTheDocument();
	});

	it("shows who won and for how much", () => {
		const { container } = show(ended());
		const result = container.querySelector(".auction-result") as HTMLElement;

		expect(result).not.toBeNull();
		// Scoped to the result panel: the price also appears in the meta rows
		// above, so an unscoped query matches twice.
		expect(result.textContent).toMatch(/auction ended/i);
		expect(result.textContent).toMatch(/won by/i);
		expect(result.textContent).toContain("Jane Smith");
		expect(result.textContent).toContain("$52,000");
	});

	it("says so plainly when nobody bid", () => {
		// Distinct from a sale, and styled differently -- an unsold lot is a
		// different outcome, not a sale with a missing name.
		const { container } = show(
			listing({
				endsAt: new Date(Date.now() - 1_000).toISOString(),
				currentBidder: null,
			}),
		);

		expect(
			screen.getAllByText(/closed without any bids/i).length,
		).toBeGreaterThan(0);
		expect(container.querySelector(".auction-result--unsold")).not.toBeNull();
	});

	it("labels the bidder as the winner rather than the current holder", () => {
		show(ended());
		expect(screen.getByText(/winning bidder/i)).toBeInTheDocument();
		expect(screen.queryByText(/current bidder/i)).not.toBeInTheDocument();
	});

	it("hides the countdown", () => {
		show(ended());
		expect(screen.queryByText(/time remaining/i)).not.toBeInTheDocument();
	});

	it("shows closed on the badge even while the row still says active", () => {
		// The unswept window. Showing "active" beside a finished auction is
		// what prompted deriving this rather than trusting the stored field.
		const { container } = show(
			listing({
				status: "active",
				startsAt: new Date(0).toISOString(),
				endsAt: new Date(Date.now() - 1_000).toISOString(),
			}),
		);

		expect(container.querySelector(".status-badge--closed")).not.toBeNull();
		expect(container.querySelector(".status-badge--active")).toBeNull();
	});

	it("treats a listing the server closed early as ended", () => {
		show(listing({ status: "closed" }));
		expect(
			screen.queryByRole("button", { name: /submit bid/i }),
		).not.toBeInTheDocument();
	});
});
