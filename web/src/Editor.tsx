// The shader page: collaborative CodeMirror editor on the left, live WebGL preview on the right.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';

import { ShaderRenderer, type CompileError } from './renderer';
import { getIdentity } from './identity';
import { sendOnlyLocalAwareness } from './awareness';

type Status = 'connecting' | 'connected' | 'disconnected';
interface Peer {
  name: string;
  color: string;
}

export const TITLE_MAX = 80;

export function Editor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const metaRef = useRef<Y.Map<unknown> | null>(null);
  const [title, setTitle] = useState('');
  const [forkedFrom, setForkedFrom] = useState<string | null>(null);
  const [forking, setForking] = useState(false);
  const editorEl = useRef<HTMLDivElement>(null);
  const canvasEl = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [errors, setErrors] = useState<CompileError[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [notFound, setNotFound] = useState(false);
  // Set by the main effect; the metadata fetch calls it if this shader has no thumbnail yet.
  const backfillThumbnail = useRef<(() => void) | null>(null);
  const thumbnailMissing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/shaders/${id}`).then(async (r) => {
      if (cancelled) return;
      if (r.status !== 200) return setNotFound(true);
      const meta = (await r.json()) as { forkedFrom: string | null; thumbnailAt: string | null };
      setForkedFrom(meta.forkedFrom);
      if (meta.thumbnailAt === null) {
        thumbnailMissing.current = true;
        backfillThumbnail.current?.();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!editorEl.current || !canvasEl.current || notFound) return;
    const doc = new Y.Doc();
    const ytext = doc.getText('code');
    // The title is a key in a shared Y.Map, so it syncs live like the code. Each change replaces the
    // whole value (last writer wins), which is fine for a short title; the code uses Y.Text, which
    // merges character by character.
    const meta = doc.getMap('meta');
    metaRef.current = meta;
    const syncTitle = () => setTitle(String(meta.get('title') ?? ''));
    meta.observe(syncTitle);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/collab`, id, doc);
    sendOnlyLocalAwareness(provider); // don't echo other people's cursors back to the server
    const me = getIdentity();
    provider.awareness.setLocalStateField('user', { name: me.name, color: me.color, colorLight: me.color + '33' });

    if (import.meta.env.DEV) (window as unknown as { __shaderlab: unknown }).__shaderlab = { doc, provider };
    provider.on('status', (e: { status: Status }) => setStatus(e.status));
    const updatePeers = () => {
      const list: Peer[] = [];
      provider.awareness.getStates().forEach((s, clientId) => {
        if (clientId !== doc.clientID && s.user) list.push(s.user as Peer);
      });
      setPeers(list);
    };
    provider.awareness.on('change', updatePeers);

    const renderer = new ShaderRenderer(canvasEl.current);
    renderer.startLoop();

    // Thumbnails: whoever is typing takes the picture. Several people may have the shader open; only
    // a client that made a local edit since its last upload captures (plus one backfill for shaders
    // that have no thumbnail yet), so watchers don't all upload the same image.
    let editSeq = 0; // local edits so far
    let capturedSeq = 0; // editSeq at the last successful upload
    let compiledOk = false;
    let captureTimer = 0;
    let lastUpload = 0;
    const THUMB_DELAY_MS = 3000; // let the code settle (and the animation run) before capturing
    const THUMB_MIN_GAP_MS = 15_000; // the server also limits writes per shader
    const markEdit = (e: Y.YTextEvent) => {
      if (e.transaction.local) editSeq++; // remote edits arrive with local = false
    };
    ytext.observe(markEdit);
    const scheduleCapture = (delay = THUMB_DELAY_MS) => {
      window.clearTimeout(captureTimer);
      captureTimer = window.setTimeout(capture, Math.max(delay, lastUpload + THUMB_MIN_GAP_MS - Date.now()));
    };
    const capture = async () => {
      if (!compiledOk || (editSeq === capturedSeq && !thumbnailMissing.current)) return;
      const seq = editSeq;
      const blob = await renderer.capture();
      if (!blob) return;
      const res = await fetch(`/api/shaders/${id}/thumbnail`, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type },
        body: blob,
      }).catch(() => null);
      if (res?.status === 204) {
        capturedSeq = seq;
        thumbnailMissing.current = false;
        lastUpload = Date.now();
      } else if (res?.status === 429) {
        // Someone else just uploaded one; try again once the server's window has passed.
        scheduleCapture(Number(res.headers.get('Retry-After') ?? 10) * 1000);
      }
    };
    backfillThumbnail.current = () => scheduleCapture();

    let compileTimer = 0;
    const recompile = () => {
      window.clearTimeout(compileTimer);
      compileTimer = window.setTimeout(() => {
        const errs = renderer.setCode(ytext.toString());
        setErrors(errs);
        compiledOk = errs.length === 0; // never photograph the previous version during an error
        if (compiledOk && (editSeq !== capturedSeq || thumbnailMissing.current)) scheduleCapture();
        // Compile errors become inline diagnostics (red underline + hover message) on their lines.
        const diagnostics: Diagnostic[] = errs.map((e) => {
          const line = view.state.doc.line(Math.min(e.line, view.state.doc.lines));
          return { from: line.from, to: line.to, severity: 'error', message: e.message };
        });
        view.dispatch(setDiagnostics(view.state, diagnostics));
      }, 250); // debounce: don't recompile on every keystroke
    };
    ytext.observe(recompile);

    const undoManager = new Y.UndoManager(ytext);
    const view = new EditorView({
      parent: editorEl.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [basicSetup, cpp(), oneDark, yCollab(ytext, provider.awareness, { undoManager }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, monospace' } })],
      }),
    });
    provider.once('sync', () => {
      recompile();
      syncTitle();
    });

    return () => {
      window.clearTimeout(compileTimer);
      window.clearTimeout(captureTimer);
      backfillThumbnail.current = null;
      ytext.unobserve(markEdit);
      ytext.unobserve(recompile);
      meta.unobserve(syncTitle);
      metaRef.current = null;
      view.destroy();
      renderer.dispose();
      provider.destroy();
      doc.destroy();
    };
  }, [id, notFound]);

  const fork = async () => {
    setForking(true);
    try {
      const res = await fetch(`/api/shaders/${id}/fork`, { method: 'POST' });
      if (res.ok) navigate(`/s/${((await res.json()) as { id: string }).id}`);
    } finally {
      setForking(false);
    }
  };

  if (notFound) return <div className="center">Shader not found. <a href="/">Make a new one</a></div>;

  return (
    <div className="page">
      <header>
        <Link to="/gallery" className="brand">ShaderLab</Link>
        <div className="title-block">
          <input
            className="title"
            aria-label="Shader title"
            placeholder="Untitled"
            maxLength={TITLE_MAX}
            value={title}
            onChange={(e) => metaRef.current?.set('title', e.target.value)}
          />
          {forkedFrom && (
            <Link className="forked" to={`/s/${forkedFrom}`}>forked from {forkedFrom}</Link>
          )}
        </div>
        <span className={`status ${status}`}>{status}</span>
        <div className="peers">
          {peers.map((p, i) => (
            <span key={i} className="peer" style={{ background: p.color }} title={p.name}>
              {p.name.split(' ').map((w) => w[0]).join('')}
            </span>
          ))}
        </div>
        <button className="secondary" onClick={fork} disabled={forking}>{forking ? 'Forking…' : 'Fork'}</button>
        <button onClick={() => navigator.clipboard.writeText(location.href)}>Copy share link</button>
      </header>
      <main>
        <div className="editor" ref={editorEl} />
        <div className="preview">
          <canvas ref={canvasEl} data-testid="preview" />
          {errors.length > 0 && (
            <pre className="errors">{errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}</pre>
          )}
        </div>
      </main>
    </div>
  );
}
