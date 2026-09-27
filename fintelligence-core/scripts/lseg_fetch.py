#!/usr/bin/env python3
"""
LSEG fetch bridge — the Python side of RealLsegSession (src/lseg-ingest.js).

Fin-Telligence's engine is Node; LSEG data is retrieved with the Python
`lseg-data` library against a running LSEG Workspace session. This script is the
thin bridge between them: RealLsegSession spawns it, hands it a JSON request on
stdin, and reads wide rows back on stdout — the exact shape the ingest seam
consumes. Swapping the synthetic FakeLsegSession for RealLsegSession + a valid
credential is then the only change needed to attest real LSEG data.

Request  (stdin, JSON):
  { "universe": ["IBM.N"], "fields": ["TR.Revenue", ...],
    "period": "FY2023", "appKey": "<optional>", "parameters": { ... },
    "mode": "data" | "history",       # default "data"
    "interval": "daily",              # history only (daily/weekly/monthly/...)
    "start": "2024-01-01",            # history only (SDate)
    "end":   "2024-03-31",            # history only (EDate)
    "chunkSize": 100,                 # split a large universe into batches
    "maxRetries": 3, "backoff": 0.5   # transport retry policy (seconds, doubling)
  }

Response (stdout, JSON):
  data mode:    { "rows": [ { "Instrument": "IBM.N", "period": "FY2023",
                              "TR.Revenue": 61860000000, ... } ] }
  history mode: { "rows": [ { "Instrument": "IBM.N", "date": "2024-03-28",
                              "TR.PriceClose": 22050, ... } ] }
  on failure:   { "error": "...", "kind": "permission_denied" | "not_found" |
                  "transport" | "bad_request" | "dependency" | "unknown" }
                with a non-zero exit code.

The `kind` lets the Node side branch: an entitlement gap (permission_denied) is a
provisioning problem, an unknown field/instrument (not_found) is a request bug,
and transport is retryable — the bridge already retries transport within a call.

Prerequisites (only for real data — the demo never runs this):
  - pip install lseg-data
  - a running LSEG Workspace / Eikon session, or a Data Platform app key with an
    entitlement covering the requested fields
  - the app key via (in order) request.appKey, --app-key, or $LSEG_APP_KEY;
    absent that, the library's own config file (lseg-data.config.json) is used.

Fundamentals are pulled with get_data (a value per period); pricing is a time
series and is pulled with get_history at its own grain (SDate/EDate/interval) —
see finding #6 in LSEG-ARCHITECTURE-REVIEW.md. The exact call shape should be
confirmed with lseg-mcp's `draft_api_call` / `get_package_signature` for your
installed lseg-data version; this bridge is not exercised against a live session
here (the tests run the deterministic FakeLsegSession), so treat the mapping as
the documented form, to confirm before a live run.
"""

import sys
import os
import json
import time


def fail(message, code=1, kind="unknown"):
    """Emit a structured error the Node side can classify, and return an exit code."""
    print(json.dumps({"error": message, "kind": kind}))
    return code


def classify_error(exc):
    """
    Map an lseg-data / transport exception to a coarse `kind` the Node side can
    branch on. lseg-data does not expose a stable public exception taxonomy across
    versions, so this reads the type name + message for the tokens LSEG and the
    underlying HTTP layer use. Order matters: permission before not-found (a 403 on
    an unentitled field must not be misread as "field does not exist").
    """
    text = f"{type(exc).__name__}: {exc}".lower()
    permission = ("403", "401", "forbidden", "unauthorized", "access denied",
                  "not entitled", "no entitlement", "entitlement", "permission",
                  "not permissioned", "insufficient")
    not_found = ("404", "not found", "invalid field", "unknown field",
                 "invalid ric", "invalid instrument", "unrecognized", "no such",
                 "does not exist", "invalid universe")
    transport = ("timeout", "timed out", "connection", "network", "unreachable",
                 "socket", "refused", "reset", "temporarily", "502", "503", "504",
                 "session is not open", "session not open", "proxy")
    if any(t in text for t in permission):
        return "permission_denied"
    if any(t in text for t in not_found):
        return "not_found"
    if any(t in text for t in transport):
        return "transport"
    return "unknown"


def chunked(seq, size):
    """Yield successive `size`-length chunks of `seq` (a whole-universe get in one
    call risks the vendor's request-size / rate limits on a large universe)."""
    size = max(1, int(size or len(seq) or 1))
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def with_retry(call, max_retries, backoff):
    """
    Run `call()`, retrying only TRANSPORT-classified failures with exponential
    backoff. A permission or not-found error is deterministic — retrying it just
    wastes the rate budget — so it is raised immediately. Returns the call result
    or re-raises the last exception once retries are exhausted.
    """
    attempt = 0
    while True:
        try:
            return call()
        except Exception as e:  # noqa: BLE001
            if classify_error(e) != "transport" or attempt >= max_retries:
                raise
            time.sleep(backoff * (2 ** attempt))
            attempt += 1


def open_session(ld, app_key):
    """Open one lseg-data session for the whole request (sessions are heavy and
    concurrency-limited — a fresh one per instrument would exhaust the budget)."""
    if app_key:
        ld.open_session(app_key=app_key)
    else:
        ld.open_session()


