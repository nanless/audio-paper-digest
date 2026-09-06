#!/usr/bin/env python3
"""Read-only historical Hugo page inventory with immutable paired evidence.

The inventory never stores Markdown body text.  Bodies are read only to hash the
exact bytes and derive bounded identity/link hints needed by a later crosswalk.
"""

from __future__ import annotations

import hashlib
import csv
import io
import json
import os
import re
import stat
import subprocess
import unicodedata
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

from path_config import HISTORICAL_PAGE_INVENTORY_DIR, PROJECT_ROOT


DEFAULT_OUTPUT_DIR = HISTORICAL_PAGE_INVENTORY_DIR
LEDGER_CONTRACT = "historical-page-ledger-v1"
RECEIPT_CONTRACT = "historical-page-ledger-receipt-v1"
VERSION = 1
MAX_MARKDOWN_BYTES = 64 * 1024 * 1024
MAX_CONFIG_BYTES = 16 * 1024 * 1024
SAFE_JSON_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,159}\.json$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
GIT_OID_RE = re.compile(r"^[a-f0-9]{40,64}$")
ARXIV_RE = re.compile(r"(?<!\d)(\d{4}\.\d{4,5})(?:v([1-9]\d*))?(?!\d)", re.I)
OPENREVIEW_RE = re.compile(r"https://openreview\.net/(?:forum|pdf)\?id=([A-Za-z0-9_-]{6,128})", re.I)
IEEE_RE = re.compile(r"https://ieeexplore\.ieee\.org/(?:document|abstract/document)/(\d+)", re.I)
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
MARKDOWN_DESTINATION_RE = re.compile(
    r"^\((?:<([^>\n]+)>|([^\s)]+))(?:\s+[\"'][^\n]*[\"'])?\)"
)
HTML_LINK_RE = re.compile(r"<a\b[^>]*\bhref\s*=\s*([\"'])(.*?)\1", re.I | re.DOTALL)
CONFERENCE_RE = re.compile(r"^(icassp|iclr|icml)-(\d{4})$", re.I)
CONFERENCE_FILE_RE = re.compile(r"^(icassp|iclr|icml)(\d{4})-(summary|task-[a-z0-9._-]+)$", re.I)
DATE_PREFIX_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-|$)")
PAGE_ID_CONTRACT = "historical-page-id-v1"
LINK_TYPES = {"markdown-inline", "html-anchor"}
LINK_STATUSES = {"resolved", "unresolved", "ambiguous"}
PUBLICATION_EVIDENCE_FIELDS = {
    "paper_digest_abstract_sha256", "paper_digest_api_reader_article_sha256",
    "paper_digest_api_reader_author_count", "paper_digest_api_reader_author_identity_contract",
    "paper_digest_api_reader_author_identity_sha256", "paper_digest_api_reader_contract",
    "paper_digest_api_reader_decision_projection", "paper_digest_api_reader_plan_sha256",
    "paper_digest_api_reader_resource_count", "paper_digest_api_reader_resource_identity_contract",
    "paper_digest_api_reader_resource_identity_sha256", "paper_digest_api_reader_source_binding_contract",
    "paper_digest_api_reader_source_bindings_sha256", "paper_digest_api_reader_source_formula_count",
    "paper_digest_api_reader_source_table_count", "paper_digest_api_reader_structured_artifacts_sha256",
    "paper_digest_arxiv_id", "paper_digest_arxiv_version", "paper_digest_arxiv_versioned_id",
    "paper_digest_document_type", "paper_digest_fresh_authoring_contract",
    "paper_digest_fresh_authoring_sha256", "paper_digest_manual_depth", "paper_digest_page_type",
    "paper_digest_pipeline_owned", "paper_digest_primary_task", "paper_digest_rank_bucket",
    "paper_digest_reader_article_sha256", "paper_digest_reader_quality", "paper_digest_score",
    "paper_digest_sidecars", "paper_digest_tutorial_artifact_plan_sha256",
    "paper_digest_tutorial_contract", "paper_digest_tutorial_payload_contract",
    "paper_digest_tutorial_payload_sha256", "paper_digest_tutorial_quality_sha256",
    "paper_digest_workbench_contract",
}
SCAN_POLICY = {
    "contract": "historical-page-scan-policy-v3",
    "bodyRetention": "sha256-only",
    "identityHints": "frontmatter-filename-explicit-links-v1",
    "outboundLinks": "strict-balanced-inline-occurrences-v3",
    "linkOffsetUnit": "utf8-byte-body-relative",
    "taxonomyRoutes": "unverified-candidates-v2",
    "publicationEvidence": "schema-checked-hash-default-whitelist-v3",
    "targetRecordBinding": "target-page-snapshot-sha256-v1",
}

PRESERVED_PUBLICATION_STRING_FIELDS = {
    "paper_digest_arxiv_id",
    "paper_digest_arxiv_versioned_id",
    "paper_digest_page_type",
}


class HistoricalPageInventoryError(RuntimeError):
    """Raised when the blog snapshot or inventory evidence fails closed."""


def _fail(message: str) -> HistoricalPageInventoryError:
    return HistoricalPageInventoryError(f"Historical page inventory rejected: {message}")


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise _fail("frontmatter contains a non-finite number")
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise _fail("frontmatter mapping keys must be strings")
        return {key: _json_value(value[key]) for key in sorted(value)}
    raise _fail(f"frontmatter contains unsupported YAML value: {type(value).__name__}")


