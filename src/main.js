import * as THREE from 'three';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, set, update, remove, onDisconnect, get } from 'firebase/database';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const bn = n => String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const MAX = 18, HIDE_MS = 40000, SIG_MS = 20000, TOSS_MS = 12000, COIN_MS = 5500, END_MS = 8000, HALF = 52;
const CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------- Firebase ---------- */
const db = getDatabase(initializeApp(firebaseConfig));
const uid = localStorage.uid || (localStorage.uid = Math.random().toString(36).slice(2, 10));
let myName = localStorage.name || '';
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), s => offset = s.val() || 0);
const now = () => Date.now() + offset;

let room = null, players = {}, state = { phase: 'lobby' }, choices = {}, caught = {}, pos = {}, skin = {}, online = {}, unsubs = [];
const sorted = () => Object.entries(players).sort((a, b) => a[1].joined - b[1].joined || (a[0] < b[0] ? -1 : 1));
const isHost = () => sorted()[0]?.[0] === uid;
const iAmSeeker = () => state.seeker === uid;
const hiders = () => (state.parts || []).filter(u => players[u] && u !== state.seeker);

let toastT;
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('on'), 2600); }

function ensureName() {
  const v = $('name').value.trim().slice(0, 14);
  if (!v) { toast('আগে আপনার নাম লিখুন'); return false; }
  myName = localStorage.name = v; goOnline(); return true;
}
function goOnline() {
  if (!myName) return;
  const r = ref(db, 'online/' + uid);
  set(r, { name: myName, room: room || '', t: now() }); onDisconnect(r).remove();
}
function register(code, joined) {
  const pr = ref(db, `rooms/${code}/players/${uid}`);
  onDisconnect(pr).remove();
  onDisconnect(ref(db, `rooms/${code}/pos/${uid}`)).remove();
  onDisconnect(ref(db, `rooms/${code}/choices/${uid}`)).remove();
  onDisconnect(ref(db, `rooms/${code}/skin/${uid}`)).remove();
  return set(pr, { name: myName, joined: joined || now() });
}
onValue(ref(db, '.info/connected'), s => {
  if (!s.val()) return;
  goOnline();
  if (room) register(room, players[uid]?.joined);
});

async function createRoom() {
  for (let i = 0; i < 5; i++) {
    const c = Array.from({ length: 5 }, () => CH[Math.random() * CH.length | 0]).join('');
    if (!(await get(ref(db, `rooms/${c}/players`))).exists()) return joinRoom(c);
  }
  return false;
}
async function joinRoom(code, quiet) {
  code = code.trim().toUpperCase();
  if (!code) { toast('রুমের ঠিকানা লিখুন'); return false; }
  const [ps, st] = await Promise.all([get(ref(db, `rooms/${code}/players`)), get(ref(db, `rooms/${code}/state`))]);
  const cnt = Object.keys(ps.val() || {}).length;
  if (cnt >= MAX) { if (!quiet) toast('রুম ভরে গেছে (সর্বোচ্চ ১৮ জন)'); return false; }
  if (cnt > 0 && st.val() && st.val().phase !== 'lobby') { if (!quiet) toast('এখানে খেলা চলছে, একটু পরে আসুন'); return false; }
  if (room) leaveRoom();
  if (cnt === 0) await set(ref(db, 'rooms/' + code), { state: { phase: 'lobby' } });
  room = code;
  await register(code);
  update(ref(db, 'online/' + uid), { room: code });
  subscribe(code);
  $('menu').hidden = true; $('hud').hidden = false; $('joy').hidden = false;
  $('code').textContent = 'ঠিকানা: ' + code + ' ⧉';
  spawnLobby(); renderAll(); onPlayers();
  return true;
}
function subscribe(code) {
  const b = `rooms/${code}/`;
  unsubs = [
    onValue(ref(db, b + 'players'), s => { players = s.val() || {}; onPlayers(); }),
    onValue(ref(db, b + 'state'), s => { const old = state; state = s.val() || { phase: 'lobby' }; onState(old); }),
    onValue(ref(db, b + 'choices'), s => { choices = s.val() || {}; renderToss(); }),
    onValue(ref(db, b + 'caught'), s => { const n = s.val() || {}; if (n[uid] && !caught[uid]) toast('আপনি ধরা পড়েছেন!'); caught = n; }),
    onValue(ref(db, b + 'pos'), s => { pos = s.val() || {}; }),
    onValue(ref(db, b + 'skin'), s => { skin = s.val() || {}; renderAll(); })
  ];
}
function leaveRoom() {
  unsubs.forEach(f => f()); unsubs = [];
  if (room) {
    remove(ref(db, `rooms/${room}/players/${uid}`)); remove(ref(db, `rooms/${room}/pos/${uid}`)); remove(ref(db, `rooms/${room}/choices/${uid}`)); remove(ref(db, `rooms/${room}/skin/${uid}`));
    update(ref(db, 'online/' + uid), { room: '' });
  }
  room = null; players = {}; pos = {}; skin = {}; choices = {}; caught = {}; state = { phase: 'lobby' };
  syncAvatars();
  ['hud', 'joy', 'lobby', 'toss', 'coinov', 'blind', 'end', 'catch', 'morph', 'skins'].forEach(i => $(i).hidden = true);
  $('menu').hidden = false;
}

