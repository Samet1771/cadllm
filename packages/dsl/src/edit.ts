// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { CadError, CadErrors, Doc, type PartResolver, type Tx } from '@cadllm/core';
import type { CnlEditStmt, EditResult } from './ast.ts';
import { quoteValue, tokenizeLine } from './lexer.ts';
import { parseEditStatement, parseCnl } from './parser.ts';

export const TESTS_META_KEY = '__tests';
export const CODE_META_PREFIX = '__code:';

export const codeMetaKey = (ref: string): string => `${CODE_META_PREFIX}${ref}`;

function resolvePropMap(
  tx: Tx,
  partId: string,
  ref: string,
  rawProps: Record<string, string | null>,
  positionalValue?: string,
): Record<string, string | null> {
  const part = tx.parts.get(partId);
  const out: Record<string, string | null> = {};

  if (positionalValue !== undefined) {
    if (part && !part.valueProp) {
      throw new CadError('invalid', `${ref}: ${part.id} takes no positional value`);
    }
    if (part?.valueProp) out[part.valueProp] = positionalValue;
  }

  for (const [k, v] of Object.entries(rawProps)) {
    const mapped =
      k === 'value' && part?.valueProp && !part.props?.['value']
        ? part.valueProp
        : k;
    if (v === null) {
      const def = part?.props?.[mapped]?.default;
      out[mapped] = def !== undefined ? def : null;
    } else {
      out[mapped] = v;
    }
  }
  return out;
}

function execStatement(tx: Tx, stmt: CnlEditStmt, recordMetaNotes: boolean): void {
  switch (stmt.kind) {
    case 'meta': {
      for (const k of Object.keys(stmt.entries)) {
        if (k.startsWith('__')) {
          throw new CadError('invalid_name', `reserved meta key "${k}"`, 'keys starting with "__" are reserved for internal use');
        }
      }
      for (const [k, v] of Object.entries(stmt.entries)) {
        const prev = tx.circuit.meta[k];
        tx.setMeta(k, v);
        if (recordMetaNotes) {
          if (v === null && prev !== undefined) tx.notes.push(`meta -${k}`);
          else if (v !== null && prev !== v) tx.notes.push(`meta ${k}=${quoteValue(v)}`);
        }
      }
      return;
    }
    case 'move': {
      tx.rename(stmt.from, stmt.to);
      return;
    }
    case 'remove': {
      if (tx.component(stmt.target)) { tx.removeComponent(stmt.target); return; }
      if (tx.net(stmt.target)) { tx.removeNet(stmt.target); return; }
      // Let Tx.rename-style error or requireComponent give a clean closest match.
      tx.rename(stmt.target, stmt.target);
      return;
    }
    case 'disconnect': {
      tx.disconnect(stmt.net, stmt.pins);
      return;
    }
    case 'net': {
      tx.connect(stmt.name, stmt.pins);
      return;
    }
    case 'place': {
      tx.updateComponent(stmt.ref, { place: stmt.place });
      return;
    }
    case 'patch': {
      const existing = tx.requireComponent(stmt.ref);
      const props = resolvePropMap(tx, existing.part, existing.ref, stmt.props);
      tx.updateComponent(stmt.ref, {
        ...(Object.keys(props).length ? { props } : {}),
        ...(Object.keys(stmt.place).length ? { place: stmt.place } : {}),
      });
      return;
    }
    case 'component': {
      const existing = tx.component(stmt.ref);
      if (!existing) {
        const mapped = resolvePropMap(tx, stmt.part, stmt.ref, stmt.props, stmt.value);
        const props: Record<string, string> = {};
        for (const [k, v] of Object.entries(mapped)) if (v !== null) props[k] = v;
        const place: Record<string, string> = {};
        for (const [k, v] of Object.entries(stmt.place)) if (v !== null) place[k] = v;
        tx.addComponent({ ref: stmt.ref, part: stmt.part, props, place });
        return;
      }
      const props = resolvePropMap(tx, stmt.part, existing.ref, stmt.props, stmt.value);
      tx.updateComponent(stmt.ref, {
        ...(stmt.part !== existing.part ? { part: stmt.part } : {}),
        ...(Object.keys(props).length ? { props } : {}),
        ...(Object.keys(stmt.place).length ? { place: stmt.place } : {}),
      });
      return;
    }
  }
}

function wrapLineError(line: number, err: unknown): CadError {
  if (err instanceof CadError) {
    if (err.message.startsWith(`line ${line}: `)) return err;
    return new CadError(err.code, `line ${line}: ${err.message}`, err.hint);
  }
  return new CadError('invalid', `line ${line}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Run CNL edit lines on a core Tx; collects ALL line errors before throwing CadErrors. */
export function applyEdit(tx: Tx, text: string): EditResult {
  const lines = text.split(/\r?\n/);
  const indexedErrors: { line: number; err: CadError }[] = [];
  const stmts: CnlEditStmt[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const parseErrs: CadError[] = [];
    const lexed = tokenizeLine(lines[i]!, lineNum, parseErrs);
    for (const tokens of lexed.statements) {
      const stmt = parseEditStatement(tokens, lexed.line, true, parseErrs);
      if (stmt) stmts.push(stmt);
    }
    for (const err of parseErrs) indexedErrors.push({ line: lineNum, err });
  }

  let applied = 0;
  for (const stmt of stmts) {
    try {
      execStatement(tx, stmt, true);
      applied += 1;
    } catch (err) {
      indexedErrors.push({ line: stmt.line, err: wrapLineError(stmt.line, err) });
    }
  }

  if (indexedErrors.length > 0) {
    indexedErrors.sort((a, b) => a.line - b.line);
    throw new CadErrors(indexedErrors.map(e => e.err));
  }
  return { statements: applied, notes: [...tx.notes] };
}

/** Load a full `.cnl` file into a new Doc at rev 0. Collects all syntax and semantic errors. */
export function loadCircuit(text: string, parts: PartResolver): Doc {
  const parsed = parseCnl(text);
  const tmp = new Doc(parts);
  tmp.transact(tx => {
    for (const [k, v] of Object.entries(parsed.meta)) tx.setMeta(k, v);
    if (parsed.testsText !== undefined) tx.setMeta(TESTS_META_KEY, parsed.testsText);

    const errors: CadError[] = [];
    for (const stmt of parsed.circuit) {
      try {
        execStatement(tx, stmt, false);
      } catch (err) {
        errors.push(wrapLineError(stmt.line, err));
      }
    }

    const viewSections: ['bb' | 'sch' | 'pcb', typeof parsed.breadboard][] = [
      ['bb', parsed.breadboard],
      ['sch', parsed.schematic],
      ['pcb', parsed.pcb],
    ];
    for (const [view, entries] of viewSections) {
      for (const entry of entries) {
        try {
          tx.updateComponent(entry.ref, { place: { [view]: entry.pos } });
        } catch (err) {
          errors.push(wrapLineError(entry.line, err));
        }
      }
    }

    for (const [ref, code] of Object.entries(parsed.code)) {
      try {
        const comp = tx.requireComponent(ref);
        if (code.trim() !== '') tx.setMeta(codeMetaKey(comp.ref), code);
      } catch (err) {
        errors.push(err instanceof CadError ? err : new CadError('invalid', String(err)));
      }
    }

    if (errors.length > 0) throw new CadErrors(errors);
  });

  return new Doc(parts, tmp.toJSON());
}
