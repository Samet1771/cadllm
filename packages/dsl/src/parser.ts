// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, CadErrors, parseSI } from '@cadllm/core';
import type {
  CnlCircuitStmt,
  CnlDoc,
  CnlEditStmt,
  CnlSectionPlace,
  CompareOp,
  ExpectCompare,
  ExpectMeasure,
  ExpectRange,
  ExpectTable,
  SectionName,
  TestBlock,
} from './ast.ts';
import { tokenizeLine, type Token } from './lexer.ts';

const SECTIONS: Record<string, SectionName> = {
  circuit: 'circuit',
  breadboard: 'breadboard',
  schematic: 'schematic',
  pcb: 'pcb',
  tests: 'tests',
};

const PLACE_SECTION_VIEW: Record<'breadboard' | 'schematic' | 'pcb', string> = {
  breadboard: 'bb',
  schematic: 'sch',
  pcb: 'pcb',
};

const ANALYSIS_KINDS = new Set(['logic', 'dc', 'op', 'tran', 'ac', 'run']);
const MEASURES = new Set<ExpectMeasure>(['min', 'max', 'avg', 'final', 'rms', 'freq', 'period', 'duty', 'rise', 'fall']);
const CODE_SECTION_END_RE = /^\[(circuit|breadboard|schematic|pcb|tests|code\s+\S+)\]\s*$/;

const errAt = (line: number, message: string, hint?: string) =>
  new CadError('invalid', `line ${line}: ${message}`, hint);

/** Parse `@view:pos` tokens (with optional trailing unquoted tokens like `top` in `@pcb:12.7,8.0,90 top`). */
function parsePlaceTokens(
  tokens: Token[],
  startIdx: number,
  line: number,
  errors: CadError[],
  allowEmpty: boolean,
): Record<string, string | null> | undefined {
  const place: Record<string, string | null> = {};
  let i = startIdx;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok.quoted || !tok.text.startsWith('@')) {
      errors.push(errAt(line, `unexpected token "${tok.text}"`, 'expected @view:pos'));
      return undefined;
    }
    const colon = tok.text.indexOf(':');
    if (colon <= 1) {
      errors.push(errAt(line, `bad placement "${tok.text}"`, 'use @view:pos, e.g. @bb:E10 or @sch:40,20'));
      return undefined;
    }
    const view = tok.text.slice(1, colon);
    const parts: string[] = [];
    const first = tok.text.slice(colon + 1);
    if (first !== '') parts.push(first);
    i += 1;
    while (i < tokens.length) {
      const next = tokens[i]!;
      if (!next.quoted && (next.text.startsWith('@') || next.eqIndex >= 0)) break;
      parts.push(next.text);
      i += 1;
    }
    const pos = parts.join(' ');
    if (pos === '') {
      if (!allowEmpty) {
        errors.push(errAt(line, `missing position in "${tok.text}"`, 'use @view:pos, e.g. @bb:E10'));
        return undefined;
      }
      place[view] = null;
    } else {
      place[view] = pos;
    }
  }
  return place;
}

function parseMetaArgs(tokens: Token[], startIdx: number, line: number, errors: CadError[]): Record<string, string | null> | undefined {
  if (startIdx >= tokens.length) {
    errors.push(errAt(line, 'meta requires at least one key=value'));
    return undefined;
  }
  const entries: Record<string, string | null> = {};
  for (let i = startIdx; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.eqIndex <= 0) {
      errors.push(errAt(line, `bad meta entry "${tok.text}"`, 'use key=value'));
      return undefined;
    }
    const k = tok.text.slice(0, tok.eqIndex);
    const v = tok.text.slice(tok.eqIndex + 1);
    entries[k] = v === '' && !tok.quoted ? null : v;
  }
  return entries;
}

