import * as THREE from 'three';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, set, update, remove, onDisconnect, get, onChildAdded } from 'firebase/database';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const bn = n => String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const MAX = 18, HIDE_MS = 40000, SIG_MS = 20000, TOSS_MS = 12000, COIN_MS = 5500, END_MS = 8000, HALF = 38; // HALF = গ্রামের সীমানা (আগে ৫২ ছিল)
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
    onValue(ref(db, b + 'skin'), s => { skin = s.val() || {}; renderAll(); }),
    onChildAdded(ref(db, b + 'shots'), s => { const v = s.val(); if (!v || seenShots.has(s.key) || now() - v.t > 3000) return; seenShots.add(s.key); spawnBall(v, false); })
  ];
}
function leaveRoom() {
  unsubs.forEach(f => f()); unsubs = [];
  if (room) {
    remove(ref(db, `rooms/${room}/players/${uid}`)); remove(ref(db, `rooms/${room}/pos/${uid}`)); remove(ref(db, `rooms/${room}/choices/${uid}`)); remove(ref(db, `rooms/${room}/skin/${uid}`));
    update(ref(db, 'online/' + uid), { room: '' });
  }
  room = null; players = {}; pos = {}; skin = {}; choices = {}; caught = {}; state = { phase: 'lobby' };
  syncAvatars(); clearPaint(); seenShots.clear();
  ['hud', 'joy', 'lobby', 'toss', 'coinov', 'blind', 'end', 'catch', 'morph', 'skins', 'xh', 'hint'].forEach(i => $(i).hidden = true);
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

/* ---------- ফোনে সবসময় আড়াআড়ি (landscape) ---------- */
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
function goLandscape() {
  if (NATIVE) return; // অ্যাপে ম্যানিফেস্টই আড়াআড়ি ধরে রাখে, JS দিয়ে আর ঘোরানো হয় না
  try {
    const d = document.documentElement;
    if (!document.fullscreenElement && d.requestFullscreen) { const r = d.requestFullscreen({ navigationUI: 'hide' }); r && r.catch && r.catch(() => {}); }
    const o = screen.orientation; if (o && o.lock) { const r = o.lock('landscape'); r && r.catch && r.catch(() => {}); }
  } catch (e) {}
}
addEventListener('pointerdown', () => { if (!NATIVE && matchMedia('(pointer:coarse)').matches) goLandscape(); }, { once: true });

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
  const toHide = (seeker, msg) => put({ phase: 'hide', seeker, parts: (s.parts || []).filter(u => players[u]), deadline: t + HIDE_MS, msg: msg || '' }, { choices: null, caught: null, skin: null, shots: null });
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
  if (p === 'end' && t >= s.deadline) return put({ phase: 'lobby' }, { choices: null, caught: null, skin: null, shots: null });
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
    if (p === 'hide' || p === 'lobby') clearPaint();
    if (p === 'seek' && iAmSeeker()) toast('ফায়ার চেপে রঙের গুলি ছুড়ুন!');
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
  $('catch').hidden = !(p === 'seek' && iAmSeeker()); $('xh').hidden = $('catch').hidden;
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
const COARSE = matchMedia('(pointer:coarse)').matches; // ফোন/ট্যাবলেট
renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.6 : 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = COARSE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe9f5, 32, 100);
const cam = new THREE.PerspectiveCamera(62, 1, .1, 240);
scene.add(new THREE.HemisphereLight(0xdcefff, 0x6d8a4f, .95));
const sun = new THREE.DirectionalLight(0xfff0d0, 1.3); sun.position.set(40, 60, 25); sun.castShadow = true;
{ const S = COARSE ? 27 : 34, sc = sun.shadow.camera; sun.shadow.mapSize.set(COARSE ? 1024 : 2048, COARSE ? 1024 : 2048);
  sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S; sc.near = 10; sc.far = 170; sun.shadow.bias = -.0004; sun.shadow.normalBias = .05; }
