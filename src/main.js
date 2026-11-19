import * as THREE from 'three';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, onValue, set, update, remove, onDisconnect, get } from 'firebase/database';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const bn = n => String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const MAX = 18, HIDE_MS = 30000, SEEK_MS = 180000, TOSS_MS = 12000, COIN_MS = 5500, END_MS = 8000, HALF = 52;
const CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------- Firebase ---------- */
const db = getDatabase(initializeApp(firebaseConfig));
const uid = localStorage.uid || (localStorage.uid = Math.random().toString(36).slice(2, 10));
let myName = localStorage.name || '';
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), s => offset = s.val() || 0);
const now = () => Date.now() + offset;

let room = null, players = {}, state = { phase: 'lobby' }, choices = {}, caught = {}, pos = {}, online = {}, unsubs = [];
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
    onValue(ref(db, b + 'pos'), s => { pos = s.val() || {}; })
  ];
}
function leaveRoom() {
  unsubs.forEach(f => f()); unsubs = [];
  if (room) {
    remove(ref(db, `rooms/${room}/players/${uid}`)); remove(ref(db, `rooms/${room}/pos/${uid}`)); remove(ref(db, `rooms/${room}/choices/${uid}`));
    update(ref(db, 'online/' + uid), { room: '' });
  }
  room = null; players = {}; pos = {}; choices = {}; caught = {}; state = { phase: 'lobby' };
  syncAvatars();
  ['hud', 'joy', 'lobby', 'toss', 'coinov', 'blind', 'end', 'catch'].forEach(i => $(i).hidden = true);
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
  const toHide = (seeker, msg) => put({ phase: 'hide', seeker, parts: (s.parts || []).filter(u => players[u]), deadline: t + HIDE_MS, msg: msg || '' }, { choices: null, caught: null });
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
  if (p === 'hide') { if (!players[s.seeker]) return end('hiders'); if (t >= s.deadline) return put({ ...s, phase: 'seek', deadline: t + SEEK_MS }); }
  if (p === 'seek') {
    if (!players[s.seeker]) return end('hiders');
    const hs = (s.parts || []).filter(u => players[u] && u !== s.seeker);
    if (hs.every(u => caught[u])) return end('seeker');
    if (t >= s.deadline) return end('hiders');
  }
  if (p === 'end' && t >= s.deadline) return put({ phase: 'lobby' }, { choices: null, caught: null });
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
  else if (p === 'hide') { t = iAmSeeker() ? 'চোখ বন্ধ' : 'লুকান!'; s = bn(left) + ' সেকেন্ড'; $('blind').innerHTML = `<div>চোখ বন্ধ!<br>${bn(left)}</div>`; }
  else if (p === 'seek') { t = iAmSeeker() ? 'সবাইকে খুঁজুন' : 'লুকিয়ে থাকুন'; s = `${bn(left)} সেকেন্ড • বাকি ${bn(hiders().filter(u => !caught[u]).length)} জন`; if (caught[uid]) s += ' • আপনি ধরা পড়েছেন'; }
  else if (p === 'end') t = 'খেলা শেষ';
  $('ph').textContent = t; $('sub').textContent = s;
}
setInterval(updateHud, 200);

/* ---------- 3D world ---------- */
const cv = $('c');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3e6); scene.fog = new THREE.Fog(0x9fd3e6, 35, 105);
const cam = new THREE.PerspectiveCamera(60, 1, .1, 200);
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b8f4e, 1.15));
const sun = new THREE.DirectionalLight(0xfff1cc, .9); sun.position.set(30, 50, 20); scene.add(sun);
const M = c => new THREE.MeshLambertMaterial({ color: c });
function addMesh(geo, col, x, y, z) { const m = new THREE.Mesh(geo, M(col)); m.position.set(x, y, z); scene.add(m); return m; }
const flat = (geo, col, x, y, z) => { const m = addMesh(geo, col, x, y, z); m.rotation.x = -Math.PI / 2; return m; };

