import { useEffect, useRef, useState } from "react";
import { createListing } from "../api/listings";
import type { Category, Listing } from "../types";

interface Props {
	onSuccess: (listing: Listing) => void;
}

const CATEGORIES: Category[] = [
	"tractor",
	"combine",
	"implement",
	"attachment",
];

/** Matches the server's cap. Checked here so the user isn't made to wait for
 *  a 2MB upload only to be told it was too big. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const ACCEPTED_IMAGES = "image/jpeg,image/png,image/webp,image/gif";

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time, not an ISO string. */
function toLocalInputValue(date: Date): string {
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function CreateListingForm({ onSuccess }: Props) {
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	// Held in state rather than read off the form on submit, because the
	// preview needs it as the user picks.
	const [image, setImage] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);

	// Prefilled a week out, which is both a sensible default and a hint about
	// what the field wants. The seller can change it.
	const [endsAt, setEndsAt] = useState(() =>
		toLocalInputValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
	);

	const fileRef = useRef<HTMLInputElement>(null);

	// Object URLs hold the file in memory until revoked, so every replaced
	// preview would otherwise leak one for the life of the page.
	useEffect(() => {
		if (!image) {
			setPreviewUrl(null);
			return;
		}
		const url = URL.createObjectURL(image);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [image]);

	const handleFile = (file: File | null) => {
		setError(null);
		if (file && file.size > MAX_IMAGE_BYTES) {
			setError("Photo must be 2MB or smaller.");
			if (fileRef.current) fileRef.current.value = "";
			setImage(null);
			return;
		}
		setImage(file);
	};

	const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);

		// See BidForm — currentTarget is null after the await.
		const form = e.currentTarget;

		const data = new FormData(form);
		const title = (data.get("title") as string).trim();

		if (!title) {
			setError("Title is required.");
			return;
		}

		const startingPrice = (data.get("startingPrice") as string).trim();
		if (startingPrice && Number(startingPrice) < 0) {
			setError("Minimum price cannot be negative.");
			return;
		}

		if (endsAt && new Date(endsAt).getTime() <= Date.now()) {
			setError("End date must be in the future.");
			return;
		}

		setSubmitting(true);
		try {
			const listing = await createListing({
				title,
				description: (data.get("description") as string).trim(),
				category: data.get("category") as Category | "",
				startingPrice,
				endsAt,
				image,
			});
			onSuccess(listing);
			form.reset();
			setImage(null);
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

			<div className="bid-form__field">
				<label htmlFor="description">Description</label>
				<textarea
					id="description"
					name="description"
					rows={3}
					maxLength={2000}
					placeholder="Condition, hours, anything a buyer would ask about"
					disabled={submitting}
				/>
			</div>

			<div className="bid-form__field">
				<label htmlFor="category">Category</label>
				<select id="category" name="category" disabled={submitting}>
					{CATEGORIES.map((c) => (
						<option key={c} value={c}>
							{c}
						</option>
					))}
				</select>
			</div>

			<div className="bid-form__field">
				<label htmlFor="startingPrice">Minimum Price ($)</label>
				<input
					id="startingPrice"
					name="startingPrice"
					type="number"
					min={0}
					step={100}
					defaultValue={0}
					disabled={submitting}
				/>
				<span className="bid-form__hint">
					Bidding opens here. 0 means no reserve.
				</span>
			</div>

			<div className="bid-form__field">
				<label htmlFor="endsAt">Auction Ends</label>
				<input
					id="endsAt"
					name="endsAt"
					type="datetime-local"
					value={endsAt}
					min={toLocalInputValue(new Date())}
					onChange={(e) => setEndsAt(e.target.value)}
					disabled={submitting}
				/>
			</div>

			<div className="bid-form__field">
				<label htmlFor="image">Photo</label>
				<input
					id="image"
					name="image"
					type="file"
					ref={fileRef}
					accept={ACCEPTED_IMAGES}
					onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
					disabled={submitting}
				/>
				<span className="bid-form__hint">
					Optional. JPEG, PNG, WebP or GIF, up to 2MB.
				</span>
			</div>

			{previewUrl && (
				<div className="image-preview">
					<img src={previewUrl} alt="Selected listing photo" />
					<button
						type="button"
						className="image-preview__remove"
						onClick={() => {
							if (fileRef.current) fileRef.current.value = "";
							setImage(null);
						}}
					>
						Remove
					</button>
				</div>
			)}

			<button type="submit" className="bid-form__submit" disabled={submitting}>
				{submitting ? "Creating…" : "Create Listing"}
			</button>
		</form>
	);
}
