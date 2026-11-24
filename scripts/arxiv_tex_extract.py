#!/usr/bin/env python3
"""Safe arXiv /e-print/<id> TeX source archive unpacker and AST extractor.

Contract: ``arxiv-tex-ast-v1``

Security properties enforced fail-closed:
- Pure in-memory archive unpacking (no temp files or filesystem extraction gadgets).
- Rejects Zip-Slip / path traversal (``..``, absolute paths, drive letters even after ``./``,
  backslashes, NUL bytes, lone surrogates, control chars, bidi overrides, NFKC bypasses).
- Rejects symlinks, hardlinks, FIFOs, character/block devices, sparse members, and corrupt/hostile PAX headers.
- Enforces strict bounds on compressed archive bytes (32 MiB), member count (256),
  uncompressed bytes (64 MiB, streaming anti-gzip-bomb), and single ``.tex`` file size (4 MiB).
- Single-pass O(n) LaTeXpOsEd comment defense: protects verbatim/\\verb code regions, handles
  TeX ``%`` line-continuation (preserving ``\\%``), strips ``\\begin{comment}...\\end{comment}``
  and nested ``\\iffalse...\\fi`` fail-closed BEFORE ``\\input`` expansion or AST extraction.
- Bounded ``\\input``/``\\include`` resolution (max depth 6, cycle detection, root containment,
  max 512 total expansion directives, max 2 MiB expanded chars) and same-length macro definition
  masking with O(n) precomputed delimiter maps and single-pass environment stacks (zero ReDoS).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import unicodedata
import uuid
from pathlib import Path
from typing import Any

TEX_AST_CONTRACT = "arxiv-tex-ast-v1"

DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
DEFAULT_MAX_MEMBERS = 256
DEFAULT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_SINGLE_TEX_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_INPUT_DEPTH = 6
DEFAULT_MAX_INPUT_EXPANSIONS = 512
DEFAULT_MAX_EXPANDED_CHARS = 2 * 1024 * 1024

_MAX_MULTICOLUMN_SPAN = 64
_MAX_DEF_PARAM_CHARS = 64
_CHUNK_SIZE = 65536

_ARXIV_ID_RE = re.compile(r"^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v[1-9]\d*)?$", re.IGNORECASE)
_DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:")
_TEX_EXTS = (".tex", ".ltx")
_TEXT_SIDECAR_EXTS = (".tex", ".ltx", ".bbl", ".bib", ".sty", ".cls", ".def", ".inc")
_VERBATIM_ENVS = frozenset({"verbatim", "verbatim*", "lstlisting", "minted"})
_CANONICAL_ROOT_NAMES = (
    "main.tex",
    "paper.tex",
    "ms.tex",
    "article.tex",
    "manuscript.tex",
    "root.tex",
    "arxiv.tex",
)
_FOOTNOTE_ONLY_MARKERS = frozenset({
    "*", "ast", "\\ast",
    "dagger", "\\dagger", "ddagger", "\\ddagger",
    "dag", "\\dag", "ddag", "\\ddag",
    "†", "‡", "star", "\\star", "§", "¶", "\\S", "\\P",
})
_BIDI_AND_FORBIDDEN_CHARS = frozenset({
    "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
    "\u2066", "\u2067", "\u2068", "\u2069",
    "\u200e", "\u200f", "\u061c",
})

_MARKER_COMMANDS = frozenset({
    "textsuperscript", "IEEEauthorrefmark", "inst",
    "affmark", "fnref", "corref", "altaffilmark",
})
_NON_FI_IF_COMMANDS = frozenset({
    "iff", "ifthenelse", "ifstrequal", "ifstrempty", "ifblank",
    "ifdef", "ifundef", "ifcsdef", "ifcsundef", "ifboolexpr",
    "ifbool", "iftoggle", "ifnumcomp", "ifdimcomp", "ifnumequal",
    "ifdimequal", "ifdimgreater", "ifdimless", "ifnumgreater",
    "ifnumless", "ifstreq", "ifcsvoid", "ifdefvoid", "ifdefempty",
    "ifdefstring", "ifcsstring", "ifstartswith", "ifendswith", "ifsubstr",
})
_BIB_ENTRY_RE = re.compile(
    r"^[ \t]*@(?!comment\b|preamble\b|string\b)[A-Za-z]+[ \t]*[{(]",
    re.IGNORECASE | re.MULTILINE,
)

_LATEX_ACCENTS = {
    "'": {"a": "á", "e": "é", "i": "í", "o": "ó", "u": "ú", "y": "ý", "c": "ć", "n": "ń", "s": "ś", "z": "ź",
          "A": "Á", "E": "É", "I": "Í", "O": "Ó", "U": "Ú", "Y": "Ý", "C": "Ć", "N": "Ń", "S": "Ś", "Z": "Ź"},
    "`": {"a": "à", "e": "è", "i": "ì", "o": "ò", "u": "ù",
          "A": "À", "E": "È", "I": "Ì", "O": "Ò", "U": "Ù"},
    '"': {"a": "ä", "e": "ë", "i": "ï", "o": "ö", "u": "ü", "y": "ÿ",
          "A": "Ä", "E": "Ë", "I": "Ï", "O": "Ö", "U": "Ü"},
    "^": {"a": "â", "e": "ê", "i": "î", "o": "ô", "u": "û",
          "A": "Â", "E": "Ê", "I": "Î", "O": "Ô", "U": "Û"},
    "~": {"a": "ã", "n": "ñ", "o": "õ", "A": "Ã", "N": "Ñ", "O": "Õ"},
    "c": {"c": "ç", "C": "Ç", "s": "ş", "S": "Ş"},
    "v": {"c": "č", "s": "š", "z": "ž", "r": "ř", "C": "Č", "S": "Š", "Z": "Ž"},
    "u": {"a": "ă", "g": "ğ", "A": "Ă", "G": "Ğ"},
    "=": {"a": "ā", "e": "ē", "i": "ī", "o": "ō", "u": "ū"},
}

_UNWRAP_1ARG_COMMANDS = frozenset({
    "textbf", "textit", "emph", "texttt", "textrm", "textsf", "textsc", "textsl",
    "textup", "textmd", "textnormal", "text", "mathrm", "mathbf", "mathit",
    "mathsf", "mathtt", "mathcal", "mathbb", "underline", "mbox", "hbox",
    "uppercase", "lowercase", "MakeUppercase", "MakeLowercase",
    "institution", "department", "city", "state", "country", "streetaddress",
    "postcode", "email", "url", "nolinkurl", "path",
})
_UNWRAP_2ND_ARG_COMMANDS = frozenset({"textcolor", "href", "texorpdfstring"})
_DROP_0ARG_COMMANDS = frozenset({
    "centering", "noindent", "smallskip", "medskip", "bigskip", "hfill", "vfill",
    "footnotesize", "scriptsize", "tiny", "small", "normalsize", "large", "Large",
    "LARGE", "huge", "Huge", "bfseries", "itshape", "rmfamily", "sffamily",
    "ttfamily", "scshape", "mdseries", "upshape", "slshape", "bf", "it", "rm",
    "sf", "tt", "sc", "em", "protect", "relax", "maketitle", "tableofcontents",
    "clearpage", "cleardoublepage", "newpage", "pagebreak", "linebreak",
    "toprule", "midrule", "bottomrule", "hline", "hdashline", "addlinespace",
    "notag", "nonumber", "qquad", "quad", "enspace", "thinspace",
    "endfirsthead", "endhead", "endfoot", "endlastfoot",
})
_DROP_1ARG_COMMANDS = frozenset({
    "label", "vspace", "hspace", "vskip", "hskip", "color", "pagestyle",
    "thispagestyle", "bibliographystyle", "bibliography", "addbibresource",
    "phantom", "hphantom", "vphantom", "cline", "index", "hypersetup",
    "cellcolor", "rowcolor", "columncolor",
})
_DROP_2ARG_COMMANDS = frozenset({"setlength", "addtolength", "setcounter", "addtocounter"})


class ArxivTexExtractError(RuntimeError):
    """Structured fail-closed error raised by the arXiv TeX AST extractor."""

    def __init__(self, message: str, code: str = "TEX_EXTRACT_ERROR") -> None:
        super().__init__(message)
        self.code = code


def get_extractor_sha256() -> str:
    """Return the deterministic lowercase SHA-256 hex digest of this extractor file."""
    return hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()


def _normalize_arxiv_id(arxiv_id: str | None) -> str | None:
    if arxiv_id is None:
        return None
    raw = str(arxiv_id).strip()
    if not raw:
        return None
    match = _ARXIV_ID_RE.match(raw)
    if not match:
        raise ArxivTexExtractError(f"Invalid arXiv ID: {arxiv_id!r}", code="INVALID_ARXIV_ID")
    return match.group(1)


def _is_macos_junk_path(rel_path: str) -> bool:
    parts = rel_path.split("/")
    return "__MACOSX" in parts or parts[-1].startswith("._")


# ═══════════════════════════════════════════════════════════════════════════
# 1. Safe Archive Unpacking (In-Memory, Hardened Security Guards)
# ═══════════════════════════════════════════════════════════════════════════

def _check_path_chars(value: str, raw_label: str) -> None:
    for ch in value:
        cp = ord(ch)
        if 0xD800 <= cp <= 0xDFFF:
            raise ArxivTexExtractError(f"Lone surrogate rejected in path: {raw_label!r}", code="PATH_TRAVERSAL")
        if cp < 0x20 or cp == 0x7F or (0x80 <= cp <= 0x9F):
            raise ArxivTexExtractError(f"Control character rejected in path: {raw_label!r}", code="PATH_TRAVERSAL")
        if ch in _BIDI_AND_FORBIDDEN_CHARS:
            raise ArxivTexExtractError(f"Bidi override character rejected in path: {raw_label!r}", code="PATH_TRAVERSAL")


def _validate_archive_member_path(raw_name: str, *, allow_dot_dir: bool = False) -> str | None:
    """Validate and normalize a relative POSIX member path inside an archive."""
    if not isinstance(raw_name, str) or not raw_name:
        raise ArxivTexExtractError("Empty archive member path", code="PATH_TRAVERSAL")

    _check_path_chars(raw_name, raw_name)
    nfkc = unicodedata.normalize("NFKC", raw_name)
    _check_path_chars(nfkc, raw_name)

    for variant in (raw_name, nfkc):
        if "\\" in variant or variant.startswith("/") or _DRIVE_LETTER_RE.match(variant):
            raise ArxivTexExtractError(f"Unsafe archive member path rejected: {raw_name!r}", code="PATH_TRAVERSAL")
        parts_v = variant.split("/")
        norm_v: list[str] = []
        for part in parts_v:
            if part == "" or part == ".":
                continue
            if part == "..":
                raise ArxivTexExtractError(f"Parent directory traversal rejected in path: {raw_name!r}", code="PATH_TRAVERSAL")
            norm_v.append(part)
        if norm_v and (_DRIVE_LETTER_RE.match(norm_v[0]) or ":" in norm_v[0]):
            raise ArxivTexExtractError(f"Drive-letter or colon prefix rejected in path: {raw_name!r}", code="PATH_TRAVERSAL")

    normalized = [p for p in raw_name.split("/") if p not in ("", ".")]
    if not normalized:
        if allow_dot_dir:
            return None
        raise ArxivTexExtractError(f"Archive member path resolves to empty path: {raw_name!r}", code="PATH_TRAVERSAL")
    return "/".join(normalized)


def _validate_input_target_path(raw_target: str) -> str:
    target = raw_target.strip()
    if not target:
        raise ArxivTexExtractError("Empty \\input/\\include target", code="INPUT_PATH_TRAVERSAL")
    try:
        normalized = _validate_archive_member_path(target, allow_dot_dir=False)
    except ArxivTexExtractError as exc:
        raise ArxivTexExtractError(
            f"Unsafe \\input/\\include target rejected: {raw_target!r}",
            code="INPUT_PATH_TRAVERSAL",
        ) from exc
    assert normalized is not None
    return normalized


def _detect_non_tex_magic(data: bytes) -> tuple[str, str] | None:
    if data.startswith(b"%PDF-"):
        return ("PDF_ONLY_PAYLOAD", "Payload is a PDF file without TeX source")
    if data.startswith(b"%!PS-Adobe"):
        return ("UNSUPPORTED_PAYLOAD", "Payload is a PostScript file without TeX source")
    if data.startswith(b"PK\x03\x04"):
        return ("UNSUPPORTED_PAYLOAD", "ZIP archive format is unsupported for arXiv TeX extraction")
    if data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff"):
        return ("UNSUPPORTED_PAYLOAD", "Binary image payload is not TeX source")
    head = data[:512].lstrip().lower()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
        return ("UNSUPPORTED_PAYLOAD", "HTML document received instead of TeX source")
    return None


def _decompress_gzip_bounded(raw_bytes: bytes, max_uncompressed_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(raw_bytes), mode="rb") as gz:
            while True:
                chunk = gz.read(_CHUNK_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_uncompressed_bytes:
                    raise ArxivTexExtractError(
                        f"Decompressed gzip stream exceeds {max_uncompressed_bytes} byte limit",
                        code="UNCOMPRESSED_LIMIT_EXCEEDED",
                    )
                chunks.append(chunk)
    except ArxivTexExtractError:
        raise
    except (OSError, EOFError, ValueError) as exc:
        raise ArxivTexExtractError(f"Corrupt or invalid gzip stream: {exc}", code="INVALID_ARCHIVE") from exc
    return b"".join(chunks)


def _is_tar_bytes(data: bytes) -> bool:
    if len(data) < 512:
        return False
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:", encoding="utf-8", errors="strict") as tf:
            first = tf.next()
            if first is not None:
                return True
            return data[:512] == b"\x00" * 512
    except (UnicodeDecodeError, RecursionError, ValueError) as exc:
        raise ArxivTexExtractError(f"Malformed or hostile tar header: {exc}", code="INVALID_ARCHIVE") from exc
    except (tarfile.TarError, EOFError, OSError):
        return False


def _extract_tar_in_memory(
    tar_bytes: bytes,
    *,
    max_members: int,
    max_uncompressed_bytes: int,
    max_single_tex_bytes: int,
) -> tuple[dict[str, bytes], list[str]]:
    files: dict[str, bytes] = {}
    all_member_paths: list[str] = []
    member_count = 0
    total_uncompressed = 0

    try:
        tf = tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:", encoding="utf-8", errors="strict")
    except (tarfile.TarError, EOFError, OSError, UnicodeDecodeError, RecursionError, ValueError) as exc:
        raise ArxivTexExtractError(f"Invalid tar archive: {exc}", code="INVALID_ARCHIVE") from exc

    with tf:
        while True:
            try:
                member = tf.next()
            except (tarfile.TarError, EOFError, OSError, UnicodeDecodeError, RecursionError, ValueError) as exc:
                raise ArxivTexExtractError(f"Malformed tar member header: {exc}", code="INVALID_ARCHIVE") from exc
            if member is None:
                break

            member_count += 1
            if member_count > max_members:
                raise ArxivTexExtractError(
                    f"Tar archive exceeds member limit of {max_members}",
                    code="TOO_MANY_MEMBERS",
                )

            pax = member.pax_headers or {}
            if member.issparse() or any(k.startswith("GNU.sparse.") for k in pax):
                raise ArxivTexExtractError(f"Sparse tar member rejected: {member.name!r}", code="UNSAFE_MEMBER_TYPE")
            if member.issym():
                raise ArxivTexExtractError(f"Symlink tar member rejected: {member.name!r}", code="UNSAFE_MEMBER_TYPE")
            if member.islnk():
                raise ArxivTexExtractError(f"Hardlink tar member rejected: {member.name!r}", code="UNSAFE_MEMBER_TYPE")
            if member.isfifo():
                raise ArxivTexExtractError(f"FIFO tar member rejected: {member.name!r}", code="UNSAFE_MEMBER_TYPE")
            if member.ischr():
                raise ArxivTexExtractError(f"Character device tar member rejected: {member.name!r}", code="UNSAFE_MEMBER_TYPE")
            if member.isblk():
                raise ArxivTexExtractError(f"Block device tar member rejected: {member.name!r}", code="UNSAFE_MEMBER_TYPE")
            if member.isdir():
                _validate_archive_member_path(member.name, allow_dot_dir=True)
                continue
            if not member.isreg():
                raise ArxivTexExtractError(
                    f"Unsupported non-regular tar member type ({member.type!r}) rejected: {member.name!r}",
                    code="UNSAFE_MEMBER_TYPE",
                )

            norm_path = _validate_archive_member_path(member.name, allow_dot_dir=False)
            assert norm_path is not None

            if member.size < 0:
                raise ArxivTexExtractError(f"Negative tar member size rejected: {norm_path!r}", code="INVALID_ARCHIVE")
            lower_path = norm_path.lower()
            is_tex_file = lower_path.endswith(_TEX_EXTS)
            if is_tex_file and member.size > max_single_tex_bytes:
                raise ArxivTexExtractError(
                    f"Single TeX file {norm_path!r} ({member.size} bytes) exceeds {max_single_tex_bytes} byte limit",
                    code="SINGLE_TEX_TOO_LARGE",
                )
            if total_uncompressed + member.size > max_uncompressed_bytes:
                raise ArxivTexExtractError(
                    f"Archive uncompressed bytes exceed {max_uncompressed_bytes} byte limit",
                    code="UNCOMPRESSED_LIMIT_EXCEEDED",
                )

            extracted = tf.extractfile(member)
            if extracted is None:
                raise ArxivTexExtractError(f"Unable to read regular tar member: {norm_path!r}", code="INVALID_ARCHIVE")

            keep_bytes = lower_path.endswith(_TEXT_SIDECAR_EXTS)
            member_chunks: list[bytes] = []
            member_read = 0
            with extracted:
                while True:
                    chunk = extracted.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    member_read += len(chunk)
                    total_uncompressed += len(chunk)
                    if total_uncompressed > max_uncompressed_bytes:
                        raise ArxivTexExtractError(
                            f"Archive uncompressed bytes exceed {max_uncompressed_bytes} byte limit",
                            code="UNCOMPRESSED_LIMIT_EXCEEDED",
                        )
                    if is_tex_file and member_read > max_single_tex_bytes:
                        raise ArxivTexExtractError(
                            f"Single TeX file {norm_path!r} exceeds {max_single_tex_bytes} byte limit",
                            code="SINGLE_TEX_TOO_LARGE",
                        )
                    if keep_bytes:
                        member_chunks.append(chunk)

            all_member_paths.append(norm_path)
            if keep_bytes:
                files[norm_path] = b"".join(member_chunks)

    return files, all_member_paths


def unpack_arxiv_tex_payload(
    raw_bytes: bytes,
    *,
    max_archive_bytes: int = DEFAULT_MAX_ARCHIVE_BYTES,
    max_members: int = DEFAULT_MAX_MEMBERS,
    max_uncompressed_bytes: int = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    max_single_tex_bytes: int = DEFAULT_MAX_SINGLE_TEX_BYTES,
) -> tuple[dict[str, bytes], str, list[str]]:
    if not isinstance(raw_bytes, (bytes, bytearray)):
        raise ArxivTexExtractError("Input payload must be bytes", code="INVALID_ARCHIVE")
    payload = bytes(raw_bytes)
    if not payload:
        raise ArxivTexExtractError("Empty payload", code="INVALID_ARCHIVE")
    if len(payload) > max_archive_bytes:
        raise ArxivTexExtractError(
            f"Archive size {len(payload)} bytes exceeds {max_archive_bytes} byte limit",
            code="ARCHIVE_TOO_LARGE",
        )

    non_tex = _detect_non_tex_magic(payload)
    if non_tex is not None:
        raise ArxivTexExtractError(non_tex[1], code=non_tex[0])

    if payload.startswith(b"\x1f\x8b"):
        decompressed = _decompress_gzip_bounded(payload, max_uncompressed_bytes)
        non_tex_inner = _detect_non_tex_magic(decompressed)
        if non_tex_inner is not None:
            raise ArxivTexExtractError(non_tex_inner[1], code=non_tex_inner[0])
        if _is_tar_bytes(decompressed):
            files, members = _extract_tar_in_memory(
                decompressed,
                max_members=max_members,
                max_uncompressed_bytes=max_uncompressed_bytes,
                max_single_tex_bytes=max_single_tex_bytes,
            )
            return files, "tar.gz", members
        if len(decompressed) > max_single_tex_bytes:
            raise ArxivTexExtractError(
                f"Single decompressed .tex.gz file ({len(decompressed)} bytes) exceeds {max_single_tex_bytes} byte limit",
                code="SINGLE_TEX_TOO_LARGE",
            )
        if b"\x00" in decompressed:
            raise ArxivTexExtractError("Binary NUL bytes in decompressed non-tar payload", code="UNSUPPORTED_PAYLOAD")
        return {"main.tex": decompressed}, "tex.gz", ["main.tex"]

    if _is_tar_bytes(payload):
        files, members = _extract_tar_in_memory(
            payload,
            max_members=max_members,
            max_uncompressed_bytes=max_uncompressed_bytes,
            max_single_tex_bytes=max_single_tex_bytes,
        )
        return files, "tar", members

    if len(payload) > max_single_tex_bytes:
        raise ArxivTexExtractError(
            f"Single raw .tex file ({len(payload)} bytes) exceeds {max_single_tex_bytes} byte limit",
            code="SINGLE_TEX_TOO_LARGE",
        )
    if b"\x00" in payload:
        raise ArxivTexExtractError("Binary NUL bytes in raw non-tar payload", code="UNSUPPORTED_PAYLOAD")
    return {"main.tex": payload}, "tex", ["main.tex"]


def _decode_tex_bytes(raw: bytes, filename: str) -> str:
    if b"\x00" in raw:
        raise ArxivTexExtractError(f"NUL byte detected inside TeX file: {filename!r}", code="INVALID_TEX_ENCODING")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


# ═══════════════════════════════════════════════════════════════════════════
# 2. O(n) Low-Level Scanners, Delimiter Maps & Verbatim Protection
# ═══════════════════════════════════════════════════════════════════════════

def _skip_ws(text: str, pos: int) -> int:
    n = len(text)
    while pos < n and text[pos] in " \t\n\r":
        pos += 1
    return pos


def _read_command_name(text: str, backslash_pos: int) -> tuple[str, int]:
    n = len(text)
    if backslash_pos + 1 >= n:
        return "", backslash_pos + 1
    nxt = text[backslash_pos + 1]
    if nxt.isalpha() or nxt == "@":
        end = backslash_pos + 2
        while end < n and (text[end].isalpha() or text[end] == "@"):
            end += 1
        return text[backslash_pos + 1 : end], end
    return nxt, backslash_pos + 2


_DELIM_REGEX_CACHE: dict[tuple[str, str], re.Pattern[str]] = {
    ("{", "}"): re.compile(r"\\[\\{}]|[{}]"),
    ("[", "]"): re.compile(r"\\[\\\[\]]|[\[\]]"),
    ("(", ")"): re.compile(r"\\[\\()]|[()]"),
}
_CMD_SCAN_RE = re.compile(r"\\\\|\\([A-Za-z@]+)")


def build_delimiter_map(text: str, open_ch: str = "{", close_ch: str = "}") -> dict[int, int]:
    """Build an O(1)-lookup matching index map for balanced delimiters in a single C-speed O(n) pass."""
    pattern = _DELIM_REGEX_CACHE.get((open_ch, close_ch))
    if pattern is None:
        esc_o = re.escape(open_ch)
        esc_c = re.escape(close_ch)
        pattern = re.compile(rf"\\[\\{esc_o}{esc_c}]|[{esc_o}{esc_c}]")
        _DELIM_REGEX_CACHE[(open_ch, close_ch)] = pattern

    match_map: dict[int, int] = {}
    stack: list[int] = []
    for m in pattern.finditer(text):
        tok = m.group(0)
        if tok == open_ch:
            stack.append(m.start())
        elif tok == close_ch and stack:
            match_map[stack.pop()] = m.start()
    return match_map


def _read_balanced(
    text: str,
    start: int,
    open_ch: str = "{",
    close_ch: str = "}",
    match_map: dict[int, int] | None = None,
) -> tuple[str, int] | None:
    """Read balanced group at `start`. O(1) when `match_map` is supplied; linear fallback otherwise."""
    n = len(text)
    if start >= n or text[start] != open_ch:
        return None
    if match_map is not None:
        end = match_map.get(start)
        if end is None:
            return None
        return text[start + 1 : end], end + 1
    depth = 0
    bs_count = 0
    i = start
    while i < n:
        ch = text[i]
        if ch == "\\":
            bs_count += 1
            i += 1
            continue
        escaped = (bs_count % 2 == 1)
        bs_count = 0
        if not escaped:
            if ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return text[start + 1 : i], i + 1
        i += 1
    return None


def _match_env_tag(text: str, pos: int, tag_kind: str) -> tuple[str, int] | None:
    """Match \\begin{name} or \\end{name} starting at backslash `pos` in O(1) bounded space."""
    prefix = "\\begin" if tag_kind == "begin" else "\\end"
    if not text.startswith(prefix, pos):
        return None
    after = pos + len(prefix)
    n = len(text)
    if after < n and (text[after].isalpha() or text[after] == "@"):
        return None
    p = _skip_ws(text, after)
    if p >= n or text[p] != "{":
        return None
    q = p + 1
    limit = min(n, q + 64)
    while q < limit and text[q] != "}":
        if text[q] in "\\{":
            return None
        q += 1
    if q < limit and text[q] == "}":
        return text[p + 1 : q].strip(), q + 1
    return None


def _match_verb_span(text: str, pos: int) -> int | None:
    """If `pos` starts \\verb*?<delim>...<delim> (same line), return index right after closing delim."""
    if not text.startswith("\\verb", pos):
        return None
    after = pos + 5
    n = len(text)
    if after < n and (text[after].isalpha() or text[after] == "@"):
        return None
    p = after
    if p < n and text[p] == "*":
        p += 1
    if p >= n or text[p] == "\n":
        return None
    delim = text[p]
    nl = text.find("\n", p + 1)
    end = text.find(delim, p + 1, n if nl == -1 else nl)
    if end == -1:
        return None
    return end + 1


def _find_verbatim_end(text: str, start: int, env_name: str) -> int:
    """Find end index right after matching \\end{env_name}, or len(text) if unclosed."""
    n = len(text)
    i = start
    while i < n:
        j = text.find("\\end", i)
        if j == -1:
            return n
        m = _match_env_tag(text, j, "end")
        if m is not None and m[0] == env_name:
            return m[1]
        i = j + 4
    return n


def _mask_span_preserve_newlines(segment: str) -> str:
    return "".join("\n" if ch == "\n" else " " for ch in segment)


def mask_verbatim_for_parsing(text: str) -> str:
    """Replace contents of \\verb and verbatim/lstlisting/minted environments with spaces (same length)."""
    if "\\verb" not in text and not any(env in text for env in _VERBATIM_ENVS):
        return text
    n = len(text)
    out: list[str] = []
    i = 0
    literal_start = 0
    while i < n:
        j = text.find("\\", i)
        if j == -1:
            break
        # Count consecutive backslashes starting at j
        k = j + 1
        while k < n and text[k] == "\\":
            k += 1
        bs_len = k - j
        if bs_len % 2 == 1:
            cmd_pos = k - 1
            verb_end = _match_verb_span(text, cmd_pos)
            if verb_end is not None:
                out.append(text[literal_start:cmd_pos])
                out.append(_mask_span_preserve_newlines(text[cmd_pos:verb_end]))
                literal_start = verb_end
                i = verb_end
                continue
            env_m = _match_env_tag(text, cmd_pos, "begin")
            if env_m is not None and env_m[0] in _VERBATIM_ENVS:
                end_after = _find_verbatim_end(text, env_m[1], env_m[0])
                out.append(text[literal_start:cmd_pos])
                out.append(_mask_span_preserve_newlines(text[cmd_pos:end_after]))
                literal_start = end_after
                i = end_after
                continue
        i = k
    if not out:
        return text
    out.append(text[literal_start:])
    return "".join(out)


# ═══════════════════════════════════════════════════════════════════════════
# 3. LaTeXpOsEd Comment Defense (O(n), Verbatim-Safe, Line-Continuation, \iffalse)
# ═══════════════════════════════════════════════════════════════════════════

_STANDALONE_END_COMMENT_RE = re.compile(r"^[ \t]*\\end[ \t]*\{[ \t]*comment[ \t]*\}[ \t]*(?:%.*)?$")
_MAX_STANDALONE_END_COMMENT_LEN = 64


def _is_tex_fi_conditional(cmd_name: str) -> bool:
    """Return True iff `cmd_name` is a TeX conditional that pairs with \\fi (excludes \\iff, etoolbox, etc.)."""
    return (cmd_name == "if" or cmd_name.startswith("if")) and cmd_name not in _NON_FI_IF_COMMANDS


def _consume_comment_environment(text: str, after_begin: int) -> int:
    """Consume raw lines after \\begin{comment} until standalone \\end{comment} line (or EOF fail-closed)."""
    n = len(text)
    pos = after_begin
    while pos < n:
        nl = text.find("\n", pos)
        line_end = n if nl == -1 else nl
        if _STANDALONE_END_COMMENT_RE.match(text[pos:line_end]):
            return n if nl == -1 else nl + 1
        pos = n if nl == -1 else nl + 1
    return n


def strip_tex_comments(text: str) -> tuple[str, int]:
    """Strip unescaped TeX % comments, \\begin{comment}...\\end{comment}, and \\iffalse...\\fi in O(n).

    - Protects \\verb*?<delim>...<delim> and verbatim/verbatim*/lstlisting/minted blocks.
    - Strips raw \\begin{comment}...\\end{comment} directly in Pass 1 (without % line-continuation
      inside the comment block, matching comment.sty) and strips %-continued \\begin{%\\ncomment} in Pass 2.
    - Handles TeX % line-continuation cleanly with O(1) bounded end-comment check (zero O(n^2)).
    - Preserves literal \\% (odd backslash count) while stripping \\\\% (even backslash count).
    - Tracks \\if / \\if* vs \\fi depth accurately (excluding \\iff and non-\\fi package macros).
    - Fails closed to EOF on unclosed \\begin{comment} or \\iffalse blocks.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    n = len(normalized)
    stripped_count = 0

    # Pass 1: single-pass O(n) % comment + raw \begin{comment} stripping with verbatim protection
    pass1: list[str] = []
    line_start_idx = 0
    cur_line_len = 0
    line_has_code = False
    line_ws_buf: list[str] = []
    bs_count = 0
    i = 0

    while i < n:
        ch = normalized[i]
        if ch == "\\":
            if bs_count % 2 == 0:
                verb_end = _match_verb_span(normalized, i)
                if verb_end is not None:
                    if line_ws_buf:
                        cur_line_len += len(line_ws_buf)
                        pass1.extend(line_ws_buf)
                        line_ws_buf.clear()
                    seg = normalized[i:verb_end]
                    pass1.append(seg)
                    cur_line_len += len(seg)
                    line_has_code = True
                    bs_count = 0
                    i = verb_end
                    continue
                env_m = _match_env_tag(normalized, i, "begin")
                if env_m is not None:
                    if env_m[0] in _VERBATIM_ENVS:
                        end_after = _find_verbatim_end(normalized, env_m[1], env_m[0])
                        if line_ws_buf:
                            cur_line_len += len(line_ws_buf)
                            pass1.extend(line_ws_buf)
                            line_ws_buf.clear()
                        chunk = normalized[i:end_after]
                        pass1.append(chunk)
                        if chunk.endswith("\n"):
                            line_has_code = False
                            line_start_idx = len(pass1)
                            cur_line_len = 0
                        else:
                            last_nl = chunk.rfind("\n")
                            if last_nl != -1:
                                line_start_idx = len(pass1)
                                cur_line_len = len(chunk) - last_nl - 1
                            else:
                                cur_line_len += len(chunk)
                            line_has_code = True
                        bs_count = 0
                        i = end_after
                        continue
                    if env_m[0] == "comment":
                        stripped_count += 1
                        if not line_has_code:
                            line_ws_buf.clear()
                        i = _consume_comment_environment(normalized, env_m[1])
                        if not line_has_code:
                            line_start_idx = len(pass1)
                            cur_line_len = 0
                        bs_count = 0
                        continue
            if line_ws_buf:
                cur_line_len += len(line_ws_buf)
                pass1.extend(line_ws_buf)
                line_ws_buf.clear()
            line_has_code = True
            bs_count += 1
            pass1.append(ch)
            cur_line_len += 1
            i += 1
            continue

        if ch == "%" and (bs_count % 2 == 0):
            stripped_count += 1
            bs_count = 0
            nl = normalized.find("\n", i + 1)
            if not line_has_code:
                line_ws_buf.clear()
                i = n if nl == -1 else nl + 1
            else:
                if nl == -1:
                    i = n
                else:
                    # O(1) bounded check: preserve newline only when current line is short standalone \end{comment}
                    if cur_line_len <= _MAX_STANDALONE_END_COMMENT_LEN:
                        cur_line_str = "".join(pass1[line_start_idx:])
                        if _STANDALONE_END_COMMENT_RE.match(cur_line_str):
                            pass1.append("\n")
                            line_has_code = False
                            line_start_idx = len(pass1)
                            cur_line_len = 0
                            i = nl + 1
                            continue
                    j = nl + 1
                    while j < n and normalized[j] in " \t":
                        j += 1
                    if j < n and normalized[j] == "\n":
                        pass1.append("\n")
                        line_has_code = False
                        line_start_idx = len(pass1)
                        cur_line_len = 0
                        i = j
                    else:
                        i = j
            continue

        bs_count = 0
        if ch == "\n":
            if line_ws_buf:
                pass1.extend(line_ws_buf)
                line_ws_buf.clear()
            pass1.append("\n")
            line_has_code = False
            line_start_idx = len(pass1)
            cur_line_len = 0
            i += 1
            continue

        if not line_has_code and ch in " \t":
            line_ws_buf.append(ch)
            i += 1
            continue

        if line_ws_buf:
            cur_line_len += len(line_ws_buf)
            pass1.extend(line_ws_buf)
            line_ws_buf.clear()
        line_has_code = True
        pass1.append(ch)
        cur_line_len += 1
        i += 1

    if line_ws_buf:
        pass1.extend(line_ws_buf)
    stage1 = "".join(pass1)

    if "\\iffalse" not in stage1 and "comment" not in stage1:
        return stage1, stripped_count

    # Pass 2: single-pass O(n) %-continued \begin{comment}...\end{comment} and \iffalse...\fi stripping
    m = len(stage1)
    out: list[str] = []
    i = 0
    bs_count = 0
    else_fi_stack: list[int] = []

    while i < m:
        if stage1[i] != "\\":
            j = stage1.find("\\", i)
            if j == -1:
                out.append(stage1[i:])
                break
            out.append(stage1[i:j])
            bs_count = 0
            i = j
            continue

        if bs_count % 2 == 0:
            verb_end = _match_verb_span(stage1, i)
            if verb_end is not None:
                out.append(stage1[i:verb_end])
                i = verb_end
                bs_count = 0
                continue
            env_m = _match_env_tag(stage1, i, "begin")
            if env_m is not None:
                if env_m[0] in _VERBATIM_ENVS:
                    end_after = _find_verbatim_end(stage1, env_m[1], env_m[0])
                    out.append(stage1[i:end_after])
                    i = end_after
                    bs_count = 0
                    continue
                if env_m[0] == "comment":
                    stripped_count += 1
                    i = _consume_comment_environment(stage1, env_m[1])
                    bs_count = 0
                    continue

            cmd_name, cmd_after = _read_command_name(stage1, i)
            if cmd_name == "iffalse":
                stripped_count += 1
                depth = 1
                j = cmd_after
                inner_bs = 0
                entered_else = False
                while j < m and depth > 0:
                    c2 = stage1[j]
                    if c2 != "\\":
                        inner_bs = 0
                        j += 1
                        continue
                    if inner_bs % 2 == 0:
                        cn2, ca2 = _read_command_name(stage1, j)
                        if cn2 == "fi":
                            depth -= 1
                            j = ca2
                            inner_bs = 0
                            continue
                        if cn2 == "else" and depth == 1:
                            entered_else = True
                            j = ca2
                            inner_bs = 0
                            break
                        if _is_tex_fi_conditional(cn2):
                            depth += 1
                            j = ca2
                            inner_bs = 0
                            continue
                        j = ca2
                        inner_bs = 0
                        continue
                    inner_bs += 1
                    j += 1
                if entered_else:
                    else_fi_stack.append(0)
                i = j
                bs_count = 0
                continue

            if else_fi_stack:
                if _is_tex_fi_conditional(cmd_name):
                    else_fi_stack[-1] += 1
                elif cmd_name == "fi":
                    if else_fi_stack[-1] == 0:
                        else_fi_stack.pop()
                        i = cmd_after
                        bs_count = 0
                        continue
                    else_fi_stack[-1] -= 1

            out.append(stage1[i:cmd_after])
            i = cmd_after
            bs_count = 0
            continue

        bs_count += 1
        out.append("\\")
        i += 1

    return "".join(out), stripped_count


