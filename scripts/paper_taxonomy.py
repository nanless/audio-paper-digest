"""Read-only shared paper taxonomy registry; no legacy tag-parser mutation."""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

FACET_IDS = ('task', 'method', 'setting', 'signal', 'application',
             'research_focus', 'artifact', 'scientific_topic', 'model_family')
CONCEPT_KEYS = {'id', 'facet', 'preferredLabel', 'aliases', 'broaderId',
                'definition', 'scopeNote', 'status', 'replacedBy'}
# ECMAScript String.trim whitespace, including BOM (Python str.strip differs).
_JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def normalize_label(value):
    if not isinstance(value, str):
        return ''
    result = unicodedata.normalize('NFKC', value).strip(_JS_WHITESPACE)
    if result.startswith('#'):
        result = result[1:].strip(_JS_WHITESPACE)
    return re.sub('[A-Z]', lambda match: match.group().lower(), result)


def _object(value, keys, name):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError(f'{name}: unexpected or missing fields')


def _string(value, name):
    if (not isinstance(value, str) or not value.strip(_JS_WHITESPACE)
            or value != value.strip(_JS_WHITESPACE) or re.search(r'[\x00-\x1f\x7f]', value)):
        raise ValueError(f'{name}: expected nonempty trimmed string without controls')


def validate_taxonomy(data):
    _object(data, {'version', 'facets', 'concepts'}, 'taxonomy')
    if data['version'] != 'paper-taxonomy-v1':
        raise ValueError('Unsupported taxonomy version')
    if not isinstance(data['facets'], list) or len(data['facets']) != len(FACET_IDS):
        raise ValueError('taxonomy: all nine facets required')
    facets = set()
    for facet in data['facets']:
        _object(facet, {'id', 'label'}, 'facet')
        if facet['id'] not in FACET_IDS or facet['id'] in facets:
            raise ValueError('Invalid/duplicate facet')
        _string(facet['label'], 'facet.label')
        facets.add(facet['id'])
    if not isinstance(data['concepts'], list) or not data['concepts']:
        raise ValueError('taxonomy: nonempty concepts required')
    ids, labels = {}, {}
    for concept in data['concepts']:
        _object(concept, CONCEPT_KEYS, 'concept')
        facet, cid = concept['facet'], concept['id']
        if (not isinstance(facet, str) or facet not in facets or not isinstance(cid, str)
                or not re.fullmatch(re.escape(facet) + r'\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*', cid)
                or cid in ids):
            raise ValueError('Invalid/duplicate concept ID')
        _object(concept['preferredLabel'], {'zh', 'en'}, f'{cid}.preferredLabel')
        for language in ('zh', 'en'):
            _string(concept['preferredLabel'][language], f'{cid}.{language}')
        _string(concept['definition'], f'{cid}.definition')
        _string(concept['scopeNote'], f'{cid}.scopeNote')
        if not isinstance(concept['aliases'], list):
            raise ValueError(f'{cid}: aliases must be array')
        aliases = set()
        for alias in concept['aliases']:
            _string(alias, f'{cid}.alias')
            normalized = normalize_label(alias)
            if not normalized or normalized in aliases:
                raise ValueError(f'{cid}: empty/duplicate alias')
            aliases.add(normalized)
        if concept['status'] not in ('active', 'deprecated'):
            raise ValueError(f'{cid}: invalid status')
        if concept['broaderId'] is not None and not isinstance(concept['broaderId'], str):
            raise ValueError(f'{cid}: invalid broaderId')
        if concept['status'] == 'active' and concept['replacedBy'] is not None:
            raise ValueError(f'{cid}: active concept cannot have replacement')
        if concept['status'] == 'deprecated' and (not isinstance(concept['replacedBy'], str) or not concept['replacedBy']):
            raise ValueError(f'{cid}: deprecated concept requires replacement')
        ids[cid] = concept
        for label in [*concept['preferredLabel'].values(), *concept['aliases']]:
            normalized = normalize_label(label)
            if not normalized:
                raise ValueError(f'{cid}: empty normalized label')
            key = (facet, normalized)
            if key in labels and labels[key] != cid:
                raise ValueError(f'Ambiguous label in facet {facet}: {label}')
            labels[key] = cid
    for concept in data['concepts']:
        cid, parent_id = concept['id'], concept['broaderId']
        if parent_id is not None:
            parent = ids.get(parent_id)
            if not parent or parent['facet'] != concept['facet'] or parent['status'] != 'active':
                raise ValueError(f'{cid}: parent must be existing active same-facet concept')
        if concept['status'] == 'deprecated':
            replacement = ids.get(concept['replacedBy'])
            if (not replacement or replacement['id'] == cid or replacement['status'] != 'active'
                    or replacement['facet'] != concept['facet']):
                raise ValueError(f'{cid}: replacement must be another active same-facet concept')
        seen = {cid}
        while parent_id is not None:
            if parent_id in seen:
                raise ValueError(f'{cid}: taxonomy cycle')
            seen.add(parent_id)
            parent = ids.get(parent_id)
            if not parent:
                raise ValueError(f'{cid}: missing ancestor')
            parent_id = parent['broaderId']
    return data