flat(new THREE.PlaneGeometry(170, 170), 0x6aa84f, 0, 0, 0);
flat(new THREE.PlaneGeometry(120, 5), 0xc9a46a, 0, .02, 0);
flat(new THREE.PlaneGeometry(5, 120), 0xc9a46a, 0, .02, 0);
flat(new THREE.CircleGeometry(9, 32), 0x4aa3d8, 26, .03, -22);

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = rng(20261119), cols = [{ x: 26, z: -22, r: 10 }];
function spot(rad, gap) {
  for (let i = 0; i < 80; i++) {
    const x = (R() * 2 - 1) * 50, z = (R() * 2 - 1) * 50;
    if (Math.hypot(x, z) < 14 || Math.abs(x) < 4 || Math.abs(z) < 4) continue;
    if (cols.every(c => Math.hypot(x - c.x, z - c.z) > c.r + rad + gap)) return { x, z };
  }
  return null;
}
const wallCols = [0xd9b38c, 0xc9a27a, 0xe6d5b8, 0x9ec1a3];
for (let i = 0; i < 14; i++) {
  const p = spot(4.5, 1.5); if (!p) continue;
  const w = 5 + R() * 3, d = 4 + R() * 3;
  addMesh(new THREE.BoxGeometry(w, 2.6, d), wallCols[i % 4], p.x, 1.3, p.z);
  const roof = addMesh(new THREE.ConeGeometry(Math.max(w, d) * .75, 1.9, 4), 0x8b5a2b, p.x, 3.55, p.z); roof.rotation.y = Math.PI / 4;
  addMesh(new THREE.BoxGeometry(1, 1.8, .1), 0x4a2f17, p.x, .9, p.z + d / 2 + .05);
  cols.push({ x: p.x, z: p.z, r: Math.max(w, d) / 2 + .3 });
}
const trunk = new THREE.CylinderGeometry(.3, .4, 3, 6), crown = new THREE.SphereGeometry(2, 8, 6);
function tree(x, z) { addMesh(trunk, 0x6b4423, x, 1.5, z); addMesh(crown, 0x2f7a35, x, 4, z); }
for (let i = 0; i < 36; i++) { const p = spot(.8, 1); if (p) { tree(p.x, p.z); cols.push({ x: p.x, z: p.z, r: .6 }); } }
for (let i = -56; i <= 56; i += 8) { tree(i, 58); tree(i, -58); tree(58, i); tree(-58, i); }
const hay = new THREE.ConeGeometry(1.6, 2.6, 8);
for (let i = 0; i < 8; i++) { const p = spot(1.6, 1); if (p) { addMesh(hay, 0xe0c060, p.x, 1.3, p.z); cols.push({ x: p.x, z: p.z, r: 1.5 }); } }
const bush = new THREE.SphereGeometry(1.5, 8, 6);
for (let i = 0; i < 34; i++) { const p = spot(1.5, .3); if (p) { const b = addMesh(bush, 0x3f7d3a, p.x, .9, p.z); b.scale.y = .85; } }

/* ---------- Avatars ---------- */
const av = {};
const hue = u => { let h = 0; for (const c of u) h = (h * 31 + c.charCodeAt(0)) % 360; return new THREE.Color().setHSL(h / 360, .55, .5); };
function label(txt) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d'); x.font = 'bold 30px "Hind Siliguri","Noto Sans Bengali",sans-serif'; x.textAlign = 'center';
  x.fillStyle = '#000a'; x.fillRect(0, 8, 256, 48); x.fillStyle = '#fff'; x.fillText(txt, 128, 43);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(2.6, .65, 1); s.position.y = 2.45; return s;
}
function makeAvatar(u) {
  const g = new THREE.Group(), col = hue(u);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(.35, .8, 4, 8), new THREE.MeshLambertMaterial({ color: col })); body.position.y = .8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(.28, 12, 10), M(0xf1c9a0)); head.position.y = 1.7;
  const lb = label(players[u]?.name || '?');
  g.add(body, head, lb); g.userData = { body, col, lb }; scene.add(g); return g;
}
function syncAvatars() {
  for (const u of Object.keys(players)) if (!av[u]) av[u] = makeAvatar(u);
  for (const u of Object.keys(av)) if (!players[u]) { scene.remove(av[u]); delete av[u]; }
}

