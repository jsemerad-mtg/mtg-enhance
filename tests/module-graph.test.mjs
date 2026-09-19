// Does every local import actually resolve to an export?
//
// This exists because a missing export shipped: src/index.js imported KEY_MAX
// from src/deck-key.js, which didn't export it. `node --check` passes — it
// only parses — and nothing else in the suite loads the Worker's module graph,
// because src/game-session.js imports "cloudflare:workers" and node cannot
// resolve that outside the Workers runtime. So the first thing to notice was
// esbuild, during `wrangler deploy`, after the migration had already been run
// and the old Worker was already broken.
//
// Static, deliberately: it reads the files and matches named imports against
// named exports, so it works on modules node refuses to load.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));
const source = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")]));

// What each file exports by name. Covers the three forms this codebase uses:
//   export function x    export const x    export { a, b }
function exportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s+class\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const as = part.split(/\sas\s/);
      const name = (as[1] || as[0]).trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// Named imports from a relative path, i.e. the ones that can be wrong here.
function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/gm)) {
    const from = m[2].replace(/^\.\//, "");
    for (const part of m[1].split(",")) {
      const as = part.split(/\sas\s/);
      const name = as[0].trim();
      if (name) out.push({ name, from });
    }
  }
  return out;
}

console.log("\nthe files are there at all");
{
  check("src has modules in it", files.length > 0, String(files.length));
  check("including the Worker entry", files.includes("index.js"));
}

console.log("\nevery named import resolves");
let checked = 0;
for (const file of files) {
  for (const { name, from } of importsOf(source[file])) {
    checked += 1;
    if (!source[from]) {
      check(`${file} → ${from}`, false, "no such file in src/");
      continue;
    }
    const has = exportsOf(source[from]).has(name);
    check(`${file} imports ${name} from ${from}`, has,
      has ? "" : `${from} exports: ${[...exportsOf(source[from])].sort().join(", ") || "(none)"}`);
  }
}
check("and there were imports to check", checked > 0, String(checked));

console.log("\nnothing imports itself");
for (const file of files) {
  const self = importsOf(source[file]).some((i) => i.from === file);
  check(`${file} doesn't import ${file}`, !self);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
