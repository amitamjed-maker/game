// in-memory Firebase RTDB mock (tests only)
const root = { v: {} }, subs = new Set(); let kc = 0;
const parts = p => String(p).split('/').filter(Boolean);
const getAt = p => { let o = root.v; for (const k of parts(p)) { if (o == null || typeof o !== 'object') return null; o = o[k]; } return o === undefined ? null : o; };
function setAt(p, val) {
  const ks = parts(p); if (!ks.length) { root.v = val || {}; return; }
  let o = root.v; for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; }
  const last = ks[ks.length - 1]; if (val === null || val === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(val));
  // prune empties
  for (let n = ks.length - 1; n > 0; n--) { let q = root.v; for (let i = 0; i < n - 1; i++) q = q[ks[i]]; const k = ks[n - 1]; if (q[k] && typeof q[k] === 'object' && !Object.keys(q[k]).length) delete q[k]; else break; }
}
const snap = (p, v) => ({ key: parts(p).pop() || null, val: () => v === undefined ? null : JSON.parse(JSON.stringify(v)), exists: () => v != null });
let q = false; const notify = () => { if (q) return; q = true; queueMicrotask(() => { q = false; for (const s of [...subs]) s.check(); }); };
export const initializeApp = c => c; export const getDatabase = () => ({});
export const ref = (db, path = '') => ({ path: parts(path).join('/') });
export const query = r => r; export const limitToLast = () => null;
export const serverTimestamp = () => Date.now();
export const set = async (r, v) => { setAt(r.path, v); notify(); };
export const remove = async r => { setAt(r.path, null); notify(); };
export const update = async (r, o) => { for (const k in o) setAt(r.path + '/' + k, o[k]); notify(); };
export const get = async r => snap(r.path, getAt(r.path));
export const push = (r, v) => { const k = 'k' + String(++kc).padStart(6, '0'); const c = { path: r.path + '/' + k }; if (v !== undefined) { setAt(c.path, v); notify(); } c.then = f => Promise.resolve().then(f); return c; };
export const onDisconnect = () => ({ remove() { return Promise.resolve(); }, set() { return Promise.resolve(); } });
function addSub(check) { const s = { check }; subs.add(s); return () => subs.delete(s); }
export const onValue = (r, cb) => {
  if (r.path === '.info/serverTimeOffset') { setTimeout(() => cb(snap(r.path, 0)), 0); return () => { }; }
  let last = undefined; const check = () => { const v = getAt(r.path), j = JSON.stringify(v); if (j !== last) { last = j; cb(snap(r.path, v)); } };
  const un = addSub(check); setTimeout(check, 0); return un;
};
const childSub = (r, cb, kind) => {
  let last = {}; const check = () => {
    const v = getAt(r.path) || {}, cur = {}; if (typeof v === 'object') for (const k in v) cur[k] = JSON.stringify(v[k]);
    for (const k in cur) { if (!(k in last)) { if (kind === 'add') cb(snap(r.path + '/' + k, v[k])); } else if (last[k] !== cur[k] && kind === 'chg') cb(snap(r.path + '/' + k, v[k])); }
    if (kind === 'rem') for (const k in last) if (!(k in cur)) cb(snap(r.path + '/' + k, JSON.parse(last[k])));
    last = cur;
  };
  const un = addSub(check); setTimeout(check, 0); return un;
};
export const onChildAdded = (r, cb) => childSub(r, cb, 'add');
export const onChildChanged = (r, cb) => childSub(r, cb, 'chg');
export const onChildRemoved = (r, cb) => childSub(r, cb, 'rem');
