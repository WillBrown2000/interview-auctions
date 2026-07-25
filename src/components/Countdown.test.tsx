import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Listing } from "../types";
import { ClockProvider } from "../useNow";
import Countdown, { formatRemaining } from "./Countdown";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function listing(msFromNow: number, overrides: Partial<Listing> = {}): Listing {
	return {
		id: "listing-1",
		title: "2019 John Deere 8R 340 Tractor",
		description: "",
		category: "tractor",
		startingPrice: 100_000,
		currentBid: 100_000,
		currentBidder: null,
		status: "active",
		startsAt: new Date(0).toISOString(),
		endsAt: new Date(Date.now() + msFromNow).toISOString(),
		imageUrl: "",
		...overrides,
	};
}

function renderCountdown(l: Listing) {
	return render(
		<ClockProvider>
			<Countdown listing={l} />
		</ClockProvider>,
	);
}

describe("formatRemaining", () => {
	// The requirement is that the format for 3 days differs from 45 seconds.
	// Each band asserts both what it shows and what it deliberately omits.

	it("shows whole days when more than two days remain", () => {
		expect(formatRemaining(3 * DAY)).toBe("3 days left");
		expect(formatRemaining(6 * DAY + 13 * HOUR)).toBe("6 days left");
	});

	it("omits seconds at the day scale", () => {
		// Ticking seconds a week out is noise pretending to be information.
		expect(
			formatRemaining(3 * DAY + 14 * HOUR + 9 * MINUTE + 41 * SECOND),
		).toBe("3 days left");
	});

	it("adds hours between one and two days", () => {
		expect(formatRemaining(DAY + 14 * HOUR)).toBe("1d 14h left");
	});

	it("shows hours and minutes under a day", () => {
		expect(formatRemaining(6 * HOUR + 21 * MINUTE)).toBe("6h 21m left");
		expect(formatRemaining(HOUR)).toBe("1h 0m left");
	});

	it("shows minutes and seconds under an hour", () => {
		expect(formatRemaining(4 * MINUTE + 32 * SECOND)).toBe("4m 32s left");
	});

	it("pads seconds so the label does not change width every tick", () => {
		// An unpadded "4m 9s" is one character narrower than "4m 10s", which
		// shifts the layout once a second.
		expect(formatRemaining(4 * MINUTE + 9 * SECOND)).toBe("4m 09s left");
	});

	it("shows seconds alone under a minute", () => {
		expect(formatRemaining(45 * SECOND)).toBe("45s left");
		expect(formatRemaining(1 * SECOND)).toBe("1s left");
	});

	it("reads Ended at zero and below", () => {
		expect(formatRemaining(0)).toBe("Ended");
		expect(formatRemaining(-5 * SECOND)).toBe("Ended");
	});

	it("changes band exactly at each boundary", () => {
		expect(formatRemaining(2 * DAY)).toBe("2 days left");
		expect(formatRemaining(2 * DAY - 1)).toMatch(/^1d /);
		expect(formatRemaining(DAY)).toMatch(/^1d /);
		expect(formatRemaining(DAY - 1)).toMatch(/h .*m left$/);
		expect(formatRemaining(HOUR - 1)).toMatch(/^59m /);
		expect(formatRemaining(MINUTE)).toBe("1m 00s left");
		expect(formatRemaining(MINUTE - 1)).toBe("59s left");
	});
});

describe("Countdown", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the time remaining", () => {
		renderCountdown(listing(3 * DAY));
		expect(screen.getByText("3 days left")).toBeInTheDocument();
	});

	it("counts down without a reload", async () => {
		// The requirement that the countdown updates in real time.
		renderCountdown(listing(30 * SECOND));
		expect(screen.getByText("30s left")).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(5 * SECOND);
		});

		expect(screen.getByText("25s left")).toBeInTheDocument();
	});

	it("flips to Ended when the clock runs out, with no refetch", async () => {
		// The requirement that a finished auction reflects its closed state
		// without a reload. Nothing here talks to the server.
		renderCountdown(listing(3 * SECOND));
		expect(screen.getByText("3s left")).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(4 * SECOND);
		});

		expect(screen.getByText("Ended")).toBeInTheDocument();
	});

	it("marks the final minute as urgent", () => {
		const { container } = renderCountdown(listing(45 * SECOND));
		expect(container.querySelector(".countdown--urgent")).not.toBeNull();
	});

	it("does not mark a comfortable margin as urgent", () => {
		const { container } = renderCountdown(listing(2 * HOUR));
		expect(container.querySelector(".countdown--urgent")).toBeNull();
	});

	it("becomes urgent as it crosses into the last minute", async () => {
		const { container } = renderCountdown(listing(62 * SECOND));
		expect(container.querySelector(".countdown--urgent")).toBeNull();

		await act(async () => {
			vi.advanceTimersByTime(5 * SECOND);
		});

		expect(container.querySelector(".countdown--urgent")).not.toBeNull();
	});

	it("reads Ended for a closed listing whose end time has not arrived", () => {
		// A lot withdrawn early. Stored status wins over the clock.
		renderCountdown(listing(DAY, { status: "closed" }));
		expect(screen.getByText("Ended")).toBeInTheDocument();
	});

	it("reads Ended for a listing past its end time but still marked active", () => {
		// The unswept window: the server has not caught up, but the UI should
		// not be advertising a live auction.
		renderCountdown(listing(-HOUR, { status: "active" }));
		expect(screen.getByText("Ended")).toBeInTheDocument();
	});

	it("shares one interval across many countdowns", () => {
		// A timer per card leaks one interval for every card that unmounts
		// without cleaning up. The provider owns the only one.
		const spy = vi.spyOn(globalThis, "setInterval");

		render(
			<ClockProvider>
				{Array.from({ length: 6 }, (_, i) => (
					<Countdown key={i} listing={listing((i + 1) * HOUR)} />
				))}
			</ClockProvider>,
		);

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("clears its interval on unmount", () => {
		const spy = vi.spyOn(globalThis, "clearInterval");
		const { unmount } = renderCountdown(listing(HOUR));

		unmount();

		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