# ═══════════════════════════════════════════════════════════════════════════
# 4. Single-Pass O(n) Command/Environment Scanners & Macro Masking
# ═══════════════════════════════════════════════════════════════════════════

def _iter_named_commands(
    text: str,
    names: set[str] | frozenset[str],
    *,
    allow_star: bool = False,
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    n = len(text)
    for m in _CMD_SCAN_RE.finditer(text):
        name = m.group(1)
        if name is None or name not in names:
            continue
        starred = False
        pos = m.end()
        if allow_star and pos < n and text[pos] == "*":
            starred = True
            pos += 1
        found.append({"name": name, "starred": starred, "start": m.start(), "after": pos})
    return found


def _find_environments(
    text: str,
    env_names: set[str] | frozenset[str],
    *,
    brace_map: dict[int, int] | None = None,
) -> list[dict[str, Any]]:
    """Single-pass O(n) stack-based top-level environment finder (zero O(n^2) on unclosed envs)."""
    if "\\begin" not in text:
        return []
    bmap = brace_map if brace_map is not None else build_delimiter_map(text, "{", "}")
    stacks: dict[str, list[tuple[int, int]]] = {}
    matched: list[dict[str, Any]] = []
    for m in _CMD_SCAN_RE.finditer(text):
        name = m.group(1)
        if name not in ("begin", "end"):
            continue
        pos = _skip_ws(text, m.end())
        grp = _read_balanced(text, pos, "{", "}", bmap)
        if grp is None:
            continue
        env_name = grp[0].strip()
        if env_name not in env_names:
            continue
        if name == "begin":
            stacks.setdefault(env_name, []).append((m.start(), grp[1]))
        else:
            st = stacks.get(env_name)
            if st:
                start_pos, body_start = st.pop()
                if not st:
                    matched.append({
                        "env": env_name,
                        "start": start_pos,
                        "body_start": body_start,
                        "body_end": m.start(),
                        "end": grp[1],
                        "body": text[body_start : m.start()],
                    })

    matched.sort(key=lambda item: item["start"])
    top_level: list[dict[str, Any]] = []
    last_end = -1
    for item in matched:
        if item["start"] >= last_end:
            top_level.append(item)
            last_end = item["end"]
    return top_level


def _macro_def_span_end(
    text: str,
    i: int,
    name: str,
    after: int,
    bmap: dict[int, int],
    kmap: dict[int, int],
) -> int | None:
    """Return end index of a macro definition command starting at `i`, or None if malformed."""
    n = len(text)
    if name in ("newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"):
        pos = after
        if pos < n and text[pos] == "*":
            pos += 1
        pos = _skip_ws(text, pos)
        if pos < n and text[pos] == "{":
            grp = _read_balanced(text, pos, "{", "}", bmap)
            if grp is None:
                return None
            pos = grp[1]
        elif pos < n and text[pos] == "\\":
            _, pos = _read_command_name(text, pos)
        else:
            return None
        for _ in range(2):
            p2 = _skip_ws(text, pos)
            if p2 < n and text[p2] == "[":
                opt = _read_balanced(text, p2, "[", "]", kmap)
                if opt is None:
                    break
                pos = opt[1]
            else:
                break
        pos = _skip_ws(text, pos)
        body = _read_balanced(text, pos, "{", "}", bmap)
        return body[1] if body is not None else None

    if name == "DeclareMathOperator":
        pos = after
        if pos < n and text[pos] == "*":
            pos += 1
        pos = _skip_ws(text, pos)
        if pos < n and text[pos] == "{":
            g1 = _read_balanced(text, pos, "{", "}", bmap)
            if g1 is None:
                return None
            pos = g1[1]
        elif pos < n and text[pos] == "\\":
            _, pos = _read_command_name(text, pos)
        pos = _skip_ws(text, pos)
        g2 = _read_balanced(text, pos, "{", "}", bmap)
        return g2[1] if g2 is not None else None

    if name in ("def", "edef", "gdef", "xdef"):
        pos = _skip_ws(text, after)
        if pos < n and text[pos] == "\\":
            _, pos = _read_command_name(text, pos)
            scan_limit = min(n, pos + _MAX_DEF_PARAM_CHARS)
            brace_pos = -1
            k = pos
            while k < scan_limit:
                if text[k] == "{":
                    brace_pos = k
                    break
                if text[k] == "\n":
                    break
                k += 1
            if brace_pos != -1:
                body = _read_balanced(text, brace_pos, "{", "}", bmap)
                return body[1] if body is not None else None
    return None


def mask_macro_definitions(text: str) -> str:
    """Replace \\newcommand/\\def/... definitions with same-length spaces (verbatim-safe, preserves charOffset)."""
    masked = mask_verbatim_for_parsing(text)
    bmap = build_delimiter_map(masked, "{", "}")
    kmap = build_delimiter_map(masked, "[", "]")
    n = len(masked)
    out: list[str] = []
    i = 0
    while i < n:
        if masked[i] != "\\":
            j = masked.find("\\", i)
            if j == -1:
                out.append(text[i:])
                break
            out.append(text[i:j])
            i = j
            continue
        name, after = _read_command_name(masked, i)
        end = _macro_def_span_end(masked, i, name, after, bmap, kmap)
        if end is not None:
            out.append(_mask_span_preserve_newlines(text[i:end]))
            i = end
            continue
        out.append(text[i:after])
        i = after
    return "".join(out)


def strip_macro_definitions(text: str) -> str:
    """Remove \\newcommand/\\renewcommand/\\providecommand/\\def/... in strict O(n) (verbatim-safe)."""
    masked = mask_verbatim_for_parsing(text)
    bmap = build_delimiter_map(masked, "{", "}")
    kmap = build_delimiter_map(masked, "[", "]")
    n = len(masked)
    out: list[str] = []
    i = 0
    while i < n:
        if masked[i] != "\\":
            j = masked.find("\\", i)
            if j == -1:
                out.append(text[i:])
                break
            out.append(text[i:j])
            i = j
            continue
        name, after = _read_command_name(masked, i)
        end = _macro_def_span_end(masked, i, name, after, bmap, kmap)
        if end is not None:
            i = end
            continue
        out.append(text[i:after])
        i = after
    return "".join(out)


def clean_tex_text(text: str, *, preserve_newlines: bool = False) -> str:
    """Convert a TeX snippet into clean human-readable text in strict O(n) time (zero recursion)."""
    if not text:
        return ""
    masked = mask_verbatim_for_parsing(text)
    bmap = build_delimiter_map(masked, "{", "}")
    kmap = build_delimiter_map(masked, "[", "]")
    pmap = build_delimiter_map(masked, "(", ")") if "\\cmidrule" in masked else None
    n = len(text)
    out: list[str] = []
    i = 0
    while i < n:
        ch = text[i]
        if ch == "~":
            out.append(" ")
            i += 1
            continue
        if ch in "{}":
            i += 1
            continue
        if ch != "\\":
            out.append(ch)
            i += 1
            continue

        # Preserve \verb*?<d>...<d> interior text cleanly
        verb_end = _match_verb_span(text, i)
        if verb_end is not None:
            name_v, after_v = _read_command_name(text, i)
            p_v = after_v + (1 if after_v < n and text[after_v] == "*" else 0)
            out.append(text[p_v + 1 : verb_end - 1])
            i = verb_end
            continue

        name, after = _read_command_name(text, i)
        if name in ("%", "&", "_", "#", "$", "{", "}"):
            out.append(name)
            i = after
            continue
        if name in (",", ";", ":", "!", " "):
            out.append(" ")
            i = after
            continue
        if name in ("\\", "tabularnewline"):
            pos = after
            if pos < n and text[pos] == "*":
                pos += 1
            p2 = _skip_ws(text, pos)
            if p2 < n and text[p2] == "[":
                opt = _read_balanced(text, p2, "[", "]", kmap)
                if opt is not None:
                    pos = opt[1]
            out.append("\n" if preserve_newlines else " ")
            i = pos
            continue
        if name == "newline":
            out.append("\n" if preserve_newlines else " ")
            i = after
            continue
        if name in ("uparrow", "Uparrow"):
            out.append("↑")
            i = after
            continue
        if name in ("downarrow", "Downarrow"):
            out.append("↓")
            i = after
            continue
        if name == "pm":
            out.append("±")
            i = after
            continue
        if name == "times":
            out.append("×")
            i = after
            continue
        if name == "cdot":
            out.append("·")
            i = after
            continue
        if name in ("leq", "le"):
            out.append("≤")
            i = after
            continue
        if name in ("geq", "ge"):
            out.append("≥")
            i = after
            continue
        if name == "approx":
            out.append("≈")
            i = after
            continue
        if name == "infty":
            out.append("∞")
            i = after
            continue
        if name in ("ldots", "dots", "cdots"):
            out.append("...")
            i = after
            continue
        if name in ("textendash", "textemdash"):
            out.append("–" if name == "textendash" else "—")
            i = after
            continue
        if name in _LATEX_ACCENTS:
            accent_map = _LATEX_ACCENTS[name]
            pos = _skip_ws(text, after) if name.isalpha() else after
            if pos < n and text[pos] == "{":
                grp = _read_balanced(text, pos, "{", "}", bmap)
                if grp is not None:
                    inner = grp[0].strip()
                    if inner == "\\i":
                        inner = "i"
                    out.append(accent_map.get(inner, inner))
                    i = grp[1]
                    continue
            elif pos < n and text[pos].isalpha():
                out.append(accent_map.get(text[pos], text[pos]))
                i = pos + 1
                continue
        if name in _DROP_0ARG_COMMANDS:
            i = after
            continue
        if name in _DROP_1ARG_COMMANDS:
            pos = after
            if pos < n and text[pos] == "*":
                pos += 1
            p2 = _skip_ws(text, pos)
            if p2 < n and text[p2] == "[":
                opt = _read_balanced(text, p2, "[", "]", kmap)
                if opt is not None:
                    p2 = _skip_ws(text, opt[1])
            grp = _read_balanced(text, p2, "{", "}", bmap)
            i = grp[1] if grp is not None else after
            continue
        if name in _DROP_2ARG_COMMANDS:
            pos = _skip_ws(text, after)
            if pos < n and text[pos] == "{":
                g1 = _read_balanced(text, pos, "{", "}", bmap)
                pos = _skip_ws(text, g1[1]) if g1 is not None else after
            elif pos < n and text[pos] == "\\":
                _, pos = _read_command_name(text, pos)
                pos = _skip_ws(text, pos)
            g2 = _read_balanced(text, pos, "{", "}", bmap)
            i = g2[1] if g2 is not None else after
            continue
        if name == "cmidrule":
            p2 = _skip_ws(text, after)
            if p2 < n and text[p2] == "[":
                opt = _read_balanced(text, p2, "[", "]", kmap)
                if opt is not None:
                    p2 = _skip_ws(text, opt[1])
            if p2 < n and text[p2] == "(":
                par = _read_balanced(text, p2, "(", ")", pmap)
                if par is not None:
                    p2 = _skip_ws(text, par[1])
            grp = _read_balanced(text, p2, "{", "}", bmap)
            i = grp[1] if grp is not None else after
            continue
        if name in _UNWRAP_1ARG_COMMANDS:
            pos = _skip_ws(text, after)
            if pos < n and text[pos] == "[":
                opt = _read_balanced(text, pos, "[", "]", kmap)
                if opt is not None:
                    pos = _skip_ws(text, opt[1])
            i = pos
            continue
        if name in _UNWRAP_2ND_ARG_COMMANDS:
            pos = _skip_ws(text, after)
            if pos < n and text[pos] == "[":
                opt = _read_balanced(text, pos, "[", "]", kmap)
                if opt is not None:
                    pos = _skip_ws(text, opt[1])
            g1 = _read_balanced(text, pos, "{", "}", bmap)
            i = _skip_ws(text, g1[1]) if g1 is not None else after
            continue
        if name in ("cite", "citep", "citet", "citeauthor", "citeyear", "ref", "eqref", "autoref", "cref", "Cref"):
            pos = after
            while True:
                p2 = _skip_ws(text, pos)
                if p2 < n and text[p2] == "[":
                    opt = _read_balanced(text, p2, "[", "]", kmap)
                    if opt is None:
                        break
                    pos = opt[1]
                else:
                    break
            p2 = _skip_ws(text, pos)
            grp = _read_balanced(text, p2, "{", "}", bmap)
            if grp is not None:
                if name in ("cite", "citep", "citet", "citeauthor", "citeyear"):
                    out.append(f"[{grp[0].strip()}]")
                elif name == "eqref":
                    out.append(f"({grp[0].strip()})")
                else:
                    out.append(grp[0].strip())
                i = grp[1]
                continue
        if name in ("footnote", "thanks"):
            pos = _skip_ws(text, after)
            if pos < n and text[pos] == "[":
                opt = _read_balanced(text, pos, "[", "]", kmap)
                if opt is not None:
                    pos = _skip_ws(text, opt[1])
            grp = _read_balanced(text, pos, "{", "}", bmap)
            i = grp[1] if grp is not None else after
            continue
        if name == "multirow":
            # \multirow{nrows}[bigstruts]{width|*|=[vmove]{text}
            pos = _skip_ws(text, after)
            g1 = _read_balanced(text, pos, "{", "}", bmap)
            if g1 is not None:
                pos = _skip_ws(text, g1[1])
                if pos < n and text[pos] == "[":
                    opt = _read_balanced(text, pos, "[", "]", kmap)
                    if opt is not None:
                        pos = _skip_ws(text, opt[1])
                if pos < n and text[pos] == "{":
                    g2 = _read_balanced(text, pos, "{", "}", bmap)
                    if g2 is not None:
                        pos = _skip_ws(text, g2[1])
                        if pos < n and text[pos] == "[":
                            opt = _read_balanced(text, pos, "[", "]", kmap)
                            if opt is not None:
                                pos = _skip_ws(text, opt[1])
                        i = pos
                        continue
                elif pos < n and text[pos] in "*=":
                    pos = _skip_ws(text, pos + 1)
                    if pos < n and text[pos] == "[":
                        opt = _read_balanced(text, pos, "[", "]", kmap)
                        if opt is not None:
                            pos = _skip_ws(text, opt[1])
                    i = pos
                    continue
        if name == "makecell":
            pos = _skip_ws(text, after)
            if pos < n and text[pos] == "[":
                opt = _read_balanced(text, pos, "[", "]", kmap)
                if opt is not None:
                    pos = _skip_ws(text, opt[1])
            i = pos
            continue

        i = after

    raw_out = "".join(out)
    raw_out = raw_out.replace("$↑$", "↑").replace("$↓$", "↓").replace("$±$", "±")
    if preserve_newlines:
        lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in raw_out.split("\n")]
        cleaned_lines: list[str] = []
        blank_run = 0
        for ln in lines:
            if not ln:
                blank_run += 1
                if blank_run <= 1 and cleaned_lines:
                    cleaned_lines.append("")
            else:
                blank_run = 0
                cleaned_lines.append(ln)
        return "\n".join(cleaned_lines).strip()
    return re.sub(r"\s+", " ", raw_out).strip()