/* ---------- Online list + invites ---------- */
onValue(ref(db, 'online'), s => { online = s.val() || {}; renderOnline(); });
function renderOnline() {
  const list = Object.entries(online).filter(([u]) => u !== uid);
  const h = list.length ? list.map(([u, o]) => `<div class="ol-i"><span>${esc(o.name || '?')} <small>${o.room ? 'রুমে আছেন' : 'ফাঁকা'}</small></span><button data-u="${u}">ডাকুন</button></div>`).join('') : '<small>এখন আর কেউ অনলাইনে নেই</small>';
  $('olMenu').innerHTML = h; $('olLobby').innerHTML = h;
  $('olN').textContent = bn(Object.keys(online).length) + ' জন';
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-u]'); if (!b) return;
  if (!ensureName()) return;
  if (!room && !(await createRoom())) return;
  set(ref(db, 'invites/' + b.dataset.u), { from: myName, code: room, t: now() });
  toast('ডাক পাঠানো হয়েছে');
});
onValue(ref(db, 'invites/' + uid), s => {
  const v = s.val(), b = $('inv');
  if (!v || now() - v.t > 120000) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<b>${esc(v.from)}</b> আপনাকে ডাকছেন<button id="iy" class="y">যোগ দিন (${esc(v.code)})</button><button id="in">না</button>`;
  $('iy').onclick = async () => { if (!ensureName()) return; remove(ref(db, 'invites/' + uid)); await joinRoom(v.code); };
  $('in').onclick = () => remove(ref(db, 'invites/' + uid));
});

/* ---------- Menu buttons ---------- */
$('create').onclick = async () => { if (ensureName()) await createRoom(); };
$('join').onclick = () => { if (ensureName()) joinRoom($('jc').value); };
$('pub').onclick = async () => { if (!ensureName()) return; for (let i = 1; i <= 30; i++) if (await joinRoom('PUB' + i, true)) return; toast('এখন কোনো রুম খালি নেই'); };
$('leave').onclick = leaveRoom;
$('code').onclick = () => {
  const t = `গ্রামের লুকোচুরিতে আসুন! রুমের ঠিকানা: ${room}`;
  if (navigator.share) navigator.share({ text: t }).catch(() => {});
  else navigator.clipboard?.writeText(room).then(() => toast('ঠিকানা কপি হয়েছে'));
};
$('start').onclick = () => {
  if (!isHost()) return;
  const ids = Object.keys(players);
  if (ids.length < 2) return toast('কমপক্ষে ২ জন লাগবে');
  update(ref(db, 'rooms/' + room), { state: { phase: 'toss', round: 1, alive: ids, parts: ids, deadline: now() + TOSS_MS, msg: 'সবাই হেড অথবা টেল বেছে নিন' }, choices: null, caught: null });
};
$('pickH').onclick = () => pick('H');
$('pickT').onclick = () => pick('T');
function pick(c) { if (state.phase === 'toss' && (state.alive || []).includes(uid)) set(ref(db, `rooms/${room}/choices/${uid}`), c); }
if (myName) { $("name").value = myName; goOnline(); }

/* ---------- Host state machine ---------- */
setInterval(hostTick, 500);
function hostTick() {
  if (!room || !isHost()) return;
  const s = state, t = now(), ids = Object.keys(players), p = s.phase;
  const put = (o, x = {}) => update(ref(db, 'rooms/' + room), { state: o, ...x });
  const nextToss = (alive, msg) => put({ phase: 'toss', round: (s.round || 1) + 1, alive, parts: s.parts, deadline: t + TOSS_MS, msg }, { choices: null });
  const toHide = (seeker, msg) => put({ phase: 'hide', seeker, parts: (s.parts || []).filter(u => players[u]), deadline: t + HIDE_MS, msg: msg || '' }, { choices: null, caught: null, skin: null });
  const end = w => put({ phase: 'end', seeker: s.seeker, parts: s.parts, winner: w, deadline: t + END_MS });
  if (p !== 'lobby' && ids.length < 2) return put({ phase: 'lobby' }, { choices: null, caught: null });
  if (p === 'toss') {
    const alive = (s.alive || []).filter(u => players[u]);
    if (!alive.length) return put({ phase: 'lobby' }, { choices: null });
    if (t < s.deadline && !alive.every(u => choices[u])) return;
    const ch = {}; alive.forEach(u => ch[u] = choices[u] || (Math.random() < .5 ? 'H' : 'T'));
    const H = alive.filter(u => ch[u] === 'H'), T = alive.filter(u => ch[u] === 'T');
    if (alive.length === 1) return toHide(alive[0]);
    if (alive.length === 2) {
      if (H.length === 1) { const res = Math.random() < .5 ? 'H' : 'T'; return put({ phase: 'coin', coin: res, seeker: (res === 'H' ? H : T)[0], final: ch, parts: s.parts, deadline: t + COIN_MS }, { choices: null }); }
      return nextToss(alive, 'দুজনেই একই পাশ বেছেছেন, আবার');
    }
    if (!H.length || !T.length || H.length === T.length) return nextToss(alive, 'পাশ সমান বা সবাই এক পাশে — কেউ বাদ পড়েনি, আবার টস');
    const big = H.length > T.length ? H : T, small = big === H ? T : H;
    const msg = `${bn(H.length)} জন হেড, ${bn(T.length)} জন টেল — ${bn(big.length)} জন বাদ`;
    return small.length === 1 ? toHide(small[0], msg) : nextToss(small, msg);
  }
  if (p === 'coin' && t >= s.deadline) return toHide(s.seeker);
  if (p === 'hide') { if (!players[s.seeker]) return end('hiders'); if (t >= s.deadline) { const n = (s.parts || []).filter(u => players[u] && u !== s.seeker).length, ms = Math.min(720000, Math.max(90000, n * 45000)); return put({ ...s, phase: 'seek', seekStart: t, deadline: t + ms }); } }
  if (p === 'seek') {
    if (!players[s.seeker]) return end('hiders');
    const hs = (s.parts || []).filter(u => players[u] && u !== s.seeker);
    if (hs.every(u => caught[u])) return end('seeker');
    if (t >= s.deadline) return end('hiders');
  }
  if (p === 'end' && t >= s.deadline) return put({ phase: 'lobby' }, { choices: null, caught: null, skin: null });
}

/* ---------- UI reactions ---------- */
function onPlayers() {
  const ids = sorted().map(e => e[0]);
  $('pl').innerHTML = `<b>ঘরে আছেন ${bn(ids.length)}/${bn(MAX)} জন</b>` + ids.map((u, i) => `<div>${esc(players[u].name)}${u === uid ? ' (আপনি)' : ''}${i === 0 ? ' ★' : ''}</div>`).join('');
  $('start').hidden = !isHost(); $('wait').hidden = isHost();
  syncAvatars(); renderToss();
}
function onState(old) {
  const p = state.phase;
  if (p !== old.phase) {
    if (p === 'seek') lastSig = Math.floor((now() - (state.seekStart || now())) / SIG_MS);
    if (p === 'hide' && !iAmSeeker()) toast('"রূপ" বাটন চেপে চেয়ার, গাছ বা অন্য কিছু হয়ে লুকান!');
    if (p === 'hide') spawnGame(); else if (p === 'lobby' && old.phase !== 'lobby') spawnLobby();
    if (p === 'coin') playCoin();
  }
  renderAll();
}
function renderAll() {
  const p = state.phase;
  $('lobby').hidden = p !== 'lobby';
  $('blind').hidden = !(p === 'hide' && iAmSeeker());
  $('coinov').hidden = p !== 'coin';
  $('end').hidden = p !== 'end'; if (p === 'end') renderEnd();
  $('catch').hidden = !(p === 'seek' && iAmSeeker());
  const canMorph = (p === 'hide' || p === 'seek') && !iAmSeeker() && (state.parts || []).includes(uid) && !caught[uid];
  $('morph').hidden = !canMorph; if (!canMorph) $('skins').hidden = true;
  renderToss();
}
function renderToss() {
  const el = $('toss');
  if (state.phase !== 'toss') { el.hidden = true; return; }
  el.hidden = false;
  const alive = (state.alive || []).filter(u => players[u]), inn = alive.includes(uid);
  $('tmsg').textContent = state.msg || '';
  $('tinfo').textContent = inn ? `টসে আছেন ${bn(alive.length)} জন • বেছেছেন ${bn(alive.filter(u => choices[u]).length)} জন` : `আপনি বাদ পড়েছেন — আপনি লুকাবেন। টসে আছেন ${bn(alive.length)} জন`;
  $('pickH').disabled = $('pickT').disabled = !inn;
  $('pickH').classList.toggle('on', choices[uid] === 'H'); $('pickT').classList.toggle('on', choices[uid] === 'T');
}
function playCoin() {
  const f = state.final || {}, nm = c => { const u = Object.keys(f).find(k => f[k] === c); return u && players[u] ? players[u].name : '?'; };
  $('coinwho').textContent = `${nm('H')} = হেড  |  ${nm('T')} = টেল`;
  const c = $('coin'); c.style.setProperty('--end', (1800 + (state.coin === 'T' ? 180 : 0)) + 'deg');
  c.className = ''; void c.offsetWidth; c.className = 'flip';
  const r = $('coinres'); r.textContent = `${state.coin === 'H' ? 'হেড' : 'টেল'}! ${players[state.seeker]?.name || ''} খুঁজবেন`;
  r.className = ''; void r.offsetWidth; r.className = 'show';
}
function renderEnd() {
  const sk = players[state.seeker]?.name || 'খোঁজক', cs = Object.keys(caught).filter(u => players[u]).map(u => esc(players[u].name));
  $('end').innerHTML = `<div class="card"><h2>${state.winner === 'seeker' ? esc(sk) + ' সবাইকে খুঁজে পেয়েছেন!' : 'লুকানোরা জিতেছে!'}</h2><p>ধরা পড়েছেন: ${cs.length ? cs.join(', ') : 'কেউ না'}</p><small>একটু পরে রুমে ফিরবেন…</small></div>`;
}
function updateHud() {
  if (!room) return;
  const p = state.phase, left = Math.max(0, Math.ceil(((state.deadline || 0) - now()) / 1000));
  let t = '', s = '';
  if (p === 'lobby') t = 'অপেক্ষাঘর';
  else if (p === 'toss') { t = `টস • রাউন্ড ${bn(state.round || 1)}`; $('ttime').textContent = bn(left); }
  else if (p === 'coin') t = 'কয়েন টস';
  else if (p === 'hide') { t = iAmSeeker() ? 'চোখ বন্ধ' : 'লুকান!'; s = bn(left) + ' সেকেন্ড' + (iAmSeeker() ? '' : ' • রূপ বদলে লুকান'); $('blind').innerHTML = `<div>চোখ বন্ধ!<br>${bn(left)}</div>`; }
  else if (p === 'seek') { t = iAmSeeker() ? 'সবাইকে খুঁজুন' : 'লুকিয়ে থাকুন'; s = `${bn(left)} সেকেন্ড • বাকি ${bn(hiders().filter(u => !caught[u]).length)} জন`; if (caught[uid]) s += ' • আপনি ধরা পড়েছেন'; }
  else if (p === 'end') t = 'খেলা শেষ';
  $('ph').textContent = t; $('sub').textContent = s;
}
setInterval(updateHud, 200);

/* ---------- 3D world ---------- */
const cv = $('c');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe9f5, 45, 125);
const cam = new THREE.PerspectiveCamera(62, 1, .1, 240);
scene.add(new THREE.HemisphereLight(0xe3f3ff, 0x6d8a4f, 1.05));
const sun = new THREE.DirectionalLight(0xfff0d0, 1.15); sun.position.set(40, 60, 25); scene.add(sun);
{ // আকাশ
  const g = new THREE.SphereGeometry(180, 16, 10), pa = g.attributes.position, n = pa.count, a = new Float32Array(n * 3);
  const top = new THREE.Color(0x4a9de0), hor = new THREE.Color(0xcfe9f5), c = new THREE.Color();
  for (let i = 0; i < n; i++) { c.copy(hor).lerp(top, Math.pow(Math.max(0, pa.getY(i) / 180), .6)); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })));
}
/*WORLD_START*/
const G = {};
const gb = (w, h, d) => G[`b${w},${h},${d}`] || (G[`b${w},${h},${d}`] = new THREE.BoxGeometry(w, h, d));
const gc = (a, b, h, s = 8) => G[`c${a},${b},${h},${s}`] || (G[`c${a},${b},${h},${s}`] = new THREE.CylinderGeometry(a, b, h, s));
const gs = (r, w = 10, h = 8) => G[`s${r},${w},${h}`] || (G[`s${r},${w},${h}`] = new THREE.SphereGeometry(r, w, h));
const gk = (r, h, s = 8) => G[`k${r},${h},${s}`] || (G[`k${r},${h},${s}`] = new THREE.ConeGeometry(r, h, s));
const gp = () => G.p || (G.p = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
const gcirc = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
const roofG = new THREE.ConeGeometry(1, 1.8, 4).rotateY(Math.PI / 4);
const leafG = new THREE.BoxGeometry(2.2, .05, .45).translate(1.1, 0, 0);
const P = (g, x, y, z, c, s) => ({ g, p: [x, y, z], c, s });
const WD = 0x8a5a2b;
const legs = (h, t, dx, dz, c) => [-1, 1].flatMap(a => [-1, 1].map(b => P(gb(t, h, t), a * dx, h / 2, b * dz, c)));
const PROPS = {
  chair: { n: 'চেয়ার', p: [P(gb(.5, .08, .5), 0, .45, 0, WD), P(gb(.5, .6, .08), 0, .78, -.21, WD), ...legs(.45, .06, .2, .2, WD)] },
  table: { n: 'টেবিল', p: [P(gb(1.4, .08, .9), 0, .8, 0, 0x9b6a3a), ...legs(.8, .08, .6, .35, 0x7d5229)] },
  sofa: { n: 'সোফা', p: [P(gb(2, .5, .9), 0, .25, 0, 0x3f6ea8), P(gb(2, .55, .2), 0, .78, -.35, 0x345c8e), P(gb(.2, .6, .9), -1, .4, 0, 0x345c8e), P(gb(.2, .6, .9), 1, .4, 0, 0x345c8e)] },
  bed: { n: 'খাট', p: [P(gb(2, .4, 1.4), 0, .2, 0, WD), P(gb(1.9, .2, 1.3), 0, .5, 0, 0xe8e0d0), P(gb(.5, .12, .35), -.7, .66, 0, 0xffffff), P(gb(.08, .9, 1.4), -1, .45, 0, 0x6e4521)] },
  cupboard: { n: 'আলমারি', p: [P(gb(1, 2, .5), 0, 1, 0, 0x7a4a24), P(gb(.03, 1.8, .03), 0, 1, .26, 0x2b1b0c)] },
  stool: { n: 'মোড়া', p: [P(gc(.3, .3, .45, 10), 0, .225, 0, 0xc58b4a)] },
  tree: { n: 'গাছ', p: [P(gc(.28, .4, 3, 6), 0, 1.5, 0, 0x6b4423), P(gs(1.8, 8, 6), 0, 3.8, 0, 0x2f7a35), P(gs(1.3, 8, 6), .9, 3.2, .3, 0x3a8a3c), P(gs(1.2, 8, 6), -.8, 3.4, -.5, 0x2a6b30)] },
  bush: { n: 'ঝোপ', p: [P(gs(1.3, 8, 6), 0, .9, 0, 0x3f7d3a, [1, .85, 1]), P(gs(.8, 8, 6), .9, .6, .4, 0x4c8c44)] },
  hay: { n: 'খড়ের গাদা', p: [P(gk(1.6, 2.6, 8), 0, 1.3, 0, 0xe0c060)] },
  pot: { n: 'কলস', p: [P(gs(.5, 10, 8), 0, .5, 0, 0xb5562e), P(gc(.2, .3, .25, 10), 0, 1.05, 0, 0xb5562e)] },
  drum: { n: 'ড্রাম', p: [P(gc(.45, .45, .9, 10), 0, .45, 0, 0x2f5fa0)] },
  rock: { n: 'পাথর', p: [P(gs(.8, 7, 5), 0, .4, 0, 0x8a8d90, [1, .7, 1])] }
};
const rng = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = rng(20261119);
// সব স্থির জিনিস একটা মেশে জোড়া লাগানো হয় (১টা draw call) — তাই ৬০ FPS
const SP = [], tm = new THREE.Matrix4(), tq = new THREE.Quaternion(), te = new THREE.Euler(), tv = new THREE.Vector3(), ts = new THREE.Vector3(), tc = new THREE.Color();
function addS(g, col, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rz = 0) {
  const gg = g.clone(); te.set(0, ry, rz, 'YZX'); tq.setFromEuler(te); tm.compose(tv.set(x, y, z), tq, ts.set(sx, sy, sz)); gg.applyMatrix4(tm);
  const n = gg.attributes.position.count, a = new Float32Array(n * 3), j = .93 + R() * .14; tc.set(col);
  for (let i = 0; i < n; i++) { a[i * 3] = tc.r * j; a[i * 3 + 1] = tc.g * j; a[i * 3 + 2] = tc.b * j; }
  gg.setAttribute('color', new THREE.BufferAttribute(a, 3)); SP.push(gg);
}
function putProp(type, x, z, ry = 0, sc = 1) {
  const c = Math.cos(ry), s = Math.sin(ry);
  for (const q of PROPS[type].p) { const [px, py, pz] = q.p, s3 = q.s || [1, 1, 1]; addS(q.g, q.c, x + (px * c + pz * s) * sc, py * sc, z + (-px * s + pz * c) * sc, ry, s3[0] * sc, s3[1] * sc, s3[2] * sc); }
}
{ // মাঠ
  const g = new THREE.PlaneGeometry(170, 170, 34, 34).rotateX(-Math.PI / 2), pa = g.attributes.position, n = pa.count, a = new Float32Array(n * 3);
  const c1 = new THREE.Color(0x5c9a43), c2 = new THREE.Color(0x7db55a), c = new THREE.Color();
  for (let i = 0; i < n; i++) { const x = pa.getX(i), z = pa.getZ(i), v = (Math.sin(x * .21) + Math.sin(z * .17) + Math.sin((x + z) * .09) + Math.sin(x * .05) * Math.cos(z * .07)) / 4 * .5 + .5; c.copy(c1).lerp(c2, v); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); SP.push(g);
}
// রাস্তা, উঠান, পুকুর, ধানক্ষেত, ঘাট, নৌকা
addS(gp(), 0xc9a46a, 0, .02, 0, 0, 120, 1, 5); addS(gp(), 0xc9a46a, 0, .02, 0, 0, 5, 1, 120);
addS(gcirc, 0xd2b27a, 0, .022, 0, 0, 9, 1, 9);
addS(gcirc, 0xd8c58a, 26, .025, -22, 0, 9.9, 1, 9.9); addS(gcirc, 0x3f94c9, 26, .03, -22, 0, 9, 1, 9);
addS(gp(), 0xaac85a, -40, .02, -38, 0, 16, 1, 12); addS(gp(), 0xaac85a, 40, .02, 38, 0, 16, 1, 12);
for (let i = 0; i < 3; i++) addS(gb(.7, .1 * (3 - i), 3), 0xb0a690, 16.5 - i * .7, .05 * (3 - i), -22);
addS(gb(3.2, .35, 1.1), WD, 30, .15, -27, .4);

const boxes = [], cols = [{ x: 26, z: -22, r: 10 }];
const resv = [{ x: 26, z: -22, r: 11 }, { x: -40, z: -38, r: 12 }, { x: 40, z: 38, r: 12 }, { x: 0, z: 0, r: 13 }];
function spot(rad, gap, lim = 50, rc = 0) {
  for (let i = 0; i < 100; i++) {
    const x = (R() * 2 - 1) * lim, z = (R() * 2 - 1) * lim;
    if (rc ? (Math.abs(x) < rad || Math.abs(z) < rad) : (Math.abs(x) < 3.5 || Math.abs(z) < 3.5)) continue;
    if (resv.every(c => Math.hypot(x - c.x, z - c.z) > c.r + rad + gap)) { resv.push({ x, z, r: rad }); return { x, z }; }
  }
  return null;
}
const FP = { sofa: [2, .9], table: [1.4, .9], bed: [2, 1.4], cupboard: [1, .5], chair: [.5, .5], stool: [.6, .6] };
function house(cx, cz, k, W, D, wc, rc) {
  const ry = k * Math.PI / 2, c = Math.round(Math.cos(ry)), s = Math.round(Math.sin(ry)), H = 2.8, odd = k & 1;
  const wp = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
  const wall = (x1, z1, x2, z2) => {
    const w = Math.abs(x2 - x1) || .25, d = Math.abs(z2 - z1) || .25, [wx, wz] = wp((x1 + x2) / 2, (z1 + z2) / 2);
    addS(gb(w, H, d), wc, wx, H / 2, wz, ry);
    const hw = (odd ? d : w) / 2, hd = (odd ? w : d) / 2; boxes.push({ x1: wx - hw, x2: wx + hw, z1: wz - hd, z2: wz + hd, wall: 1 });
  };
  wall(-W / 2, -D / 2, W / 2, -D / 2); wall(-W / 2, -D / 2, -W / 2, D / 2); wall(W / 2, -D / 2, W / 2, D / 2);
  wall(-W / 2, D / 2, -.9, D / 2); wall(.9, D / 2, W / 2, D / 2); // সামনের দেয়ালে দরজা
  { const [x, z] = wp(0, D / 2); addS(gb(1.8, .6, .25), wc, x, 2.5, z, ry); const [a, b] = wp(0, D / 2 + .5); addS(gb(2.2, .15, .8), 0xb0a690, a, .075, b, ry); }
  { const [x, z] = wp(0, 0); addS(gp(), 0xb98b5e, x, .03, z, ry, W - .3, 1, D - .3); const [a, b] = wp(W / 4, 0); addS(gp(), 0xa8423a, a, .045, b, ry, 2.6, 1, 1.8); }
  addS(roofG, rc, cx, H + .9, cz, ry, (W / 2 + .55) / .7071, 1, (D / 2 + .55) / .7071);
  const win = (lx, lz, an) => { const [x, z] = wp(lx, lz); addS(gb(.9, .7, .06), 0x2d4a5a, x, 1.6, z, ry + an); };
  for (const d of [-.14, .14]) { win(0, -D / 2 + d, 0); win(-W / 2 + d, 0, Math.PI / 2); win(W / 2 + d, 0, Math.PI / 2); }
  const fu = (t, lx, lz, an = 0) => {
    const [x, z] = wp(lx, lz); putProp(t, x, z, ry + an);
    const o = Math.round((ry + an) / (Math.PI / 2)) & 1, [fw, fd] = FP[t], hw = (o ? fd : fw) / 2, hd = (o ? fw : fd) / 2;
    boxes.push({ x1: x - hw, x2: x + hw, z1: z - hd, z2: z + hd });
  };
  fu('sofa', -W / 2 + 1.4, -D / 2 + .8); fu('table', W / 4, 0); fu('chair', W / 4 - 1.1, .2, Math.PI / 2); fu('chair', W / 4 + 1.1, -.1, -Math.PI / 2);
  fu('chair', W / 4, .95, Math.PI); fu('bed', W / 2 - 1.4, -D / 2 + .9); fu('cupboard', -W / 2 + .5, .2, Math.PI / 2); fu('stool', -.6, 1);
}
const wallCols = [0xe3cfa6, 0xd2a679, 0xb9c9a0, 0xe6d9c0, 0xc9d6dd], roofCols = [0x8fa1aa, 0xb68b45, 0x9a4f2f, 0x6e7f8a];
for (let i = 0; i < 11; i++) {
  const W = 7 + (R() < .5 ? 2 : 0), D = 6 + (R() < .5 ? 1 : 0), p = spot(Math.max(W, D) / 2 + 2.8, .5, 46, 1);
  if (p) house(p.x, p.z, R() * 4 | 0, W, D, wallCols[i % 5], roofCols[i % 4]);
}
for (let i = 0; i < 34; i++) { const p = spot(1.2, .8); if (p) { putProp('tree', p.x, p.z, R() * 6, .9 + R() * .5); cols.push({ x: p.x, z: p.z, r: .55 }); } }
for (let i = -56; i <= 56; i += 8) for (const [x, z] of [[i, 58], [i, -58], [58, i], [-58, i]]) putProp('tree', x, z, R() * 6, 1.2);
for (let i = 0; i < 14; i++) { // নারকেল গাছ
  const p = spot(1, .8); if (!p) continue; const h = 5 + R() * 1.5;
  addS(gc(.13, .22, h, 6), 0x8a6a45, p.x, h / 2, p.z);
  for (let j = 0; j < 7; j++) addS(leafG, 0x3d8f3a, p.x, h, p.z, j * .9 + R() * .3, 1, 1, 1, -.55);
  cols.push({ x: p.x, z: p.z, r: .4 });
}
for (let i = 0; i < 6; i++) { // বাঁশঝাড়
  const p = spot(1.5, .8); if (!p) continue;
  for (let j = 0; j < 6; j++) { const a = j * 1.05, r = .5 * R(); addS(gc(.06, .07, 5.5, 5), 0x7fae3a, p.x + Math.cos(a) * r, 2.75, p.z + Math.sin(a) * r, 0, 1, 1, 1, (R() - .5) * .15); }
  cols.push({ x: p.x, z: p.z, r: .8 });
}
for (let i = 0; i < 6; i++) { const p = spot(1.6, 1); if (p) { putProp('hay', p.x, p.z, R() * 6); cols.push({ x: p.x, z: p.z, r: 1.4 }); } }
for (let i = 0; i < 8; i++) { const p = spot(.8, .5), sc = .7 + R() * .8; if (p) { putProp('rock', p.x, p.z, R() * 6, sc); cols.push({ x: p.x, z: p.z, r: .7 * sc }); } }
for (let i = 0; i < 30; i++) { const p = spot(1.5, .3); if (p) putProp('bush', p.x, p.z, R() * 6, .9 + R() * .4); }
{ const w = spot(1.6, 1); if (w) { addS(gc(.9, 1, .7, 12), 0x9a9a9a, w.x, .35, w.z); addS(gc(.55, .55, .72, 12), 0x2a4a6a, w.x, .36, w.z); cols.push({ x: w.x, z: w.z, r: 1.1 }); } }
const worldGeo = mergeGeometries(SP, false);
if (!worldGeo) throw new Error('world merge failed');
const world = new THREE.Mesh(worldGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
scene.add(world); SP.length = 0;
/*WORLD_END*/
{ const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: .9 });
  for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(gs(1), cm); m.scale.set(14 + i * 2, 3, 7); m.position.set(Math.cos(i * 2.4) * 110, 70 + i * 3, Math.sin(i * 2.4) * 110); scene.add(m); } }

/* ---------- মানুষ + রূপ ---------- */
const matC = {}; const mat = c => matC[c] || (matC[c] = new THREE.MeshLambertMaterial({ color: c }));
const SKINS = [0xf1c9a0, 0xd9a679, 0xb98056, 0x8d5a3b], PANTS = [0x2d3a5a, 0x3b3b3b, 0x4a5a3a];
const hairG = new THREE.SphereGeometry(.215, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
const shadowG = new THREE.CircleGeometry(.6, 14).rotateX(-Math.PI / 2), shadowM = new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: .3, depthWrite: false });
function buildProp(t) { const g = new THREE.Group(); for (const q of PROPS[t].p) { const m = new THREE.Mesh(q.g, mat(q.c)); m.position.set(...q.p); if (q.s) m.scale.set(...q.s); g.add(m); } return g; }
function label(txt) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d'); x.font = 'bold 30px "Hind Siliguri","Noto Sans Bengali",sans-serif'; x.textAlign = 'center';
  x.fillStyle = '#000a'; x.fillRect(0, 8, 256, 48); x.fillStyle = '#fff'; x.fillText(txt, 128, 43);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(2.6, .65, 1); s.position.y = 2.3; return s;
}
const av = {};
function makeAvatar(u) {
  let h = 0; for (const ch of u) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const col = new THREE.Color().setHSL((h % 360) / 360, .55, .5);
  const g = new THREE.Group(), hum = new THREE.Group(), shirt = new THREE.MeshLambertMaterial({ color: col }), skin = mat(SKINS[h % 4]), pant = mat(PANTS[h % 3]);
  const M = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); return o; };
  const limb = (w, len, x, y, m, tip, ty) => { const p = new THREE.Group(); p.position.set(x, y, 0); p.add(M(gb(w, len, w), m, 0, -len / 2, 0)); tip.position.y = ty; p.add(tip); return p; };
  const shoe = () => M(gb(.2, .1, .3), mat(0x222222), 0, 0, .05);
  const armL = limb(.14, .58, -.34, 1.28, shirt, M(gs(.08, 8, 6), skin, 0, 0, 0), -.6), armR = limb(.14, .58, .34, 1.28, shirt, M(gs(.08, 8, 6), skin, 0, 0, 0), -.6);
  const legL = limb(.18, .7, -.13, .7, pant, shoe(), -.66), legR = limb(.18, .7, .13, .7, pant, shoe(), -.66);
  hum.add(M(gb(.5, .6, .28), shirt, 0, 1, 0), M(gs(.2, 12, 10), skin, 0, 1.5, 0), M(hairG, mat(0x1a1410), 0, 1.52, 0),
    M(gs(.03, 6, 5), mat(0x111111), -.07, 1.53, .18), M(gs(.03, 6, 5), mat(0x111111), .07, 1.53, .18), armL, armR, legL, legR);
  const lb = label(players[u]?.name || '?');
  g.add(hum, M(shadowG, shadowM, 0, .06, 0), lb);
  g.userData = { hum, shirt, col, armL, armR, legL, legR, lb, prop: null, ptype: null, ph: 0, sp: 0, init: 0 };
  scene.add(g); return g;
}
function syncAvatars() {
  for (const u of Object.keys(players)) if (!av[u]) av[u] = makeAvatar(u);
  for (const u of Object.keys(av)) if (!players[u]) { scene.remove(av[u]); delete av[u]; }
}
function updateAvatars(dt) {
  const p = state.phase, gameOn = p === 'hide' || p === 'seek';
  for (const u in av) {
    const g = av[u], d = g.userData, q = u === uid ? { x: me.x, z: me.z, r: me.ry } : pos[u];
    if (!q) { g.visible = false; continue; }
    g.visible = true;
    const px = g.position.x, pz = g.position.z;
    if (u === uid || !d.init) { g.position.set(q.x, 0, q.z); g.rotation.y = q.r; d.init = 1; }
    else {
      const k = 1 - Math.exp(-12 * dt); g.position.x += (q.x - px) * k; g.position.z += (q.z - pz) * k;
      g.rotation.y += Math.atan2(Math.sin(q.r - g.rotation.y), Math.cos(q.r - g.rotation.y)) * k;
    }
    const mv = Math.hypot(g.position.x - px, g.position.z - pz) / dt;
    d.sp += (Math.min(mv, 7) - d.sp) * Math.min(1, dt * 10); d.ph += d.sp * dt * 2.2;
    const sw = Math.sin(d.ph) * Math.min(1, d.sp / 4) * .8;
    d.legL.rotation.x = sw; d.legR.rotation.x = -sw; d.armL.rotation.x = -sw; d.armR.rotation.x = sw;
    const sk = gameOn && u === state.seeker, ct = (p === 'hide' || p === 'seek' || p === 'end') && !!caught[u];
    const want = gameOn && !sk && !ct && PROPS[skin[u]] ? skin[u] : null;
    if (want !== d.ptype) { if (d.prop) { g.remove(d.prop); d.prop = null; } if (want) { d.prop = buildProp(want); g.add(d.prop); } d.ptype = want; }
    d.hum.visible = !d.prop;
    d.shirt.color.set(sk ? 0xd64545 : ct ? 0x888888 : d.col);
    g.scale.y = ct ? .45 : 1;
    d.lb.visible = u !== uid && (p === 'lobby' || sk);
  }
}

/* ---------- নিয়ন্ত্রণ ---------- */
const me = { x: 0, z: 6, ry: 0 };
let camYaw = 0, camPitch = .5, camDist = 7.5, lastSend = 0, dirty = false, stunUntil = 0, lastSig = 0;
function sendPos(force) {
  if (!room) return; const t = performance.now();
  if (!force && t - lastSend < 100) return; lastSend = t; dirty = false;
  set(ref(db, `rooms/${room}/pos/${uid}`), { x: +me.x.toFixed(2), z: +me.z.toFixed(2), r: +me.ry.toFixed(2) });
}
function spawnLobby() { me.x = (Math.random() - .5) * 8; me.z = (Math.random() - .5) * 8; sendPos(true); }
function spawnGame() {
  const parts = state.parts || [], i = parts.indexOf(uid);
  if (i < 0) return spawnLobby();
  if (iAmSeeker()) { me.x = 0; me.z = 0; camYaw = 0; }
  else { const a = i / parts.length * Math.PI * 2; me.x = Math.cos(a) * 9; me.z = Math.sin(a) * 9; camYaw = Math.atan2(Math.cos(a), Math.sin(a)); }
  sendPos(true);
}
function canMove() {
  const p = state.phase, inG = (state.parts || []).includes(uid);
  if (p === 'lobby') return true;
  if (p === 'hide') return !iAmSeeker() && inG && !caught[uid];
  if (p === 'seek') return inG && !caught[uid] && !(iAmSeeker() && performance.now() < stunUntil);
  return false;
}
const keys = {};
addEventListener('keydown', e => { if (document.activeElement.tagName === 'INPUT') return; keys[e.code] = 1; if (e.code === 'KeyE' || e.code === 'Space') doCatch(); });
addEventListener('keyup', e => keys[e.code] = 0);
let jx = 0, jz = 0, jid = null; const joy = $('joy'), knob = $('knob');
function jm(e) { const r = joy.getBoundingClientRect(), Rr = r.width / 2; let dx = e.clientX - r.left - Rr, dy = e.clientY - r.top - Rr; const d = Math.hypot(dx, dy); if (d > Rr) { dx *= Rr / d; dy *= Rr / d; } jx = dx / Rr; jz = dy / Rr; knob.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`; }
joy.addEventListener('pointerdown', e => { jid = e.pointerId; joy.setPointerCapture(jid); jm(e); });
joy.addEventListener('pointermove', e => { if (e.pointerId === jid) jm(e); });
const jend = e => { if (e.pointerId === jid) { jid = null; jx = jz = 0; knob.style.transform = 'translate(-50%,-50%)'; } };
joy.addEventListener('pointerup', jend); joy.addEventListener('pointercancel', jend);
let drag = null;
cv.addEventListener('pointerdown', e => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => { if (drag && drag.id === e.pointerId) { camYaw -= (e.clientX - drag.x) * .006; camPitch = Math.max(.12, Math.min(1.2, camPitch + (e.clientY - drag.y) * .004)); drag.x = e.clientX; drag.y = e.clientY; } });
cv.addEventListener('pointerup', () => drag = null);
$('catch').onclick = doCatch;

const skinBox = $('skins');
skinBox.innerHTML = Object.entries(PROPS).map(([k, v]) => `<button data-s="${k}">${v.n}</button>`).join('') + '<button data-s="">মানুষ</button>';
skinBox.onclick = e => { const b = e.target.closest('[data-s]'); if (!b || !room) return; set(ref(db, `rooms/${room}/skin/${uid}`), b.dataset.s || null); skinBox.hidden = true; };
$('morph').onclick = () => { skinBox.hidden = !skinBox.hidden; };

function doCatch() {
  if (!room || state.phase !== 'seek' || !iAmSeeker() || performance.now() < stunUntil) return;
  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw); let best = null, bd = 9;
  for (const u of hiders()) {
    const p = pos[u]; if (caught[u] || !p) continue;
    const dx = p.x - me.x, dz = p.z - me.z, d = Math.hypot(dx, dz);
    if (d < 3.2 && d > 0 && (dx * fx + dz * fz) / d > .7 && d < bd) { best = u; bd = d; }
  }
  if (best) { set(ref(db, `rooms/${room}/caught/${best}`), true); toast(`${players[best]?.name || ''} ধরা পড়েছে!`); }
  else { stunUntil = performance.now() + 1800; toast('ভুল! ২ সেকেন্ড থামুন'); }
}
function collide(r) {
  for (const k of cols) { const ex = me.x - k.x, ez = me.z - k.z, m = k.r + r, d2 = ex * ex + ez * ez; if (d2 < m * m && d2 > 1e-6) { const d = Math.sqrt(d2); me.x = k.x + ex / d * m; me.z = k.z + ez / d * m; } }
  for (const b of boxes) {
    const cx = Math.max(b.x1, Math.min(me.x, b.x2)), cz = Math.max(b.z1, Math.min(me.z, b.z2)), dx = me.x - cx, dz = me.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-8) { const d = Math.sqrt(d2); me.x = cx + dx / d * r; me.z = cz + dz / d * r; }
    else { const l = me.x - b.x1, rr = b.x2 - me.x, tp = me.z - b.z1, bt = b.z2 - me.z, m = Math.min(l, rr, tp, bt); if (m === l) me.x = b.x1 - r; else if (m === rr) me.x = b.x2 + r; else if (m === tp) me.z = b.z1 - r; else me.z = b.z2 + r; }
  }
}
function step(dt) {
  if (!room || !canMove()) return false;
  let f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - jz;
  let r = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + jx;
  const l = Math.hypot(f, r); if (l < .08) return false;
  if (l > 1) { f /= l; r /= l; }
  const sp = iAmSeeker() && state.phase === 'seek' ? 6 : 5.2, sn = Math.sin(camYaw), cs = Math.cos(camYaw);
  const dx = -sn * f + cs * r, dz = -cs * f - sn * r;
  me.x += dx * sp * dt; me.z += dz * sp * dt; me.ry = Math.atan2(dx, dz);
  collide(.4);
  me.x = Math.max(-HALF, Math.min(HALF, me.x)); me.z = Math.max(-HALF, Math.min(HALF, me.z));
  return true;
}
const wallBlocked = (x, z) => { for (const b of boxes) if (b.wall && x > b.x1 - .3 && x < b.x2 + .3 && z > b.z1 - .3 && z < b.z2 + .3) return true; return false; };
function camPlace(dt) {
  const cp = Math.cos(camPitch), sp = Math.sin(camPitch), hx = Math.sin(camYaw) * cp, hz = Math.cos(camYaw) * cp;
  let dist = 7.5;
  for (let i = 1; i <= 14; i++) { const d = 7.5 * i / 14; if (1.4 + sp * d < 2.9 && wallBlocked(me.x + hx * d, me.z + hz * d)) { dist = Math.max(.9, 7.5 * (i - 1) / 14 - .3); break; } }
  camDist = dist < camDist ? dist : camDist + (dist - camDist) * Math.min(1, 3 * dt);
  cam.position.set(me.x + hx * camDist, 1.4 + sp * camDist, me.z + hz * camDist);
  cam.lookAt(me.x, 1.3, me.z);
}

