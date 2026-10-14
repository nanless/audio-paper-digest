"""Reproduce saved model pixels using only this checkout's trusted Git renderers."""
import hashlib
from pathlib import Path
import re
import subprocess
from runtime_guard import require_external_runtime

if __name__ == '__main__':
    require_external_runtime('reader-inline-svg-pixel-replay')
    raise SystemExit('This helper is called through the normal blog publisher.')

CONTRACT = 'reader-trusted-git-inline-svg-pixel-replay-v1'
REPOSITORY = Path(__file__).resolve().parent.parent
RENDERER_PATH = 'scripts/reader_inline_svg.py'


def _git(*arguments):
    return subprocess.run(['git', *arguments], cwd=REPOSITORY, check=True,
                          capture_output=True, timeout=20).stdout


def _trusted_renderers():
    head = _git('rev-parse', 'HEAD^{commit}').decode().strip()
    if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', head):
        raise ValueError('SVG renderer Git commit is invalid')
    revisions = _git('rev-list', '--max-count=32', head, '--', RENDERER_PATH).decode().splitlines()
    seen = set()
    for commit in dict.fromkeys([head, *revisions]):
        blob = _git('rev-parse', f'{commit}:{RENDERER_PATH}').decode().strip()
        if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', blob):
            raise ValueError('SVG renderer Git blob is invalid')
        code = _git('cat-file', 'blob', blob)
        if len(code) > 256 * 1024:
            raise ValueError('SVG renderer Git program exceeds its limit')
        digest = hashlib.sha256(code).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        yield code, {'gitCommitOid': commit, 'rendererBlobOid': blob,
                    'rendererSha256': digest}


def replay_saved_inline_svg_pixels(raw, expected_sha256):
    from reader_inline_svg import validate_svg, render_svg, MAX_OUTPUT_BYTES
    if not re.fullmatch(r'[a-f0-9]{64}', str(expected_sha256 or '')):
        raise ValueError('Saved SVG pixel SHA is invalid')
    # The current security validator still gates every historical producer.
    validate_svg(raw)
    actual = render_svg(raw)
    if hashlib.sha256(actual).hexdigest() == expected_sha256:
        return actual, None
    for code, provenance in _trusted_renderers():
        namespace = {'__name__': 'trusted_inline_svg_pixel_replay',
                     '__file__': str(REPOSITORY / RENDERER_PATH)}
        exec(compile(code, f'git:{provenance["rendererBlobOid"]}:{RENDERER_PATH}', 'exec'), namespace)
        producer = namespace.get('render_svg')
        if not callable(producer):
            continue
        try:
            candidate = producer(raw)
        except Exception:
            # Old renderers can reject newer static markup. They cannot authorize it.
            continue
        if (not isinstance(candidate, bytes) or not candidate.startswith(b'\x89PNG\r\n\x1a\n')
                or len(candidate) > MAX_OUTPUT_BYTES
                or hashlib.sha256(candidate).hexdigest() != expected_sha256):
            continue
        return candidate, {'contract': CONTRACT, **provenance,
                           'sourceSvgSha256': hashlib.sha256(raw).hexdigest(),
                           'savedPixelSha256': expected_sha256}
    raise ValueError('No trusted original SVG renderer reproduced the saved model pixels')
