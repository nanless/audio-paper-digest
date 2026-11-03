"""Bounded process-local cache of successful pure PDF visual extraction.

The legacy source and saved-binding verifier still executes on every call. Only
its backend's visual extraction is adapted; source, cell and numeric checks are
never cached. Implementation identities are read from actual files before and
after every extraction or hit.
"""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader_pdf_visual_audit_cache.py')

from collections import OrderedDict
import copy
from dataclasses import replace
import hashlib
import importlib
import json
from pathlib import Path
import threading
import weakref
from daily_source_format import is_fresh_source_provenance, PROVENANCE
from protocol_codec import has_valid_header, historical_header


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


class _VisualAuditCache:
    def __init__(self, max_entries=8, max_bytes=128 * 1024 * 1024):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._entries = OrderedDict()
        self._bytes = 0
        # Also provides single flight: a competing identical request observes
        # the first completed result, while a failed request never installs one.
        self._lock = threading.RLock()

    def extract(self, pdf_bytes, backend, implementation_identity):
        if not isinstance(pdf_bytes, bytes):
            raise TypeError('PDF visual cache requires actual immutable PDF bytes')
        before = implementation_identity()
        key = (_sha(pdf_bytes), backend.name, backend.version, before)
        with self._lock:
            cached = self._entries.get(key)
            if cached is None:
                result = backend.extract_visual_audit(pdf_bytes)
                if not isinstance(result, dict):
                    raise ValueError('PDF visual extraction did not return an audit object')
            else:
                result = cached[0]
            if implementation_identity() != before:
                raise ValueError('PDF extraction implementation bytes changed during replay')
            if cached is None:
                stored = copy.deepcopy(result)
                size = len(json.dumps(stored, ensure_ascii=False, sort_keys=True,
                                      allow_nan=False).encode('utf-8'))
                if size <= self.max_bytes and self.max_entries > 0:
                    while self._entries and (len(self._entries) >= self.max_entries
                                              or self._bytes + size > self.max_bytes):
                        _key, (_value, old_size) = self._entries.popitem(last=False)
                        self._bytes -= old_size
                    self._entries[key] = (stored, size)
                    self._bytes += size
            else:
                self._entries.move_to_end(key)
            return copy.deepcopy(result)


_CACHE = _VisualAuditCache()
_INSTALL_LOCK = threading.RLock()
_ADAPTERS = weakref.WeakKeyDictionary()
_CELL_FAMILY = 'sealed-pdf-cell-confirmation'


def _extractor_view(paper):
    """Give the frozen extractor its original headers without changing proof bodies."""
    plan = paper['apiReaderPlan']
    manifest = paper['analysisManifest']
    provenance = paper.get('freshRewriteProvenance')
    if not is_fresh_source_provenance(provenance) or type(provenance.get('sourceGeneration')) is not int \
            or provenance != manifest.get('freshRewriteProvenance'):
        raise ValueError('论文与阶段封存来源证明不同')
    old_source = historical_header(PROVENANCE, 'original-source-identity')
    old_source.update({key: value for key, value in provenance.items()
                       if key not in {'contract', 'schemaFingerprint'}})
    bindings = []
    for binding in plan['tableBindings']:
        if 'pdfCellConfirmation' not in binding:
            bindings.append(binding)
            continue
        proof = binding['pdfCellConfirmation']
        if not has_valid_header(proof, _CELL_FAMILY):
            raise ValueError('PDF逐格来源记录格式已改变')
        for cell in binding.get('cellBindings', []):
            if any(type(cell.get(key)) is not int for key in ('renderedRow', 'renderedColumn')):
                raise ValueError('PDF逐格来源证明的坐标类型非法')
        body = {key: value for key, value in proof.items() if key not in {'contract', 'schemaFingerprint'}}
        # The original proof contains no boolean fields. Python's loose equality
        # would otherwise treat true as a valid page or cell coordinate of 1.
        pending = list(body.values())
        while pending:
            value = pending.pop()
            if type(value) is bool:
                raise ValueError('PDF逐格来源证明的正文类型非法')
            if isinstance(value, dict):
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)
        original = historical_header(_CELL_FAMILY, 'source-bound-complete-cell-proof')
        bindings.append({**binding, 'pdfCellConfirmation': {**original, **body}})
    return {**paper, 'freshRewriteProvenance': old_source,
            'analysisManifest': {**manifest, 'freshRewriteProvenance': old_source},
            'apiReaderPlan': {**plan, 'tableBindings': bindings}}


def _implementation_identity(legacy):
    # backend_files hashes every actual implementation file (including the
    # Python binary); do not replace these reads with mtime-based reuse.
    records = list(legacy.backend_files())
    for path in (Path(__file__).resolve(), Path(legacy.__file__).resolve(),
                 Path(legacy.__file__).resolve().parent / 'conference_extractor.py'):
        records.append({'path': str(path), 'sha256': _sha(path.read_bytes())})
    return json.dumps(records, sort_keys=True, separators=(',', ':'))


def verify_saved_bindings_cached(legacy, paper, runtime_root):
    """Run the real legacy verifier with one thread-safe extraction adapter."""
    if legacy is not importlib.import_module('reader_pdf_cell_evidence'):
        raise ValueError('PDF visual adapter requires the actual legacy verifier module')
    with _INSTALL_LOCK:
        installed = _ADAPTERS.get(legacy)
        if installed is None:
            original_loader = legacy.load_pypdf_backend
            if original_loader is not importlib.import_module('conference_extractor').load_pypdf_backend:
                raise ValueError('PDF visual adapter requires the actual extractor factory')

            def cached_loader():
                backend = original_loader()
                if backend.extract_visual_audit is None:
                    return backend
                return replace(backend, extract_visual_audit=lambda pdf_bytes:
                    _CACHE.extract(pdf_bytes, backend, lambda: _implementation_identity(legacy)))

            _ADAPTERS[legacy] = cached_loader
            legacy.load_pypdf_backend = cached_loader
        elif legacy.load_pypdf_backend is not installed:
            raise ValueError('PDF visual adapter dependency changed after installation')
    # Neither derive nor verify_saved_bindings is replaced or cached.
    return legacy.verify_saved_bindings(_extractor_view(paper), runtime_root)
