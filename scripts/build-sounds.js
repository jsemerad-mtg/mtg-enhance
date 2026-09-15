// Transcode, normalize and catalogue the sound effects.
//
//   node scripts/build-sounds.js          (or: npm run build:sounds)
//
// In:  sounds-src/<sound id>.<wav|aiff|flac|mp3|m4a>
// Out: public/sounds/<sound id>.m4a  +  public/sounds/manifest.json
//
// Why this is a script and not an admin backend
// ---------------------------------------------
// There is one sound designer. A CMS for one person editing ~81 files is more
// code than the thing it manages, and it would need auth, storage, an audit
// trail and a way to undo a bad upload. A script does the same job
// deterministically, lives in git, and can be re-run from scratch. When
// *players* upload their own sounds — which is roadmapped — that needs storage,
// quotas and moderation anyway, and none of this gets in the way of building it
// then.
//
// Why LUFS and not peak
// ---------------------
// Peak normalization makes every file touch the same ceiling, which is not the
// same as every file sounding equally loud: a sparse sound with one transient
// peaks just as high as a dense one and still sounds half the volume. Integrated
// loudness measures what people actually perceive. Normalizing to peak is the
// usual reason a soundboard has one effect everyone flinches at and another
// nobody can hear.
//
// Why two passes
// --------------
// ffmpeg's loudnorm in single-pass mode corrects from a running estimate, which
// drifts badly on files this short — a one-second sound barely gives it time to
// settle. The first pass measures the whole file, the second applies an exact
// correction. The output is then measured AGAIN so the manifest reports what was
// actually achieved rather than what was requested.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOUND_GROUPS } from "../src/sound-catalog.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(here, "../sounds-src");
const OUT_DIR = path.join(here, "../public/sounds");
const CLIENT_JS = path.join(here, "../public/client.js");

// Short table sounds, played on phone speakers in a noisy room. -16 LUFS is
// loud enough to cut through without the clipping that chasing -14 invites on
// percussive material. -1 dBTP leaves room for the encoder: AAC is lossy, and a
// waveform that peaks at 0 before encoding can exceed it afterwards.
const TARGET_LUFS = -16;
const TARGET_TP = -1;
const TARGET_LRA = 11;
const BITRATE = "112k";

// Anything further than this from target gets flagged in the manifest. Not an
// error — some sounds legitimately sit apart — but it should be a decision
// rather than an accident.
const TOLERANCE_LU = 1;

const AUDIO_EXT = new Set([".wav", ".aiff", ".aif", ".flac", ".mp3", ".m4a", ".ogg"]);

async function ensureFfmpeg() {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
  } catch {
    console.error(
      "\nffmpeg and ffprobe are needed and weren't found on PATH.\n" +
      "  macOS:  brew install ffmpeg\n" +
      "Nothing was written.\n"
    );
    process.exit(1);
  }
}

// Labels live in client.js's SOUND_LIBRARY, which is the UI's business. Parsing
// them here rather than duplicating them keeps one source of truth — the same
// reason tests/sound-auth.test.mjs reads that file instead of importing a copy.
function readLabels() {
  const src = fs.readFileSync(CLIENT_JS, "utf8");
  const start = src.indexOf("const SOUND_LIBRARY = {");
  const end = src.indexOf("\n};", start);
  const labels = {};
  if (start === -1 || end === -1) return labels;
  for (const [, id, label] of src.slice(start, end).matchAll(/\["([a-z_]+)",\s*"([^"]+)"\]/g)) {
    labels[id] = label;
  }
  return labels;
}

// loudnorm's print_format=json writes the measurement to stderr, after
// everything else ffmpeg has to say. Take the last JSON object in the stream.
function parseLoudnorm(stderr) {
  const matches = [...stderr.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][0]);
      if (parsed.input_i !== undefined) return parsed;
    } catch { /* not the one */ }
  }
  return null;
}

