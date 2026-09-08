# Fin-Telligence

**Financial answers you can audit. The model writes SQL, the database produces the numbers, and every figure in the answer is verified against the data before you see it.**

[![Prototype](https://img.shields.io/badge/prototype-live-brightgreen.svg)](https://fin-telligence.netlify.app/)
[![Core tests](https://img.shields.io/badge/core-88%20tests%2C%20offline-blue.svg)](fintelligence-core/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

The premise is simple: a language model is excellent at turning a question into SQL, and terrible at being trusted with the arithmetic. So it is never trusted with the arithmetic. The model writes a query, a read-only database returns the rows, and a verifier checks that every number in the prose actually came from those rows. What you get back is either a grounded answer with a full provenance trail, or an explicit refusal. Never an unverified paragraph presented as fact.

```
question
   ├─ plan      model writes SQL, having never seen a row of data
   ├─ guard     parsed, SELECT-only, allow-listed, LIMIT enforced   ← refuses here
   ├─ execute   read-only connection                                ← refuses here
   ├─ narrate   prose written, then every number checked against the rows
   ├─ lineage   SQL + tables + columns + row count + result hash
   └─ audit     appended to a hash-chained log
```

## What's in this repo

| Path | What it is |
|------|-----------|
| [`fintelligence-core/`](fintelligence-core/) | **The working engine.** A Node.js CLI and library that implements the full pipeline above: guard, read-only warehouse, grounding verifier, lineage capture, and a tamper-evident audit chain. 88 tests, no API credential required to run most of them. |
| [`fintelligence/`](fintelligence/) | **The prototype site** deployed at [fin-telligence.netlify.app](https://fin-telligence.netlify.app/). It argues for the thesis; the core repository does it. |

The prototype makes the case. The core makes it executable. Start with the [`fintelligence-core/` README](fintelligence-core/README.md) for the full technical account.

## The four guarantees, and what enforces each

A claim is only worth what enforces it. Each guarantee is backed by a mechanism and a test that would fail if it broke, not by a promise.

| Guarantee | Enforced by |
|-----------|-------------|
| The model cannot write to the database | A connection opened `readOnly: true`; SQLite refuses writes below anything the code can reach |
| Only SELECT, only allow-listed tables, always bounded | `guard.js` parses SQL to an AST and inspects the full table list, including subqueries and CTE bodies |
| Every figure in the prose came from the data | `grounding.js` extracts each number and matches it to a returned value, allowing only legitimate transforms (cents to currency, ratio to percent) |
| A past answer cannot be altered unnoticed | `audit.js` hash-chains each entry to the one before it; `verify()` reports the first index where the chain breaks |

## Quick start

```bash
cd fintelligence-core
npm install
npm run seed                      # build the demo warehouse
npm test                          # 88 tests, no credential required

export ANTHROPIC_API_KEY=...      # only planning and narration call a model
node bin/fintel.js ask "How has MRR trended over the period?"
node bin/fintel.js audit
```

The guard, the warehouse, the lineage record, and the audit chain all run with no credential. Only the plan and narrate steps call the model.

## What is real, and what is not

In keeping with the project's own discipline about claims:

- **Real:** the guard, read-only enforcement, the SQLite warehouse, lineage capture and hashing, the audit chain, grounding verification, the CLI, and the offline test suite.
- **Synthetic:** the data. Customers over six months, generated deterministically from a fixed seed so the same question always produces the same result hash. The numbers are invented, internally consistent, and describe no real company. For a tool about traceable figures, fabricated data clearly labelled as fabricated is fine; fabricated data presented as real is the exact failure this project exists to prevent.
- **Not a compliance claim:** the audit entries carry `SOX` and `GDPR: no PII` tags because the query path is read-only over a schema with no personal data. That is a true statement about this configuration, not a certification. SOC 2, SOX, and GDPR are properties of organizations and processes, not of software. What this produces is evidence: a query, its provenance, a reproducible hash of its result, and a chain showing the record has not been edited since.

## Requirements

Node 22+ (`node:sqlite` is built in, so there is no native database dependency to compile). Planning and narration call a large language model; the API key is read from the environment (see the quick start).

## License

MIT. See [LICENSE](LICENSE).
