import { hasEnded } from "../auction";
import type { Listing } from "../types";
import { useNow } from "../useNow";
import Countdown from "./Countdown";

interface Props {
	listing: Listing;
	isSelected: boolean;
	onClick: () => void;
}

export default function ListingCard({ listing, isSelected, onClick }: Props) {
	// Reading the shared clock rather than Date.now() means the card restyles
	// itself the moment the auction ends, without a reload and without its own
	// timer.
	//
	// Was `listing.status === "closed"`, which only greys out lots the server
	// has swept. An auction past its end time but still stored as active read
	// "Ended" in the corner while keeping the styling of a live lot.
	const closed = hasEnded(listing, useNow());

	return (
		<div
			className={`listing-card ${isSelected ? "listing-card--selected" : ""} ${closed ? "listing-card--closed" : ""}`}
			onClick={onClick}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => e.key === "Enter" && onClick()}
		>
			<img
				src={listing.imageUrl}
				alt={listing.title}
				className="listing-card__image"
			/>
			<div className="listing-card__body">
				<span className={`badge badge--${listing.category}`}>
					{listing.category}
				</span>
				<h3 className="listing-card__title">{listing.title}</h3>
				<div className="listing-card__bid">
					Current bid: <strong>${listing.currentBid.toLocaleString()}</strong>
				</div>
				<div
					className={`listing-card__time ${closed ? "listing-card__time--ended" : ""}`}
				>
					<Countdown listing={listing} />
				</div>
			</div>
		</div>
	);
}
