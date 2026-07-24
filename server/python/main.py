import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# ============================================================
# Models
# ============================================================


class Listing(BaseModel):
    """Wire JSON matches the TypeScript server (camelCase keys)."""

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=to_camel,
    )

    id: str
    title: str
    description: str
    category: Literal["tractor", "combine", "implement", "attachment"]
    starting_price: float
    current_bid: float
    current_bidder: Optional[str]
    status: Literal["active", "closed", "pending"]
    ends_at: str
    image_url: str


class BidRequest(BaseModel):
    bidder: str
    amount: float


class CreateListingRequest(BaseModel):
    title: str


# ============================================================
# In-memory store — seeded from data/listings.json
# ============================================================

_data_file = Path(__file__).parent / "data" / "listings.json"
listings: list[Listing] = [
    Listing(**item) for item in json.loads(_data_file.read_text())
]

# ============================================================
# App
# ============================================================

app = FastAPI(title="Interview Auctions")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get(
    "/api/listings",
    response_model=list[Listing],
    response_model_by_alias=True,
)
def get_listings():
    return listings


@app.post(
    "/api/listings",
    response_model=Listing,
    status_code=201,
    response_model_by_alias=True,
)
def create_listing(body: CreateListingRequest):
    if not body.title or not body.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")

    listing = Listing(
        id=str(uuid.uuid4()),
        title=body.title.strip(),
        description="",
        category="implement",
        starting_price=0,
        current_bid=0,
        current_bidder=None,
        status="active",
        ends_at=(datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        image_url="",
    )
    listings.append(listing)
    return listing


@app.get(
    "/api/listings/{listing_id}",
    response_model=Listing,
    response_model_by_alias=True,
)
def get_listing(listing_id: str):
    listing = next((l for l in listings if l.id == listing_id), None)
    if listing is None:
        raise HTTPException(status_code=404, detail="Listing not found")
    return listing


@app.post(
    "/api/listings/{listing_id}/bids",
    response_model=Listing,
    status_code=201,
    response_model_by_alias=True,
)
def place_bid(listing_id: str, bid: BidRequest):
    listing = next((l for l in listings if l.id == listing_id), None)
    if listing is None:
        raise HTTPException(status_code=404, detail="Listing not found")

    if listing.status != "active":
        raise HTTPException(
            status_code=400, detail="This listing is not currently active"
        )

    if not bid.bidder or not bid.bidder.strip():
        raise HTTPException(status_code=400, detail="Bidder name is required")

    if bid.amount <= 0:
        raise HTTPException(
            status_code=400, detail="Bid amount must be a positive number"
        )

    if bid.amount >= listing.current_bid:
        raise HTTPException(
            status_code=400,
            detail=f"Bid must be greater than the current bid of ${listing.current_bid:,.0f}",
        )

    listing.current_bid = bid.amount
    listing.current_bidder = bid.bidder.strip()

    return listing