/** Parse a single statement inside `[circuit]` or an `edit` batch. */
export function parseEditStatement(tokens: Token[], line: number, allowEdit: boolean, errors: CadError[]): CnlEditStmt | undefined {
  const first = tokens[0]!;
  const t0 = first.text;

  // `meta k=v …`
  if (!first.quoted && t0 === 'meta') {
    const entries = parseMetaArgs(tokens, 1, line, errors);
    return entries ? { kind: 'meta', line, entries } : undefined;
  }

  // `mv A B`
  if (!first.quoted && t0 === 'mv') {
    if (!allowEdit) {
      errors.push(errAt(line, 'mv is only allowed in edit batches'));
      return undefined;
    }
    if (tokens.length !== 3) {
      errors.push(errAt(line, 'mv requires two arguments', 'usage: mv <from> <to>'));
      return undefined;
    }
    return { kind: 'move', line, from: tokens[1]!.text, to: tokens[2]!.text };
  }

  // `-NET: pins` or `-NAME`
  if (!first.quoted && t0.startsWith('-')) {
    if (!allowEdit) {
      errors.push(errAt(line, `remove/disconnect "${t0}" is only allowed in edit batches`));
      return undefined;
    }
    const colon = t0.indexOf(':');
    if (colon >= 0) {
      const net = t0.slice(1, colon);
      if (!net) {
        errors.push(errAt(line, `missing net name in "${t0}"`));
        return undefined;
      }
      const after = t0.slice(colon + 1);
      const pins = [...(after ? [after] : []), ...tokens.slice(1).map(t => t.text)];
      if (pins.length === 0) {
        errors.push(errAt(line, `-${net}: requires at least one pin`));
        return undefined;
      }
      return { kind: 'disconnect', line, net, pins };
    }
    const target = t0.slice(1);
    if (!target) {
      errors.push(errAt(line, 'missing component or net name after "-"'));
      return undefined;
    }
    if (tokens.length > 1) {
      errors.push(errAt(line, `unexpected token "${tokens[1]!.text}" after "${t0}"`));
      return undefined;
    }
    return { kind: 'remove', line, target };
  }

  // `~REF k=v …`
  if (!first.quoted && t0.startsWith('~')) {
    if (!allowEdit) {
      errors.push(errAt(line, `patch "${t0}" is only allowed in edit batches`));
      return undefined;
    }
    const ref = t0.slice(1);
    if (!ref) {
      errors.push(errAt(line, 'missing component ref after "~"'));
      return undefined;
    }
    if (tokens.length < 2) {
      errors.push(errAt(line, `${t0} requires at least one key=val or @view:pos`));
      return undefined;
    }
    const props: Record<string, string | null> = {};
    let place: Record<string, string | null> = {};
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (!tok.quoted && tok.text.startsWith('@')) {
        const parsedPlace = parsePlaceTokens(tokens, i, line, errors, true);
        if (!parsedPlace) return undefined;
        place = { ...place, ...parsedPlace };
        break;
      }
      if (tok.eqIndex <= 0) {
        errors.push(errAt(line, `bad patch token "${tok.text}"`, 'use key=value (or key= to delete) or @view:pos'));
        return undefined;
      }
      const k = tok.text.slice(0, tok.eqIndex);
      const v = tok.text.slice(tok.eqIndex + 1);
      props[k] = v === '' && !tok.quoted ? null : v;
    }
    return { kind: 'patch', line, ref, props, place };
  }

  // Net line: `NET: pin …` or `NET:pin …`
  if (!first.quoted && t0.includes(':')) {
    const colon = t0.indexOf(':');
    const name = t0.slice(0, colon);
    if (!name) {
      errors.push(errAt(line, `missing net name before ":" in "${t0}"`));
      return undefined;
    }
    const after = t0.slice(colon + 1);
    const pins = [...(after ? [after] : []), ...tokens.slice(1).map(t => t.text)];
    if (pins.length === 0) {
      errors.push(errAt(line, `net ${name}: requires at least one pin`));
      return undefined;
    }
    return { kind: 'net', line, name, pins };
  }

  // Placement-only line: `REF @view:pos …`
  if (tokens.length >= 2 && !tokens[1]!.quoted && tokens[1]!.text.startsWith('@')) {
    const place = parsePlaceTokens(tokens, 1, line, errors, false);
    if (!place) return undefined;
    return { kind: 'place', line, ref: t0, place };
  }

  // Component line: `REF PART [value] [key=val …] [@view:pos …]`
  if (tokens.length < 2) {
    errors.push(errAt(line, `incomplete statement "${t0}"`, 'expected "<ref> <part> [value]" or "<NET>: <pin> …"'));
    return undefined;
  }
  const partTok = tokens[1]!;
  if (!partTok.quoted && (partTok.eqIndex >= 0 || partTok.text.startsWith('@'))) {
    errors.push(errAt(line, `expected part id after "${t0}", got "${partTok.text}"`));
    return undefined;
  }

  let value: string | undefined;
  const props: Record<string, string | null> = {};
  let place: Record<string, string | null> = {};
  let seenPropOrValue = false;

  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.quoted && tok.text.startsWith('@')) {
      const parsedPlace = parsePlaceTokens(tokens, i, line, errors, false);
      if (!parsedPlace) return undefined;
      place = { ...place, ...parsedPlace };
      break;
    }
    if (tok.eqIndex > 0) {
      const k = tok.text.slice(0, tok.eqIndex);
      const v = tok.text.slice(tok.eqIndex + 1);
      props[k] = v === '' && !tok.quoted ? null : v;
      seenPropOrValue = true;
      continue;
    }
    if (tok.eqIndex === 0) {
      errors.push(errAt(line, `missing property name in "${tok.text}"`));
      return undefined;
    }
    if (!seenPropOrValue && value === undefined) {
      value = tok.text;
      seenPropOrValue = true;
      continue;
    }
    errors.push(errAt(line, `unexpected positional token "${tok.text}"`, 'use key=value for extra props'));
    return undefined;
  }

  return {
    kind: 'component',
    line,
    ref: t0,
    part: partTok.text,
    ...(value !== undefined ? { value } : {}),
    props,
    place,
  };
}

