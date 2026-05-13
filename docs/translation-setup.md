# Auto-Translation Setup (Google Cloud Translation — default)

When the admin saves a product/category/section/promo-code, the backend automatically detects whether the text is English or Arabic, routes it into the correct column (`title` for English, `title_ar` for Arabic — even if the admin typed into the "wrong" field), and translates the other side. Both English and Arabic always end up populated in the database, and both are returned in API responses. The admin can still edit either side manually at any time — manual values always win over auto-translation.

The mobile app keeps consuming `title`/`title_ar`, `description`/`description_ar`, etc. — no client change needed.

This doc lists everything you (the deploy operator) need to do.

---

## TL;DR — what you have to do

1. Create a Google Cloud project + enable Cloud Translation API + generate an API key (~5 min).
2. Add 2 environment variables to `.env`.
3. Restart the backend.
4. (Optional) Run the one-time backfill script for existing rows.

That's the whole list. The code is already wired and tested. Azure is also supported as an alternative — see the bottom of this doc.

### Free tier (verified May 2026)

| Provider | Free tier | Beyond free tier | Notes |
|---|---|---|---|
| **Google Cloud Translation** *(default)* | **500,000 chars/month** | $20 per 1M chars | Free tier never expires, resets monthly. Applies to v2 NMT and v3 Basic/Advanced NMT. |
| Azure AI Translator | 2,000,000 chars/month | ~$10 per 1M chars | F0 tier, no time limit. |

For a boutique catalog (~5K products, low monthly write volume), Google's 500K/month is **plenty** — you'll likely never see a bill. The one-time backfill of an existing catalog (~1–2M chars) would cost roughly $20–30 once, then ongoing usage stays inside the free tier.

---

## 1. Create a Google Cloud Translation API key (~5 minutes)

### 1.1 Sign in / create a Google Cloud account

