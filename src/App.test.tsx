import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Listing } from "./types";
import { ClockProvider } from "./useNow";

/** Minimal EventSource stand-in — jsdom has none. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	onopen: (() => void) | null = null;
	listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
	closed = false;

	constructor(public url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, h: (e: MessageEvent) => void) {
		(this.listeners[type] ??= []).push(h);
	}
	removeEventListener(type: string, h: (e: MessageEvent) => void) {
		this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== h);
	}
	close() {
		this.closed = true;
	}
	emit(type: string, data: unknown) {
		const e = { data: JSON.stringify(data) } as MessageEvent;
		for (const h of this.listeners[type] ?? []) h(e);
	}
	static latest() {
		return FakeEventSource.instances[FakeEventSource.instances.length - 1];
	}
}

function listing(n: number, overrides: Partial<Listing> = {}): Listing {
	return {
		id: `listing-${n}`,
		title: `Tractor ${n}`,
		description: `Description ${n}`,
		category: "tractor",
		startingPrice: 10_000 * n,
		currentBid: 10_000 * n,
		currentBidder: null,
		status: "active",
		startsAt: new Date(0).toISOString(),
		endsAt: new Date(Date.now() + n * 3_600_000).toISOString(),
		imageUrl: "",
		...overrides,
	};
}

/** Serves listings, and records what was asked for. */
function serve(listings: Listing[], totalOverride?: number) {
	const requests: URLSearchParams[] = [];

	const fn = vi.fn(async (url: unknown, init?: unknown) => {
		const href = String(url);

		if (init && (init as RequestInit).method === "POST") {
			return {
				ok: true,
				status: 201,
				headers: new Headers(),
				json: async () => ({ ...listings[0], currentBid: 99_999 }),
			};
		}

		const query = new URLSearchParams(href.split("?")[1] ?? "");
		requests.push(query);

		const pageSize = Number(query.get("pageSize") ?? 20);
		const page = Number(query.get("page") ?? 1);
		const start = (page - 1) * pageSize;
		const slice = listings.slice(start, start + pageSize);
		const total = totalOverride ?? listings.length;

		return {
			ok: true,
			status: 200,
			headers: new Headers({ Date: new Date().toUTCString() }),
			json: async () => ({
				data: slice,
				pagination: {
					page,
					pageSize,
					totalItems: total,
					totalPages: Math.ceil(total / pageSize),
					hasMore: start + slice.length < total,
				},
			}),
		};
	});

	vi.stubGlobal("fetch", fn);
	return { fn, requests };
}

function show() {
	return render(
		<ClockProvider>
			<App />
		</ClockProvider>,
	);
}