/* ---------- সংকেত "ডু!" ---------- */
let AC;
function audio() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); return AC; }
addEventListener('pointerdown', () => { try { audio(); } catch (e) {} });
function beep(pan, gain) {
  try {
    const a = audio(), o = a.createOscillator(), g = a.createGain(), T = a.currentTime;
    o.type = 'sine'; o.frequency.setValueAtTime(440, T); o.frequency.exponentialRampToValueAtTime(230, T + .3);
    g.gain.setValueAtTime(Math.max(.02, gain), T); g.gain.exponentialRampToValueAtTime(.001, T + .34); o.connect(g);
    if (a.createStereoPanner) { const p = a.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(a.destination); } else g.connect(a.destination);
    o.start(T); o.stop(T + .36);
  } catch (e) {}
}
function playSignal() {
  const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  for (const u of hiders()) {
    if (caught[u]) continue;
    if (u === uid) { beep(0, .25); continue; }
    const p = pos[u]; if (!p) continue;
    const dx = p.x - me.x, dz = p.z - me.z, d = Math.hypot(dx, dz) || 1;
    beep(Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)), .7 * Math.exp(-d / 22));
  }
  const e = $('sig'); e.hidden = false; clearTimeout(e._t); e._t = setTimeout(() => e.hidden = true, 1300);
}

/* ---------- রেন্ডার লুপ ---------- */
function resize() { renderer.setSize(innerWidth, innerHeight, false); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const t = performance.now(), dt = Math.max(.001, Math.min(.05, (t - last) / 1000)); last = t;
  if (step(dt)) dirty = true;
  if (dirty && t - lastSend >= 100) sendPos(true);
  updateAvatars(dt);
  if (room) {
    camPlace(dt);
    if (state.phase === 'seek' && state.seekStart) { const k = Math.floor((now() - state.seekStart) / SIG_MS); if (k > lastSig) { lastSig = k; playSignal(); } }
  } else { const a = t / 7000; cam.position.set(Math.cos(a) * 44, 18, Math.sin(a) * 44); cam.lookAt(0, 2, 0); }
  renderer.render(scene, cam);
});
