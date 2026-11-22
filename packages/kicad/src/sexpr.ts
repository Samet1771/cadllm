// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export type SexprToken =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; raw: string }
  | { kind: 'symbol'; value: string };

export type SexprString = { kind: 'string'; value: string };
export type SexprNumber = { kind: 'number'; value: number };
export type SexprSymbol = { kind: 'symbol'; value: string };
export type SexprAtom = SexprString | SexprNumber | SexprSymbol;
export type SexprList = Sexpr[];
export type Sexpr = SexprAtom | SexprList;

const NUM_RE = /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export const sym = (value: string): SexprSymbol => ({ kind: 'symbol', value });
export const str = (value: string): SexprString => ({ kind: 'string', value });
export const num = (value: number): SexprNumber => ({
  kind: 'number',
  value: Object.is(value, -0) ? 0 : value,
});

export const isList = (node: Sexpr | undefined): node is SexprList => Array.isArray(node);

export function headOf(node: Sexpr | undefined): string | undefined {
  if (!Array.isArray(node) || node.length === 0) return undefined;
  const first = node[0];
  if (!first || Array.isArray(first) || first.kind !== 'symbol') return undefined;
  return first.value;
}

export function atomString(node: Sexpr | undefined): string | undefined {
  if (!node || Array.isArray(node)) return undefined;
  return node.kind === 'number' ? String(node.value) : node.value;
}

export function atomNumber(node: Sexpr | undefined): number | undefined {
  if (!node || Array.isArray(node)) return undefined;
  if (node.kind === 'number') return node.value;
  const trimmed = node.value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : undefined;
}

export function findChild(list: SexprList, tag: string): SexprList | undefined {
  for (let i = 1; i < list.length; i++) {
    const child = list[i];
    if (Array.isArray(child) && headOf(child) === tag) return child;
  }
  return undefined;
}

export function findChildren(list: SexprList, tag: string): SexprList[] {
  const out: SexprList[] = [];
  for (let i = 1; i < list.length; i++) {
    const child = list[i];
    if (Array.isArray(child) && headOf(child) === tag) out.push(child);
  }
  return out;
}

const isWs = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const isDelim = (ch: string): boolean => isWs(ch) || ch === '(' || ch === ')' || ch === '"';

/** Tokenize an S-expression string into parens, strings (with escapes), numbers, and symbols. */
export function tokenizeSexpr(text: string): SexprToken[] {
  const tokens: SexprToken[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i]!;
    if (isWs(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      let val = '';
      let closed = false;
      while (i < n) {
        const c = text[i]!;
        if (c === '"') {
          i++;
          closed = true;
          break;
        }
        if (c === '\\') {
          i++;
          if (i >= n) throw new Error('Unterminated string escape in S-expression');
          const esc = text[i]!;
          if (esc === 'n') val += '\n';
          else if (esc === 'r') val += '\r';
          else if (esc === 't') val += '\t';
          else if (esc === '"') val += '"';
          else if (esc === '\\') val += '\\';
          else val += esc;
          i++;
        } else {
          val += c;
          i++;
        }
      }
      if (!closed) throw new Error('Unterminated string in S-expression');
      tokens.push({ kind: 'string', value: val });
      continue;
    }

    const start = i;
    while (i < n && !isDelim(text[i]!)) i++;
    const raw = text.slice(start, i);
    if (NUM_RE.test(raw)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        tokens.push({ kind: 'number', value: Object.is(parsed, -0) ? 0 : parsed, raw });
        continue;
      }
    }
    tokens.push({ kind: 'symbol', value: raw });
  }

  return tokens;
}

function readExpr(tokens: SexprToken[], state: { pos: number }): Sexpr {
  const tok = tokens[state.pos++];
  if (!tok) throw new Error('Unexpected end of S-expression');
  if (tok.kind === 'rparen') throw new Error('Unexpected ")" in S-expression');
  if (tok.kind === 'lparen') {
    const list: SexprList = [];
    while (state.pos < tokens.length) {
      if (tokens[state.pos]!.kind === 'rparen') {
        state.pos++;
        return list;
      }
      list.push(readExpr(tokens, state));
    }
    throw new Error('Unclosed "(" in S-expression');
  }
  if (tok.kind === 'string') return { kind: 'string', value: tok.value };
  if (tok.kind === 'number') return { kind: 'number', value: tok.value };
  return { kind: 'symbol', value: tok.value };
}

/** Parse a token stream into a single root S-expression. */
export function parseSexprTokens(tokens: SexprToken[]): Sexpr {
  if (tokens.length === 0) throw new Error('Empty S-expression');
  const state = { pos: 0 };
  const expr = readExpr(tokens, state);
  if (state.pos < tokens.length) throw new Error('Trailing tokens after S-expression');
  return expr;
}

/** Parse an S-expression string into a single root AST node. */
export function parseSexpr(text: string): Sexpr {
  return parseSexprTokens(tokenizeSexpr(text));
}

/** Parse an S-expression string containing one or more top-level expressions. */
export function parseSexprAll(text: string): Sexpr[] {
  const tokens = tokenizeSexpr(text);
  const state = { pos: 0 };
  const out: Sexpr[] = [];
  while (state.pos < tokens.length) out.push(readExpr(tokens, state));
  return out;
}

function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  return out + '"';
}

function formatPretty(node: Sexpr, depth: number): string {
  if (!Array.isArray(node)) return printSexpr(node);
  if (node.length === 0) return '()';
  const hasSublist = node.some(Array.isArray);
  if (!hasSublist) {
    return '(' + node.map(c => printSexpr(c)).join(' ') + ')';
  }
  const pad = '  '.repeat(depth);
  const childPad = '  '.repeat(depth + 1);
  const headAtoms: string[] = [];
  let idx = 0;
  while (idx < node.length && !Array.isArray(node[idx])) {
    headAtoms.push(printSexpr(node[idx]!));
    idx++;
  }
  const lines: string[] = [`(${headAtoms.join(' ')}`];
  for (; idx < node.length; idx++) {
    const child = node[idx]!;
    if (Array.isArray(child)) {
      lines.push(`${childPad}${formatPretty(child, depth + 1)}`);
    } else {
      lines.push(`${childPad}${printSexpr(child)}`);
    }
  }
  lines.push(`${pad})`);
  return lines.join('\n');
}

/** Print an S-expression AST back to text. */
export function printSexpr(node: Sexpr, opts?: { pretty?: boolean }): string {
  if (opts?.pretty) return formatPretty(node, 0);
  if (!Array.isArray(node)) {
    if (node.kind === 'string') return escapeString(node.value);
    if (node.kind === 'number') return String(Object.is(node.value, -0) ? 0 : node.value);
    return node.value;
  }
  return '(' + node.map(c => printSexpr(c)).join(' ') + ')';
}