scene.add(sun, sun.target);
function shadowFollow() { // ছায়ার বাক্স খেলোয়াড়ের সাথে সাথে চলে
  const q = .07, tx = room ? Math.round(me.x / q) * q : 0, tz = room ? Math.round(me.z / q) * q : 0;
  sun.target.position.set(tx, 0, tz); sun.position.set(tx + 40, 60, tz + 25);
}
{ // আকাশ
  const g = new THREE.SphereGeometry(180, 16, 10), pa = g.attributes.position, n = pa.count, a = new Float32Array(n * 3);
  const top = new THREE.Color(0x4a9de0), hor = new THREE.Color(0xcfe9f5), c = new THREE.Color();
  for (let i = 0; i < n; i++) { c.copy(hor).lerp(top, Math.pow(Math.max(0, pa.getY(i) / 180), .6)); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })));
}
/*WORLD_START*/
const ripples = [], water = {};
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
const prop = (n, p, r, h, fp) => ({ n, p, r, h, fp });
const BK = (y, c) => P(gb(1.2, .12, .3), 0, y, .02, c);
const PROPS = {
  chair: prop('চেয়ার', [P(gb(.5, .08, .5), 0, .45, 0, WD), P(gb(.5, .6, .08), 0, .78, -.21, WD), ...legs(.45, .06, .2, .2, WD)], .4, 1.1, [.5, .5]),
  table: prop('টেবিল', [P(gb(1.4, .08, .9), 0, .8, 0, 0x9b6a3a), ...legs(.8, .08, .6, .35, 0x7d5229)], .8, .9, [1.4, .9]),
  sofa: prop('সোফা', [P(gb(2, .5, .9), 0, .25, 0, 0x3f6ea8), P(gb(2, .55, .2), 0, .78, -.35, 0x345c8e), P(gb(.2, .6, .9), -1, .4, 0, 0x345c8e), P(gb(.2, .6, .9), 1, .4, 0, 0x345c8e)], 1.05, 1.2, [2, .9]),
  bed: prop('খাট', [P(gb(2, .4, 1.4), 0, .2, 0, WD), P(gb(1.9, .2, 1.3), 0, .5, 0, 0xe8e0d0), P(gb(.5, .12, .35), -.7, .66, 0, 0xffffff), P(gb(.08, .9, 1.4), -1, .45, 0, 0x6e4521)], 1.1, .9, [2, 1.4]),
  cupboard: prop('আলমারি', [P(gb(1, 2, .5), 0, 1, 0, 0x7a4a24), P(gb(.03, 1.8, .03), 0, 1, .26, 0x2b1b0c)], .65, 2, [1, .5]),
  shelf: prop('বইয়ের তাক', [P(gb(1.4, 1.8, .4), 0, .9, 0, 0x7a4a24), BK(.5, 0xc0392b), BK(.95, 0x2e86c1), BK(1.4, 0xf1c40f)], .75, 1.8, [1.4, .4]),
  tv: prop('টিভি', [P(gb(1.4, .5, .5), 0, .25, 0, 0x5b3a1e), P(gb(1.2, .75, .06), 0, .85, -.03, 0x2b2b2b), P(gb(1.1, .65, .08), 0, .85, 0, 0x111111)], .75, 1.25, [1.4, .5]),
  lamp: prop('বাতি', [P(gc(.2, .25, .06, 10), 0, .03, 0, 0x444444), P(gc(.03, .03, 1.5, 6), 0, .8, 0, 0x444444), P(gc(.28, .16, .35, 10), 0, 1.65, 0, 0xffe08a)], .3, 1.85, [.4, .4]),
  plant: prop('গাছের টব', [P(gc(.3, .22, .4, 10), 0, .2, 0, 0xb5562e), P(gs(.4, 8, 6), 0, .7, 0, 0x2f8f3a), P(gs(.28, 8, 6), .2, .95, .1, 0x3aa347)], .45, 1.3, [.6, .6]),
  stool: prop('মোড়া', [P(gc(.3, .3, .45, 10), 0, .225, 0, 0xc58b4a)], .35, .5, [.6, .6]),
  bench: prop('বেঞ্চ', [P(gb(1.6, .08, .5), 0, .5, 0, WD), P(gb(1.6, .4, .06), 0, .8, -.22, WD), ...legs(.5, .07, .7, .18, 0x6b4423)], .9, 1, [1.6, .5]),
  bucket: prop('বালতি', [P(gc(.3, .24, .5, 10), 0, .25, 0, 0xd1453b)], .35, .55, [.6, .6]),
  tree: prop('গাছ', [P(gc(.28, .4, 3, 6), 0, 1.5, 0, 0x6b4423), P(gs(1.8, 8, 6), 0, 3.8, 0, 0x2f7a35), P(gs(1.3, 8, 6), .9, 3.2, .3, 0x3a8a3c), P(gs(1.2, 8, 6), -.8, 3.4, -.5, 0x2a6b30)], 1, 5, [1, 1]),
  bush: prop('ঝোপ', [P(gs(1.3, 8, 6), 0, .9, 0, 0x3f7d3a, [1, .85, 1]), P(gs(.8, 8, 6), .9, .6, .4, 0x4c8c44)], 1.2, 1.4, [1, 1]),
  hay: prop('খড়ের গাদা', [P(gk(1.6, 2.6, 8), 0, 1.3, 0, 0xe0c060)], 1.3, 2.6, [1, 1]),
  pot: prop('কলস', [P(gs(.5, 10, 8), 0, .5, 0, 0xb5562e), P(gc(.2, .3, .25, 10), 0, 1.05, 0, 0xb5562e)], .5, 1.3, [1, 1]),
  drum: prop('ড্রাম', [P(gc(.45, .45, .9, 10), 0, .45, 0, 0x2f5fa0)], .5, .9, [1, 1]),
  rock: prop('পাথর', [P(gs(.8, 7, 5), 0, .4, 0, 0x8a8d90, [1, .7, 1])], .75, .8, [1, 1])
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
  const g = new THREE.PlaneGeometry(104, 104, 26, 26).rotateX(-Math.PI / 2), pa = g.attributes.position, n = pa.count, a = new Float32Array(n * 3);
  const c1 = new THREE.Color(0x5c9a43), c2 = new THREE.Color(0x7db55a), c = new THREE.Color();
  for (let i = 0; i < n; i++) { const x = pa.getX(i), z = pa.getZ(i), v = (Math.sin(x * .21) + Math.sin(z * .17) + Math.sin((x + z) * .09) + Math.sin(x * .05) * Math.cos(z * .07)) / 4 * .5 + .5; c.copy(c1).lerp(c2, v); a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); SP.push(g);
}
addS(gcirc, 0x70a050, 0, -.05, 0, 0, 170, 1, 170); // সীমানার বাইরের সবুজ মাঠ (ফাঁকা দেখাবে না)
// রাস্তা, উঠান, পুকুর, ধানক্ষেত, ঘাট, নৌকা
addS(gp(), 0xc9a46a, 0, .02, 0, 0, 86, 1, 5); addS(gp(), 0xc9a46a, 0, .02, 0, 0, 5, 1, 86);
addS(gcirc, 0xd2b27a, 0, .022, 0, 0, 9, 1, 9);
const PX = 23, PZ = -19, PR = 8; // পুকুর
addS(gcirc, 0xd8c58a, PX, .025, PZ, 0, PR + .9, 1, PR + .9); // পুকুরের পানি আলাদা মেশ (নিচে), যাতে ঢেউ খেলে
addS(gp(), 0xaac85a, -31, .02, -31, 0, 14, 1, 10); addS(gp(), 0xaac85a, 31, .02, 31, 0, 14, 1, 10);
for (let i = 0; i < 3; i++) addS(gb(.7, .1 * (3 - i), 3), 0xb0a690, PX - PR + .5 - i * .7, .05 * (3 - i), PZ);
addS(gb(3.2, .35, 1.1), WD, PX + 4, .15, PZ - 5, .4);