def canonical_json(value: Any) -> bytes:
    return json.dumps(_json_value(value), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def stable_hash(value: Any) -> str:
    return sha256_bytes(canonical_json(value))


def encoded_json(value: Any) -> bytes:
    return (json.dumps(_json_value(value), ensure_ascii=False, sort_keys=True,
                       indent=2) + "\n").encode("utf-8")


def _exact(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise _fail(f"{label} has unknown or missing fields")
    return value


def _sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise _fail(f"{label} must be a lowercase SHA-256")
    return value


def _safe_text(value: Any, label: str, maximum: int = 4096) -> str:
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > maximum or re.search(r"[\x00-\x1f\x7f]", value)):
        raise _fail(f"{label} must be bounded trimmed text without controls")
    return value


def _safe_directory(path: Path, *, create: bool = False) -> Path:
    requested = Path(path).expanduser().absolute()
    if create and not requested.exists():
        parent = _safe_directory(requested.parent)
        requested = parent / requested.name
        requested.mkdir(mode=0o700)
    try:
        info = requested.lstat()
        resolved = requested.resolve(strict=True)
    except OSError as exc:
        raise _fail(f"directory is missing or inaccessible: {requested}") from exc
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or resolved != requested:
        raise _fail(f"unsafe directory: {requested}")
    return requested


def _read_regular(path: Path, maximum: int, label: str) -> bytes:
    path = Path(path)
    try:
        before = path.lstat()
        if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode)
                or before.st_nlink != 1 or before.st_size > maximum):
            raise _fail(f"{label} must be a bounded regular single-link file")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except HistoricalPageInventoryError:
        raise
    except OSError as exc:
        raise _fail(f"cannot safely open {label}: {path}") from exc
    try:
        opened = os.fstat(fd)
        named = path.lstat()
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or stat.S_ISLNK(named.st_mode) or named.st_nlink != 1
                or (opened.st_dev, opened.st_ino, opened.st_size)
                != (named.st_dev, named.st_ino, named.st_size)):
            raise _fail(f"{label} changed or became unsafe while opening")
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(fd, min(1024 * 1024, remaining))
            if not chunk:
                raise _fail(f"{label} changed while reading")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(fd, 1):
            raise _fail(f"{label} grew while reading")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _yaml_object(raw: str, label: str) -> dict[str, Any]:
    try:
        import yaml
    except ImportError as exc:
        raise _fail("PyYAML is required for historical frontmatter inventory") from exc

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def mapping(loader, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise _fail(f"{label} contains duplicate YAML key: {key}")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    try:
        value = yaml.load(raw, Loader=UniqueKeyLoader)
    except HistoricalPageInventoryError:
        raise
    except (yaml.YAMLError, TypeError) as exc:
        raise _fail(f"{label} is invalid YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise _fail(f"{label} must be a YAML object")
    return _json_value(value)


def _parse_frontmatter(path: Path, raw: bytes) -> tuple[dict[str, Any], bytes, bytes, str]:
    try:
        content = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise _fail(f"Markdown is not strict UTF-8: {path.name}") from exc
    match = FRONTMATTER_RE.match(content)
    if not match:
        raise _fail(f"Markdown lacks strict YAML frontmatter: {path.name}")
    frontmatter = _yaml_object(match.group(1), f"{path.name} frontmatter")
    frontmatter_bytes = content[:match.end()].encode("utf-8")
    body = content[match.end():]
    body_bytes = body.encode("utf-8")
    if frontmatter_bytes + body_bytes != raw:
        raise _fail(f"frontmatter/body bytes do not partition content: {path.name}")
    return frontmatter, frontmatter_bytes, body_bytes, body


def _git(repo: Path, args: list[str]) -> bytes:
    result = subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise _fail(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def _git_remote_main(repo: Path, remote_name: str) -> dict[str, Any]:
    ref = f"refs/remotes/{remote_name}/main"
    result = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", ref],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode == 1:
        return {"availability": "unavailable", "oid": None, "ref": ref}
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise _fail(f"git rev-parse remote main failed: {detail}")
    oid = result.stdout.decode("ascii", errors="strict").strip().lower()
    if not GIT_OID_RE.fullmatch(oid):
        raise _fail("remote main tracking ref did not return a canonical OID")
    return {"availability": "available", "oid": oid, "ref": ref}


def _git_snapshot(repo: Path, remote_name: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}", remote_name):
        raise _fail("remote name is malformed")
    branch = _git(repo, ["branch", "--show-current"]).decode("utf-8", errors="strict").strip()
    head = _git(repo, ["rev-parse", "HEAD"]).decode("ascii", errors="strict").strip().lower()
    if not branch or not GIT_OID_RE.fullmatch(head):
        raise _fail("blog repository branch/HEAD is not canonical")
    status = _git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])
    push_url = _git(repo, ["remote", "get-url", "--push", remote_name]).decode("utf-8", errors="strict").strip()
    if not push_url or "\n" in push_url or "\x00" in push_url:
        raise _fail("blog remote push URL is malformed")
    if "://" in push_url:
        parsed_remote = urlsplit(push_url)
        if parsed_remote.username or parsed_remote.password:
            raise _fail("blog remote push URL must not contain credentials")
    remote_identity = stable_hash({"remote": remote_name, "pushUrl": push_url})
    return {"branch": branch, "head": head, "clean": not status,
            "statusSha256": sha256_bytes(status), "remoteName": remote_name,
            "remoteIdentitySha256": remote_identity,
            "remoteMain": _git_remote_main(repo, remote_name)}


def _tracked_markdown(repo: Path) -> tuple[str, str, list[dict[str, str]]]:
    object_format = _git(repo, ["rev-parse", "--show-object-format"]).decode("ascii", errors="strict").strip()
    if object_format not in ("sha1", "sha256"):
        raise _fail("blog Git object format is unsupported")
    tree_oid = _git(repo, ["rev-parse", "HEAD:content/posts"]).decode("ascii", errors="strict").strip().lower()
    if not GIT_OID_RE.fullmatch(tree_oid):
        raise _fail("content/posts tree OID is malformed")
    staged = _git(repo, ["ls-files", "--stage", "-z", "--", "content/posts"])
    flags = _git(repo, ["ls-files", "-v", "-z", "--", "content/posts"])
    flag_by_path: dict[str, str] = {}
    for item in flags.split(b"\0"):
        if not item:
            continue
        decoded = item.decode("utf-8", errors="strict")
        flag, pathname = decoded[0], decoded[2:]
        flag_by_path[pathname] = flag
    records = []
    for item in staged.split(b"\0"):
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        mode, oid, stage = metadata.decode("ascii", errors="strict").split(" ")
        pathname = raw_path.decode("utf-8", errors="strict")
        if not pathname.lower().endswith(".md"):
            continue
        if stage != "0" or mode not in ("100644", "100755") or not GIT_OID_RE.fullmatch(oid):
            raise _fail(f"tracked Markdown page has unsupported index metadata: {pathname}")
        if flag_by_path.get(pathname) != "H":
            raise _fail(f"tracked Markdown page uses assume-unchanged/skip-worktree metadata: {pathname}")
        records.append({"path": pathname, "blobOid": oid.lower()})
    records.sort(key=lambda item: item["path"])
    return object_format, tree_oid, records


def _git_blob_oid(raw: bytes, object_format: str) -> str:
    digest = hashlib.new(object_format)
    digest.update(f"blob {len(raw)}\0".encode("ascii"))
    digest.update(raw)
    return digest.hexdigest()


def _markdown_paths(repo: Path) -> list[Path]:
    root = _safe_directory(repo / "content" / "posts")
    result: list[Path] = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort(); files.sort()
        for name in [*dirs, *files]:
            item = Path(directory) / name
            if item.is_symlink():
                raise _fail(f"blog posts tree contains a symlink: {item.relative_to(repo)}")
        for name in files:
            item = Path(directory) / name
            info = item.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise _fail(f"blog posts tree contains an unsafe file: {item.relative_to(repo)}")
            if item.suffix.lower() == ".md":
                result.append(item)
    return sorted(result, key=lambda item: item.relative_to(repo).as_posix())


def _base_url(repo: Path) -> tuple[str, dict[str, Any], bytes]:
    config = repo / "hugo.yaml"
    raw = _read_regular(config, MAX_CONFIG_BYTES, "Hugo config")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise _fail("hugo.yaml is not strict UTF-8") from exc
    values = _yaml_object(text, "hugo.yaml")
    if values.get("permalinks") or values.get("uglyURLs"):
        raise _fail("custom Hugo permalinks/uglyURLs need a separate inventory projection")
    base = values.get("baseURL")
    if not isinstance(base, str):
        raise _fail("Hugo baseURL is required")
    parsed = urlsplit(base)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.query or parsed.fragment
            or re.search(r"[\x00-\x20\x7f\\]", base)):
        raise _fail("Hugo baseURL must be safe HTTPS")
    return base.rstrip("/") + "/", values, raw


