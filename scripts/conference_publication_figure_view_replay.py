#!/usr/bin/env python3
"""Pure read-only view transform; output is NEVER source/review/publication authority.

Only the real Node maintenance opaque scope may consume this result after binding
all raw bytes and the freshly replayed outcome, then comparing canonical bytes.
"""
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from conference_publication_figure_view import project_page_bytes, stable, require


def native_parser():
    # Reuse the exact fixed native parser without importing publication services.
    path = Path(__file__).resolve().parent / 'publish-to-blog.py'
    tree = ast.parse(path.read_text())
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'parse_markdown_images']
    require(len(functions) == 1, 'native image parser missing or ambiguous')
    ns = {'re': re, 'PublishDataValidationError': ValueError}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(path), 'exec'), ns)
    return ns['parse_markdown_images'], hashlib.sha256(path.read_bytes()).hexdigest()


def transform(input_value):
    require(isinstance(input_value, dict) and set(input_value) == {
        'contract', 'rawPageBase64', 'rawPageSha256', 'kind', 'paperId', 'nodeDerivation'},
        'pure view input fields differ')
    require(input_value['contract'] == 'conference-publication-figure-view-transform-input-v1', 'pure view input contract differs')
    require(input_value['kind'] in {'paper', 'aggregate'}, 'not a publication page')
    require((input_value['kind'] == 'paper' and isinstance(input_value['paperId'], str)
             and re.fullmatch(r'conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+', input_value['paperId']))
            or (input_value['kind'] == 'aggregate' and input_value['paperId'] is None), 'page ownership missing')
    require(isinstance(input_value['rawPageBase64'], str) and len(input_value['rawPageBase64']) <= 64 * 1024 * 1024, 'raw page input too large')
    raw = base64.b64decode(input_value['rawPageBase64'], validate=True)
    require(hashlib.sha256(raw).hexdigest() == input_value['rawPageSha256'], 'raw bytes SHA differs')
    node = input_value['nodeDerivation']
    require(isinstance(node, dict) and node.get('contract') == 'conference-publication-figure-crops-v1'
            and node.get('purpose') == 'publication-display-only', 'outcome type differs')
    require(node.get('derivationSha256') == stable({k:v for k,v in node.items() if k != 'derivationSha256'}), 'outcome transport bytes differ')
    require(isinstance(node.get('derivations'), list), 'derivations missing')
    parse, parser_sha = native_parser()
    content = raw.decode('utf-8')
    if input_value['kind'] == 'paper':
        actions = [item for item in node['derivations'] if item['paperId'] == input_value['paperId']]
    else:
        present = {item['url'] for item in parse(content)}
        actions = [item for item in node['derivations'] if item['originalUrl'] in present]
    projected = project_page_bytes(raw, input_value['rawPageSha256'], actions, node['derivationSha256'], parse)
    return {'contract':'conference-publication-figure-view-transform-output-v1',
            'purpose':'pure-byte-transform-only', 'doesNotGrantSourceOrReviewOrPublication':True,
            'rawPageSha256':input_value['rawPageSha256'], 'projectedPageSha256':hashlib.sha256(projected).hexdigest(),
            'projectedPageBase64':base64.b64encode(projected).decode('ascii'), 'size':len(projected),
            'implementation':{'viewModuleSha256':hashlib.sha256(Path(__file__).with_name('conference_publication_figure_view.py').read_bytes()).hexdigest(),
                              'cliSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                              'nativeParserModuleSha256':parser_sha}}


def main():
    from runtime_guard import require_external_runtime
    require_external_runtime('conference_publication_figure_view_replay.py')
    require(len(sys.argv)==2 and re.fullmatch(r'[0-9]+',sys.argv[1]) and int(sys.argv[1])>=3, 'private FD required')
    fd=int(sys.argv[1]); st=os.fstat(fd)
    require(stat.S_ISREG(st.st_mode) and st.st_mode & 0o077 == 0 and 2 <= st.st_size <= 80 * 1024 * 1024, 'bounded private regular FD required')
    with os.fdopen(os.dup(fd),'rb') as stream:
        raw=stream.read(80 * 1024 * 1024 + 1)
    require(len(raw)<=80 * 1024 * 1024, 'input too large')
    result=transform(json.loads(raw))
    sys.stdout.write(json.dumps(result,ensure_ascii=False,separators=(',',':')))

if __name__ == '__main__':
    try:main()
    except Exception as error:
        sys.stderr.write(str(error)[:2000]);sys.exit(1)
