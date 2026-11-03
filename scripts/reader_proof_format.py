"""Choose an exact proof representation; never authenticate source or values."""
import protocol_codec as codec

GRID = 'reader-sealed-pdf-table-grid'
PROFILE = 'pdf-grid-display-normalization'


def grid_header(value=None):
    if value is None:
        return codec.record_header(codec.contract(GRID), GRID)
    if not codec.has_valid_header(value, GRID):
        raise ValueError('PDF grid proof header is unknown or mixed')
    expected = codec.record_header(value['contract'], GRID, value.get('schemaFingerprint'))
    if value != expected or not (codec.is_current_header(value, GRID)
            or value == codec.historical_header(GRID, 'exact-official-pdf-grid')):
        raise ValueError('PDF grid format has no exact original/current encoder')
    return expected


def grid_profile(header):
    header = grid_header(header)
    return codec.record_header(codec.contract(PROFILE), PROFILE) if codec.is_current_header(header, GRID) \
        else codec.historical_contract(PROFILE, 'fixed-explicit-glyphs')
