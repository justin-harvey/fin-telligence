# fintelligence-core

A working implementation of the Fin-Telligence thesis: **the model writes SQL,
the database produces the numbers, and every figure in the answer is verified
against the data before you see it.**

The [prototype](https://fin-telligence.netlify.app/) argues for this. This
repository does it. Everything below is executable.

```
question
   ├─ plan      model writes SQL, having never seen a row of data
   ├─ guard     parsed, SELECT-only, allow-listed, LIMIT enforced   ← refuses here
   ├─ execute   read-only connection                                ← refuses here
   ├─ narrate   prose written, then every number checked against the rows
   ├─ lineage   SQL + tables + columns + row count + result hash
   └─ audit     appended to a hash-chained log
```

## Quick start

```bash
npm install
npm run seed                      # build the demo warehouse
npm test                          # 117 tests, no credential required

export ANTHROPIC_API_KEY=...      # or: ant auth login
node bin/fintel.js ask "How has MRR trended over the period?"
node bin/fintel.js audit
node bin/fintel.js audit --export audit-package.json

# run SOC 2 controls, or serve the whole engine over MCP (stdio)
node bin/fintel.js controls run PI1.2-enron-debt-reconciliation --export packet.json
node bin/fintel.js mcp
```

The guard, the database, the lineage record, and the audit chain all work with
no credential. Only planning and narration call a model:

```bash
node bin/fintel.js explain "SELECT name FROM sqlite_master"
# REJECTED
#   reason : table_not_allowed
```

## The four guarantees, and what enforces each

A claim is only worth what enforces it. Each row names the mechanism and the
test that would fail if it broke.

| Guarantee | Enforced by | Not by |
|---|---|---|
| The model cannot write to the database | A connection opened `readOnly: true`; SQLite refuses below anything this code can reach | Asking the model not to |
| Only SELECT, only four tables, always bounded | `src/guard.js` — parses to an AST and inspects it | A `/^SELECT/i` regex |
| Every figure in the prose came from the data | `src/grounding.js` — extracts each number and matches it to a returned value | The model's good intentions |
| A past answer cannot be altered unnoticed | `src/audit.js` — each entry hashes the one before it | An append-only convention |

### The guard parses, it does not pattern-match

`SELECT 1 FROM customers; DROP TABLE customers` passes a `/^\s*SELECT/i` test.
So does a CTE wrapping a DELETE, and a subquery reaching `sqlite_master`. The
guard builds an AST, walks the statement's full table list — including
subqueries and CTE bodies — and rejects anything unparseable rather than
assuming it is probably fine.

It also has to *not* over-reject: the parser reports CTE aliases alongside real
tables, so a naive allow-list rejects `WITH monthly AS (...) SELECT * FROM
monthly`, which is most real analytics SQL. A guard that blocks legitimate work
gets switched off, so that case has its own test.

### Grounding is what makes the headline claim testable

Scoping the model to SQL generation handles most of the risk — the figures come
from the warehouse. But asking a model to *narrate* a result set reopens it: a
total it summed itself, an estimated percentage, a comparison to a period
nobody queried. That sentence reads exactly like the true ones beside it.

So narration is verified, not trusted. Every number in the prose is extracted
and matched against the values the query returned, allowing the three
transformations a writer legitimately performs:

```
identity          1.087        → "1.087"
cents → currency  32,476,072¢  → "$324,760.72"
ratio → percent   1.087        → "108.7%"
```

Tolerance is **half a unit in the last place written** — the rounding rule a
human actually follows. `36.7%` admits `[36.65, 36.75)`; `$1.2M` admits
`[1.15M, 1.25M)`. Stricter than a flat percentage for precise figures, looser
for deliberately rounded ones.

If a number has no source, the narrator is told exactly which one and asked
again. If it fails twice, the system stops asking and emits a mechanical
summary built directly from the rows. **The caller always receives a verified
answer or an explicit refusal — never an unverified paragraph presented as
fact.**

One of the grounding tests uses `$412,000` as its fabricated figure. That is
the MRR number hardcoded in the original prototype. It is not in this data, and
the checker catches it.

### The audit log is tamper-evident, not merely append-only

A file anyone can edit is a file that can be quietly edited. Each entry carries
the hash of the entry before it, and its own hash covers that link. Editing any
historical record breaks the chain from that point forward; `verify()` reports
the first index where it breaks.

The tests cover the naive tamper (edit an entry), the *informed* tamper
(recompute that entry's own hash so it is self-consistent — the break simply
moves one position along), and deletion from the middle.

They also cover the honest limitation: **truncating the newest entries leaves a
valid shorter chain.** Nothing local can prevent that, which is exactly why a
real deployment anchors the head hash somewhere it does not control. That is
what [TLaaS](https://github.com/justin-harvey/TLaaS) already does — this log is
the same construction minus the on-chain step, and the two compose directly.

## Trade-surveillance attestation

The SaaS warehouse shows the engine works. A second warehouse shows it where
the thesis matters most: capital markets, where "roughly right, trust me" is
not an answer a regulator accepts. The same guard, grounding, lineage and audit
chain are pointed at a different schema and allow-list — the boundary is
identical, only the domain changes.

```bash
node bin/fintel.js markets seed                    # orders, executions, prices, positions
node bin/fintel.js markets net-position ACME       # net position at close, pinned as-of and hashed
node bin/fintel.js markets surveillance            # flag rapid place-and-cancel accounts
node bin/fintel.js markets audit                   # verify the surveillance/position audit chain
```

Three scenarios, framed against real regimes:

| Scenario | Question | Regime it speaks to |
|----------|----------|---------------------|
| **Net position at close** | Signed position per account in a ticker, as of the close timestamp | MiFID II position reporting; reproducible from the execution ledger and reconciled against the end-of-day snapshot |
| **Rapid place-and-cancel** | Accounts that cancelled ≥ N orders within Y ms of placing them | MAR / MiFID II market-abuse surveillance (the shape spoofing and layering leave) |
| **Tamper test** | Alter a historical alert and re-verify | The audit chain reports the exact entry that changed |

Two things make these more than a report. The net-position figure is computed
*in SQL* and pinned with an as-of cutoff, so re-running it reproduces the same
result hash exactly — an auditor can recompute and compare. And every alert is
appended to the hash-chained, optionally-signed log, so a surveillance finding
cannot be quietly walked back after the fact. The data is synthetic and
deterministic; two of the six accounts are seeded to exhibit the place-and-cancel
pattern, and the surveillance query flags exactly those two.

## The Enron reporting-gap demo

The markets warehouse shows the engine catching abuse in a live order book. A
third warehouse shows it against the case the whole "a number you can put in
front of a regulator" thesis is haunted by: Enron's FY2000 10-K, where the
reported numbers and the underlying reality had famously come apart. Two
scenarios reconstruct the two mechanics of that gap, and both compute the
reported figure *and* the underlying figure in a single guarded query, so the
distance between them is a grounded, hash-chained, tamper-evident result rather
than an assertion.

```bash
node bin/fintel.js enron seed       # entities, revenue deals, debt instruments, reported line items
node bin/fintel.js enron revenue    # revenue as reported (gross) vs merchant margin (net)
node bin/fintel.js enron debt       # reported debt vs true debt incl. off-balance-sheet SPEs
node bin/fintel.js enron audit      # verify the Enron audit chain
```

| Scenario | What it shows | The real anchor |
|----------|---------------|-----------------|
| **Revenue basis** | Revenue booked *gross* (full trade notional) versus the *net* merchant margin actually earned | Gross reconciles to the reported **$100,789m** total revenues; net margin is **$1,953m** — the gross-basis booking is what turned $40bn into $100bn |
| **Hidden debt** | Debt on the reported balance sheet versus the true total once the SPEs are included | Reported reconciles to the **$10,229m** short + long-term debt on the 10-K; the SPE vehicles (JEDI, Chewco, LJM1/2, Raptor, Whitewing) add the leverage that stayed off it |
| **Tamper test** | Alter a recorded attestation and re-verify | The audit chain reports the exact entry that changed |

The distinction that matters here is the one the rest of the project turns on.
**The aggregates are real:** they reconcile to Enron's actual reported figures,
transcribed verbatim from the filing (SEC accession `0001024401-01-500010`) into
`db/enron-anchor.md` and stored in a `reported_financials` table that carries the
citation on every row. **The transaction-level rows are synthetic** — there is no
public Enron general ledger — and the off-balance-sheet SPE amounts are
illustrative of the mechanism, not a claimed exact historical total. Real anchor
figures are labelled real; fabricated rows are labelled fabricated. That
labelling is not incidental to the demo; it *is* the demo. (Money here is integer
USD millions, the grain a 10-K prints, so a computed figure grounds against the
filing verbatim — a deliberate departure from the other warehouses' integer
cents, documented in `db/enron-schema.sql`.)

## What is real here, and what is not

**Real:** the guard (table *and* column allow-lists, a wall-clock query budget,
a row-level scope hook driven by an authenticated principal), read-only
enforcement behind a warehouse-connector interface (SQLite reference adapter),
three SQLite warehouses (SaaS finance, capital markets, and a synthetic Enron
reporting-gap POC whose aggregates reconcile to real 10-K figures), a first-class
metric registry the scenarios resolve against, lineage capture and hashing, the
hash-chained audit log with Ed25519 signing and a pluggable external-anchoring
hook, grounding verification (unit-aware, and able to check derived figures the
query returns), a control-result shape and an offline-verifiable evidence packet
(intent → SQL → CSV → hash + signature, `fintel enron … --export`), a SOC 2
control catalog whose entries assert PASS/EXCEPTION and emit that packet
(`fintel controls run …`; three reconciliation controls across the SaaS and
Enron warehouses), an MCP server that exposes the controls, canonical queries and
audit verification as tools and each warehouse's live schema as a resource
(`fintel mcp`, stdio), the CLI, and 117 tests that run offline.

**Synthetic:** the data. 416 customers over six months, generated
deterministically from a fixed seed so that the same question always produces
the same result hash — reproducibility is the point of publishing a hash.
The numbers are invented and internally consistent; they describe no real
company. For a tool about traceable figures, fabricated data clearly labelled
as fabricated is fine. Fabricated data presented as real is the exact failure
this project exists to prevent.

**Reference implementations, real but not production-grade:** authentication and
row-level security resolve a token to a principal and confine that principal to
its book via the guard's scope hook — the mechanism is enforced and tested, but
the token registry is an in-memory demo, not an IdP. The warehouse connector is
a live interface with a working SQLite adapter and a Snowflake adapter *shape*
(no network integration ships). The metric registry is first-class and the
scenarios resolve against it. The external anchor is a real interface with a
local stub.

**Not built:** a real IdP behind the auth layer, a live cloud-warehouse adapter,
PII detection for the GDPR annotation, a production external anchor, and any UI.
The audit entries carry `SOX` and `GDPR: no PII` tags because the query path is
read-only over a schema with no personal data — that is a true statement about
*this* configuration, not a compliance claim.

## On compliance vocabulary

The tags describe what the log contains. They are not certifications.

SOC 2, SOX, and GDPR are not properties software can hold. SOC 2 in particular
is an attestation a licensed CPA firm issues about an *organization's* controls
against the AICPA Trust Services Criteria. A tool can produce evidence that
supports an audit; it cannot be the audit. Anything stronger than that is a
claim the first person in the room who has sat through one will correctly
disbelieve.

What this produces is evidence: a query, its provenance, a reproducible hash of
its result, and a chain that shows the record has not been edited since.

## Layout

```
db/schema.sql          SaaS warehouse: four tables; money in integer cents
db/markets-schema.sql  markets warehouse: accounts, orders, executions, prices, positions
db/enron-schema.sql    Enron POC warehouse: entities, revenue, debt, reported financials (USD millions)
db/enron-anchor.md     Enron's real reported figures, cited to the 10-K (the aggregate anchor)
src/db.js              read-only connection, deterministic seed, wall-clock query budget
src/guard.js           the security boundary (table + column allow-lists, scope/as-of hooks)
src/planner.js         question → SQL (structured output, Claude Opus 4.8)
src/narrator.js        rows → prose, with grounded retry and safe fallback
src/grounding.js       unit-aware numeric verification
src/lineage.js         canonical serialisation + result hashing
src/audit.js           hash-chained log + export package
src/signing.js         Ed25519 result signing (keys from the environment)
src/anchor.js          pluggable external-anchoring hook + local stub
src/warehouse.js       connector interface: SQLite adapter + Snowflake shape
src/registry.js        first-class metric / semantic registry
src/auth.js            authentication + per-principal row-level security
src/markets.js         capital-markets warehouse, metric layer, surveillance scenarios
src/enron.js           Enron POC warehouse, reporting-gap scenarios (real anchors, synthetic rows)
src/saas.js            canonical credential-free SaaS queries (e.g. the MRR reconciliation)
src/evidence.js        control-result shape + verifiable evidence packet (intent→SQL→CSV→hash+sig)
src/controls.js        the SOC 2 control catalog (queries that assert PASS/EXCEPTION)
src/warehouses.js      warehouse descriptors + live PRAGMA schema (allow-list filtered)
src/mcp.js             MCP tools + resources (pure, transport-free)
src/mcp-server.js      the stdio MCP transport (the only file that imports the SDK)
src/ask.js             the pipeline
bin/fintel.js          CLI
test/                  117 tests, none requiring a credential
```

Requires Node 22+ (`node:sqlite` is built in, so there is no native database
dependency to compile).