/* ---------- Player control ---------- */
const me = { x: 0, z: 6, ry: 0 };
let camYaw = 0, lastSend = 0, dirty = false;
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
addEventListener('keydown', e => { if (document.activeElement.tagName === 'INPUT') return; keys[e.code] = 1; if (e.code === 'KeyE' || e.code === 'Space') doCatch(); });
addEventListener('keyup', e => keys[e.code] = 0);
let jx = 0, jz = 0, jid = null; const joy = $('joy'), knob = $('knob');
function jm(e) { const r = joy.getBoundingClientRect(), Rr = r.width / 2; let dx = e.clientX - r.left - Rr, dy = e.clientY - r.top - Rr; const d = Math.hypot(dx, dy); if (d > Rr) { dx *= Rr / d; dy *= Rr / d; } jx = dx / Rr; jz = dy / Rr; knob.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`; }
joy.addEventListener('pointerdown', e => { jid = e.pointerId; joy.setPointerCapture(jid); jm(e); });
joy.addEventListener('pointermove', e => { if (e.pointerId === jid) jm(e); });
const jend = e => { if (e.pointerId === jid) { jid = null; jx = jz = 0; knob.style.transform = 'translate(-50%,-50%)'; } };
joy.addEventListener('pointerup', jend); joy.addEventListener('pointercancel', jend);
let drag = null;
cv.addEventListener('pointerdown', e => { drag = { id: e.pointerId, x: e.clientX }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', e => { if (drag && drag.id === e.pointerId) { camYaw -= (e.clientX - drag.x) * .006; drag.x = e.clientX; } });
cv.addEventListener('pointerup', () => drag = null);
$('catch').onclick = doCatch;
function doCatch() {
  if (!room || state.phase !== 'seek' || !iAmSeeker()) return;
  let n = 0;
  for (const u of hiders()) { const p = pos[u]; if (!caught[u] && p && Math.hypot(p.x - me.x, p.z - me.z) < 3) { set(ref(db, `rooms/${room}/caught/${u}`), true); n++; } }
  toast(n ? `${bn(n)} জনকে ধরেছেন!` : 'কাছে কেউ নেই');
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
  for (const k of cols) { const ex = me.x - k.x, ez = me.z - k.z, d = Math.hypot(ex, ez), m = k.r + .45; if (d < m && d > 0) { me.x = k.x + ex / d * m; me.z = k.z + ez / d * m; } }
  me.x = Math.max(-HALF, Math.min(HALF, me.x)); me.z = Math.max(-HALF, Math.min(HALF, me.z));
  return true;
}

/* ---------- Render loop ---------- */
function resize() { renderer.setSize(innerWidth, innerHeight, false); cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
let last = performance.now();
renderer.setAnimationLoop(() => {
  const t = performance.now(), dt = Math.min(.05, (t - last) / 1000); last = t;
  if (step(dt)) dirty = true;
  if (dirty && t - lastSend >= 100) sendPos(true);
  const p = state.phase;
  for (const u in av) {
    const g = av[u], q = u === uid ? { x: me.x, z: me.z, r: me.ry } : pos[u];
    if (!q) { g.visible = false; continue; }
    g.visible = true;
    if (u === uid || !g.userData.init) { g.position.set(q.x, 0, q.z); g.rotation.y = q.r; g.userData.init = 1; }
    else {
      const k = 1 - Math.exp(-12 * dt); g.position.x += (q.x - g.position.x) * k; g.position.z += (q.z - g.position.z) * k;
      const da = Math.atan2(Math.sin(q.r - g.rotation.y), Math.cos(q.r - g.rotation.y)); g.rotation.y += da * k;
    }
    const sk = p !== 'lobby' && u === state.seeker, ct = p !== 'lobby' && !!caught[u];
    g.userData.body.material.color.set(sk ? 0xd64545 : ct ? 0x888888 : g.userData.col);
    g.scale.y = ct ? .45 : 1;
    g.userData.lb.visible = u !== uid && (p === 'lobby' || sk);
  }
  if (room) {
    const D = 7.5, H = 4.6, tx = me.x + Math.sin(camYaw) * D, tz = me.z + Math.cos(camYaw) * D;
    cam.position.lerp(new THREE.Vector3(tx, H, tz), 1 - Math.exp(-10 * dt));
    cam.lookAt(me.x, 1.3, me.z);
    if (p === 'seek' && iAmSeeker()) $('catch').classList.toggle('ready', hiders().some(u => !caught[u] && pos[u] && Math.hypot(pos[u].x - me.x, pos[u].z - me.z) < 3));
  } else {
    const a = t / 7000; cam.position.set(Math.cos(a) * 42, 16, Math.sin(a) * 42); cam.lookAt(0, 2, 0);
  }
  renderer.render(scene, cam);
});