# ═══════════════════════════════════════════════════════════════════════════
# 5. Root .tex Detection & Bounded \input / \include Expansion
# ═══════════════════════════════════════════════════════════════════════════

def _has_documentclass_and_begin_document(stripped_tex: str) -> bool:
    masked = mask_verbatim_for_parsing(stripped_tex)
    bmap = build_delimiter_map(masked, "{", "}")
    has_docclass = False
    has_begin_doc = False
    n = len(masked)
    i = 0
    while i < n:
        if masked[i] == "\\":
            name, after = _read_command_name(masked, i)
            if name == "documentclass":
                has_docclass = True
            elif name == "begin":
                pos = _skip_ws(masked, after)
                grp = _read_balanced(masked, pos, "{", "}", bmap)
                if grp is not None and grp[0].strip() == "document":
                    has_begin_doc = True
            if has_docclass and has_begin_doc:
                return True
            i = after
        else:
            i += 1
    return False


def detect_root_tex(files: dict[str, bytes]) -> str:
    """Deterministically auto-detect the root .tex file containing \\documentclass and \\begin{document}."""
    candidates: list[tuple[tuple[int, int, int, int, str], str]] = []
    for path_key in sorted(files.keys()):
        if not path_key.lower().endswith(_TEX_EXTS) or _is_macos_junk_path(path_key):
            continue
        text = _decode_tex_bytes(files[path_key], path_key)
        stripped, _ = strip_tex_comments(text)
        if not _has_documentclass_and_begin_document(stripped):
            continue
        depth = path_key.count("/")
        basename = path_key.rsplit("/", 1)[-1].lower()
        name_rank = _CANONICAL_ROOT_NAMES.index(basename) if basename in _CANONICAL_ROOT_NAMES else len(_CANONICAL_ROOT_NAMES)
        has_structure = 0 if (
            "\\begin{abstract}" in stripped
            or "\\section" in stripped
            or "\\input" in stripped
            or "\\include{" in stripped
        ) else 1
        score = (depth, name_rank, has_structure, -len(stripped), path_key)
        candidates.append((score, path_key))

    if not candidates:
        raise ArxivTexExtractError(
            "No root .tex file containing both \\documentclass and \\begin{document} found",
            code="NO_ROOT_TEX",
        )
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def expand_tex_inputs(
    files: dict[str, bytes],
    root_tex_file: str,
    *,
    max_input_depth: int = DEFAULT_MAX_INPUT_DEPTH,
    max_input_expansions: int = DEFAULT_MAX_INPUT_EXPANSIONS,
    max_expanded_chars: int = DEFAULT_MAX_EXPANDED_CHARS,
) -> tuple[str, list[str], int]:
    """Strip comments and safely expand \\input{}/\\include{} with cycle, depth, expansion-count & size caps."""
    root_dir = root_tex_file.rsplit("/", 1)[0] if "/" in root_tex_file else ""
    included_files: list[str] = []
    included_seen: set[str] = set()
    stripped_total = [0]
    char_counter = [0]
    expansion_counter = [0]

    stripped_cache: dict[str, tuple[str, str, dict[int, int]]] = {}

    def _load_file_bundle(file_path: str) -> tuple[str, str, dict[int, int]]:
        if file_path not in stripped_cache:
            raw_text = _decode_tex_bytes(files[file_path], file_path)
            stripped, count = strip_tex_comments(raw_text)
            stripped_total[0] += count
            masked = mask_verbatim_for_parsing(stripped)
            bmap = build_delimiter_map(masked, "{", "}")
            stripped_cache[file_path] = (stripped, masked, bmap)
        return stripped_cache[file_path]

    def _resolve_candidate(target_norm: str) -> str | None:
        candidates: list[str] = []
        if root_dir:
            candidates.append(f"{root_dir}/{target_norm}")
            if not target_norm.lower().endswith(".tex"):
                candidates.append(f"{root_dir}/{target_norm}.tex")
        candidates.append(target_norm)
        if not target_norm.lower().endswith(".tex"):
            candidates.append(f"{target_norm}.tex")
        for cand in candidates:
            if cand in files:
                return cand
        return None

    def _append_piece(buf: list[str], piece: str) -> None:
        if not piece:
            return
        char_counter[0] += len(piece)
        if char_counter[0] > max_expanded_chars:
            raise ArxivTexExtractError(
                f"Expanded TeX content exceeds {max_expanded_chars} character limit",
                code="EXPANDED_SIZE_EXCEEDED",
            )
        buf.append(piece)

    def _expand_file(file_path: str, depth: int, active_stack: list[str]) -> str:
        content, masked, bmap = _load_file_bundle(file_path)
        n = len(masked)
        out: list[str] = []
        i = 0
        literal_start = 0

        while i < n:
            if masked[i] != "\\":
                nxt = masked.find("\\", i)
                if nxt == -1:
                    break
                i = nxt
                continue

            name, after = _read_command_name(masked, i)
            if name in ("input", "include"):
                pos = _skip_ws(masked, after)
                if pos < n and masked[pos] == "{":
                    grp = _read_balanced(masked, pos, "{", "}", bmap)
                    if grp is not None:
                        expansion_counter[0] += 1
                        if expansion_counter[0] > max_input_expansions:
                            raise ArxivTexExtractError(
                                f"\\input/\\include directive count exceeds limit of {max_input_expansions}",
                                code="TOO_MANY_INPUT_EXPANSIONS",
                            )
                        _append_piece(out, content[literal_start:i])
                        target_norm = _validate_input_target_path(grp[0])
                        resolved = _resolve_candidate(target_norm)
                        if resolved is not None:
                            if resolved in active_stack:
                                chain = " -> ".join(active_stack + [resolved])
                                raise ArxivTexExtractError(
                                    f"Cycle detected in \\input/\\include: {chain}",
                                    code="INPUT_CYCLE",
                                )
                            if depth + 1 > max_input_depth:
                                raise ArxivTexExtractError(
                                    f"\\input/\\include nesting depth exceeds limit of {max_input_depth}",
                                    code="INPUT_DEPTH_EXCEEDED",
                                )
                            if resolved not in included_seen:
                                included_seen.add(resolved)
                                included_files.append(resolved)
                            child_text = _expand_file(resolved, depth + 1, active_stack + [resolved])
                            out.append(child_text)
                        literal_start = grp[1]
                        i = grp[1]
                        continue
            i = after

        _append_piece(out, content[literal_start:])
        return "".join(out)

    expanded = _expand_file(root_tex_file, 0, [root_tex_file])
    return expanded, included_files, stripped_total[0]


