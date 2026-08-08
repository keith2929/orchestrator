# Live GUI: small-wins plan

**This file is the single source of truth for what gets built next.** It
supersedes the earlier `MASTER_PROMPT.md` / `masterprompt2.md` /
`orchestrator_fix_prompt.md` plans, which described the original extraction-bot
build and have been removed. The orchestrator keeps a verbatim copy at
`../orchestrator/MASTER_PROMPT.md` (its `server.js` reads that fixed path);
edit this file and re-copy, never the other way round.

## How to use this file

This is a living checklist, not a one-time plan. After finishing the work for
a stage, check off its bullets, update its status line with what was actually
built and measured, and commit the update. If a stage is skipped or modified
due to discoveries made during implementation, document the deviation inline.

---

## Architecture overview & current reality

- **Tech stack**: Vite + React (SPA, frontend under
  `packages/valuation-creator/app/`), Express backend (orchestrator under
  `server.js` at root), TypeScript monorepo (`pnpm`).
- **Providers**: `ExtractionProvider` (legacy static fixture / JSON provider)
  vs. `LiveApiProvider` (calls `/api/...` endpoints on the orchestrator).
- **`packages/valuation-creator/app/src/context/CompanyContext.tsx`** —
  `CompanyContext.tsx` has `selectCompany(ticker, exchange)` wired to
  `provider.searchTicker`.
- **`packages/valuation-creator/app/src/providers/LiveApiProvider.ts`** —
  live provider; `searchTicker`, `getFinancials` and `getMarketData`
  implemented (Stages 1–2), `getPeer` still throws "not available until Step
  3". One `/api/financials/:ticker` round trip per company is shared between
  `getFinancials` and `getMarketData`, and data-quality warnings are exposed
  through `getWarnings` (see below).
- **`.../providers/LiveApiProvider/canonicalMapper.ts`** —
  `CanonicalFinancialData → FinancialStatements`, aligning the three
  independent canonical period series on fiscal year, scaling reported units,
  plugging residual "other" buckets, and deriving working-capital movements.
  Absent tags default to 0 and are recorded in `missingFields`.
- **Warnings path** — `LiveApiProvider.getWarnings` → forwarded by
  `CachedMarketDataProvider.getWarnings` → rendered as a banner by
  `StatementsView` (duck-typed `WarningsCapableProvider`, the same surface
  `ExtractionProvider` uses). `StatementsView` reads `getFinancials` only, so
  statements render even when market data is unavailable.
- **Local dev**: `run-local.sh` builds the orchestrator *and its workspace
  dependencies*, runs `sync-workspace-dists.sh`, then starts `server.js`
  (port 4501) and the app dev server (port 4502, set via `vite.config.ts`
  `server.port`/`VITE_DEV_PORT` — do NOT reintroduce CLI `--port` flags
  through `pnpm ... dev --`, that forwarding is broken with this pnpm/vite
  combo and silently falls back to 5173). Desktop shortcut: `~/Desktop/Valuation Calc.desktop`.
- **`sync-workspace-dists.sh`** — mandatory after any cross-package change.
  `.npmrc` sets `symlink=false` (vboxsf share), so workspace deps are
  install-time *copies*; pnpm never refreshes them, not even on `pnpm install
  --force`. Without this step a rebuilt adapter silently never reaches
  `server.js`.
- **Env vars** (`.env`, gitignored): `FMP_API_KEY`, `ALPHAVANTAGE_API_KEY`,
  `POLYGON_API_KEY`, `SEC_EDGAR_USER_AGENT`. No `.env.example` currently —
  intentionally removed after it leaked a real key; recreate as a clean
  placeholder-only template if onboarding another machine/person.

## Live source coverage (measured 2026-08-04, not assumed)

Verified by running the pipeline against the real APIs with the keys in
`.env`. This is what the stages below can actually rely on:

- **EDGAR (tier 1)** — works, and is effectively the *only* source of
  statements. Supplies 10 fiscal years plus identity and shares outstanding.
  Carries no prices, by design.
- **Polygon (tier 2)** — `/v3/reference/tickers` works; `/v2/last/trade` is
  **403 on the free tier**, so the adapter falls back to
  `/v2/aggs/ticker/{t}/prev` (previous close), which the free tier does
  serve. This is the working price source.
- **FMP (tier 2)** — every endpoint returns **403**; the key is rejected.
  Contributes nothing today.
- **Alpha Vantage (tier 2)** — the key works when called directly, but the
  pipeline calls it twice per fetch (`resolveMeta` + `fetchFinancials`) and
  it is usually already rate-limited (free tier), so it is skipped in
  practice.
- **yfinance** — broken for every ticker: `could not obtain consent cookie:
  HTTP 404`.
- **HTML scraper** — 403 on every page fetch.

**Consequence: coverage is US/EDGAR-only.** Non-US tickers (`C6L`,
`005930.KS`) return zero periods and surface a visible error, not partial
data. Any stage that assumes international coverage needs a working yfinance
replacement first.

## Confirmed gaps (checked against source, not assumed)

- `CanonicalMeta` has no sector/industry/SIC/market-cap-classification field.
  Needed for Stage 5 (dynamic peers); size can proxy off existing
  `sales`/`sharesOutstanding × currentPrice`, industry cannot.
- No adapter fetches price history — real 5y regression beta is out of scope
  for all 5 stages below; placeholder beta used instead.
- No source carries a 52-week high/low, so `getMarketData` collapses both to
  the current price; the football field's "52-week range" bar is a point.
- `marketValueOfDebt` is the latest **book** value of debt, and `cash`
  excludes short-term investments — both flagged as warnings, not silently
  substituted.
