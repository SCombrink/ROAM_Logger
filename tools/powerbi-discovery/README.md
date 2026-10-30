# Power BI discovery for the monthly tracker

ROAM Logger's sidebar shows each person's monthly observation counts, read
from the Power BI report. This folder helps find, on your own computer, the
exact details the app needs to read that report.

There are two ways to use it.

## A. Quick: record once and paste the result

From the repository root, in a terminal:

```
npm install --no-save playwright-core
node tools/powerbi-discovery/record.mjs
```

1. Edge opens the report. Sign in if asked (first run only).
2. Click **Monthly Employee Detailed Observation Counts**. Use the **Name**
   slicer to pick yourself, and scroll the table a little.
3. Hover your profile picture (top right) so "Account manager for ..." shows.
4. In the terminal type `s` then Enter (snapshot), then `q` then Enter (finish).
5. Open the new `tools/powerbi-discovery/capture-<time>/` folder and share
   `summary.txt`, the last `snapshot-NN.json`, and one `data-NNN.json` that
   lists the monthly counts (you may replace other people's names).

## B. Guided: let an AI assistant on your computer drive it

Open an AI coding assistant on your computer in this repository (for example
Claude Code) and paste the prompt below. It knows the goal and what is
already known, writes and runs the tests, and tells you what to click in
Power BI, in Edge DevTools or in the terminal, until it has everything.

---

### Prompt to paste

```
You are helping me finish the Power BI integration of ROAM Logger, a Tauri
(Rust + React) desktop app in this repository. Work with me step by step:
you write and run scripts on this Windows computer, tell me exactly what to
click in Power BI, Edge DevTools or the terminal, read the results, and keep
going until the goal below is met. Do not guess values - verify each one
against real captured data.

GOAL
Produce tools/powerbi-discovery/findings.json with every value the app needs
to read one person's monthly observation counts from the Power BI report,
each verified:
{
  "reportUrl":         "the report URL that opens the observation page directly",
  "pageName":          "Monthly Employee Detailed Observation Counts",
  "dataUrlPattern":    "substring that identifies the data requests",
  "responseFormat":    "how counts are laid out in the response (see below)",
  "observerQueryName": "Table.Column holding employee names, e.g. Employees.Name",
  "urlFilterField":    "Power BI URL filter form, e.g. Employees/Name",
  "verifiedFilterUrl": "reportUrl + &filter=... that I confirmed shows only me",
  "monthSource":       "where the month comes from: matrix column groups, one column per month, or a date/month field (give its Table.Column)",
  "countMeasure":      "Table.Measure or column holding the count",
  "identity":          { "where": "how to read my display name from the page", "example": "Surname, Name" },
  "sampleResponseFile":"path of a captured response containing my row",
  "notes":             "anything unusual"
}
Done = findings.json is complete, every value was confirmed with me, and a
small script (tools/powerbi-discovery/verify.mjs) opens verifiedFilterUrl,
captures the data and prints my 12 monthly counts for this year, matching
what I see in Power BI.

WHAT IS ALREADY KNOWN
- Report: https://app.powerbi.com/groups/me/reports/9444ebdb-d554-4f2d-a1c9-4fd1ae81e4c9/ReportSection863ec14e12657866880b?experience=power-bi
  It opens on page "Global OBS Report"; the counts are on page
  "Monthly Employee Detailed Observation Counts" (a table listing every
  employee: Pers.no., Personnel Number (shows "Surname, Name"), Hire Date,
  Employment Type, Region, Office, Sector, Business Unit, Cost Center, then
  monthly counts to the right). Slicers on the right: Region, Sector,
  Business Unit, Cost Center, Associate, Office, Name, Manager, Employment Type.
- Data does NOT come from .../explore/querydata. The report runs on a
  Premium capacity; data requests go to
  pbipncus2-northcentralus.pbidedicated.windows.net/webapi/capacities/<id>/workloads/QES/QueryExecutionService/automatic/public/query
  (POST, about 27 per page load). Expected response format: Power BI "DSR"
  JSON - results[].result.data.descriptor.Select (Name, Kind 1=field
  2=measure, Value key like G0/M0) and results[].result.data.dsr.DS[0]
  with PH[].DM0[] rows (S = schema, C = compressed values, R = repeat
  bitmask, Ø = null bitmask, DN = value dictionary in ValueDicts) and, for
  matrices, SH[].DM1[] column members with X[] cells per row. Confirm this.
- The page shows a profile button top right labelled "Account manager for
  Surname, Name" (inner element: div.userInfoCircle). The label was NOT
  found as an aria-label/title by a simple querySelector - find where it is.
- Power BI only sends the first few hundred rows of a large table, so the
  app opens the report with a URL filter for one person
  (?filter=Table/Column eq 'Surname, Name'; spaces in names become _x0020_).
  The right Table/Column has not been confirmed yet.
- tools/powerbi-discovery/record.mjs already records all data responses,
  page snapshots (name hints, visible tables) and a summary while I click.
  Start from it; change or extend it as needed.
- The app's own code: src-tauri/src/powerbi.rs (opens Edge, clicks the
  page, captures traffic via src-tauri/src/cdp_net.rs), and
  src-tauri/src/powerbi_dsr.rs (decodes DSR, detects name/month/count
  columns, builds URL filters; has unit tests showing expected shapes).
  Read these so findings.json fits what the app expects.

HOW TO WORK
1. Read record.mjs and the three Rust files above. Summarise in 5 lines
   what the app expects.
2. Have me run record.mjs and click through the report. Read summary.txt
   and the data-*.json files yourself.
3. Find the response that contains the employee table. Decode it (write a
   small Node script) and show me the decoded rows for the first 3
   employees, with column names. Ask me to confirm they match the screen.
4. Work out observerQueryName and urlFilterField. Build the filter URL for
   my name, have me open it in Edge, and confirm the table shows only me.
5. Find where my display name lives (DOM attribute, tooltip, a request
   such as /me or /user, localStorage/sessionStorage, or a JWT claim).
   If needed, tell me exactly what to inspect in Edge DevTools
   (F12 > Elements / Network / Application) and what to paste back.
6. Write verify.mjs and findings.json. Run verify.mjs and compare its 12
   monthly counts with what I read off the screen. Fix until they match.
7. Finish with a short report: findings.json, how verify.mjs proves it,
   and any change needed in powerbi.rs / powerbi_dsr.rs (as a diff).

RULES
- Ask before anything that changes Power BI (no saving, sharing,
  subscribing or editing). Read only.
- Keep captured data local; it contains colleagues' names. Do not commit
  capture-* folders or .edge-profile (they are git-ignored).
- Prefer small scripts you run and read over asking me to describe things.
- When unsure, capture more and look, rather than assume.
```

---

When the assistant finishes, share `findings.json` (and its proposed
changes) and the app can be finished from it.
