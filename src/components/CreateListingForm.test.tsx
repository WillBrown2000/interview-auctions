import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateListingForm from "./CreateListingForm";

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

describe("CreateListingForm", () => {
	it("posts the seller-supplied fields as multipart", async () => {
		// Multipart whether or not a photo is attached, so there is one
		// encoding rather than a branch.
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: { id: "new", title: "New Tractor" } });
		render(<CreateListingForm onSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/^title/i), "New Tractor");
		await user.type(screen.getByLabelText(/description/i), "Low hours.");
		await user.selectOptions(screen.getByLabelText(/category/i), "combine");
		await user.clear(screen.getByLabelText(/minimum price/i));
		await user.type(screen.getByLabelText(/minimum price/i), "45000");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
		const body = init.body as FormData;

		expect(body.get("title")).toBe("New Tractor");
		expect(body.get("description")).toBe("Low hours.");
		expect(body.get("category")).toBe("combine");
		expect(body.get("startingPrice")).toBe("45000");
		expect(body.get("endsAt")).toBeTruthy();
	});

	it("sends the chosen photo", async () => {
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: { id: "new", title: "With Photo" } });
		render(<CreateListingForm onSuccess={() => {}} />);

		const file = new File(["binary"], "tractor.png", { type: "image/png" });
		await user.type(screen.getByLabelText(/^title/i), "With Photo");
		await user.upload(screen.getByLabelText(/photo/i), file);
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
		expect((init.body as FormData).get("image")).toBe(file);
	});

	it("sets no Content-Type, so the browser can supply the boundary", async () => {
		// Setting it by hand omits the multipart boundary, and the server then
		// cannot parse a body that looks perfectly fine on the wire.
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: { id: "new" } });
		render(<CreateListingForm onSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/^title/i), "No Header");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		await waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const init = fetchMock.mock.calls[0][1] as unknown as RequestInit;
		expect(init.headers).toBeUndefined();
	});

	it("rejects an oversized photo before uploading it", async () => {
		// Checked client-side so the user isn't made to wait for a 3MB upload
		// only to be told it was too big.
		const user = userEvent.setup();
		const fetchMock = mockFetch({ body: {} });
		render(<CreateListingForm onSuccess={() => {}} />);

		const tooBig = new File([new Uint8Array(3 * 1024 * 1024)], "huge.png", {
			type: "image/png",
		});
		await user.upload(screen.getByLabelText(/photo/i), tooBig);

		expect(await screen.findByText(/2mb or smaller/i)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("stops a past end date at the input itself", () => {
		// A `min` of now means the browser refuses the value before any handler
		// runs. The submit-time check behind it is defence in depth for clients
		// that don't enforce it -- asserting on the error message here would be
		// testing jsdom's validation rather than the app's.
		render(<CreateListingForm onSuccess={() => {}} />);
		const endsAt = screen.getByLabelText(/auction ends/i) as HTMLInputElement;

		expect(endsAt.min).toBeTruthy();
		const min = new Date(endsAt.min).getTime();
		expect(min).toBeLessThanOrEqual(Date.now() + 1_000);
		expect(min).toBeGreaterThan(Date.now() - 60_000);
	});

	it("defaults the end date a week out", () => {
		render(<CreateListingForm onSuccess={() => {}} />);
		const value = (screen.getByLabelText(/auction ends/i) as HTMLInputElement)
			.value;

		const days = (new Date(value).getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThan(7.1);
	});

	it("clears itself after a successful create, without throwing", async () => {
		// The same currentTarget-after-await bug as BidForm. It was latent here
		// because the create endpoint is less exercised, but identical.
		const user = userEvent.setup();
		mockFetch({ body: { id: "new", title: "New Tractor" } });
		const errors: unknown[] = [];
		vi.spyOn(console, "error").mockImplementation((e) => errors.push(e));

		render(<CreateListingForm onSuccess={() => {}} />);

		await user.type(screen.getByLabelText(/^title/i), "New Tractor");
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
		await user.type(screen.getByLabelText(/^title/i), "New Tractor");
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
		await user.type(screen.getByLabelText(/^title/i), "   ");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("shows the server's error", async () => {
		const user = userEvent.setup();
		mockFetch({ ok: false, body: { error: "Title is required" } });

		render(<CreateListingForm onSuccess={() => {}} />);
		await user.type(screen.getByLabelText(/^title/i), "Something");
		await user.click(screen.getByRole("button", { name: /create listing/i }));

		expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
	});
});
