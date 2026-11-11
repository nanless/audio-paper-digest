# 协议登记与结构指纹

## 这一页解决什么

项目保存的很多 JSON 需要说明“这是什么格式”。新记录不再把 `-v1`、`-v2` 写进格式名，而是写一个稳定的用途名（`contract`）和一份结构声明的内容指纹（`schemaFingerprint`）。名称说明用途，指纹说明实际字段和规则；两者一起才能确定这条记录该按哪种结构读取。

登记集中在 [`config/protocols/`](../config/protocols/)，当前有 36 份 JSON 文件。Node 读取全部登记；Python 的发布与科学身份只读其中非 `clients-*` 的服务端目录，原生客户端专用格式由 [`apps/generate-client-protocols.py`](../apps/generate-client-protocols.py) 读取，两边不是同一份文件清单：

| 语言 | 入口 | 读取范围 |
|---|---|---|
| Node | [`scripts/lib/protocol-codec.js`](../scripts/lib/protocol-codec.js) | 全部 `config/protocols/*.json` |
| Python | [`scripts/protocol_codec.py`](../scripts/protocol_codec.py) | `server_catalog_paths()` 返回的非 `clients-*` 目录 |

两份实现使用同一套规范化 JSON 和 SHA-256 算法。格式登记本身不是签名，也不授予来源、分析、费用或发布资格；它只回答“这条记录声明的是哪种结构”。

## 登记文件长什么样

每个 `config/protocols/<名称>.json` 只含一个 `protocols` 数组：

```json
{
  "protocols": [
    {
      "name": "conference-queue-plan",
      "currentVariant": "ordered-selected-conferences",
      "currentSchema": {
        "fields": ["conferenceId", "catalogName", "reportName", "filterId", "concurrency"],
        "maxConcurrency": 3,
        "identity": "ordered-members-exact-plan-sha"
      },
      "historical": [
        {
          "tag": "conference-queue-plan-v1",
          "variant": "ordered-selected-conferences",
          "header": { "contract": "conference-queue-plan-v1", "version": 1 }
        }
      ]
    }
  ]
}
```

四项各有作用：

| 字段 | 含义 |
|---|---|
| `name` | 稳定的用途名，新记录写入 `contract`。只能用小写字母、数字、`-`、`.`，不能带 `-v1` 这类段。 |
| `currentVariant` | 当前语义变体的名字，同样不带版本号。它和 `name`、`currentSchema` 一起参与指纹计算。 |
| `currentSchema` | 当前结构的完整声明：字段、校验规则、身份算法等。不能为空对象。 |
| `historical` | 只读的旧格式清单。没有旧记录时写空数组。 |

历史项有三种写法：

- 旧记录只写了 `contract`：`{"tag": "旧标签", "variant": "旧语义"}`。
- 旧记录还写了 `version`、`schemaVersion` 或旧的结构指纹：加 `header`，逐字段写出当时实际写入的头。
- 旧头带 `schemaFingerprint` 时，再加 `schema`，写明当时的完整结构；登记器会重算指纹并要求一致。

个别更早的记录只写整数版本号（例如 `version: 3`），这类旧头也登记在 `historical`，`tag` 写那个整数，并在 `header` 中保留原字段。

`historical` 中的 `tag` 只用于读取，不会用于新写入。已有旧记录也不补写新字段；重算旧记录的哈希时继续使用原头和原字节。

### 同一稳定名换了结构

如果用途名不变、字段发生变化，把新的结构放进 `currentSchema`，并把旧结构登记为一条历史项：`tag` 仍写旧记录实际使用的 `contract`（可以就是同一个稳定名），`variant` 写旧语义，`header` 写旧指纹，`schema` 写旧结构。这样新旧记录都能找到各自的结构；读取旧记录时必须提供原指纹，不能拿当前结构去解释旧头。

## 指纹怎么算

指纹是下面这个对象的 SHA-256：

```json
{ "name": "...", "currentVariant": "...", "currentSchema": { ... } }
```

规范化规则：对象的键按字典序排列，使用紧凑分隔符，保留 UTF-8；字段名只用普通 ASCII 字符；数字必须是安全整数。结果是 64 位小写十六进制 SHA-256。Node 与 Python 的实现逐字一致，同一份登记在两边得到同一个值。登记里的数字要写成 JSON 整数：写成 `2.0` 时 Node 会当作整数 2，Python 会拒绝，两边无法得到同一个指纹。

登记时不需要手填指纹，程序会计算。手抄、复制别的格式或凭印象填写都会在加载时被拒绝。

## 写入和读取

