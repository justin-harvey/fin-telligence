"""
A stand-in for the `lseg.data` module, for tests only.

test/lseg-bridge.test.js puts this directory on PYTHONPATH and describes, in
$FAKE_LSEG_SCENARIO (JSON), the frame each call returns — shaped the way lseg-data
documents its results: a get_data frame with an Instrument column, and a
Date-indexed get_history frame with per-field, per-instrument or MultiIndex
columns. It is not pandas: FakeFrame implements only the three members the bridge
touches (columns, to_dict(orient="records"), reset_index()), so the real bridge
runs offline with no LSEG entitlement and no pandas install.

Scenario markers stand in for what pandas hands back:
  NaN (a bare JSON NaN token)   -> float('nan')
  {"$na": true}                 -> a pandas-NA-like object (type name NAType)
  {"$int64": 5}                 -> a numpy-scalar-like object, unwrapped via .item()
  {"$ts": "2024-04-01"}         -> a datetime, as a pandas Timestamp would be
  a column given as a list      -> an (instrument, field) MultiIndex tuple
  {"raise": "message"}          -> the call raises with that message
  {"crash": true}               -> the process dies with no structured error
"""

import json
import os
from datetime import datetime


class NAType:
    """Mimics pandas.NA's type name, which is all the bridge inspects."""


class Int64:
    """Mimics a numpy integer scalar: not a Python int until .item() unwraps it."""

    def __init__(self, value):
        self.value = value

    def item(self):
        return self.value


def _value(v):
    if isinstance(v, dict):
        if v.get("$na"):
            return NAType()
        if "$int64" in v:
            return Int64(v["$int64"])
        if "$ts" in v:
            return datetime.fromisoformat(v["$ts"])
    return v


def _label(c):
    return tuple(c) if isinstance(c, list) else c


class FakeFrame:
    def __init__(self, columns, rows, index=None, index_name="Date"):
        self.columns = [_label(c) for c in columns]
        self._rows = [[_value(v) for v in row] for row in rows]
        self._index = None if index is None else [_value(v) for v in index]
        self._index_name = index_name

    def to_dict(self, orient="records"):
        assert orient == "records", orient
        return [dict(zip(self.columns, row)) for row in self._rows]

    def reset_index(self):
        if self._index is None:
            return self
        # Like pandas: with MultiIndex columns the index becomes a ("Date", "") column.
        multi = any(isinstance(c, tuple) for c in self.columns)
        frame = FakeFrame([], [])
        frame.columns = [(self._index_name, "") if multi else self._index_name] + self.columns
        frame._rows = [[i] + row for i, row in zip(self._index, self._rows)]
        return frame


def _respond(call):
    spec = json.loads(os.environ.get("FAKE_LSEG_SCENARIO", "{}")).get(call)
    if spec is None:
        raise RuntimeError(f"fake lseg: FAKE_LSEG_SCENARIO has no {call!r} frame")
    if "raise" in spec:
        raise RuntimeError(spec["raise"])
    if spec.get("crash"):
        os._exit(3)
    return FakeFrame(spec["columns"], spec["rows"], spec.get("index"), spec.get("index_name", "Date"))


def open_session(app_key=None):
    return None


def close_session():
    return None


def get_data(universe, fields, parameters=None, use_field_names_in_headers=False):
    return _respond("data")


def get_history(universe, fields, interval=None, start=None, end=None):
    return _respond("history")