function parsePlacementSectionLine(tokens: Token[], line: number, section: 'breadboard' | 'schematic' | 'pcb', errors: CadError[]): CnlSectionPlace | undefined {
  if (tokens.length < 2) {
    errors.push(errAt(line, `expected "<ref> @<pos>" in [${section}]`));
    return undefined;
  }
  const ref = tokens[0]!.text;
  const second = tokens[1]!;
  if (second.quoted || !second.text.startsWith('@')) {
    errors.push(errAt(line, `expected "@<pos>" after "${ref}" in [${section}]`));
    return undefined;
  }
  let firstPos = second.text.slice(1);
  const viewKey = PLACE_SECTION_VIEW[section];
  const colon = firstPos.indexOf(':');
  if (colon > 0) {
    const prefix = firstPos.slice(0, colon);
    if (prefix === viewKey || prefix === section) {
      firstPos = firstPos.slice(colon + 1);
    } else if (prefix === 'bb' || prefix === 'sch' || prefix === 'pcb') {
      errors.push(errAt(line, `view "@${prefix}:" does not belong in [${section}]`));
      return undefined;
    }
  }
  const posParts = [...(firstPos !== '' ? [firstPos] : []), ...tokens.slice(2).map(t => t.text)];
  const pos = posParts.join(' ');
  if (pos === '') {
    errors.push(errAt(line, `missing position for ${ref} in [${section}]`));
    return undefined;
  }
  return { line, ref, pos };
}

