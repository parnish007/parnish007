#!/usr/bin/env node
// render.mjs: deterministic HTML-to-video renderer. Zero npm dependencies.
// Needs: Node 22+ (built-in WebSocket and fetch), Chrome / Chromium / Edge, ffmpeg.
//
// The composition page must expose:
//   window.__video = { width, height, fps, duration, ready: Promise, seek(t): Promise|void, audio?(): Promise<base64 WAV> }
// Every visual must be a pure function of t (seconds). The renderer never plays the page in real time: for each
// frame it calls seek(t), waits one animation frame, and screenshots. Same input, same frames.
//
// Usage:
//   node render.mjs composition.html --out video.mp4                 full render (with audio when the page has it)
//   node render.mjs composition.html --stills 0,2.5,6,12 --out-dir shots   still frames + contact sheet, for review
//   node render.mjs composition.html --serve                         serve the folder for live preview in a browser
// Options:
//   --fps N            override the page's fps          --from S / --to S   render only part of the timeline
//   --scale F          output scale (0.5 = half size)   --crf N             x264 quality (default 16; lower = better)
//   --motion-blur N    N sub-frames per frame, averaged --shutter F         fraction of a frame the shutter is open (0.5)
//   --grain N          temporal grain (0-20) against banding in dark gradients
//   --lufs N           normalise audio loudness (e.g. -14 for web)   --no-audio   skip the soundtrack
//   --format png|jpeg  frame transfer format (png: lossless, default)
//   --chrome PATH      browser to use (or CHROME_PATH)   --ffmpeg PATH (or FFMPEG_PATH)
//   --gl swiftshader   software WebGL (for Three.js when the GPU is unavailable in headless mode)
//   --keep-frames DIR  also write every frame as PNG
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- arguments ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[k.slice(2)] = true;
      else { a[k.slice(2)] = next; i++; }
    } else a._.push(k);
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const num = (v, d) => (v === undefined || v === true ? d : Number(v));
if (!args._[0] || args.help) {
  const head = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  console.log(head.slice(0, head.findIndex((l) => !l.startsWith("//"))).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(args._[0] ? 0 : 1);
}
if (typeof WebSocket === "undefined") die("Node 22 or newer is required (built-in WebSocket).");

function die(msg) { console.error("render: " + msg); process.exit(1); }
const log = (...m) => console.log(...m);

// --- tools -------------------------------------------------------------------------------------------------

function which(name) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}
function findChrome() {
  const c = [args.chrome, process.env.CHROME_PATH];
  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      c.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    c.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) c.push(which(n));
  }
  return c.find((p) => p && p !== true && fs.existsSync(p));
}
const FFMPEG = (args.ffmpeg !== true && args.ffmpeg) || process.env.FFMPEG_PATH || which("ffmpeg");

// --- a tiny static server, so fonts, images and modules load exactly as they would on the web -------------------

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".otf": "font/otf", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
};
function serve(root) {
  root = path.resolve(root);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.resolve(root, "." + rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store" }).end(data);
    });
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// --- Chrome DevTools Protocol over the built-in WebSocket ---------------------------------------------------------

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.handlers = {};
    this.opened = new Promise((ok, fail) => {
      this.ws.onopen = ok;
      this.ws.onerror = () => fail(new Error("could not connect to the browser"));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { ok, fail } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) fail(new Error(m.error.message + (m.error.data ? ": " + m.error.data : "")));
        else ok(m.result);
      } else if (m.method) for (const h of this.handlers[m.method] || []) h(m.params);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
  }
  on(method, fn) { (this.handlers[method] ||= []).push(fn); }
}

function timeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`timed out after ${ms / 1000}s: ${what}`)), ms);
  })]).finally(() => clearTimeout(timer));
}
async function evaluate(cdp, expression, ms = 60000) {
  const r = await timeout(cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    ms, expression.slice(0, 80));
  if (r.exceptionDetails) {
    throw new Error("page error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function launch() {
  const chrome = findChrome();
  if (!chrome) die("no Chrome, Chromium or Edge found; pass --chrome PATH or set CHROME_PATH.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "render-chrome-"));
  const flags = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--force-color-profile=srgb",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--run-all-compositor-stages-before-draw", "--font-render-hinting=none"];
  if (args.gl === "swiftshader") flags.push("--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  const proc = spawn(chrome, [...flags, "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  let port;
  for (let i = 0; i < 150 && !port; i++) {
    if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) { proc.kill(); die("the browser did not start (no DevToolsActivePort after 15 s)."); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.opened;
  const close = async () => {
    try { await timeout(cdp.send("Browser.close"), 3000, "close"); } catch { proc.kill(); }
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
  };
  return { cdp, close, chrome };
}

// --- main ----------------------------------------------------------------------------------------------------

const isUrl = /^https?:\/\//.test(args._[0]);
// a local page may carry a query string (comp.html?scene=intro): one file, several compositions
const [input, query] = isUrl ? [args._[0], ""] : args._[0].split(/\?(.*)/s);
if (!isUrl && !fs.existsSync(input)) die(`not found: ${input}`);

let server = null, pageUrl = input;
if (!isUrl) {
  server = await serve(path.dirname(path.resolve(input)));
  pageUrl = `http://127.0.0.1:${server.address().port}/${encodeURIComponent(path.basename(input))}${query ? "?" + query : ""}`;
}
if (args.serve) {
  log(`Preview: ${pageUrl}\n(space: play/pause, arrows: step, shift+arrows: 1 s). Ctrl+C to stop.`);
  await new Promise(() => {});
}
if (!FFMPEG) die("ffmpeg not found; install it or pass --ffmpeg PATH.");

const { cdp, close } = await launch();
let exitCode = 0;
try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const seen = new Set();
  const report = (msg) => { if (!seen.has(msg)) { seen.add(msg); console.error("page: " + msg); } };
  cdp.on("Runtime.exceptionThrown", (p) => report(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "warning") report(p.args.map((x) => x.value ?? x.description).join(" "));
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((ok) => cdp.on("Page.loadEventFired", ok));
  await cdp.send("Page.navigate", { url: pageUrl + (pageUrl.includes("?") ? "&" : "?") + "render=1" });
  await timeout(loaded, 60000, "page load");
  for (let i = 0; i < 100; i++) {
    if (await evaluate(cdp, "typeof window.__video === 'object' && window.__video !== null")) break;
    if (i === 99) throw new Error("the page does not define window.__video (see the contract at the top of this file)");
    await new Promise((r) => setTimeout(r, 100));
  }
  const meta = await evaluate(cdp, `Promise.resolve(window.__video.ready).then(() => ({
      width: window.__video.width, height: window.__video.height, fps: window.__video.fps,
      duration: window.__video.duration, hasAudio: typeof window.__video.audio === "function" }))`, 120000);
  const W = Math.round(meta.width), H = Math.round(meta.height);
  const fps = num(args.fps, meta.fps || 30);
  const scale = num(args.scale, 1);
  if (!(W > 0 && H > 0 && meta.duration > 0)) throw new Error("window.__video needs width, height and duration");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const clip = { x: 0, y: 0, width: W, height: H, scale };
  const outW = Math.round(W * scale), outH = Math.round(H * scale);
  const format = args.format === "jpeg" ? "jpeg" : "png";

  const settle = args["no-raf"] ? "" : ".then(() => new Promise((r) => requestAnimationFrame(() => r(true))))";
  async function frameAt(t) {
    await evaluate(cdp, `Promise.resolve(window.__video.seek(${t}))${settle}`);
    const shot = await cdp.send("Page.captureScreenshot", {
      format, quality: format === "jpeg" ? 95 : undefined, clip, optimizeForSpeed: true, captureBeyondViewport: false });
    return Buffer.from(shot.data, "base64");
  }

  if (args.stills) {
    // --- review mode: still frames and a contact sheet ---
    const times = String(args.stills).split(",").map(Number).filter((t) => t >= 0 && t <= meta.duration);
    const dir = path.resolve(args["out-dir"] && args["out-dir"] !== true ? args["out-dir"] : "stills");
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, t] of times.entries()) {
      fs.writeFileSync(path.join(dir, `still_${String(i).padStart(3, "0")}.png`), await frameAt(t));
      log(`still ${i}: t=${t}s`);
    }
    if (times.length > 1) {
      const cols = Math.min(4, times.length), rows = Math.ceil(times.length / cols);
      const r = spawnSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", "1", "-i", path.join(dir, "still_%03d.png"),
        "-vf", `scale=640:-2,tile=${cols}x${rows}:padding=8:margin=8:color=0x202020`, "-frames:v", "1",
        path.join(dir, "sheet.png")], { encoding: "utf8" });
      if (r.status === 0) log(`contact sheet: ${path.join(dir, "sheet.png")} (left to right, top to bottom)`);
      else console.error(r.stderr);
    }
  } else {
    // --- full render ---
    const from = Math.max(0, num(args.from, 0)), to = Math.min(meta.duration, num(args.to, meta.duration));
    const frames = Math.round((to - from) * fps);
    const sub = Math.max(1, Math.round(num(args["motion-blur"], 1)));
    const shutter = Math.min(1, Math.max(0.05, num(args.shutter, 0.5)));
    const out = path.resolve(args.out && args.out !== true ? args.out : "video.mp4");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));

    let audioFile = null;
    if (meta.hasAudio && !args["no-audio"]) {
      log("rendering the soundtrack...");
      const b64 = await evaluate(cdp, "Promise.resolve(window.__video.audio())", 300000);
      if (b64) { audioFile = path.join(tmp, "audio.wav"); fs.writeFileSync(audioFile, Buffer.from(b64, "base64")); }
    }

    const vf = [];
    if (sub > 1) vf.push(`tmix=frames=${sub}`, `select=eq(mod(n\\,${sub})\\,${sub - 1})`, `setpts=N/(${fps}*TB)`);
    vf.push("scale=out_color_matrix=bt709:out_range=tv", "format=yuv420p");
    const grain = num(args.grain, 0);
    if (grain > 0) vf.push(`noise=alls=${grain}:allf=t`);
    const ff = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps * sub),
      "-c:v", format === "png" ? "png" : "mjpeg", "-i", "-"];
    if (audioFile) ff.push("-ss", String(from), "-t", String(to - from), "-i", audioFile);
    ff.push("-vf", vf.join(","), "-r", String(fps), "-c:v", "libx264", "-preset", "slow", "-crf", String(num(args.crf, 16)),
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-movflags", "+faststart");
    if (audioFile) {
      if (args.lufs !== undefined) ff.push("-af", `loudnorm=I=${num(args.lufs, -14)}:TP=-1.5:LRA=11`);
      ff.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-map", "0:v", "-map", "1:a");   // loudnorm resamples up
    }
    ff.push("-t", String(to - from), out);

    const enc = spawn(FFMPEG, ff, { stdio: ["pipe", "inherit", "pipe"] });
    let encErr = "";
    enc.stderr.on("data", (d) => { encErr = (encErr + d).slice(-8000); });
    const encDone = new Promise((ok) => enc.on("close", ok));
    let encClosed = false;
    enc.on("close", () => { encClosed = true; });
    const write = (buf) => new Promise((ok, fail) => {
      if (encClosed) return fail(new Error("ffmpeg stopped early:\n" + encErr));
      if (enc.stdin.write(buf)) ok(); else enc.stdin.once("drain", ok);
    });

    const keep = args["keep-frames"] && args["keep-frames"] !== true ? path.resolve(args["keep-frames"]) : null;
    if (keep) fs.mkdirSync(keep, { recursive: true });
    log(`rendering ${frames} frames at ${fps} fps, ${outW}x${outH}${sub > 1 ? `, motion blur ${sub}x` : ""}` +
      `${audioFile ? ", with audio" : ""} -> ${out}`);
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      const t = from + i / fps;
      for (let k = 0; k < sub; k++) {
        const buf = await frameAt(+(t + (sub > 1 ? (k / sub) * shutter / fps : 0)).toFixed(6));
        await write(buf);
        if (keep && k === sub - 1) fs.writeFileSync(path.join(keep, `frame_${String(i).padStart(5, "0")}.png`), buf);
      }
      if ((i + 1) % fps === 0 || i === frames - 1) {
        const rate = (i + 1) / ((Date.now() - started) / 1000);
        const eta = Math.round((frames - i - 1) / rate);
        process.stdout.write(`\r  frame ${i + 1}/${frames} (${((i + 1) / frames * 100).toFixed(1)}%) ` +
          `${rate.toFixed(1)} fps, ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, "0")}s left   `);
      }
    }
    enc.stdin.end();
    const code = await encDone;
    process.stdout.write("\n");
    fs.rmSync(tmp, { recursive: true, force: true });
    if (code !== 0) throw new Error("ffmpeg failed:\n" + encErr);
    log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${out}`);
    log(`next: node "${path.join(path.dirname(fileURLToPath(import.meta.url)), "check.mjs")}" "${out}" --sheet sheet.png`);
  }
} catch (e) {
  console.error("render: " + e.message);
  exitCode = 1;
} finally {
  await close();
  server?.close();
}
process.exit(exitCode);
