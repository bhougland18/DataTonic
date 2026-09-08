// Regex Studio — deterministic RE2 token explainer.
//
// Parses a (valid) RE2 pattern into a nested, human-readable tree rendered as
// the RegexStudio-style cards. Offline and instant; the AI "Explain with AI"
// one-shot is a complement, not a replacement. Only called on patterns re2js
// has accepted, so exotic/invalid constructs need not be handled defensively.

export type ExplainKind = 'group' | 'token' | 'quant' | 'anchor' | 'class' | 'literal' | 'alt';

export interface ExplainNode {
    sym: string;
    title: string;
    desc: string;
    kind: ExplainKind;
    children?: ExplainNode[];
}

const ESCAPES: Record<string, { title: string; desc: string; kind: ExplainKind }> = {
    d: { title: 'Digit', desc: 'Matches a single digit 0–9.', kind: 'class' },
    D: { title: 'Not a digit', desc: 'Matches any character that is not a digit.', kind: 'class' },
    w: { title: 'Word character', desc: 'Matches a letter, digit, or underscore.', kind: 'class' },
    W: { title: 'Non-word character', desc: 'Matches anything except a letter, digit, or underscore.', kind: 'class' },
    s: { title: 'Whitespace', desc: 'Matches a space, tab, or newline.', kind: 'class' },
    S: { title: 'Non-whitespace', desc: 'Matches any character that is not whitespace.', kind: 'class' },
    b: { title: 'Word boundary', desc: 'Matches the position between a word and a non-word character.', kind: 'anchor' },
    B: { title: 'Not a word boundary', desc: 'Matches any position that is not a word boundary.', kind: 'anchor' },
    A: { title: 'Start of text', desc: 'Matches only at the very start of the input.', kind: 'anchor' },
    z: { title: 'End of text', desc: 'Matches only at the very end of the input.', kind: 'anchor' },
    n: { title: 'Newline', desc: 'Matches a line-feed character.', kind: 'token' },
    t: { title: 'Tab', desc: 'Matches a tab character.', kind: 'token' },
    r: { title: 'Carriage return', desc: 'Matches a carriage-return character.', kind: 'token' },
};