function parseExpectSubject(
  rawSubject: string,
  line: number,
  errors: CadError[],
): { probe: string; measure?: ExpectMeasure; at?: number } | undefined {
  const atIdx = rawSubject.indexOf('@');
  if (atIdx >= 0) {
    const base = rawSubject.slice(0, atIdx).trim();
    const tRaw = rawSubject.slice(atIdx + 1).trim();
    if (!base || !tRaw) {
      errors.push(errAt(line, `bad probe@time "${rawSubject}"`, 'use e.g. V(LA)@1.5s or D13@0.75s'));
      return undefined;
    }
    if (/^[A-Za-z]+\(/.test(base) && !/^[VI]\(/i.test(base)) {
      errors.push(errAt(line, `cannot combine measure with @time in "${rawSubject}"`));
      return undefined;
    }
    const at = parseSI(tRaw);
    if (at === undefined || !Number.isFinite(at) || at < 0) {
      errors.push(errAt(line, `invalid time "${tRaw}" in "${rawSubject}"`));
      return undefined;
    }
    return { probe: base, measure: 'at', at };
  }

  const fnMatch = rawSubject.match(/^([A-Za-z]+)\((.+)\)$/);
  if (fnMatch) {
    const fn = fnMatch[1]!.toLowerCase();
    const inner = fnMatch[2]!.trim();
    if (fn === 'v' || fn === 'i') return { probe: rawSubject };
    if (MEASURES.has(fn as ExpectMeasure)) {
      if (!inner) {
        errors.push(errAt(line, `missing probe in "${rawSubject}"`));
        return undefined;
      }
      return { probe: inner, measure: fn as ExpectMeasure };
    }
    errors.push(errAt(line, `unknown measure "${fnMatch[1]}"`, 'measures: min max avg final rms freq period duty rise fall, or probe@time'));
    return undefined;
  }

  return { probe: rawSubject };
}

function parseExpectLine(tokens: Token[], line: number, errors: CadError[]): ExpectCompare | ExpectRange | undefined {
  const rest = tokens.slice(1).map(t => t.text).join(' ').trim();
  if (!rest) {
    errors.push(errAt(line, 'expect requires an assertion or "table"'));
    return undefined;
  }

  const rangeMatch = rest.match(/^(\S+)\s+(\S+)\.\.(\S+)$/);
  if (rangeMatch) {
    const [, subject, minRaw, maxRaw] = rangeMatch as [string, string, string, string];
    const subj = parseExpectSubject(subject, line, errors);
    if (!subj) return undefined;
    const min = parseSI(minRaw);
    const max = parseSI(maxRaw);
    if (min === undefined) {
      errors.push(errAt(line, `invalid SI value "${minRaw}" in range`));
      return undefined;
    }
    if (max === undefined) {
      errors.push(errAt(line, `invalid SI value "${maxRaw}" in range`));
      return undefined;
    }
    if (min > max) {
      errors.push(errAt(line, `range min "${minRaw}" exceeds max "${maxRaw}"`));
      return undefined;
    }
    return {
      kind: 'range',
      probe: subj.probe,
      ...(subj.measure !== undefined ? { measure: subj.measure } : {}),
      ...(subj.at !== undefined ? { at: subj.at } : {}),
      min,
      max,
      minRaw,
      maxRaw,
      line,
    };
  }

  const cmpMatch = rest.match(/^(\S+?)\s*(<=|>=|<|>|=)\s*(\S+)$/);
  if (cmpMatch) {
    const [, subject, op, raw] = cmpMatch as [string, string, CompareOp, string];
    const subj = parseExpectSubject(subject, line, errors);
    if (!subj) return undefined;
    const value = parseSI(raw);
    if (value === undefined) {
      errors.push(errAt(line, `invalid SI value "${raw}" in expect`));
      return undefined;
    }
    return {
      kind: 'compare',
      probe: subj.probe,
      ...(subj.measure !== undefined ? { measure: subj.measure } : {}),
      ...(subj.at !== undefined ? { at: subj.at } : {}),
      op,
      value,
      raw,
      line,
    };
  }

  errors.push(errAt(line, `cannot parse expect "${rest}"`, 'use "expect V(LA) > 1.8", "expect I(D1) 8m..15m", or "expect table"'));
  return undefined;
}

function parseTestsLines(rawLines: { line: number; text: string }[], errors: CadError[]): { tests: TestBlock[]; testsText?: string } {
  const tests: TestBlock[] = [];
  let currentTest: TestBlock | undefined;
  let currentTable: { node: ExpectTable; indent: number } | undefined;

  const closeTable = () => {
    if (currentTable && currentTable.node.rows.length === 0) {
      errors.push(errAt(currentTable.node.line, 'expect table has no rows'));
    }
    currentTable = undefined;
  };

  for (const { line, text } of rawLines) {
    const lexed = tokenizeLine(text, line, errors);
    for (const tokens of lexed.statements) {
      const head = tokens[0]!;
      const isDirective = !head.quoted && (head.text === 'test' || head.text === 'expect' || ANALYSIS_KINDS.has(head.text));
      const hasArrow = tokens.some(t => !t.quoted && t.text === '->');

      if (currentTable && !isDirective && (lexed.indent > currentTable.indent || hasArrow)) {
        const arrowIdx = tokens.findIndex(t => !t.quoted && t.text === '->');
        if (arrowIdx <= 0 || arrowIdx === tokens.length - 1) {
          errors.push(errAt(line, 'bad expect table row', 'use "<inputs> -> <outputs>", e.g. "0 1 -> 1"'));
          continue;
        }
        currentTable.node.rows.push({
          inputs: tokens.slice(0, arrowIdx).map(t => t.text),
          outputs: tokens.slice(arrowIdx + 1).map(t => t.text),
          line,
        });
        continue;
      }

      closeTable();

      if (!head.quoted && head.text === 'test') {
        if (tokens.length !== 2) {
          errors.push(errAt(line, 'test requires a single name', 'usage: test "name"'));
          currentTest = undefined;
          continue;
        }
        currentTest = { name: tokens[1]!.text, line, expects: [] };
        tests.push(currentTest);
        continue;
      }

      if (!currentTest) {
        errors.push(errAt(line, `statement "${head.text}" outside any test block`, 'start with test "name"'));
        continue;
      }

      if (!head.quoted && head.text === 'expect') {
        if (tokens.length === 2 && !tokens[1]!.quoted && tokens[1]!.text === 'table') {
          const table: ExpectTable = { kind: 'table', rows: [], line };
          currentTest.expects.push(table);
          currentTable = { node: table, indent: lexed.indent };
          continue;
        }
        const exp = parseExpectLine(tokens, line, errors);
        if (exp) currentTest.expects.push(exp);
        continue;
      }

      if (!head.quoted && ANALYSIS_KINDS.has(head.text)) {
        if (currentTest.analysis) {
          errors.push(errAt(line, `duplicate analysis line in test "${currentTest.name}"`));
          continue;
        }
        const args: Record<string, string> = {};
        const positional: string[] = [];
        for (let i = 1; i < tokens.length; i++) {
          const tok = tokens[i]!;
          if (tok.eqIndex > 0) {
            args[tok.text.slice(0, tok.eqIndex)] = tok.text.slice(tok.eqIndex + 1);
          } else {
            positional.push(tok.text);
          }
        }
        currentTest.analysis = { kind: head.text, args, positional, line };
        continue;
      }

      errors.push(errAt(line, `unknown test directive "${head.text}"`, 'expected logic, dc, op, tran, ac, run, or expect'));
    }
  }

  closeTable();

  const bodyLines = rawLines.map(r => r.text);
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === '') bodyLines.pop();
  const testsText = bodyLines.length > 0 ? bodyLines.join('\n') : undefined;
  return { tests, ...(testsText !== undefined ? { testsText } : {}) };
}

/** Parse a full `.cnl` document (header, meta, sections). Syntax only; throws CadErrors with line numbers. */
export function parseCnl(text: string): CnlDoc {
  const lines = text.split(/\r?\n/);
  const errors: CadError[] = [];
  const doc: CnlDoc = {
    version: 1,
    meta: {},
    circuit: [],
    breadboard: [],
    schematic: [],
    pcb: [],
    tests: [],
    code: {},
  };

  let seenHeader = false;
  let section: SectionName | undefined;
  let currentCodeRef: string | undefined;
  const codeBuffers = new Map<string, string[]>();
  const testRawLines: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (section === 'code' && currentCodeRef !== undefined) {
      if (!CODE_SECTION_END_RE.test(trimmed)) {
        codeBuffers.get(currentCodeRef)!.push(raw);
        continue;
      }
      currentCodeRef = undefined;
    }

    // Check `[code <ref>]` before generic `[name]` section header.
    const codeSecMatch = trimmed.match(/^\[code\s+(\S+)\](?:\s*#.*)?$/);
    if (codeSecMatch) {
      if (!seenHeader) {
        errors.push(errAt(1, 'missing "cnl 1" header'));
        seenHeader = true;
      }
      const ref = codeSecMatch[1]!;
      const dup = [...codeBuffers.keys()].some(k => k.toUpperCase() === ref.toUpperCase());
      if (dup) {
        errors.push(errAt(lineNum, `duplicate [code ${ref}] section`));
      } else {
        codeBuffers.set(ref, []);
      }
      section = 'code';
      currentCodeRef = dup ? undefined : ref;
      continue;
    }

    // Check section header `[name]` before section-specific handling so `[tests]` terminates cleanly.
    const secMatch = trimmed.match(/^\[([A-Za-z0-9_-]+)\](?:\s*#.*)?$/);
    if (secMatch) {
      if (!seenHeader) {
        errors.push(errAt(1, 'missing "cnl 1" header'));
        seenHeader = true;
      }
      const name = secMatch[1]!.toLowerCase();
      const mapped = SECTIONS[name];
      if (!mapped) {
        errors.push(errAt(lineNum, `unknown section [${secMatch[1]}]`, 'valid: [circuit] [breadboard] [schematic] [pcb] [code <ref>] [tests]'));
        section = undefined;
      } else {
        section = mapped;
      }
      continue;
    }

    if (section === 'tests') {
      testRawLines.push({ line: lineNum, text: raw });
      continue;
    }

    const lexed = tokenizeLine(raw, lineNum, errors);
    for (const tokens of lexed.statements) {
      const head = tokens[0]!;
      if (!seenHeader) {
        seenHeader = true;
        if (head.quoted || head.text !== 'cnl' || tokens.length !== 2 || tokens[1]!.text !== '1') {
          errors.push(errAt(lineNum, 'expected "cnl 1" header'));
        }
        continue;
      }

      if (!section) {
        if (!head.quoted && head.text === 'cnl') {
          errors.push(errAt(lineNum, 'duplicate "cnl" header'));
          continue;
        }
        if (!head.quoted && head.text === 'meta') {
          const entries = parseMetaArgs(tokens, 1, lineNum, errors);
          if (entries) {
            for (const [k, v] of Object.entries(entries)) {
              if (k.startsWith('__')) {
                errors.push(errAt(lineNum, `reserved meta key "${k}"`, 'keys starting with "__" are reserved for internal use'));
                continue;
              }
              if (v === null) delete doc.meta[k]; else doc.meta[k] = v;
            }
          }
          continue;
        }
        errors.push(errAt(lineNum, `expected a [section] before "${head.text}"`, 'add [circuit]'));
        continue;
      }

      if (section === 'circuit') {
        const stmt = parseEditStatement(tokens, lineNum, false, errors);
        if (stmt) doc.circuit.push(stmt as CnlCircuitStmt);
      } else if (section !== 'code') {
        const place = parsePlacementSectionLine(tokens, lineNum, section, errors);
        if (place) doc[section].push(place);
      }
    }
  }

  if (!seenHeader) errors.push(errAt(1, 'empty file; expected "cnl 1" header'));

  for (const [ref, rawLines] of codeBuffers) {
    const body = [...rawLines];
    while (body.length > 0 && body[0]!.trim() === '') body.shift();
    while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
    if (body.length > 0) doc.code[ref] = body.join('\n');
  }

  if (testRawLines.length > 0) {
    const parsedTests = parseTestsLines(testRawLines, errors);
    doc.tests = parsedTests.tests;
    if (parsedTests.testsText !== undefined) doc.testsText = parsedTests.testsText;
  }

  if (errors.length > 0) throw new CadErrors(errors);
  return doc;
}