def _registry_data(taxonomy):
    if not isinstance(taxonomy, dict):
        raise ValueError('taxonomy: expected registry')
    expected = {'version', 'facets', 'concepts'}
    if 'registrySha256' in taxonomy:
        expected.add('registrySha256')
        if not isinstance(taxonomy['registrySha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', taxonomy['registrySha256']):
            raise ValueError('taxonomy: invalid registry SHA metadata')
    _object(taxonomy, expected, 'taxonomy')
    return validate_taxonomy({key: taxonomy.get(key) for key in ('version', 'facets', 'concepts')})


def load_taxonomy(file_path=None):
    if file_path is None:
        import taxonomy_paths
        file_path = taxonomy_paths.TAXONOMY_REGISTRY_FILE
    raw = Path(file_path).read_bytes()
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('taxonomyRegistry exceeds 2 MiB')
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('taxonomy: duplicate JSON key')
            value[key] = item
        return value
    # Match Node's fatal TextDecoder: UTF-8 BOM is discarded for parsing, while
    # the digest continues to bind the complete original byte sequence.
    data = validate_taxonomy(json.loads(raw.decode('utf-8-sig'), object_pairs_hook=unique_object))
    return {**data, 'registrySha256': hashlib.sha256(raw).hexdigest()}


def resolve_label(taxonomy, label, facet=None):
    data = _registry_data(taxonomy)
    if facet is not None and facet not in FACET_IDS:
        raise ValueError(f'Unknown facet: {facet}')
    normalized = normalize_label(label)
    if not normalized:
        return None
    matches = [concept for concept in data['concepts']
               if (facet is None or concept['facet'] == facet)
               and any(normalize_label(value) == normalized
                       for value in [*concept['preferredLabel'].values(), *concept['aliases']])]
    return matches[0] if len(matches) == 1 else None


def ancestors(taxonomy, cid):
    data = _registry_data(taxonomy)
    ids = {concept['id']: concept for concept in data['concepts']}
    if not isinstance(cid, str) or cid not in ids:
        raise ValueError(f'Unknown concept ID: {cid}')
    result, parent_id = [], ids[cid]['broaderId']
    while parent_id is not None:
        result.append(parent_id)
        parent_id = ids[parent_id]['broaderId']
    return result


def prune_ancestors(taxonomy, ids):
    _registry_data(taxonomy)
    if not isinstance(ids, list) or any(not isinstance(cid, str) for cid in ids):
        raise ValueError('ids must be string array')
    covered = {parent for cid in ids for parent in ancestors(taxonomy, cid)}
    return [cid for cid in ids if cid not in covered]


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(Path(__file__).name)
    print('Shared taxonomy library; use build-taxonomy-preview.py for a preview.')