async function measure(file) {
  const filter = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`;
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", filter, "-f", "null", "-"])
    .catch((e) => ({ stderr: e.stderr || "" }));
  return parseLoudnorm(stderr);
}

async function durationOf(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  return Math.round(parseFloat(stdout) * 1000) / 1000;
}

async function build() {
  await ensureFfmpeg();

  if (!fs.existsSync(SRC_DIR)) {
    fs.mkdirSync(SRC_DIR, { recursive: true });
    console.log(`Created ${path.relative(process.cwd(), SRC_DIR)} — drop source audio in there.`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const labels = readLabels();
  const files = fs.readdirSync(SRC_DIR).filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()));

  // A file whose name isn't a known sound id fails the build rather than being
  // quietly transcoded into a file nothing will ever play.
  const unknown = files.filter((f) => !SOUND_GROUPS[path.basename(f, path.extname(f))]);
  if (unknown.length) {
    console.error("\nThese filenames don't match any sound id in src/sound-catalog.js:\n");
    for (const f of unknown) console.error(`  ${f}`);
    console.error("\nRename them, or add the id to the catalog. Nothing was written.\n");
    process.exit(1);
  }

  const sounds = [];
  for (const file of files.sort()) {
    const id = path.basename(file, path.extname(file));
    const src = path.join(SRC_DIR, file);
    const out = path.join(OUT_DIR, `${id}.m4a`);

    // Skip work already done. Cheap to check, and the whole set takes a while
    // once there are eighty of them.
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
      const existing = await measure(out);
      sounds.push(await describe(id, out, existing, labels, true));
      process.stdout.write(`  = ${id}\n`);
      continue;
    }

    const pass1 = await measure(src);
    if (!pass1) {
      console.error(`\nCouldn't measure ${file}. Is it really audio?\n`);
      process.exit(1);
    }

    // linear=true applies one constant gain rather than dynamic compression —
    // it preserves the shape of the sound. ffmpeg falls back to dynamic on its
    // own if the required correction is out of range.
    const filter = [
      `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`,
      `measured_I=${pass1.input_i}`,
      `measured_TP=${pass1.input_tp}`,
      `measured_LRA=${pass1.input_lra}`,
      `measured_thresh=${pass1.input_thresh}`,
      `offset=${pass1.target_offset}`,
      "linear=true",
      "print_format=summary",
    ].join(":");

    await run("ffmpeg", [
      "-hide_banner", "-y", "-i", src,
      "-af", filter,
      "-ar", "44100",
      // Mono on purpose: these are table sounds, not music. Halves the bytes
      // and there is no stereo image worth keeping in a board wipe.
      "-ac", "1",
      "-c:a", "aac", "-b:a", BITRATE,
      "-movflags", "+faststart",
      out,
    ]);

    // Measure the OUTPUT. What the manifest reports is what was achieved, not
    // what was asked for — encoding happens after normalization and can move
    // the true peak.
    const after = await measure(out);
    sounds.push(await describe(id, out, after, labels, false));
    process.stdout.write(`  + ${id}\n`);
  }

  const have = new Set(sounds.map((s) => s.id));
  const missing = Object.keys(SOUND_GROUPS)
    .filter((id) => !have.has(id))
    .map((id) => ({ id, group: SOUND_GROUPS[id], label: labels[id] || null }));

  const manifest = {
    generated: new Date().toISOString(),
    target: { lufs: TARGET_LUFS, truePeak: TARGET_TP, toleranceLu: TOLERANCE_LU },
    sounds,
    missing,
  };
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const off = sounds.filter((s) => s.offTarget);
  console.log(`\n${sounds.length} built, ${missing.length} still to author.`);
  if (off.length) {
    console.log(`\n${off.length} more than ${TOLERANCE_LU} LU from target — worth a listen:`);
    for (const s of off) console.log(`  ${s.id.padEnd(20)} ${s.lufs} LUFS`);
  }
  console.log(`\nAudition them at /sounds.html\n`);
}

async function describe(id, file, measured, labels, skipped) {
  const lufs = measured ? Math.round(parseFloat(measured.input_i) * 10) / 10 : null;
  return {
    id,
    group: SOUND_GROUPS[id],
    label: labels[id] || id,
    file: `sounds/${id}.m4a`,
    bytes: fs.statSync(file).size,
    duration: await durationOf(file),
    lufs,
    truePeak: measured ? Math.round(parseFloat(measured.input_tp) * 10) / 10 : null,
    offTarget: lufs === null ? false : Math.abs(lufs - TARGET_LUFS) > TOLERANCE_LU,
    skipped,
  };
}

build().catch((e) => {
  console.error(e?.stderr || e);
  process.exit(1);
});