- `dividendsPaid` arrives absent for at least some filers (AAPL included), so
  `commonDividendsPaid` defaults to 0 and DDM implies 0.0000. Corrected
  2026-08-05: EDGAR *does* carry the data (`PaymentsOfDividends`, AAPL FY2025 =
  15,421,000,000) — it is `edgar-adapter`'s first-present-concept selection that
  drops it. See Stage 3 for the mechanism.

---

## Stage 1 — Wire up ticker search (live) ✅ CLEAR (2026-08-04)

**Status:** Implemented and verified end-to-end. `LiveApiProvider.searchTicker`
calls `/api/search/:ticker` and normalizes the response into `CompanyRef`.
Verified live for AAPL and MSFT; unknown tickers throw cleanly and
`CompanyContext` handles errors gracefully.

- [x] Implement `LiveApiProvider.searchTicker` calling `/api/search/:ticker`
- [x] Normalize backend JSON (`{ ticker, companyName, exchange, currency }`)
      into `CompanyRef` (`id`, `name`, `ticker`, `reportingCurrency`)
- [x] Demo: searching `AAPL` in the live app UI resolves the company name and
      enables financials view without crashing
- [x] Unsupported/unknown ticker returns a clear error, never an unhandled
      rejection
- [x] *(added)* Server-side ticker validation in orchestrator route:
      validates the returned ticker matches the request (throws on mismatch/null
      or unknown input)

---

## Stage 2 — Get the financials (live) ✅ CLEAR (2026-08-04)

**Status:** Implemented and verified end-to-end against the live APIs.
`canonicalMapper.ts` maps `CanonicalFinancialData → FinancialStatements`;
`LiveApiProvider.getFinancials`/`getMarketData` share one
`/api/financials/:ticker` round trip per company; `missingFields` reach the UI
through `getWarnings` → `CachedMarketDataProvider` → `StatementsView`'s banner.

Verified live for AAPL: 10 fiscal years (FY2016–FY2025), FY2025 revenue
416,161,000,000, `currentPrice` 303.42, `sharesOutstanding` 14,594,180,000
(≈$4.43tn market cap, cross-checked against Polygon and Alpha Vantage
directly), 96 warnings surfaced rather than swallowed. Full suite green: 604
tests across 13 packages, `pnpm -r build` (which is where typechecking
happens — there is no repo-wide `tsc --noEmit` script) and `eslint .` clean.

**Re-audited 2026-08-04** against the working tree: every checkbox below
still holds. `pnpm -r test` → 604 passed / 13 packages, `pnpm -r build` → 0,
`eslint .` → clean.

- [x] `LiveApiProvider.getFinancials` / `getMarketData` call
      `/api/financials/:ticker` and map `CanonicalFinancialData` into
      `FinancialStatements` / `MarketData` via `canonicalMapper.ts`
- [x] Map income statement (revenue, gross profit, operating income / EBIT,
      net income, EBITDA derived if missing)
- [x] Map balance sheet (cash, total debt, total equity / book value, total
      assets)
- [x] Map cash flow statement (operating cash flow, capital expenditures,
      dividends paid)
- [x] Map market data (`currentPrice`, `sharesOutstanding`, `week52High`/
      `week52Low` defaulted to current price, `marketValueOfDebt`, `cash`)
- [x] Pass all unmapped / defaulted canonical tags through `getWarnings()`
      so data quality is fully visible in the UI banner
- [x] Demo: searching `AAPL` populates the financials tab with 10 real fiscal
      years (FY2016–FY2025), correct revenue, and a working market cap
- [x] Unsupported/malformed data surfaces a visible error banner rather than
      crash or report a silent zero.
- [x] *(added)* Polygon previous-close fallback, so `getMarketData` resolves
      at all
- [x] *(added)* `sync-workspace-dists.sh`, so cross-package changes reach the
      running server

---

## Stage 3 — DCF/DDM valuation with a fake peer average ⚠️ MOSTLY CLEAR — DDM gap (live GUI re-verified 2026-08-05)

**Status:** Implemented; re-verified in the *running* GUI (headless Chromium
against `./run-local.sh`: API 4501 + app dev server 4502, live EDGAR/Polygon
data, no fixtures). `LiveApiProvider.getPeer` returns a hardcoded placeholder
peer (`PLACEHOLDER_PEER`, ticker `"FAKE"`, name `"PLACEHOLDER PEER (not real
data)"`, `equityBeta5Y: 1.0`, every other numeric field non-zero) and
`SessionPlaceholderBanner` shows the `PLACEHOLDER_PEER_DATA` banner on **every**
tab.

**Measured for AAPL (2026-08-05, live, price = Polygon previous close 309.38,
shares 14,594,180,000, FY2016–FY2025 EDGAR statements):**

| Figure | Measured |
| --- | --- |
| DCF implied price — Gordon Growth | **97.5331** (upside −68.5%, EV 1,478,160,067,357.5) |
| DCF implied price — Exit Multiple | **44.1704** (upside −85.7%, EV 699,375,331,706.5) |
| DDM implied price | **0.0000** (equity value 0.0, upside −100.0%) |
| WACC | **7.20%** (finite) |
| Cost of equity (Ke) | 7.35% (Rf 1.97% + relevered β 0.6868 × MRP 7.83%) |
| Pre-tax / after-tax Kd | 0.00% / 0.00% |
| MV equity / MV debt | 4,515,147,408,400.0 / 90,678,000,000.0 (weights 98.0% / 2.0%) |
| Comps (placeholder peer) median P/E LTM | 35.00x → implied 268.6242; EV/EBITDA LTM → 169.4207 |

