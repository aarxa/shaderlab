// A friendly random name and colour per browser, shown on your cursor to other editors.
// Accounts come later (see MILESTONES.md); until then this lives in localStorage.
const ADJ = ['Swift', 'Quiet', 'Bright', 'Lucky', 'Cosmic', 'Neon', 'Velvet', 'Amber', 'Misty', 'Brave'];
const NOUN = ['Otter', 'Comet', 'Fox', 'Pixel', 'Heron', 'Lynx', 'Nebula', 'Koi', 'Raven', 'Moth'];
const COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#eab308', '#14b8a6', '#ef4444'];

export interface Identity {
  name: string;
  color: string;
}

export function getIdentity(): Identity {
  try {
    const saved = localStorage.getItem('shaderlab.identity');
    if (saved) return JSON.parse(saved) as Identity;
  } catch {
    // private mode or blocked storage: fall through to a fresh identity
  }
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const id = { name: `${pick(ADJ)} ${pick(NOUN)}`, color: pick(COLORS) };
  try {
    localStorage.setItem('shaderlab.identity', JSON.stringify(id));
  } catch {
    // ignore
  }
  return id;
}
