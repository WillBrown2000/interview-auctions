import { useEffect, useRef, useState } from "react";
import type { Category, Status } from "../types";

export interface Filters {
	q: string;
	category: Category | "";
	status: Status | "";
	/** Raw input text; "" means no bound. */
	minPrice: string;
	maxPrice: string;
	sort: "endsAt" | "currentBid" | "title";
	order: "asc" | "desc";
}

interface Props {
	value: Filters;
	/** What "Clear" returns to, and what counts as unfiltered. */
	defaults: Filters;
	onChange: (next: Filters) => void;
}

const CATEGORIES: Category[] = [
	"tractor",
	"combine",
	"implement",
	"attachment",
];
const STATUSES: Status[] = ["active", "closed", "pending"];

// Sort field and direction are one control in the UI. "Ending soonest" is a
// concept a bidder has; "endsAt, ascending" is not.
const SORT_OPTIONS: {
	label: string;
	sort: Filters["sort"];
	order: Filters["order"];
}[] = [
	{ label: "Ending soonest", sort: "endsAt", order: "asc" },
	{ label: "Ending latest", sort: "endsAt", order: "desc" },
	{ label: "Price: low to high", sort: "currentBid", order: "asc" },
	{ label: "Price: high to low", sort: "currentBid", order: "desc" },
	{ label: "Title A–Z", sort: "title", order: "asc" },
];

const SEARCH_DEBOUNCE_MS = 300;

export default function ListingFilters({ value, defaults, onChange }: Props) {
	// The text input is uncontrolled by the parent so that typing stays
	// responsive; only the debounced value is lifted up. The selects have no
	// such problem and report immediately.
	const [q, setQ] = useState(value.q);

	// Price bounds debounce for the same reason as the search box: each digit
	// typed into "50000" would otherwise be five requests, four of them for
	// prices the user never meant.
	const [minPrice, setMinPrice] = useState(value.minPrice);
	const [maxPrice, setMaxPrice] = useState(value.maxPrice);

	// Held in refs so the debounce effects depend on the typed text alone.
	// Depending on `value` or `onChange` directly would restart the timer on
	// every parent render and the search would never fire.
	const onChangeRef = useRef(onChange);
	const valueRef = useRef(value);
	onChangeRef.current = onChange;
	valueRef.current = value;

	useEffect(() => {
		if (q === valueRef.current.q) return;
		const timer = setTimeout(() => {
			onChangeRef.current({ ...valueRef.current, q });
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [q]);

	useEffect(() => {
		if (
			minPrice === valueRef.current.minPrice &&
			maxPrice === valueRef.current.maxPrice
		) {
			return;
		}
		const timer = setTimeout(() => {
			onChangeRef.current({ ...valueRef.current, minPrice, maxPrice });
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [minPrice, maxPrice]);

	// The server rejects minPrice > maxPrice with a 400 rather than quietly
	// returning nothing. Catching it here means the user sees what's wrong
	// against the inputs instead of an error banner over the results.
	const invalidRange =
		minPrice !== "" && maxPrice !== "" && Number(minPrice) > Number(maxPrice);

	const activeSort =
		SORT_OPTIONS.findIndex(
			(o) => o.sort === value.sort && o.order === value.order,
		) ?? 0;

	// Measured against the defaults, not against empty. The status filter starts
	// at "active", so it is not evidence that the user narrowed anything.
	const isFiltered =
		q !== defaults.q ||
		value.category !== defaults.category ||
		value.status !== defaults.status ||
		minPrice !== defaults.minPrice ||
		maxPrice !== defaults.maxPrice;

	return (
		<div className="filters">
			<input
				type="search"
				className="filters__search"
				placeholder="Search title or description…"
				value={q}
				onChange={(e) => setQ(e.target.value)}
				aria-label="Search listings"
			/>

			<div className="filters__row">
				<select
					className="filters__select"
					value={value.category}
					onChange={(e) =>
						onChange({ ...value, category: e.target.value as Category | "" })
					}
					aria-label="Filter by category"
				>
					<option value="">All categories</option>
					{CATEGORIES.map((c) => (
						<option key={c} value={c}>
							{c}
						</option>
					))}
				</select>

				<select
					className="filters__select"
					value={value.status}
					onChange={(e) =>
						onChange({ ...value, status: e.target.value as Status | "" })
					}
					aria-label="Filter by status"
				>
					<option value="">Any status</option>
					{STATUSES.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
			</div>

			<div className="filters__row">
				<input
					type="number"
					className={`filters__price ${invalidRange ? "filters__price--invalid" : ""}`}
					placeholder="Min $"
					value={minPrice}
					min={0}
					step={500}
					onChange={(e) => setMinPrice(e.target.value)}
					aria-label="Minimum price"
				/>
				<span className="filters__price-sep">–</span>
				<input
					type="number"
					className={`filters__price ${invalidRange ? "filters__price--invalid" : ""}`}
					placeholder="Max $"
					value={maxPrice}
					min={0}
					step={500}
					onChange={(e) => setMaxPrice(e.target.value)}
					aria-label="Maximum price"
				/>
			</div>

			{invalidRange && (
				<div className="filters__hint">Minimum price is above the maximum.</div>
			)}

			<div className="filters__row">
				<select
					className="filters__select"
					value={activeSort}
					onChange={(e) => {
						const option = SORT_OPTIONS[Number(e.target.value)];
						onChange({ ...value, sort: option.sort, order: option.order });
					}}
					aria-label="Sort listings"
				>
					{SORT_OPTIONS.map((o, i) => (
						<option key={o.label} value={i}>
							{o.label}
						</option>
					))}
				</select>

				{isFiltered && (
					<button
						type="button"
						className="filters__clear"
						onClick={() => {
							setQ(defaults.q);
							setMinPrice(defaults.minPrice);
							setMaxPrice(defaults.maxPrice);
							// Sort is left as the user set it — clearing filters is
							// about narrowing, not about how results are ordered.
							onChange({
								...value,
								q: defaults.q,
								category: defaults.category,
								status: defaults.status,
								minPrice: defaults.minPrice,
								maxPrice: defaults.maxPrice,
							});
						}}
					>
						Clear
					</button>
				)}
			</div>
		</div>
	);
}
