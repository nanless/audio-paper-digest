'use strict';

// 仅合并明确TeX注解与完全一致的可见副本；裸重复仍保留并由正式校验阻断。
function normalizeExplicitReaderSymbolProjection(value) {
    let output = String(value ?? '');
    if (!output.includes('\\')) return output;
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
    const canonical = text => text.normalize('NFKC').replace(/[\u200b\u200c\u200d\ufeff]/g, '');
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
    return output.replace(/([↑↓])\\(uparrow|downarrow)(?![A-Za-z])/g,
        (whole, visible, command, offset, input) => {
            if (hasContinuation(input, offset + whole.length)
                || visible !== (command === 'uparrow' ? '↑' : '↓')) return whole;
            return visible;
        })
        .replace(/([+/])\\;\1\\;/g, '$1');
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
        /l[\u200b\u200c\u200d\ufeff]*r\s*=\s*([0-9]+(?:\.[0-9]+)?)[\u200b\u200c\u200d\ufeff]*e[−-](\d+)\s*lr\s*=\s*\1e\^\{[-−]\2\}/gi,
        (_whole, base, exponent) => `lr=${base}e-${exponent}`
    );
    return output;
}

module.exports = { normalizeExplicitReaderSymbolProjection, normalizeReaderSourceDisplayArtifacts };