const boxes = [], hbs = [], rooms = [], cols = [{ x: PX, z: PZ, r: PR + 1, h: 0 }];
const resv = [{ x: PX, z: PZ, r: PR + 2 }, { x: -31, z: -31, r: 9 }, { x: 31, z: 31, r: 9 }, { x: 0, z: 0, r: 10 }];
function spot(rad, gap, lim = 32, rc = 0) {
  for (let i = 0; i < 100; i++) {
    const x = (R() * 2 - 1) * lim, z = (R() * 2 - 1) * lim;
    if (rc ? (Math.abs(x) < rad || Math.abs(z) < rad) : (Math.abs(x) < 3.5 || Math.abs(z) < 3.5)) continue;
    if (resv.every(c => Math.hypot(x - c.x, z - c.z) > c.r + rad + gap)) { resv.push({ x, z, r: rad }); return { x, z }; }
  }
  return null;
}
for (let i = 0; i < 8; i++) { addS(gp(), 0x95b44a, -31, .025, -35.6 + i * 1.3, 0, 13, 1, .3); addS(gp(), 0x95b44a, 31, .025, 26.4 + i * 1.3, 0, 13, 1, .3); }
for (let i = 0; i < 8; i++) { const a = i * .8, r = 2 + (i % 3) * 1.8; addS(gcirc, 0x3f9d4a, PX + Math.cos(a) * r, .035, PZ + Math.sin(a) * r, 0, .5, 1, .5); }
function house(cx, cz, k, W, D, wc, rc) {
  const ry = k * Math.PI / 2, c = Math.round(Math.cos(ry)), s = Math.round(Math.sin(ry)), H = 2.8, odd = k & 1;
  const wp = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
  const wall = (x1, z1, x2, z2) => {
    const w = Math.abs(x2 - x1) || .25, d = Math.abs(z2 - z1) || .25, [wx, wz] = wp((x1 + x2) / 2, (z1 + z2) / 2);
    addS(gb(w, H, d), wc, wx, H / 2, wz, ry);
    const hw = (odd ? d : w) / 2, hd = (odd ? w : d) / 2; boxes.push({ x1: wx - hw, x2: wx + hw, z1: wz - hd, z2: wz + hd, wall: 1, h: H });
  };
  wall(-W / 2, -D / 2, W / 2, -D / 2); wall(-W / 2, -D / 2, -W / 2, D / 2); wall(W / 2, -D / 2, W / 2, D / 2);
  wall(-W / 2, D / 2, -.9, D / 2); wall(.9, D / 2, W / 2, D / 2); // সামনের দেয়ালে দরজা
  { const [x, z] = wp(0, D / 2); addS(gb(1.8, .6, .25), wc, x, 2.5, z, ry); const [a, b] = wp(0, D / 2 + .5); addS(gb(2.4, .15, .8), 0xb0a690, a, .075, b, ry);
    for (const sx of [-.95, .95]) { const [p, q] = wp(sx, D / 2); addS(gb(.12, 2.2, .32), 0x5a3a1e, p, 1.1, q, ry); } }
  { const [x, z] = wp(0, 0); addS(gp(), 0xb98b5e, x, .03, z, ry, W - .3, 1, D - .3);
    const [a, b] = wp(W / 4, .3); addS(gp(), 0xa8423a, a, .045, b, ry, 3.2, 1, 2.2);
    const [e, f] = wp(-W / 2 + 2, -D / 2 + 2.3); addS(gp(), 0x3a6a8a, e, .045, f, ry, 3, 1, 1.8); }
  addS(roofG, rc, cx, H + .9, cz, ry, (W / 2 + .55) / .7071, 1, (D / 2 + .55) / .7071);
  { const [x, z] = wp(W / 4, -D / 4); addS(gb(.6, 1.5, .6), 0x8a4b3a, x, H + 1.1, z, ry); }
  const win = (lx, lz, an) => { const [x, z] = wp(lx, lz); addS(gb(.9, .7, .06), 0x2d4a5a, x, 1.6, z, ry + an); };
  for (const d of [-.14, .14]) { win(0, -D / 2 + d, 0); win(-W / 2 + d, 0, Math.PI / 2); win(W / 2 + d, 0, Math.PI / 2); win(-W / 4, D / 2 + d, 0); win(W / 4, D / 2 + d, 0); }
  const fu = (t, lx, lz, an = 0) => {
    const [x, z] = wp(lx, lz); putProp(t, x, z, ry + an);
    const o = Math.round((ry + an) / (Math.PI / 2)) & 1, [fw, fd] = PROPS[t].fp, hw = (o ? fd : fw) / 2, hd = (o ? fw : fd) / 2;
    boxes.push({ x1: x - hw, x2: x + hw, z1: z - hd, z2: z + hd, h: PROPS[t].h });
  };
  fu('sofa', -W / 2 + 1.4, -D / 2 + .8); fu('shelf', 0, -D / 2 + .35); fu('bed', W / 2 - 1.4, -D / 2 + .9);
  fu('table', W / 4, .3); fu('chair', W / 4 - 1.1, .5, Math.PI / 2); fu('chair', W / 4 + 1.1, .2, -Math.PI / 2); fu('chair', W / 4, 1.25, Math.PI); fu('chair', W / 4, -.65);
  fu('cupboard', -W / 2 + .5, .2, Math.PI / 2); fu('cupboard', -W / 2 + .5, 1.8, Math.PI / 2);
  fu('tv', W / 2 - .4, D / 4, -Math.PI / 2); fu('lamp', -W / 2 + .45, D / 2 - .6); fu('plant', W / 2 - .5, D / 2 - .6); fu('stool', -1.8, 1.6);
  const hx = (odd ? D : W) / 2, hz = (odd ? W : D) / 2;
  hbs.push({ x1: cx - hx - .55, x2: cx + hx + .55, z1: cz - hz - .55, z2: cz + hz + .55, cx, cz, hw: hx + .55, hd: hz + .55 });
  rooms.push({ x1: cx - hx + .13, x2: cx + hx - .13, z1: cz - hz + .13, z2: cz + hz - .13 });
}
const wallCols = [0xe3cfa6, 0xd2a679, 0xb9c9a0, 0xe6d9c0, 0xc9d6dd], roofCols = [0x8fa1aa, 0xb68b45, 0x9a4f2f, 0x6e7f8a];
for (let i = 0; i < 9; i++) {
  const W = 11 + (R() < .5 ? 2 : 0), D = 9 + (R() < .5 ? 1 : 0), p = spot(Math.max(W, D) / 2 + 2.9, .3, 30, 1);
  if (p) house(p.x, p.z, R() * 4 | 0, W, D, wallCols[i % 5], roofCols[i % 4]);
}
const inHb = (x, z, m = 0) => hbs.some(h => x > h.x1 - m && x < h.x2 + m && z > h.z1 - m && z < h.z2 + m);
for (let i = 0; i < 16; i++) { const p = spot(1.2, .8); if (p) { putProp('tree', p.x, p.z, R() * 6, .9 + R() * .5); cols.push({ x: p.x, z: p.z, r: .55, h: 5 }); } }
for (let i = -42; i <= 42; i += 6) for (const [x, z] of [[i, 43], [i, -43], [43, i], [-43, i]]) putProp('tree', x, z, R() * 6, 1.2);
for (let i = 0; i < 7; i++) { // নারকেল গাছ
  const p = spot(1, .8); if (!p) continue; const h = 5 + R() * 1.5;
  addS(gc(.13, .22, h, 6), 0x8a6a45, p.x, h / 2, p.z);
  for (let j = 0; j < 7; j++) addS(leafG, 0x3d8f3a, p.x, h, p.z, j * .9 + R() * .3, 1, 1, 1, -.55);
  cols.push({ x: p.x, z: p.z, r: .4, h: 6 });
}
for (let i = 0; i < 3; i++) { // বাঁশঝাড়
  const p = spot(1.5, .8); if (!p) continue;
  for (let j = 0; j < 6; j++) { const a = j * 1.05, r = .5 * R(); addS(gc(.06, .07, 5.5, 5), 0x7fae3a, p.x + Math.cos(a) * r, 2.75, p.z + Math.sin(a) * r, 0, 1, 1, 1, (R() - .5) * .15); }
  cols.push({ x: p.x, z: p.z, r: .8, h: 5.5 });
}
for (let i = 0; i < 3; i++) { const p = spot(1.6, 1); if (p) { putProp('hay', p.x, p.z, R() * 6); cols.push({ x: p.x, z: p.z, r: 1.4, h: 2.6 }); } }
for (let i = 0; i < 4; i++) { const p = spot(.8, .5), sc = .7 + R() * .8; if (p) { putProp('rock', p.x, p.z, R() * 6, sc); cols.push({ x: p.x, z: p.z, r: .7 * sc, h: .8 * sc }); } }
for (let i = 0; i < 3; i++) { const p = spot(1.3, .8); if (p) { putProp('bench', p.x, p.z, R() * 6.28); cols.push({ x: p.x, z: p.z, r: .9, h: 1 }); } }
for (let i = 0; i < 16; i++) { const p = spot(1.5, .3); if (p) putProp('bush', p.x, p.z, R() * 6, .9 + R() * .4); }
for (const [x, z] of [[4.5, 18], [-4.5, -18], [4.5, -18], [-4.5, 18], [18, 4.5], [-18, -4.5], [18, -4.5], [-18, 4.5]]) { // রাস্তার বাতি
  addS(gc(.06, .08, 4, 6), 0x444444, x, 2, z); addS(gs(.22, 8, 6), 0xffe9a0, x, 4.1, z); cols.push({ x, z, r: .3, h: 4 });
}
const FLW = [0xff5a5a, 0xffd84a, 0xff9ad5, 0xffffff, 0xb07aff];
for (let i = 0; i < 20; i++) { const p = spot(.5, .2); if (!p) continue; for (let j = 0; j < 5; j++) addS(gs(.1, 6, 5), FLW[(i + j) % 5], p.x + (R() - .5) * .7, .15, p.z + (R() - .5) * .7); }
const GRN = [0x4f8f3a, 0x6fae48, 0x3f7d33];
for (let i = 0; i < 100; i++) { const x = (R() * 2 - 1) * 38, z = (R() * 2 - 1) * 38; if (inHb(x, z, 1) || Math.hypot(x - PX, z - PZ) < PR + 1.6 || Math.abs(x) < 3 || Math.abs(z) < 3) continue; addS(gk(.1, .55, 4), GRN[i % 3], x, .27, z, R() * 6); }
{ const w = spot(1.6, 1); if (w) { addS(gc(.9, 1, .7, 12), 0x9a9a9a, w.x, .35, w.z); addS(gc(.55, .55, .72, 12), 0x2a4a6a, w.x, .36, w.z); cols.push({ x: w.x, z: w.z, r: 1.1, h: .7 }); } }
function solidAt(x, y, z) {
  if (y <= 0) return 1;
  for (const b of boxes) if (y < b.h && x > b.x1 && x < b.x2 && z > b.z1 && z < b.z2) return 1;
  for (const k of cols) if (k.h && y < k.h) { const ex = x - k.x, ez = z - k.z; if (ex * ex + ez * ez < k.r * k.r) return 1; }
  for (const h of hbs) if (y > 2.8 && x > h.x1 && x < h.x2 && z > h.z1 && z < h.z2) { const f = 1 - Math.max(Math.abs(x - h.cx) / h.hw, Math.abs(z - h.cz) / h.hd); if (y < 2.8 + 1.8 * f) return 1; }
  return 0;
}
function rayWorld(ox, oy, oz, dx, dy, dz, max) {
  for (let t = .5; t < max; t += .25) { const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t; if (solidAt(x, y, z)) return { t, x, y, z, hit: 1 }; }
  return { t: max, x: ox + dx * max, y: oy + dy * max, z: oz + dz * max, hit: 0 };
}
const worldGeo = mergeGeometries(SP, false);
if (!worldGeo) throw new Error('world merge failed');
const world = new THREE.Mesh(worldGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
world.receiveShadow = true; world.castShadow = true;
scene.add(world); SP.length = 0;
{ // পুকুরের পানি: আলাদা মেশ, ঢেউ আর ঝিলিক সহ
  const wm = new THREE.MeshLambertMaterial({ color: 0x3f94c9, transparent: true, opacity: .88, emissive: 0x0b3a5a, emissiveIntensity: .35, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const w = new THREE.Mesh(gcirc, wm); w.position.set(PX, .03, PZ); w.scale.set(PR, 1, PR); w.receiveShadow = true; scene.add(w);
  for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.RingGeometry(.92, 1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .4, depthWrite: false })); r.position.set(PX, .05, PZ); scene.add(r); ripples.push(r); }
  water.m = wm;
}
/*WORLD_END*/
{ const sd = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 10), new THREE.MeshBasicMaterial({ color: 0xfff3b0, fog: false })); sd.position.set(86.6, 129.9, 54.1); scene.add(sd);
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,244,190,.95)'); gr.addColorStop(.25, 'rgba(255,230,150,.45)'); gr.addColorStop(1, 'rgba(255,230,150,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false, depthWrite: false, transparent: true })); gl.scale.set(95, 95, 1); gl.position.copy(sd.position); scene.add(gl); }
const clouds = [];
{ const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: .93 });
  for (let i = 0; i < 9; i++) { // প্রতিটা মেঘ কয়েকটা গোলা জোড়া দিয়ে, আস্তে আস্তে ভেসে যায়
    const g = new THREE.Group(), s = 1 + (i % 3) * .35;
    for (let j = 0; j < 4; j++) { const m = new THREE.Mesh(gs(1, 12, 8), cm); m.scale.set((9 - j * 1.2) * s, (3.2 - j * .35) * s, (5.5 - j * .5) * s); m.position.set((j - 1.5) * 8 * s, (j % 2) * 1.6, (j % 2 ? 2 : -1.5)); g.add(m); }
    g.position.set(Math.cos(i * 2.4) * 105, 72 + (i % 4) * 5, Math.sin(i * 2.4) * 105); g.userData.sp = 1.2 + (i % 3) * .6; scene.add(g); clouds.push(g);
  } }

