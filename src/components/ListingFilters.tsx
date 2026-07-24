import { useEffect, useRef, useState } from "react";
import type { Category, Status } from "../types";

export interface Filters {
	q: string;
	category: Category | "";
	status: Status | "";
	sort: "endsAt" | "currentBid" | "title";
	order: "asc" | "desc";
}

interface Props {
	value: Filters;
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

export default function ListingFilters({ value, onChange }: Props) {
	// The text input is uncontrolled by the parent so that typing stays
	// responsive; only the debounced value is lifted up. The selects have no
	// such problem and report immediately.
	const [q, setQ] = useState(value.q);

	// Held in refs so the debounce effect depends on the query text alone.
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

	const activeSort =
		SORT_OPTIONS.findIndex(
			(o) => o.sort === value.sort && o.order === value.order,
		) ?? 0;

	const isFiltered = q !== "" || value.category !== "" || value.status !== "";

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
							setQ("");
							onChange({ ...value, q: "", category: "", status: "" });
						}}
					>
						Clear
					</button>
				)}
			</div>
		</div>
	);
}
