// Gallery: every shader, newest first, loaded a page at a time with the server's cursor.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

interface Item {
  id: string;
  title: string;
  forkedFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

const PAGE = 24;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const units: [number, string][] = [[86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return 'just now';
}

export function Gallery() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const loadMore = useCallback(async (after: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (after) qs.set('cursor', after);
      const res = await fetch(`/api/shaders?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as { items: Item[]; nextCursor: string | null };
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      setDone(page.nextCursor === null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development
    started.current = true;
    void loadMore(null);
  }, [loadMore]);

  const titles = new Map(items.map((i) => [i.id, i.title]));

  return (
    <div className="page">
      <header>
        <Link to="/gallery" className="brand">ShaderLab</Link>
        <span className="muted">Gallery</span>
        <button style={{ marginLeft: 'auto' }} onClick={() => navigate('/')}>New shader</button>
      </header>
      <div className="gallery">
        {items.map((it) => (
          <Link key={it.id} to={`/s/${it.id}`} className="card">
            <div className="card-title">{it.title}</div>
            <div className="card-meta">
              {ago(it.createdAt)}
              {it.forkedFrom && <> · forked from {titles.get(it.forkedFrom) ?? it.forkedFrom}</>}
            </div>
          </Link>
        ))}
        {items.length === 0 && !loading && !error && <div className="muted">No shaders yet.</div>}
      </div>
      <div className="gallery-footer">
        {error && <span className="error-text">Couldn't load shaders ({error}). </span>}
        {!done && (
          <button className="secondary" disabled={loading} onClick={() => loadMore(cursor)}>
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}
