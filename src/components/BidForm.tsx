import { useState } from "react";
import { placeBid } from "../api/listings";
import type { Listing } from "../types";

interface Props {
	listing: Listing;
	onBidSuccess: (updated: Listing) => void;
}

export default function BidForm({ listing, onBidSuccess }: Props) {
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);

		const data = new FormData(e.currentTarget);
		const bidder = (data.get("bidder") as string).trim();
		const numAmount = parseFloat(data.get("amount") as string);

		if (!bidder) {
			setError("Bidder name is required.");
			return;
		}
		if (isNaN(numAmount) || numAmount <= 0) {
			setError("Please enter a valid bid amount.");
			return;
		}

		setSubmitting(true);
		try {
			const updated = await placeBid(listing.id, bidder, numAmount);
			onBidSuccess(updated);
			e.currentTarget.reset();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to place bid");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form className="bid-form" onSubmit={handleSubmit}>
			<h4 className="bid-form__title">Place a Bid</h4>
			{error && <div className="bid-form__error">{error}</div>}
			<div className="bid-form__field">
				<label htmlFor="bidder">Your Name</label>
				<input
					id="bidder"
					name="bidder"
					type="text"
					placeholder="e.g. Jane Smith"
					disabled={submitting}
				/>
			</div>
			<div className="bid-form__field">
				<label htmlFor="amount">Bid Amount ($)</label>
				<input
					id="amount"
					name="amount"
					type="number"
					placeholder={`e.g. ${(listing.currentBid + 1_000).toLocaleString()}`}
					min={1}
					step={1}
					disabled={submitting}
				/>
			</div>
			<button
				type="submit"
				className="bid-form__submit"
				disabled={submitting}
			>
				{submitting ? "Submitting…" : "Submit Bid"}
			</button>
		</form>
	);
}
