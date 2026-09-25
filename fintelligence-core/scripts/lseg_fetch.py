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
    "period": "FY2023", "appKey": "<optional>", "parameters": { ... } }

Response (stdout, JSON):
  { "rows": [ { "Instrument": "IBM.N", "period": "FY2023",
                "TR.Revenue": 61860000000, ... } ] }
  or on failure: { "error": "..." } with a non-zero exit code.

Prerequisites (only for real data — the demo never runs this):
  - pip install lseg-data
  - a running LSEG Workspace / Eikon session, or a Data Platform app key with an
    entitlement covering the requested fields
  - the app key via (in order) request.appKey, --app-key, or $LSEG_APP_KEY;
    absent that, the library's own config file (lseg-data.config.json) is used.

The exact get_data call shape should be confirmed with lseg-mcp's
`draft_api_call` / `get_package_signature` for your installed lseg-data version;
this bridge follows the documented get_data(universe, fields, parameters) form
and requests field-code headers so columns map back to TR.* codes.
"""

import sys
import os
import json


def fail(message, code=1):
    print(json.dumps({"error": message}))
    return code


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as e:  # noqa: BLE001
        return fail(f"could not parse request JSON on stdin: {e}", 64)

    universe = req.get("universe") or []
    fields = req.get("fields") or []
    period = req.get("period")
    parameters = dict(req.get("parameters") or {})
    app_key = req.get("appKey") or os.environ.get("LSEG_APP_KEY")

    if not universe:
        return fail("no universe (RICs) provided", 64)
    if not fields:
        return fail("no fields (TR.* codes) provided", 64)

    try:
        import lseg.data as ld
    except ImportError:
        return fail(
            "lseg-data is not installed. `pip install lseg-data` (requires an LSEG entitlement to return data).",
            69,
        )

    # A period like 'FY2023'/'FY0' is passed through as an LSEG field parameter.
    if period and not ({"Period", "FPeriod", "SDate", "EDate"} & set(parameters)):
        parameters["Period"] = period

    try:
        if app_key:
            ld.open_session(app_key=app_key)
        else:
            ld.open_session()
    except Exception as e:  # noqa: BLE001
        return fail(
            f"could not open an LSEG session: {e}. Ensure LSEG Workspace is running, or the app key + "
            "entitlement are valid.",
            70,
        )

    try:
        try:
            # Prefer TR.* codes as column headers so they map straight back.
            df = ld.get_data(
                universe=universe,
                fields=fields,
                parameters=parameters or None,
                use_field_names_in_headers=True,
            )
        except TypeError:
            # Older/newer signatures may not accept the kwarg; fall back positionally.
            df = ld.get_data(universe, fields, parameters or None)
    except Exception as e:  # noqa: BLE001
        return fail(f"get_data failed: {e}", 71)
    finally:
        try:
            ld.close_session()
        except Exception:  # noqa: BLE001
            pass

    try:
        records = df.to_dict(orient="records")
        data_cols = [c for c in df.columns if str(c).lower() != "instrument"]
    except Exception as e:  # noqa: BLE001
        return fail(f"could not read the returned data frame: {e}", 72)

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

    print(json.dumps({"rows": rows}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
