import multer from "multer";

/**
 * Photo uploads for new listings.
 *
 * Held in memory by multer, then written to the database as a blob in the same
 * transaction as the listing itself. Nothing touches the filesystem, so there
 * is no orphaned-file problem when validation rejects a listing after the
 * upload has already arrived, and no second piece of state to keep in step
 * with the database.
 *
 * multipart rather than a base64 data URL in JSON. Base64 avoids the
 * dependency but inflates the payload by a third, and the whole thing has to
 * be buffered as a string before anything can look at it. multer enforces the
 * size cap while receiving, so an oversized upload is cut off mid-flight.
 */

/**
 * 2MB.
 *
 * Comfortably above a photo someone would put on a listing, and low enough
 * that a row stays reasonable to read. SQLite's own guidance puts blob reads
 * ahead of filesystem reads below roughly 100KB and competitive to about a
 * megabyte, so this cap makes the tail of that range the worst case rather
 * than the norm. It is also memory: multer holds the whole upload while the
 * request is in flight, so the cap bounds what one request can occupy.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * The types allowed, and what each is stored as.
 *
 * An allowlist rather than a denylist -- the interesting attacks are always
 * the type nobody thought to exclude. SVG is deliberately absent: it's an
 * image to a browser and a script host to an attacker.
 */
const ALLOWED_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
]);

export class UploadError extends Error {}

export const uploadListingImage = multer({
	// Memory, not disk: the bytes are going straight into the database, and a
	// temp file in between is a file to clean up on every failure path.
	storage: multer.memoryStorage(),
	limits: { fileSize: MAX_BYTES, files: 1 },
	fileFilter: (_req, file, cb) => {
		if (!ALLOWED_TYPES.has(file.mimetype)) {
			cb(
				new UploadError(
					`Unsupported image type. Allowed: ${[...ALLOWED_TYPES].join(", ")}`,
				),
			);
			return;
		}
		cb(null, true);
	},
}).single("image");

/** Where a listing's photo is served from. */
export function imageUrlFor(listingId: string): string {
	// Under /api so the frontend's existing dev proxy covers it without a
	// second rule.
	return `/api/listings/${listingId}/image`;
}

/** Turns multer's errors into something a client can act on. */
export function describeUploadError(err: unknown): string | null {
	if (err instanceof UploadError) return err.message;
	if (err instanceof multer.MulterError) {
		if (err.code === "LIMIT_FILE_SIZE") {
			return `Image must be ${MAX_BYTES / 1024 / 1024}MB or smaller`;
		}
		if (err.code === "LIMIT_FILE_COUNT") return "Only one image is allowed";
		if (err.code === "LIMIT_UNEXPECTED_FILE") {
			return "Unexpected file field; the image field must be named 'image'";
		}
		return err.message;
	}
	return null;
}

export const MAX_UPLOAD_BYTES = MAX_BYTES;
export const ALLOWED_IMAGE_TYPES = [...ALLOWED_TYPES];
