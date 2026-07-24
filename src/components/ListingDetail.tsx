import BidForm from "./BidForm";
import type { Listing } from "../types";

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
				<span className={`status-badge status-badge--${listing.status}`}>
					{listing.status}
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
					<span className="meta-label">Current Bidder</span>
					<span className="meta-value">
						{listing.currentBidder ?? "No bids yet"}
					</span>
				</div>
				<div className="meta-row">
					<span className="meta-label">Auction Ends</span>
					<span className="meta-value">{formatDate(listing.endsAt)}</span>
				</div>
			</div>

			{listing.status === "active" && (
				<BidForm listing={listing} onBidSuccess={onBidSuccess} />
			)}
		</div>
	);
}
