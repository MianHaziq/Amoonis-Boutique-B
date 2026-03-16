# Bunny Storage Integration

How **Bunny CDN Storage** is used for image uploads in the Amoonis Boutique backend.

## Architecture

- **Bunny Storage** is the object store; files are uploaded via the Storage API.
- **Bunny CDN** serves files via a public hostname.
- Flow: Client (multipart) → Express (multer) → bunnyStorage.service → Bunny Storage API → CDN URL returned.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| BUNNY_STORAGE_ZONE | Yes | Storage zone name |
| BUNNY_STORAGE_ACCESS_KEY | Yes | Storage API password |
| BUNNY_STORAGE_REGION | No | Default: storage.bunnycdn.com |
| BUNNY_IMAGES_CDN_HOSTNAME | Yes | CDN hostname (e.g. myzone.b-cdn.net) |

## Config and service

- **Config:** `src/config/bunnyStorage.js` – reads env and exports config.
- **Service:** `src/services/bunnyStorage.service.js`
  - `uploadImage(buffer, path, filename, contentType)` – returns public CDN URL.
  - `deleteImage(storagePath)` – deletes file in storage (e.g. when replacing images).

## Image upload flow

1. **Route:** POST `/api/upload/image` or `/api/v1/upload/image`
2. **Auth:** Admin JWT required (`verifyAdmin`)
3. **Middleware:** Multer single file, field `file`, image types only, max 5MB
4. **Query:** Optional `path` (e.g. team, testimonials, products, uploads). Default: uploads
5. **Response:** `{ success: true, data: { url } }` with CDN URL

Example: `POST /api/v1/upload/image?path=products` with multipart `file` and `Authorization: Bearer <admin_jwt>`.

## Video upload (for later)

Only image upload is implemented. To add video you can use the same Storage zone with a new path (e.g. videos) and a new endpoint that accepts video MIME types and larger limits, or use Bunny Stream for transcoding (separate config and service).

## Usage for developers

1. Set BUNNY_STORAGE_ZONE, BUNNY_STORAGE_ACCESS_KEY, BUNNY_IMAGES_CDN_HOSTNAME in .env.
2. Call POST /api/v1/upload/image with admin JWT and multipart `file`; optional `path` for folder.
3. Store the returned `data.url` (e.g. product image URL).
4. To delete: use `bunnyStorage.deleteImage(storagePath)` from a service (e.g. product update).