/* ---------- মানুষ + রূপ ---------- */
const matC = {}; const mat = c => matC[c] || (matC[c] = new THREE.MeshLambertMaterial({ color: c }));
const SKINS = [0xf1c9a0, 0xd9a679, 0xb98056, 0x8d5a3b], PANTS = [0x2d3a5a, 0x3b3b3b, 0x4a5a3a];
const hairG = new THREE.SphereGeometry(.215, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
const shadowG = new THREE.CircleGeometry(.6, 14).rotateX(-Math.PI / 2), shadowM = new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: .16, depthWrite: false });
function buildProp(t) { const g = new THREE.Group(); for (const q of PROPS[t].p) { const m = new THREE.Mesh(q.g, mat(q.c)); m.position.set(...q.p); if (q.s) m.scale.set(...q.s); m.castShadow = true; g.add(m); } return g; }
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
  const gun = new THREE.Group(), brl = M(gc(.035, .035, .4, 6), mat(0x888888), 0, .03, .6); brl.rotation.x = Math.PI / 2;
  gun.add(M(gb(.1, .16, .5), mat(0x333333), 0, 0, .2), brl, M(gs(.09, 8, 6), mat(0xff3b30), 0, .15, .1), M(gb(.07, .2, .09), mat(0x222222), 0, -.15, .05));
  gun.scale.setScalar(1.6); gun.position.set(.34, 1.0, .3); gun.visible = false; hum.add(gun);
  const lb = label(players[u]?.name || '?');
  g.add(hum, M(shadowG, shadowM, 0, .06, 0), lb);
  g.userData = { hum, shirt, gun, col, armL, armR, legL, legR, lb, prop: null, ptype: null, ph: 0, sp: 0, init: 0 };
  g.traverse(o => { if (o.isMesh && o.geometry !== shadowG) o.castShadow = true; });
  scene.add(g); return g;
}
function syncAvatars() {
  for (const u of Object.keys(players)) if (!av[u]) av[u] = makeAvatar(u);
  for (const u of Object.keys(av)) if (!players[u]) { scene.remove(av[u]); delete av[u]; }
}
function updateAvatars(dt) {
  // ঘাড় ঘুরিয়ে পাশ থেকে দেখলে হালকা দুলুনি (শ্বাস)

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
    if (mv > 3.5 && !d.prop && (d.dust = (d.dust || 0) - dt) < 0) { d.dust = .14; emit(g.position.x, .1, g.position.z, (Math.random() - .5) * .6, .5, (Math.random() - .5) * .6, .45, dustM, .13, 0); }
    d.sp += (Math.min(mv, 7) - d.sp) * Math.min(1, dt * 10); d.ph += d.sp * dt * 2.2;
    const sw = Math.sin(d.ph) * Math.min(1, d.sp / 4) * .8;
    d.legL.rotation.x = sw; d.legR.rotation.x = -sw; d.armL.rotation.x = -sw; d.armR.rotation.x = sw;
    const sk = gameOn && u === state.seeker, ct = (p === 'hide' || p === 'seek' || p === 'end') && !!caught[u];
    const want = gameOn && !sk && !ct && PROPS[skin[u]] ? skin[u] : null;
    if (want !== d.ptype) { if (d.prop) { g.remove(d.prop); d.prop = null; } if (want) { d.prop = buildProp(want); g.add(d.prop); } d.ptype = want; }
    d.hum.visible = !d.prop; d.gun.visible = sk;
    d.shirt.color.set(sk ? 0xd64545 : ct ? (typeof caught[u] === 'number' ? caught[u] : 0x888888) : d.col);
    g.scale.y = ct ? .45 : 1;
    d.lb.visible = u !== uid && (p === 'lobby' || sk);
  }
}

