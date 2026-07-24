import { useCallback, useEffect, useState } from "react";
import { getListings } from "./api/listings";
import CreateListingForm from "./components/CreateListingForm";
import ListingCard from "./components/ListingCard";
import ListingDetail from "./components/ListingDetail";
import ListingFilters, { type Filters } from "./components/ListingFilters";
import type { Listing, PaginationMeta } from "./types";

// Small enough that paging is visible against the eight seeded listings.
const PAGE_SIZE = 6;

const EMPTY_FILTERS: Filters = {
	q: "",
	category: "",
	status: "",
	sort: "endsAt",
	order: "asc",
};

export default function App() {
	const [listings, setListings] = useState<Listing[]>([]);
	const [pagination, setPagination] = useState<PaginationMeta | null>(null);
	const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
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

					<ListingFilters value={filters} onChange={handleFiltersChange} />

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
