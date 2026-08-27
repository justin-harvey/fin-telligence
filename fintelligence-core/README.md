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
npm test                          # 49 pass, 8 skip — no credential required

export ANTHROPIC_API_KEY=...      # or: ant auth login
node bin/fintel.js ask "How has MRR trended over the period?"
node bin/fintel.js audit
node bin/fintel.js audit --export audit-package.json
```

The guard, the database, the lineage record, and the audit chain all work with
no credential. Only planning and narration call a model:

```bash
node bin/fintel.js explain "SELECT name FROM sqlite_master"
# REJECTED
#   reason : table_not_allowed
```

The 8 skipped tests need a live PostgreSQL. With one configured the suite is
57 passing, 0 skipped — see [Running against PostgreSQL](#running-against-postgresql).

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

## What is real here, and what is not

**Real:** the guard, the read-only enforcement, the SQLite warehouse, lineage
capture and hashing, the audit chain, grounding verification, the CLI, and 43
tests that run offline.

**Synthetic:** the data. 416 customers over six months, generated
deterministically from a fixed seed so that the same question always produces
the same result hash — reproducibility is the point of publishing a hash.
The numbers are invented and internally consistent; they describe no real
company. For a tool about traceable figures, fabricated data clearly labelled
as fabricated is fine. Fabricated data presented as real is the exact failure
this project exists to prevent.

**Not built:** authentication and per-user authorization, a real warehouse
connector (BigQuery/Snowflake), the pre-built metric fabric mapped to
Stripe/NetSuite schema, PII detection for the GDPR annotation, and any UI. The
audit entries carry `SOX` and `GDPR: no PII` tags because the query path is
read-only over a schema with no personal data — that is a true statement about
*this* configuration, not a compliance claim.

## Running against PostgreSQL

SQLite is the demo. The same pipeline runs against a networked warehouse, and
the point of supporting a second one is that the guarantees have to survive the
move — a lineage hash that changes when you change database is not a lineage
hash.

```bash
# 1. mirror the demo data into Postgres (refuses if the database holds
#    tables it did not create — it runs DROP TABLE)
export FINTEL_ADMIN_DATABASE_URL=postgres://admin:...@host:5432/fintel
node bin/fintel.js mirror-postgres

# 2. provision the read-only role (password is a psql variable, not a file)
psql -d fintel -v reader_password="'...'" -f db/postgres/readonly-role.sql

# 3. point the pipeline at it and prove the credential cannot write
export DATABASE_URL=postgres://fintel_reader:...@host:5432/fintel
node bin/fintel.js warehouse
```

`fintel warehouse` prints the evidence rather than an assurance:

```
READ-ONLY
  dialect   : postgresql
  connection: postgres://fintel_reader:***@localhost:5432/fintel
  [pass] not_superuser
  [pass] no_schema_create
  [pass] no_write_privilege:customers
  ...
  [pass] write_probe
         permission denied for table customers
```

`ask()` runs this before it plans anything and refuses at the `verify` stage on
a writable connection — before the model is called at all.

### What running it against a live server actually surfaced

None of these are visible by reading the code. Each has a regression test.

**The read-only check has to be able to fail.** A check that consults only the
catalog passes trivially for a superuser, because superusers bypass privilege
checks and `has_table_privilege` returns true for everything. So there are two
independent checks — what the catalog says, and an actual `INSERT` inside a
transaction that is always rolled back — and a test that points the whole thing
at a deliberately writable role to confirm it reports `false`. A safety check
that cannot fail is not a safety check.

**Registering the `int8` type parser is not enough.** `pg` returns `BIGINT` and
`NUMERIC` as strings, correctly: both hold values float64 cannot represent.
But the lineage hash is taken over the rows, so SQLite's `3585700` and
Postgres's `"3585700"` hash differently and the same question against the same
data yields two different provenance records. The trap is that `SUM()` over a
`BIGINT` column returns `NUMERIC`, not `BIGINT` — the sum of a money column is
the single most likely thing an analytics query selects, so the type left
unhandled is the one that matters most. Both are parsed, under a rule that
converts only when the text round-trips through `Number` exactly; anything
else stays a string rather than becoming a value that is quietly off by one.

**The mirror's safety check failed open.** It refuses to touch a database
holding tables it did not create, because it runs `DROP TABLE`. Reading
`information_schema.tables` to find them is wrong in the worst direction: the
standard defines it to show only objects the current role holds a privilege on,
so pointing it at a database full of another team's tables, with a role that
has no rights to them, returns *zero rows*. The check concluded the database was
empty and cleared the way to drop things — it was at its most permissive
exactly when it knew least. It now reads `pg_catalog`, which is not
privilege-filtered.

**Grants attach to objects, not names.** The mirror drops and recreates every
table, so each run produces new objects that happen to share a name — silently
revoking the reader's `SELECT`. The symptom appears much later as `permission
denied for table customers`, which reads like a broken adapter or a bad
password rather than two setup steps run in the wrong order. The mirror
re-grants, so the steps commute. This one bit the test suite itself: re-running
the mirror stripped the writable fixture role of its grants, and the negative
tests started passing for the wrong reason — they saw a role that could not
write and concluded the read-only check worked. Each test now establishes its
own precondition.

**`DROP ROLE IF EXISTS` does not belong in a provisioning script.** Roles are
cluster-wide, so the drop fails if the role holds a privilege in any other
database — and `psql` without `ON_ERROR_STOP` keeps going. Every later
statement then applies to a role still carrying its old password and old
grants, and the script reports success. The script creates if absent and
`ALTER`s, and sets `ON_ERROR_STOP`.

### Not built

The BigQuery and Snowflake adapters do not exist. The adapter interface is
shaped so they could be added, which is not the same thing as having added
them, and this section will say so until one has been run against a live
warehouse.

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
db/schema.sql        four tables; money in integer cents, never floats
src/db.js            read-only connection + deterministic seed
src/guard.js         the security boundary
src/planner.js       question → SQL (structured output, Claude Opus 5)
src/narrator.js      rows → prose, with grounded retry and safe fallback
src/grounding.js     numeric verification
src/lineage.js       canonical serialisation + result hashing
src/audit.js         hash-chained log + export package
src/ask.js           the pipeline
bin/fintel.js        CLI
test/                43 tests, none requiring a credential
```

Requires Node 22+ (`node:sqlite` is built in, so there is no native database
dependency to compile).
