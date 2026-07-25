import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Listing } from "../types";
import { ClockProvider } from "../useNow";
import ListingCard from "./ListingCard";

function listing(overrides: Partial<Listing> = {}): Listing {
	return {
		id: "listing-1",
		title: "2019 John Deere 8R 340 Tractor",
		description: "",
		category: "tractor",
		startingPrice: 50_000,
		currentBid: 52_000,
		currentBidder: "Jane Smith",
		status: "active",
		startsAt: new Date(0).toISOString(),
		// Three days plus an hour: exactly three days would tick down to
		// "2 days left" in the milliseconds before the assertion runs.
		endsAt: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
		imageUrl: "https://example.test/tractor.png",
		...overrides,
	};
}

function show(
	l: Listing,
	props: { isSelected?: boolean; onClick?: () => void } = {},
) {
	return render(
		<ClockProvider>
			<ListingCard
				listing={l}
				isSelected={props.isSelected ?? false}
				onClick={props.onClick ?? (() => {})}
			/>
		</ClockProvider>,
	);
}

describe("ListingCard", () => {
	it("shows the title, category and current bid", () => {
		show(listing());
		expect(screen.getByText(/john deere/i)).toBeInTheDocument();
		expect(screen.getByText("tractor")).toBeInTheDocument();
		expect(screen.getByText("$52,000")).toBeInTheDocument();
	});

	it("shows the time remaining", () => {
		show(listing());
		expect(screen.getByText("3 days left")).toBeInTheDocument();
	});

	it("marks itself selected", () => {
		const { container } = show(listing(), { isSelected: true });
		expect(container.querySelector(".listing-card--selected")).not.toBeNull();
	});

	it("responds to a click", async () => {
		const onClick = vi.fn();
		const user = userEvent.setup();
		show(listing(), { onClick });

		await user.click(screen.getByRole("button"));

		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("responds to the Enter key", async () => {
		// It's a div with role=button, so keyboard support is not free.
		const onClick = vi.fn();
		const user = userEvent.setup();
		show(listing(), { onClick });

		screen.getByRole("button").focus();
		await user.keyboard("{Enter}");

		expect(onClick).toHaveBeenCalledTimes(1);
	});

	describe("ended styling", () => {
		it("greys out a listing the server has closed", () => {
			const { container } = show(listing({ status: "closed" }));
			expect(container.querySelector(".listing-card--closed")).not.toBeNull();
			expect(screen.getByText("Ended")).toBeInTheDocument();
		});

		it("greys out a listing past its end time but still marked active", () => {
			// The bug: this used to key off stored status alone, so an unswept
			// auction read "Ended" in the corner while keeping the full styling
			// of a live lot.
			const { container } = show(
				listing({
					status: "active",
					startsAt: new Date(0).toISOString(),
					endsAt: new Date(Date.now() - 1_000).toISOString(),
				}),
			);

			expect(container.querySelector(".listing-card--closed")).not.toBeNull();
			expect(screen.getByText("Ended")).toBeInTheDocument();
		});

		it("leaves a live listing ungreyed", () => {
			const { container } = show(listing());
			expect(container.querySelector(".listing-card--closed")).toBeNull();
		});
	});
});
