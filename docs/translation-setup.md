# Auto-Translation Setup (Azure AI Translator)

When the admin saves a product/category/section/promo-code, the backend automatically detects whether the text is English or Arabic, routes it into the correct column (`title` for English, `title_ar` for Arabic — even if the admin typed into the "wrong" field), and translates the other side. Both English and Arabic always end up populated in the database, and both are returned in API responses. The admin can still edit either side manually at any time — manual values always win over auto-translation.

The mobile app keeps consuming `title`/`title_ar`, `description`/`description_ar`, etc. — no client change needed.

This doc lists everything you (the deploy operator) need to do.

---

## TL;DR — what you have to do

1. Create an Azure Translator resource (free tier — 2,000,000 chars/month).
2. Add 4 environment variables.
3. Restart the backend.
4. (Optional) Run the one-time backfill script for existing rows.

That's the whole list. The code is already wired and tested.

---

## 1. Create an Azure Translator resource (~3 minutes)

1. Go to <https://portal.azure.com> → sign in (free Microsoft account works).
2. Click **Create a resource** → search **"Translator"** → select **Translator** (publisher: Microsoft) → **Create**.
3. Fill the form:
   - **Subscription**: your subscription (Free Trial is fine).
   - **Resource group**: create one, e.g. `amoon-bloom`.
   - **Region**: pick one close to your backend (e.g. `UAE North`, `West Europe`, `East US`). **Remember this value — you'll paste it into `AZURE_TRANSLATOR_REGION`.**
   - **Name**: anything, e.g. `amoon-translator`.
   - **Pricing tier**: **Free F0** (2M chars/month, $0).
4. Click **Review + create** → **Create**. Wait ~30 seconds.
5. Open the created resource → left sidebar → **Keys and Endpoint**.
6. Copy:
   - **KEY 1** (a long hex string) → this is `AZURE_TRANSLATOR_KEY`.
   - **Location/Region** (e.g. `uaenorth`) → this is `AZURE_TRANSLATOR_REGION`.
   - Note: the **Text Translation** endpoint is the global one — `https://api.cognitive.microsofttranslator.com`. You don't need a regional endpoint for translation.

---

## 2. Environment variables

Add these to your **`.env`** (local dev) and to **Railway → Variables** (production).

### Required to enable translation

| Variable | Value | Notes |
|---|---|---|
| `TRANSLATION_PROVIDER` | `azure` | Set to `none` (or unset) to disable auto-translation entirely. |
| `AZURE_TRANSLATOR_KEY` | `<your KEY 1>` | From step 1.6 above. Treat as a secret. |
| `AZURE_TRANSLATOR_REGION` | `<your region>` | The Location field, e.g. `uaenorth`. Must be lowercase, no spaces. |

### Optional tuning (sensible defaults already set)

| Variable | Default | Purpose |
|---|---|---|
| `AZURE_TRANSLATOR_ENDPOINT` | `https://api.cognitive.microsofttranslator.com` | Override only if Microsoft tells you to use a regional endpoint. |
| `TRANSLATION_TIMEOUT_MS` | `5000` | Max ms to wait for one Azure call before giving up. |
| `TRANSLATION_RETRY_ATTEMPTS` | `1` | Retries on 5xx / network errors. 4xx never retries (fails fast). |
| `TRANSLATION_CACHE_MAX` | `5000` | In-memory LRU cache size (entries). Repeat strings cost $0. |

### Example block

```env
# --- Auto-translation ---
TRANSLATION_PROVIDER=azure
AZURE_TRANSLATOR_KEY=abcdef0123456789abcdef0123456789
AZURE_TRANSLATOR_REGION=uaenorth
```

---

## 3. Restart and verify

```bash
# Local
npm run dev

# Production (Railway): push & redeploy — env changes don't auto-restart on Railway,
# you need to redeploy or restart the service.
```

The server logs once at boot if translation is disabled. If you see no warning, it's enabled.

Run the smoke test (real Azure round-trips) once your key is set:

```bash
node scripts/test-translation.js
```

Expected output: ~30 assertions passing, including measured single-call latency, batch performance, and en↔ar round-trips. Anything failing means the key/region is wrong or the network is blocked.

---

## 4. Backfill existing rows (optional, one-time)

Your DB already has products/categories/etc. with one side filled and the other `null`. To translate the gaps in one shot:

```bash
# Preview first (no DB writes):
node scripts/backfill-translations.js --dry-run

# Then run it:
node scripts/backfill-translations.js

# Or target one model:
node scripts/backfill-translations.js --model Product --limit 100
```

