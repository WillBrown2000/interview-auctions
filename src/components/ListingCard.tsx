import type { Listing } from "../types";

interface Props {
	listing: Listing;
	isSelected: boolean;
	onClick: () => void;
}

function timeRemaining(endsAt: string, status: string): string {
	if (status === "closed") return "Ended";
	const diff = new Date(endsAt).getTime() - Date.now();
	if (diff <= 0) return "Ended";
	const days = Math.floor(diff / 86_400_000);
	const hours = Math.floor((diff % 86_400_000) / 3_600_000);
	if (days > 0) return `${days} day${days === 1 ? "" : "s"} left`;
	if (hours > 0) return `${hours} hour${hours === 1 ? "" : "s"} left`;
	return "Less than an hour left";
}

export default function ListingCard({ listing, isSelected, onClick }: Props) {
	const closed = listing.status === "closed";

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
					{timeRemaining(listing.endsAt, listing.status)}
				</div>
			</div>
		</div>
	);
}
