# Thumbnails explained

Every gallery card now shows a picture of the shader. This page covers how the picture gets made,
where it's stored, how it's served, and why each choice was made. Interview questions are at the end.

**What a user sees.** You edit a shader. A few seconds after your code compiles, the gallery card
shows what your preview looks like. Old shaders with no picture get one the first time anyone opens
them. Until then their card shows a colored gradient, picked from the shader's id so it stays the same.

---

## The big decision: who renders the picture?

| Option | Cost | Problem |
|---|---|---|
| Render every shader live in the gallery | No storage | Browsers allow ~16 WebGL contexts per page. 24 cards is too many, and compiling 24 shaders on every visit is slow on a laptop and worse on a phone |
| Render on the server (headless GPU) | A GPU, or slow software rendering | Running untrusted shader code on our server, and a GPU we'd have to pay for |
| **The editor's browser captures its own preview and uploads it** | ~5–30 KB per shader | The upload is untrusted, so it must be validated (below) |

The editor already has the shader compiled and running. Capturing one frame costs almost nothing
there, so the person who changes the shader pays for its picture.

---

## 1. Capturing a frame: `capture()` in `web/src/renderer.ts`

- The WebGL canvas is created with `preserveDrawingBuffer: false`, which is faster. The browser may
  wipe the pixels as soon as a frame is shown, so reading "whatever's on screen" gives a blank or
  stale image. `capture()` **draws a frame and copies it in the same task**, before the browser can
  wipe it.
- It copies onto a 320×180 2D canvas with a "cover" crop: scale until it fills the box, then cut off
  the overflow. Every card is the same 16:9 shape whatever size your preview window was.
- **WebP, falling back to JPEG.** WebP is the smallest. Safari can't *encode* WebP, and
  `toBlob('image/webp')` quietly returns a PNG there instead. PNG is lossless and large for noisy
  shader output, so if the result isn't WebP we re-encode as JPEG.

## 2. When to capture: `Editor.tsx`

The rule is **whoever is typing takes the picture.**
- `ytext.observe` counts edits where `transaction.local` is true, meaning edits this browser made.
  Edits arriving from other people over the WebSocket have `local = false`. If five people are
  watching one person type, only the typist uploads.
- After a compile **succeeds**, if there are local edits since the last upload, a capture is
  scheduled 3 s later, so the code settles and the animation runs a little. Each new compile resets
  that timer, which is a debounce.
- No capture while there's a compile error. The renderer keeps running the *previous* working
  program in that case, so the picture wouldn't match the code.
- At most one upload per 15 s per browser. If the server answers 429 because someone else just
  uploaded, the client waits for the `Retry-After` and tries again.
- **Backfill.** If the shader's metadata says `thumbnailAt: null`, the first successful compile
  uploads one even without edits. Old shaders fill in as people visit them.

## 3. Storing it: migration 4 and `store.ts`