Output reports per-model counts and elapsed time. Safe to re-run — only rows still missing a twin are touched.

Cost estimate: a typical 5K-product catalog ≈ 1–2M chars to backfill. Free tier covers this in the same month.

---

## 5. How it behaves (so you can explain it to the admin)

The backend uses **content-based language detection**, not slot-based. The admin can type into *either* field — English or Arabic — and the system will route the text to the correct column and translate the other side automatically.

| Admin input | What the backend does | Final DB row |
|---|---|---|
| Types **English** into `title` | Keeps it; translates to `title_ar` | `title = "Red roses"`, `title_ar = "ورود حمراء"` |
| Types **Arabic** into `title` (wrong slot) | **Moves** it to `title_ar`; translates to fill `title` | `title = "Red roses"`, `title_ar = "ورود حمراء"` |
| Types **Arabic** into `title_ar` | Keeps it; translates to `title` | `title = "Red roses"`, `title_ar = "ورود حمراء"` |
| Types **English** into `title_ar` (wrong slot) | **Moves** it to `title`; translates to fill `title_ar` | `title = "Red roses"`, `title_ar = "ورود حمراء"` |
| Fills **both** sides manually | Stored exactly as typed — manual override always wins | Both columns hold the admin's input verbatim |
| Both empty | Nothing happens | Both stay empty |
| Translation API fails / times out / quota hit | Admin's input saved exactly as given, in the column they used. The other column stays `null`. The save is **never blocked**. | Best-effort — admin can re-save when API is back |

**Re-saving a record with new text overwrites the auto-translated side.** If the admin wants to keep a hand-crafted Arabic translation, they should fill both sides on save (manual override wins).

**Detection algorithm:** Arabic Unicode script (U+0600–U+06FF, U+0750–U+077F, and Arabic Presentation Forms) is counted vs. Latin letters. Whichever script has more characters wins. Pure numbers, emoji, or empty strings fall back to English. This is content-based, free, and deterministic.

---

## 6. Fields covered

Already wired (no further work):

- **Category**: `title`, `description`
- **Section**: `title`
- **Product**: `title`, `subtitle`
- **ProductDescription**: `title`, `description`
- **ProductOption**: `title`, `options[]` (array of size variants, etc.)
- **PromoCode**: `name`, `description`

Each admin write costs **one Azure round-trip** regardless of how many fields are translated — the code batches the parent + every child row into a single API call.

---

## 7. Performance & cost notes

- **Single round-trip per save**: a product create with 5 descriptions + 3 options = 1 Azure call.
- **In-memory LRU cache**: identical strings cost $0 (e.g. "Free shipping" repeats across promos).
- **No DB connection held during network I/O**: translations run before the Prisma transaction opens. No connection-pool starvation under load.
- **Soft failure**: Azure outage / quota exhaustion never blocks a save. Worst case, the `_ar` side stays null and the admin sees their original input back.
- **Kill switch**: set `TRANSLATION_PROVIDER=none` and restart to turn off everything without removing the key. Useful if you ever hit a billing surprise.

---

## 8. Monitoring (optional)

The translation service logs to stdout under `[translation]`. To watch usage and quota:

- Azure Portal → your Translator resource → **Metrics** → add `Total Calls` and `Characters Translated`.
- Free tier quota resets on the 1st of each month. Stay under 2M chars/month to pay $0.

---

## What to do if something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Server logs `AZURE_TRANSLATOR_KEY missing` | Env not picked up | Verify `.env` is loaded; restart server |
| Test script reports `401` / `403` | Wrong key or region | Re-copy from Azure portal; region must match the resource's Location |
| `429 Too Many Requests` | Quota exhausted (over 2M/month) | Upgrade to S1 paid tier (~$10/M chars) or wait for monthly reset |
| Arabic comes back garbled / English passes through | Network failure mid-call | Check `[translation]` logs; transient — admin can re-save |

---

## Files added/changed

```
src/services/translation.service.js   # Azure wrapper, cache, batching, retry
src/utils/bilingual.js                # autoTranslate / autoTranslateMany helpers
src/services/category.service.js      # wired
src/services/section.service.js       # wired
src/services/product.service.js       # wired (parent + descriptions + options)
src/services/promoCode.service.js     # wired
src/config/env.js                     # registers new env vars
scripts/backfill-translations.js      # one-time backfill for existing rows
scripts/test-translation.js           # smoke test (offline + live modes)
docs/translation-setup.md             # this doc
```