export function explain(pattern: string): ExplainNode[] {
    let i = 0;
    let groupNo = 0;

    const quantDesc = (q: string): string => {
        const lazy = q.endsWith('?') && q.length > 1;
        const core = lazy ? q.slice(0, -1) : q;
        let base: string;
        if (core === '*') base = 'Match the preceding token zero or more times.';
        else if (core === '+') base = 'Match the preceding token one or more times.';
        else if (core === '?') base = 'Match the preceding token zero or one time (optional).';
        else {
            const m = core.match(/^\{(\d+)(,)?(\d+)?\}$/);
            if (m) {
                const [, a, comma, b] = m;
                if (comma && b) base = `Match the preceding token between ${a} and ${b} times.`;
                else if (comma) base = `Match the preceding token at least ${a} times.`;
                else base = `Match the preceding token exactly ${a} time${a === '1' ? '' : 's'}.`;
            } else base = 'Quantifier.';
        }
        return lazy ? `${base} (lazy — as few as possible)` : base;
    };

    // Consume a quantifier at i (if any) and return its symbol, else null.
    const takeQuant = (): string | null => {
        const c = pattern[i];
        if (c === '*' || c === '+' || c === '?') {
            i++;
            let q = c;
            if (pattern[i] === '?') {
                q += '?';
                i++;
            }
            return q;
        }
        if (c === '{') {
            const close = pattern.indexOf('}', i);
            if (close > i && /^\{\d+(,\d*)?\}$/.test(pattern.slice(i, close + 1))) {
                let q = pattern.slice(i, close + 1);
                i = close + 1;
                if (pattern[i] === '?') {
                    q += '?';
                    i++;
                }
                return q;
            }
        }
        return null;
    };

    const parseClass = (): ExplainNode => {
        const start = i;
        i++; // [
        if (pattern[i] === '^') i++;
        if (pattern[i] === ']') i++; // literal ] as first member
        while (i < pattern.length && pattern[i] !== ']') {
            if (pattern[i] === '\\') i++;
            i++;
        }
        if (pattern[i] === ']') i++;
        const sym = pattern.slice(start, i);
        const negated = sym.startsWith('[^');
        return {
            sym,
            title: negated ? 'Negated character set' : 'Character set',
            desc: negated
                ? 'Matches any single character NOT listed in the set.'
                : 'Matches any single character listed in the set.',
            kind: 'class',
        };
    };

    const parseEscape = (): ExplainNode => {
        i++; // backslash
        const ch = pattern[i] ?? '';
        i++;
        const known = ESCAPES[ch];
        if (known) return { sym: `\\${ch}`, ...known };
        return {
            sym: `\\${ch}`,
            title: 'Escaped character',
            desc: `Matches the literal character "${ch}".`,
            kind: 'literal',
        };
    };

    const parseGroup = (): ExplainNode => {
        i++; // (
        let title = 'Capturing group';
        let capturing = true;
        let extra = '';
        if (pattern[i] === '?') {
            if (pattern[i + 1] === ':') {
                i += 2;
                title = 'Non-capturing group';
                capturing = false;
            } else if (pattern[i + 1] === 'P' && pattern[i + 2] === '<') {
                const close = pattern.indexOf('>', i);
                extra = pattern.slice(i + 3, close);
                i = close + 1;
                title = `Named group «${extra}»`;
            } else if (pattern[i + 1] === '<') {
                const close = pattern.indexOf('>', i);
                extra = pattern.slice(i + 2, close);
                i = close + 1;
                title = `Named group «${extra}»`;
            } else {
                // inline flags, e.g. (?i) or (?i:...)
                let j = i + 1;
                while (j < pattern.length && pattern[j] !== ':' && pattern[j] !== ')') j++;
                const flags = pattern.slice(i + 1, j);
                if (pattern[j] === ')') {
                    i = j + 1;
                    return {
                        sym: `(?${flags})`,
                        title: 'Inline flags',
                        desc: flagDesc(flags),
                        kind: 'token',
                    };
                }
                i = j + 1; // consume flags and ':'
                title = `Group with flags (${flags})`;
                capturing = false;
            }
        }
        let num = 0;
        if (capturing && title === 'Capturing group') {
            groupNo++;
            num = groupNo;
        }
        const children = parseSeq(true);
        if (pattern[i] === ')') i++;
        return {
            sym: '( … )',
            title: num ? `Capturing group #${num}` : title,
            desc: num
                ? `Groups the tokens below and captures the match for backref \\${num}.`
                : 'Groups the tokens below.',
            kind: 'group',
            children,
        };
    };

    function parseSeq(insideGroup: boolean): ExplainNode[] {
        const out: ExplainNode[] = [];
        while (i < pattern.length) {
            const c = pattern[i];
            if (c === ')' && insideGroup) break;
            let atom: ExplainNode;
            if (c === '(') atom = parseGroup();
            else if (c === '[') atom = parseClass();
            else if (c === '\\') atom = parseEscape();
            else if (c === '^') {
                i++;
                atom = { sym: '^', title: 'Start anchor', desc: 'Matches the start of the string (or line in multiline mode).', kind: 'anchor' };
            } else if (c === '$') {
                i++;
                atom = { sym: '$', title: 'End anchor', desc: 'Matches the end of the string (or line in multiline mode).', kind: 'anchor' };
            } else if (c === '.') {
                i++;
                atom = { sym: '.', title: 'Any character', desc: 'Matches any character except a newline.', kind: 'token' };
            } else if (c === '|') {
                i++;
                out.push({ sym: '|', title: 'Alternation', desc: 'Match the expression before OR after the bar.', kind: 'alt' });
                continue;
            } else {
                i++;
                atom = { sym: c, title: 'Literal', desc: `Matches the character "${c}".`, kind: 'literal' };
            }
            out.push(atom);
            const q = takeQuant();
            if (q) out.push({ sym: q, title: 'Quantifier', desc: quantDesc(q), kind: 'quant' });
        }
        return out;
    }

    return parseSeq(false);
}

function flagDesc(flags: string): string {
    const map: Record<string, string> = {
        i: 'case-insensitive',
        m: 'multiline (^ and $ match line boundaries)',
        s: 'dot matches newline',
        U: 'ungreedy',
    };
    const parts = flags
        .split('')
        .map(f => map[f])
        .filter(Boolean);
    return parts.length ? `Enables ${parts.join(', ')} for the rest of the pattern.` : 'Sets matching flags.';
}