# ═══════════════════════════════════════════════════════════════════════════
# 6. Structured AST Extraction
# ═══════════════════════════════════════════════════════════════════════════

def _split_document(expanded_tex: str) -> tuple[str, str, int]:
    """Split expanded TeX into (preamble, body, body_char_offset), respecting verbatim regions."""
    masked = mask_verbatim_for_parsing(expanded_tex)
    docs = _find_environments(masked, {"document"})
    if not docs:
        raise ArxivTexExtractError(
            "Root TeX file missing complete \\begin{document}...\\end{document}",
            code="NO_ROOT_TEX",
        )
    doc = docs[0]
    return (
        expanded_tex[: doc["start"]],
        expanded_tex[doc["body_start"] : doc["body_end"]],
        doc["body_start"],
    )


def _extract_first_command_arg(
    text: str,
    cmd_names: frozenset[str],
    *,
    allow_opt: bool = True,
    bmap: dict[int, int] | None = None,
    kmap: dict[int, int] | None = None,
) -> str | None:
    bm = bmap if bmap is not None else build_delimiter_map(text, "{", "}")
    km = kmap if kmap is not None else build_delimiter_map(text, "[", "]")
    for item in _iter_named_commands(text, cmd_names, allow_star=False):
        pos = _skip_ws(text, item["after"])
        if allow_opt and pos < len(text) and text[pos] == "[":
            opt = _read_balanced(text, pos, "[", "]", km)
            if opt is not None:
                pos = _skip_ws(text, opt[1])
        grp = _read_balanced(text, pos, "{", "}", bm)
        if grp is not None:
            return grp[0]
    return None


