import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Listing } from "../types";
import BidForm from "./BidForm";

const listing: Listing = {
	id: "listing-1",
	title: "2019 John Deere 8R 340 Tractor",
	description: "",
	category: "tractor",
	startingPrice: 50_000,
	currentBid: 50_000,
	currentBidder: null,
	status: "active",
	startsAt: new Date(0).toISOString(),
	endsAt: new Date(Date.now() + 86_400_000).toISOString(),
	imageUrl: "",
};

function mockFetch(response: { ok?: boolean; body?: unknown }) {
	// Declared with fetch's signature so mock.calls is typed [url, init]
	// rather than an empty tuple.
	const fn = vi.fn(async (_url?: unknown, _init?: unknown) => ({
		ok: response.ok ?? true,
		status: response.ok === false ? 400 : 201,
		json: async () => response.body ?? {},
	}));
	vi.stubGlobal("fetch", fn);
	return fn;
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("BidForm", () => {
	it("submits the bidder and amount", async () => {
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: { ...listing, currentBid: 52_000 } });
		render(<BidForm listing={listing} onBidSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/your name/i), "Jane Smith");
		await user.type(screen.getByLabelText(/bid amount/i), "52000");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({
			bidder: "Jane Smith",
			amount: 52_000,
		});
	});

	it("clears the form after a successful bid without throwing", async () => {
		// The task-0 regression. `e.currentTarget.reset()` ran after an awaited
		// fetch, by which point React had nulled currentTarget -- so a
		// *successful* bid threw a TypeError and the form never cleared.
		const user = userEvent.setup();
		mockFetch({ body: { ...listing, currentBid: 52_000 } });
		const errors: unknown[] = [];
		vi.spyOn(console, "error").mockImplementation((e) => errors.push(e));

		render(<BidForm listing={listing} onBidSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/your name/i), "Jane Smith");
		await user.type(screen.getByLabelText(/bid amount/i), "52000");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		await waitFor(() =>
			expect(screen.getByLabelText(/your name/i)).toHaveValue(""),
		);
		expect(screen.getByLabelText(/bid amount/i)).toHaveValue(null);
		expect(errors).toHaveLength(0);
	});

	it("reports the updated listing to its parent", async () => {
		const user = userEvent.setup();
		const updated = { ...listing, currentBid: 52_000, currentBidder: "Jane" };
		mockFetch({ body: updated });
		const onBidSuccess = vi.fn();

		render(<BidForm listing={listing} onBidSuccess={onBidSuccess} />);

		await user.type(screen.getByLabelText(/your name/i), "Jane");
		await user.type(screen.getByLabelText(/bid amount/i), "52000");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		await waitFor(() => expect(onBidSuccess).toHaveBeenCalledWith(updated));
	});

	it("shows the server's rejection message", async () => {
		const user = userEvent.setup();
		mockFetch({
			ok: false,
			body: { error: "Bid must be greater than the current bid of $50,000" },
		});

		render(<BidForm listing={listing} onBidSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/your name/i), "Lowballer");
		await user.type(screen.getByLabelText(/bid amount/i), "100");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		expect(
			await screen.findByText(/greater than the current bid/i),
		).toBeInTheDocument();
	});

	it("validates before hitting the network", async () => {
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: {} });

		render(<BidForm listing={listing} onBidSuccess={() => {}} />);
		await user.type(screen.getByLabelText(/bid amount/i), "52000");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a missing amount without hitting the network", async () => {
		// A blank amount rather than a zero: the input carries min={1}, so a
		// zero is stopped by the browser's own validation before the handler
		// ever runs, and the test would be asserting on the wrong mechanism.
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: {} });

		render(<BidForm listing={listing} onBidSuccess={() => {}} />);
		await user.type(screen.getByLabelText(/your name/i), "Jane");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		expect(await screen.findByText(/valid bid amount/i)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("suggests an amount above the current bid", () => {
		render(<BidForm listing={listing} onBidSuccess={() => {}} />);
		expect(screen.getByLabelText(/bid amount/i)).toHaveAttribute(
			"placeholder",
			expect.stringContaining("51,000"),
		);
	});

	describe("when the price moves while composing", () => {
		it("says so instead of silently changing anything", async () => {
			const { rerender } = render(
				<BidForm listing={listing} onBidSuccess={() => {}} />,
			);
			expect(screen.queryByText(/current bid moved/i)).not.toBeInTheDocument();

			rerender(
				<BidForm
					listing={{ ...listing, currentBid: 60_000, currentBidder: "Rival" }}
					onBidSuccess={() => {}}
				/>,
			);

			expect(screen.getByText(/current bid moved to/i)).toBeInTheDocument();
			expect(screen.getByText(/60,000/)).toBeInTheDocument();
		});

		it("leaves what the user typed alone", async () => {
			// The important one. Rewriting the field under the cursor is how
			// somebody submits $61,000 having decided on $52,000.
			const user = userEvent.setup();
			const { rerender } = render(
				<BidForm listing={listing} onBidSuccess={() => {}} />,
			);

			await user.type(screen.getByLabelText(/bid amount/i), "52000");

			rerender(
				<BidForm
					listing={{ ...listing, currentBid: 60_000, currentBidder: "Rival" }}
					onBidSuccess={() => {}}
				/>,
			);

			expect(screen.getByLabelText(/bid amount/i)).toHaveValue(52_000);
		});

		it("fills the amount in only when the user asks", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<BidForm listing={listing} onBidSuccess={() => {}} />,
			);

			rerender(
				<BidForm
					listing={{ ...listing, currentBid: 60_000, currentBidder: "Rival" }}
					onBidSuccess={() => {}}
				/>,
			);

			await user.click(screen.getByRole("button", { name: /bid \$61,000/i }));

			expect(screen.getByLabelText(/bid amount/i)).toHaveValue(61_000);
			expect(screen.queryByText(/current bid moved/i)).not.toBeInTheDocument();
		});

		it("stays quiet when the price has not moved", () => {
			const { rerender } = render(
				<BidForm listing={listing} onBidSuccess={() => {}} />,
			);
			rerender(
				<BidForm
					listing={{ ...listing, title: "Renamed" }}
					onBidSuccess={() => {}}
				/>,
			);

			expect(screen.queryByText(/current bid moved/i)).not.toBeInTheDocument();
		});

		it("resets when a different listing is selected", () => {
			// The previous listing's price is meaningless against a new auction.
			const { rerender } = render(
				<BidForm listing={listing} onBidSuccess={() => {}} />,
			);

			rerender(
				<BidForm
					listing={{ ...listing, id: "listing-2", currentBid: 90_000 }}
					onBidSuccess={() => {}}
				/>,
			);

			expect(screen.queryByText(/current bid moved/i)).not.toBeInTheDocument();
		});
	});

	it("disables its controls while submitting", async () => {
		const user = userEvent.setup();
		let release: (v: unknown) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				() =>
					new Promise((resolve) => {
						release = () => resolve({ ok: true, json: async () => listing });
					}),
			),
		);

		render(<BidForm listing={listing} onBidSuccess={() => {}} />);
		await user.type(screen.getByLabelText(/your name/i), "Jane");
		await user.type(screen.getByLabelText(/bid amount/i), "52000");
		await user.click(screen.getByRole("button", { name: /submit bid/i }));

		expect(
			await screen.findByRole("button", { name: /submitting/i }),
		).toBeDisabled();

		release(null);
	});
});
