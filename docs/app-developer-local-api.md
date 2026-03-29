# App developer: connecting to the local API

## What the error usually means

Message: *“nothing is listening on port …”* / *“server is not running”*.

**Two common causes:**

1. **The backend process is not started** — you must run the API from a terminal first (see below).
2. **Wrong port in the app** — this repo defaults to **`PORT=5000`** (see `.env.example`). If the app calls e.g. `http://localhost:3000` but the API runs on **5000**, the connection fails exactly as if the server were down.

## Start the API locally

From the backend repo root:

```bash
cp .env.example .env
# Edit .env: DATABASE_URL, JWT_SECRET, and PORT (if you change it)

npm install
npx prisma migrate deploy   # first time / after pulling migrations
npm run dev                 # development (reload on change)
# or: npm start             # migrate + server (production-style)
```

Wait until logs show something like:

`[SERVER] Server running on port <PORT>`

## Point the mobile / web app at the right URL

- **Base path for this API:** `http://<host>:<PORT>/api/v1`  
  Default for this project: **`http://localhost:5000/api/v1`**.

- **`PORT` in `.env` and the app must match** (default **5000**).

### Android emulator

`localhost` on the emulator is the device itself. Use the host machine:

`http://10.0.2.2:<PORT>/api/v1`

### iOS simulator

`http://localhost:<PORT>/api/v1` usually works.

### Physical phone / tablet

Use your computer’s **LAN IP** (same Wi‑Fi), e.g. `http://192.168.1.x:<PORT>/api/v1`.

## Check quickly

With the server running (default `PORT=5000`):

```bash
curl http://localhost:5000/
```

You should get JSON with `"status": "healthy"`. If that works, use the same host and port in the app (plus `/api/v1/...` for endpoints).