/* ---------- নিয়ন্ত্রণ ---------- */
const me = { x: 0, z: 6, ry: 0 };
let camYaw = 0, camPitch = .5, camF = 1, lastSend = 0, dirty = false, lastSig = 0;
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
  if (p === 'seek') return inG && !caught[uid];
  return false;
}
const keys = {};
addEventListener('keydown', e => { if (document.activeElement.tagName === 'INPUT') return; keys[e.code] = 1; if (e.code === 'KeyE' || e.code === 'Space') fire(); });
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
let fireIv = null; const fb = $('catch');
fb.addEventListener('pointerdown', e => { e.preventDefault(); fire(); clearInterval(fireIv); fireIv = setInterval(fire, 230); });
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => fb.addEventListener(ev, () => { clearInterval(fireIv); fireIv = null; }));

const skinBox = $('skins');
skinBox.innerHTML = Object.entries(PROPS).map(([k, v]) => `<button data-s="${k}">${v.n}</button>`).join('') + '<button data-s="">মানুষ</button>';
skinBox.onclick = e => { const b = e.target.closest('[data-s]'); if (!b || !room) return; set(ref(db, `rooms/${room}/skin/${uid}`), b.dataset.s || null); skinBox.hidden = true; };
$('morph').onclick = () => { skinBox.hidden = !skinBox.hidden; };

