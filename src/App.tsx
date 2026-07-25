import { useCallback, useEffect, useState } from "react";
import { getListings } from "./api/listings";
import CreateListingForm from "./components/CreateListingForm";
import ListingCard from "./components/ListingCard";
import ListingDetail from "./components/ListingDetail";
import ListingFilters, { type Filters } from "./components/ListingFilters";
import type { Listing, PaginationMeta } from "./types";
import { type AuctionEvent, useAuctionEvents } from "./useAuctionEvents";

// Small enough that paging is visible against the eight seeded listings.
const PAGE_SIZE = 6;

/**
 * Live auctions, soonest to close, first.
 *
 * status defaults to "active" rather than "any" because sorting by end date
 * ascending puts the *longest*-expired lots at the front — so an unfiltered
 * landing page was six auctions that closed months ago. Someone arriving at an
 * auction site wants what they can still bid on.
 *
 * Filtering rather than reordering keeps this a UI default: the API still
 * returns everything, and "Any status" is one click away. The alternative —
 * ranking ended lots last inside the default sort — pushes a display decision
 * into the query and makes the endpoint's ordering harder to state.
 */
const DEFAULT_FILTERS: Filters = {
	q: "",
	category: "",
	status: "active",
	minPrice: "",
	maxPrice: "",
	sort: "endsAt",
	order: "asc",
};

export default function App() {
	const [listings, setListings] = useState<Listing[]>([]);
	const [pagination, setPagination] = useState<PaginationMeta | null>(null);
	const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
	const [page, setPage] = useState(1);

	// The selected listing is held as a whole object, not looked up by id in
	// `listings`. Once the list is paginated the selection can live on a page
	// that isn't loaded, and an id lookup would blank the detail panel the
	// moment you turned the page.
	const [selected, setSelected] = useState<Listing | null>(null);

	const [showCreateForm, setShowCreateForm] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await getListings({
				...filters,
				page,
				pageSize: PAGE_SIZE,
			});
			setListings(result.data);
			setPagination(result.pagination);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load listings");
			setListings([]);
			setPagination(null);
		} finally {
			setLoading(false);
		}
	}, [filters, page]);

	useEffect(() => {
		load();
	}, [load]);

	// Any change to the filters invalidates the current page number -- staying
	// on page 3 of a result set that now has one page shows an empty list.
	const handleFiltersChange = (next: Filters) => {
		setFilters(next);
		setPage(1);
	};

	/**
	 * Applies a server push to whatever this client is holding.
	 *
	 * Patching in place rather than refetching. A refetch on every bid would
	 * reorder the page under the user when sorted by price, and could move the
	 * listing they're reading onto a different page entirely. The event carries
	 * everything needed to update the row.
	 *
	 * Listings the client doesn't have are ignored: the stream is global so
	 * that auctions off-screen stay current, but nothing needs doing for a lot
	 * that isn't rendered.
	 */
	const applyEvent = useCallback((event: AuctionEvent) => {
		const patch = (listing: Listing): Listing => {
			if (listing.id !== event.listingId) return listing;

			switch (event.type) {
				case "bid":
					return {
						...listing,
						currentBid: event.currentBid,
						currentBidder: event.currentBidder,
					};
				case "closed":
					return { ...listing, status: "closed", endsAt: event.endsAt };
				case "updated":
					// Carries the whole mutable surface, so this is the one case
					// that can move a listing back to active with a new deadline.
					return {
						...listing,
						status: event.status,
						endsAt: event.endsAt,
						currentBid: event.currentBid,
						currentBidder: event.currentBidder,
					};
			}
		};

		setListings((prev) => prev.map(patch));
		setSelected((prev) => (prev ? patch(prev) : prev));
	}, []);

	useAuctionEvents({
		onEvent: applyEvent,
		// Events during a disconnect are lost. Refetching is cheaper than
		// server-side replay and correct no matter how long the gap was.
		onReconnect: () => load(),
	});

	const handleBidSuccess = (updated: Listing) => {
		setListings((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
		setSelected((prev) => (prev?.id === updated.id ? updated : prev));
	};

	const handleListingCreated = (listing: Listing) => {
		setSelected(listing);
		setShowCreateForm(false);
		// Refetch rather than splicing it in: where the new listing falls
		// depends on the active sort and filters, which is the server's call.
		setPage(1);
		load();
	};

	const totalPages = pagination?.totalPages ?? 0;

	return (
		<div className="app">
			<header className="app-header">
				<h1>Interview Auctions</h1>
				<p className="app-header__subtitle">Farm Equipment Marketplace</p>
			</header>
			<div className="app-body">
				<aside className="panel panel--left">
					<div className="panel__heading-row">
						<h2 className="panel__heading">Listings</h2>
						<button
							type="button"
							className="panel__heading-action"
							onClick={() => {
								setShowCreateForm(true);
								setSelected(null);
							}}
						>
							+ New
						</button>
					</div>

					<ListingFilters
						value={filters}
						defaults={DEFAULT_FILTERS}
						onChange={handleFiltersChange}
					/>

					{error && (
						<div className="state-message state-message--error">{error}</div>
					)}
					{loading && <div className="state-message">Loading listings…</div>}
					{!loading && !error && listings.length === 0 && (
						<div className="state-message">
							No listings match those filters.
						</div>
					)}
					{!loading && !error && listings.length > 0 && (
						<div className="listing-grid">
							{listings.map((listing) => (
								<ListingCard
									key={listing.id}
									listing={listing}
									isSelected={listing.id === selected?.id}
									onClick={() => {
										setSelected(listing);
										setShowCreateForm(false);
									}}
								/>
							))}
						</div>
					)}

					{pagination && pagination.totalItems > 0 && (
						<div className="pager">
							<button
								type="button"
								className="pager__button"
								onClick={() => setPage((p) => p - 1)}
								disabled={page <= 1 || loading}
							>
								← Prev
							</button>
							<span className="pager__status">
								Page {pagination.page} of {totalPages}
								<span className="pager__count">
									{pagination.totalItems} listing
									{pagination.totalItems === 1 ? "" : "s"}
								</span>
							</span>
							<button
								type="button"
								className="pager__button"
								onClick={() => setPage((p) => p + 1)}
								disabled={!pagination.hasMore || loading}
							>
								Next →
							</button>
						</div>
					)}
				</aside>
				<main className="panel panel--right">
					{showCreateForm ? (
						<CreateListingForm onSuccess={handleListingCreated} />
					) : selected ? (
						<ListingDetail listing={selected} onBidSuccess={handleBidSuccess} />
					) : (
						<div className="empty-state">
							<p>Select a listing to view details and place a bid.</p>
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
