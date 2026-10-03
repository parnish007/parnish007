#!/usr/bin/env node
// Builds the profile GIFs from profile.html: renders every frame with render.mjs (headless Chrome, frame by frame),
// then encodes each GIF with one shared palette. Needs Node 22+, Chrome or Edge, and ffmpeg.
// Usage: node build.mjs [scene ...]        (default: all scenes; output in ../)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..");
const scenes = process.argv.slice(2).length ? process.argv.slice(2) : ["hero", "about", "toap", "contextforge", "footer"];
for (const scene of scenes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gif-${scene}-`));
  const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), `profile.html?scene=${scene}`, "--fps", "20",
    "--keep-frames", tmp, "--out", path.join(tmp, "preview.mp4"), "--crf", "28"], { cwd: HERE, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status);
  const gif = path.join(OUT, `${scene}.gif`);
  // stats_mode=full + ordered (bayer) dithering: still paper stays identical between frames, so only moving parts
  // are stored, and colours do not shimmer from frame to frame.
  const e = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "20", "-i", path.join(tmp, "frame_%05d.png"),
    "-vf", "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop", "0", gif], { stdio: "inherit" });
  if (e.status !== 0) process.exit(e.status);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${scene}.gif  ${(fs.statSync(gif).size / 1e6).toFixed(2)} MB`);
}
