import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateListingForm from "./CreateListingForm";

function mockFetch(response: { ok?: boolean; body?: unknown }) {
	const fn = vi.fn(async () => ({
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

describe("CreateListingForm", () => {
	it("posts the title", async () => {
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: { id: "new", title: "New Tractor" } });
		render(<CreateListingForm onSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/title/i), "New Tractor");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ title: "New Tractor" });
	});

	it("clears itself after a successful create, without throwing", async () => {
		// The same currentTarget-after-await bug as BidForm. It was latent here
		// because the create endpoint is less exercised, but identical.
		const user = userEvent.setup();
		mockFetch({ body: { id: "new", title: "New Tractor" } });
		const errors: unknown[] = [];
		vi.spyOn(console, "error").mockImplementation((e) => errors.push(e));

		render(<CreateListingForm onSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/title/i), "New Tractor");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		await waitFor(() =>
			expect(screen.getByLabelText(/title/i)).toHaveValue(""),
		);
		expect(errors).toHaveLength(0);
	});

	it("hands the created listing to its parent", async () => {
		const user = userEvent.setup();
		const created = { id: "new", title: "New Tractor" };
		mockFetch({ body: created });
		const onSuccess = vi.fn();

		render(<CreateListingForm onSuccess={onSuccess} />);
		await user.type(screen.getByLabelText(/title/i), "New Tractor");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(created));
	});

	it("requires a title before hitting the network", async () => {
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: {} });

		render(<CreateListingForm onSuccess={() => {}} />);
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only title", async () => {
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: {} });

		render(<CreateListingForm onSuccess={() => {}} />);
		await user.type(screen.getByLabelText(/title/i), "   ");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shows the server's error", async () => {
		const user = userEvent.setup();
		mockFetch({ ok: false, body: { error: "Title is required" } });

		render(<CreateListingForm onSuccess={() => {}} />);
		await user.type(screen.getByLabelText(/title/i), "Something");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
	});
});
