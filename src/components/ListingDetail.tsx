import { hasEnded } from "../auction";
import type { Listing } from "../types";
import BidForm from "./BidForm";

interface Props {
	listing: Listing;
	onBidSuccess: (updated: Listing) => void;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export default function ListingDetail({ listing, onBidSuccess }: Props) {
	const ended = hasEnded(listing);

	// The badge shows the status the auction is actually in, not the one the
	// row happens to store. A listing whose end time has passed but that
	// nothing has swept yet still reads "active" in the database, and showing
	// that next to a closed auction is just confusing.
	const displayStatus = ended ? "closed" : listing.status;

	return (
		<div className="listing-detail">
			<img
				src={listing.imageUrl}
				alt={listing.title}
				className="listing-detail__image"
			/>
			<div className="listing-detail__header">
				<span className={`badge badge--${listing.category}`}>
					{listing.category}
				</span>
				<span className={`status-badge status-badge--${displayStatus}`}>
					{displayStatus}
				</span>
			</div>
			<h2 className="listing-detail__title">{listing.title}</h2>
			<p className="listing-detail__description">{listing.description}</p>

			<div className="listing-detail__meta">
				<div className="meta-row">
					<span className="meta-label">Starting Price</span>
					<span className="meta-value">
						${listing.startingPrice.toLocaleString()}
					</span>
				</div>
				<div className="meta-row">
					<span className="meta-label">Current Bid</span>
					<span className="meta-value meta-value--highlight">
						${listing.currentBid.toLocaleString()}
					</span>
				</div>
				<div className="meta-row">
					<span className="meta-label">
						{ended ? "Winning Bidder" : "Current Bidder"}
					</span>
					<span className="meta-value">
						{listing.currentBidder ?? "No bids yet"}
					</span>
				</div>
				<div className="meta-row">
					<span className="meta-label">
						{ended ? "Auction Ended" : "Auction Ends"}
					</span>
					<span className="meta-value">{formatDate(listing.endsAt)}</span>
				</div>
			</div>

			{ended ? (
				<AuctionResult listing={listing} />
			) : (
				<BidForm listing={listing} onBidSuccess={onBidSuccess} />
			)}
		</div>
	);
}

/**
 * Shown in place of the bid form once an auction is over.
 *
 * The form isn't merely disabled — it's gone. The server refuses these bids,
 * so leaving inputs on screen invites someone to fill them in and be told no.
 * What replaces it is the thing a visitor to a finished auction wants: who won
 * and for how much.
 */
function AuctionResult({ listing }: { listing: Listing }) {
	if (!listing.currentBidder) {
		return (
			<div className="auction-result auction-result--unsold">
				<h4 className="auction-result__heading">Auction ended</h4>
				<p className="auction-result__detail">
					This auction closed without any bids.
				</p>
			</div>
		);
	}

	return (
		<div className="auction-result">
			<h4 className="auction-result__heading">Auction ended</h4>
			<p className="auction-result__detail">
				Won by <strong>{listing.currentBidder}</strong> for{" "}
				<strong>${listing.currentBid.toLocaleString()}</strong>
			</p>
		</div>
	);
}