beforeEach(() => {
	FakeEventSource.instances = [];
	vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("App", () => {
	it("loads and lists auctions", async () => {
		serve([listing(1), listing(2)]);
		show();

		expect(await screen.findByText("Tractor 1")).toBeInTheDocument();
		expect(screen.getByText("Tractor 2")).toBeInTheDocument();
	});

	it("defaults to live auctions rather than everything", async () => {
		// Sorting by end date ascending puts the longest-expired lots first, so
		// an unfiltered landing page was a wall of finished auctions.
		const { requests } = serve([listing(1)]);
		show();

		await screen.findByText("Tractor 1");
		expect(requests[0].get("status")).toBe("active");
		expect(requests[0].get("sort")).toBe("endsAt");
	});

	it("surfaces a load failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 500,
				headers: new Headers(),
				json: async () => ({ error: "Database unavailable" }),
			})),
		);
		show();

		expect(
			await screen.findByText(/database unavailable/i),
		).toBeInTheDocument();
	});

	it("says so when nothing matches", async () => {
		serve([]);
		show();

		expect(await screen.findByText(/no listings match/i)).toBeInTheDocument();
	});

	describe("selection", () => {
		it("opens a listing's detail", async () => {
			const user = userEvent.setup();
			serve([listing(1), listing(2)]);
			show();

			await user.click(await screen.findByText("Tractor 1"));

			const detail = document.querySelector(".listing-detail") as HTMLElement;
			expect(within(detail).getByText("Tractor 1")).toBeInTheDocument();
		});

		it("keeps the selection when the page turns", async () => {
			// The selection can live on a page that is no longer loaded. Looking
			// it up by id in the current page blanked the panel on a page turn.
			const user = userEvent.setup();
			serve(Array.from({ length: 12 }, (_, i) => listing(i + 1)));
			show();

			await user.click(await screen.findByText("Tractor 1"));
			await user.click(screen.getByRole("button", { name: /next/i }));

			await waitFor(() =>
				expect(screen.getByText("Tractor 7")).toBeInTheDocument(),
			);
			const detail = document.querySelector(".listing-detail") as HTMLElement;
			expect(within(detail).getByText("Tractor 1")).toBeInTheDocument();
		});
	});

	describe("pagination", () => {
		it("reports the page count", async () => {
			serve(Array.from({ length: 12 }, (_, i) => listing(i + 1)));
			show();

			expect(await screen.findByText(/page 1 of 2/i)).toBeInTheDocument();
			expect(screen.getByText(/12 listings/i)).toBeInTheDocument();
		});

		it("disables Prev on the first page", async () => {
			serve(Array.from({ length: 12 }, (_, i) => listing(i + 1)));
			show();

			await screen.findByText("Tractor 1");
			expect(screen.getByRole("button", { name: /prev/i })).toBeDisabled();
		});

		it("disables Next on the last page", async () => {
			const user = userEvent.setup();
			serve(Array.from({ length: 12 }, (_, i) => listing(i + 1)));
			show();

			await screen.findByText("Tractor 1");
			await user.click(screen.getByRole("button", { name: /next/i }));

			await waitFor(() =>
				expect(screen.getByRole("button", { name: /next/i })).toBeDisabled(),
			);
		});

		it("returns to page one when a filter changes", async () => {
			// Staying on page 3 of a result set that now has one page shows an
			// empty list.
			const user = userEvent.setup();
			const { requests } = serve(
				Array.from({ length: 12 }, (_, i) => listing(i + 1)),
			);
			show();

			await screen.findByText("Tractor 1");
			await user.click(screen.getByRole("button", { name: /next/i }));
			await waitFor(() =>
				expect(screen.getByText("Tractor 7")).toBeInTheDocument(),
			);

			await user.selectOptions(
				screen.getByLabelText(/filter by category/i),
				"combine",
			);

			await waitFor(() => {
				const last = requests[requests.length - 1];
				expect(last.get("category")).toBe("combine");
				expect(last.get("page")).toBe("1");
			});
		});
	});

	describe("filters", () => {
		it("sends a category filter", async () => {
			const user = userEvent.setup();
			const { requests } = serve([listing(1)]);
			show();

			await screen.findByText("Tractor 1");
			await user.selectOptions(
				screen.getByLabelText(/filter by category/i),
				"combine",
			);

			await waitFor(() =>
				expect(requests[requests.length - 1].get("category")).toBe("combine"),
			);
		});

		it("sends price bounds", async () => {
			const user = userEvent.setup();
			const { requests } = serve([listing(1)]);
			show();

			await screen.findByText("Tractor 1");
			await user.type(screen.getByLabelText(/minimum price/i), "50000");

			await waitFor(
				() =>
					expect(requests[requests.length - 1].get("minPrice")).toBe("50000"),
				{ timeout: 2_000 },
			);
		});

		it("debounces the search box instead of firing per keystroke", async () => {
			const user = userEvent.setup();
			const { requests } = serve([listing(1)]);
			show();

			await screen.findByText("Tractor 1");
			const before = requests.length;
			await user.type(screen.getByLabelText(/search listings/i), "deere");

			await waitFor(() => expect(requests.length).toBeGreaterThan(before), {
				timeout: 2_000,
			});
			// Five characters, nowhere near five requests.
			expect(requests.length - before).toBeLessThan(5);
		});

		it("warns rather than sending an impossible price range", async () => {
			const user = userEvent.setup();
			serve([listing(1)]);
			show();

			await screen.findByText("Tractor 1");
			await user.type(screen.getByLabelText(/minimum price/i), "100");
			await user.type(screen.getByLabelText(/maximum price/i), "5");

			expect(
				await screen.findByText(/minimum price is above the maximum/i),
			).toBeInTheDocument();
		});
	});

	describe("realtime updates", () => {
		it("applies another bidder's bid to the list", async () => {
			serve([listing(1)]);
			show();
			await screen.findByText("Tractor 1");

			act(() =>
				FakeEventSource.latest().emit("bid", {
					type: "bid",
					listingId: "listing-1",
					currentBid: 88_000,
					currentBidder: "Rival",
					placedAt: new Date().toISOString(),
				}),
			);

			expect(await screen.findByText("$88,000")).toBeInTheDocument();
		});

		it("closes a listing when the server says it expired", async () => {
			serve([listing(1)]);
			show();
			await screen.findByText("Tractor 1");

			act(() =>
				FakeEventSource.latest().emit("closed", {
					type: "closed",
					listingId: "listing-1",
					endsAt: new Date(Date.now() - 1_000).toISOString(),
				}),
			);

			await waitFor(() =>
				expect(document.querySelector(".listing-card--closed")).not.toBeNull(),
			);
		});

		it("reopens a listing on an updated event", async () => {
			// The only event that can move a listing back to active.
			serve([
				listing(1, {
					status: "closed",
					startsAt: new Date(0).toISOString(),
					endsAt: new Date(Date.now() - 1_000).toISOString(),
				}),
			]);
			show();
			await screen.findByText("Tractor 1");

			act(() =>
				FakeEventSource.latest().emit("updated", {
					type: "updated",
					listingId: "listing-1",
					status: "active",
					startsAt: new Date(0).toISOString(),
					endsAt: new Date(Date.now() + 60_000).toISOString(),
					currentBid: 25_000,
					currentBidder: null,
				}),
			);

			await waitFor(() =>
				expect(document.querySelector(".listing-card--closed")).toBeNull(),
			);
		});

		it("ignores events for listings it isn't showing", async () => {
			// The stream is global so off-screen auctions stay current; there is
			// nothing to do for a lot that isn't rendered.
			serve([listing(1)]);
			show();
			await screen.findByText("Tractor 1");

			expect(() =>
				act(() =>
					FakeEventSource.latest().emit("bid", {
						type: "bid",
						listingId: "some-other-listing",
						currentBid: 1,
						currentBidder: "Nobody",
						placedAt: new Date().toISOString(),
					}),
				),
			).not.toThrow();

			expect(screen.getByText("$10,000")).toBeInTheDocument();
		});

		it("updates the open detail panel too", async () => {
			const user = userEvent.setup();
			serve([listing(1)]);
			show();

			await user.click(await screen.findByText("Tractor 1"));

			act(() =>
				FakeEventSource.latest().emit("bid", {
					type: "bid",
					listingId: "listing-1",
					currentBid: 88_000,
					currentBidder: "Rival",
					placedAt: new Date().toISOString(),
				}),
			);

			const detail = document.querySelector(".listing-detail") as HTMLElement;
			await waitFor(() =>
				expect(within(detail).getByText("Rival")).toBeInTheDocument(),
			);
		});

		it("refetches after the stream reconnects", async () => {
			// Events during a disconnect are lost; refetching closes the gap.
			const { requests } = serve([listing(1)]);
			show();
			await screen.findByText("Tractor 1");

			const before = requests.length;
			act(() => FakeEventSource.latest().onopen?.());
			act(() => FakeEventSource.latest().onopen?.());

			await waitFor(() => expect(requests.length).toBeGreaterThan(before));
		});
	});

	describe("creating a listing", () => {
		it("opens the form", async () => {
			const user = userEvent.setup();
			serve([listing(1)]);
			show();
			await screen.findByText("Tractor 1");

			await user.click(screen.getByRole("button", { name: /\+ new/i }));

			expect(screen.getByText(/new listing/i)).toBeInTheDocument();
		});
	});
});
