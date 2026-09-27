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
                  "transport" | "bad_request" | "bad_response" | "dependency" |
                  "unknown" }
                with a non-zero exit code.

The `kind` lets the Node side branch: an entitlement gap (permission_denied) is a
provisioning problem, an unknown field/instrument (not_found) is a request bug,
transport is retryable — the bridge already retries transport within a call — and
bad_response means lseg-data answered with a frame the bridge will not guess at.

Mapping discipline. A value is mapped to a field code by NAME only (headers are
matched case-insensitively), never by column position: a positional guess lands a
value under the wrong field code without any error. A missing value — None, NaN,
pandas NA or NaT — leaves the field out of the row (absent, not zero, and never the
non-JSON token NaN), and numpy scalars are unwrapped to plain numbers. A frame that
cannot be mapped unambiguously is a bad_response error, not a guess.

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
installed lseg-data version. This bridge has never run against a live session:
test/lseg-bridge.test.js runs it end to end against a fake `lseg.data` module
(test/fixtures/fake-lseg) that returns the frame shapes lseg-data documents, which
pins the mapping and error handling — the live shapes still need confirming
before a real pull.
"""

import sys
import os
import json
import math
import time


def fail(message, code=1, kind="unknown"):
    """Emit a structured error the Node side can classify, and return an exit code."""
    print(json.dumps({"error": message, "kind": kind}))
    return code


class ResponseShapeError(Exception):
    """lseg-data returned a frame the bridge cannot map unambiguously to
    (instrument, field code) values. Raised rather than guessed: a guessed mapping
    lands a value under the wrong field code, or drops it, without any error."""


def native(value):
    """
    A JSON-safe scalar, or None for every flavour of missing value.

    lseg-data returns pandas frames, so a missing datapoint arrives as None, float
    NaN, pandas NA or NaT, and a number can arrive as a numpy scalar. Left alone,
    json.dumps writes NaN (not valid JSON — the Node side cannot parse it) and
    default=str turns NA or a numpy scalar into text ("<NA>", "123").
    """
    if value is None or type(value).__name__ in ("NAType", "NaTType"):
        return None
    if hasattr(value, "isoformat"):  # datetime / date / pandas Timestamp
        return value.isoformat()
    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()  # numpy scalar -> plain Python number
        except (TypeError, ValueError):
            pass
    if isinstance(value, float) and math.isnan(value):
        return None
    return value


def iso_date(value):
    """A trading date as YYYY-MM-DD (get_history dates arrive as Timestamps)."""
    value = native(value)
    return None if value is None else str(value)[:10]


def header(col):
    """Split a column label — plain, or an (instrument, field) MultiIndex tuple —
    into its trimmed (outer, inner) names."""
    if isinstance(col, tuple):
        outer = str(col[0]).strip() if len(col) > 0 else ""
        inner = str(col[1]).strip() if len(col) > 1 else ""
        return outer, inner
    return str(col).strip(), ""


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
    own grain, not a per-period fundamental — finding #6), with the documented
    keyword arguments.
    """
    kwargs = {"universe": universe, "fields": fields}
    if interval:
        kwargs["interval"] = interval
    if start:
        kwargs["start"] = start
    if end:
        kwargs["end"] = end
    # No positional fallback here: retrying as get_history(universe, fields) would
    # silently drop the requested interval/range and land a different series than
    # the one asked for. A signature mismatch fails loudly instead.
    return ld.get_history(**kwargs)


def map_data_records(df, fields, period):
    """
    Map a get_data frame into wide rows keyed by TR.* field code, one per
    instrument. Columns are matched to field codes by name, case-insensitively
    (lseg-data's header case varies by version). A requested field with no column
    of its own raises: the old positional fallback paired the i-th field with the
    i-th column, so a reordered or missing column put values under the wrong code.
    """
    by_name = {header(c)[0].upper(): c for c in df.columns}
    inst_col = by_name.get("INSTRUMENT")
    missing = [f for f in fields if f.upper() not in by_name]
    if inst_col is None or missing:
        raise ResponseShapeError(
            f"get_data columns {[str(c) for c in df.columns]} do not name "
            f"{'the instrument' if inst_col is None else missing}; refusing to map by position"
        )
    rows = []
    for rec in df.to_dict(orient="records"):
        inst = native(rec.get(inst_col))
        if not inst:
            raise ResponseShapeError(f"get_data returned a row with no instrument: {rec}")
        row = {"Instrument": inst, "period": period}
        for field in fields:
            value = native(rec.get(by_name[field.upper()]))
            if value is not None:
                row[field] = value
        rows.append(row)
    return rows


