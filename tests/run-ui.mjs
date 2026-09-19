// Boots the mock worker, runs every browser suite against it, shuts it down.
//
//   npm run test:ui
//
// The suites need a server because the client talks to /api/player-state,
// /api/records and /api/decks before it will render anything. mock-server.mjs
// answers those and serves public/ — it is the Worker's shape, not its code.
//
// Playwright and a browser are not repo dependencies, because CI for this
// project is one person on a laptop. If the launch fails, install them:
//   npm i -D playwright && npx playwright install chromium
// or point MTGE_CHROMIUM at a Chromium you already have.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MTGE_TEST_PORT || 8232);
const BASE = `http://127.0.0.1:${PORT}`;

const SUITES = [
  "modes-ui", "steps-ui", "records-ui", "bracket-ui",
  "decklink-ui", "oracle-ui", "client-session-ui", "table-ui", "oppview-ui",
  "mycommanders-ui", "resilience-ui",
  "table-polish-ui", "undo-share-ui", "import-ui", "partner-ui",
];

const server = spawn(process.execPath, [path.join(here, "mock-server.mjs")], {
  env: { ...process.env, MTGE_TEST_PORT: String(PORT) },
  stdio: ["ignore", "ignore", "inherit"],
});

// Wait for it rather than sleeping a guessed number of milliseconds.
const ready = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const run = (file) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, `${file}.test.mjs`)], {
      env: { ...process.env, MTGE_TEST_BASE: BASE },
      stdio: "inherit",
    });
    p.on("exit", (codeOut) => resolve(codeOut === 0));
  });

let failed = [];
try {
  if (!await ready()) {
    console.error(`\nThe mock server never came up on ${BASE}.\n`);
    process.exitCode = 1;
  } else {
    for (const suite of SUITES) {
      console.log(`\n── ${suite} ──`);
      if (!await run(suite)) failed.push(suite);
    }
  }
} finally {
  server.kill();
}

if (failed.length) {
  console.log(`\n${failed.length} suite${failed.length === 1 ? "" : "s"} failed: ${failed.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("\nAll browser suites passed.");
}