def fetch_data(ld, universe, fields, parameters):
    """One get_data call for a chunk of the universe (fundamentals: a value per period)."""
    try:
        return ld.get_data(
            universe=universe,
            fields=fields,
            parameters=parameters or None,
            use_field_names_in_headers=True,
        )
    except TypeError:
        # Older/newer signatures may not accept the kwarg; fall back positionally.
        return ld.get_data(universe, fields, parameters or None)


def fetch_history(ld, universe, fields, interval, start, end):
    """
    One get_history call for a chunk of the universe (pricing: a time series at its
    own grain, not a per-period fundamental — finding #6). Signature varies across
    lseg-data versions, so try the documented kwargs and fall back positionally.
    """
    kwargs = {"universe": universe, "fields": fields}
    if interval:
        kwargs["interval"] = interval
    if start:
        kwargs["start"] = start
    if end:
        kwargs["end"] = end
    try:
        return ld.get_history(**kwargs)
    except TypeError:
        return ld.get_history(universe, fields)


def map_data_records(df, fields, period):
    """Map a get_data frame into wide rows keyed by TR.* field code, per instrument."""
    records = df.to_dict(orient="records")
    data_cols = [c for c in df.columns if str(c).lower() != "instrument"]
    rows = []
    for rec in records:
        inst = rec.get("Instrument") or rec.get("instrument")
        row = {"Instrument": inst, "period": period}
        for i, field in enumerate(fields):
            if field in rec and rec[field] is not None:
                row[field] = rec[field]
            elif i < len(data_cols) and rec.get(data_cols[i]) is not None:
                # Positional fallback when headers are display names, not codes.
                row[field] = rec[data_cols[i]]
        rows.append(row)
    return rows


def map_history_records(df, fields):
    """
    Map a get_history frame into per-(instrument, date) rows. get_history typically
    returns a Date-indexed frame; single-instrument requests carry field columns,
    multi-instrument requests carry an Instrument column. This handles both and
    leaves the exact live shape to confirm via lseg-mcp before a live run.
    """
    try:
        df = df.reset_index()
    except Exception:  # noqa: BLE001
        pass
    records = df.to_dict(orient="records")
    rows = []
    for rec in records:
        # The date lands under 'Date'/'date' once the index is reset.
        date = rec.get("Date") or rec.get("date") or rec.get("Timestamp")
        inst = rec.get("Instrument") or rec.get("instrument")
        row = {"Instrument": inst, "date": str(date) if date is not None else None}
        for field in fields:
            if rec.get(field) is not None:
                row[field] = rec[field]
        rows.append(row)
    return rows


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        return fail(f"could not parse request JSON on stdin: {e}", 64, kind="bad_request")

    universe = req.get("universe") or []
    fields = req.get("fields") or []
    period = req.get("period")
    parameters = dict(req.get("parameters") or {})
    app_key = req.get("appKey") or os.environ.get("LSEG_APP_KEY")
    mode = (req.get("mode") or "data").lower()
    interval = req.get("interval")
    start = req.get("start")
    end = req.get("end")
    chunk_size = req.get("chunkSize") or 100
    max_retries = int(req.get("maxRetries", 3))
    backoff = float(req.get("backoff", 0.5))

    if not universe:
        return fail("no universe (RICs) provided", 64, kind="bad_request")
    if not fields:
        return fail("no fields (TR.* codes) provided", 64, kind="bad_request")

    try:
        import lseg.data as ld
    except ImportError:
        return fail(
            "lseg-data is not installed. `pip install lseg-data` (requires an LSEG entitlement to return data).",
            69,
            kind="dependency",
        )

    # A period like 'FY2023'/'FY0' is passed through as an LSEG field parameter.
    if mode == "data" and period and not ({"Period", "FPeriod", "SDate", "EDate"} & set(parameters)):
        parameters["Period"] = period

    try:
        open_session(ld, app_key)
    except Exception as e:  # noqa: BLE001
        kind = classify_error(e)
        return fail(
            f"could not open an LSEG session: {e}. Ensure LSEG Workspace is running, or the app key + "
            "entitlement are valid.",
            70,
            kind=kind if kind != "unknown" else "transport",
        )

    # One session, chunked over the universe, transport errors retried with
    # backoff — the session is opened once above and closed once in `finally`.
    try:
        rows = []
        for chunk in chunked(universe, chunk_size):
            if mode == "history":
                df = with_retry(lambda c=chunk: fetch_history(ld, c, fields, interval, start, end),
                                max_retries, backoff)
                rows.extend(map_history_records(df, fields))
            else:
                df = with_retry(lambda c=chunk: fetch_data(ld, c, fields, parameters),
                                max_retries, backoff)
                rows.extend(map_data_records(df, fields, period))
    except Exception as e:  # noqa: BLE001
        call = "get_history" if mode == "history" else "get_data"
        return fail(f"{call} failed: {e}", 71, kind=classify_error(e))
    finally:
        try:
            ld.close_session()
        except Exception:  # noqa: BLE001
            pass

    print(json.dumps({"rows": rows}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