新记录的头只写稳定名和当前指纹：

```json
{
  "contract": "conference-queue-plan",
  "schemaFingerprint": "08c8282ce9549b8c7867da4e00363302af0827c886217123fe75b1f9af7e5a3d",
  "conferences": []
}
```

Node 用 `recordHeader(name, name)` 取得头，或用 `record(name, fields)` 一次加上头和正文；Python 用 `record_header(name, name)` 和 `record(name, fields)`。`record()` 会拒绝覆盖 `contract`、`schemaFingerprint`、`version`、`schemaVersion`、`policyVersion` 这些保留键，避免把旧版本字段带进新记录。

读取时：

- `hasValidHeader(value, family)` 核对 `contract` 和 `schemaFingerprint` 是否整组匹配已登记格式。
- `isCurrentHeader(...)` 额外要求它就是当前结构；只读旧记录时不要用它。
- `format(tag, family, fingerprint)` 返回该记录登记时的语义变体。
- `declaredSchema(...)` 返回记录声明时的结构，用于重算旧字段；缺指纹的旧头没有完整结构，调用会报错。
- `historicalHeader(...)`、`historicalContract(...)` 读取旧头；`historicalContract` 只适用于没有指纹的旧格式，带指纹的旧记录必须读完整头。

同一个 `contract` 可能登记了多种结构（当前一种、历史若干种）。这时读取必须带上原 `schemaFingerprint`；只给名称无法判断该按哪份结构解释。

## 旧标签的只读重放

`-v1`、`-v2` 这类登记标签只出现在 `historical` 中，代表过去某次写入的实际头。旧记录按下面的顺序重放：

1. 读取原文件字节，不修改原记录。
2. 用旧头中的 `contract` 和可选 `schemaFingerprint` 在登记中找到当时的结构。
3. 用当时的结构和算法重新核对字段、来源、SHA 与计数；没有指纹的旧头只按它实际携带的字段核对，不能凭空补全结构。
4. 只有当前入口明确允许时，才把通过重放的旧结果用于当前发布；只读通过不等于取得新的分析、请求或发布资格。

不要给旧记录补写新指纹，也不要把旧标签改写成稳定名；那会改变原字节和原身份。

## 新增一个格式

1. 先想清用途，取一个能长期使用的稳定名；不要用 `-v1` 表示第一版。
2. 在 `currentVariant` 写当前语义，在 `currentSchema` 写全字段和校验规则；结构声明要能说明哪些字段必需、身份怎么算。
3. 如果已有旧格式，把旧头逐字段登记到 `historical`，带旧指纹时同时登记旧 `schema`。不要猜测旧字段。
4. 把登记放进 `config/protocols/` 下合适的小写文件名；加载器会读取该目录的全部 `*.json`。
5. 用 `recordHeader`（Node）或 `record_header`（Python）写新记录，用 `hasValidHeader` 等函数读旧记录。
6. 运行定向测试：

```bash
node --test tests/protocol-codec.test.js
```

新增格式后，检查所有实际读写点是否都走共享登记器；不要在业务代码里另写一份指纹算法或字段白名单。

## 常见错误

- **小写键**：`schemaFingerprint` 大小写敏感。Hugo 会把 front matter 参数 map 的嵌套键递归小写，所以网页内嵌的 `paper-tools__client-sidecars` 声明必须按白名单逐字段重建，保留驼峰写法。写成 `schemafingerprint` 时，`hasValidHeader` 不通过。已发行的 2026-11-03、11-04 页面曾出现小写，客户端只把这一个已知别名归一化一次，之后仍按登记指纹校验。
- **混用旧头**：新格式写成 `contract` + `schemaFingerprint`，不要再带 `version` 或 `schemaVersion`；旧标签也不要补新指纹。把旧 `version: 1` 和新 `contract` 拼在一起，或把新指纹写到旧记录上，都会被拒绝。
- **手填指纹**：指纹由 `name`、`currentVariant`、`currentSchema` 共同决定。改字段、改变体名或改用途名都会得到新值；不能把别的格式的指纹复制过来。
- **同一标签多种结构却不带指纹**：读取时必须传原 `schemaFingerprint`，否则无法确定结构。
- **拿当前结构解释旧记录**：旧记录必须按登记的历史结构读取；当前结构只用于新写入。
- **改结构不登记历史**：已保存的旧记录会失去可读的结构声明，后续重算和恢复都会失败。

格式登记和结构指纹只识别“这是哪种记录”。记录里的来源、SHA、费用、次数和发布资格，仍由各自入口按原规则核验。
