import { useEffect, useRef, useState } from "react";
import { placeBid } from "../api/listings";
import type { Listing } from "../types";

interface Props {
	listing: Listing;
	onBidSuccess: (updated: Listing) => void;
}

export default function BidForm({ listing, onBidSuccess }: Props) {
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	/**
	 * The current bid as it stood when this form was last a blank slate.
	 *
	 * The listing updates live now, so the price can move while someone is
	 * partway through typing an amount. The one thing not to do is rewrite the
	 * input under their cursor -- that is how a person submits $60,000 having
	 * decided on $52,000. The amount field is uncontrolled and stays untouched;
	 * the change is surfaced as a notice instead, and they decide.
	 */
	const [baseline, setBaseline] = useState(listing.currentBid);
	const amountRef = useRef<HTMLInputElement>(null);

	// A different listing means a different auction, so the previous baseline
	// is meaningless.
	const listingIdRef = useRef(listing.id);
	useEffect(() => {
		if (listingIdRef.current !== listing.id) {
			listingIdRef.current = listing.id;
			setBaseline(listing.currentBid);
		}
	}, [listing.id, listing.currentBid]);

	const outbid = listing.currentBid > baseline;
	const suggested = listing.currentBid + 1_000;

	const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);

		// Captured before the first await: React sets currentTarget back to null
		// once the handler's synchronous phase ends, so reading it after the
		// awaited fetch below would throw.
		const form = e.currentTarget;

		const data = new FormData(form);
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
			form.reset();
			// The form is blank again, so the notice has nothing left to warn
			// about -- the price they were told about is now the one on screen.
			setBaseline(updated.currentBid);
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

			{outbid && (
				// aria-live so a screen reader announces the change; it happens
				// with no interaction from the user, so nothing else would.
				<div className="bid-form__notice" role="status" aria-live="polite">
					<span>
						Current bid moved to{" "}
						<strong>${listing.currentBid.toLocaleString()}</strong>
						{listing.currentBidder ? ` (${listing.currentBidder})` : ""}
					</span>
					<button
						type="button"
						className="bid-form__notice-action"
						onClick={() => {
							// Only ever on an explicit click. The amount is filled in
							// because the user asked for it, not because a stranger's
							// bid arrived.
							if (amountRef.current) {
								amountRef.current.value = String(suggested);
							}
							setBaseline(listing.currentBid);
						}}
					>
						Bid ${suggested.toLocaleString()}
					</button>
				</div>
			)}

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
					ref={amountRef}
					type="number"
					placeholder={`e.g. ${suggested.toLocaleString()}`}
					min={1}
					step={1}
					disabled={submitting}
				/>
			</div>
			<button type="submit" className="bid-form__submit" disabled={submitting}>
				{submitting ? "Submitting…" : "Submit Bid"}
			</button>
		</form>
	);
}