1. Go to <https://console.cloud.google.com> and sign in with any Google account (Gmail works).
2. Accept the terms if prompted. First-time users get a **$300 free credit** (you won't need it — Translation has its own permanent free tier).

### 1.2 Create (or pick) a project

1. Top bar → click the project dropdown → **NEW PROJECT**.
2. Name it `amoon-bloom` (or anything) → **Create**.
3. Wait ~10 seconds, then make sure the new project is selected in the top bar.

### 1.3 Enable the Cloud Translation API

1. In the search bar at the top of the console, type **"Cloud Translation API"** and click the result.
2. Click **Enable**. (If you haven't yet enabled billing on the project, Google will prompt you to set up a billing account here. The card is for identity verification — Translation stays free under the monthly cap.)
3. Wait ~30 seconds.

### 1.4 Create the API key

1. Left sidebar → **APIs & Services → Credentials** (or search "Credentials" in the top bar).
2. Click **+ CREATE CREDENTIALS** → **API key**.
3. A modal pops up with your key. **Copy it now** — this is `GOOGLE_TRANSLATE_API_KEY`.
4. Click **Edit API key** (or the pencil icon next to the new key in the list).
5. Under **API restrictions**:
   - Select **Restrict key**.
   - Tick **Cloud Translation API** only.
   - Save.

   This means the key can only call the Translation API — if it ever leaks, attackers can't use it to drain your other Google services.
6. (Optional but recommended) Under **Application restrictions** → set **IP addresses** and add your backend server's outbound IP (Railway shows this in the project dashboard). If your IP is dynamic, skip this and rely on the API restriction above.

---

## 2. Environment variables

Add these to your **`.env`** (local dev) and to **Railway → Variables** (production).

### Required

| Variable | Value | Notes |
|---|---|---|
| `TRANSLATION_PROVIDER` | `google` | Set to `none` (or unset key) to disable auto-translation entirely. |
| `GOOGLE_TRANSLATE_API_KEY` | `<your API key>` | From step 1.4 above. Treat as a secret — never commit to git. |

### Optional tuning (sensible defaults already set)

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_TRANSLATE_ENDPOINT` | `https://translation.googleapis.com` | Only override if Google publishes a regional endpoint you must use. |
| `TRANSLATION_TIMEOUT_MS` | `5000` | Max ms to wait for one translate call before giving up. |
| `TRANSLATION_RETRY_ATTEMPTS` | `1` | Retries on 5xx / network errors. 4xx never retries (fails fast). |
| `TRANSLATION_CACHE_MAX` | `5000` | In-memory LRU cache size (entries). Repeat strings cost $0. |

### Example block

```env
# --- Auto-translation (Google Cloud Translation) ---
TRANSLATION_PROVIDER=google
GOOGLE_TRANSLATE_API_KEY=AIzaSyA-your-key-here...
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

- **Google Cloud Console** → your project → **APIs & Services → Dashboard** → click "Cloud Translation API" → see request count and character usage charts.
- **Quotas**: same screen → Quotas tab. Confirms your free monthly quota (500K chars) and how much you've used.
- Free tier resets on the 1st of each month. Stay under 500K chars/month (Google) or 2M chars/month (Azure) to pay $0.

---

## What to do if something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Server logs `GOOGLE_TRANSLATE_API_KEY missing` | Env not picked up | Verify `.env` is loaded; restart server |
| Test script reports `400 API key not valid` | Wrong/copied with whitespace | Re-copy from Google Cloud Console → APIs & Services → Credentials |
| Test script reports `403 PERMISSION_DENIED` | API key is restricted to a different API or IP | Check the key's API restrictions allow **Cloud Translation API**; loosen IP restriction if blocking your IP |
| `403 has not been used in project … or it is disabled` | Cloud Translation API not enabled on the project the key belongs to | Console → search "Cloud Translation API" → Enable |
| `429 Too Many Requests` / `RESOURCE_EXHAUSTED` | Quota exhausted (over 500K/month) | Either wait for monthly reset (1st of next month) or add billing to keep going at $20/M |
| Arabic comes back garbled / English passes through | Network failure mid-call | Check `[translation]` logs; transient — admin can re-save |

---

## Files added/changed

```
src/services/translation.service.js   # Multi-provider wrapper (google/azure/none)
src/utils/bilingual.js                # autoTranslate / autoTranslateMany helpers
src/services/category.service.js      # wired
src/services/section.service.js       # wired
src/services/product.service.js       # wired (parent + descriptions + options)
src/services/promoCode.service.js     # wired
src/config/env.js                     # registers translation env vars
scripts/backfill-translations.js      # one-time backfill for existing rows
scripts/test-translation.js           # smoke test (offline + live modes)
docs/translation-setup.md             # this doc
```

---

## Alternative: using Azure AI Translator instead

The codebase supports Azure as a drop-in alternative. Switch by changing two env vars — no code change.

### Create the Azure resource

1. Go to <https://portal.azure.com> → **Create a resource** → search **"Translator"** → **Create**.
2. Form values:
   - **Subscription**: any active subscription.
   - **Resource group**: `amoon-bloom` (or any).
   - **Region**: any (e.g. `UAE North`, `West Europe`). Save the value — it goes in `AZURE_TRANSLATOR_REGION`.
   - **Name**: e.g. `amoon-translator`.
   - **Pricing tier**: **Free F0** (2M chars/month, $0). Do not pick S1 by accident.
3. After ~30 seconds the resource is ready → left sidebar → **Keys and Endpoint** → copy **KEY 1**.

### Env vars

```env
TRANSLATION_PROVIDER=azure
AZURE_TRANSLATOR_KEY=abcdef0123456789...
AZURE_TRANSLATOR_REGION=uaenorth
```

Set `TRANSLATION_PROVIDER=azure` (instead of `google`) and the runtime switches without any other change. Both providers go through the same wrapper, cache, retry, batching, and bilingual helper — your services don't know the difference.

### When Azure makes more sense than Google

- **Higher free volume**: Azure F0 gives 2M chars/month (4× Google's 500K).
- **Microsoft-shop environments**: if you're already on Azure for other services, billing is consolidated.
- **Slightly more consistent translations for formal/technical text** (per public benchmarks). Google tends to win on casual / marketing copy, but the difference is small.
