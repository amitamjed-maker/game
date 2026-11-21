// স্মোক টেস্ট: npm i --no-save @sparticuz/chromium puppeteer-core, তারপর vite (উপরের কনফিগ) চালু রেখে: node tools/smoke.mjs
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], headless: 'shell' });
const p = await b.newPage(); await p.setViewport({ width: 844, height: 390 });
const errs = []; p.on('pageerror', e => errs.push('PAGEERR ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
p.on('console', m => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED/.test(m.text())) errs.push('console.error: ' + m.text().slice(0, 300)); });
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'load' }); await sleep(4500);
const clk = id => p.evaluate(i => document.getElementById(i).click(), id);
const txt = id => p.evaluate(i => document.getElementById(i)?.innerText || '', id);
await p.type('#name', 'Belawal'); await clk('solo'); await sleep(2500);
// ---- মজার অ্যাকশন: প্রতিটা বাটন চেপে দেখা
await clk('funBtn'); await sleep(400);
const btns = await p.evaluate(() => [...document.querySelectorAll('#funBox button')].map((b, i) => i + ':' + b.innerText.replace(/\n/g, ' ')));
console.log('fun buttons:', btns.join(' | '));
const n = btns.length;
for (let i = 0; i < n; i++) {
  await p.evaluate(i => { const bx = document.getElementById('funBox'); if (bx.hidden) document.getElementById('funBtn').click(); const b = bx.querySelectorAll('button')[i]; b && !b.disabled && b.click(); }, i);
  await sleep(1500);
  if (i === 2) await p.screenshot({ path: 'shot_fun.png' });
}
console.log('after fun errs so far:', errs.length);
// ---- হোস্ট-অ্যাকশন: গরু/ঘোড়ায় ওঠা ইত্যাদি হয়ে গেছে; এবার শুধু লুকোচুরি
await p.evaluate(() => { const bx = document.getElementById('funBox'); if (!bx.hidden) document.getElementById('funBtn').click(); });
await clk('startH'); await sleep(1500);
await p.screenshot({ path: 'shot_toss.png' });
await clk('pickH');
let last = ''; const t0 = Date.now(), seen = {};
while (Date.now() - t0 < 110000) {
  const ph = await txt('ph'); if (ph !== last) { console.log(((Date.now() - t0) / 1000).toFixed(0) + 's ph=', ph); last = ph; }
  if (/লুকান|লুকা/.test(ph) && !seen.h) { seen.h = 1; await sleep(8000); await p.screenshot({ path: 'shot_hide.png' }); }
  if (/খোঁজ/.test(ph) && !seen.s) { seen.s = 1; await sleep(8000); await p.screenshot({ path: 'shot_seek.png' }); }
  await sleep(1000);
}
console.log(errs.slice(0, 12).join('\n') || 'NO ERRORS');
await b.close();
