"""Strict cross-runtime paper identity contract (paper-identity-v1)."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

CONTRACT = "paper-identity-v1"
ARXIV_ID_RE = re.compile(r"^\d{4}\.\d{4,5}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SCHEMES = frozenset(("icassp-arnumber", "openreview-forum-id", "conference-paper-id"))
SHA_RE = re.compile(r"^[a-f0-9]{64}$")


def _fail(message: str) -> None:
    raise ValueError(f"Invalid paper identity: {message}")


def _exact_object(value: Any, fields: tuple[str, ...], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be a plain object")
    if set(value) != set(fields):
        _fail(f"{label} has unknown or missing fields")
    return value


def _text(value: Any, label: str, *, allow_empty: bool = False, maximum: int = 4096) -> str:
    if not isinstance(value, str) or value != value.strip() or len(value) > maximum or (not allow_empty and not value):
        _fail(f"{label} must be a trimmed text value without controls")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        _fail(f"{label} must be a trimmed text value without controls")
    return value


def _year(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1900 or value > 2100:
        _fail(f"{label} must be a supported four-digit year")
    return value


def validate_external_id(value: Any) -> dict[str, str]:
    raw = _exact_object(value, ("scheme", "value"), "externalId")
    if raw["scheme"] not in SCHEMES:
        _fail("externalId.scheme is unsupported")
    identifier = _text(raw["value"], "externalId.value", maximum=128)
    valid = (re.fullmatch(r"[1-9]\d*", identifier) if raw["scheme"] in {"icassp-arnumber", "conference-paper-id"}
             else re.fullmatch(r"[A-Za-z0-9_-]{6,128}", identifier))
    if not valid:
        _fail("externalId.value is invalid for its scheme")
    return {"scheme": raw["scheme"], "value": identifier}


def _public_dns_name(hostname: str | None) -> bool:
    if not hostname:
        return False
    host = hostname.lower()
    if host == "localhost" or host.endswith(".localhost") or ":" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    if len(host) > 253 or "." not in host:
        return False
    return all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in host.split("."))


def validate_official_url(value: Any, label: str) -> str:
    url = _text(value, label, maximum=2048)
    try:
        parsed = urlsplit(url)
    except ValueError:
        _fail(f"{label} is not a URL")
    try:
        port = parsed.port
    except ValueError:
        _fail(f"{label} is not a URL")
    if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or port
            or parsed.hostname != (parsed.hostname or "").lower()
            or parsed.query or parsed.fragment or not _public_dns_name(parsed.hostname)):
        _fail(f"{label} must be a canonical public HTTPS URL without credentials, port, query, or fragment")
    if (parsed.path == "/" or "//" in parsed.path or any(part in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._~-]+", part)
            for part in parsed.path.split("/")[1:])):
        _fail(f"{label} has an unsafe or non-canonical path")
    canonical = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    if canonical != url:
        _fail(f"{label} must use canonical URL spelling")
    return url


def validate_source(value: Any) -> dict[str, Any]:
    raw = _exact_object(value, ("status", "url"), "source")
    if raw["status"] == "unavailable":
        if raw["url"] is not None:
            _fail("source.url must be null when unavailable")
        return {"status": "unavailable", "url": None}
    if raw["status"] != "official":
        _fail("source.status must be official or unavailable")
    return {"status": "official", "url": validate_official_url(raw["url"], "source.url")}


def validate_citation(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    raw = _exact_object(value, ("title", "authors", "venue", "year"), "citation")
    title = _text(raw["title"], "citation.title", maximum=2048)
    if not isinstance(raw["authors"], list) or len(raw["authors"]) > 100:
        _fail("citation.authors must be an array of at most 100 names")
    authors = [_text(author, f"citation.authors[{index}]", maximum=512) for index, author in enumerate(raw["authors"])]
    if len(set(authors)) != len(authors):
        _fail("citation.authors must not contain duplicate names")
    venue = None if raw["venue"] is None else _text(raw["venue"], "citation.venue", maximum=512)
    year = None if raw["year"] is None else _year(raw["year"], "citation.year")
    return {"title": title, "authors": authors, "venue": venue, "year": year}


def canonical_conference_id(conference: Mapping[str, Any], external_id: Mapping[str, str]) -> str:
    return f"conference:{conference['slug']}:{conference['year']}:{external_id['scheme']}:{external_id['value']}"


def conference_coordinates(conference: Any) -> dict[str, Any]:
    raw = _exact_object(conference, ("id", "year"), "conference coordinates")
    year = _year(raw["year"], "conference coordinates.year")
    suffix = f"-{year}"
    if not isinstance(raw["id"], str) or not raw["id"].endswith(suffix):
        _fail("conference coordinates.id must end with its exact year")
    slug = raw["id"][:-len(suffix)]
    if not SLUG_RE.fullmatch(slug):
        _fail("conference coordinates.id must contain a normalized slug")
    return {"slug": slug, "year": year}


def canonical_conference_paper_id(conference: Any, source_identity: Any) -> str:
    raw = _exact_object(source_identity, ("type", "value"), "conference source identity")
    external_id = validate_external_id({"scheme": raw["type"], "value": raw["value"]})
    return canonical_conference_id(conference_coordinates(conference), external_id)


def assert_canonical_conference_paper_id(value: Any, conference: Any, source_identity: Any) -> str:
    expected = canonical_conference_paper_id(conference, source_identity)
    if value != expected:
        _fail(f"conference paperId must be {expected}")
    return expected


def normalize_identity(value: Any) -> dict[str, Any]:
    raw = _exact_object(value, ("contract", "kind", "canonicalId", "arxivId", "conference", "externalId", "source", "citation"), "paper identity")
    if raw["contract"] != CONTRACT:
        _fail(f"contract must be {CONTRACT}")
    if raw["kind"] not in {"arxiv", "conference"}:
        _fail("kind must be arxiv or conference")
    source = validate_source(raw["source"])
    citation = validate_citation(raw["citation"])
    if raw["kind"] == "arxiv":
        if not isinstance(raw["arxivId"], str) or not ARXIV_ID_RE.fullmatch(raw["arxivId"]):
            _fail("arxivId is invalid")
        if raw["conference"] is not None or raw["externalId"] is not None:
            _fail("arxiv identity must not contain conference fields")
        canonical_id = f"arxiv:{raw['arxivId']}"
        if raw["canonicalId"] != canonical_id:
            _fail("canonicalId does not bind arxivId")
        if source["status"] == "official" and source["url"] != f"https://arxiv.org/abs/{raw['arxivId']}":
            _fail("official arxiv source.url must bind its exact canonical abs URL")
        return {"contract": CONTRACT, "kind": "arxiv", "canonicalId": canonical_id, "arxivId": raw["arxivId"],
                "conference": None, "externalId": None, "source": source, "citation": citation}
    if raw["arxivId"] is not None:
        _fail("conference identity must not contain arxivId")
    conference_raw = _exact_object(raw["conference"], ("slug", "year"), "conference")
    if not isinstance(conference_raw["slug"], str) or not SLUG_RE.fullmatch(conference_raw["slug"]):
        _fail("conference.slug must be a normalized slug")
    conference = {"slug": conference_raw["slug"], "year": _year(conference_raw["year"], "conference.year")}
    external_id = validate_external_id(raw["externalId"])
    canonical_id = canonical_conference_id(conference, external_id)
    if raw["canonicalId"] != canonical_id:
        _fail("canonicalId does not bind conference, year, scheme, and value")
    return {"contract": CONTRACT, "kind": "conference", "canonicalId": canonical_id, "arxivId": None,
            "conference": conference, "externalId": external_id, "source": source, "citation": citation}


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def stable_sha256(value: Any) -> str:
    return sha256(stable_json(value))


def identity_payload(value: Any) -> dict[str, Any]:
    normalized = normalize_identity(value)
    if normalized["kind"] == "arxiv":
        return {"contract": CONTRACT, "kind": "arxiv", "canonicalId": normalized["canonicalId"], "arxivId": normalized["arxivId"]}
    return {"contract": CONTRACT, "kind": "conference", "canonicalId": normalized["canonicalId"],
            "conference": normalized["conference"], "externalId": normalized["externalId"]}


def identity_sha256(value: Any) -> str:
    return stable_sha256(identity_payload(value))


def record_sha256(value: Any) -> str:
    return stable_sha256(normalize_identity(value))


def is_sha256(value: Any) -> bool:
    return bool(SHA_RE.fullmatch(str(value or "")))


__all__ = ["CONTRACT", "ARXIV_ID_RE", "SCHEMES", "canonical_conference_id", "conference_coordinates",
           "canonical_conference_paper_id", "assert_canonical_conference_paper_id", "validate_external_id",
           "validate_official_url", "validate_source", "validate_citation", "normalize_identity", "identity_payload",
           "stable_json", "sha256", "stable_sha256", "identity_sha256", "record_sha256", "is_sha256"]


if __name__ == '__main__':
    # Every top-level Python script has the same external-runtime boundary,
    # even when this file normally serves only as an importable shared module.
    from runtime_guard import require_external_runtime
    require_external_runtime('paper_identity.py')