def _hugo_page_snapshot(repo: Path, base: str) -> tuple[dict[str, str], set[str], dict[str, Any]]:
    def run(arguments: list[str]) -> bytes:
        try:
            result = subprocess.run(["hugo", *arguments, "--source", str(repo), "--noBuildLock"],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                                    timeout=120)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise _fail("Hugo is required to authoritatively inventory page routes") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            raise _fail(f"Hugo page inventory failed: {detail}")
        return result.stdout

    try:
        version = subprocess.run(["hugo", "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 check=True, timeout=30).stdout.decode("utf-8", errors="strict").strip()
    except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
        raise _fail("Hugo version cannot be determined") from exc
    if not version or len(version) > 500 or re.search(r"[\x00-\x1f\x7f]", version):
        raise _fail("Hugo version output is malformed")

    def rows(command: str) -> list[dict[str, str]]:
        text = run(["list", command]).decode("utf-8", errors="strict")
        result = []
        for item in csv.DictReader(io.StringIO(text)):
            pathname = item.get("path", "")
            if pathname.startswith("content/posts/") and pathname.lower().endswith(".md"):
                raw_permalink = item.get("permalink", "")
                if not raw_permalink:
                    raise _fail(f"Hugo omitted permalink for {pathname}")
                permalink = _canonical_blog_url(raw_permalink, base)
                result.append({"path": pathname, "permalink": permalink})
        result.sort(key=lambda item: item["path"])
        if len({item["path"] for item in result}) != len(result):
            raise _fail("Hugo returned duplicate content/posts paths")
        return result

    all_pages = rows("all")
    published_pages = rows("published")
    all_mapping = {item["path"]: item["permalink"] for item in all_pages}
    published_paths = {item["path"] for item in published_pages}
    if not published_paths.issubset(all_mapping):
        raise _fail("Hugo published page set is not a subset of all pages")
    descriptor = {"version": version, "pageSetSha256": stable_hash(all_pages),
                  "publishedPageSetSha256": stable_hash(published_pages),
                  "pageCount": len(all_pages), "publishedPageCount": len(published_pages)}
    return all_mapping, published_paths, descriptor


def _canonical_blog_url(raw: str, base: str, *, relative_to: str | None = None) -> str:
    if not isinstance(raw, str) or not raw or raw != raw.strip() or re.search(r"[\x00-\x20\x7f\\]", raw):
        raise _fail("page URL/alias contains unsafe text")
    base_parts = urlsplit(base)
    joined = urljoin(relative_to or base, raw)
    parsed = urlsplit(joined)
    if (parsed.scheme != "https" or parsed.netloc != base_parts.netloc or parsed.username
            or parsed.password or parsed.port not in (None, 443)):
        raise _fail("page URL/alias leaves the configured HTTPS blog origin")
    decoded = unquote(parsed.path)
    if ("\\" in decoded or re.search(r"[\x00-\x1f\x7f]", decoded)
            or any(part in (".", "..") for part in decoded.split("/"))
            or not decoded.startswith(unquote(base_parts.path))):
        raise _fail("page URL/alias escapes the configured base path")
    path = quote(decoded, safe="/-._~")
    if not path.endswith("/") and "." not in Path(decoded).name:
        path += "/"
    return urlunsplit(("https", base_parts.netloc, path, "", ""))


def _page_url(repo: Path, path: Path, frontmatter: dict[str, Any], base: str) -> str:
    explicit = frontmatter.get("url")
    if explicit is not None:
        return _canonical_blog_url(explicit, base)
    posts = repo / "content" / "posts"
    relative = path.relative_to(posts)
    if path.name in ("index.md", "_index.md"):
        parts = list(relative.parent.parts)
    else:
        slug = frontmatter.get("slug", path.stem)
        if (not isinstance(slug, str) or not slug or slug != slug.strip()
                or re.search(r"[\x00-\x1f\x7f/\\?#]", slug)):
            raise _fail(f"unsafe page slug: {path.relative_to(repo)}")
        parts = [*relative.parent.parts, slug]
    base_parts = urlsplit(base)
    suffix = "/".join(quote(part, safe="-._~") for part in parts)
    raw_path = base_parts.path.rstrip("/") + "/posts/" + suffix + "/"
    return _canonical_blog_url(raw_path, base)


def _aliases(frontmatter: dict[str, Any], base: str) -> list[str]:
    raw = frontmatter.get("aliases", [])
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise _fail("frontmatter aliases must be a string or string list")
    return sorted(set(_canonical_blog_url(item, base) for item in raw))


def _legacy_list(frontmatter: dict[str, Any], field: str) -> list[str]:
    value = frontmatter.get(field, [])
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise _fail(f"frontmatter {field} must be a non-empty string list when present")
    return list(value)


def _kind_scope(path: Path, frontmatter: dict[str, Any], categories: list[str]) -> tuple[str, dict[str, Any]]:
    stem = path.stem
    conference_keys = {f"{match.group(1).lower()}-{match.group(2)}" for item in categories
                       if (match := CONFERENCE_RE.fullmatch(item))}
    file_match = CONFERENCE_FILE_RE.fullmatch(stem)
    if file_match:
        conference_keys.add(f"{file_match.group(1).lower()}-{file_match.group(2)}")
    date_match = DATE_PREFIX_RE.match(stem)
    day = date_match.group(1) if date_match else None
    if day:
        try: date.fromisoformat(day)
        except ValueError as exc: raise _fail(f"invalid date prefix in {path.name}") from exc
    if len(conference_keys) == 1:
        scope = {"type": "conference", "key": next(iter(conference_keys))}
    elif len(conference_keys) > 1:
        scope = {"type": "conflict", "key": None}
    elif day:
        scope = {"type": "daily", "key": day}
    else:
        scope = {"type": "unknown", "key": None}
    declared = frontmatter.get("paper_digest_page_type")
    if declared is not None and not isinstance(declared, str):
        raise _fail("paper_digest_page_type must be a string when present")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", stem):
        kind = "daily-summary"
    elif file_match and file_match.group(3).lower() == "summary":
        kind = "conference-summary"
    elif file_match:
        kind = "conference-task"
    elif declared in ("summary", "digest", "index"):
        kind = "conference-summary" if scope["type"] == "conference" else "daily-summary"
    elif declared in (None, "paper"):
        kind = "paper"
    else:
        kind = "unknown"
    return kind, scope


def _identity_hints(path: Path, frontmatter: dict[str, Any], body: str) -> dict[str, Any]:
    found: dict[tuple[str, str], set[str]] = {}

    def add(scheme: str, value: str, source: str):
        found.setdefault((scheme, value), set()).add(source)

    for field in ("paper_digest_arxiv_id", "paper_digest_arxiv_versioned_id", "arxiv_id", "arxivId"):
        value = frontmatter.get(field)
        if value is None:
            continue
        if not isinstance(value, str):
            raise _fail(f"{field} identity hint must be a string or null")
        match = ARXIV_RE.fullmatch(value)
        if not match:
            raise _fail(f"{field} identity hint is malformed")
        add("arxiv", match.group(1), f"frontmatter:{field}")
    filename = re.search(r"-(\d{4})-(\d{4,5})(?:v[1-9]\d*)?$", path.stem)
    if filename:
        add("arxiv", f"{filename.group(1)}.{filename.group(2)}", "filename")
    for match in re.finditer(r"https://arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?(?:\.pdf)?", body, re.I):
        add("arxiv", match.group(1), "body:arxiv-link")
    for match in OPENREVIEW_RE.finditer(body):
        add("openreview-forum-id", match.group(1), "body:openreview-link")
    for match in IEEE_RE.finditer(body):
        add("icassp-arnumber", match.group(1), "body:ieee-link")
    candidates = [{"scheme": scheme, "value": value, "sources": sorted(sources)}
                  for (scheme, value), sources in sorted(found.items())]
    by_scheme: dict[str, set[str]] = {}
    for item in candidates:
        by_scheme.setdefault(item["scheme"], set()).add(item["value"])
    status = ("none" if not candidates else "conflict" if any(len(values) > 1 for values in by_scheme.values())
              else "single" if len(candidates) == 1 else "multiple")
    return {"status": status, "candidates": candidates}


def _is_markdown_escaped(value: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and value[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def _strict_markdown_inline_links(body: str) -> list[tuple[int, int, str]]:
    """Parse the deliberately narrow inline-link grammar without guessing labels.

    Link labels use balanced square brackets (including the real ``[m]``/``[t]``
    paper-title case). Destinations retain the previous strict grammar, so a
    formula fragment such as ``[w](1)`` is parsed here but is still rejected by
    the internal-post target allowlist in ``_strict_post_link_occurrences``.
    """
    result: list[tuple[int, int, str]] = []
    position = 0
    while position < len(body):
        start = body.find("[", position)
        if start < 0:
            break
        position = start + 1
        if _is_markdown_escaped(body, start):
            continue
        depth = 1
        cursor = start + 1
        while cursor < len(body) and body[cursor] != "\n":
            character = body[cursor]
            if character == "[" and not _is_markdown_escaped(body, cursor):
                depth += 1
            elif character == "]" and not _is_markdown_escaped(body, cursor):
                depth -= 1
                if depth == 0:
                    destination = MARKDOWN_DESTINATION_RE.match(body[cursor + 1:])
                    if destination:
                        end = cursor + 1 + destination.end()
                        # Skip the complete image construct as one unit. This
                        # prevents a nested bracket in alt text being mistaken
                        # for an independent hyperlink.
                        if start == 0 or body[start - 1] != "!" or _is_markdown_escaped(body, start - 1):
                            result.append((start, end, destination.group(1) or destination.group(2)))
                        position = end
                    break
            cursor += 1
    return result


def _strict_post_link_occurrences(body: str, page_url: str, base: str) -> list[dict[str, Any]]:
    # This is deliberately a narrow grammar, not a general Markdown guesser.
    # Historical aggregate links use absolute site paths or explicit HTTPS
    # URLs. Bare targets such as LaTeX's ``[w](1)`` are never admitted.
    matches: list[tuple[int, int, str, str]] = []
    for start, end, target in _strict_markdown_inline_links(body):
        matches.append((start, end, "markdown-inline", target))
    for match in HTML_LINK_RE.finditer(body):
        matches.append((match.start(), match.end(), "html-anchor", match.group(2)))
    matches.sort(key=lambda item: (item[0], item[1], item[2]))
    base_path = urlsplit(base).path.rstrip("/") + "/posts/"
    result = []
    previous_character = 0
    previous_byte = 0
    for start, end, link_type, raw in matches:
        target = raw.strip()
        if not (target.startswith("/") or target.startswith("./") or target.startswith("../")
                or target.startswith("https://")):
            continue
        try:
            value = _canonical_blog_url(target, base, relative_to=page_url)
        except HistoricalPageInventoryError:
            continue
        if unquote(urlsplit(value).path).startswith(unquote(base_path)):
            previous_byte += len(body[previous_character:start].encode("utf-8"))
            end_byte = previous_byte + len(body[start:end].encode("utf-8"))
            result.append({"ordinal": len(result) + 1, "linkType": link_type,
                           "sourceByteStart": previous_byte, "sourceByteEnd": end_byte,
                           "targetRawSha256": sha256_bytes(target.encode("utf-8")),
                           "targetUrl": value})
            previous_character = end
            previous_byte = end_byte
    return result


def _publication_evidence(frontmatter: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for field in sorted(key for key in frontmatter if key in PUBLICATION_EVIDENCE_FIELDS):
        value = _json_value(frontmatter[field])
        value_type = ("null" if value is None else "boolean" if isinstance(value, bool)
                      else "integer" if isinstance(value, int) else "number" if isinstance(value, float)
                      else "string" if isinstance(value, str) else "array" if isinstance(value, list) else "object")
        # Strings are hash-only by default, including a scalar sidecar value.
        # Only the smallest identity/enum set crosses this boundary, and every
        # preserved value is checked against its field-specific grammar.
        if value_type == "string":
            preserved = _preserved_publication_string(field, value)
        else:
            preserved = value if value_type in ("null", "boolean", "integer", "number") else None
        result.append({"field": field, "valueType": value_type, "value": preserved,
                       "valueSha256": stable_hash(value)})
    return result


def _preserved_publication_string(field: str, value: str) -> str | None:
    if field not in PRESERVED_PUBLICATION_STRING_FIELDS:
        return None
    if field == "paper_digest_arxiv_id":
        if not re.fullmatch(r"\d{4}\.\d{4,5}", value):
            raise _fail("paper_digest_arxiv_id must be a normalized unversioned arXiv ID")
    elif field == "paper_digest_arxiv_versioned_id":
        if not re.fullmatch(r"\d{4}\.\d{4,5}v[1-9]\d*", value):
            raise _fail("paper_digest_arxiv_versioned_id must be a normalized versioned arXiv ID")
    elif field == "paper_digest_page_type":
        if value not in {"paper", "index", "summary", "digest"}:
            raise _fail("paper_digest_page_type is outside the preserved enum")
    return value


def _term_slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    normalized = re.sub(r"[\s_]+", "-", normalized)
    normalized = re.sub(r"[/\\?#%]+", "-", normalized)
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    if not normalized or re.search(r"[\x00-\x1f\x7f]", normalized):
        raise _fail("legacy taxonomy term cannot be projected safely")
    return normalized


def _taxonomy_candidates(tags: list[str], categories: list[str], base: str) -> list[dict[str, str]]:
    candidates = []
    for taxonomy, values in (("tags", tags), ("categories", categories)):
        for term in sorted(set(values)):
            route = urljoin(base, f"{taxonomy}/{quote(_term_slug(term), safe='-._~')}/")
            candidates.append({"taxonomy": taxonomy, "term": term, "status": "unverified",
                               "candidateUrl": route, "method": "legacy-term-normalization-v1"})
    return candidates


def _frontmatter_date(frontmatter: dict[str, Any], field: str, *, required: bool = False) -> str | None:
    value = frontmatter.get(field)
    if value is None:
        if required:
            raise _fail(f"frontmatter {field} is required")
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}(?:T|$)", value):
        try:
            return date.fromisoformat(value[:10]).isoformat()
        except ValueError as exc:
            raise _fail(f"frontmatter {field} is not a canonical date") from exc
    raise _fail(f"frontmatter {field} must be a date or ISO timestamp")


def _page_snapshot_body(page: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in page.items()
            if key not in ("outboundPostLinks", "snapshotSha256", "recordSha256")}


def _page_record(repo: Path, path: Path, raw: bytes, base: str, git_blob_oid: str,
                 hugo_permalink: str, published: bool) -> dict[str, Any]:
    frontmatter, frontmatter_bytes, body_bytes, body = _parse_frontmatter(path, raw)
    relative = path.relative_to(repo).as_posix()
    tags = _legacy_list(frontmatter, "tags")
    categories = _legacy_list(frontmatter, "categories")
    primary_url = _page_url(repo, path, frontmatter, base)
    authoritative_url = _canonical_blog_url(hugo_permalink, base)
    if primary_url != authoritative_url:
        raise _fail(f"manual page URL projection differs from Hugo: {relative}")
    primary_url = authoritative_url
    aliases = _aliases(frontmatter, base)
    kind, scope = _kind_scope(path, frontmatter, categories)
    draft = frontmatter.get("draft", False)
    if not isinstance(draft, bool):
        raise _fail(f"frontmatter draft must be boolean: {relative}")
    published_date = _frontmatter_date(frontmatter, "publishDate") or _frontmatter_date(
        frontmatter, "date", required=True)
    date_match = DATE_PREFIX_RE.match(path.stem)
    cohort_date = date_match.group(1) if date_match else published_date
    file_match = CONFERENCE_FILE_RE.fullmatch(path.stem)
    legacy_task_key = file_match.group(3).lower() if file_match and file_match.group(3).lower().startswith("task-") else None
    page_id = f"page:{stable_hash({'contract': PAGE_ID_CONTRACT, 'path': relative, 'primaryUrl': primary_url})}"
    marker_fields = sorted(key for key in frontmatter if key.startswith("paper_digest_"))
    marker_values = {key: frontmatter[key] for key in marker_fields}
    marker = {"pipelineOwned": frontmatter.get("paper_digest_pipeline_owned")
              if isinstance(frontmatter.get("paper_digest_pipeline_owned"), bool) else None,
              "declaredPageType": frontmatter.get("paper_digest_page_type")
              if isinstance(frontmatter.get("paper_digest_page_type"), str) else None,
              "fieldNames": marker_fields, "fieldsSha256": stable_hash(marker_values)}
    body_record = {
        "pageId": page_id, "path": relative, "gitBlobOid": git_blob_oid,
        "contentBytes": len(raw), "contentSha256": sha256_bytes(raw),
        "frontmatterBytes": len(frontmatter_bytes), "frontmatterSha256": sha256_bytes(frontmatter_bytes),
        "bodyBytes": len(body_bytes), "bodySha256": sha256_bytes(body_bytes),
        "primaryUrl": primary_url, "aliases": aliases, "kind": kind, "scope": scope,
        "publishedDate": published_date, "cohortDate": cohort_date,
        "legacyTaskKey": legacy_task_key, "draft": draft, "published": published,
        "legacy": {"tags": tags, "categories": categories, "marker": marker},
        "identityHints": _identity_hints(path, frontmatter, body),
        "outboundPostLinks": _strict_post_link_occurrences(body, primary_url, base),
        "publicationEvidenceRefs": _publication_evidence(frontmatter),
        "legacyTaxonomyCandidates": _taxonomy_candidates(tags, categories, base),
    }
    return {**body_record, "snapshotSha256": stable_hash(_page_snapshot_body(body_record))}


def _url_collisions(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    claims: dict[str, set[str]] = {}
    for page in pages:
        for url in [page["primaryUrl"], *page["aliases"]]:
            claims.setdefault(url, set()).add(page["path"])
    return [{"url": url, "paths": sorted(paths)} for url, paths in sorted(claims.items()) if len(paths) > 1]


def _resolve_links(pages: list[dict[str, Any]]) -> None:
    claims: dict[str, list[dict[str, Any]]] = {}
    for page in pages:
        for url in [page["primaryUrl"], *page["aliases"]]:
            claims.setdefault(url, []).append(page)
    for page in pages:
        resolved = []
        for occurrence in page["outboundPostLinks"]:
            targets = {item["pageId"]: item for item in claims.get(occurrence["targetUrl"], [])}
            if len(targets) == 1:
                target = next(iter(targets.values()))
                binding = {"status": "resolved", "targetPath": target["path"],
                           "targetPageId": target["pageId"],
                           "targetRecordSha256": target["snapshotSha256"]}
            elif targets:
                binding = {"status": "ambiguous", "targetPath": None,
                           "targetPageId": None, "targetRecordSha256": None}
            else:
                binding = {"status": "unresolved", "targetPath": None,
                           "targetPageId": None, "targetRecordSha256": None}
            resolved.append({**occurrence, **binding})
        page["outboundPostLinks"] = resolved
        page_body = {key: value for key, value in page.items() if key != "recordSha256"}
        page["recordSha256"] = stable_hash(page_body)


def _page_sha_map(repo: Path) -> dict[str, str]:
    return {path.relative_to(repo).as_posix(): sha256_bytes(_read_regular(path, MAX_MARKDOWN_BYTES, "Markdown page"))
            for path in _markdown_paths(repo)}


def _assert_repository_snapshot(repo: Path, ledger: dict[str, Any], remote_name: str) -> None:
    source = ledger["source"]
    current_git = _git_snapshot(repo, remote_name)
    for field in ("branch", "head", "clean", "statusSha256", "remoteName",
                  "remoteIdentitySha256", "remoteMain"):
        if current_git[field] != source[field]:
            raise _fail(f"blog repository {field} drifted after inventory scan")
    base, _config, config_raw = _base_url(repo)
    hugo_urls, hugo_published, hugo_runtime = _hugo_page_snapshot(repo, base)
    if base != source["baseUrl"] or sha256_bytes(config_raw) != source["hugoConfig"]["sha256"]:
        raise _fail("blog Hugo configuration drifted after inventory scan")
    if hugo_runtime != source["hugoRuntime"]:
        raise _fail("blog Hugo runtime/page-set proof drifted after inventory scan")
    object_format, tree_oid, tracked = _tracked_markdown(repo)
    if (object_format != source["gitObjectFormat"] or tree_oid != source["contentTreeOid"]
            or len(tracked) != source["trackedPages"]["count"]
            or stable_hash(tracked) != source["trackedPages"]["setSha256"]):
        raise _fail("blog tracked page/tree proof drifted after inventory scan")
    expected = {page["path"]: page for page in ledger["pages"]}
    paths = _markdown_paths(repo)
    if [path.relative_to(repo).as_posix() for path in paths] != sorted(expected):
        raise _fail("blog Markdown page set drifted after inventory scan")
    for path in paths:
        relative = path.relative_to(repo).as_posix()
        raw = _read_regular(path, MAX_MARKDOWN_BYTES, "Markdown page")
        page = expected[relative]
        if (sha256_bytes(raw) != page["contentSha256"]
                or _git_blob_oid(raw, object_format) != page["gitBlobOid"]
                or hugo_urls.get(relative) != page["primaryUrl"]
                or (relative in hugo_published) != page["published"]):
            raise _fail(f"blog page bytes drifted after inventory scan: {relative}")


def scan_historical_pages(blog_repo: Path, *, require_clean_main: bool = False,
                          remote_name: str = "origin",
                          after_scan_hook: Callable[[], None] | None = None) -> dict[str, Any]:
    """Build and self-validate one immutable snapshot without writing output."""
    repo = _safe_directory(Path(blog_repo))
    before = _git_snapshot(repo, remote_name)
    if require_clean_main and (before["branch"] != "main" or not before["clean"]):
        raise _fail("apply requires the blog repository on clean branch main")
    base, _config, config_raw = _base_url(repo)
    hugo_urls, hugo_published, hugo_runtime = _hugo_page_snapshot(repo, base)
    object_format, content_tree_oid, tracked_pages = _tracked_markdown(repo)
    tracked_by_path = {item["path"]: item["blobOid"] for item in tracked_pages}
    markdown_paths = _markdown_paths(repo)
    markdown_names = [path.relative_to(repo).as_posix() for path in markdown_paths]
    if markdown_names != sorted(tracked_by_path):
        raise _fail("content/posts Markdown pages must exactly equal the normal tracked Git page set")
    if markdown_names != sorted(hugo_urls):
        raise _fail("tracked Markdown page set differs from Hugo all-page inventory")
    pages = []
    initial_sha = {}
    for path in markdown_paths:
        raw = _read_regular(path, MAX_MARKDOWN_BYTES, "Markdown page")
        relative = path.relative_to(repo).as_posix()
        initial_sha[relative] = sha256_bytes(raw)
        blob_oid = _git_blob_oid(raw, object_format)
        page = _page_record(repo, path, raw, base, blob_oid, hugo_urls[relative], relative in hugo_published)
        if blob_oid != tracked_by_path[relative]:
            raise _fail(f"working page bytes do not equal the tracked Git blob: {relative}")
        pages.append(page)
    if not pages:
        raise _fail("content/posts contains no Markdown pages")
    if after_scan_hook:
        after_scan_hook()
    final_sha = _page_sha_map(repo)
    _base_after, _config_after, config_raw_after = _base_url(repo)
    after = _git_snapshot(repo, remote_name)
    after_format, after_tree_oid, tracked_after = _tracked_markdown(repo)
    hugo_urls_after, hugo_published_after, hugo_runtime_after = _hugo_page_snapshot(repo, base)
    if (before != after or initial_sha != final_sha or config_raw != config_raw_after
            or base != _base_after or object_format != after_format
            or content_tree_oid != after_tree_oid or tracked_pages != tracked_after
            or hugo_urls != hugo_urls_after or hugo_published != hugo_published_after
            or hugo_runtime != hugo_runtime_after):
        raise _fail("blog HEAD/status/config/pages drifted during inventory scan")
    _resolve_links(pages)
    collisions = _url_collisions(pages)
    outbound_links = [{"sourcePageId": page["pageId"], "sourcePath": page["path"], **target}
                      for page in pages for target in page["outboundPostLinks"]]
    counts = {"pages": len(pages), "papers": sum(page["kind"] == "paper" for page in pages),
              "dailySummaries": sum(page["kind"] == "daily-summary" for page in pages),
              "conferenceSummaries": sum(page["kind"] == "conference-summary" for page in pages),
              "conferenceTasks": sum(page["kind"] == "conference-task" for page in pages),
              "unknown": sum(page["kind"] == "unknown" for page in pages),
              "urlCollisions": len(collisions), "outboundPostLinks": len(outbound_links),
              "resolvedOutboundPostLinks": sum(item["status"] == "resolved" for item in outbound_links),
              "unresolvedOutboundPostLinks": sum(item["status"] == "unresolved" for item in outbound_links),
              "ambiguousOutboundPostLinks": sum(item["status"] == "ambiguous" for item in outbound_links)}
    source = {**before, "baseUrl": base, "hugoConfig": {"path": "hugo.yaml",
        "sha256": sha256_bytes(config_raw)}, "contentRoot": "content/posts",
        "hugoRuntime": hugo_runtime,
        "gitObjectFormat": object_format, "contentTreeOid": content_tree_oid,
        "trackedPages": {"count": len(tracked_pages), "setSha256": stable_hash(tracked_pages)}}
    policy = dict(SCAN_POLICY)
    body = {"contract": LEDGER_CONTRACT, "version": VERSION, "source": source,
            "policy": policy, "pages": pages, "urlCollisions": collisions,
            "outboundPostLinks": outbound_links, "outboundPostLinksSha256": stable_hash(outbound_links),
            "counts": counts, "pageSetSha256": stable_hash(pages)}
    ledger = {**body, "ledgerSha256": stable_hash(body)}
    return validate_ledger(ledger)


def validate_ledger(value: Any) -> dict[str, Any]:
    value = _exact(value, {"contract", "version", "source", "policy", "pages", "urlCollisions",
                           "outboundPostLinks", "outboundPostLinksSha256", "counts", "pageSetSha256",
                           "ledgerSha256"}, "historical page ledger")
    if value["contract"] != LEDGER_CONTRACT or value["version"] != VERSION:
        raise _fail("historical page ledger contract/version is unsupported")
    source = _exact(value["source"], {"branch", "head", "clean", "statusSha256", "remoteName",
                                     "remoteIdentitySha256", "remoteMain", "baseUrl", "hugoConfig",
                                     "contentRoot", "hugoRuntime", "gitObjectFormat", "contentTreeOid", "trackedPages"},
                    "ledger source")
    _safe_text(source["branch"], "source.branch")
    if not isinstance(source["head"], str) or not GIT_OID_RE.fullmatch(source["head"]):
        raise _fail("source.head is not a Git OID")
    if not isinstance(source["clean"], bool):
        raise _fail("source.clean must be boolean")
    for field in ("statusSha256", "remoteIdentitySha256"):
        _sha(source[field], f"source.{field}")
    remote_main = _exact(source["remoteMain"], {"availability", "oid", "ref"}, "source.remoteMain")
    expected_ref = f"refs/remotes/{source['remoteName']}/main"
    if remote_main["availability"] not in ("available", "unavailable") or remote_main["ref"] != expected_ref:
        raise _fail("source.remoteMain is malformed")
    if remote_main["availability"] == "available":
        if not isinstance(remote_main["oid"], str) or not GIT_OID_RE.fullmatch(remote_main["oid"]):
            raise _fail("source.remoteMain available OID is malformed")
    elif remote_main["oid"] is not None:
        raise _fail("source.remoteMain unavailable state must have oid=null")
    _safe_text(source["remoteName"], "source.remoteName")
    _safe_text(source["baseUrl"], "source.baseUrl")
    if _canonical_blog_url(source["baseUrl"], source["baseUrl"]) != source["baseUrl"]:
        raise _fail("source.baseUrl is not canonical")
    if source["contentRoot"] != "content/posts":
        raise _fail("source.contentRoot is unsupported")
    if source["gitObjectFormat"] not in ("sha1", "sha256"):
        raise _fail("source.gitObjectFormat is unsupported")
    expected_oid_length = 40 if source["gitObjectFormat"] == "sha1" else 64
    if not isinstance(source["contentTreeOid"], str) or len(source["contentTreeOid"]) != expected_oid_length \
            or not GIT_OID_RE.fullmatch(source["contentTreeOid"]):
        raise _fail("source.contentTreeOid is malformed")
    tracked = _exact(source["trackedPages"], {"count", "setSha256"}, "source.trackedPages")
    if not isinstance(tracked["count"], int) or isinstance(tracked["count"], bool) or tracked["count"] < 1:
        raise _fail("source.trackedPages.count is invalid")
    _sha(tracked["setSha256"], "source.trackedPages.setSha256")
    config = _exact(source["hugoConfig"], {"path", "sha256"}, "source.hugoConfig")
    if config["path"] != "hugo.yaml":
        raise _fail("source Hugo config path is unsupported")
    _sha(config["sha256"], "source.hugoConfig.sha256")
    hugo_runtime = _exact(source["hugoRuntime"], {"version", "pageSetSha256", "publishedPageSetSha256",
                                                  "pageCount", "publishedPageCount"}, "source.hugoRuntime")
    _safe_text(hugo_runtime["version"], "source.hugoRuntime.version", 500)
    for field in ("pageSetSha256", "publishedPageSetSha256"):
        _sha(hugo_runtime[field], f"source.hugoRuntime.{field}")
    for field in ("pageCount", "publishedPageCount"):
        if not isinstance(hugo_runtime[field], int) or isinstance(hugo_runtime[field], bool) or hugo_runtime[field] < 0:
            raise _fail(f"source.hugoRuntime.{field} is invalid")
    _exact(value["policy"], set(SCAN_POLICY), "scan policy")
    if value["policy"] != SCAN_POLICY:
        raise _fail("scan policy differs from supported v2")
    if not isinstance(value["pages"], list) or not value["pages"]:
        raise _fail("ledger pages must be non-empty")
    paths = []
    for index, page in enumerate(value["pages"]):
        _validate_page(page, index)
        for field in (page["primaryUrl"], *page["aliases"],
                      *(link["targetUrl"] for link in page["outboundPostLinks"])):
            if _canonical_blog_url(field, source["baseUrl"]) != field:
                raise _fail(f"pages[{index}] contains a noncanonical blog URL")
        posts_prefix = unquote(urlsplit(source["baseUrl"]).path).rstrip("/") + "/posts/"
        if not unquote(urlsplit(page["primaryUrl"]).path).startswith(posts_prefix):
            raise _fail(f"pages[{index}].primaryUrl is outside the posts route")
        if any(not unquote(urlsplit(link["targetUrl"]).path).startswith(posts_prefix)
               for link in page["outboundPostLinks"]):
            raise _fail(f"pages[{index}] outbound link is outside the posts route")
        expected_candidates = _taxonomy_candidates(page["legacy"]["tags"], page["legacy"]["categories"],
                                                   source["baseUrl"])
        if page["legacyTaxonomyCandidates"] != expected_candidates:
            raise _fail(f"pages[{index}] legacy taxonomy candidates drifted")
        paths.append(page["path"])
    if paths != sorted(paths) or len(set(paths)) != len(paths):
        raise _fail("ledger page paths must be unique and sorted")
    if hugo_runtime["pageCount"] != len(value["pages"]) or hugo_runtime["publishedPageCount"] != sum(
            page["published"] is True for page in value["pages"]):
        raise _fail("source Hugo page counts drifted from ledger pages")
    hugo_pages = [{"path": page["path"], "permalink": page["primaryUrl"]} for page in value["pages"]]
    hugo_published_pages = [item for item, page in zip(hugo_pages, value["pages"]) if page["published"]]
    if (hugo_runtime["pageSetSha256"] != stable_hash(hugo_pages)
            or hugo_runtime["publishedPageSetSha256"] != stable_hash(hugo_published_pages)):
        raise _fail("source Hugo page-set SHA drifted from ledger pages")
    if _sha(value["pageSetSha256"], "pageSetSha256") != stable_hash(value["pages"]):
        raise _fail("pageSetSha256 drifted")
    tracked_records = [{"path": page["path"], "blobOid": page["gitBlobOid"]} for page in value["pages"]]
    if tracked["count"] != len(tracked_records) or tracked["setSha256"] != stable_hash(tracked_records):
        raise _fail("source tracked page proof does not bind ledger pages")
    expected_collisions = _url_collisions(value["pages"])
    if value["urlCollisions"] != expected_collisions:
        raise _fail("URL collision index drifted")
    claims: dict[str, list[dict[str, Any]]] = {}
    for page in value["pages"]:
        for url in [page["primaryUrl"], *page["aliases"]]:
            claims.setdefault(url, []).append(page)
    for page in value["pages"]:
        for link in page["outboundPostLinks"]:
            targets = {target["pageId"]: target for target in claims.get(link["targetUrl"], [])}
            expected_status = "resolved" if len(targets) == 1 else "ambiguous" if targets else "unresolved"
            if link["status"] != expected_status:
                raise _fail("outbound link resolution status drifted")
            if expected_status == "resolved":
                target = next(iter(targets.values()))
                if (link["targetPath"] != target["path"] or link["targetPageId"] != target["pageId"]
                        or link["targetRecordSha256"] != target["snapshotSha256"]):
                    raise _fail("resolved outbound link target binding drifted")
            elif any(link[field] is not None for field in ("targetPath", "targetPageId", "targetRecordSha256")):
                raise _fail("unresolved/ambiguous outbound link must not claim a target page")
    expected_outbound = [{"sourcePageId": page["pageId"], "sourcePath": page["path"], **target}
                         for page in value["pages"] for target in page["outboundPostLinks"]]
    if value["outboundPostLinks"] != expected_outbound:
        raise _fail("aggregate outbound post link index drifted")
    if _sha(value["outboundPostLinksSha256"], "outboundPostLinksSha256") != stable_hash(expected_outbound):
        raise _fail("outboundPostLinksSha256 drifted")
    counts = _exact(value["counts"], {"pages", "papers", "dailySummaries", "conferenceSummaries",
                                     "conferenceTasks", "unknown", "urlCollisions", "outboundPostLinks",
                                     "resolvedOutboundPostLinks", "unresolvedOutboundPostLinks",
                                     "ambiguousOutboundPostLinks"},
                    "ledger counts")
    if any(not isinstance(amount, int) or isinstance(amount, bool) or amount < 0 for amount in counts.values()):
        raise _fail("ledger counts must be nonnegative integers")
    expected_counts = {"pages": len(value["pages"]),
        "papers": sum(page["kind"] == "paper" for page in value["pages"]),
        "dailySummaries": sum(page["kind"] == "daily-summary" for page in value["pages"]),
        "conferenceSummaries": sum(page["kind"] == "conference-summary" for page in value["pages"]),
        "conferenceTasks": sum(page["kind"] == "conference-task" for page in value["pages"]),
        "unknown": sum(page["kind"] == "unknown" for page in value["pages"]),
        "urlCollisions": len(expected_collisions), "outboundPostLinks": len(expected_outbound),
        "resolvedOutboundPostLinks": sum(item["status"] == "resolved" for item in expected_outbound),
        "unresolvedOutboundPostLinks": sum(item["status"] == "unresolved" for item in expected_outbound),
        "ambiguousOutboundPostLinks": sum(item["status"] == "ambiguous" for item in expected_outbound)}
    if counts != expected_counts:
        raise _fail("ledger counts drifted")
    body = dict(value); body.pop("ledgerSha256")
    if _sha(value["ledgerSha256"], "ledgerSha256") != stable_hash(body):
        raise _fail("ledgerSha256 drifted")
    return _json_value(value)


def _validate_page(page: Any, index: int) -> None:
    page = _exact(page, {"pageId", "path", "gitBlobOid", "contentBytes", "contentSha256",
                         "frontmatterBytes", "frontmatterSha256", "bodyBytes", "bodySha256",
                         "primaryUrl", "aliases", "kind", "scope",
                         "publishedDate", "cohortDate", "legacyTaskKey", "draft", "published",
                         "legacy", "identityHints", "outboundPostLinks", "publicationEvidenceRefs",
                         "legacyTaxonomyCandidates", "snapshotSha256", "recordSha256"}, f"pages[{index}]")
    _safe_text(page["path"], f"pages[{index}].path")
    if (Path(page["path"]).is_absolute() or "\\" in page["path"]
            or any(part in ("", ".", "..") for part in page["path"].split("/"))
            or not page["path"].startswith("content/posts/") or not page["path"].endswith(".md")):
        raise _fail(f"pages[{index}].path is unsafe")
    if not isinstance(page["contentBytes"], int) or isinstance(page["contentBytes"], bool) or page["contentBytes"] < 1:
        raise _fail(f"pages[{index}].contentBytes is invalid")
    if (not isinstance(page["frontmatterBytes"], int) or isinstance(page["frontmatterBytes"], bool)
            or not isinstance(page["bodyBytes"], int) or isinstance(page["bodyBytes"], bool)
            or page["frontmatterBytes"] < 1 or page["bodyBytes"] < 0
            or page["frontmatterBytes"] + page["bodyBytes"] != page["contentBytes"]):
        raise _fail(f"pages[{index}] frontmatter/body byte partition is invalid")
    if not isinstance(page["pageId"], str) or not re.fullmatch(r"page:[a-f0-9]{64}", page["pageId"]):
        raise _fail(f"pages[{index}].pageId is invalid")
    if not isinstance(page["gitBlobOid"], str) or not GIT_OID_RE.fullmatch(page["gitBlobOid"]):
        raise _fail(f"pages[{index}].gitBlobOid is invalid")
    for field in ("contentSha256", "frontmatterSha256", "bodySha256"):
        _sha(page[field], f"pages[{index}].{field}")
    _safe_text(page["primaryUrl"], f"pages[{index}].primaryUrl")
    expected_page_id = f"page:{stable_hash({'contract': PAGE_ID_CONTRACT, 'path': page['path'], 'primaryUrl': page['primaryUrl']})}"
    if page["pageId"] != expected_page_id:
        raise _fail(f"pages[{index}].pageId does not bind path and primaryUrl")
    if (not isinstance(page["aliases"], list) or any(not isinstance(item, str) for item in page["aliases"])
            or page["aliases"] != sorted(set(page["aliases"]))):
        raise _fail(f"pages[{index}].aliases must be unique and sorted")
    if page["kind"] not in {"paper", "daily-summary", "conference-summary", "conference-task", "unknown"}:
        raise _fail(f"pages[{index}].kind is unsupported")
    scope = _exact(page["scope"], {"type", "key"}, f"pages[{index}].scope")
    if scope["type"] not in {"daily", "conference", "unknown", "conflict"}:
        raise _fail(f"pages[{index}].scope.type is unsupported")
    if scope["type"] == "daily":
        if not isinstance(scope["key"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", scope["key"]):
            raise _fail(f"pages[{index}].scope daily key is invalid")
        try: date.fromisoformat(scope["key"])
        except ValueError as exc: raise _fail(f"pages[{index}].scope daily key is invalid") from exc
    elif scope["type"] == "conference":
        if not isinstance(scope["key"], str) or not CONFERENCE_RE.fullmatch(scope["key"]):
            raise _fail(f"pages[{index}].scope conference key is invalid")
    elif scope["key"] is not None:
        raise _fail(f"pages[{index}].scope key must be null for unknown/conflict")
    for field in ("publishedDate", "cohortDate"):
        if not isinstance(page[field], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", page[field]):
            raise _fail(f"pages[{index}].{field} is invalid")
        try: date.fromisoformat(page[field])
        except ValueError as exc: raise _fail(f"pages[{index}].{field} is invalid") from exc
    if page["legacyTaskKey"] is not None and (not isinstance(page["legacyTaskKey"], str)
            or not re.fullmatch(r"task-[a-z0-9._-]+", page["legacyTaskKey"])):
        raise _fail(f"pages[{index}].legacyTaskKey is invalid")
    if not isinstance(page["draft"], bool) or not isinstance(page["published"], bool):
        raise _fail(f"pages[{index}] draft/published state is malformed")
    legacy = _exact(page["legacy"], {"tags", "categories", "marker"}, f"pages[{index}].legacy")
    for field in ("tags", "categories"):
        if not isinstance(legacy[field], list) or any(not isinstance(item, str) for item in legacy[field]):
            raise _fail(f"pages[{index}].legacy.{field} is invalid")
    marker = _exact(legacy["marker"], {"pipelineOwned", "declaredPageType", "fieldNames", "fieldsSha256"},
                    f"pages[{index}].legacy.marker")
    if marker["pipelineOwned"] is not None and not isinstance(marker["pipelineOwned"], bool) \
            or marker["declaredPageType"] is not None \
            and not isinstance(marker["declaredPageType"], str):
        raise _fail(f"pages[{index}].legacy.marker is invalid")
    if (not isinstance(marker["fieldNames"], list)
            or any(not isinstance(field, str) or not field.startswith("paper_digest_") for field in marker["fieldNames"])
            or marker["fieldNames"] != sorted(set(marker["fieldNames"]))):
        raise _fail(f"pages[{index}].legacy.marker.fieldNames is invalid")
    _sha(marker["fieldsSha256"], f"pages[{index}].legacy.marker.fieldsSha256")
    hints = _exact(page["identityHints"], {"status", "candidates"}, f"pages[{index}].identityHints")
    if hints["status"] not in {"none", "single", "multiple", "conflict"} or not isinstance(hints["candidates"], list):
        raise _fail(f"pages[{index}].identityHints is invalid")
    candidate_order = []
    by_scheme: dict[str, set[str]] = {}
    for candidate in hints["candidates"]:
        _exact(candidate, {"scheme", "value", "sources"}, "identity candidate")
        _safe_text(candidate["scheme"], "identity scheme"); _safe_text(candidate["value"], "identity value")
        if (not isinstance(candidate["sources"], list)
                or any(not isinstance(source, str) or not source for source in candidate["sources"])
                or candidate["sources"] != sorted(set(candidate["sources"]))):
            raise _fail("identity candidate sources are invalid")
        if candidate["scheme"] == "arxiv" and not re.fullmatch(r"\d{4}\.\d{4,5}", candidate["value"]):
            raise _fail("arXiv identity candidate is malformed")
        if candidate["scheme"] == "openreview-forum-id" and not re.fullmatch(r"[A-Za-z0-9_-]{6,128}", candidate["value"]):
            raise _fail("OpenReview identity candidate is malformed")
        if candidate["scheme"] == "icassp-arnumber" and not re.fullmatch(r"[1-9]\d*", candidate["value"]):
            raise _fail("ICASSP identity candidate is malformed")
        if candidate["scheme"] not in {"arxiv", "openreview-forum-id", "icassp-arnumber"}:
            raise _fail("identity candidate scheme is unsupported")
        candidate_order.append((candidate["scheme"], candidate["value"]))
        by_scheme.setdefault(candidate["scheme"], set()).add(candidate["value"])
    if candidate_order != sorted(set(candidate_order)):
        raise _fail("identity candidates must be unique and sorted")
    expected_hint_status = ("none" if not candidate_order else "conflict"
                            if any(len(values) > 1 for values in by_scheme.values())
                            else "single" if len(candidate_order) == 1 else "multiple")
    if hints["status"] != expected_hint_status:
        raise _fail(f"pages[{index}].identityHints.status drifted")
    if not isinstance(page["outboundPostLinks"], list):
        raise _fail(f"pages[{index}].outboundPostLinks must be an array")
    for link_index, link in enumerate(page["outboundPostLinks"]):
        _exact(link, {"ordinal", "linkType", "sourceByteStart", "sourceByteEnd", "targetRawSha256",
                      "targetUrl", "status", "targetPath", "targetPageId", "targetRecordSha256"},
               f"pages[{index}].outboundPostLinks[{link_index}]")
        if link["ordinal"] != link_index + 1 or link["linkType"] not in LINK_TYPES:
            raise _fail("outbound link ordinal/type is invalid")
        if (not isinstance(link["sourceByteStart"], int) or isinstance(link["sourceByteStart"], bool)
                or not isinstance(link["sourceByteEnd"], int) or isinstance(link["sourceByteEnd"], bool)
                or link["sourceByteStart"] < 0 or link["sourceByteEnd"] <= link["sourceByteStart"]
                or link["sourceByteEnd"] > page["bodyBytes"]):
            raise _fail("outbound link byte occurrence is invalid")
        _sha(link["targetRawSha256"], "outbound link raw target SHA")
        _safe_text(link["targetUrl"], "outbound link targetUrl")
        if link["status"] not in LINK_STATUSES:
            raise _fail("outbound link status is unsupported")
        for field in ("targetPath", "targetPageId", "targetRecordSha256"):
            if link[field] is not None and not isinstance(link[field], str):
                raise _fail("outbound link target binding is malformed")
    if not isinstance(page["publicationEvidenceRefs"], list):
        raise _fail(f"pages[{index}] publication evidence must be an array")
    evidence_fields = []
    allowed_types = {"null", "boolean", "integer", "number", "string", "array", "object"}
    for evidence in page["publicationEvidenceRefs"]:
        _exact(evidence, {"field", "valueType", "value", "valueSha256"}, "publication evidence reference")
        field = _safe_text(evidence["field"], "publication evidence field")
        if field not in PUBLICATION_EVIDENCE_FIELDS:
            raise _fail("publication evidence field is unsupported")
        if evidence["valueType"] not in allowed_types:
            raise _fail("publication evidence valueType is unsupported")
        _sha(evidence["valueSha256"], "publication evidence valueSha256")
        if evidence["valueType"] == "string":
            if field in PRESERVED_PUBLICATION_STRING_FIELDS:
                if not isinstance(evidence["value"], str) \
                        or _preserved_publication_string(field, evidence["value"]) != evidence["value"]:
                    raise _fail("preserved publication string does not match its field schema")
            elif evidence["value"] is not None:
                raise _fail("publication strings outside the preserved enum/ID set must be hash-only")
        elif evidence["valueType"] in {"array", "object"}:
            if evidence["value"] is not None:
                raise _fail("structured publication evidence, including sidecars, must be hash-only")
        elif evidence["valueType"] == "null":
            if evidence["value"] is not None:
                raise _fail("null publication evidence must preserve null")
        elif evidence["valueType"] == "boolean":
            if not isinstance(evidence["value"], bool):
                raise _fail("boolean publication evidence has the wrong value type")
        elif evidence["valueType"] == "integer":
            if not isinstance(evidence["value"], int) or isinstance(evidence["value"], bool):
                raise _fail("integer publication evidence has the wrong value type")
        elif evidence["valueType"] == "number":
            if not isinstance(evidence["value"], float):
                raise _fail("number publication evidence has the wrong value type")
        if evidence["value"] is not None or evidence["valueType"] == "null":
            if stable_hash(evidence["value"]) != evidence["valueSha256"]:
                raise _fail("publication evidence preserved value SHA drifted")
        evidence_fields.append(field)
    if evidence_fields != sorted(set(evidence_fields)):
        raise _fail("publication evidence fields must be unique and sorted")
    if not isinstance(page["legacyTaxonomyCandidates"], list):
        raise _fail("legacy taxonomy candidates must be an array")
    for candidate in page["legacyTaxonomyCandidates"]:
        _exact(candidate, {"taxonomy", "term", "status", "candidateUrl", "method"},
               "legacy taxonomy candidate")
        if candidate["taxonomy"] not in {"tags", "categories"} or candidate["status"] != "unverified" \
                or candidate["method"] != "legacy-term-normalization-v1":
            raise _fail("legacy taxonomy candidate is unsupported")
        _safe_text(candidate["term"], "legacy taxonomy term")
        _safe_text(candidate["candidateUrl"], "legacy taxonomy candidate URL")
    snapshot_body = _page_snapshot_body(page)
    if _sha(page["snapshotSha256"], f"pages[{index}].snapshotSha256") != stable_hash(snapshot_body):
        raise _fail(f"pages[{index}].snapshotSha256 drifted")
    body = dict(page); body.pop("recordSha256")
    if _sha(page["recordSha256"], f"pages[{index}].recordSha256") != stable_hash(body):
        raise _fail(f"pages[{index}].recordSha256 drifted")


def build_receipt(ledger: dict[str, Any], ledger_name: str) -> tuple[bytes, dict[str, Any], bytes]:
    checked = validate_ledger(ledger)
    if not isinstance(ledger_name, str) or not SAFE_JSON_NAME.fullmatch(ledger_name):
        raise _fail("ledger output name must be a safe direct JSON filename")
    ledger_bytes = encoded_json(checked)
    body = {"contract": RECEIPT_CONTRACT, "version": VERSION,
            "ledger": {"name": ledger_name, "fileSha256": sha256_bytes(ledger_bytes),
                       "ledgerSha256": checked["ledgerSha256"],
                       "pageSetSha256": checked["pageSetSha256"], "pageCount": len(checked["pages"])},
            "repositorySnapshotSha256": stable_hash(checked["source"])}
    receipt = {**body, "receiptSha256": stable_hash(body)}
    return ledger_bytes, receipt, encoded_json(receipt)


def validate_receipt(value: Any, ledger: dict[str, Any], ledger_bytes: bytes, ledger_name: str) -> dict[str, Any]:
    checked = validate_ledger(ledger)
    value = _exact(value, {"contract", "version", "ledger", "repositorySnapshotSha256", "receiptSha256"},
                   "historical page receipt")
    if value["contract"] != RECEIPT_CONTRACT or value["version"] != VERSION:
        raise _fail("historical page receipt contract/version is unsupported")
    bound = _exact(value["ledger"], {"name", "fileSha256", "ledgerSha256", "pageSetSha256", "pageCount"},
                   "receipt ledger binding")
    if not isinstance(bound["pageCount"], int) or isinstance(bound["pageCount"], bool) or bound["pageCount"] < 1:
        raise _fail("receipt ledger pageCount must be a positive integer")
    if (bound["name"] != ledger_name or bound["fileSha256"] != sha256_bytes(ledger_bytes)
            or bound["ledgerSha256"] != checked["ledgerSha256"]
            or bound["pageSetSha256"] != checked["pageSetSha256"]
            or bound["pageCount"] != len(checked["pages"])):
        raise _fail("receipt does not bind the exact ledger file/content")
    if _sha(value["repositorySnapshotSha256"], "repositorySnapshotSha256") != stable_hash(checked["source"]):
        raise _fail("receipt repository snapshot binding drifted")
    body = dict(value); body.pop("receiptSha256")
    if _sha(value["receiptSha256"], "receiptSha256") != stable_hash(body):
        raise _fail("receiptSha256 drifted")
    return _json_value(value)


def _strict_json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        text = raw.decode("utf-8", errors="strict")

        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"duplicate key: {key}")
                result[key] = value
            return result

        value = json.loads(text, object_pairs_hook=unique)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise _fail(f"{label} must be strict UTF-8 JSON without duplicate keys") from exc
    if not isinstance(value, dict):
        raise _fail(f"{label} must contain a JSON object")
    return value


def write_inventory_pair(output_dir: Path, ledger_name: str, receipt_name: str,
                         ledger: dict[str, Any], *, expected_repo: Path,
                         remote_name: str = "origin",
                         after_reservation_hook: Callable[[], None] | None = None) -> dict[str, str]:
    if (not isinstance(receipt_name, str) or not SAFE_JSON_NAME.fullmatch(receipt_name)
            or receipt_name == ledger_name):
        raise _fail("receipt output name must be a different safe direct JSON filename")
    ledger_bytes, receipt, receipt_bytes = build_receipt(ledger, ledger_name)
    checked_repo = _safe_directory(Path(expected_repo))
    _assert_repository_snapshot(checked_repo, ledger, remote_name)
    root = _safe_directory(Path(output_dir), create=True)
    ledger_path = root / ledger_name; receipt_path = root / receipt_name
    opened: list[tuple[Path, int]] = []
    try:
        for target in (ledger_path, receipt_path):
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            opened.append((target, fd))
        if after_reservation_hook:
            after_reservation_hook()
        _assert_repository_snapshot(checked_repo, ledger, remote_name)
        for (_path, fd), payload in zip(opened, (ledger_bytes, receipt_bytes)):
            written = 0
            while written < len(payload):
                count = os.write(fd, payload[written:])
                if count <= 0:
                    raise OSError("short write")
                written += count
            os.fsync(fd); os.fchmod(fd, 0o600)
        _assert_repository_snapshot(checked_repo, ledger, remote_name)
    except Exception:
        for _path, fd in opened:
            try: os.close(fd)
            except OSError: pass
        for target, _fd in opened:
            try: target.unlink()
            except OSError: pass
        raise
    else:
        for _path, fd in opened:
            os.close(fd)
    directory_fd = os.open(root, os.O_RDONLY)
    try: os.fsync(directory_fd)
    finally: os.close(directory_fd)
    try:
        load_inventory_pair(ledger_path, receipt_path)
    except Exception:
        for target in (ledger_path, receipt_path):
            try: target.unlink()
            except OSError: pass
        raise
    return {"ledger": str(ledger_path), "receipt": str(receipt_path)}


def load_inventory_pair(ledger_path: Path, receipt_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    ledger_path = Path(ledger_path); receipt_path = Path(receipt_path)
    if ledger_path.parent.resolve() != receipt_path.parent.resolve():
        raise _fail("ledger and receipt must share one directory")
    ledger_raw = _read_regular(ledger_path, MAX_MARKDOWN_BYTES, "historical page ledger")
    receipt_raw = _read_regular(receipt_path, MAX_CONFIG_BYTES, "historical page receipt")
    ledger = validate_ledger(_strict_json(ledger_raw, "historical page ledger"))
    if encoded_json(ledger) != ledger_raw:
        raise _fail("historical page ledger bytes are not canonical")
    receipt = _strict_json(receipt_raw, "historical page receipt")
    checked_receipt = validate_receipt(receipt, ledger, ledger_raw, ledger_path.name)
    if encoded_json(checked_receipt) != receipt_raw:
        raise _fail("historical page receipt bytes are not canonical")
    return ledger, checked_receipt


__all__ = [
    "DEFAULT_OUTPUT_DIR", "HistoricalPageInventoryError", "LEDGER_CONTRACT", "RECEIPT_CONTRACT",
    "VERSION", "build_receipt", "encoded_json", "load_inventory_pair", "scan_historical_pages",
    "sha256_bytes", "stable_hash", "validate_ledger", "validate_receipt", "write_inventory_pair",
]


if __name__ == "__main__":
    from runtime_guard import require_external_runtime
    require_external_runtime("historical_page_scan.py")
    print("Historical page scan library; use history-inventory.py.")