/* ---------- কণা: ধুলো আর রঙের ছিটা ---------- */
const parts = [], dustM = new THREE.MeshBasicMaterial({ color: 0xe6d5ac, transparent: true, opacity: .55, depthWrite: false });
function emit(x, y, z, vx, vy, vz, life, mt, size, g) {
  let o; if (parts.length >= 90) { o = parts.shift(); o.m.visible = true; } else { o = { m: new THREE.Mesh(gs(1, 6, 4), mt) }; scene.add(o.m); }
  o.m.material = mt; o.m.position.set(x, y, z); o.size = size; o.vx = vx; o.vy = vy; o.vz = vz; o.life = o.max = life; o.g = g; o.m.scale.setScalar(size); parts.push(o);
}
function updateParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const o = parts[i]; o.life -= dt;
    if (o.life <= 0) { scene.remove(o.m); parts.splice(i, 1); continue; }
    o.vy -= o.g * dt; o.m.position.x += o.vx * dt; o.m.position.y = Math.max(.03, o.m.position.y + o.vy * dt); o.m.position.z += o.vz * dt;
    o.m.scale.setScalar(o.size * (o.g ? o.life / o.max : 1 + (1 - o.life / o.max) * 1.2) * (o.g ? 1 : Math.min(1, o.life / o.max * 2.5)));
  }
}
function paintBurst(x, y, z, c) { for (let i = 0; i < 7; i++) emit(x, y, z, (Math.random() - .5) * 4, Math.random() * 3.5, (Math.random() - .5) * 4, .5 + Math.random() * .3, ballMat(c), .07 + Math.random() * .05, 14); }

/* ---------- বন্দুক: রঙের গুলি ---------- */
const BALLC = [0xff3b30, 0x34c759, 0x0a84ff, 0xffd60a, 0xff2d95, 0xbf5af2, 0xff9f0a];
const balls = [], splats = [], bm = {}, spm = {}, seenShots = new Set();
const ballMat = c => bm[c] || (bm[c] = new THREE.MeshBasicMaterial({ color: c }));
const splatG = new THREE.CircleGeometry(1, 10);
let lastFire = 0;
function spawnBall(v, mine) {
  const m = new THREE.Mesh(gs(.2, 10, 8), ballMat(v.c)); m.position.set(v.x, v.y, v.z); scene.add(m);
  balls.push({ m, x: v.x, y: v.y, z: v.z, dx: v.dx, dy: v.dy, dz: v.dz, c: v.c, mine: !!mine, life: 0 });
}
function splat(x, y, z, dx, dy, dz, c) {
  let m; paintBurst(x, y, z, c);
  if (splats.length >= 90) m = splats.shift(); else { m = new THREE.Mesh(splatG, null); scene.add(m); }
  m.material = spm[c] || (spm[c] = new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const s = .3 + Math.random() * .25; m.scale.set(s, s * (.7 + Math.random() * .6), 1);
  if (y < .12) { m.position.set(x, .07, z); m.rotation.set(-Math.PI / 2, 0, Math.random() * 6); }
  else { m.rotation.set(0, 0, 0); m.position.set(x - dx * .04, y - dy * .04, z - dz * .04); m.lookAt(x - dx, y - dy, z - dz); m.rotateZ(Math.random() * 6); }
  splats.push(m);
}
function clearPaint() { splats.forEach(m => scene.remove(m)); splats.length = 0; balls.forEach(b => scene.remove(b.m)); balls.length = 0; }
function updateBalls(dt) {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i]; let dead = false; const sp = 40, n = Math.max(1, Math.ceil(sp * dt / .25)), h = dt / n;
    for (let k = 0; k < n && !dead; k++) {
      b.x += b.dx * sp * h; b.y += b.dy * sp * h; b.z += b.dz * sp * h;
      if (b.mine) for (const u of hiders()) {
        if (caught[u] || !av[u]) continue;
        const pp = av[u].position, def = state.phase === 'seek' && PROPS[skin[u]] ? PROPS[skin[u]] : null, r = (def ? def.r : .45) + .13, hh = def ? def.h : 1.8;
        if (b.y > -.1 && b.y < hh && (b.x - pp.x) ** 2 + (b.z - pp.z) ** 2 < r * r) { set(ref(db, `rooms/${room}/caught/${u}`), b.c); toast(`${players[u]?.name || ''} ধরা পড়েছে!`); dead = true; break; }
      }
      if (!dead && solidAt(b.x, b.y, b.z)) { splat(b.x, b.y, b.z, b.dx, b.dy, b.dz, b.c); dead = true; }
    }
    b.life += dt;
    if (dead || b.life > 1.6) { scene.remove(b.m); balls.splice(i, 1); } else b.m.position.set(b.x, b.y, b.z);
  }
}
const vtmp = new THREE.Vector3();
const aimPitch = () => Math.max(-.6, Math.min(.7, -(camPitch - .5) * 1.3));
function fire() {
  if (!room || state.phase !== 'seek' || !iAmSeeker() || !canMove()) return;
  const t = performance.now(); if (t - lastFire < 200) return; lastFire = t;
  cam.getWorldDirection(vtmp);
  const hit = rayWorld(cam.position.x, cam.position.y, cam.position.z, vtmp.x, vtmp.y, vtmp.z, 55);
  const ap = aimPitch(), cp = Math.cos(ap), mx = me.x - Math.sin(camYaw) * cp * .6, my = 1.4 + Math.sin(ap) * .6, mz = me.z - Math.cos(camYaw) * cp * .6;
  let dx = hit.x - mx, dy = hit.y - my, dz = hit.z - mz; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  const key = uid + '_' + Date.now();
  const data = { x: +mx.toFixed(2), y: +my.toFixed(2), z: +mz.toFixed(2), dx: +dx.toFixed(3), dy: +dy.toFixed(3), dz: +dz.toFixed(3), c: BALLC[Math.random() * BALLC.length | 0], t: now() };
  seenShots.add(key); spawnBall(data, true); popSound();
  set(ref(db, `rooms/${room}/shots/${key}`), data); setTimeout(() => remove(ref(db, `rooms/${room}/shots/${key}`)), 5000);
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
  me.x += dx * sp * dt; me.z += dz * sp * dt; if (!(state.phase === 'seek' && iAmSeeker())) me.ry = Math.atan2(dx, dz);
  collide(.4);
  me.x = Math.max(-HALF, Math.min(HALF, me.x)); me.z = Math.max(-HALF, Math.min(HALF, me.z));
  return true;
}
const roomAt = (x, z) => { for (const r of rooms) if (x > r.x1 && x < r.x2 && z > r.z1 && z < r.z2) return r; return null; };
const hbAt = (x, z) => { for (const h of hbs) if (x > h.x1 && x < h.x2 && z > h.z1 && z < h.z2) return h; return null; };
const wallBlocked = (x, z) => { for (const b of boxes) if (b.wall && x > b.x1 - .3 && x < b.x2 + .3 && z > b.z1 - .3 && z < b.z2 + .3) return true; return false; };
function camPlace(dt) {
  const shoot = state.phase === 'seek' && iAmSeeker(), sy = Math.sin(camYaw), cy = Math.cos(camYaw);
  let vx, vy, vz, lx, ly, lz;
  if (shoot) { // কাঁধের উপর দিয়ে নিশানা
    const ap = aimPitch(), cp = Math.cos(ap);
    vx = sy * 3.2 + cy * .6; vy = .5 - Math.sin(ap) * 1.2; vz = cy * 3.2 - sy * .6;
    lx = me.x - sy * cp * 30; ly = 1.4 + Math.sin(ap) * 30; lz = me.z - cy * cp * 30;
  } else {
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    vx = sy * cp * 7.5; vy = sp * 7.5; vz = cy * cp * 7.5; lx = me.x; ly = 1.3; lz = me.z;
  }
  const rm = roomAt(me.x, me.z), mh = hbAt(me.x, me.z);
  // ঘরের ভেতরে থাকলে ক্যামেরা কখনো ঘরের বাইরে যাবে না
  const free = (x, y, z) => rm
    ? (x > rm.x1 + .35 && x < rm.x2 - .35 && z > rm.z1 + .35 && z < rm.z2 - .35 && y < 2.6)
    : !(y < 2.9 && wallBlocked(x, z)) && !hbs.some(h => h !== mh && x > h.x1 && x < h.x2 && z > h.z1 && z < h.z2 && y < 4.8);
  const len = Math.hypot(vx, vy, vz); let f = 1;
  for (let i = 1; i <= 16; i++) { const q = i / 16; if (!free(me.x + vx * q, 1.4 + vy * q, me.z + vz * q)) { f = Math.max(.9 / len, (i - 1) / 16 - .04); break; } }
  camF = f < camF ? f : camF + (f - camF) * Math.min(1, 3 * dt);
  let qx = me.x + vx * camF, qy = 1.4 + vy * camF, qz = me.z + vz * camF;
  if (rm) { qx = Math.max(rm.x1 + .2, Math.min(rm.x2 - .2, qx)); qz = Math.max(rm.z1 + .2, Math.min(rm.z2 - .2, qz)); qy = Math.min(qy, 2.5); }
  cam.position.set(qx, qy, qz);
  cam.lookAt(lx, ly, lz);
}