def extract_title(preamble: str, body: str) -> str:
    header_region = preamble + "\n" + body[: min(len(body), 20000)]
    raw_title = _extract_first_command_arg(header_region, frozenset({"icmltitle", "title"}))
    if raw_title is None:
        return ""
    return clean_tex_text(raw_title, preserve_newlines=False)


def extract_abstract(body: str) -> str:
    masked = mask_verbatim_for_parsing(body)
    envs = _find_environments(masked, {"abstract"})
    if envs:
        env = envs[0]
        return clean_tex_text(body[env["body_start"] : env["body_end"]], preserve_newlines=True)
    raw_abs = _extract_first_command_arg(body[: min(len(body), 30000)], frozenset({"abstract"}))
    if raw_abs is not None:
        return clean_tex_text(raw_abs, preserve_newlines=True)
    return ""


# ─── Author & Affiliation Extraction (Unified Markers, Fail-Closed) ───────

def _split_top_level(text: str, delimiter: str) -> list[str]:
    parts: list[str] = []
    n = len(text)
    dlen = len(delimiter)
    depth = 0
    bs_count = 0
    start = 0
    i = 0
    while i < n:
        ch = text[i]
        if ch == "\\":
            if depth == 0 and delimiter.startswith("\\") and text[i : i + dlen] == delimiter:
                if delimiter[-1].isalpha():
                    after_idx = i + dlen
                    if after_idx >= n or not (text[after_idx].isalpha() or text[after_idx] == "@"):
                        parts.append(text[start:i])
                        i += dlen
                        start = i
                        bs_count = 0
                        continue
                else:
                    parts.append(text[start:i])
                    i += dlen
                    start = i
                    bs_count = 0
                    continue
            bs_count += 1
            i += 1
            continue
        escaped = (bs_count % 2 == 1)
        bs_count = 0
        if not escaped:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth = max(0, depth - 1)
            elif depth == 0 and not delimiter.startswith("\\") and text[i : i + dlen] == delimiter:
                parts.append(text[start:i])
                i += dlen
                start = i
                continue
        i += 1
    parts.append(text[start:])
    return parts


def _split_top_level_and_commands(text: str) -> list[str]:
    """Split on top-level \\and, \\And, or \\AND (LaTeX/NeurIPS/ICLR author separators)."""
    parts: list[str] = []
    n = len(text)
    depth = 0
    bs_count = 0
    start = 0
    i = 0
    while i < n:
        ch = text[i]
        if ch == "\\":
            if depth == 0 and bs_count % 2 == 0:
                name, after = _read_command_name(text, i)
                if name in ("and", "And", "AND"):
                    parts.append(text[start:i])
                    start = after
                    i = after
                    bs_count = 0
                    continue
            bs_count += 1
            i += 1
            continue
        escaped = (bs_count % 2 == 1)
        bs_count = 0
        if not escaped:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth = max(0, depth - 1)
        i += 1
    parts.append(text[start:])
    return parts


def _normalize_marker_tokens(raw_marker: str) -> list[str]:
    cleaned = raw_marker.strip()
    if not cleaned:
        return []
    cleaned = cleaned.replace("$", "").replace("{", "").replace("}", "")
    cleaned = re.sub(r"\\(?:text|mathrm|mathbf|mathit|textrm|textsf|scriptsize|tiny|footnotesize)\b", "", cleaned)
    cleaned = cleaned.replace("\\,", ",").replace(";", ",")
    tokens: list[str] = []
    for piece in cleaned.split(","):
        tok = piece.strip()
        if not tok:
            continue
        if re.fullmatch(r"[0-9A-Za-z_-]+", tok):
            tokens.append(tok)
            continue
        for st in re.findall(r"\\[A-Za-z]+|[0-9A-Za-z_-]+|[*†‡§¶]", tok):
            if st:
                tokens.append(st)
    seen: set[str] = set()
    result: list[str] = []
    for tok in tokens:
        if tok not in seen:
            seen.add(tok)
            result.append(tok)
    return result


def _match_inline_marker_at(
    text: str,
    pos: int,
    bmap: dict[int, int],
    kmap: dict[int, int],
) -> tuple[list[str], int] | None:
    """Unified inline marker recognizer at `pos` supporting $^k$, ${}^k$, $\\,^k$, and marker commands."""
    n = len(text)
    ch = text[pos]
    if ch == "$":
        end_math = text.find("$", pos + 1)
        if end_math != -1:
            inner = text[pos + 1 : end_math].strip()
            # Strip optional leading spacing macros and empty base {} (e.g. $\,^1$, ${}^1$, $\;^{1,2}$)
            inner = re.sub(r"^(?:\\[,;:! ]|\{\}|~|[ \t])+", "", inner)
            if inner.startswith("^"):
                toks = _normalize_marker_tokens(inner[1:])
                if toks:
                    return toks, end_math + 1
        return None
    if ch == "^":
        p = pos + 1
        if p < n and text[p] == "{":
            grp = _read_balanced(text, p, "{", "}", bmap)
            if grp is not None:
                toks = _normalize_marker_tokens(grp[0])
                if toks:
                    return toks, grp[1]
        elif p < n and text[p] == "\\":
            cmd, after = _read_command_name(text, p)
            toks = _normalize_marker_tokens("\\" + cmd)
            if toks:
                return toks, after
        elif p < n and not text[p].isspace():
            toks = _normalize_marker_tokens(text[p])
            if toks:
                return toks, p + 1
        return None
    if ch == "\\":
        name, after = _read_command_name(text, pos)
        if name in _MARKER_COMMANDS:
            p = _skip_ws(text, after)
            if p < n and text[p] == "[":
                opt = _read_balanced(text, p, "[", "]", kmap)
                if opt is not None:
                    toks = _normalize_marker_tokens(opt[0])
                    if toks:
                        return toks, opt[1]
            grp = _read_balanced(text, p, "{", "}", bmap)
            if grp is not None:
                toks = _normalize_marker_tokens(grp[0])
                if toks:
                    return toks, grp[1]
    return None


def _has_inline_marker_syntax(text: str) -> bool:
    """Single source of truth for inline marker presence using _match_inline_marker_at (zero regex drift)."""
    bmap = build_delimiter_map(text, "{", "}")
    kmap = build_delimiter_map(text, "[", "]")
    n = len(text)
    i = 0
    while i < n:
        if _match_inline_marker_at(text, i, bmap, kmap) is not None:
            return True
        if text[i] == "\\":
            # Skip escaped commands & accents (e.g., \^{o}) so accents never false-match bare '^'
            _, after = _read_command_name(text, i)
            i = after
            continue
        i += 1
    return False


def _extract_thanks_and_strip(text: str) -> tuple[str, list[str]]:
    bmap = build_delimiter_map(text, "{", "}")
    thanks_list: list[str] = []
    n = len(text)
    out: list[str] = []
    i = 0
    while i < n:
        if text[i] == "\\":
            name, after = _read_command_name(text, i)
            if name == "thanks":
                pos = _skip_ws(text, after)
                grp = _read_balanced(text, pos, "{", "}", bmap)
                if grp is not None:
                    cleaned = clean_tex_text(grp[0], preserve_newlines=False)
                    if cleaned:
                        thanks_list.append(cleaned)
                    i = grp[1]
                    continue
            out.append(text[i:after])
            i = after
        else:
            out.append(text[i])
            i += 1
    return "".join(out), thanks_list


def _extract_inline_markers_and_strip(text: str) -> tuple[str, list[str]]:
    bmap = build_delimiter_map(text, "{", "}")
    kmap = build_delimiter_map(text, "[", "]")
    markers: list[str] = []
    n = len(text)
    out: list[str] = []
    i = 0
    while i < n:
        m = _match_inline_marker_at(text, i, bmap, kmap)
        if m is not None:
            markers.extend(m[0])
            i = m[1]
            continue
        if text[i] == "\\":
            _, after = _read_command_name(text, i)
            out.append(text[i:after])
            i = after
            continue
        out.append(text[i])
        i += 1
    dedup: list[str] = []
    seen: set[str] = set()
    for mk in markers:
        if mk not in seen:
            seen.add(mk)
            dedup.append(mk)
    return "".join(out), dedup


def _extract_leading_affil_marker(text: str) -> tuple[str | None, str]:
    s = text.lstrip()
    if not s:
        return None, ""
    bmap = build_delimiter_map(s, "{", "}")
    kmap = build_delimiter_map(s, "[", "]")
    m = _match_inline_marker_at(s, 0, bmap, kmap)
    if m is not None and len(m[0]) == 1:
        return m[0][0], s[m[1] :].lstrip()
    return None, s


def _split_inline_keyed_affiliations(raw_text: str) -> tuple[list[dict[str, Any]], bool]:
    """Split affiliation text on inline markers (e.g. '$^1$MIT, $^2$CMU' or across \\\\ lines).

    Returns (affiliations_list, segmentation_ambiguous).
    Fails closed (segmentation_ambiguous=True) when markers appear mid-text after unkeyed
    leading text, or when a multi-token marker appears on an affiliation, or when residual
    markers remain unsegmented.
    """
    bmap = build_delimiter_map(raw_text, "{", "}")
    kmap = build_delimiter_map(raw_text, "[", "]")
    n = len(raw_text)
    marker_hits: list[tuple[int, int, list[str]]] = []
    i = 0
    while i < n:
        m = _match_inline_marker_at(raw_text, i, bmap, kmap)
        if m is not None:
            marker_hits.append((i, m[1], m[0]))
            i = m[1]
            continue
        if raw_text[i] == "\\":
            _, after = _read_command_name(raw_text, i)
            i = after
            continue
        i += 1

    if not marker_hits:
        return [], False

    # If non-trivial unkeyed text appears BEFORE the first marker -> ambiguous segmentation!
    leading_text = clean_tex_text(raw_text[: marker_hits[0][0]], preserve_newlines=False).strip(" ,;:")
    if leading_text:
        return [{"marker": None, "text": _clean_affiliation_body(raw_text)}], True

    parsed: list[dict[str, Any]] = []
    ambiguous = False
    for idx, (_start, end, toks) in enumerate(marker_hits):
        seg_end = marker_hits[idx + 1][0] if idx + 1 < len(marker_hits) else n
        seg_raw = raw_text[end:seg_end]
        # Clean trailing separators like ',', ';', '\quad', 'and'
        seg_text = _clean_affiliation_body(seg_raw).strip(" ,;:")
        if len(toks) != 1:
            ambiguous = True
            if seg_text:
                parsed.append({"marker": None, "text": seg_text})
            continue
        if seg_text:
            parsed.append({"marker": toks[0], "text": seg_text})
        else:
            ambiguous = True

    return parsed, ambiguous


def _split_top_level_word_and(text: str) -> list[str]:
    parts: list[str] = []
    n = len(text)
    depth = 0
    bs_count = 0
    start = 0
    i = 0
    while i < n:
        ch = text[i]
        if ch == "\\":
            bs_count += 1
            i += 1
            continue
        escaped = (bs_count % 2 == 1)
        bs_count = 0
        if not escaped:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth = max(0, depth - 1)
            elif depth == 0 and ch.isspace():
                ws_end = i
                while ws_end < n and text[ws_end].isspace():
                    ws_end += 1
                if text[ws_end : ws_end + 3] == "and":
                    after_and = ws_end + 3
                    if after_and < n and text[after_and].isspace():
                        ws2_end = after_and
                        while ws2_end < n and text[ws2_end].isspace():
                            ws2_end += 1
                        parts.append(text[start:i])
                        start = ws2_end
                        i = ws2_end
                        continue
                i = ws_end
                continue
        i += 1
    parts.append(text[start:])
    return parts


def _strip_email_tokens(name: str) -> str:
    return " ".join(tok for tok in name.split() if "@" not in tok).strip(" ,;:")