DATE_HEADERS = ("DATE", "TIMESTAMP")


def map_history_records(df, fields, chunk):
    """
    Map a get_history frame into one row per (instrument, trading day).

    get_history returns a Date-indexed frame whose columns depend on the request:
    one column per field for a single instrument; an (instrument, field)
    MultiIndex for several; one column per instrument when several share a single
    field; or a long frame with an Instrument column. Each shape is resolved by
    NAME to (instrument, field), and anything else raises. The old mapping emitted
    rows with no instrument for every shape but the long one, which the Node side
    then skipped — so a live pull landed nothing, silently.
    """
    df = df.reset_index()
    columns = list(df.columns)
    wanted = {f.upper(): f for f in fields}
    rics = {str(r).upper(): r for r in chunk}
    date_col = next((c for c in columns if header(c)[0].upper() in DATE_HEADERS), None)
    inst_col = next((c for c in columns if header(c)[0].upper() == "INSTRUMENT" and not header(c)[1]), None)

    targets = {}  # column label -> (instrument, or None when the Instrument column names it; field code)
    for col in columns:
        if col == date_col or col == inst_col:
            continue
        outer, inner = header(col)
        if inner:  # (instrument, field) MultiIndex
            ric, field = rics.get(outer.upper()), wanted.get(inner.upper())
        elif inst_col is not None:  # long shape
            ric, field = None, wanted.get(outer.upper())
        elif len(chunk) == 1:  # one instrument: its fields are the columns
            ric, field = chunk[0], wanted.get(outer.upper())
        elif len(fields) == 1:  # one field: the instruments are the columns
            ric, field = rics.get(outer.upper()), fields[0]
        else:
            ric, field = None, None
        if field and (ric or inst_col is not None):
            targets[col] = (ric, field)

    mapped = {field for _, field in targets.values()}
    unmapped = [f for f in fields if f not in mapped]
    if date_col is None or unmapped:
        raise ResponseShapeError(
            f"get_history columns {[str(c) for c in columns]} do not resolve "
            f"{'a Date column' if date_col is None else unmapped} to (instrument, field); refusing to guess"
        )

    rows = {}
    for rec in df.to_dict(orient="records"):
        day = iso_date(rec.get(date_col))
        if day is None:
            raise ResponseShapeError(f"get_history returned a row with no date: {rec}")
        for col, (ric, field) in targets.items():
            inst = ric or native(rec.get(inst_col))
            if not inst:
                raise ResponseShapeError(f"get_history returned a row with no instrument: {rec}")
            row = rows.setdefault((inst, day), {"Instrument": inst, "date": day})
            value = native(rec.get(col))
            if value is not None:
                row[field] = value
    return list(rows.values())


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
    call = "get_history" if mode == "history" else "get_data"
    try:
        rows = []
        for chunk in chunked(universe, chunk_size):
            if mode == "history":
                df = with_retry(lambda c=chunk: fetch_history(ld, c, fields, interval, start, end),
                                max_retries, backoff)
                rows.extend(map_history_records(df, fields, chunk))
            else:
                df = with_retry(lambda c=chunk: fetch_data(ld, c, fields, parameters),
                                max_retries, backoff)
                rows.extend(map_data_records(df, fields, period))
    except ResponseShapeError as e:
        return fail(f"{call} returned a frame the bridge will not guess at: {e}", 72, kind="bad_response")
    except Exception as e:  # noqa: BLE001
        return fail(f"{call} failed: {e}", 71, kind=classify_error(e))
    finally:
        try:
            ld.close_session()
        except Exception:  # noqa: BLE001
            pass

    # allow_nan=False: native() already turned NaN into None, so a non-finite
    # number reaching here (an infinity) fails loudly instead of emitting a token
    # JSON.parse rejects.
    try:
        body = json.dumps({"rows": rows}, default=str, allow_nan=False)
    except ValueError as e:
        return fail(f"{call} returned a non-finite number: {e}", 72, kind="bad_response")
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
