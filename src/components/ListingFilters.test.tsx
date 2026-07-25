import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ListingFilters, { type Filters } from "./ListingFilters";

const DEFAULTS: Filters = {
	q: "",
	category: "",
	status: "active",
	minPrice: "",
	maxPrice: "",
	sort: "endsAt",
	order: "asc",
};

function show(value: Partial<Filters> = {}) {
	const onChange = vi.fn();
	const merged = { ...DEFAULTS, ...value };
	const view = render(
		<ListingFilters value={merged} defaults={DEFAULTS} onChange={onChange} />,
	);
	return { onChange, view, value: merged };
}

describe("ListingFilters", () => {
	it("reports a category immediately", async () => {
		const user = userEvent.setup();
		const { onChange } = show();

		await user.selectOptions(
			screen.getByLabelText(/filter by category/i),
			"combine",
		);

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ category: "combine" }),
		);
	});

	it("reports a status immediately", async () => {
		const user = userEvent.setup();
		const { onChange } = show();

		await user.selectOptions(
			screen.getByLabelText(/filter by status/i),
			"closed",
		);

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ status: "closed" }),
		);
	});

	it("maps a sort choice to a field and a direction", () => {
		// The UI offers "Price: high to low" because that is a concept a bidder
		// has; "currentBid, descending" is not.
		const { onChange } = show();
		const select = screen.getByLabelText(/sort listings/i);

		return userEvent
			.setup()
			.selectOptions(select, "3")
			.then(() => {
				expect(onChange).toHaveBeenCalledWith(
					expect.objectContaining({ sort: "currentBid", order: "desc" }),
				);
			});
	});

	it("debounces the search box", async () => {
		const user = userEvent.setup();
		const { onChange } = show();

		await user.type(screen.getByLabelText(/search listings/i), "deere");

		// Nothing yet; the whole point is not firing per keystroke.
		expect(onChange).not.toHaveBeenCalled();
		await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), {
			timeout: 2_000,
		});
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ q: "deere" }),
		);
	});

	it("debounces the price inputs", async () => {
		const user = userEvent.setup();
		const { onChange } = show();

		await user.type(screen.getByLabelText(/minimum price/i), "50000");

		expect(onChange).not.toHaveBeenCalled();
		await waitFor(
			() =>
				expect(onChange).toHaveBeenCalledWith(
					expect.objectContaining({ minPrice: "50000" }),
				),
			{ timeout: 2_000 },
		);
	});

	it("flags an inverted price range without sending it", async () => {
		// The server answers this with a 400. Catching it here puts the message
		// against the inputs rather than over the results.
		const user = userEvent.setup();
		show();

		await user.type(screen.getByLabelText(/minimum price/i), "100");
		await user.type(screen.getByLabelText(/maximum price/i), "5");

		expect(
			await screen.findByText(/minimum price is above the maximum/i),
		).toBeInTheDocument();
	});

	describe("the Clear button", () => {
		it("stays hidden when nothing is narrowed", () => {
			// status starts at "active", which is a default rather than evidence
			// the user filtered anything.
			show();
			expect(
				screen.queryByRole("button", { name: /clear/i }),
			).not.toBeInTheDocument();
		});

		it("appears once a filter is set", () => {
			show({ category: "tractor" });
			expect(
				screen.getByRole("button", { name: /clear/i }),
			).toBeInTheDocument();
		});

		it("returns the filters to their defaults", async () => {
			const user = userEvent.setup();
			const { onChange } = show({ category: "tractor", status: "closed" });

			await user.click(screen.getByRole("button", { name: /clear/i }));

			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({
					q: "",
					category: "",
					status: "active",
					minPrice: "",
					maxPrice: "",
				}),
			);
		});

		it("leaves the sort alone", async () => {
			// Clearing filters is about narrowing, not about ordering.
			const user = userEvent.setup();
			const { onChange } = show({
				category: "tractor",
				sort: "currentBid",
				order: "desc",
			});

			await user.click(screen.getByRole("button", { name: /clear/i }));

			expect(onChange).toHaveBeenCalledWith(
				expect.objectContaining({ sort: "currentBid", order: "desc" }),
			);
		});
	});
});
