// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError } from '@cadllm/core';

export interface Token {
  text: string;
  quoted: boolean;
  /** Index of first '=' outside quotes, or -1 if none. */
  eqIndex: number;
}

export interface LineStatements {
  line: number;
  indent: number;
  statements: Token[][];
}

/**
 * Lex a single line into `;`-separated statements, respecting `#` comments and `"..."` quotes.
 * Pushes a CadError into `errors` on unterminated strings.
 */
export function tokenizeLine(raw: string, lineNum: number, errors: CadError[]): LineStatements {
  const indentMatch = raw.match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0].length : 0;
  const statements: Token[][] = [];
  let tokens: Token[] = [];
  let buf = '';
  let inToken = false;
  let hasQuotes = false;
  let eqIndex = -1;
  let inQuote = false;

  const flushToken = () => {
    if (!inToken) return;
    tokens.push({ text: buf, quoted: hasQuotes, eqIndex });
    buf = '';
    inToken = false;
    hasQuotes = false;
    eqIndex = -1;
  };

  const flushStmt = () => {
    flushToken();
    if (tokens.length > 0) {
      statements.push(tokens);
      tokens = [];
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuote) {
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1]!;
        if (next === '"' || next === '\\') { buf += next; i += 1; continue; }
        if (next === 'n') { buf += '\n'; i += 1; continue; }
        if (next === 't') { buf += '\t'; i += 1; continue; }
      }
      if (ch === '"') {
        inQuote = false;
        continue;
      }
      buf += ch;
      continue;
    }

    if (ch === '#') break;
    if (ch === ';') { flushStmt(); continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flushToken(); continue; }
    if (ch === '"') {
      inToken = true;
      hasQuotes = true;
      inQuote = true;
      continue;
    }
    if (!inToken) inToken = true;
    if (ch === '=' && eqIndex === -1) eqIndex = buf.length;
    buf += ch;
  }

  if (inQuote) {
    errors.push(new CadError('invalid', `line ${lineNum}: unterminated quoted string`));
    return { line: lineNum, indent, statements: [] };
  }

  flushStmt();
  return { line: lineNum, indent, statements };
}

/** Quote a CNL value if it is empty or contains characters that would alter tokenization. */
export function quoteValue(value: string, extraForbidden?: RegExp): string {
  if (
    value === '' ||
    /[\s;#"\n\t\\]/.test(value) ||
    (extraForbidden && extraForbidden.test(value))
  ) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }
  return value;
}
