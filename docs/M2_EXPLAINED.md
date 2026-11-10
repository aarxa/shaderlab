# M2 explained: titles, forking, and the gallery

What was built, file by file, in plain language: what each piece does, **why** it's built that way,
and what would break without it. At the end: interview questions with answers, and one small change
for you to make yourself.

**What a user can now do:** give a shader a title (it syncs live to everyone editing), click **Fork** to
get their own copy, and browse every shader on **/gallery**, newest first, with "Load more".

---

## The big picture: where each piece of data lives

| Data | Lives in | Why there |
|---|---|---|
| The code | Yjs document (`Y.Text 'code'`) | Character-level merging when two people type at once |
| The title | Yjs document (`Y.Map 'meta'`, key `title`) **and** a `title` column | The document makes it sync live; the column lets the gallery list titles without opening every document |
| Who it was forked from | `forked_from` column | Set once at creation, never edited, so it doesn't need to sync |
| Created / updated time | `created_at`, `updated_at` columns | Sorting and paging the gallery |

The Yjs document is the **source of truth** for the title. The column is a **denormalized copy**,
refreshed every time the document is saved. "Denormalized" means stored twice on purpose for read speed.

---

## 1. Migrations: `server/src/migrations.ts`

**Problem.** Before M2 the server ran `CREATE TABLE IF NOT EXISTS shaders (...)` on startup. That can
create a table but never **change** one. The live database on Render already has a `shaders` table
with real data, so adding a `title` column needs a different tool.

**What a migration is.** A numbered, append-only list of schema changes. The database remembers which
ones it has applied (in a `schema_migrations` table) and applies only the new ones, in order. Every
copy of the database (yours, CI's, Render's) ends up with the same schema by the same path.

**The three migrations:**
1. `create shaders`: the original table, still `IF NOT EXISTS`, because databases created before
   migrations existed already have it. (Verified on your local database, which had 5 old shaders.)
2. `title and forked_from`: `title` defaults to `'Untitled'`, so existing rows get a value
   automatically. `forked_from` references another shader; `ON DELETE SET NULL` means deleting an
   original won't delete or break its forks, the link just becomes empty.
3. `gallery index`: an index on `(created_at DESC, id DESC)`. See section 4.

**The `migrate()` function, step by step:**
1. **Takes an advisory lock** (`pg_advisory_lock`). If two server instances start at the same moment
   (normal during a deploy), both would try to apply migration 2 and the second would crash with
   "column already exists". The lock makes the second wait until the first is finished; it then sees
   nothing left to do.