No `NaN` anywhere in the DOM on any tab, no page errors, no error banners once
market data resolves.

**The one gap: DDM implied price is 0.0000, not a real price.** It is finite,
not NaN, and nothing throws — but every forecast year's total dividends are 0
(payout ratio 0.00%), so the model is degenerate. Root cause is *not* the
placeholder peer and *not* "EDGAR lacks the data" (the earlier note above was
wrong): `edgar-adapter`'s `resolveConcept()` (`src/companyFacts.ts`) takes the
**first candidate concept that exists at all** and never falls back. For AAPL
`PaymentsOfDividendsCommonStock` (listed first in `src/concepts.ts`) exists but
only covers FY2015–FY2017, so `PaymentsOfDividends` — which covers 2011→2025
(FY2025 = 15,421,000,000) — is never consulted, and `cashFlow.dividendsPaid`
comes through absent for every year the model uses. Fix: make candidate
selection per-period (or union the candidates) rather than first-present-wins.

Related, same class, but data-coverage rather than a bug: no candidate concept
(`InterestExpense`, `InterestExpenseDebt`) covers AAPL FY2024–FY2025, so
`interestExpense` is absent, pre-tax Kd computes as 0.00% and WACC is
effectively all-equity (7.20% ≈ 98.0% × 7.35%).

Also observed, cosmetic, not blocking: (a) the four comps peer rows are the same
placeholder object, so React logs duplicate-key warnings from
`PeerMultiplesTable` (keyed on `p.name`); (b) `FootballFieldView` hardcodes the
`S$` currency symbol, so a USD company renders as `S$309.38`; (c) the beta in
WACC still comes from the `SIA_BETA_PEERS` airline fixture, not from
`PLACEHOLDER_PEER.equityBeta5Y`.

Operational note for anyone repeating this: Polygon's free tier rate-limits
quickly, and *every* `/api/search/:ticker` call spends a Polygon request. A
readiness poll loop against that endpoint will exhaust the quota and make
`getMarketData` throw "no source reported currentPrice" in the GUI — poll the
app's port, not the API. Also `run-local.sh` reads `PORT` from the environment
(`API_PORT="${PORT:-4501}"`); an inherited `PORT` silently moves the API off
4501.

- [x] `LiveApiProvider.getPeer` returns one hardcoded placeholder `PeerData`
      regardless of ticker
- [x] Obviously-fake identifying fields (`name: "PLACEHOLDER PEER (not real data)"`,
      `ticker: "FAKE"`)
- [x] Every numeric field real/non-zero/non-undefined, incl.
      `equityBeta5Y: 1.0` placeholder (undefined/0 breaks or silently
      corrupts WACC downstream)
- [x] Persistent UI banner when placeholder peer data is active — verified
      visible on Search, Assumptions, Statements, Beta/WACC, Valuations,
      Sensitivity and Football field
- [~] Demo: DCF/DDM produces a real implied price for a live ticker, peer
      inputs unmistakably marked placeholder, WACC doesn't NaN — **DCF yes
      (97.5331 / 44.1704), WACC yes (7.20%, finite), DDM no (0.0000)**; see
      the `dividendsPaid` concept-fallback bug above

---

## Stage 4 — Peer average from a hardcoded peer set ✅ CLEAR (live GUI verified 2026-08-06)

**Status:** Implemented and verified in the *running* GUI (headless Chromium
against `./run-local.sh`: API 4501 + app dev server 4502, live EDGAR/Polygon
data, no fixtures — driver kept at `__tests__/live-gui/verifyStage4.cjs`). Peer
tickers resolve off the hardcoded sector table (`peerSets.ts`, US tickers only),
`/api/peers` fetches them in one batch, and the comps tables + football field
render **real averaged peer multiples**, with the banner state from task-10.

**Gap found and fixed during this verification.** The provider-side work was
right, but no view could reach it: `ValuationsView`, `useValuationModel` and
`usePlaceholderWarnings` still fetched peers as
`SIA_COMPS_PEER_REFS.map(ref => provider.getPeer(ref.ticker, ref.exchange))` —
the SIA airline fixture's refs (`293`/SEHK, `9202`/TSE, `A003490`/KOSE,
`9201`/TSE). None are in `SECTOR_PEER_SETS`, so loading AAPL produced four
identical `PLACEHOLDER_PEER` rows (P/E 35.00x), the full-placeholder banner, and
**no `/api/peers` request at all**. New `providers/peerGroups.ts`
(`loadCompsPeers` / `peerSourceRefs` / `isPeerGroupCapableProvider`) now routes
all three call sites to the *selected company's* own peer group via
`LiveApiProvider.getPeerGroup`, falling back to the fixture refs for providers
without one (`FixtureProvider`); `CachedMarketDataProvider` forwards
`getPeerGroup` only when its delegate has it. Because the banners are computed
from the same `peerSourceRefs` the tables fetched, they can no longer describe a
different peer set than the views render.

**Measured for AAPL (2026-08-06, live, price 311.00 = Polygon previous close):**

| Peer (live) | Price | P/E LTM | P/B LTM | EV/EBITDA LTM |
| --- | --- | --- | --- | --- |
| MICROSOFT CORPORATION | 487.46 | 27.06x | 8.18x | 23.08x |
| Alphabet Inc. | 362.43 | 33.54x | 10.67x | 33.74x |
| Dell Technologies Inc. | 462.70 | 50.37x | −121.04x | 28.53x |