def _split_author_names(
    raw_chunk: str,
    default_markers: list[str] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    all_thanks: list[str] = []
    authors: list[dict[str, Any]] = []
    base_markers = list(default_markers or [])

    and_chunks = _split_top_level_and_commands(raw_chunk)
    pieces: list[str] = []
    for chunk in and_chunks:
        for comma_piece in _split_top_level(chunk, ","):
            pieces.extend(_split_top_level_word_and(comma_piece))

    for piece in pieces:
        without_thanks, item_thanks = _extract_thanks_and_strip(piece)
        all_thanks.extend(item_thanks)
        without_markers, item_markers = _extract_inline_markers_and_strip(without_thanks)
        name = _strip_email_tokens(clean_tex_text(without_markers, preserve_newlines=False))
        if not name:
            continue
        merged_markers = list(base_markers)
        for m in item_markers:
            if m not in merged_markers:
                merged_markers.append(m)
        authors.append({
            "name": name,
            "markers": merged_markers,
            "affiliations": [],
            "thanks": item_thanks,
            "bindingStatus": "unmapped",
        })
    return authors, all_thanks


def _bind_authors_to_affiliations(
    authors: list[dict[str, Any]],
    affiliations: list[dict[str, Any]],
    *,
    force_ambiguous: bool = False,
) -> str:
    if not authors:
        return "none"
    if not affiliations:
        for a in authors:
            a["affiliations"] = []
            a["bindingStatus"] = "unmapped"
        return "unmapped"

    if force_ambiguous:
        for a in authors:
            a["affiliations"] = []
            a["bindingStatus"] = "ambiguous"
        return "ambiguous"

    marker_map: dict[str, str] = {}
    ambiguous_keys: set[str] = set()
    for aff in affiliations:
        mk = aff.get("marker")
        txt = aff.get("text", "")
        if mk is not None and txt:
            if mk in marker_map and marker_map[mk] != txt:
                ambiguous_keys.add(mk)
            else:
                marker_map[mk] = txt

    # Compute relevant (non-footnote) markers per author first so footnote * never breaks single-affiliation binding
    per_author_relevant: list[list[str]] = []
    for a in authors:
        rel = [
            m for m in a["markers"]
            if (m in marker_map or m in ambiguous_keys) or (m not in _FOOTNOTE_ONLY_MARKERS)
        ]
        per_author_relevant.append(rel)

    any_relevant_marker = any(bool(rel) for rel in per_author_relevant)
    any_ambiguous = False
    any_bound = False

    for a, relevant_markers in zip(authors, per_author_relevant):
        if relevant_markers:
            if any(m in ambiguous_keys or m not in marker_map for m in relevant_markers):
                a["affiliations"] = []
                a["bindingStatus"] = "ambiguous"
                any_ambiguous = True
            else:
                bound: list[str] = []
                for m in relevant_markers:
                    val = marker_map[m]
                    if val not in bound:
                        bound.append(val)
                a["affiliations"] = bound
                a["bindingStatus"] = "bound"
                any_bound = True
        else:
            if len(affiliations) == 1 and not any_relevant_marker and affiliations[0]["marker"] is None:
                a["affiliations"] = [affiliations[0]["text"]]
                a["bindingStatus"] = "bound"
                any_bound = True
            else:
                a["affiliations"] = []
                a["bindingStatus"] = "ambiguous"
                any_ambiguous = True

    if any_ambiguous:
        return "ambiguous"
    if any_bound:
        if len(affiliations) == 1 and not any_relevant_marker and affiliations[0]["marker"] is None:
            return "single_affiliation"
        return "bound"
    return "unmapped"


def _parse_ieee_author_block(
    raw_author_arg: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], str]:
    authors: list[dict[str, Any]] = []
    affiliations: list[dict[str, Any]] = []
    thanks_all: list[str] = []

    blocks = _split_top_level_and_commands(raw_author_arg)
    block_records: list[tuple[list[str], list[str]]] = []
    for blk in blocks:
        bmap = build_delimiter_map(blk, "{", "}")
        names_raw: list[str] = []
        affs_raw: list[str] = []
        for item in _iter_named_commands(blk, frozenset({"IEEEauthorblockN", "IEEEauthorblockA"})):
            pos = _skip_ws(blk, item["after"])
            grp = _read_balanced(blk, pos, "{", "}", bmap)
            if grp is None:
                continue
            if item["name"] == "IEEEauthorblockN":
                names_raw.append(grp[0])
            else:
                affs_raw.append(grp[0])
        if names_raw or affs_raw:
            block_records.append((names_raw, affs_raw))

    has_refmarks = any(
        _has_inline_marker_syntax(s)
        for names_r, affs_r in block_records
        for s in (*names_r, *affs_r)
    )

    if has_refmarks:
        seg_ambiguous = False
        for names_r, affs_r in block_records:
            for nr in names_r:
                parsed_a, th = _split_author_names(nr)
                authors.extend(parsed_a)
                thanks_all.extend(th)
            for ar in affs_r:
                ar_clean, th = _extract_thanks_and_strip(ar)
                thanks_all.extend(th)
                inline_affs, is_amb = _split_inline_keyed_affiliations(ar_clean)
                if inline_affs:
                    affiliations.extend(inline_affs)
                    if is_amb:
                        seg_ambiguous = True
                else:
                    aff_text = _clean_affiliation_body(ar_clean)
                    if aff_text:
                        affiliations.append({"marker": None, "text": aff_text})
        status = _bind_authors_to_affiliations(authors, affiliations, force_ambiguous=seg_ambiguous)
        return authors, affiliations, thanks_all, status

    any_ambiguous = False
    for names_r, affs_r in block_records:
        block_authors: list[dict[str, Any]] = []
        for nr in names_r:
            parsed_a, th = _split_author_names(nr)
            block_authors.extend(parsed_a)
            thanks_all.extend(th)
        block_affs: list[str] = []
        for ar in affs_r:
            ar_clean, th = _extract_thanks_and_strip(ar)
            thanks_all.extend(th)
            lines = [clean_tex_text(ln, preserve_newlines=False) for ln in _split_top_level(ar_clean, "\\\\")]
            lines = [ln for ln in lines if ln and "@" not in ln]
            aff_text = ", ".join(lines)
            if aff_text:
                block_affs.append(aff_text)
                affiliations.append({"marker": None, "text": aff_text})
        if len(names_r) == 1 and len(block_affs) == 1:
            for a in block_authors:
                a["affiliations"] = [block_affs[0]]
                a["bindingStatus"] = "bound"
        elif len(block_affs) == 0:
            for a in block_authors:
                a["affiliations"] = []
                a["bindingStatus"] = "unmapped"
        else:
            any_ambiguous = True
            for a in block_authors:
                a["affiliations"] = []
                a["bindingStatus"] = "ambiguous"
        authors.extend(block_authors)

    if not authors:
        return authors, affiliations, thanks_all, "none"
    if any_ambiguous:
        return authors, affiliations, thanks_all, "ambiguous"
    if all(a["bindingStatus"] == "bound" for a in authors):
        return authors, affiliations, thanks_all, "bound"
    if all(a["bindingStatus"] == "unmapped" for a in authors):
        return authors, affiliations, thanks_all, "unmapped"
    return authors, affiliations, thanks_all, "ambiguous"


def _clean_affiliation_body(raw_aff: str) -> str:
    if any(tok in raw_aff for tok in ("\\institution", "\\department", "\\city", "\\country", "\\state")):
        bmap = build_delimiter_map(raw_aff, "{", "}")
        parts: list[str] = []
        for item in _iter_named_commands(
            raw_aff,
            frozenset({"department", "institution", "city", "state", "country"}),
        ):
            pos = _skip_ws(raw_aff, item["after"])
            grp = _read_balanced(raw_aff, pos, "{", "}", bmap)
            if grp is not None:
                val = clean_tex_text(grp[0], preserve_newlines=False)
                if val:
                    parts.append(val)
        if parts:
            return ", ".join(parts)
    lines = _split_top_level(raw_aff, "\\\\")
    cleaned_lines = [clean_tex_text(ln, preserve_newlines=False) for ln in lines]
    cleaned_lines = [ln for ln in cleaned_lines if ln]
    return ", ".join(cleaned_lines)


def extract_authors_and_affiliations(
    preamble: str,
    body: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], str]:
    first_sec = body.find("\\section")
    body_header = body[:first_sec] if first_sec != -1 else body[:25000]
    header_region = preamble + "\n" + body_header
    bmap = build_delimiter_map(header_region, "{", "}")
    kmap = build_delimiter_map(header_region, "[", "]")

    all_thanks: list[str] = []

    def _add_thanks(items: list[str]) -> None:
        for t in items:
            if t and t not in all_thanks:
                all_thanks.append(t)

    raw_title_arg = _extract_first_command_arg(
        header_region, frozenset({"icmltitle", "title"}), bmap=bmap, kmap=kmap
    )
    if raw_title_arg:
        _, title_thanks = _extract_thanks_and_strip(raw_title_arg)
        _add_thanks(title_thanks)

    # 1. ICML style (\icmlauthor + \icmlaffiliation)
    icml_cmds = _iter_named_commands(header_region, frozenset({"icmlauthor", "icmlaffiliation", "icmlEqualContribution"}))
    if any(c["name"] == "icmlauthor" for c in icml_cmds):
        authors: list[dict[str, Any]] = []
        affiliations: list[dict[str, Any]] = []
        for item in icml_cmds:
            pos = _skip_ws(header_region, item["after"])
            if item["name"] == "icmlauthor":
                g1 = _read_balanced(header_region, pos, "{", "}", bmap)
                if g1 is None:
                    continue
                g2 = _read_balanced(header_region, _skip_ws(header_region, g1[1]), "{", "}", bmap)
                if g2 is None:
                    continue
                name_raw, th = _extract_thanks_and_strip(g1[0])
                _add_thanks(th)
                name = clean_tex_text(name_raw, preserve_newlines=False)
                markers = _normalize_marker_tokens(g2[0])
                if name:
                    authors.append({
                        "name": name,
                        "markers": markers,
                        "affiliations": [],
                        "thanks": th,
                        "bindingStatus": "unmapped",
                    })
            elif item["name"] == "icmlaffiliation":
                g1 = _read_balanced(header_region, pos, "{", "}", bmap)
                if g1 is None:
                    continue
                g2 = _read_balanced(header_region, _skip_ws(header_region, g1[1]), "{", "}", bmap)
                if g2 is None:
                    continue
                key = g1[0].strip()
                aff_text = _clean_affiliation_body(g2[0])
                if aff_text:
                    affiliations.append({"marker": key or None, "text": aff_text})
        status = _bind_authors_to_affiliations(authors, affiliations)
        return authors, affiliations, all_thanks, status

    # 2. Ordered scan of \author, \affil, \affiliation, \institute, \address
    target_cmds = frozenset({"author", "affil", "affiliation", "institute", "address"})
    events: list[dict[str, Any]] = []
    for item in _iter_named_commands(header_region, target_cmds):
        pos = _skip_ws(header_region, item["after"])
        opt_arg: str | None = None
        if pos < len(header_region) and header_region[pos] == "[":
            opt = _read_balanced(header_region, pos, "[", "]", kmap)
            if opt is not None:
                opt_arg = opt[0]
                pos = _skip_ws(header_region, opt[1])
        grp = _read_balanced(header_region, pos, "{", "}", bmap)
        if grp is None:
            continue
        events.append({
            "name": item["name"],
            "opt": opt_arg,
            "arg": grp[0],
            "start": item["start"],
        })

    # 2a. IEEE style inside \author{...}
    for ev in events:
        if ev["name"] == "author" and ("\\IEEEauthorblockN" in ev["arg"] or "\\IEEEauthorblockA" in ev["arg"]):
            authors, affiliations, th, status = _parse_ieee_author_block(ev["arg"])
            _add_thanks(th)
            return authors, affiliations, all_thanks, status

    author_events = [e for e in events if e["name"] == "author"]
    affil_events = [e for e in events if e["name"] != "author"]

    has_explicit_opt_markers = any(e["opt"] is not None and e["opt"].strip() for e in events)
    has_inline_markers = any(_has_inline_marker_syntax(e["arg"]) for e in events)

    # 2b. Interleaved ACM/RevTeX style — reject if an affiliation precedes the first author!
    is_interleaved = False
    if len(author_events) >= 2 and affil_events and not has_explicit_opt_markers and not has_inline_markers:
        first_author_pos = author_events[0]["start"]
        last_author_pos = author_events[-1]["start"]
        affil_before_first_author = any(ae["start"] < first_author_pos for ae in affil_events)
        if not affil_before_first_author and any(first_author_pos < ae["start"] < last_author_pos for ae in affil_events):
            is_interleaved = True

    if is_interleaved:
        authors = []
        affiliations = []
        pending_authors: list[dict[str, Any]] = []
        last_group: list[dict[str, Any]] = []
        for ev in events:
            if ev["name"] == "author":
                parsed_a, th = _split_author_names(ev["arg"])
                _add_thanks(th)
                authors.extend(parsed_a)
                pending_authors.extend(parsed_a)
                last_group = pending_authors
            else:
                aff_clean_raw, th = _extract_thanks_and_strip(ev["arg"])
                _add_thanks(th)
                aff_text = _clean_affiliation_body(aff_clean_raw)
                if aff_text:
                    affiliations.append({"marker": None, "text": aff_text})
                    target_group = pending_authors if pending_authors else last_group
                    for a in target_group:
                        if aff_text not in a["affiliations"]:
                            a["affiliations"].append(aff_text)
                        a["bindingStatus"] = "bound"
                    pending_authors = []
        for a in pending_authors:
            a["bindingStatus"] = "unmapped"
        if not authors:
            return [], affiliations, all_thanks, "none"
        if all(a["bindingStatus"] == "bound" for a in authors):
            return authors, affiliations, all_thanks, "bound"
        return authors, affiliations, all_thanks, "ambiguous"

    # 2c. Explicit-marker / authblk / LLNCS / standard \author + \affil/\affiliation/\institute/\address
    authors = []
    affiliations = []
    used_llncs_inst = False
    seg_ambiguous = False

    for ev in author_events:
        # Use exact command match (not substring!) so \institution never triggers LLNCS mode
        if _iter_named_commands(ev["arg"], frozenset({"inst"})):
            used_llncs_inst = True
        opt_markers = _normalize_marker_tokens(ev["opt"]) if ev["opt"] else []
        parsed_a, th = _split_author_names(ev["arg"], default_markers=opt_markers)
        _add_thanks(th)
        authors.extend(parsed_a)

    for ev in affil_events:
        raw_arg, th = _extract_thanks_and_strip(ev["arg"])
        _add_thanks(th)
        opt_markers = _normalize_marker_tokens(ev["opt"]) if ev["opt"] else []
        if opt_markers:
            aff_text = _clean_affiliation_body(raw_arg)
            if aff_text:
                for mk in opt_markers:
                    affiliations.append({"marker": mk, "text": aff_text})
            continue

        # Handle LLNCS \institute{Inst 1 \and Inst 2} AND single-institute \institute{ETH Zurich} + \inst{1}
        if ev["name"] == "institute" and (used_llncs_inst or "\\and" in raw_arg):
            inst_parts = _split_top_level_and_commands(raw_arg)
            has_explicit_lead = any(_extract_leading_affil_marker(p)[0] is not None for p in inst_parts)
            for idx, part in enumerate(inst_parts, start=1):
                mk, rest = _extract_leading_affil_marker(part)
                aff_text = _clean_affiliation_body(rest)
                if not aff_text:
                    continue
                if mk is not None:
                    affiliations.append({"marker": mk, "text": aff_text})
                elif used_llncs_inst and not has_explicit_lead:
                    affiliations.append({"marker": str(idx), "text": aff_text})
                else:
                    affiliations.append({"marker": None, "text": aff_text})
            continue

        # Inline marker splitting across the entire affiliation argument (handles both \\ and single-line markers)
        inline_affs, is_amb = _split_inline_keyed_affiliations(raw_arg)
        if inline_affs:
            affiliations.extend(inline_affs)
            if is_amb:
                seg_ambiguous = True
        else:
            aff_text = _clean_affiliation_body(raw_arg)
            if aff_text:
                affiliations.append({"marker": None, "text": aff_text})

    status = _bind_authors_to_affiliations(authors, affiliations, force_ambiguous=seg_ambiguous)
    return authors, affiliations, all_thanks, status


# ─── Sections Extraction ──────────────────────────────────────────────────

def _strip_float_environments(text: str) -> str:
    float_envs = frozenset({
        "table", "table*", "sidewaystable", "sidewaystable*", "wraptable",
        "figure", "figure*", "wrapfigure", "sidewaysfigure", "SCfigure",
        "thebibliography",
    })
    masked = mask_verbatim_for_parsing(text)
    envs = _find_environments(masked, float_envs)
    if not envs:
        return text
    pieces: list[str] = []
    cursor = 0
    for env in envs:
        pieces.append(text[cursor : env["start"]])
        cursor = env["end"]
    pieces.append(text[cursor:])
    return "".join(pieces)