/* ---------- শব্দ, গান, সংকেত ---------- */
let AC, music = localStorage.music !== 'off', mTimer = null, mStep = 0, mNext = 0, mOut = null, nb = null, proxT = 0;
function audio() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); return AC; }
addEventListener('pointerdown', () => { try { audio(); startMusic(); } catch (e) {} });
function beep(pan, gain, f0 = 440, type = 'sine', dur = .34) {
  try {
    const a = audio(), o = a.createOscillator(), g = a.createGain(), T = a.currentTime;
    o.type = type; o.frequency.setValueAtTime(f0, T); o.frequency.exponentialRampToValueAtTime(f0 * .52, T + dur * .85);
    g.gain.setValueAtTime(Math.max(.02, gain), T); g.gain.exponentialRampToValueAtTime(.001, T + dur); o.connect(g);
    if (a.createStereoPanner) { const p = a.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(a.destination); } else g.connect(a.destination);
    o.start(T); o.stop(T + dur + .03);
  } catch (e) {}
}
const popSound = () => beep(0, .25, 700, 'triangle', .1);
const proxBeep = d => beep(0, .16, 1100 - d * 40, 'square', .07);
let jit = 0;
const relAngle = ta => Math.atan2(-Math.sin(camYaw), -Math.cos(camYaw)) - ta;
const HINT_MIN = 15; // এর চেয়ে কাছে গেলে দূরত্ব/তীর আর দেখাবে না
function playSignal() { // খোঁজকের জন্য ইঙ্গিত: কোন দিকে, কত দূরে
  const e = $('sig'); e.hidden = false; clearTimeout(e._t); e._t = setTimeout(() => e.hidden = true, 1300);
  if (!iAmSeeker()) { if (hiders().includes(uid) && !caught[uid]) beep(0, .2); return; }
  let best = null, bd = 1e9;
  for (const u of hiders()) { const p = pos[u]; if (caught[u] || !p) continue; const d = Math.hypot(p.x - me.x, p.z - me.z); if (d < bd) { bd = d; best = p; } }
  if (!best) return;
  jit = (Math.random() - .5) * .7; const ta = Math.atan2(best.x - me.x, best.z - me.z) + jit;
  const n = bd < 10 ? 4 : bd < 20 ? 3 : bd < 35 ? 2 : 1, f0 = 300 + Math.max(0, 40 - bd) * 8;
  for (let i = 0; i < n; i++) setTimeout(() => beep(Math.max(-1, Math.min(1, Math.sin(relAngle(ta)))), .5, f0), i * 190);
}
function hintUpdate() { // খোঁজক সবসময় সবচেয়ে কাছের লুকানোর দূরত্ব দেখে, ১৫ মিটারের মধ্যে গেলে আর দেখে না
  const h = $('hint');
  if (!room || state.phase !== 'seek' || !iAmSeeker()) { if (!h.hidden) h.hidden = true; return; }
  let best = null, bd = 1e9;
  for (const u of hiders()) { const p = pos[u]; if (caught[u] || !p) continue; const d = Math.hypot(p.x - me.x, p.z - me.z); if (d < bd) { bd = d; best = p; } }
  if (!best || bd < HINT_MIN) { if (!h.hidden) h.hidden = true; return; }
  h.hidden = false;
  $('hd').textContent = `প্রায় ${bn(Math.round(bd))} মিটার`;
  $('arr').style.transform = `rotate(${relAngle(Math.atan2(best.x - me.x, best.z - me.z) + jit)}rad)`;
}
function proxCheck(t) { // কাছে কেউ থাকলে ফায়ার বাটন লাল হয়ে বিপ বিপ করে
  const b = $('catch');
  if (state.phase !== 'seek' || !iAmSeeker()) { b.classList.remove('hot'); return; }
  let md = 1e9;
  for (const u of hiders()) { const p = pos[u]; if (caught[u] || !p) continue; const d = Math.hypot(p.x - me.x, p.z - me.z); if (d < md) md = d; }
  const near = md < 7; b.classList.toggle('hot', near);
  if (near && t > proxT) { proxBeep(md); proxT = t + 260 + md * 110; }
}
/* ব্যাকগ্রাউন্ড গান (কোড দিয়ে বানানো, কোনো ফাইল লাগে না) */
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
function mTone(type, m, t, dur, vol) { const o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.value = mtof(m); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0008, t + dur); o.connect(g); g.connect(mOut); o.start(t); o.stop(t + dur + .03); }
function mKick(t) { const o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(40, t + .15); g.gain.setValueAtTime(.5, t); g.gain.exponentialRampToValueAtTime(.001, t + .2); o.connect(g); g.connect(mOut); o.start(t); o.stop(t + .22); }
function mHat(t, v) {
  if (!nb) { const len = Math.floor(AC.sampleRate * .04); nb = AC.createBuffer(1, len, AC.sampleRate); const d = nb.getChannelData(0); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len); }
  const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain(); s.buffer = nb; f.type = 'highpass'; f.frequency.value = 6000; g.gain.value = v; s.connect(f); f.connect(g); g.connect(mOut); s.start(t);
}
const PENT = [0, 2, 4, 7, 9, 12], MINP = [0, 3, 5, 7, 10, 12], PAT = [0, 2, 4, 2, 5, 4, 2, 1];
function mStepPlay(i, t) {
  const minor = state.phase === 'seek', bar = (i >> 3) & 3, st = i & 7, r = (minor ? [-3, -7, 0, -5] : [0, -3, -7, -5])[bar], sc = minor ? MINP : PENT;
  if (st === 0) for (const o of minor ? [0, 3, 7] : [0, 4, 7]) mTone('triangle', 60 + r + o, t, 1.5, .035);
  if (st === 0 || st === 4) { mTone('sine', 48 + r, t, .45, .22); mKick(t); }
  if (!(st === 3 && bar % 2)) mTone('triangle', 64 + r + sc[(PAT[st] + bar) % 6], t, .2, .08);
  mHat(t, st % 2 ? .05 : .02);
}
function mSched() { const sp = 60 / (state.phase === 'seek' ? 126 : 108) / 2; while (mNext < AC.currentTime + .35) { mStepPlay(mStep, mNext); mNext += sp; mStep++; } }
function startMusic() { if (!music || mTimer) return; const a = audio(); if (!mOut) { mOut = a.createGain(); mOut.gain.value = .35; mOut.connect(a.destination); } mNext = a.currentTime + .1; mTimer = setInterval(mSched, 120); }
function stopMusic() { clearInterval(mTimer); mTimer = null; }
$('mus').textContent = music ? '🎵' : '🔇';
$('mus').onclick = () => { music = !music; localStorage.music = music ? 'on' : 'off'; $('mus').textContent = music ? '🎵' : '🔇'; music ? startMusic() : stopMusic(); };

