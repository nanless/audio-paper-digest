'use strict';

// 仅合并明确TeX注解与完全一致的可见副本；裸重复仍保留并由正式校验阻断。
function normalizeExplicitReaderSymbolProjection(value) {
    let output = String(value ?? '');
    if (!output.includes('\\')) return output;
    // Entire source cells only: a visible approximation marker and its explicit
    // TeX annotation are the same marker, not two measured values. Unknown
    // commands, arithmetic continuations and bare numeric duplicates stay put.
    output = output.replace(/(^|[|\n])([ \t]*)([^|\n]+?)([ \t]*)(?=[|\n]|$)/g,
        (whole, boundary, space, body, trailing) => {
            if (!body.includes('\\')) return whole;
            const quantity = String.raw`(?:∼\\sim)?(?:\d+(?:\.\d+)?|\.\d+)(?:[ \t]*(?:KB|MB|GB|ms|s|Hz|kHz|MHz|GHz|dB|GFLOPs|%))?`;
            if (body.includes('∼\\sim')
                && new RegExp(`^${quantity}(?:[ \\t]*/[ \\t]*${quantity})?$`).test(body)) {
                return boundary + space + body.replaceAll('∼\\sim', '∼') + trailing;
            }
            // Complete, bounded sums of explicitly duplicated calligraphic
            // variables. Compare coefficients, subscripts and order verbatim;
            // never infer a half-value from a repeated number or expression.
            if (body.length > 512 || !body.includes('\\mathcal{')) return whole;
            const term = /^([1-9]\d{0,3})?\\mathcal\{([A-Za-z])\}_\{(0|[1-9]\d{0,3})\}$/;
            const matches = new Set();
            for (let split = 1; split < body.length; split++) {
                const terms = body.slice(split).trim().split('+').map(part => part.trim());
                if (terms.length > 8) continue;
                const atoms = terms.map(part => term.exec(part));
                if (atoms.some(atom => !atom)) continue;
                const projection = atoms.map(atom => (atom[1] || '') + atom[2] + atom[3]).join('+');
                const visible = body.slice(0, split).normalize('NFKC')
                    .replace(/[\u200b\u200c\u200d\u2060\ufeff \t]/g, '');
                if (visible === projection) matches.add(body.slice(0, split).trimEnd());
            }
            return matches.size === 1 ? boundary + space + [...matches][0] + trailing : whole;
        });
    // 仅完整格中的同值布尔符号与显式 TeX 副本；乘积、续式和裸重复不投影。
    output = output.replace(/(^|[|\n])([ \t]*)([✓×])\\(checkmark|times)(?=[ \t]*(?:[|\n]|$))/g,
        (whole, boundary, space, visible, command) => visible === (command === 'checkmark' ? '✓' : '×')
            ? `${boundary}${space}${visible}` : whole);
    // A complete scalar multiplier may carry the same visible × and explicit
    // \times annotation. Keep every numeric byte; never consume a continuation.
    output = output.replace(/(^|[|\n])([ \t]*)([+−-]?(?:\d+(?:\.\d+)?|\.\d+))×\\times(?=[ \t]*(?:[|]|$))/g,
        (_whole, boundary, space, scalar) => `${boundary}${space}${scalar}×`);
    const hasContinuation = (input, end) => /^\s*[\p{L}\p{N}_^\\({]/u.test(input.slice(end));
    // 只有完整的可见变量与明确 TeX 同值时才合并，不能从裸重复猜测。
    const compound = [
        /(?<![A-Za-z0-9_])([A-Za-z])([0-9]+)([A-Za-z]{1,24})\1_\{\2\}\^\{\\mathrm\{\3\}\}(\s+\(multi-space\))?(?![\p{L}\p{N}_^\\({])/gu,
        /(?<![A-Za-z0-9_])([A-Za-z]{1,24})([A-Za-z]{1,24})×([A-Za-z]{1,24})([A-Za-z]{1,24})\1_\{\\(?:mathrm|text)\{\2\}\}(?:\\!)*\\times(?:\\!)*(?:\\mathrm\{\3\}|\3)_\{\\(?:mathrm|text)\{\4\}\}(?![\p{L}\p{N}_^\\({])/gu
    ];
    output = output.replace(compound[0], (whole, base, index, power, label, offset, input) =>
        hasContinuation(input, offset + whole.length) ? whole : `${base}${index}${power}${label || ''}`);
    output = output.replace(compound[1], (whole, left, leftIndex, right, rightIndex, offset, input) =>
        hasContinuation(input, offset + whole.length) ? whole : `${left}${leftIndex}×${right}${rightIndex}`);
    output = output.replace(/(?<![A-Za-z0-9_.+−-])([+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))%([∗*]{1,3})\s*([+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))\\%\^\{([*]{1,3})\}(?![\p{L}\p{N}._^\\({])/gu,
        (whole, visible, stars, tex, texStars, offset, input) =>
            hasContinuation(input, offset + whole.length)
            || visible.replace('−', '-') !== tex.replace('−', '-')
            || stars.replace(/∗/g, '*') !== texStars ? whole : `${visible}%${stars}`);
    output = output.replace(/(?<![A-Za-z0-9_.+−-])([+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))%\s*([+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))\\%(?![\p{L}\p{N}._^\\({])/gu,
        (whole, visible, tex, offset, input) => hasContinuation(input, offset + whole.length)
            || visible.replace('−', '-') !== tex.replace('−', '-') ? whole : `${visible}%`);
    // 范数符号只接受完整可见下标与明确 TeX 同义，不从裸重复或续式猜值。
    output = output.replace(/(?<![\p{L}\p{N}_])ℓ(∞|[0-9]+)\\ell_\{(\\infty|[0-9]+)\}(?![\p{L}\p{N}_^\\({+−=×÷/*<>≤≥-])/gu,
        (whole, visibleIndex, texIndex, offset, input) => {
            if (/^\s*[\p{L}\p{N}_^\\({+−=×÷/*<>≤≥-]/u.test(input.slice(offset + whole.length))) return whole;
            const projectedIndex = texIndex === '\\infty' ? '∞' : texIndex;
            return visibleIndex === projectedIndex ? 'ℓ' + visibleIndex : whole;
        });
    const greek = { Delta:'Δ', alpha:'α', beta:'β', gamma:'γ', tau:'τ', lambda:'λ', omega:'ω' };
    const baseProjection = base => {
        const command = /^\\([A-Za-z]{1,24})$/.exec(base);
        if (command) return greek[command[1]] || null;
        const styled = /^\\(?:mathcal|mathrm)\{([A-Za-z]{1,24})\}$/.exec(base);
        return styled ? styled[1] : /^[A-Za-z]{1,24}$/.test(base) ? base : null;
    };
    const atom = /^(?:\\boldsymbol\{\\Delta_\{\\mathrm\{([A-Za-z]{1,24})\}\}\}|(\\mathcal\{[A-Za-z]\}|\\mathrm\{[A-Za-z]{1,24}\}|\\Delta|[A-Za-z]{1,24})_\{\\(?:mathrm|text)\{([A-Za-z]{1,24})\}\}(?:\(\\(tau|alpha|beta|gamma|lambda|omega)\))?|\\(Delta|alpha|beta|gamma|tau|lambda|omega))(?:\\(uparrow|downarrow))?(?![\p{L}\p{N}_^\\({])/u;
    const canonical = text => text.normalize('NFKC').replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '');
    // 逐起点识别完整受限原子，避免贪婪地把可见副本当成 TeX 的字母基底。
    for (let index = output.length - 1; index >= 0; index--) {
        const match = atom.exec(output.slice(index, index + 160));
        if (!match) continue;
        // 数学续尾前的空白不是结束边界；任何继续命令都保留原注解。
        if (hasContinuation(output, index + match[0].length)) continue;
        let projection;
        if (match[1]) projection = 'Δ' + match[1];
        else if (match[5]) projection = greek[match[5]];
        else {
            const base = baseProjection(match[2]);
            if (!base) continue;
            projection = base + match[3] + (match[4] ? '(' + greek[match[4]] + ')' : '');
        }
        if (match[6]) projection += match[6] === 'uparrow' ? '↑' : '↓';
        const visible = output.slice(0, index).match(/[\p{L}\p{N}()↑↓\u200b\u200c\u200d\ufeff]*$/u)?.[0] || '';
        const start = index - visible.length;
        if (canonical(visible) !== projection) continue;
        output = output.slice(0, start) + visible + output.slice(index + match[0].length);
        index = start;
    }
    return output.replace(/([↑↓])(?:\\(uparrow|downarrow)(?![A-Za-z])|\{\\(uparrow|downarrow)\}(?=[ \t]*(?:[|\n]|$)))/g,
        (whole, visible, plainCommand, bracedCommand, offset, input) => {
            const command = plainCommand || bracedCommand;
            if (hasContinuation(input, offset + whole.length)
                || visible !== (command === 'uparrow' ? '↑' : '↓')) return whole;
            return visible;
        })
        .replace(/([+/])\\;\1\\;/g, '$1')
        // LaTeXML 也会把「标识符 + 符号」整体重复一遍：`r≥r\geq`。
        // 只在命令与可见符号确实是同一符号时折叠，未知命令保持原样交给后续检查。
        .replace(/([A-Za-z0-9])([≥≤≈≠±×·∼→←↑↓↔])\1\\([A-Za-z]+)/g,
            (whole, head, symbol, command) => (
                READER_TEX_SYMBOLS[command] === symbol ? `${head}${symbol}` : whole));
}

// 表格单元格里 LaTeXML 会把同一个值输出两遍：一次可见副本、一次同义 TeX 注解。
// 只按“可见值 == TeX 纯文本投影”折叠完整重复；未知命令或数值不同时保持原样，
// 交给调用方的 unresolved_source_tex 检查拒绝，不能静默删值。
const READER_TEX_SYMBOLS = Object.freeze({
    uparrow: '↑', downarrow: '↓', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
    times: '×', pm: '±', cdot: '·', approx: '≈', geq: '≥', leq: '≤', neq: '≠', sim: '∼',
    sigma: 'σ', lambda: 'λ', tau: 'τ', beta: 'β', alpha: 'α', mu: 'μ', pi: 'π',
    delta: 'δ', eta: 'η', theta: 'θ', kappa: 'κ', rho: 'ρ', phi: 'φ', chi: 'χ', psi: 'ψ', zeta: 'ζ', nu: 'ν', xi: 'ξ', epsilon: 'ε', varepsilon: 'ε',
    Delta: 'Δ', omega: 'ω', gamma: 'γ', checkmark: '✓', infty: '∞', ell: 'ℓ', dagger: '†', ddagger: '‡',
    varnothing: '∅', emptyset: '∅', circ: '∘', star: '⋆', bullet: '•', prime: '′',
});
const READER_TEX_STYLE_NAMES = /\\(?:textnormal|textbf|text|mathrm|mathbf|mathit|mathcal|boldsymbol|mbox|operatorname|widehat|overline|underline|tilde|hat|bar)/g;
function readerTexCellCanonical(value) {
    return String(value ?? '').normalize('NFKC')
        .replace(/[\u200b\u200c\u200d\u2060\ufeff\u2061\u2062]/g, '')
        .replace(/−/g, '-').replace(/\s+/g, '').trim();
}
function readerTexPlain(value) {
    let output = String(value ?? '');
    if (!output.includes('\\') && !/[_^]\{/.test(output) && !output.includes('{,}')) return output;
    output = output.replace(/\\[,;:!]/g, '');
    for (let round = 0; round < 10; round++) {
        const before = output;
        output = output
            .replace(/([A-Za-z0-9]+)\^\{((?:[^{}]|\{[^{}]*\})*)\}_\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1$3$2')
            .replace(/([A-Za-z0-9]+)_\{((?:[^{}]|\{[^{}]*\})*)\}\^\{((?:[^{}]|\{[^{}]*\})*)\}/g, '$1$2$3')
            .replace(READER_TEX_STYLE_NAMES, '')
            .replace(/\{([^{}]*)\}/g, '$1');
        if (output === before) break;
    }
    output = output.replace(/\\([A-Za-z]+)/g, (whole, name) => {
        if (Object.hasOwn(READER_TEX_SYMBOLS, name)) return READER_TEX_SYMBOLS[name];
        for (let length = name.length - 1; length >= 2; length--) {
            const head = name.slice(0, length);
            if (Object.hasOwn(READER_TEX_SYMBOLS, head)) return READER_TEX_SYMBOLS[head] + name.slice(length);
        }
        return whole;
    });
    return output.replace(/[{}^_]/g, '');
}
function readerTexAlignTail(plain, canonicalPrefix) {
    for (let index = 0; index <= plain.length; index++) {
        if (readerTexCellCanonical(plain.slice(0, index)) === canonicalPrefix) return plain.slice(index);
    }
    return null;
}
function foldReaderTexCellDuplicate(value) {
    const text = String(value ?? '');
    // 可见文字后面又跟一段 `{}_{...}^{...}` 上下标副本时，只要副本里的字符
    // 全部已在可见部分出现，就丢弃副本
    // （vv-MF∅CFGmSTFT{}_{\mathrm{mSTFT}}^{\varnothing\mathrm{CFG}}）。
    const dual = /^([\s\S]*?)\{\}_\{([\s\S]+)\}\^\{([\s\S]+)\}$/.exec(text);
    if (dual && dual[0].length === text.length) {
        const plain = readerTexPlain(dual[2] + dual[3]);
        if (plain && !plain.includes('\\') && [...plain].every((char) => dual[1].includes(char))) {
            return dual[1];
        }
    }
    // 可见符号后跟同义命令的重复副本（EER↓\downarrow、ACC↑\uparrow）：命令的符号
    // 必须与可见部分最后一个字符完全相同，且命令后面不是字母数字续写。
    const symbolCopy = /^\\([A-Za-z]+)([\s\S]*)$/u.exec(text);
    if (symbolCopy) {
        const symbol = Object.hasOwn(READER_TEX_SYMBOLS, symbolCopy[1]) ? READER_TEX_SYMBOLS[symbolCopy[1]] : null;
        if (symbol && symbolCopy[2] && !/^[A-Za-z0-9]/u.test(symbolCopy[2])) {
            const head = text.slice(0, text.length - symbolCopy[0].length);
            if (head && head.endsWith(symbol)) return head + symbolCopy[2];
        }
    }
    for (let split = 1; split < text.length; split++) {
        const tailProbe = text.slice(split);
        if (!tailProbe.includes('\\') && !/[_^]\{/.test(tailProbe) && !tailProbe.includes('{,}')) continue;
        const prefix = text.slice(0, split), suffix = text.slice(split);
        const plain = readerTexPlain(suffix);
        if (!plain || plain.includes('\\')) continue;
        const canonicalPrefix = readerTexCellCanonical(prefix);
        const canonicalPlain = readerTexCellCanonical(plain);
        if (!canonicalPlain) continue;
        // 整格只有「一个可见符号 + 同义命令」时也是完整的同义双写
        // （∅\varnothing、∘\circ）。命令的纯文本必须和可见值逐字相等，
        // 所以 `2^{2}` 这种真实上标和 `∅\circ` 这种不同值都不会被折叠。
        if (canonicalPrefix.length === 1 && canonicalPlain === canonicalPrefix
            && suffix.startsWith('\\')) return prefix;
        // 前缀可能带「+ 」这类装饰符，副本只复制实体部分（+ n∼𝒰0,1n\sim\mathcal{U}_{0,1}）。
        const strippedPrefix = canonicalPrefix.replace(/^[^0-9A-Za-z\u4e00-\u9fff]+/u, '');
        if (strippedPrefix.length >= 2 && strippedPrefix !== canonicalPrefix && canonicalPlain.startsWith(strippedPrefix)) {
            const strippedTail = readerTexAlignTail(plain, strippedPrefix);
            if (strippedTail !== null && /^[\s(（\[,:：;；↑↓→←↔±×%°+\-]/.test(strippedTail)) return prefix + strippedTail;
        }
        // 单字符符号前缀 + 副本继续给出余下文字（Δ\DeltaIC → ΔIC）。
        // 副本必须以 TeX 构造开始；否则普通单词（EER↓\downarrow 的 E + ER…）会被误折。
        if (canonicalPrefix.length === 1 && canonicalPlain.length > 1 && canonicalPlain.startsWith(canonicalPrefix)
            && /^[\\{^_]/u.test(suffix)) {
            const symbolTail = readerTexAlignTail(plain, canonicalPrefix);
            if (symbolTail !== null && /^[A-Za-z0-9\u4e00-\u9fff\s(（\[,:：;；]/u.test(symbolTail)) return prefix + symbolTail;
        }
        if (canonicalPrefix.length < 2) continue;
        // 副本只重复「紧邻的那个词元」时也折叠：整格开头还有正文
        //（Aligned temporal granularity (†:f×8{}^{\dagger}\!:{f}\times 8）。
        if (canonicalPlain.length >= 2) {
            // 副本后面可能紧跟右括号或句读，比较时先剥离再补回。
            const trailingMatch = /[)）】\],.;；]+$/u.exec(plain);
            const trailing = trailingMatch ? trailingMatch[0] : '';
            const core = trailing ? plain.slice(0, plain.length - trailing.length) : plain;
            // 纯文本还原会在符号与数字之间插入空格（‡:f× 4），比较时统一去空白。
            const squeeze = value => String(value || '').replace(/\s+/gu, '');
            const squeezedCore = squeeze(core);
            if (squeezedCore && squeeze(prefix).endsWith(squeezedCore)) {
                const head = prefix.replace(/\s+$/u, '');
                const at = head.lastIndexOf(core.trim().slice(-1));
                const before = at > 0 ? head.slice(0, at) : '';
                if (!before || !/[A-Za-z0-9\u4e00-\u9fff]$/u.test(before)) return prefix + trailing;
            }
        }
        if (canonicalPlain === canonicalPrefix) return prefix;
        if (canonicalPrefix.length > canonicalPlain.length && canonicalPrefix.endsWith(canonicalPlain)) return prefix;
        if (canonicalPlain.startsWith(canonicalPrefix)) {
            const remainder = readerTexAlignTail(plain, canonicalPrefix);
            // 只有 TeX 注解之后是独立正文或尾符号时才保留；注解自己的下标/内容
            // （FD\mathrm{FD_{norm}} 的 norm）不是独立正文，不能当重复删一半。
            if (remainder !== null && /^[\s(（\[,:：;；↑↓→←↔±×%°]/.test(remainder)) return prefix + remainder;
        }
        // 注解只重复可见值开头的一个符号（−72.9-72.9、w/o L→\rightarrowH 的箭头），
        // 保留可见副本来替换整个注解；剩余文字里的独立副本仍由下一轮折叠加守。
        if (/^[\\{^_]/.test(suffix) && canonicalPlain.length > 1 && canonicalPrefix.length > 1
            && !/[0-9]/.test(canonicalPlain[0])
            && canonicalPrefix.endsWith(canonicalPlain[0])) return prefix + plain.slice(1);
    }
    return text;
}
function projectReaderAnonMacro(value) {
    // 匿名投稿的自定义宏 `\\anon[匿名写法]{真名}` 在扁平文本里只剩 `\\anon[匿名写法]真名`。
    // 可见输出是方括号里的匿名写法；只在紧跟一段字母数字短词或一条 URL 时替换。
    // URL 必须整条丢掉：只吃掉 `https` 会把仓库地址原样留在页面上。
    return String(value ?? '')
        .replace(/\\anon\[([^\]]*)\][A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s，。、；：）】]*/g, '$1')
        .replace(/\\anon\[([^\]]*)\][A-Za-z0-9-]*(?![A-Za-z0-9])/g, '$1');
}

const PARENTHESIZED_SIGNED_DOUBLE_WRITE_RE = /(\(([+−-])([0-9]+(?:\.[0-9]+)?%?)\))\(([+−-])([0-9]+(?:\.[0-9]+)?%?)\)/g;
const LEADING_EMPTY_LINK_CELL_PREFIX_RE = /^[^\S\r\n]*\[\]\[\][ \t]+(?=[^\s\u200b\u200c\u200d\u2060\ufeff])(?!\[\]\[\])/;

function collapseParenthesizedSignedDoubleWrite(value) {
    const text = String(value ?? '');
    if (!text.includes(')(')) return text;
    const protectedUrls = [];
    const masked = text.replace(/\]\([^)\s]+\)/g, (match) => {
        protectedUrls.push(match);
        return `\x00PDURL${protectedUrls.length - 1}\x00`;
    });
    const collapsed = masked.replace(
        PARENTHESIZED_SIGNED_DOUBLE_WRITE_RE,
        (whole, firstGroup, firstSign, firstNum, secondSign, secondNum, offset, input) => {
            if (firstNum !== secondNum) return whole;
            if ((firstSign === '−' ? '-' : firstSign) !== (secondSign === '−' ? '-' : secondSign)) {
                return whole;
            }
            if (offset > 0 && /[\p{L}\p{N}_^\\.\])}+−=*×÷\-/\x00]$/u.test(input.slice(0, offset))) {
                return whole;
            }
            const tail = input.slice(offset + whole.length);
            if (tail && (/^[\p{L}\p{N}_^\\({%*×÷/\x00]/u.test(tail) || /^\.\p{N}/u.test(tail))) {
                return whole;
            }
            return firstGroup;
        }
    );
    let restored = collapsed;
    for (let index = 0; index < protectedUrls.length; index++) {
        restored = restored.split(`\x00PDURL${index}\x00`).join(protectedUrls[index]);
    }
    return restored;
}

function stripLeadingEmptyReferenceLinkCellPrefix(value) {
    return String(value ?? '').replace(LEADING_EMPTY_LINK_CELL_PREFIX_RE, '');
}

function projectReaderCellTexDisplayBody(value) {
    let output = String(value ?? '');
    // LaTeXML 脚注残留：n/a11footnotemark: 1 → n/a（在任何提前返回之前处理）。
    output = output.replace(/(\S*?)\s*11footnotemark:\s*\d+(?![\d.])/g, '$1');
    output = output.replace(/\s*\(\s*\)/g, '');
    // 页面渲染会把单元格里的 < > 转成 HTML 实体，比较前先还原成字面尖括号。
    output = output.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (output.includes('\\anon[')) output = projectReaderAnonMacro(output);
    // 符号重复：++0.0、−-19.6、+-3.2 只留一个符号（后面必须紧跟数字）。
    output = output.replace(/([+−])(?:[+−-])(?=[\d.])/g, '$1');
    // 带括号的有符号标量双写：(−1.4)(-1.4) → (−1.4)、(+0.2)(+0.2) → (+0.2)。
    output = collapseParenthesizedSignedDoubleWrite(output);
    // 行内公式的定界符 \( \) 只是排版包裹，单元格比较时去掉。
    output = output.split('\\(').join('').split('\\)').join('');
    // 千位分隔的 TeX 写法与紧邻重复：55{,}00855{,}008 → 55,008。
    output = output.replace(/{,}/g, ',');
    output = output.replace(/(\d{1,3}(?:,\d{3})+)\1(?![\d,])/g, '$1');
    // 同一个整数写两遍：3232 → 32。小数点和千位分隔符两侧不算同一段数字
    // （0.7070.707 里的 7070 是 0.707 的尾数接下一份的首位，不是重复），
    // 四位年份 2020 与一位数 55/99 也不能折叠。
    output = output.replace(/(?<![\d,.])(\d{2,})\1(?![\d,.])/g,
        (whole) => (/^(?:19|20)\d{2}$/.test(whole) ? whole : whole.slice(0, whole.length / 2)));
    if (!output.includes('\\') && !/[_^]\{/.test(output)
        && !/([^|\n=]{1,12}=[0-9]+(?:\.[0-9]+)?)\1(?![0-9.])/.test(output)) return output;
    output = output.replace(/\\[,;:]/g, '');
    // 可见 Unicode 数学字母/粗体与同值 \boldsymbol 注解只保留可见副本。
    output = output.replace(/([^\s\\|(){}])\\boldsymbol\{(\\?[A-Za-z]+)\}/gu,
        (whole, visible, name) => {
            const value = name.startsWith('\\') ? name.slice(1) : name;
            const projected = Object.hasOwn(READER_TEX_SYMBOLS, value) ? READER_TEX_SYMBOLS[value] : value;
            return readerTexCellCanonical(visible) === readerTexCellCanonical(projected) ? visible : whole;
        });
    // 文本模式下重复可见字符的上标副本（I2{}^{\text{2}}S → I2S）：可见字符已在前面，
    // 副本只是把同一个字符排成上标。**必须紧跟字母/数字续写**才算词内副本；
    // 若副本出现在词尾（2{}^{\text{2}}、m2{}^{\text{2}}），那是真指数，保留原文，
    // 让「残留 TeX」检查去要求改写，不能静默把 ^2 折掉。
    output = output.replace(/([A-Za-z0-9])\{\}\^\{\\text\{([A-Za-z0-9]{1,3})\}\}(?=[A-Za-z0-9])/g,
        (whole, visible, copy) => (visible === copy ? visible : whole));
    output = output.replace(/([A-Za-z])\^\\(?:hat|widehat)\{([A-Za-z]+)\}/g,
        (whole, visible, name) => visible === name ? visible + '\u0302' : whole);
    output = output.replace(/\\hat\{([A-Za-z])\}/g, (_whole, name) => name + '\u0302');
    output = output.replace(/([A-Za-z])\u00af\\overline\{([A-Za-z]+)\}/g,
        (whole, visible, name) => visible === name ? visible + '\u0304' : whole);
    output = output.replace(/\\overline\{([A-Za-z])\}/g, (_whole, name) => name + '\u0304');
    // 一个单元格里可能有多组「可见值 + TeX 副本」，用分号隔开；先分段折叠再拼回，
    // 否则第一组后面的全部内容会被当成同一个副本而不匹配。
    if (/[;；]/.test(output) && /\\/.test(output)) {
        output = output.split(/([;；])/u).map(part => (/[;；]/u.test(part) ? part : projectReaderCellTexDisplayBody(part))).join('');
    }
    for (let round = 0; round < 6 && (output.includes('\\') || /[_^]\{/.test(output)); round++) {
        const folded = foldReaderTexCellDuplicate(output);
        if (folded === output) break;
        output = folded;
    }
    // 简单指数 10^{-4} 与来源的可见写法 10−4 等价，投影成同一形态。
    output = output.replace(/(\d)\^\{([-−+]\d+)\}/g, (_w, base, exp) => base + exp.replace('-', '\u2212'));
    // 整格就是一小段纯上下标 TeX（d_{z}）时，按可见形式投影成 dz。
    const strippedCell = output.trim();
    if (strippedCell.length <= 40 && !strippedCell.includes('\\') && /[_^]\{/.test(strippedCell)) {
        output = readerTexPlain(strippedCell);
    }
    // LaTeXML 在正文型单元格里会把「标识符 + 符号」整体重复一遍，例如
    // `r≥r\geq`；只在命令与可见符号确实是同一符号时合并，未知命令保持原样。
    output = output.replace(/([A-Za-z0-9])([≥≤≈≠±×·∼→←↑↓↔])\1\\([A-Za-z]+)/g,
        (whole, head, symbol, command) => (READER_TEX_SYMBOLS[command] === symbol ? `${head}${symbol}` : whole));
    // 同一形态还可能是「符号 + 它自己的命令」，没有重复标识符：`≈\approx`。
    output = output.replace(/([≥≤≈≠±×·∼])\\([A-Za-z]+)/g,
        (whole, symbol, command) => (READER_TEX_SYMBOLS[command] === symbol ? symbol : whole));
    // 渲染侧可能已经先把命令换成符号，留下两个相同关系符：`≈≈`。
    // 同一符号连写没有实际语义，按一个处理，保证与原始 TeX 副本折后一致。
    output = output.replace(/([≥≤≈≠×·∼])\1/g, '$1');

    // 「标签=数值」整体重复（r¯=0.643r̄=0.643）：可见副本与 TeX 副本各写一遍。
    // 只在含 = 的单元格里做，并先把长音符两种写法统一，避免影响裸 \overline 规则。
    if (output.includes('=')) {
        // 上划线可能带下标：\overline{R_{\sigma}} → Rσ̄，先投影再折叠重复。
        output = output.replace(/\u00af/g, '\u0304');
        // 只有正文里已经存在同一个可见副本时才投影，避免把 \overline{ACC} 改写成
        // ACC̄、把 \overline{1-\alpha} 的长音符挂到最后一个字符上。
        output = output.replace(/\\overline\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
            (whole, inner) => {
                const visible = `${readerTexPlain(inner)}\u0304`;
                return output.includes(visible) ? visible : whole;
            });
        output = output.replace(/([^|\n=]{1,12}=[0-9]+(?:\.[0-9]+)?)\1(?![0-9.])/g, '$1');
    }
    // 变量+下标整体重复（T1T_{1} → T1T1 → T1）：可见副本与 TeX 副本各一遍。
    output = output.replace(/([A-Za-z]+)(\d+)\1\2(?![A-Za-z0-9])/g, '$1$2');
    return output;
}

function projectReaderCellTexDisplay(value) {
    let output = String(value ?? '');
    output = output.replace(/(\S*?)\s*11footnotemark:\s*\d+(?![\d.])/g, '$1');
    output = output.replace(/\s*\(\s*\)/g, '');
    if (output.includes('\\anon[')) output = projectReaderAnonMacro(output);
    // LaTeXML 行首空锚点/图标宏残留：[][] VideoLLaMA2-AV+PACD → VideoLLaMA2-AV+PACD。
    // 仅剥离整格开头后跟横向空白与非空可见正文的单个 [][] 前缀；若剥离后经后续投影不剩可见字符则回退保留 [][]。
    const stripped = stripLeadingEmptyReferenceLinkCellPrefix(output);
    if (stripped !== output) {
        const projected = projectReaderCellTexDisplayBody(stripped);
        const stabilized = projected.replace(/\s*\(\s*\)/g, '');
        if (/[^\s\u200b\u200c\u200d\u2060\ufeff]/.test(stabilized)
            && stripLeadingEmptyReferenceLinkCellPrefix(projected) === projected) {
            return projected;
        }
    }
    return projectReaderCellTexDisplayBody(output);
}

function normalizeReaderSourceDisplayArtifacts(value) {
    let output = normalizeExplicitReaderSymbolProjection(value);
    // 只投影完整表格格值：分子、分母的可见副本与显式 {,} 注解须逐字一致。
    // 可选百分比尾注原样保留；裸分数重复、续式和其他 TeX 不据此恢复。
    output = output.replace(/(^|[|\n])([ \t]*)(\d{1,3}(?:,\d{3})*|\d+)\/(\d{1,3}(?:,\d{3})*|\d+)(\d{1,3}(?:\{,\}\d{3})*|\d+)\/(\d{1,3}(?:\{,\}\d{3})*|\d+)(?=[ \t]*(?:\(\d+(?:\.\d+)?%\)[ \t]*)?(?:[|]|$))/g,
        (whole, boundary, space, numerator, denominator, texNumerator, texDenominator) => {
            if (!`${texNumerator}/${texDenominator}`.includes('{,}')
                || numerator !== texNumerator.replaceAll('{,}', ',')
                || denominator !== texDenominator.replaceAll('{,}', ',')) return whole;
            return `${boundary}${space}${numerator}/${denominator}`;
        });
    // 保留数值后的全部脚注字符，只去掉同值同脚注的明确上标副本。
    output = output.replace(/(^|[|\n])([ \t]*)([+−-]?(?:\d+(?:\.\d+)?|\.\d+))([a-zℓ](?:,[a-zℓ])*)([+−-]?(?:\d+(?:\.\d+)?|\.\d+))\^\{((?:[a-z]|\\ell)(?:,(?:[a-z]|\\ell))*)\}(?=[ \t]*(?:[|]|$))/g,
        (whole, boundary, space, visible, notes, tex, texNotes) => visible === tex
            && notes === texNotes.replaceAll('\\ell', 'ℓ') ? `${boundary}${space}${visible}${notes}` : whole);
    output = output.replace(/(^|[|\n])([ \t]*)∼\\sim(?=[ \t]*(?:[|]|$))/g, '$1$2∼');
    // 仅合并同变量、同数值且带明确 TeX {=} 注解的等式副本。
    // 裸重复、不同变量/数值、额外下标或数字尾部不具备此证据。
    output = output.replace(
        /(?<![A-Za-z0-9._])([A-Za-z])\s*=\s*([+−-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\1\s*\{=\}\s*\2(?!\s*[A-Za-z0-9._^\\{%℃°+−*\/=<>-])/g,
        (_whole, variable, value) => `${variable}=${value}`
    );
    // 同一字母标记与整数下标的明确 TeX 副本，如 F0F_{0}。
    output = output.replace(/(?<![A-Za-z0-9_])([A-Za-z]+)(\d+)\1_\{\2\}(?![A-Za-z0-9_])/g, '$1$2');
    // 误差项的可见值与明确 TeX 注解逐字相同时，仅合并显示副本。
    // 保留前导小数点、正负号和尾零；裸数字重复或不一致的误差不在此处理。
    output = output.replace(
        /(?<![A-Za-z0-9.+−-])([+−-]?(?:\d+(?:\.\d+)?|\.\d+))\s*±\s*((?:\d+(?:\.\d+)?|\.\d+))\s*\1\s*\\pm\s*\2(?![A-Za-z0-9.])/g,
        (_whole, mean, uncertainty) => `${mean} ± ${uncertainty}`
    ).replace(
        /(?<![A-Za-z0-9.+−-])([+−-]?(?:\d+(?:\.\d+)?|\.\d+))\s*±\s*((?:\d+(?:\.\d+)?|\.\d+))\s*\\mathbf\{\1\}\s*\\scriptscriptstyle\{\s*\\pm\s*\2\s*\}(?![A-Za-z0-9.])/g,
        (_whole, mean, uncertainty) => `${mean} ± ${uncertainty}`
    );
    // Only an entire cell may carry this literal s/ms suffix. The explicit
    // duplicate is the operator, never either number or the unit; no caption
    // unit is propagated and seconds/milliseconds are never converted.
    output = output.replace(
        /(^|[|\n])([ \t]*)([+−-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+))[ \t]*±[ \t]*\\pm[ \t]*([0-9]+(?:\.[0-9]+)?|\.[0-9]+)([ \t]+)(ms|s)(?=[ \t]*(?:[|\n]|$))/g,
        (_whole, boundary, space, mean, uncertainty, gap, unit) => `${boundary}${space}${mean} ± ${uncertainty}${gap}${unit}`
    );
    // 同一均值/误差之间的可见 ± 与明确 \pm 是同一个运算符的两种显示。
    // 只规范完整数值对；不删数值、不改符号，续尾有下标、幂或未知命令时保留原样。
    output = output.replace(
        /(?<![A-Za-z0-9.+−-])([+−-]?(?:\d+(?:\.\d+)?|\.\d+))\s*±\s*(?:\\pm\s*)?((?:\d+(?:\.\d+)?|\.\d+))/g,
        (whole, mean, uncertainty, offset, input) => {
            if (/^\s*[\p{L}\p{N}._^\\({+−-]/u.test(input.slice(offset + whole.length))) return whole;
            return `${mean} ± ${uncertainty}`;
        }
    );
    // 科学计数也可能同时含可见文字与 TeX 注解。两份系数和指数必须完全一致；
    // 不从裸数字重复、不同符号或近似数值猜测原值。
    output = output.replace(
        /(?<![A-Za-z0-9.+−-])([+−-]?\d+(?:\.\d+)?)×10([−+-]?)(\d+)\1\{\\times\}10\^\{([−+-]?)(\d+)\}(?![A-Za-z0-9.])/g,
        (whole, coefficient, visibleSign, exponent, texSign, texExponent) => {
            const sign = visibleSign.replace('−', '-');
            if (sign !== texSign.replace('−', '-') || exponent !== texExponent) return whole;
            return `\\(${coefficient.replace('−', '-')}\\times10^{${sign}${exponent}}\\)`;
        }
    );
    // LaTeXML 会把同一个置信区间输出两次：一次是可见文字，一次是花括号编码的逗号注解。
    // 保留可见的那个区间，只丢弃端点与它完全重复的注解。
    output = output.replace(
        /(\[\s*([+−-]?\d+(?:\.\d+)?)\s*,\s*([+−-]?\d+(?:\.\d+)?)\s*\])\[\s*([+−-]?\d+(?:\.\d+)?)\{\}\{,\}\s*([+−-]?\d+(?:\.\d+)?)\{\}\s*\]/g,
        (whole, visible, low, high, annotatedLow, annotatedHigh) => (
            low.replaceAll('-', '−') === annotatedLow.replaceAll('-', '−')
                && high.replaceAll('-', '−') === annotatedHigh.replaceAll('-', '−')
                ? visible : whole
        )
    );
    output = output.replace(
        /(?<![\d,/])(\d{1,3}(?:,\d{3})+)(\d{1,3}(?:\{,\}\d{3})+)(?![\d,/])/g,
        (whole, visible, annotation) => annotation.replaceAll('{,}', ',') === visible
            ? visible : whole
    );
    const scalar = '[+−-]?\\d+(?:\\.\\d+)?';
    const repeatedInterval = new RegExp(
        `(?<![A-Za-z0-9])(${scalar})[\\s\\u200b]*\\[\\s*(${scalar})\\s*,\\s*(${scalar})\\s*\\]`
        + `[\\s\\u200b]*(${scalar})\\\\;\\s*\\[\\s*(${scalar})\\s*,\\s*(${scalar})\\s*\\]`, 'g'
    );
    output = output.replace(repeatedInterval, (whole, mean, low, high, texMean, texLow, texHigh) => {
        const same = (left, right) => left.replace('−', '-') === right.replace('−', '-');
        if (!same(mean, texMean) || !same(low, texLow) || !same(high, texHigh)) return whole;
        return `${mean} [${low}, ${high}]`;
    });
    output = output.replace(
        /(?<![A-Za-z0-9])([1-9]\d*)([−+-])(\d+)\1\^\{([−+-])\3\}(?![A-Za-z0-9])/g,
        (whole, base, visibleSign, exponent, texSign) => {
            const sign = visibleSign.replace('−', '-');
            if (sign !== texSign.replace('−', '-')) return whole;
            return `\\(${base}^{${sign}${exponent}}\\)`;
        }
    );
    output = output.replace(
        /l[\u200b\u200c\u200d\u2060\ufeff]*r\s*=\s*([0-9]+(?:\.[0-9]+)?)[\u200b\u200c\u200d\u2060\ufeff]*e[−-](\d+)\s*lr\s*=\s*\1e\^\{[-−]\2\}/gi,
        (_whole, base, exponent) => `lr=${base}e-${exponent}`
    );
    output = collapseParenthesizedSignedDoubleWrite(output);
    return output;
}

module.exports = {
    collapseParenthesizedSignedDoubleWrite,
    normalizeExplicitReaderSymbolProjection,
    normalizeReaderSourceDisplayArtifacts,
    projectReaderCellTexDisplay,
    stripLeadingEmptyReferenceLinkCellPrefix,
};
