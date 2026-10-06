'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../scripts/lib/conference-postprocess.js');
// 预期值是上一版修复流程固定下来的输出。复杂的图注
// 不应再产生新的改动；上一版修复本来就不保证保留原始输入。
const cases=[
  {
    "source": "*论文图 2。`[p](‘beat’)`*",
    "nodeExpected": "*论文图 2。`[p](‘beat’)`*",
    "pythonExpected": "*论文图 2。`[p](‘beat’)`*",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。原论文 Figure 2：“Pitch in [ph5P](‘beat’)”。*",
    "nodeExpected": "*论文图 2。原论文 Figure 2：“Pitch in &#91;ph5P&#93;(‘beat’)”。*",
    "pythonExpected": "*论文图 2。原论文 Figure 2：“Pitch in &#91;ph5P&#93;(‘beat’)”。*",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。[音](“字”) [p]('word') [t](\"term\")*",
    "nodeExpected": "*论文图 2。&#91;音&#93;(“字”) &#91;p&#93;('word') &#91;t&#93;(\"term\")*",
    "pythonExpected": "*论文图 2。&#91;音&#93;(“字”) &#91;p&#93;('word') &#91;t&#93;(\"term\")*",
    "complexSkip": false
  },
  {
    "source": "正文 [论文](https://example.org) [ph5P](‘beat’)",
    "nodeExpected": "正文 [论文](https://example.org) [ph5P](‘beat’)",
    "pythonExpected": "正文 [论文](https://example.org) [ph5P](‘beat’)",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。[原文](https://example.org) [5] \\[x\\] ![label](‘file’)*",
    "nodeExpected": "*论文图 2。[原文](https://example.org) [5] \\[x\\] ![label](‘file’)*",
    "pythonExpected": "*论文图 2。[原文](https://example.org) [5] \\[x\\] ![label](‘file’)*",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。\\[p](‘beat’) [p](beat) [p](‘broken)*",
    "nodeExpected": "*论文图 2。\\[p](‘beat’) [p](beat) [p](‘broken)*",
    "pythonExpected": "*论文图 2。\\[p](‘beat’) [p](beat) [p](‘broken)*",
    "complexSkip": false
  },
  {
    "source": "```text\n*论文图 2。[p](‘beat’)*\n```",
    "nodeExpected": "```text\n*论文图 2。[p](‘beat’)*\n```",
    "pythonExpected": "```text\n*论文图 2。[p](‘beat’)*\n```",
    "complexSkip": false
  },
  {
    "source": "~~~~\n*论文图 2。[p](‘beat’)*\n~~~\n*论文图 3。[p](‘beat’)*\n~~~~",
    "nodeExpected": "~~~~\n*论文图 2。[p](‘beat’)*\n~~~\n*论文图 3。[p](‘beat’)*\n~~~~",
    "pythonExpected": "~~~~\n*论文图 2。[p](‘beat’)*\n~~~\n*论文图 3。[p](‘beat’)*\n~~~~",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。\\(x=[1,2]\\)*",
    "nodeExpected": "*论文图 2。\\(x=[1,2]\\)*",
    "pythonExpected": "*论文图 2。\\(x=[1,2]\\)*",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。[p](‘beat’)*\r\n*论文图 3。[p](‘beat’)*",
    "nodeExpected": "*论文图 2。&#91;p&#93;(‘beat’)*\r\n*论文图 3。&#91;p&#93;(‘beat’)*",
    "pythonExpected": "*论文图 2。&#91;p&#93;(‘beat’)*\r\n*论文图 3。&#91;p&#93;(‘beat’)*",
    "complexSkip": false
  },
  {
    "source": "*论文图 2。escaped [p\\](‘beat’)*",
    "nodeExpected": "*论文图 2。escaped [p\\](‘beat’)*",
    "pythonExpected": "*论文图 2。escaped [p\\](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。formula \\([p](‘beat’)\\)*",
    "nodeExpected": "*论文图 2。formula \\([p](‘beat’)\\)*",
    "pythonExpected": "*论文图 2。formula \\([p](‘beat’)\\)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。formula $[p](‘beat’)$*",
    "nodeExpected": "*论文图 2。formula $[p](‘beat’)$*",
    "pythonExpected": "*论文图 2。formula $[p](‘beat’)$*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。![alt [p](‘beat’) other](https://example.org/image.png)*",
    "nodeExpected": "*论文图 2。![alt [p](‘beat’) other](https://example.org/image.png)*",
    "pythonExpected": "*论文图 2。![alt \\[p](‘beat’) other](https://example.org/image.png)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。![image](https://example.org/x.png) [p](‘beat’)*",
    "nodeExpected": "*论文图 2。![image](https://example.org/x.png) [p](‘beat’)*",
    "pythonExpected": "*论文图 2。![image](https://example.org/x.png) [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。<span>title</span> [p](‘beat’)*",
    "nodeExpected": "*论文图 2。<span>title</span> [p](‘beat’)*",
    "pythonExpected": "*论文图 2。<span>title</span> [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。<EOT> [p](‘beat’)*",
    "nodeExpected": "*论文图 2。<EOT> [p](‘beat’)*",
    "pythonExpected": "*论文图 2。<EOT> [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。**bold** [p](‘beat’)*",
    "nodeExpected": "*论文图 2。**bold** [p](‘beat’)*",
    "pythonExpected": "*论文图 2。两个星号bold两个星号 [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。_emphasis_ [p](‘beat’)*",
    "nodeExpected": "*论文图 2。_emphasis_ [p](‘beat’)*",
    "pythonExpected": "*论文图 2。_emphasis_ [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。~~strike~~ [p](‘beat’)*",
    "nodeExpected": "*论文图 2。~~strike~~ [p](‘beat’)*",
    "pythonExpected": "*论文图 2。~~strike~~ [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。[outer [p](‘beat’) tail]*",
    "nodeExpected": "*论文图 2。[outer [p](‘beat’) tail]*",
    "pythonExpected": "*论文图 2。[outer [p](‘beat’) tail]*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。[unclosed [p](‘beat’)*",
    "nodeExpected": "*论文图 2。[unclosed [p](‘beat’)*",
    "pythonExpected": "*论文图 2。[unclosed [p](‘beat’)*",
    "complexSkip": true
  },
  {
    "source": "*论文图 2。`[p](‘beat’)` and [t](‘word’)*\r\n",
    "nodeExpected": "*论文图 2。`[p](‘beat’)` and [t](‘word’)*\r\n",
    "pythonExpected": "*论文图 2。`[p](‘beat’)` and [t](‘word’)*\r\n",
    "complexSkip": true
  }
];
for(const[i,c]of cases.entries())test((c.complexSkip?'complex caption adds no delta ':'plain/existing caption ')+i,()=>assert.equal(api.repairPreservedPage(c.source),c.nodeExpected));
