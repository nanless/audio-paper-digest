"""Strict read-only scoring proof predicate, mirrored by lib/scoring-stability.js."""

import math
import re

SCORING_STABILITY_RESOLUTION_CONTRACT = 'api-scoring-stability-resolution-v1'
SCORING_STABILITY_CONSENSUS_TOLERANCE = 0.3


def _finite_number(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


# Mirror the JS comparison without rounding or rewriting any saved proof.
def scoring_difference_within_tolerance(difference, first_score, second_score):
    if not _finite_number(difference) or difference < 0:
        return False
    if difference <= SCORING_STABILITY_CONSENSUS_TOLERANCE:
        return True
    return (all(_finite_number(score) and 0 <= score <= 10
                for score in (first_score, second_score))
            and difference == abs(second_score - first_score)
            and difference - SCORING_STABILITY_CONSENSUS_TOLERANCE
            <= math.ulp(1.0) * max(1, abs(first_score), abs(second_score)))


def scoring_stability_is_resolved(stage):
    if not isinstance(stage, dict) or stage.get('stabilityWarning') is not True:
        return True
    resolution = stage.get('stabilityResolution')
    if not isinstance(resolution, dict):
        return False
    multi_pass = resolution.get('method') == 'multi_pass_consensus'
    if (resolution.get('contract') != SCORING_STABILITY_RESOLUTION_CONTRACT
            or resolution.get('status') != 'resolved'
            or not (resolution.get('method') == 'second_pass_consensus' or multi_pass)
            or not all(_finite_number(resolution.get(field))
                       for field in ('firstAuditScore', 'secondAuditScore', 'scoreDifference'))
            or not scoring_difference_within_tolerance(resolution['scoreDifference'],
                                                       resolution['firstAuditScore'],
                                                       resolution['secondAuditScore'])
            or not _valid_sha(resolution.get('secondAuditSha256'))):
        return False
    if not multi_pass:
        return True
    attempts = resolution.get('thirdAttempts')
    return (_finite_number(resolution.get('thirdAuditScore'))
            and _finite_number(attempts) and 1 <= attempts <= 2 ** 53 - 1
            and int(attempts) == attempts
            and _valid_sha(resolution.get('firstAuditSha256'))
            and _valid_sha(resolution.get('thirdAuditSha256'))
            # A resolved third pass necessarily selects a pair ending in that pass.
            and resolution['secondAuditScore'] == resolution['thirdAuditScore']
            and resolution['secondAuditSha256'] == resolution['thirdAuditSha256']
            and stage.get('auditSha256') == resolution['secondAuditSha256']
            and _finite_number(stage.get('finalScore'))
            and abs(stage['finalScore'] - resolution['secondAuditScore']) < 1e-9
            and abs(abs(resolution['secondAuditScore'] - resolution['firstAuditScore'])
                    - resolution['scoreDifference']) < 1e-9)


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('scoring_stability.py')
    raise SystemExit('这是只读评分证明模块，请通过正常分析或页面发布入口使用。')