2. Creates `schema_migrations` if missing, and reads which versions are done.
3. For each new migration: **`BEGIN` → run SQL → record the version → `COMMIT`**. If anything fails,
   `ROLLBACK` undoes all of it and the version isn't recorded, so the next start retries from a clean
   state. Postgres can roll back schema changes (many databases can't); that's what makes this safe.
4. Releases the lock.

**Why the SQL is in a `.ts` file, not `.sql` files:** the Dockerfile only copies the compiled `dist/`
folder into the image. SQL files sitting next to the code would be silently left out, and the server
would start with no migrations. Keeping them in TypeScript means they're compiled in.

**Rule:** never edit a migration that has shipped. If migration 2 is wrong, write migration 4 to fix it.
Databases that already ran migration 2 would never see your edit.

---

## 2. Titles: `collab.ts` (`Room.persist`), `store.ts` (`cleanTitle`), `Editor.tsx`

**In the browser** (`Editor.tsx`): the title box reads `meta.get('title')` and on every keystroke calls
`meta.set('title', value)`. `meta.observe(...)` updates the box when *someone else* changes it. That's
all it takes to sync: the same WebSocket connection that carries code edits carries this too. No new
endpoint, no new protocol.

**Map vs. Text: a deliberate difference.** The code is a `Y.Text`, which merges character by
character: if two people type in different places, both edits survive. The title is one value in a
`Y.Map`, so each change **replaces** the whole title, and if two people type at the same instant the
later one wins ("last writer wins"). For a short title that's fine and simpler. For the code it would
be terrible.

**On the server** (`Room.persist`): saves are debounced (at most once a second per shader). Each save
now reads the title out of the document, cleans it with `cleanTitle`, and writes both the document and
the title column in one `UPDATE`.

**`cleanTitle`: why the server cleans it.** The browser box has `maxLength={80}`, but that's just a
suggestion: anyone can open dev tools or write their own client and send a 10,000-character title.
**Anything the client enforces, the server must enforce again.** `cleanTitle` trims whitespace,
collapses runs of spaces, cuts to 80 characters (by code point, so it never splits an emoji in half),
and falls back to "Untitled" if empty or not a string.

Note the limit: we clean the *column*, not the document. Someone could still put a giant title in the
shared document; the gallery stays clean, and the editor box just shows the long text. Fully blocking
that means validating updates as they arrive. That's M3 territory, with read-only permissions.

---

## 3. Forking: `POST /api/shaders/:id/fork` in `app.ts`, plus `RoomManager.snapshot` in `collab.ts`

**What it does:** creates a new shader containing the original's current code, titled
"Fork of *original title*", with `forked_from` pointing back. Returns `{ id }`; the browser then opens it.

**The trap, and why `snapshot()` exists.** Saves are debounced by 1 second. If people are editing the
original *right now*, their last second of typing exists only in the server's memory, not in Postgres
yet. If fork read from Postgres, it would silently drop those edits. So `readSource()` asks
`rooms.snapshot(id)` first:
- **Someone has it open?** Use the live in-memory document. It's the newest version there is.
- **Nobody has it open?** Then there are no unsaved edits, and Postgres is up to date.

The first fork test checks exactly this: type, wait 100 ms (on the server but not saved), fork, and
check the fork contains the edit.

**A smaller race inside that.** Between finding the room and reading it, the last user could leave
and the room could unload. Rooms always save *before* unloading and set a `destroyed` flag, so
`snapshot()` returns null and we fall back to Postgres, which by then has everything.

**Fresh document vs. copied state: a design choice.** A Yjs document's saved state contains its whole
edit history: deleted text is kept as "tombstones" so merging works. Copying that into the fork would
make every fork of a fork carry the full history of every ancestor. Instead the fork is a **brand-new
document with a copy of the current text**. Its history starts at the fork.

**The title has to go in the document too.** The fork's title is set in its new document's `meta`
map, not just its column. Otherwise the first save would read the title from the document and
overwrite "Fork of Plasma" with whatever was there.

**Consistency model** (a likely interview question): a fork is a **snapshot at one moment**. Edits made
to the original after that moment don't appear in the fork, and edits to the fork never touch the
original. There's a test for the second part.

---

## 4. The gallery: `GET /api/shaders` in `app.ts`, `list()` in `store.ts`, `Gallery.tsx`

**Request/response:** `GET /api/shaders?limit=24&cursor=...` returns
`{ items: [...], nextCursor: "..." | null }`. Use `nextCursor` to get the next page; `null` means the end.

### Why a cursor, not page numbers
The obvious version is `?page=2` → `ORDER BY created_at DESC LIMIT 20 OFFSET 20`. It has two problems:

1. **Repeats and skips.** You load page 1 (shaders 1–20). Someone creates a shader, so everything
   shifts down by one. Page 2 (`OFFSET 20`) now starts at what used to be shader 20, which you already
   saw. Deletions cause the opposite: a skip. One test does exactly this and checks there are no repeats.
2. **It gets slow.** `OFFSET 10000` makes Postgres find and throw away 10,000 rows before returning 20.
   Deep pages get slower and slower.

**A cursor says "start after this exact row"** instead of "skip N rows." The cursor holds the last
row's `(created_at, id)`, and the next page is:
```sql
WHERE (created_at, id) < ($cursor_time, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT 25
```
New shaders appear *above* the cursor and can't push anything into your next page. With the index,
Postgres jumps straight to the cursor position, so page 500 is as fast as page 1.

### The three details that make it correct
1. **The `id` tiebreak.** Two shaders can have the same `created_at`. Sorting by time alone leaves
   their order undefined, so pages can repeat or lose them. Adding `id` makes the order total (every
   row has exactly one position). The row comparison `(created_at, id) < (t, id)` matches that order.
2. **Microsecond precision: a real bug I demonstrated.** Postgres stores timestamps to the
   microsecond; a JavaScript `Date` only has milliseconds. Building the cursor from a JS Date rounds
   12:00:00.123**456** down to 12:00:00.123, so rows in that millisecond fall on the wrong side of the
   cursor. When I switched to a JS-Date cursor, the test with five same-timestamp shaders **skipped
   four of them** on page 2. The fix: the cursor carries Postgres's own text form of the timestamp
   (`created_at::text`), which Postgres converts back exactly.
3. **Fetch one extra row.** We ask for `limit + 1` rows. If we get the extra one, there's another page,
   so we return a `nextCursor`; if not, we return `null`. No separate `COUNT(*)` query needed.

**The index** `(created_at DESC, id DESC)` is in the same column order as the `ORDER BY`. Postgres
reads the index in order and stops after 25 entries, with no sorting. A test runs `EXPLAIN` and checks
the plan uses that index with no Sort step.

**The cursor is opaque:** base64 of `[timestamp, id]`. Clients treat it as a meaningless string, so
we can change its format later without breaking anyone. Garbage cursors are checked (shape, id
format, timestamp characters) and return **400**. And if one gets through that check but isn't a real
time, Postgres raises a data error (code class 22), which is also turned into a 400, not a crash.

**Page size:** `limit` defaults to 20 and is clamped to 1–50, so nobody can request a million rows.

**`Gallery.tsx`:** loads 24 at a time and appends each page; "Load more" passes the last `nextCursor`.
The "forked from" text shows the original's title when it's already on screen.

---

## 5. Tests: what proves it works

`server/test/m2.test.ts` (10 tests, in-memory store, real WebSocket clients):
- titles: default "Untitled"; a title set in the document is saved; 500-character titles are capped.
- fork: includes unsaved live edits; records `forkedFrom` and "Fork of …"; editing the fork leaves the
  original alone; 404/400 on bad ids.
- gallery: newest-first paging across 3 pages; no repeats when a shader is created mid-scroll;
  page-size cap and garbage-cursor 400.

`server/test/pgstore.test.ts` (Postgres only, also runs in CI):
- titles and `forked_from` round-trip; re-running migrations does nothing.
- five rows with the **identical microsecond** timestamp page correctly (the bug in section 4).
- the gallery query plan uses the index with no sort.

Also checked by hand in the browser on Postgres: typing a title syncs to a second tab and is saved a
second later; Fork opens the copy with the right title and link; the gallery lists everything; paging
by 4 returns all 11 shaders with no repeats.

---

## Interview questions (cover the answer, say it out loud, then check)

<details><summary>1. Why not just add the column to the CREATE TABLE statement?</summary>

`CREATE TABLE IF NOT EXISTS` does nothing if the table exists, and the production table already does.
Migrations are numbered changes the database tracks, so every environment converges to the same
schema, and you can see what changed and when.
</details>

<details><summary>2. What happens if a migration fails halfway?</summary>

Each migration runs in a transaction with its version record. On failure everything rolls back,
including partial schema changes (Postgres DDL is transactional), and the version isn't recorded, so
it reruns next time. The server refuses to start rather than run on a half-migrated schema.
</details>

<details><summary>3. Two servers start at once. What stops them from both migrating?</summary>

A Postgres advisory lock. The second blocks until the first finishes, then sees nothing to do.
</details>

<details><summary>4. Where does the title live, and which copy is the truth?</summary>

In the Yjs document (so it syncs live) and in a column (so the gallery can query it). The document is
the source of truth; the column is a denormalized copy rewritten on every save.
</details>

<details><summary>5. Why is the title a Y.Map value but the code a Y.Text?</summary>

Text merges character-level concurrent edits; a map value is last-writer-wins. Fine for a short title,
unacceptable for code.
</details>

<details><summary>6. The browser limits titles to 80 characters. Why check again on the server?</summary>

The client is not a security boundary. Anyone can send their own messages. Every rule the client
enforces has to be enforced by the server too.
</details>

<details><summary>7. Someone is typing in a shader and you fork it. Do you get their latest edits?</summary>

Yes. Saves are debounced, so the newest edits may only be in memory. Fork reads the live room's
in-memory document if the shader is open, and Postgres only if it isn't (then nothing is unsaved).
Edits after the fork moment don't appear in the fork: it's a point-in-time snapshot.
</details>

<details><summary>8. Why does a fork start a fresh document instead of copying the CRDT state?</summary>

The state includes the full edit history (tombstones for deleted text). Copying it would make every
fork carry all its ancestors' history. A fresh document with the current text starts small.
</details>

<details><summary>9. Why cursor pagination instead of OFFSET?</summary>

OFFSET shifts when rows are added or deleted between page loads, causing repeats or skips, and it
gets slower the deeper you go because Postgres must walk and discard every skipped row. A cursor
continues from an exact row, is stable under inserts, and with the right index is constant-time per page.
</details>

<details><summary>10. Why does the cursor include the id, and why not use a JS Date for the time?</summary>

Ids break ties between equal timestamps so the order is total. JS Dates have millisecond precision
but Postgres has microseconds; a rounded cursor lands before the real row and pages skip or repeat
rows. The cursor carries Postgres's exact text timestamp. (I showed a test failing without this.)
</details>

<details><summary>11. Describe your index and why the column order matters.</summary>

`(created_at DESC, id DESC)`, the same as the ORDER BY, so Postgres reads it in order and stops after
`limit + 1` entries with no sort. Reversed column order couldn't serve the query.
</details>

<details><summary>12. How do you know there's a next page without COUNT(*)?</summary>

Fetch `limit + 1`. If the extra row exists, return a cursor; otherwise null.
</details>

---

## Your turn: one small change (about 30 minutes)

In the editor, the "forked from" link shows the original's **id** (`forked from K9KU8wmG8T`). Make it
show the original's **title** instead (`forked from Rainbow Plasma`).

Hints: in `Editor.tsx`, the first `useEffect` already fetches this shader's metadata, which includes
`forkedFrom`. When `forkedFrom` is set, fetch `/api/shaders/<forkedFrom>` too and keep its `title` in
state. Handle the original having been deleted (the request returns 404, so fall back to the id).
Then check in the browser: fork a titled shader and look at the link.