Averaged multiples (implied price): P/E LTM **36.99x** (283.8845), P/B LTM
−34.06x (−172.0862), EV/EBITDA LTM **28.45x** (278.4484), P/E NTM 36.99x
(162.2928), EV/EBITDA NTM 28.45x (179.4041). Medians 33.54x / 8.18x / 28.53x.
Football field bars are driven by those comps (LTM EV/EBITDA 225.18–330.92, NTM
EV/EBITDA 146.09–212.22, LTM P/B −611.52–53.93). No `NaN` in the DOM, no page
errors, and the duplicate-React-key warning from Stage 3 is gone now that peer
names are distinct. DDM is no longer degenerate (8.81 / 17.36 / 25.91) after the
Stage 3 dividends fix.

**Peers skipped, and why:** 3 of 6 (`MSFT, GOOGL, DELL, HPQ, HPE, CSCO`) load per
run; the other three are skipped with `Peer <T> was skipped: required field(s)
not reported: equityValue.` The cause is Polygon's free-tier request limit, not
the peer code: with six peers fetched at `PEER_CONCURRENCY = 4`, the orchestrator
records `SOURCE_RATE_LIMITED: Source "polygon" rate-limited resolveMeta; skipped`
for the overflow (Alpha Vantage is already rate-limited, FMP is 403, yfinance
404), leaving `currentPrice: null` → no `equityValue` → skipped rather than
zeroed. **Which** peers survive therefore varies between runs (an earlier run in
the same session kept MSFT/HPQ/CSCO instead). Mitigating it means a price source
that isn't quota-capped, or serialising peer price fetches — neither is a Stage 4
change.

