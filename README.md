# Fin-Telligence

A product thesis about traceable numbers, and a working implementation of it.

This repository holds two things, and it is worth being precise about which is
which, because they are not the same kind of artifact:

| | What it is | Does it run? |
|---|---|---|
| [`prototype/`](prototype/) | A design prototype of the product. Every figure in it is **hardcoded**. There is no database and no model behind it. | Renders. Computes nothing. |
| [`fintelligence-core/`](fintelligence-core/) | An implementation of the thesis the prototype argues for. | Yes — 43 tests, no credential required. |

The prototype makes a claim: that an answer about your revenue should arrive
with the SQL that produced it, and that no figure should reach you unless it
came back from the warehouse. `fintelligence-core` is that claim, built and
under test.

## The working part

```bash
cd fintelligence-core
npm install
npm run seed     # deterministic synthetic warehouse
npm test         # 43 passing, no API key needed
```

The guard, the read-only database boundary, the lineage record and the audit
chain all run offline. Only planning and narration call a model.

```bash
node bin/fintel.js explain "SELECT name FROM sqlite_master"
# REJECTED
#   reason : table_not_allowed
```

See [`fintelligence-core/README.md`](fintelligence-core/README.md) for what
enforces each guarantee and the test that fails if it breaks.

## The prototype

`prototype/` is the Vite build output of the design prototype — the compiled
bundle, not its source. Two consequences worth stating plainly rather than
letting a reader discover them:

- **The numbers are hardcoded.** The interface displays a connected Stripe
  account, a live badge and a customer count. None of it is wired to anything.
  It is a mockup of an interface, presented as one.
- **The source is not in this repository.** What is committed is 634 KB of
  minified JavaScript. It cannot be modified here, only served.

The prototype was originally built as a product thesis for a WisdomAI PM
application, which its "About this prototype" panel states.

## Known gaps

Kept here rather than in a document that claims they were fixed:

- The prototype's copy describes the audit log as "SOX-ready" and
  "GDPR-annotated". SOX and GDPR are obligations that attach to organizations
  and their processes, not properties a piece of software can hold. The
  defensible claim is the narrower one `fintelligence-core` actually
  implements: a hash-chained, exportable record of every query, what it
  touched, and what it returned. The copy should be corrected when the
  prototype's source is available to edit.
- The prototype's "95%+ metric accuracy vs Stripe dashboard" is a target, not
  a measurement. Nothing has been measured against a Stripe dashboard.
- `fintelligence-core` has no authentication, no per-user authorization and no
  UI. It is a core, not a product.
- The two halves are not connected. Wiring the prototype's interface to
  `ask()` needs an HTTP layer, and the API key cannot live in the browser.
