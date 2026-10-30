// Power BI discovery recorder for ROAM Logger.
//
// Opens the observation report in Microsoft Edge (your own sign-in, kept in a
// private profile folder next to this script), lets you click around
// normally, and records everything the app needs:
//   - every report data response (Power BI's query calls), with its request
//   - which columns each response contains (decoded from Power BI's format)
//   - where your name appears on the page ("Account manager for ...")
//   - the tables visible on screen and the page address
//
// Usage (from the repository root):
//   npm install --no-save playwright-core
//   node tools/powerbi-discovery/record.mjs [report-url]
//
// While it runs, type in this terminal:
//   s + Enter   save a snapshot of the page (name, visible tables, address)
//   q + Enter   finish: write summary.txt and close Edge
//
// Everything is written to tools/powerbi-discovery/capture-<time>/.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const reportUrl =
  process.argv[2] ||
  "https://app.powerbi.com/groups/me/reports/9444ebdb-d554-4f2d-a1c9-4fd1ae81e4c9/ReportSection863ec14e12657866880b?experience=power-bi";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(here, `capture-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

// Shared capacity: .../explore/querydata ; Premium/Fabric: .../QueryExecutionService/.../public/query
const isData = (u) => /querydata|executequeries|queryexecutionservice|\/public\/query(\?|$)/i.test(u);
const shortUrl = (u) => u.split(/[?#]/)[0].replace(/^https?:\/\//, "");

const requestCounts = new Map();
const dataFiles = [];
let dataCount = 0;
let snapshotCount = 0;

/** Column names and row counts from a Power BI query response (DSR format). */
function describeResponse(text) {
  try {
    const json = JSON.parse(text);
    const results = json.results || json.jobs || [];
    return results.map((r, i) => {
      const data = r.result?.data ?? r.data ?? {};
      const select = data.descriptor?.Select ?? [];
      const ds = data.dsr?.DS?.[0] ?? {};
      const rows = (ds.PH ?? []).reduce((n, ph) => n + (ph.DM0?.length ?? 0), 0);
      const colGroups = (ds.SH ?? []).reduce((n, sh) => n + (sh.DM1?.length ?? 0), 0);
      return `  result ${i}: ${rows} rows${colGroups ? `, ${colGroups} column groups` : ""}; columns: ` +
        select.map((s) => `${s.Name ?? s.Value} [${s.Kind === 2 ? "measure" : "field"}]`).join(", ");
    }).join("\n") || "  (no results array - top-level keys: " + Object.keys(json).join(", ") + ")";
  } catch (e) {
    return "  (not JSON: " + text.slice(0, 120).replace(/\s+/g, " ") + ")";
  }
}

// Runs inside the page: where is the signed-in name, and what tables are on screen?
const PAGE_PROBE = () => {
  const attrs = ["aria-label", "title", "data-tooltip", "alt"];
  const nameHits = [];
  for (const el of document.querySelectorAll("*")) {
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v && /account|manager|signed in|profile/i.test(v) && v.length < 200) {
        nameHits.push({ tag: el.tagName.toLowerCase(), attr: a, value: v, class: (el.className && el.className.baseVal === undefined ? el.className : "").toString().slice(0, 80) });
      }
    }
    if (nameHits.length > 40) break;
  }
  const grids = [...document.querySelectorAll('[role="grid"],[role="treegrid"],[role="table"]')].slice(0, 6).map((g) => {
    const rows = [...g.querySelectorAll('[role="row"]')];
    const cells = (r) => [...r.querySelectorAll('[role="columnheader"],[role="rowheader"],[role="gridcell"],[role="cell"]')].map((c) => (c.innerText || c.getAttribute("aria-label") || "").trim());
    return { rows: rows.slice(0, 8).map(cells), totalRows: rows.length };
  });
  let storageKeys = [];
  try { storageKeys = [...Object.keys(localStorage).map((k) => "local:" + k), ...Object.keys(sessionStorage).map((k) => "session:" + k)].slice(0, 60); } catch (e) {}
  return {
    url: location.href,
    title: document.title,
    hasPowerBIAccessToken: typeof window.powerBIAccessToken === "string",
    nameHits,
    grids,
    storageKeys,
    pageTabs: [...document.querySelectorAll('[role="tab"],[role="treeitem"],[role="listitem"]')].map((e) => (e.innerText || "").trim()).filter(Boolean).slice(0, 20),
  };
};

const context = await chromium.launchPersistentContext(path.join(here, ".edge-profile"), {
  // PBI_CHANNEL=chromium uses Playwright's own Chromium (for testing without Edge).
  channel: process.env.PBI_CHANNEL === "chromium" ? undefined : process.env.PBI_CHANNEL || "msedge",
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

context.on("response", async (response) => {
  const url = response.url();
  const key = shortUrl(url);
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  if (!isData(url)) return;
  try {
    const body = await response.text();
    const n = String(++dataCount).padStart(3, "0");
    const file = `data-${n}.json`;
    fs.writeFileSync(path.join(outDir, file), body);
    fs.writeFileSync(path.join(outDir, `data-${n}.request.json`), response.request().postData() ?? "");
    dataFiles.push({ file, url, description: describeResponse(body) });
    console.log(`[data #${n}] ${key} (${body.length} bytes)\n${describeResponse(body)}`);
  } catch (e) {
    console.log(`[data] could not read body of ${key}: ${e.message}`);
  }
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(reportUrl, { waitUntil: "domcontentloaded" }).catch((e) => console.log("Navigation:", e.message));

console.log(`
Recording to ${outDir}
1. Sign in if asked (first run only).
2. Click "Monthly Employee Detailed Observation Counts", use the slicers
   (e.g. Name), scroll the table - every data response is saved.
3. Hover your profile picture (top right) so its label is on screen.
Type "s" + Enter to save a page snapshot, "q" + Enter to finish.
`);

async function snapshot() {
  const n = String(++snapshotCount).padStart(2, "0");
  const probe = await page.evaluate(PAGE_PROBE).catch((e) => ({ error: e.message }));
  fs.writeFileSync(path.join(outDir, `snapshot-${n}.json`), JSON.stringify(probe, null, 2));
  console.log(`[snapshot ${n}] ${probe.url ?? ""}\n  name hints: ${(probe.nameHits ?? []).map((h) => `${h.attr}="${h.value}"`).slice(0, 5).join(" | ") || "none"}\n  tables on screen: ${(probe.grids ?? []).length}`);
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const cmd = line.trim().toLowerCase();
  if (cmd === "s") await snapshot();
  if (cmd === "q") break;
}

await snapshot();
const top = [...requestCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
const summary = [
  `Report: ${reportUrl}`,
  `Data responses saved: ${dataCount}`,
  "",
  "== Data responses ==",
  ...dataFiles.map((d) => `${d.file}  ${shortUrl(d.url)}\n${d.description}`),
  "",
  "== Most frequent requests ==",
  ...top.map(([k, n]) => `${n}x ${k}`),
  "",
  `Snapshots: ${snapshotCount} (snapshot-NN.json: name hints, visible tables, page names, storage keys)`,
].join("\n");
fs.writeFileSync(path.join(outDir, "summary.txt"), summary);
console.log("\n" + summary + `\n\nDone. Paste summary.txt (and the last snapshot) where needed: ${outDir}`);
await context.close();
process.exit(0);
