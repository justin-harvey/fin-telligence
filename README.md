# Fin-Telligence

**A proposal, and enough working code to tell whether the proposal is sound.**

The claim: when a finance team asks a question in English and a model answers,
the answer should arrive with the SQL that produced it, and no figure should
reach the reader unless it came back from the warehouse. Not "the model is
usually right" — *this number is that cell in that result set, and here is the
hash to prove it.*

This repository is that argument in two parts: a prototype that shows what it
would look like, and a working core that establishes it can actually be built.
Neither is a product. The point of each is to make the direction concrete
enough to evaluate.

| | What it is | Runs? |
|---|---|---|
| [`prototype/`](prototype/) | The interface, so the shape of the thing is legible. Every figure in it is **hardcoded**. | Renders. Computes nothing. |
| [`fintelligence-core/`](fintelligence-core/) | The mechanism, built and under test. | Yes — 49 tests offline, 57 against a live PostgreSQL. |

## The problem it addresses

A finance team gets an answer from an analytics tool. The number looks right.
"Looks right" is not enough to put in a board deck, and it is nowhere near
enough for a regulated filing — because when someone asks *where did that come
from*, the honest answer is usually a shrug and a re-run.

Text-to-SQL tools make this worse rather than better. The model produces a
figure; nothing establishes the figure came from the data rather than from the
model. The failure is silent, it looks exactly like success, and it scales.

## The mechanism

Four guarantees, each with the thing that enforces it. A claim is worth what
enforces it, so the third column is the point of the table.

| Guarantee | Enforced by | Not by |
|---|---|---|
| The model cannot write to the warehouse | A connection proven read-only *before the model is called*, checked against the catalog and with a real write attempt in a rolled-back transaction | Trusting the connection string |
| Only bounded reads of known tables | An AST parse, dialect-aware, rejecting anything unparseable | A `/^SELECT/i` regex |
| Every figure in the prose came from the data | Each number extracted and matched back to a returned value before the answer is shown | The model's good intentions |
| A past answer cannot be altered unnoticed | Each audit entry hashes the one before it | An append-only convention |

The same question against the same data produces the **same lineage hash on
SQLite and on PostgreSQL** — a test asserts it. Provenance that changed when you
changed warehouse would not be provenance.

## What is proven, and what is assumed

The distinction matters more than either list.

**Proven — running code, under test:**

- The read-only proof fails correctly when handed a writable credential. There
  is a test that points it at a deliberately writable role to confirm the check
  can fail; a safety check that cannot fail is not a safety check.
- The guard refuses writes, unlisted tables, multi-statement injection, and
  data-modifying CTEs, under two SQL dialects.
- Grounding catches fabricated figures, including plausible ones.
- The audit chain detects tampering with any prior entry.
- Two different warehouses agree on the hash.

**Assumed — not yet demonstrated:**

- That metric definitions can be mapped to a customer's schema without a
  bespoke engagement per customer. This is the largest unknown and the one that
  decides whether this is a product or a consulting practice.
- That grounding holds up on derived figures — ratios, period-over-period
  deltas, currency rounding — not just values read straight from a cell.
- That the latency and model cost per question are acceptable when a grounding
  failure triggers a retry.
- Anything about BigQuery, Snowflake or Databricks. The adapter interface is
  shaped for them. None has been run.

## What it would take to build for real

Scoped honestly, in dependency order, for someone deciding whether to fund it:

1. **A serving layer.** `ask()` is a library call today. It needs HTTP,
   streaming, cancellation and timeouts, and the model credential has to live
   server-side — it cannot be in the browser.
2. **Authentication and per-user authorization.** There is none. Row scoping by
   tenant has to reach into the generated SQL itself, not sit in front of it,
   or the guard is checking the wrong thing.
3. **A semantic layer.** The allow-list is four hardcoded tables. Real
   deployment needs metric definitions mapped onto the customer's warehouse.
   This is the item above that is assumed rather than proven, and it is the
   long pole.
4. **Per-warehouse connectors.** The PostgreSQL work established the pattern —
   dialect-aware parsing, a read-only proof, and type parity so hashes agree.
   Each new warehouse is roughly that same shape and cost, and none of it is
   free.
5. **Durable audit storage.** The chain is a local JSONL file. Production needs
   real storage, a retention policy, and a chain that survives concurrent
   writers.

The open question I would want answered before anything else: **when grounding
fails, what should happen?** Today the system falls back to a mechanical
summary rather than showing an unverified sentence. Whether a regulated buyer
finds that acceptable — or wants a hard refusal — changes the product.

## Running it

```bash
cd fintelligence-core
npm install
npm run seed     # deterministic synthetic warehouse
npm test         # 49 passing, 8 skipped, no API key needed
```

The guard, the read-only boundary, the lineage record and the audit chain all
run offline; only planning and narration call a model. The 8 skipped tests need
a live PostgreSQL — configured, the suite is 57 passing, 0 skipped.

```bash
node bin/fintel.js explain "SELECT name FROM sqlite_master"
# REJECTED
#   reason : table_not_allowed

node bin/fintel.js warehouse    # prints the read-only evidence, check by check
```

[`fintelligence-core/README.md`](fintelligence-core/README.md) has the design
detail, and the five bugs that only surfaced by running it against a live
server rather than reading it.

## About the prototype

`prototype/` is the Vite build output — the compiled bundle, not its source, so
it can be served but not modified here. It was originally built as a product
thesis for a WisdomAI PM application, which its "About this prototype" panel
states.

Its numbers are hardcoded, and it displays a connected Stripe account with a
live badge that is wired to nothing. That is fine for what it is — a mockup of
an interface, presented as one — and it is stated here so that nobody has to
discover it.

## Known gaps

Recorded here rather than in a document claiming they were fixed:

- The prototype's copy calls the audit log "SOX-ready" and "GDPR-annotated".
  SOX and GDPR are obligations attaching to organizations and their processes,
  not properties software can hold. The defensible claim is the narrower one
  the core implements: a hash-chained, exportable record of every query, what
  it touched, and what it returned. To be corrected when the prototype's source
  is available.
- The prototype's "95%+ metric accuracy vs Stripe dashboard" is a target. No
  measurement against a Stripe dashboard has been taken.
- The two halves are not connected. Wiring them is item 1 above.
