"""Identify source-correction record formats before the actual local replay."""

try:
    import protocol_codec as protocols
except ModuleNotFoundError:
    from . import protocol_codec as protocols


def locator_family(value):
    for name in ('conference-source-resource-correction', 'conference-source-core-correction'):
        if protocols.has_valid_header(value, name):
            return name
    return None


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