/* ---------- রেন্ডার লুপ ---------- */
function resize() { renderer.setSize(innerWidth, innerHeight, false); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const t = performance.now(), dt = Math.max(.001, Math.min(.05, (t - last) / 1000)); last = t;
  if (room && state.phase === 'seek' && iAmSeeker()) { const ny = Math.atan2(-Math.sin(camYaw), -Math.cos(camYaw)); if (Math.abs(Math.atan2(Math.sin(ny - me.ry), Math.cos(ny - me.ry))) > .05) { me.ry = ny; dirty = true; } }
  if (step(dt)) dirty = true;
  if (dirty && t - lastSend >= 100) sendPos(true);
  updateAvatars(dt); updateBalls(dt); updateParts(dt); proxCheck(t); hintUpdate(); shadowFollow();
  { const T = t / 1000; // পানির ঢেউ, মেঘের ভেসে যাওয়া
    water.m.emissiveIntensity = .3 + Math.sin(T * 1.7) * .12;
    ripples.forEach((r, i) => { const k = ((T * .22 + i / 3) % 1); r.scale.set(PR * (.25 + k * .75), 1, PR * (.25 + k * .75)); r.material.opacity = .45 * (1 - k); });
    clouds.forEach(c => { c.position.x += c.userData.sp * dt; if (c.position.x > 130) c.position.x = -130; }); }
  if (room) {
    camPlace(dt);
    if (state.phase === 'seek' && state.seekStart) { const k = Math.floor((now() - state.seekStart) / SIG_MS); if (k > lastSig) { lastSig = k; playSignal(); } }
  } else { const a = t / 7000; cam.position.set(Math.cos(a) * 36, 16, Math.sin(a) * 36); cam.lookAt(0, 2, 0); }
  renderer.render(scene, cam);
});
