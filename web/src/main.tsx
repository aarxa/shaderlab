import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';

import { Editor } from './Editor';
import './styles.css';

// "/" creates a fresh shader and redirects to its share link. The request is shared module-wide
// so React StrictMode's double effect run in development doesn't create two shaders.
let creating: Promise<{ id: string }> | null = null;

function NewShader() {
  const navigate = useNavigate();
  useEffect(() => {
    creating ??= fetch('/api/shaders', { method: 'POST' }).then((r) => r.json());
    creating.then(({ id }) => {
      creating = null;
      navigate(`/s/${id}`, { replace: true });
    });
  }, [navigate]);
  return <div className="center">Creating a shader…</div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<NewShader />} />
        <Route path="/s/:id" element={<Editor />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