def extract_sections(body: str, body_char_offset: int) -> list[dict[str, Any]]:
    level_map = {"section": 1, "subsection": 2, "subsubsection": 3}
    masked = mask_verbatim_for_parsing(body)
    bmap = build_delimiter_map(masked, "{", "}")
    kmap = build_delimiter_map(masked, "[", "]")
    headings: list[dict[str, Any]] = []

    for item in _iter_named_commands(masked, frozenset(level_map.keys()), allow_star=True):
        pos = _skip_ws(masked, item["after"])
        if pos < len(masked) and masked[pos] == "[":
            opt = _read_balanced(masked, pos, "[", "]", kmap)
            if opt is not None:
                pos = _skip_ws(masked, opt[1])
        grp = _read_balanced(masked, pos, "{", "}", bmap)
        if grp is None:
            continue
        title = clean_tex_text(body[pos + 1 : grp[1] - 1], preserve_newlines=False)
        headings.append({
            "level": level_map[item["name"]],
            "title": title,
            "start": item["start"],
            "content_start": grp[1],
            "charOffset": body_char_offset + item["start"],
        })

    bib_boundary = len(body)
    for marker in ("\\begin{thebibliography}", "\\bibliography{"):
        idx = masked.find(marker)
        if idx != -1 and idx < bib_boundary:
            bib_boundary = idx

    sections: list[dict[str, Any]] = []
    for idx, heading in enumerate(headings):
        next_start = headings[idx + 1]["start"] if idx + 1 < len(headings) else bib_boundary
        if next_start < heading["content_start"]:
            next_start = len(body)
        raw_slice = body[heading["content_start"] : next_start]
        prose_slice = _strip_float_environments(raw_slice)
        sections.append({
            "level": heading["level"],
            "title": heading["title"],
            "text": clean_tex_text(prose_slice, preserve_newlines=True),
            "charOffset": heading["charOffset"],
        })
    return sections


# ─── Tables Extraction (booktabs / tabular / tabularx / longtable) ────────

def _extract_caption_and_label(
    env_body: str,
    *,
    exclude_subenvs: frozenset[str] = frozenset(),
    masked_body: str | None = None,
) -> tuple[str, str | None]:
    raw_text = env_body
    scan_text = masked_body if masked_body is not None else mask_verbatim_for_parsing(env_body)
    if exclude_subenvs:
        sub_envs = _find_environments(scan_text, exclude_subenvs)
        if sub_envs:
            raw_pieces: list[str] = []
            scan_pieces: list[str] = []
            cursor = 0
            for se in sub_envs:
                raw_pieces.append(raw_text[cursor : se["start"]])
                scan_pieces.append(scan_text[cursor : se["start"]])
                cursor = se["end"]
            raw_pieces.append(raw_text[cursor:])
            scan_pieces.append(scan_text[cursor:])
            outer_cap, outer_lbl = _extract_caption_and_label(
                "".join(raw_pieces),
                masked_body="".join(scan_pieces),
            )
            if outer_cap or outer_lbl:
                return outer_cap, outer_lbl

    bmap = build_delimiter_map(scan_text, "{", "}")
    kmap = build_delimiter_map(scan_text, "[", "]")
    caption = ""
    label: str | None = None
    for item in _iter_named_commands(scan_text, frozenset({"caption", "label"}), allow_star=True):
        pos = _skip_ws(scan_text, item["after"])
        if item["name"] == "caption" and not caption:
            if pos < len(scan_text) and scan_text[pos] == "[":
                opt = _read_balanced(scan_text, pos, "[", "]", kmap)
                if opt is not None:
                    pos = _skip_ws(scan_text, opt[1])
            grp = _read_balanced(scan_text, pos, "{", "}", bmap)
            if grp is not None:
                raw_cap = raw_text[pos + 1 : grp[1] - 1]
                inner_lbl = _extract_first_command_arg(grp[0], frozenset({"label"}), allow_opt=False)
                if inner_lbl and label is None:
                    label = inner_lbl.strip()
                caption = clean_tex_text(raw_cap, preserve_newlines=False)
        elif item["name"] == "label" and label is None:
            grp = _read_balanced(scan_text, pos, "{", "}", bmap)
            if grp is not None:
                label = raw_text[pos + 1 : grp[1] - 1].strip()
    return caption, label


def _skip_tabular_header_args(env_name: str, body: str) -> str:
    bmap = build_delimiter_map(body, "{", "}")
    kmap = build_delimiter_map(body, "[", "]")
    pos = _skip_ws(body, 0)
    if env_name in ("tabularx", "tabular*", "tabulary"):
        width_grp = _read_balanced(body, pos, "{", "}", bmap)
        if width_grp is not None:
            pos = _skip_ws(body, width_grp[1])
    if pos < len(body) and body[pos] == "[":
        opt = _read_balanced(body, pos, "[", "]", kmap)
        if opt is not None:
            pos = _skip_ws(body, opt[1])
    col_grp = _read_balanced(body, pos, "{", "}", bmap)
    if col_grp is not None:
        pos = col_grp[1]
    return body[pos:]


def _strip_longtable_directives(body: str) -> str:
    """Strip \\caption, \\label, and repeated \\endhead/\\endfoot/\\endlastfoot blocks from longtable."""
    bmap = build_delimiter_map(body, "{", "}")
    kmap = build_delimiter_map(body, "[", "]")
    n = len(body)
    # First remove \caption[...]{...} and \label{...}
    out: list[str] = []
    i = 0
    while i < n:
        if body[i] == "\\":
            name, after = _read_command_name(body, i)
            if name in ("caption", "label"):
                pos = after
                if name == "caption" and pos < n and body[pos] == "*":
                    pos += 1
                pos = _skip_ws(body, pos)
                if name == "caption" and pos < n and body[pos] == "[":
                    opt = _read_balanced(body, pos, "[", "]", kmap)
                    if opt is not None:
                        pos = _skip_ws(body, opt[1])
                grp = _read_balanced(body, pos, "{", "}", bmap)
                if grp is not None:
                    # Also skip optional trailing \\ right after \caption{...}
                    p2 = _skip_ws(body, grp[1])
                    if p2 + 1 < n and body[p2 : p2 + 2] == "\\\\":
                        i = p2 + 2
                    else:
                        i = grp[1]
                    continue
            out.append(body[i:after])
            i = after
        else:
            out.append(body[i])
            i += 1
    cleaned = "".join(out)

    # Separate first-page header (before \endfirsthead) and actual data body (after last \end*head/\end*foot)
    markers = _iter_named_commands(
        cleaned,
        frozenset({"endfirsthead", "endhead", "endfoot", "endlastfoot"}),
    )
    if not markers:
        return cleaned
    first_head = next((m for m in markers if m["name"] == "endfirsthead"), None)
    last_marker = markers[-1]
    if first_head is not None:
        head_part = cleaned[: first_head["start"]]
        data_part = cleaned[last_marker["after"] :]
        sep = "\\midrule\n" if "\\midrule" not in data_part[:80] else ""
        return head_part + "\\\\\n" + sep + data_part
    # Only \endhead / \endfoot / \endlastfoot present
    first_endhead = next((m for m in markers if m["name"] == "endhead"), None)
    if first_endhead is not None:
        head_part = cleaned[: first_endhead["start"]]
        data_part = cleaned[last_marker["after"] :]
        sep = "\\midrule\n" if "\\midrule" not in data_part[:80] else ""
        return head_part + "\\\\\n" + sep + data_part
    return cleaned[last_marker["after"] :]


def _split_tabular_rows(tabular_content: str) -> list[str]:
    kmap = build_delimiter_map(tabular_content, "[", "]")
    rows: list[str] = []
    n = len(tabular_content)
    depth = 0
    start = 0
    i = 0
    while i < n:
        ch = tabular_content[i]
        if ch == "\\":
            if i + 1 < n and tabular_content[i + 1] == "\\":
                if depth == 0:
                    rows.append(tabular_content[start:i])
                    pos = i + 2
                    if pos < n and tabular_content[pos] == "*":
                        pos += 1
                    p2 = _skip_ws(tabular_content, pos)
                    if p2 < n and tabular_content[p2] == "[":
                        opt = _read_balanced(tabular_content, p2, "[", "]", kmap)
                        if opt is not None:
                            pos = opt[1]
                    start = pos
                    i = pos
                    continue
                i += 2
                continue
            name, after = _read_command_name(tabular_content, i)
            if name == "tabularnewline" and depth == 0:
                rows.append(tabular_content[start:i])
                pos = after
                if pos < n and tabular_content[pos] == "*":
                    pos += 1
                p2 = _skip_ws(tabular_content, pos)
                if p2 < n and tabular_content[p2] == "[":
                    opt = _read_balanced(tabular_content, p2, "[", "]", kmap)
                    if opt is not None:
                        pos = opt[1]
                start = pos
                i = pos
                continue
            i = after
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        i += 1
    rows.append(tabular_content[start:])
    return rows


def _split_tabular_cells(row_str: str) -> list[str]:
    cells: list[str] = []
    n = len(row_str)
    depth = 0
    bs_count = 0
    start = 0
    i = 0
    while i < n:
        ch = row_str[i]
        if ch == "\\":
            bs_count += 1
            i += 1
            continue
        escaped = (bs_count % 2 == 1)
        bs_count = 0
        if not escaped:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth = max(0, depth - 1)
            elif ch == "&" and depth == 0:
                cells.append(row_str[start:i])
                start = i + 1
        i += 1
    cells.append(row_str[start:])
    return cells


def _parse_cell_with_multicolumn(raw_cell: str) -> tuple[str, int]:
    s = raw_cell.strip()
    if "\\multicolumn" in s:
        bmap = build_delimiter_map(s, "{", "}")
        cmds = _iter_named_commands(s, frozenset({"multicolumn"}))
        if cmds:
            pos = _skip_ws(s, cmds[0]["after"])
            g_span = _read_balanced(s, pos, "{", "}", bmap)
            if g_span is not None:
                g_align = _read_balanced(s, _skip_ws(s, g_span[1]), "{", "}", bmap)
                if g_align is not None:
                    g_text = _read_balanced(s, _skip_ws(s, g_align[1]), "{", "}", bmap)
                    if g_text is not None:
                        try:
                            span = int(g_span[0].strip())
                        except ValueError:
                            span = 1
                        span = max(1, min(span, _MAX_MULTICOLUMN_SPAN))
                        return clean_tex_text(g_text[0], preserve_newlines=False), span
    return clean_tex_text(s, preserve_newlines=False), 1


def _parse_tabular_grid(env_name: str, env_body: str) -> tuple[list[str], list[list[str]]]:
    content = _skip_tabular_header_args(env_name, env_body)
    if env_name == "longtable":
        content = _strip_longtable_directives(content)
    raw_rows = _split_tabular_rows(content)

    parsed_rows: list[tuple[list[tuple[str, int]], bool, bool]] = []
    for raw_row in raw_rows:
        has_midrule = "\\midrule" in raw_row
        has_hline = "\\hline" in raw_row
        raw_cells = _split_tabular_cells(raw_row)
        cell_specs = [_parse_cell_with_multicolumn(c) for c in raw_cells]
        if any(txt for txt, _ in cell_specs):
            parsed_rows.append((cell_specs, has_midrule, has_hline))

    if not parsed_rows:
        return [], []

    split_idx: int | None = None
    for idx in range(1, len(parsed_rows)):
        if parsed_rows[idx][1]:
            split_idx = idx
            break
    if split_idx is None:
        for idx in range(1, len(parsed_rows)):
            if parsed_rows[idx][2]:
                split_idx = idx
                break
    if split_idx is None:
        split_idx = 1

    header_specs = [row_cells for row_cells, _, _ in parsed_rows[:split_idx]]
    data_specs = [row_cells for row_cells, _, _ in parsed_rows[split_idx:]]

    expanded_header_rows: list[list[str]] = []
    for row_cells in header_specs:
        expanded_row: list[str] = []
        for txt, span in row_cells:
            if len(header_specs) > 1:
                expanded_row.extend([txt] * span)
            else:
                expanded_row.append(txt)
                if span > 1:
                    expanded_row.extend([""] * (span - 1))
        expanded_header_rows.append(expanded_row)

    max_cols = max((len(r) for r in expanded_header_rows), default=0)
    if len(expanded_header_rows) == 1:
        headers = expanded_header_rows[0]
    else:
        headers = []
        for col in range(max_cols):
            col_parts: list[str] = []
            for hr in expanded_header_rows:
                val = hr[col] if col < len(hr) else ""
                if val and (not col_parts or col_parts[-1] != val):
                    col_parts.append(val)
            headers.append(" / ".join(col_parts))

    data_rows: list[list[str]] = []
    for row_cells in data_specs:
        row_out: list[str] = []
        for txt, span in row_cells:
            row_out.append(txt)
            if span > 1:
                row_out.extend([""] * (span - 1))
        data_rows.append(row_out)

    return headers, data_rows


def extract_tables(body: str) -> list[dict[str, Any]]:
    masked = mask_verbatim_for_parsing(body)
    table_envs = _find_environments(
        masked,
        frozenset({"table", "table*", "sidewaystable", "sidewaystable*", "wraptable", "longtable"}),
    )
    tables: list[dict[str, Any]] = []
    tabular_names = frozenset({"tabular", "tabularx", "tabular*", "tabulary"})

    for tenv in table_envs:
        t_body = body[tenv["body_start"] : tenv["body_end"]]
        t_masked = masked[tenv["body_start"] : tenv["body_end"]]
        caption, label = _extract_caption_and_label(
            t_body,
            exclude_subenvs=frozenset({"subtable", "subfigure"}),
            masked_body=t_masked,
        )
        if tenv["env"] == "longtable":
            headers, rows = _parse_tabular_grid("longtable", t_body)
            tables.append({"caption": caption, "label": label, "headers": headers, "rows": rows})
            continue
        inner_tabulars = _find_environments(t_masked, tabular_names)
        if not inner_tabulars:
            tables.append({"caption": caption, "label": label, "headers": [], "rows": []})
            continue
        for tab in inner_tabulars:
            raw_tab_body = t_body[tab["body_start"] : tab["body_end"]]
            headers, rows = _parse_tabular_grid(tab["env"], raw_tab_body)
            tables.append({"caption": caption, "label": label, "headers": headers, "rows": rows})
    return tables


# ─── Figures Extraction ───────────────────────────────────────────────────

