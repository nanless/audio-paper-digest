"""只识别用量事件的原格式；不更改原账目或授予请求额度。"""

import protocol_codec as formats

EVENT_CONTRACT = 'llm-usage'


def usage_event_header():
    return formats.record_header(EVENT_CONTRACT, EVENT_CONTRACT)


def is_usage_event_format(event):
    if type(event) is not dict:
        return False
    current = 'contract' in event
    return formats.has_valid_header(event, EVENT_CONTRACT, 'contract' if current else 'version')