```sql
CREATE TABLE thumbnails (
  shader_id     TEXT PRIMARY KEY REFERENCES shaders(id) ON DELETE CASCADE,
  image         BYTEA NOT NULL,
  content_type  TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
- **A separate table, not a column on `shaders`.** The two change at different rates and are read by
  different requests: the document is saved every second while someone types, the image every ~10 s
  at most, and the gallery needs only "is there one, and which version".
  - Postgres already moves big values out of the row ("TOAST"), and an `UPDATE` that doesn't change
    them reuses the pointer. So this isn't about copying bytes.
  - The separate table keeps image writes off the hot `shaders` row, so they don't contend with
    document saves. It also lets the gallery `LEFT JOIN` on the primary key and read only
    `updated_at`.
  - It's also the shape you'd want when moving images to object storage later: swap one table for a
    URL column.
- **`ON DELETE CASCADE`**: deleting a shader deletes its picture.
- **Upsert that can't hit a foreign-key error.**
  `INSERT INTO thumbnails ... SELECT id, $2, $3 FROM shaders WHERE id = $1 ON CONFLICT (shader_id) DO UPDATE ...`
  - If the shader doesn't exist, the SELECT returns no rows, so nothing is inserted and `rowCount` is
    0. The route turns that into a 404.
  - `updated_at = GREATEST(now(), old + 1 ms)` makes the version strictly increase, which the
    caching below depends on.
- **Forks copy the thumbnail** (`copyThumbnail`): same code, same picture, until someone edits the fork.
- Why Postgres and not S3: at 5–30 KB each, 10,000 shaders is about 300 MB. That's fine in the
  database, with one fewer service to run. Past that, or behind a CDN, object storage would be the move.

## 4. Validating uploads: `server/src/thumbnails.ts`

The upload comes from a browser, which means it could come from anyone with `curl`. So:
- **Magic bytes, not the Content-Type header.** `sniffImage` reads the file's own signature:
  - PNG starts with `89 50 4E 47 ...`
  - JPEG starts with `FF D8`
  - WebP is `RIFF....WEBP`

  It then parses the width and height (from PNG's IHDR chunk, JPEG's start-of-frame segment, or one
  of WebP's three layouts). Anything else is a 400, even if it claims to be `image/png`. The type
  stored is the one *found in the bytes*.
- **Limits:** at most 150 KB (Fastify answers 413 before the route even runs) and at most 640×640
  pixels. A tiny file can still declare a huge size, so the dimension check matters too.
- **Rate limit:** `WriteLimiter` allows one stored write per shader per 10 s (429 with `Retry-After`).
  However many clients or scripts try, the database write rate stays bounded. The check runs after
  validation, so a rejected upload doesn't use up the slot.
- **Serving it safely:** `X-Content-Type-Options: nosniff` (the browser must believe our type and not
  guess) plus `Content-Security-Policy: default-src 'none'`. Even if something slipped through, the
  response can't run as a page.

## 5. Serving it fast: cache headers

- The gallery requests `/api/shaders/<id>/thumbnail?v=<thumbnailAt in ms>`. That URL only ever means
  one image, because a new upload changes `thumbnailAt` and so the URL. So the server answers
  `Cache-Control: public, max-age=31536000, immutable`. After the first visit the browser never asks
  again.
- Without `?v` (or with an old one) it answers `no-cache` with an `ETag`. The browser revalidates
  each time and gets a bodiless `304 Not Modified` if nothing changed.
- This is the same "cache busting" trick as Vite's hashed asset names (`index-BMDpjJtP.js`).
- `loading="lazy"` on the `<img>`: cards below the fold aren't fetched until you scroll near them.

## 6. Tests: `server/test/thumbnails.test.ts`

The HTTP tests run against MemoryStore and again against Postgres when `TEST_DATABASE_URL` is set.
- `sniffImage` on real PNGs (built in the test with zlib), JPEG headers, and all three WebP
  layouts; HTML, GIF, truncated, and empty input rejected.
- Upload, then download: same bytes, `nosniff`, and the CSP.
- WebP declared as PNG is stored as WebP.
- Versioned URL is immutable, bare URL is `no-cache`, and the ETag gives 304. A new upload
  invalidates both.
- Rejections: HTML pretending to be PNG (400), 2000-pixel-wide (400), over 150 KB (413), JSON or
  `text/html` (415). None of them are stored.
- Rate limit (429 with Retry-After, then allowed again), unknown shader (404), malformed id (400).
- The gallery shows `thumbnailAt`, and a fork gets the same image.

**Checked in a real browser** (production build). Opening an old shader backfilled a 320×180 WebP.
Changing the code to solid red produced a new thumbnail whose center pixel was red. The gallery
cards' image URLs all came back 200 and immutable.

---

## Interview questions

**1. Why capture thumbnails in the browser instead of rendering them on the server?**
> The editor already has the shader compiled and on screen, so capturing a frame is nearly free.
> Server-side rendering means running untrusted GPU code and paying for a GPU. Rendering live in the
> gallery hits the browser's WebGL context limit (~16) and compiles dozens of shaders per visit.
> The trade-off is that uploads are untrusted, so I validate them on the server.

**2. How do you know an upload is really an image?**
> I ignore the Content-Type and read the magic bytes, then parse the dimensions from the format's
> header. I enforce 150 KB and 640×640, store the detected type, and serve it with `nosniff` and a
> `default-src 'none'` CSP.

**3. How can the browser cache thumbnails forever when they change?**
> The URL includes the version (`?v=updatedAt`). A new image means a new URL, so each URL is immutable.
> Requests without the version get `no-cache` plus an ETag, for 304s.

**4. Five people are editing one shader. How many uploads happen?**
> Only clients with local edits capture. The server allows one write per shader per 10 s, and the
> others get 429 with Retry-After and back off. So it's at most one write per 10 s, whatever the
> number of people.

**5. Why a separate table?**
> The document and the image change at different rates and are read by different queries. Every
> update writes a new row version, so a separate table keeps image uploads from contending with the
> document saves on the hot `shaders` row. The gallery reads only the thumbnail's timestamp through
> a primary-key join. (Large values are TOASTed and reused when unchanged, so it isn't about copying
> bytes.) It's also easy to swap for object storage later.

**6. What happens on Safari?**
> It can't encode WebP, and `toBlob` silently gives a PNG. I check the blob's type and re-encode as
> JPEG, which is much smaller than PNG for noisy images.
