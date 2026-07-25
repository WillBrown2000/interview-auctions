import { hasEnded, isPending } from "../auction";
import type { Listing } from "../types";
import { useNow } from "../useNow";
import BidForm from "./BidForm";
import Countdown from "./Countdown";

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
	// Shared clock, so the panel swaps the bid form for the result the instant
	// the auction closes — no reload, and no timer of its own.
	const now = useNow();
	const ended = hasEnded(listing, now);
	const pending = isPending(listing, now);

	// The badge shows the status the auction is actually in, not the one the
	// row happens to store. A listing whose end time has passed but that
	// nothing has swept yet still reads "active" in the database, and showing
	// that next to a closed auction is just confusing.
	const displayStatus = pending ? "pending" : ended ? "closed" : listing.status;

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
				{pending && (
					<div className="meta-row">
						<span className="meta-label">Bidding Opens</span>
						<span className="meta-value">{formatDate(listing.startsAt)}</span>
					</div>
				)}
				<div className="meta-row">
					<span className="meta-label">
						{ended ? "Auction Ended" : "Auction Ends"}
					</span>
					<span className="meta-value">{formatDate(listing.endsAt)}</span>
				</div>
				{!ended && (
					<div className="meta-row">
						<span className="meta-label">
							{pending ? "Opens In" : "Time Remaining"}
						</span>
						<span className="meta-value">
							<Countdown listing={listing} />
						</span>
					</div>
				)}
			</div>

			{pending ? (
				<NotOpenYet listing={listing} />
			) : ended ? (
				<AuctionResult listing={listing} />
			) : (
				<BidForm listing={listing} onBidSuccess={onBidSuccess} />
			)}
		</div>
	);
}

/**
 * Shown in place of the bid form before an auction opens.
 *
 * The form is absent rather than disabled, for the same reason it is on a
 * finished auction: the server refuses these bids, so putting inputs on screen
 * only invites someone to fill them in and be told no. What a visitor to a
 * catalogued lot wants instead is when it opens and what it will open at.
 */
function NotOpenYet({ listing }: { listing: Listing }) {
	return (
		<div className="auction-result auction-result--pending">
			<h4 className="auction-result__heading">Bidding not open yet</h4>
			<p className="auction-result__detail">
				Opens <Countdown listing={listing} className="countdown--inline" /> at{" "}
				<strong>${listing.startingPrice.toLocaleString()}</strong>
			</p>
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
