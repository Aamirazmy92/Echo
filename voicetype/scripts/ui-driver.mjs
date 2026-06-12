// Throwaway UI driver for reviewing the Echo app. Polls cmds.txt for commands,
// appends results to driver-log.txt, screenshots to shots/.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const WORK = path.join(APP_DIR, '.ui-driver');
const SHOTS = path.join(WORK, 'shots');
const CMD_FILE = path.join(WORK, 'cmds.txt');
const LOG_FILE = path.join(WORK, 'driver-log.txt');
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(CMD_FILE, '');
fs.writeFileSync(LOG_FILE, '');

const log = (...a) => fs.appendFileSync(LOG_FILE, a.join(' ') + '\n');

let app = null;
let page = null;

const COMMANDS = {
  async launch() {
    if (app) return log('already launched');
    app = await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe'),
      args: [APP_DIR],
      timeout: 60_000,
    });
    await new Promise(r => setTimeout(r, 10_000));
    page = app.windows().find(w => !w.url().startsWith('devtools://')) ?? await app.firstWindow();
    log('launched.', app.windows().length, 'windows:');
    for (const w of app.windows()) log(' ', w.url());
  },
  async windows() {
    if (!app) return log('ERROR: launch first');
    for (const w of app.windows()) log(' ', w.url());
  },
  async use(idx) {
    if (!app) return log('ERROR: launch first');
    page = app.windows()[Number(idx)];
    log('using window', idx, page?.url());
  },
  async show() {
    // force-show the main window in case it launched hidden/tray-only
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) { w.show(); w.focus(); }
    });
    log('shown all windows');
  },
  async resize(arg) {
    const [w, h] = (arg || '1280 800').split(/\s+/).map(Number);
    await app.evaluate(({ BrowserWindow }, { w, h }) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      win.setSize(w, h);
    }, { w, h });
    log('resized to', w, h);
  },
  async ss(name) {
    if (!page) return log('ERROR: launch first');
    const f = path.join(SHOTS, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    log('screenshot:', f);
  },
  async cap(arg) {
    // native Electron capturePage — works when Playwright's screenshot hangs
    const [idxStr, name] = (arg || '0 cap').split(/\s+/);
    const f = path.join(SHOTS, (name || `cap-${Date.now()}`) + '.png');
    const dataUrl = await app.evaluate(async ({ BrowserWindow }, { idx }) => {
      const win = BrowserWindow.getAllWindows()[idx];
      if (!win) throw new Error('no window ' + idx);
      const img = await win.webContents.capturePage();
      return img.toDataURL();
    }, { idx: Number(idxStr) });
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    log('captured:', f);
  },
  async winlist() {
    const info = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w, i) => ({ i, title: w.getTitle(), url: w.webContents.getURL(), visible: w.isVisible(), bounds: w.getBounds() })));
    log(JSON.stringify(info, null, 1));
  },
  async click(sel) {
    const r = await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK';
    }, sel);
    log('click', sel, '->', r);
  },
  async 'click-text'(text) {
    const r = await page.evaluate(t => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')];
      const el = els.find(e => e.textContent?.trim() === t) ?? els.find(e => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click(); return 'OK: ' + el.tagName + ' ' + (el.textContent || '').trim().slice(0, 40);
    }, text);
    log('click-text', JSON.stringify(text), '->', r);
  },
  async text(sel) {
    const t = await page.evaluate(
      s => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)',
      sel || null);
    log(t);
  },
  async eval(expr) {
    try { log(JSON.stringify(await page.evaluate(expr))); }
    catch (e) { log('ERROR:', e.message); }
  },
  async sleep(ms) { await new Promise(r => setTimeout(r, Number(ms) || 1000)); log('slept', ms); },
  async type(text) {
    await page.keyboard.type(text, { delay: 15 });
    log('typed:', text);
  },
  async press(key) {
    await page.keyboard.press(key);
    log('pressed:', key);
  },
  async pwclick(sel) {
    await page.click(sel, { timeout: 5000 });
    log('pwclick', sel, '-> OK');
  },
  async fill(arg) {
    const idx = arg.indexOf(' ');
    const sel = arg.slice(0, idx);
    const value = arg.slice(idx + 1);
    await page.fill(sel, value, { timeout: 5000 });
    log('fill', sel, '=', value);
  },
  async html(sel) {
    const h = await page.evaluate(
      s => document.querySelector(s)?.innerHTML ?? '(NOT_FOUND)',
      sel || '.sticky-editor-body');
    log('HTML:', h);
  },
  async mouse(arg) {
    const [x, y] = arg.split(/\s+/).map(Number);
    await page.mouse.click(x, y);
    log('mouse click at', x, y);
  },
  async rect(sel) {
    const r = await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }, sel);
    log('rect', sel, JSON.stringify(r));
  },
  async quit() { if (app) await app.close().catch(() => {}); app = null; page = null; log('quit'); },
};

log('driver ready');
let offset = 0;
const tick = async () => {
  let buf;
  try { buf = fs.readFileSync(CMD_FILE, 'utf8'); } catch { buf = ''; }
  if (buf.length > offset) {
    const lines = buf.slice(offset).split('\n').filter(l => l.trim());
    offset = buf.length;
    for (const line of lines) {
      const [cmd, ...rest] = line.trim().split(/\s+/);
      const fn = COMMANDS[cmd];
      if (!fn) { log('unknown:', cmd); continue; }
      try { await fn(rest.join(' ')); } catch (e) { log('ERROR:', e.message); }
      log('--done--', cmd);
      if (cmd === 'quit') process.exit(0);
    }
  }
  setTimeout(tick, 300);
};
tick();
