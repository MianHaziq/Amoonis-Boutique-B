# App Developer Guide — Auto-Translation (Bilingual Fields)

> **TL;DR:** Every admin-managed text field (product/category/section/promo-code) now has an English column and an Arabic column. The backend automatically fills the missing language when the admin saves only one side. The admin panel should make **Arabic fields optional** (not required) with a hint like *"Leave empty to auto-translate from English"*. The API always returns **both** languages in responses. After auto-translation, the admin can re-edit either side at any time.

---

## 1. What the backend now does for you

When the admin saves a product (or category / section / promo code), the backend will:

1. Look at every bilingual field pair (`title` ↔ `title_ar`, `description` ↔ `description_ar`, etc.).
2. If the admin filled **only English** → backend auto-translates and stores Arabic too.
3. If the admin filled **only Arabic** → backend auto-translates and stores English too.
4. If the admin filled **both** → backend leaves them exactly as typed (manual edit wins).
5. If admin filled **neither** → both stay empty.

It also **detects language by content**, not by which field the admin typed into. So if the admin accidentally types Arabic into the English field, the backend will route it to the correct column automatically.

The translation provider is **Google Cloud Translation**, free up to 500K chars/month. The backend handles caching, batching, retry, and timeouts internally — you don't need to do anything.

---

## 2. Bilingual fields — full list

These are all the fields that have an English/Arabic twin. You'll find them on the existing models you already integrate with:

| Model | English field(s) | Arabic field(s) |
|---|---|---|
| **Category** | `title`, `description` | `title_ar`, `description_ar` |
| **Section** | `title` | `title_ar` |
| **Product** | `title`, `subtitle` | `title_ar`, `subtitle_ar` |
| **ProductDescription** (rows inside a product) | `title`, `description` | `title_ar`, `description_ar` |
| **ProductOption** (rows inside a product) | `title`, `options[]` (string array) | `title_ar`, `options_ar[]` (string array) |
| **PromoCode** | `name`, `description` | `name_ar`, `description_ar` |

**Banners** have no text — no changes needed there.

---

## 3. Admin panel UI/UX — what to change

> The admin form currently has separate input fields for every Arabic value, and they're required. **Make them optional and add a hint.** The backend will auto-fill if left blank.

### Validation rule

For every bilingual pair (e.g. `title` + `title_ar`), the backend enforces **"at least one side must be filled"**:

- Send only `title` → ✓ valid, Arabic auto-filled
- Send only `title_ar` → ✓ valid, English auto-filled
- Send both → ✓ valid, manual values kept verbatim
- Send neither → ✗ 400 validation error: *"Title is required — provide either 'title' or 'title_ar'"*

Same applies to:
- `description` / `description_ar` on Category
- `name` / `name_ar` on PromoCode
- Each row of `descriptions[]` on Product (must have one of `description` / `description_ar`)
- Each row of `productOptions[]` on Product (must have one of `title` / `title_ar`)

This means **Arabic fields are no longer required** on the admin form — make them optional in your UI.

### Per-field UX

For every bilingual pair, keep both fields visible but change them as follows:

```
┌─────────────────────────────────────────────────────┐
│  Title (English) *                                  │
│  ┌─────────────────────────────────────────────┐   │
│  │ Red roses bouquet                           │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  Title (Arabic)         ✨ Auto-translate          │
│  ┌─────────────────────────────────────────────┐   │
│  │                                             │   │
│  └─────────────────────────────────────────────┘   │
│  Leave empty to auto-translate from English        │
└─────────────────────────────────────────────────────┘
```

Specific changes:

1. **Arabic field label** — append "(optional)" or show a small sparkle/AI icon (✨ or similar) to signal it can be auto-generated.
2. **Placeholder** in the empty Arabic field: `"Leave empty to auto-translate from English"` (and vice versa for the English field, in case admin types Arabic only).
3. **Validation** — Arabic field must **NOT** be required. Allow submit when only English is filled. *At least one of the two sides should be required* (don't allow both empty).
4. **After save** — the response will contain the auto-filled value. Re-populate the form / detail screen with **both** fields so the admin can see what was generated and edit it if they want.

### Visual indicator that a value was auto-translated (recommended)

The backend doesn't currently flag whether a value was auto-translated vs. typed manually — both end up in the same column. If you want to show "Auto-translated" badges in the UI, you can keep that state on the frontend:

- Before submit: track which fields the admin actually typed in.
- After submit: any field that came back filled but wasn't typed in → mark as "auto-translated" in your UI state.
- Display a small badge: `🤖 Auto-translated · click to edit`.

This is a nice-to-have, not required for the feature to work.

### Skipping auto-translation entirely

The admin can also fill **both** sides manually — when both are non-empty, the backend leaves them exactly as typed (no auto-translation runs).

---

## 4. API payloads — examples

> **No new endpoints.** The existing create / update endpoints accept the same shape as before — you just don't have to fill `*_ar` fields anymore.

Base URL: `/api/v1` (or `/api/*` for legacy).

### Create a category

**Request** `POST /api/v1/categories`

```json
{
  "title": "Flowers",
  "description": "Fresh cut bouquets for every occasion",
  "image": "https://cdn..."
}
```

**Response**

```json
{
  "id": "uuid…",
  "title": "Flowers",
  "title_ar": "زهور",
  "description": "Fresh cut bouquets for every occasion",
  "description_ar": "باقات طازجة لكل مناسبة",
  "image": "https://cdn…",
  "totalProducts": 0,
  "createdAt": "2026-05-13T…",
  "updatedAt": "2026-05-13T…"
}
```

### Creating a category with ONLY Arabic

This is now fully supported. The admin can type only Arabic and the English column will be filled automatically:

**Request** `POST /api/v1/categories`

```json
{
  "title_ar": "زهور",
  "description_ar": "باقات طازجة لكل مناسبة"
}
```

**Response**

```json
{
  "id": "uuid…",
  "title": "Flowers",
  "title_ar": "زهور",
  "description": "Fresh bouquets for every occasion",
  "description_ar": "باقات طازجة لكل مناسبة",
  …
}
```

### Manual override

If you want to **override** the Arabic with a hand-crafted version, include both:

```json
{
  "title": "Flowers",
  "title_ar": "ورود مختارة",     // your manual version — kept as-is
  "description": "Fresh cut bouquets for every occasion"
}
```

Backend sees `title` AND `title_ar` both filled → doesn't translate, stores both verbatim.

### Create a product (with descriptions + options)

**Request** `POST /api/v1/products`

```json
{
  "title": "Wedding gift bouquet",
  "subtitle": "Premium roses arrangement",
  "price": 299.00,
  "discountedPrice": 249.00,
  "quantity": 50,
  "categoryId": "uuid…",
  "images": ["https://…", "https://…"],
  "descriptions": [
    {
      "title": "Materials",
      "description": "Imported fresh roses, premium wrap, satin ribbon"
    },
    {
      "title": "Care instructions",
      "description": "Keep in cool place, change water every 2 days"
    }
  ],
  "productOptions": [
    {
      "title": "Size",
      "options": ["Small", "Medium", "Large"]
    },
    {
      "title": "Wrap color",
      "options": ["White", "Pink", "Gold"]
    }
  ]
}
```

**Response** — every `*_ar` field is filled automatically:

```json
{
  "id": "uuid…",
  "title": "Wedding gift bouquet",
  "title_ar": "باقة هدية الزفاف",
  "subtitle": "Premium roses arrangement",
  "subtitle_ar": "ترتيب الورود الفاخر",
  "price": 299.00,
  "discountedPrice": 249.00,
  "quantity": 50,
  "category": { "id": "uuid…", "title": "Flowers" },
  "images": ["https://…", "https://…"],
  "image": "https://…",
  "descriptions": [
    {
      "id": "uuid…",
      "title": "Materials",
      "title_ar": "المواد",
      "description": "Imported fresh roses, premium wrap, satin ribbon",
      "description_ar": "ورود طازجة مستوردة، تغليف فاخر، شريط من الساتان"
    },
    {
      "id": "uuid…",
      "title": "Care instructions",
      "title_ar": "تعليمات العناية",
      "description": "Keep in cool place, change water every 2 days",
      "description_ar": "احفظها في مكان بارد، غيّر الماء كل يومين"
    }
  ],
  "productOptions": [
    {
      "id": "uuid…",
      "title": "Size",
      "title_ar": "الحجم",
      "options": ["Small", "Medium", "Large"],
      "options_ar": ["صغير", "وسط", "كبير"]
    },
    {
      "id": "uuid…",
      "title": "Wrap color",
      "title_ar": "لون التغليف",
      "options": ["White", "Pink", "Gold"],
      "options_ar": ["أبيض", "وردي", "ذهبي"]
    }
  ],
  "createdAt": "…",
  "updatedAt": "…"
}
```

### Create a section

**Request** `POST /api/v1/sections`

```json
{
  "title": "Ramadan Deals",
  "image": "https://…",
  "productIds": ["uuid…", "uuid…"],
  "categoryIds": ["uuid…"]
}
```

Response will contain `title_ar` auto-filled.

### Create a promo code

**Request** `POST /api/v1/promo-codes`

```json
{
  "code": "RAMADAN2026",
  "name": "Ramadan Special 20% off",
  "description": "20% off on all products during Ramadan",
  "discountType": "PERCENTAGE",
  "discountValue": 20,
  "appliesTo": "ALL_PRODUCTS"
}
```

Response will contain `name_ar` and `description_ar` auto-filled.

---

## 5. ⚠️ Critical: How to handle the EDIT screen

This is the most important section. Read it carefully.

### The rule

The backend's "manual override wins" rule **only triggers when both the English and Arabic fields are present in the request payload**. If you send only one of them, the backend assumes you want auto-translation and **will overwrite the other side**.

### What this means for the edit form

✅ **DO**: When the admin opens an edit screen, **load the full record from the API** (both `title` and `title_ar`), and **submit BOTH fields back** on save — even if the admin only changed one of them.

```json
// On the edit screen, load:
{ "title": "Red roses", "title_ar": "ورود حمراء" }

// Admin fixes a typo in title_ar only. On save, SEND BOTH:
{ "title": "Red roses", "title_ar": "ورود حمراء بقايا" }   // ✓ correct
```

❌ **DON'T**: Send only the field that changed. This will trigger auto-translation and overwrite the other side.

```json
// Admin fixes a typo in title_ar only. WRONG payload:
{ "title_ar": "ورود حمراء بقايا" }   // ✗ backend will re-translate title from this and overwrite the English
```

### How most admin forms already work

If your admin UI is built with a standard form pattern (e.g. React state holding the full object, submitting all fields on save), **you're already doing it right**. This is the default for almost every admin panel.

If your form is doing PATCH-style partial updates (only sending changed fields), you need to either:

1. Switch to sending the whole record on save, OR
2. Send the unchanged twin field alongside the changed one (effectively the same thing), OR
3. Tell me and I'll add an `autoTranslate: false` flag the backend will respect.

### Quick mental check

> "When the admin saves an edit, is BOTH `title` AND `title_ar` in my request body?"

If yes → you're good. If no → fix it before shipping.

---

## 6. Error handling — what happens if Google API fails

The translation never blocks an admin save. Worst case:

| Scenario | Result |
|---|---|
| Google returns 5xx / network drop | Backend retries once. If still failing → admin's input is saved exactly as typed; the other side stays `null`. Save succeeds. |
| Google quota exhausted (over 500K/month) | Same as above. |
| Timeout (>5 seconds) | Same as above. |
| Backend service down | Standard 5xx — same handling as any other API failure. |

### What to show in the UI

After a successful save, **always check the response** for the bilingual pair:

- Both filled → all good.
- Only one side filled → Google probably failed. Show a small non-blocking warning to the admin: *"Arabic translation couldn't be generated automatically. You can add it manually or save again later."* and keep the record viewable as normal.

No special API field tells you "translation failed" — just check whether the `*_ar` side came back populated.

---

## 7. Testing checklist for the admin panel integration

Before shipping, verify each of these on the admin panel:

- [ ] Create category with only English `title` → Arabic comes back filled in response
- [ ] Create category with only Arabic `title_ar` → English comes back filled
- [ ] Create category with **both** English and Arabic → both stored exactly as typed (no overwrite)
- [ ] Create category with **neither** title nor title_ar → returns 400 validation error
- [ ] Edit existing category, change only English → re-save → Arabic preserved (because you send both fields)
- [ ] Create product with **only** Arabic title and Arabic description → all `_ar` fields are taken as the input, English fields auto-filled
- [ ] Create product with descriptions and options where each row has only Arabic → translates each row
- [ ] Create a promo code with `name_ar` only → `name` auto-filled
- [ ] Try saving with a forced backend failure (disable network) → save still succeeds; the column the admin typed in gets their text, the other column gets the same text as a fallback. UI doesn't crash.
- [ ] Mobile app displays correct language based on user locale

---

## 8. Summary for the dev

1. **No new API endpoints.** Same routes you already use.
2. **Arabic fields become optional** on every admin form. Add a hint: *"Leave empty to auto-translate"*.
3. **API responses always contain both languages** — your mobile app already uses `title_ar` etc., so nothing changes there.
4. **On edit/save, always send BOTH the English and Arabic field values** — even if the admin only changed one. This is the only behavior gotcha.
5. **Translation is automatic, soft-failing, and free** (under 500K chars/month) — nothing for you to configure on the client.

If anything's unclear or you need a behavior flag (`autoTranslate: false`), ask the backend team — easy to add.