def extract_figures(body: str) -> list[dict[str, Any]]:
    masked = mask_verbatim_for_parsing(body)
    fig_envs = _find_environments(
        masked,
        frozenset({"figure", "figure*", "wrapfigure", "sidewaysfigure", "SCfigure"}),
    )
    figures: list[dict[str, Any]] = []
    for fenv in fig_envs:
        f_body = body[fenv["body_start"] : fenv["body_end"]]
        f_masked = masked[fenv["body_start"] : fenv["body_end"]]
        bmap = build_delimiter_map(f_masked, "{", "}")
        kmap = build_delimiter_map(f_masked, "[", "]")
        caption, label = _extract_caption_and_label(
            f_body,
            exclude_subenvs=frozenset({"subfigure", "subtable"}),
            masked_body=f_masked,
        )
        graphics_paths: list[str] = []
        for item in _iter_named_commands(f_masked, frozenset({"includegraphics"}), allow_star=True):
            pos = _skip_ws(f_masked, item["after"])
            if pos < len(f_masked) and f_masked[pos] == "[":
                opt = _read_balanced(f_masked, pos, "[", "]", kmap)
                if opt is not None:
                    pos = _skip_ws(f_masked, opt[1])
            grp = _read_balanced(f_masked, pos, "{", "}", bmap)
            if grp is not None:
                gpath = f_body[pos + 1 : grp[1] - 1].strip().strip('"').strip("'")
                if gpath:
                    graphics_paths.append(gpath)
        figures.append({"caption": caption, "label": label, "graphicsPaths": graphics_paths})
    return figures


# ─── Equations Extraction ─────────────────────────────────────────────────

def _extract_all_labels(text: str) -> list[str]:
    bmap = build_delimiter_map(text, "{", "}")
    labels: list[str] = []
    for item in _iter_named_commands(text, frozenset({"label"})):
        pos = _skip_ws(text, item["after"])
        grp = _read_balanced(text, pos, "{", "}", bmap)
        if grp is not None:
            val = grp[0].strip()
            if val:
                labels.append(val)
    return labels


def extract_equations(body: str) -> list[dict[str, Any]]:
    numbered_envs = frozenset({"equation", "align", "gather", "multline", "flalign", "eqnarray"})
    starred_envs = frozenset({"equation*", "align*", "gather*", "multline*", "flalign*", "eqnarray*"})
    all_eq_envs = numbered_envs | starred_envs

    masked = mask_verbatim_for_parsing(body)
    found_items: list[tuple[int, dict[str, Any]]] = []
    eq_envs = _find_environments(masked, all_eq_envs)
    for eenv in eq_envs:
        raw_latex = body[eenv["body_start"] : eenv["body_end"]].strip()
        labels = _extract_all_labels(raw_latex)
        is_numbered = (eenv["env"] in numbered_envs) or ("\\tag{" in raw_latex) or bool(labels)
        found_items.append((
            eenv["start"],
            {
                "environment": eenv["env"],
                "label": labels[0] if labels else None,
                "labels": labels,
                "latex": raw_latex,
                "numbered": is_numbered,
            },
        ))

    # \[ ... \] display math scan: skip \\[5pt] cleanly and break immediately on EOF (O(n))
    captured_ranges = [(e["start"], e["end"]) for e in eq_envs]
    range_idx = 0
    num_ranges = len(captured_ranges)

    n = len(masked)
    i = 0
    while i < n - 1:
        while range_idx < num_ranges and captured_ranges[range_idx][1] <= i:
            range_idx += 1
        if range_idx < num_ranges and captured_ranges[range_idx][0] <= i < captured_ranges[range_idx][1]:
            i = captured_ranges[range_idx][1]
            continue
        if masked[i] == "\\":
            if masked[i + 1] == "[":
                j = i + 2
                end_pos = -1
                while j < n - 1:
                    if masked[j] == "\\":
                        if masked[j + 1] == "]":
                            end_pos = j
                            break
                        j += 2
                        continue
                    j += 1
                if end_pos == -1:
                    break  # No remaining \] before EOF: exit in O(n)!
                raw_latex = body[i + 2 : end_pos].strip()
                labels = _extract_all_labels(raw_latex)
                found_items.append((
                    i,
                    {
                        "environment": "displaymath",
                        "label": labels[0] if labels else None,
                        "labels": labels,
                        "latex": raw_latex,
                        "numbered": bool(labels) or ("\\tag{" in raw_latex),
                    },
                ))
                i = end_pos + 2
                continue
            # Consume escaped pair (including \\ so \\[5pt] is NEVER misread as \[)
            i += 2
            continue
        i += 1

    found_items.sort(key=lambda item: item[0])
    return [entry for _, entry in found_items]


# ─── Bibliography Extraction ──────────────────────────────────────────────

def extract_bibliography(
    expanded_tex: str,
    files: dict[str, bytes],
    included_files: list[str],
    root_tex_file: str,
) -> dict[str, Any]:
    masked = mask_verbatim_for_parsing(expanded_tex)
    bmap = build_delimiter_map(masked, "{", "}")
    kmap = build_delimiter_map(masked, "[", "]")
    bibitem_count = len(_iter_named_commands(masked, frozenset({"bibitem"})))

    bib_files: list[str] = []
    seen_bibs: set[str] = set()
    for item in _iter_named_commands(masked, frozenset({"bibliography", "addbibresource"})):
        pos = _skip_ws(masked, item["after"])
        if pos < len(masked) and masked[pos] == "[":
            opt = _read_balanced(masked, pos, "[", "]", kmap)
            if opt is not None:
                pos = _skip_ws(masked, opt[1])
        grp = _read_balanced(masked, pos, "{", "}", bmap)
        if grp is not None:
            for part in grp[0].split(","):
                name = part.strip()
                if name and name not in seen_bibs:
                    seen_bibs.add(name)
                    bib_files.append(name)

    included_set = set(included_files) | {root_tex_file}
    if bibitem_count == 0:
        for path_key in sorted(files.keys()):
            if path_key.lower().endswith(".bbl") and path_key not in included_set and not _is_macos_junk_path(path_key):
                bbl_text, _ = strip_tex_comments(_decode_tex_bytes(files[path_key], path_key))
                bibitem_count += len(_iter_named_commands(bbl_text, frozenset({"bibitem"})))

    bib_entry_count = 0
    for path_key in sorted(files.keys()):
        if path_key.lower().endswith(".bib") and not _is_macos_junk_path(path_key):
            bib_text = _decode_tex_bytes(files[path_key], path_key)
            bib_entry_count += len(_BIB_ENTRY_RE.findall(bib_text))

    reference_count = bibitem_count if bibitem_count > 0 else bib_entry_count
    return {
        "bibitemCount": bibitem_count,
        "bibliographyFiles": bib_files,
        "bibEntryCount": bib_entry_count,
        "referenceCount": reference_count,
    }


# ═══════════════════════════════════════════════════════════════════════════
# 7. Public Python API & Hardened CLI Entrypoint
# ═══════════════════════════════════════════════════════════════════════════

def extract_tex_ast_from_bytes(
    raw_bytes: bytes,
    arxiv_id: str | None = None,
    *,
    max_archive_bytes: int = DEFAULT_MAX_ARCHIVE_BYTES,
    max_members: int = DEFAULT_MAX_MEMBERS,
    max_uncompressed_bytes: int = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    max_single_tex_bytes: int = DEFAULT_MAX_SINGLE_TEX_BYTES,
    max_input_depth: int = DEFAULT_MAX_INPUT_DEPTH,
    max_input_expansions: int = DEFAULT_MAX_INPUT_EXPANSIONS,
    max_expanded_chars: int = DEFAULT_MAX_EXPANDED_CHARS,
) -> dict[str, Any]:
    """Safely extract structured `arxiv-tex-ast-v1` JSON dict from arXiv /e-print bytes."""
    normalized_id = _normalize_arxiv_id(arxiv_id)
    if not isinstance(raw_bytes, (bytes, bytearray)):
        raise ArxivTexExtractError("raw_bytes must be bytes", code="INVALID_ARCHIVE")
    payload = bytes(raw_bytes)
    archive_sha256 = hashlib.sha256(payload).hexdigest()

    files, archive_format, _members = unpack_arxiv_tex_payload(
        payload,
        max_archive_bytes=max_archive_bytes,
        max_members=max_members,
        max_uncompressed_bytes=max_uncompressed_bytes,
        max_single_tex_bytes=max_single_tex_bytes,
    )

    root_tex_file = detect_root_tex(files)
    expanded_tex, included_files, stripped_comments_count = expand_tex_inputs(
        files,
        root_tex_file,
        max_input_depth=max_input_depth,
        max_input_expansions=max_input_expansions,
        max_expanded_chars=max_expanded_chars,
    )

    raw_preamble, raw_body, body_char_offset = _split_document(expanded_tex)
    # Same-length macro masking BEFORE extracting any AST field (preserves charOffset!)
    preamble = mask_macro_definitions(raw_preamble)
    body = mask_macro_definitions(raw_body)

    title = extract_title(preamble, body)
    abstract = extract_abstract(body)
    authors, affiliations, thanks, author_affiliation_status = extract_authors_and_affiliations(preamble, body)
    sections = extract_sections(body, body_char_offset)
    tables = extract_tables(body)
    figures = extract_figures(body)
    equations = extract_equations(body)
    bibliography = extract_bibliography(preamble + "\n" + body, files, included_files, root_tex_file)

    return {
        "contract": TEX_AST_CONTRACT,
        "arxivId": normalized_id,
        "title": title,
        "abstract": abstract,
        "authors": authors,
        "affiliations": affiliations,
        "authorAffiliationStatus": author_affiliation_status,
        "thanks": thanks,
        "sections": sections,
        "tables": tables,
        "figures": figures,
        "equations": equations,
        "bibliography": bibliography,
        "provenance": {
            "contract": TEX_AST_CONTRACT,
            "archiveSha256": archive_sha256,
            "archiveFormat": archive_format,
            "archiveBytes": len(payload),
            "rootTexFile": root_tex_file,
            "includedFiles": included_files,
            "totalExpandedChars": len(expanded_tex),
            "extractorSha256": get_extractor_sha256(),
            "strippedCommentsCount": stripped_comments_count,
        },
    }


def _read_bounded_stdin(max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    stream = sys.stdin.buffer
    while True:
        chunk = stream.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ArxivTexExtractError(f"Stdin payload exceeds {max_bytes} byte limit", code="ARCHIVE_TOO_LARGE")
        chunks.append(chunk)
    return b"".join(chunks)


def _read_bounded_file(file_path: Path, max_bytes: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(file_path, flags)
    except OSError as exc:
        raise ArxivTexExtractError(f"Unable to open input file {file_path}: {exc}", code="IO_ERROR") from exc
    try:
        try:
            st = os.fstat(fd)
        except OSError as exc:
            raise ArxivTexExtractError(f"Unable to stat input file {file_path}: {exc}", code="IO_ERROR") from exc
        if not stat.S_ISREG(st.st_mode):
            raise ArxivTexExtractError(f"Input path is not a regular file: {file_path}", code="IO_ERROR")
        if st.st_size > max_bytes:
            raise ArxivTexExtractError(
                f"Input file size {st.st_size} bytes exceeds {max_bytes} byte limit",
                code="ARCHIVE_TOO_LARGE",
            )
        chunks: list[bytes] = []
        total = 0
        while True:
            try:
                chunk = os.read(fd, _CHUNK_SIZE)
            except OSError as exc:
                raise ArxivTexExtractError(f"Failed reading input file {file_path}: {exc}", code="IO_ERROR") from exc
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ArxivTexExtractError(
                    f"Input file exceeds {max_bytes} byte limit",
                    code="ARCHIVE_TOO_LARGE",
                )
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _write_output_atomic(out_path: Path, rendered: str) -> None:
    """Atomically write output JSON using O_EXCL|O_NOFOLLOW temp file, 0600, fsync, and os.replace."""
    parent = out_path.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
        parent_st = parent.lstat()
        if stat.S_ISLNK(parent_st.st_mode) or not stat.S_ISDIR(parent_st.st_mode):
            raise ArxivTexExtractError(f"Output parent directory is unsafe: {parent}", code="IO_ERROR")
        try:
            existing_st = out_path.lstat()
            if stat.S_ISLNK(existing_st.st_mode) or not stat.S_ISREG(existing_st.st_mode) or existing_st.st_nlink != 1:
                raise ArxivTexExtractError(
                    f"Refusing to overwrite symlink/non-regular/multi-linked output target: {out_path}",
                    code="IO_ERROR",
                )
        except FileNotFoundError:
            pass
    except ArxivTexExtractError:
        raise
    except OSError as exc:
        raise ArxivTexExtractError(f"Unable to validate output path {out_path}: {exc}", code="IO_ERROR") from exc

    tmp_path = parent / f".{out_path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    payload = rendered.encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        fd = os.open(tmp_path, flags, 0o600)
        view = memoryview(payload)
        written = 0
        while written < len(payload):
            written += os.write(fd, view[written:])
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(tmp_path, out_path)
    except OSError as exc:
        if fd != -1:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ArxivTexExtractError(f"Atomic write failed for {out_path}: {exc}", code="IO_ERROR") from exc


def main(argv: list[str] | None = None) -> int:
    from runtime_guard import require_external_runtime

    require_external_runtime("arxiv_tex_extract.py")

    parser = argparse.ArgumentParser(
        description="Safely extract structured arxiv-tex-ast-v1 JSON from arXiv /e-print TeX payloads."
    )
    parser.add_argument("--input", default="-", help="Input archive/.tex file path, or '-' for stdin")
    parser.add_argument("--output", default="-", help="Output JSON file path, or '-' for stdout")
    parser.add_argument("--arxiv-id", default=None, help="Optional arXiv ID (e.g. 2611.12345)")
    parser.add_argument(
        "--max-archive-bytes",
        type=int,
        default=DEFAULT_MAX_ARCHIVE_BYTES,
        help="Maximum input archive size in bytes (default: 32 MiB)",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args(argv)

    max_bytes = args.max_archive_bytes
    if max_bytes < 1 or max_bytes > DEFAULT_MAX_ARCHIVE_BYTES:
        print(
            json.dumps({"error": "INVALID_LIMIT", "message": f"--max-archive-bytes must be 1..{DEFAULT_MAX_ARCHIVE_BYTES}"}),
            file=sys.stderr,
        )
        return 2

    try:
        if args.input == "-":
            raw = _read_bounded_stdin(max_bytes)
        else:
            raw = _read_bounded_file(Path(args.input), max_bytes)
        ast = extract_tex_ast_from_bytes(
            raw,
            arxiv_id=args.arxiv_id,
            max_archive_bytes=max_bytes,
        )
    except ArxivTexExtractError as exc:
        print(json.dumps({"error": exc.code, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1

    if args.pretty:
        rendered = json.dumps(ast, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    else:
        rendered = json.dumps(ast, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    try:
        if args.output == "-":
            sys.stdout.write(rendered)
            if not rendered.endswith("\n"):
                sys.stdout.write("\n")
        else:
            _write_output_atomic(Path(args.output), rendered)
    except ArxivTexExtractError as exc:
        print(json.dumps({"error": exc.code, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