**Banner state (task-10) confirmed on both the Valuations and Football-field
tabs:** full-placeholder banner **absent**; `PARTIAL_PEER_DATA` banner shown
("only 3 of 6 live peers for AAPL loaded; the peer group below is real data from
those 3 peers, not the full sector"); `PEER_BETA_PLACEHOLDER` banner shown
alongside it. The three states stay independently keyed and independently
rendered — a partially-real group is never collapsed into either silence or a
"fully real" claim.

Deviations from plan: yfinance-dependent international tickers stay excluded (as
planned); a peer with unusable figures is **skipped, never defaulted** to a
median/placeholder multiple, so the averages only ever contain real peers.

**Re-verified 2026-08-06 (second run, same driver, fresh `./run-local.sh`).**
Same conclusion, different surviving peers — which is the run-to-run variance
described above, now with direct evidence for its cause. `/api/peers?tickers=
MSFT,GOOGL,DELL,HPQ,HPE,CSCO` was the only peer request issued; **MSFT, GOOGL,
HPQ** loaded and **DELL, HPE, CSCO** were skipped (`required field(s) not
reported: equityValue`).

| Peer (live) | Price | P/E LTM | P/B LTM | EV/EBITDA LTM |
| --- | --- | --- | --- | --- |
| MICROSOFT CORPORATION | 487.46 | 27.06x | 8.18x | 23.08x |
| Alphabet Inc. | 362.43 | 33.54x | 10.67x | 33.74x |
| HP INC. | 28.52 | 10.31x | −75.38x | 7.82x |

Averaged multiples (implied price, AAPL at 311.00): P/E LTM **23.64x**
(181.4176), P/B LTM −18.84x (−95.1940), EV/EBITDA LTM **21.55x** (209.9829),
P/E NTM 23.64x (103.7139), EV/EBITDA NTM 21.55x (136.5842) — each the plain mean
of the three live rows above. Football field: LTM EV/EBITDA 73.85–330.92, LTM
P/B −380.85–53.93, NTM EV/EBITDA 51.44–212.22, DDM 8.81–25.91, DCF GG
65.50–200.18, DCF exit 32.11–58.19. No `NaN`, no console/page errors. Banners:
full-placeholder **absent**, `PARTIAL_PEER_DATA` ("only 3 of 6 live peers for
AAPL loaded") and `PEER_BETA_PLACEHOLDER` both shown, on Valuations *and*
Football field.

Quota — not data — is confirmed as the skip cause: refetching just
`/api/peers?tickers=DELL,HPE,CSCO` (a batch small enough to stay under Polygon's
free-tier per-minute cap) immediately returned real prices for all three (DELL
462.70 / 646,142,428 sh, HPE 53.22 / 1,324,203,521 sh, CSCO 121.50 /
3,941,434,665 sh). The peer code path is fine; the six-wide batch at
`PEER_CONCURRENCY = 4` simply outruns the price source.

**Re-verified 2026-08-06 (third run) — found and fixed a crash the first two runs
got lucky on.** Same driver, fresh `PORT=4501 ./run-local.sh`. This run only
**2** of 6 peers survived, and that is a case the earlier runs (3 survivors each)
never exercised: `computeStatistics` (`core/src/comps.ts`) computed `p25`/`p75`
via `quartileExc`, which throws `RangeError: QUARTILE.EXC position 0.75 (p=0.25,
n=2) is out of range [1, 2]` for `n < 3` — Excel's `#NUM!`, faithfully
reproduced. The throw happened inside `ValuationsView`'s `useMemo`, so React
unmounted the **entire Valuations view** (and the football field's
`useValuationModel` takes the same `buildComps` path). Since *which* peers
survive is quota-dependent and varies run to run, a 1- or 2-peer group is a
normal live outcome, not an edge case.

Fix: `MultipleStatistics.p25`/`p75` and `ImpliedValuationStatistics.p25`/`p75`
are now `number | null` / `ImpliedValuation | null`, and `computeStatistics`
returns `null` below `MIN_QUARTILE_EXC_PEERS` (= 3, the smallest `n` satisfying
`1 <= (n+1)p <= n` for both quartiles) instead of throwing. `quartileExc` itself
stays strict, so Excel fidelity and every golden is unchanged (the SIA fixture
has 4 peers). `MultipleStatTable` renders `n/a` for an undefined quartile rather
than inventing a number; `footballField.ts` only reads `.minimum`/`.maximum`,
which stay non-null, so the bars are unaffected.

**Measured for AAPL (third run, live, price 311.00):** peers loaded **MSFT**
(487.46, P/E LTM 27.06x, P/B 8.18x, EV/EBITDA 23.08x) and **HP INC.** (28.52,
10.31x, −75.38x, 7.82x). Averaged multiples (implied price): P/E LTM **18.69x**
(143.4311), P/B LTM −33.60x (−169.7544), EV/EBITDA LTM **15.45x** (149.5138),
P/E NTM 18.69x (81.9975), EV/EBITDA NTM 15.45x (98.7654) — each the mean of the
two live rows, with medians equal to the averages (n=2) and all four quartile
cells reading `n/a`. Football field: LTM EV/EBITDA 73.85–225.18, LTM P/B
−380.85–41.34, NTM EV/EBITDA 51.44–146.09, DDM 8.81–25.91, DCF GG 65.50–200.18,
DCF exit 32.11–58.19. No `NaN`, **no page errors and no console errors**
(previously an unhandled `RangeError` plus React's error-boundary warning).
Banners unchanged and correct on both tabs: full-placeholder **absent**,
`PARTIAL_PEER_DATA` ("only 2 of 6 live peers for AAPL loaded") and
`PEER_BETA_PLACEHOLDER` both shown.

**A second, distinct skip mechanism showed up this run.** Of the four skipped
peers, three were the familiar price-quota case (`DELL`, `HPE`, `CSCO` —
`required field(s) not reported: equityValue`; re-probing the batch confirms
`currentPrice: null` with `FIELD_UNFILLED/merge-engine` and no Polygon note at
all). But **`GOOGL` was skipped on `sales`, not `equityValue`** — its price
resolved fine (362.43); what was missing is `revenue` in the *latest* annual
period. Re-probing shows GOOGL FY2025 carries `costOfRevenue`, `operatingIncome`
and `netIncome` but no `revenue` tag from EDGAR alone; a single-ticker fetch
minutes earlier *did* have both `revenue` and `grossProfit` for FY2025, i.e. the
tag only arrives when a Tier-2 source happens not to be rate-limited. So peer
skips are not all price-quota: the statements side degrades independently, and
the same six-wide batch can drop a peer on either axis.

**Re-verified 2026-08-06 (fourth and fifth runs, same driver, fresh
`PORT=4501 ./run-local.sh`).** Two consecutive loads of AAPL, covering both the
`n = 2` and `n = 3` peer-count paths. Conclusion unchanged: the comps tables and
football field render real averaged peer multiples, and the task-10 banner state
is correct on both tabs. Price 311.00 (Polygon previous close) in both runs, and
`/api/peers?tickers=MSFT,GOOGL,DELL,HPQ,HPE,CSCO` was again the only peer request
issued per run.

| Run | Peers loaded | Peers skipped (reason) |
| --- | --- | --- |
| 4 (`n = 2`) | MSFT, HPQ | GOOGL (`sales`); DELL, HPE, CSCO (`equityValue`) |
| 5 (`n = 3`) | MSFT, DELL, HPQ | GOOGL (`sales, equityValue`); HPE, CSCO (`equityValue`) |

Peer rows (identical figures wherever the same peer appears in both runs):
MICROSOFT CORPORATION 487.46 / 27.06x / 8.18x / 23.08x; Dell Technologies Inc.
462.70 / 50.37x / −121.04x / 28.53x; HP INC. 28.52 / 10.31x / −75.38x / 7.82x.

Averaged multiples (implied price) — each the plain mean of that run's live rows,
checked by hand:

- **Run 4** P/E LTM **18.69x** (143.4311, −53.9%), P/B LTM −33.60x (−169.7544),
  EV/EBITDA LTM **15.45x** (149.5138, −51.9%), P/E NTM 18.69x (81.9975),
  EV/EBITDA NTM 15.45x (98.7654). Medians equal the averages and all four
  quartile cells read `n/a` — the `MIN_QUARTILE_EXC_PEERS` path from the third
  run, still degrading cleanly rather than throwing.
- **Run 5** P/E LTM **29.25x** (224.4723), P/B LTM −62.75x (−317.0107),
  EV/EBITDA LTM **19.81x** (192.7584), P/E NTM 29.25x (128.3277), EV/EBITDA NTM
  19.81x (125.8116). Medians 27.06x / −75.38x / 23.08x; at `n = 3` the quartiles
  populate (P/E p25 10.31x, p75 50.37x).

Football field, run 5: LTM EV/EBITDA 73.85–279.25, LTM P/B −611.52–41.34, NTM
EV/EBITDA 51.44–179.90, DDM 8.81–25.91, DCF GG 65.50–200.18, DCF exit
32.11–58.19, 52-week range flat at 311.00. Both runs: no `NaN` in the DOM, no
console errors, no page errors; full-placeholder banner **absent**,
`PARTIAL_PEER_DATA` and `PEER_BETA_PLACEHOLDER` both shown on Valuations *and*
Football field.

**Both skip mechanisms now trace to the same root cause, with provenance
evidence.** Re-probing `/api/peers?tickers=GOOGL,HPE,CSCO` (3-wide, under
Polygon's per-minute cap) returned real prices for all three — GOOGL 362.43,
HPE 53.22, CSCO 121.50 — *and* a `revenue` tag in each one's latest annual
period. So neither skip is a data gap. The `sales` skip is explained by
provenance: GOOGL's FY2025 `revenue` and `grossProfit` are keyed to
**`source: "polygon", tier: 2`**, while FY2024 `revenue` comes from `edgar`
(EDGAR emits `MISSING_CONCEPT` for GOOGL's latest-year revenue/gross profit).
Polygon is therefore GOOGL's *only* supplier of both `currentPrice` and
latest-year `revenue`, which is why one rate-limited source can drop that peer on
either axis. Corrected from the third run's note: the `revenue` tag is not
"absent from EDGAR alone" by coincidence of timing — it is structurally a Tier-2
field for this filer.

Driver fix made during this verification: `verifyStage4.cjs`'s `text()` helper
reads elements that may legitimately be absent (a hidden banner, an `n/a`
quartile), and inherited Playwright's 30s default timeout — so a run where a
cell was missing spent 30s per read across ~90 reads and hung for tens of
minutes instead of reporting the absence. It now sets
`page.setDefaultTimeout(READ_TIMEOUT_MS)` (5s); the waits that genuinely need to
be long still pass `PEER_TIMEOUT_MS` explicitly and are unaffected.

Still open, cosmetic, unchanged from Stage 3: `FootballFieldView` hardcodes the
`S$` symbol, so USD AAPL renders as `S$311.00`.

- [x] Hardcoded sector → peer-ticker table, **US tickers only** for this pass
      (EDGAR/FMP coverage; skip yfinance-dependent international tickers like
      `005930.KS`/`6758.T` to avoid an international-data debugging detour)
- [x] `LiveApiProvider.getPeer` calls `fetchFinancials` per peer ticker in
      the matching sector, maps into `PeerData` (sales/EBITDA/EBIT/
      earnings/book value from `CanonicalFinancialData`; beta stays fixed
      placeholder)
- [x] Demo: comps/football-field view shows real averaged peer multiples for
      a US ticker in a covered sector — verified live for AAPL on 2026-08-06
      (P/E LTM 36.99x avg over MSFT/GOOGL/DELL), after wiring the views to
      `getPeerGroup`; see the status note above
- [x] *(added)* `providers/peerGroups.ts` — the single peer-loading path shared
      by the comps tables, the football field and the peer-data banners
- [x] *(added)* Quartiles degrade to `null`/`n/a` below `MIN_QUARTILE_EXC_PEERS`
      peers instead of throwing `QUARTILE.EXC` out of range and unmounting the
      Valuations view — a quota-shortened peer group is a normal live outcome

---

## Stage 5 — Dynamic peer selection by size + industry ✅ CLEAR (live GUI verified across 3 SIC groups 2026-08-07)

**Status:** Implemented and verified end-to-end in the *running* GUI. Peers are
selected dynamically from the target's own SIC code plus a log-symmetric sales
size window, screened over the live SEC universe; the selected tickers reach the
comps table and the football field, with the four-state banner correct on both
tabs. Verified for **AAPL (SIC 3571)**, **WMT (5331)** and **PFE (2834)** — three
different SIC major groups, three different peer sets, one `/api/peers` request
each carrying exactly the screen's output. Size-proxy noise measured on the
ruler the screen actually uses (XBRL `frames` sales): **zero band flips** at
every window on every pool. Deviations: leveraged existing SEC submissions
SIC + the canonical sales proxy without a `CanonicalMeta` schema migration; and
PFE's comps/football views do not render for a **target-side** reason unrelated
to peer selection (`buildForecast` rejects a payout ratio > 1) — see the
2026-08-07 second-pass section below.

- [x] Add `sicCode`/`sicDescription` to `CanonicalMeta` (`packages/canonical/src/schema.ts`) or populate dynamically from SEC submissions metadata response / lookup tables
- [x] Populate from EDGAR metadata / lookup (SEC submissions response already carries `sic` / `sicDescription`)
- [x] Size screen: proxy via existing `sales` or `sharesOutstanding × currentPrice`
- [x] Screening universe: US/EDGAR-covered tickers only for this pass
- [x] Scope the actual selection algorithm (SIC match + size-band filter), measure size-proxy noise, and verify comps valuation pipeline integration

### Live GUI verification of the dynamic screen + its banner (2026-08-07)

Driver: `__tests__/live-gui/verifyDynamicPeers.cjs` (real SEC, no fixtures);
report: `docs/live-gui-dynamic-peers-report.json`. With `./run-local.sh` up
(`PORT=4501`), loading **AAPL**:

- `GET /api/peer-screen/AAPL` → **200 in ~2.5 s**: SIC `3571` (Electronic
  Computers), target size 416.2 B on the `frames-sales` ruler, **113** filers in
  the `browse-edgar` pool, **8** of them ticker-bearing (`DELL, OMCL, OSS,
  SCKT, SMCI, SMCIP, XNDU, ZEPP`), **7** sized off the XBRL frames sweep.
- The app screened those 8 itself and asked for
  `/api/peers?tickers=DELL,XNDU` — the **dynamically selected** pair, *not* the
  hardcoded technology-hardware sector set. The comps table rendered
  **Dell Technologies Inc.** as the peer (XNDU reported no annual periods and
  was skipped, never zeroed).
- All four banner states behaved: full-placeholder banner **absent**;
  `DYNAMIC_PEER_SELECTION` banner shown on the comps *and* football-field tabs
  ("the 1 peer for AAPL was chosen by the live SIC + size screen (SIC major
  group 35 (the exact code was too thin), a ×10 sales-size window, 8 candidates
  screened) … 1 of them was admitted without a size on the frames ruler");
  `PARTIAL_PEER_DATA` shown (1 of 2 loaded); `PEER_BETA_PLACEHOLDER` shown, as
  it is in every state. No `NaN` in the DOM, no console or page errors.
- Honest outcome worth recording: AAPL's own SIC pool is **too thin and too
  small** for it — the ladder had to widen to major group 35 at a ×10 window and
  still returned a single peer, because only 8 SIC-3571 filers carry a ticker
  and the largest (Dell) is ~4× smaller. The screen reports that rather than
  padding the set; a wider pool needs the sibling-SIC enumeration noted as a
  known limit in `README-INGESTION.md`.

### Live GUI verification across two SIC groups + measured ruler noise (2026-08-07, second pass)

The section above only ever loaded AAPL, which cannot distinguish "the screen
picks peers from the target's own industry" from "the app has one peer list".
This pass drives the *running* app (`PORT=4501 ./run-local.sh`, API 4501 + Vite
4502, headless Chromium, live SEC/EDGAR/Polygon, no fixtures) over **three US
targets in three different SIC major groups**, and measures the noise of the
ruler the screen actually uses.

Drivers and artifacts (all re-runnable):

| Artifact | What it holds |
| --- | --- |
| `__tests__/live-gui/verifyStage5.cjs` | multi-ticker sweep: screen inputs, `/api/peers` request issued, comps rows/stats, football bars, all four banners on *both* tabs, `peer-selection:*` warnings |
| `docs/live-gui-stage5-report.json` | AAPL + PFE run |
| `docs/live-gui-stage5-report-wmt.json` | AAPL + WMT run |
| `__tests__/live-gui/measureSizeProxyNoise.cjs` | noise of the XBRL `frames` sales ruler, on the live candidate pools |
| `docs/live-gui-stage5-size-proxy-noise.json` | AAPL + WMT + PFE noise measurement |
| `packages/valuation-creator/app/scripts/probeForecastFailure.ts` | *(added this pass)* surfaces the `buildForecast` error `useValuationModel` swallows |

**The peer set follows the target, not a table.** One `/api/peers` request per
load, and its ticker list is the screen's output every time:

| Target | SIC (major group) | Target size, `frames-sales` | Pool → tickered → sized | `/api/peers?tickers=` | Rendered in comps |
| --- | --- | --- | --- | --- | --- |
| **AAPL** Apple Inc. | 3571 Electronic Computers (35) | 416.2 B | 113 → 8 → 7 | `DELL,XNDU` | Dell Technologies Inc. |
| **WMT** Walmart Inc. | 5331 Retail-Variety Stores (53) | 713.2 B | 94 → 10 → 8 | `COST,TGT,MNSO,MSOGF` | Costco, Target |
| **PFE** Pfizer Inc. | 2834 Pharmaceutical Preparations (28) | 62.6 B | 500 → 164 → 78 | `ABBV,BMY,CELG-RI,ABT,AARD,ABVX` | *(see the PFE gap below)* |

**WMT is the clean end-to-end case** (`docs/live-gui-stage5-report-wmt.json`,
price 112.07): the comps table rendered **COSTCO WHOLESALE CORP /NEW** (949.15,
P/E LTM 51.97x, P/B 14.43x, EV/EBITDA 32.12x) and **TARGET CORPORATION** (147.08,
18.03x, 4.13x, 8.62x), and those two peers drive the football field — LTM
EV/EBITDA 28.85–116.93, LTM P/B 51.73–180.67, NTM EV/EBITDA 108.52–399.38,
alongside DCF GG 121.17–373.55, DCF exit 58.56–110.10, DDM 41.26–121.37. `MNSO`
and `MSOGF` were skipped (`no annual periods were reported`), never zeroed. No
`NaN` in the DOM, no console errors, no page errors, in either run.

**Banner state is correct on the comps *and* football-field tabs for every
target**, including PFE: full-placeholder banner **absent**;
`DYNAMIC_PEER_SELECTION` shown and naming the basis it actually settled on;
`PARTIAL_PEER_DATA` shown with the honest count (1 of 2 for AAPL, 2 of 4 for WMT,
3 of 6 for PFE); `PEER_BETA_PLACEHOLDER` shown, as in every state.

**Algorithm parameters actually in force** (`packages/peer-selection/src/`,
unmodified defaults — the app passes no `PeerSelectionOptions`):

- `MIN_PEERS = 4`, `TARGET_PEERS = 6`, `MAX_PEERS = 8`
  (`server.js` caps a request at `MAX_PEER_TICKERS = 12`, `PEER_CONCURRENCY = 4`).
- Ladder `SIZE_LADDER`, stopping at the first rung with `MIN_PEERS` **sized,
  in-band** candidates, else the last rung: exact ×3.16 → exact ×5 →
  major-group ×3.16 → major-group ×5 → major-group ×10. Unsized candidates never
  count toward the stop condition; they backfill afterwards, only up to
  `TARGET_PEERS`, each with its own `peer-selection:size-basis-unknown:<T>` key.
- Ranking (`rank.ts`), applied in order: exact SIC before major group → smaller
  `|log10(size/targetSize)|` → size basis matching the target's before `unknown`
  → ≥ `MIN_COMPLETE_ANNUAL_PERIODS = 5` annual periods (pre-fetch: "sized" stands
  in) → ticker ascending. Deterministic, no clock, no randomness.
- Ruler: XBRL `frames/us-gaap/{Revenues, RevenueFromContractWithCustomerExcludingAssessedTax}/USD/{CY2025, CY2024}`,
  first hit wins, newest frame and `Revenues` first; target falls back to
  `canonical-sales` and then to no size screen at all. Pool: `browse-edgar`
  `SIC=` exact match, ≤ 5 pages × 100.

Which rung each target settled on, and why — the in-band counts come from the
noise report's `bandFlips`, so the ladder's behaviour is reproducible from data
rather than asserted:

| Target | sized in-band at ×3.16 / ×5 / ×10 | Settled rung | Peers returned |
| --- | --- | --- | --- |
| AAPL | 0 / 1 / 1 | last rung (major group 35, ×10) | DELL + XNDU (unsized backfill) |
| WMT | 1 / 1 / 2 | last rung (major group 53, ×10) | COST, TGT + MNSO, MSOGF (unsized backfill) |
| PFE | **4** / 4 / 5 | **rung 1** (exact SIC 2834, ×3.16) | ABBV, BMY, CELG-RI, ABT + AARD, ABVX (unsized backfill) |

PFE is the one target here whose exact-SIC pool is rich enough to satisfy
`MIN_PEERS` at the default window, which is exactly the outcome the ladder is
for: mega-caps in thin 4-digit codes (AAPL, WMT) fall through to the widest rung
and say so in the banner, rather than being padded.

**Measured size-proxy noise** (`docs/live-gui-stage5-size-proxy-noise.json`,
2026-08-07, live SEC). Frame coverage that day: `Revenues` CY2025 2 087 CIKs /
CY2024 2 347; `RevenueFromContractWithCustomerExcludingAssessedTax` CY2025 2 634
/ CY2024 2 917. All spreads are `|log10(a/b)|`, so 0.5 ≈ ×3.16 — one full
window edge.

| Metric | AAPL pool | WMT pool | PFE pool |
| --- | --- | --- | --- |
| Candidates sized / total (coverage) | 7 / 8 (87.5 %) | 8 / 10 (80.0 %) | 78 / 164 (**47.6 %**) |
| Concept spread (same filer, same frame, both revenue tags) | n = 0 | n = 4, median **0.0003** (≈ 0.07 %), max 0.0004 | n = 10, median 0, p90 **0.845**, max 0.874 |
| Vintage spread (same tag, CY2025 vs CY2024) | n = 7, median **0.118**, max 0.166 | n = 10, median **0.034**, max 0.090 | n = 64, median **0.179**, p90 0.874, max **2.368** |
| Candidates sized on a different frame than the target | 0 of 7 | 0 of 8 | **8 of 78** |
| Target `frames-sales` vs `canonical-sales` | 0.000 | −0.004 | 0.000 |
| **Candidates that change side of a window edge under the alternative reading (×3.16 / ×5 / ×10)** | **0 / 0 / 0** | **0 / 0 / 0** | **0 / 0 / 0** |

The decision-relevant answer is the last row: across all three pools and all
three windows, **not one candidate flips in or out of the band** when the other
available reading is used, even though the PFE pool's year-over-year spread
reaches 2.37 decades. The reason is visible in the AAPL pool's own log-ratios
(`−0.56` Dell, `−1.28` SMCI/SMCIP, `−2.55` Omnicell, `−3.21` Zepp, `−4.11` OSS,
`−4.44` Socket Mobile): within-industry size dispersion is one to four decades
wide, an order of magnitude larger than the ≤ 0.18-decade median reading noise,
so the noise is not what decides membership. What *does* decide it is
**coverage** — 52 % of PFE's candidates carry no frames reading at all and can
only enter as unsized backfill, and the two mega-cap targets are excluded from
their own default window by real size distance, not by measurement error.

**One gap found, and it is not in the screen: PFE renders no comps or football
field at all.** The dynamic screen, the `/api/peers` fetch and all four banners
are correct for PFE, but the Valuations tab shows "Forecast unavailable for the
current assumptions; DCF/DDM cannot be computed" / "Comps unavailable", and the
football table never mounts. `useValuationModel` swallows the cause
(`try { buildForecast(...) } catch { return null }`); the new
`scripts/probeForecastFailure.ts` surfaces it:

```
PFE  buildForecast THREW: payoutRatio must be in [0, 1], got 1.2208887719397592
       at buildNetIncomeForecast (core/src/forecast.ts:940)
```

Pfizer's live FY2025 dividends exceed its net income, so the derived payout
ratio is 1.22 and `buildNetIncomeForecast`'s guard rejects it. This is a
**target-side** forecast-input guard, entirely independent of peer selection —
the same probe over a wider sample shows it is not a one-off: `KO` fails on
`interestRateOnDebt must be a finite number, got Infinity` (no debt reported)
and `XOM` on `inventoryDaysOfCogs must be a finite number, got NaN`, while
`AAPL`, `WMT`, `CAT` and `MSFT` build cleanly. A payout ratio above 1 is
ordinary corporate behaviour, so this guard will keep taking whole valuation
views down for real companies; fixing it means deciding the modelling semantics
(clamp, carry the excess as a return of capital, or degrade only the DDM), which
is a core-forecast change and deliberately **not** made inside this
verification pass.

Also unchanged and still cosmetic: `FootballFieldView` hardcodes the `S$`
symbol, so USD targets render as `S$312.41` (AAPL) and `S$112.07` (WMT).

---

## Deferred / explicitly out of scope for Stages 1–5

- Real 5-year regression beta (needs a new price-history adapter + new
  canonical field + regression math — a separate future work package)
- Hosting (Render) + DB caching (Supabase) — layers in naturally after
  Stage 2 once there's something live worth caching/deploying; not a
  prerequisite for proving out functionality
