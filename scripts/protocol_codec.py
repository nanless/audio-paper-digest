"""识别当前和历史格式；不修改原对象，也不授予分析或发布资格。"""

import hashlib
import json
import re
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parents[1] / 'config' / 'protocols'
NAME = re.compile(r'[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*\Z')
NUMBERED = re.compile(r'(?:^|[-.])v\d+(?:$|[-.])')
RESERVED = {'contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion', '__proto__'}


def canonical(value):
    def check(item):
        if item is None or type(item) is bool:
            return
        if type(item) is str:
            if any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                raise ValueError('协议声明不能包含不完整的 Unicode 字符')
            return
        if type(item) is int and abs(item) <= 2 ** 53 - 1:
            return
        if type(item) is list:
            for member in item:
                check(member)
            return
        if type(item) is dict:
            for key, member in item.items():
                if type(key) is not str or not key or key == '__proto__' or any(ord(char) < 32 or ord(char) > 126 for char in key):
                    raise ValueError('协议声明的字段名必须是普通 ASCII 字符')
                check(member)
            return
        raise ValueError('协议声明只能包含 JSON 值，数值必须是安全整数')
    check(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class Codec:
    def __init__(self, catalogs):
        if type(catalogs) is not list:
            raise ValueError('协议目录必须是数组')
        self._entries = {}
        for catalog in catalogs:
            if type(catalog) is not dict or set(catalog) != {'protocols'} or type(catalog['protocols']) is not list:
                raise ValueError('协议目录格式不正确')
            for source in catalog['protocols']:
                if type(source) is not dict or set(source) != {'name', 'currentVariant', 'currentSchema', 'historical'}:
                    raise ValueError('协议登记格式不正确')
                name, variant = source['name'], source['currentVariant']
                if any(type(item) is not str or not NAME.fullmatch(item) or NUMBERED.search(item) for item in (name, variant)) \
                        or name in self._entries or type(source['currentSchema']) is not dict or not source['currentSchema'] \
                        or type(source['historical']) is not list:
                    raise ValueError('协议名、当前结构或历史登记不正确或重复')
                fp = self._fingerprint(name, variant, source['currentSchema'])
                current = {'tag': name, 'variant': variant, 'fp': fp,
                           'header': json.dumps({'contract': name, 'schemaFingerprint': fp}, ensure_ascii=False),
                           'schema': json.dumps(source['currentSchema'], ensure_ascii=False)}
                tags, history = {name: {fp: current}}, []
                for item in source['historical']:
                    if type(item) is not dict or set(item) not in ({'tag', 'variant'}, {'tag', 'variant', 'header'}, {'tag', 'variant', 'header', 'schema'}) \
                            or not (type(item['tag']) is str and item['tag'] and len(item['tag']) <= 256 and not re.search(r'\s', item['tag'])
                                    or type(item['tag']) is int and 0 <= item['tag'] <= 2 ** 53 - 1 and 'header' in item) \
                            or type(item['variant']) is not str or not NAME.fullmatch(item['variant']) or NUMBERED.search(item['variant']):
                        raise ValueError('历史协议登记不正确')
                    header = item.get('header', {'contract': item['tag']})
                    canonical(header)
                    if type(header) is not dict or sum(type(value) is type(item['tag']) and value == item['tag'] for value in header.values()) != 1:
                        raise ValueError('历史协议头必须精确包含原标签')
                    old_fp = header.get('schemaFingerprint')
                    if old_fp is not None:
                        if type(old_fp) is not str or not re.fullmatch(r'[a-f0-9]{64}', old_fp) \
                                or type(item.get('schema')) is not dict or not item['schema'] \
                                or self._fingerprint(name, item['variant'], item['schema']) != old_fp:
                            raise ValueError('历史结构指纹必须对应原结构声明')
                    elif 'schemaFingerprint' in header or 'schema' in item:
                        raise ValueError('历史结构声明缺少精确指纹')
                    group = tags.setdefault(item['tag'], {})
                    if old_fp in group:
                        raise ValueError('同一协议标签和结构指纹不能重复登记')
                    descriptor = {'tag': item['tag'], 'variant': item['variant'], 'fp': old_fp,
                                  'header': json.dumps(header, ensure_ascii=False),
                                  'schema': json.dumps(item['schema'], ensure_ascii=False) if 'schema' in item else None}
                    group[old_fp] = descriptor
                    history.append(descriptor)
                self._entries[name] = {'current': current, 'tags': tags, 'history': history}

    @staticmethod
    def _fingerprint(name, variant, schema):
        value = {'name': name, 'currentVariant': variant, 'currentSchema': schema}
        return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()

    def _entry(self, name):
        if type(name) is not str or name not in self._entries:
            raise ValueError(f'未登记的协议族：{name}')
        return self._entries[name]

    def _group(self, raw, name):
        value = self._entry(name)
        if type(raw) not in (str, int):
            return None
        return value['tags'].get(raw)

    def _select(self, raw, name, selectors):
        choices = self._group(raw, name)
        if not choices:
            raise ValueError(f'无法识别 {name} 的格式')
        if not selectors:
            if len(choices) != 1:
                raise ValueError(f'{name} 同一标签有多种结构，读取时必须提供原结构指纹')
            return next(iter(choices.values()))
        fp = selectors[0]
        if type(fp) not in (str, type(None)) or fp not in choices:
            raise ValueError(f'{name} 未登记该标签与结构指纹的组合')
        return choices[fp]

    def contract(self, name):
        self._entry(name)
        return name

    def is_contract(self, raw, name, variant=None, *selectors):
        choices = self._group(raw, name)
        if not choices:
            return False
        if selectors:
            fp = selectors[0]
            value = choices.get(fp) if type(fp) in (str, type(None)) else None
            return value is not None and (variant is None or value['variant'] == variant)
        return variant is None or all(value['variant'] == variant for value in choices.values())

    def format(self, raw, name, *selectors):
        return self._select(raw, name, selectors)['variant']

    def identity_domain(self, raw, name, *selectors):
        self._select(raw, name, selectors)
        return raw

    def declared_schema(self, raw, name, *selectors):
        schema = self._select(raw, name, selectors)['schema']
        if schema is None:
            raise ValueError(f'{name} 的原格式没有登记完整结构声明')
        return json.loads(schema)

    def historical_header(self, name, variant, *selectors):
        found = [value for value in self._entry(name)['history'] if value['variant'] == variant
                 and (not selectors or value['fp'] == selectors[0])]
        if len(found) != 1:
            raise ValueError(f'历史协议 {name}/{variant} 未唯一确定')
        return json.loads(found[0]['header'])

    def historical_contract(self, name, variant):
        found = [value for value in self._entry(name)['history'] if value['variant'] == variant]
        if len(found) != 1:
            raise ValueError(f'历史协议 {name}/{variant} 未唯一确定')
        value = found[0]
        if len(self._entry(name)['tags'][value['tag']]) != 1 or value['fp'] is not None:
            raise ValueError('有结构指纹的历史格式必须读取完整原头，不能仅取标签')
        return value['tag']

    def schema_fingerprint(self, name):
        return self._entry(name)['current']['fp']

    def record_header(self, raw, name, *selectors):
        value = self._entry(name)['current'] if raw == name and not selectors else self._select(raw, name, selectors)
        return json.loads(value['header'])

    def has_valid_header(self, value, name, tag_field='contract'):
        self._entry(name)
        if type(value) is not dict or type(tag_field) is not str:
            return False
        try:
            header = self.record_header(value.get(tag_field), name, value.get('schemaFingerprint'))
        except ValueError:
            return False
        if any(type(value.get(key)) is not type(expected) or value[key] != expected for key, expected in header.items()):
            return False
        return all(key not in value or key in header for key in ('contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion'))

    def is_current_header(self, value, name, tag_field='contract'):
        return self.has_valid_header(value, name, tag_field) and value[tag_field] == name \
            and value['schemaFingerprint'] == self.schema_fingerprint(name)

    def registered_headers(self, name):
        # Metadata only; never supplies an authenticated source or saved run.
        entry = self._entry(name)
        return [json.loads(value['header']) for value in (entry['current'], *entry['history'])]

    def record(self, name, fields=None):
        fields = {} if fields is None else fields
        if type(fields) is not dict or RESERVED.intersection(fields):
            raise ValueError('新协议字段不能覆盖格式声明或带入旧版本字段')
        return {**self.record_header(name, name), **fields}


def catalog_paths(directory=DIRECTORY):
    directory = Path(directory)
    if directory.resolve() != directory:
        raise ValueError('协议目录不能经过符号链接')
    result = []
    for filename in sorted(directory.iterdir()):
        if not re.fullmatch(r'[a-z][a-z0-9-]*\.json', filename.name):
            continue
        info = filename.lstat()
        if filename.is_symlink() or not filename.is_file() or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
            raise ValueError('协议目录要求有界普通文件')
        result.append(filename)
    return result


def server_catalog_paths(directory=DIRECTORY):
    """Publication/scientific dependencies exclude schemas used only inside native apps.

    Public client formats stay in clients.json; shared server tag formats stay in
    tags.json. A server consumer must move any newly shared format out of the
    native-only clients-* namespace before using it.
    """
    return [path for path in catalog_paths(directory) if not path.name.startswith('clients-')]


def read_catalogs(directory=DIRECTORY):
    result = []
    for filename in catalog_paths(directory):
        def unique_fields(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError(f'协议目录中出现重复字段：{key}')
                value[key] = item
            return value
        result.append(json.loads(filename.read_text(encoding='utf-8'), object_pairs_hook=unique_fields))
    return result


_shared = None


def _codec():
    global _shared
    if _shared is None:
        _shared = Codec(read_catalogs())
    return _shared


def contract(name): return _codec().contract(name)
def is_contract(raw, name, variant=None, *selectors): return _codec().is_contract(raw, name, variant, *selectors)
def format(raw, name, *selectors): return _codec().format(raw, name, *selectors)
def identity_domain(raw, name, *selectors): return _codec().identity_domain(raw, name, *selectors)
def declared_schema(raw, name, *selectors): return _codec().declared_schema(raw, name, *selectors)
def historical_contract(name, variant): return _codec().historical_contract(name, variant)
def historical_header(name, variant, *selectors): return _codec().historical_header(name, variant, *selectors)
def schema_fingerprint(name): return _codec().schema_fingerprint(name)
def record_header(raw, name, *selectors): return _codec().record_header(raw, name, *selectors)
def has_valid_header(value, name, tag_field='contract'): return _codec().has_valid_header(value, name, tag_field)
def is_current_header(value, name, tag_field='contract'): return _codec().is_current_header(value, name, tag_field)
def record(name, fields=None): return _codec().record(name, fields)

def registered_headers(name): return _codec().registered_headers(name)
