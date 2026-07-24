export interface Bid {
	id: string;
	listingId: string;
	bidder: string;
	amount: number;
	placedAt: string;
}

export type Category = "tractor" | "combine" | "implement" | "attachment";
export type Status = "active" | "closed" | "pending";

export interface PaginationMeta {
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
	hasMore: boolean;
}

export interface Paginated<T> {
	data: T[];
	pagination: PaginationMeta;
}

export interface ListingQuery {
	page?: number;
	pageSize?: number;
	category?: Category | "";
	status?: Status | "";
	q?: string;
	sort?: "endsAt" | "currentBid" | "title";
	order?: "asc" | "desc";
}

export interface Listing {
	id: string;
	title: string;
	description: string;
	category: "tractor" | "combine" | "implement" | "attachment";
	startingPrice: number;
	currentBid: number;
	currentBidder: string | null;
	status: "active" | "closed" | "pending";
	endsAt: string;
	imageUrl: string;
}
