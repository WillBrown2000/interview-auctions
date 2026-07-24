import { useState } from "react";
import { createListing } from "../api/listings";
import type { Listing } from "../types";

interface Props {
	onSuccess: (listing: Listing) => void;
}

export default function CreateListingForm({ onSuccess }: Props) {
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);

		const data = new FormData(e.currentTarget);
		const title = (data.get("title") as string).trim();

		if (!title) {
			setError("Title is required.");
			return;
		}

		setSubmitting(true);
		try {
			const listing = await createListing({ title });
			onSuccess(listing);
			e.currentTarget.reset();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create listing");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form className="bid-form" onSubmit={handleSubmit}>
			<h4 className="bid-form__title">New Listing</h4>
			{error && <div className="bid-form__error">{error}</div>}
			<div className="bid-form__field">
				<label htmlFor="title">Title</label>
				<input
					id="title"
					name="title"
					type="text"
					placeholder="e.g. 2018 John Deere 6120M"
					disabled={submitting}
				/>
			</div>
			<button
				type="submit"
				className="bid-form__submit"
				disabled={submitting}
			>
				{submitting ? "Creating…" : "Create Listing"}
			</button>
		</form>
	);
}
