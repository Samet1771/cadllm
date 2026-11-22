// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export type SectionName = 'circuit' | 'breadboard' | 'schematic' | 'pcb' | 'tests';

export interface CnlCompStmt {
  kind: 'component';
  line: number;
  ref: string;
  part: string;
  value?: string;
  props: Record<string, string | null>;
  place: Record<string, string | null>;
}

export interface CnlPlaceStmt {
  kind: 'place';
  line: number;
  ref: string;
  place: Record<string, string | null>;
}

export interface CnlNetStmt {
  kind: 'net';
  line: number;
  name: string;
  pins: string[];
}

export interface CnlMetaStmt {
  kind: 'meta';
  line: number;
  entries: Record<string, string | null>;
}

export interface CnlRemoveStmt {
  kind: 'remove';
  line: number;
  target: string;
}

export interface CnlDisconnectStmt {
  kind: 'disconnect';
  line: number;
  net: string;
  pins: string[];
}

export interface CnlPatchStmt {
  kind: 'patch';
  line: number;
  ref: string;
  props: Record<string, string | null>;
  place: Record<string, string | null>;
}

export interface CnlMoveStmt {
  kind: 'move';
  line: number;
  from: string;
  to: string;
}

export type CnlCircuitStmt = CnlCompStmt | CnlPlaceStmt | CnlNetStmt | CnlMetaStmt;
export type CnlEditStmt = CnlCircuitStmt | CnlRemoveStmt | CnlDisconnectStmt | CnlPatchStmt | CnlMoveStmt;

export interface CnlSectionPlace {
  line: number;
  ref: string;
  pos: string;
}

export type CompareOp = '<' | '<=' | '>' | '>=' | '=';

export interface ExpectCompare {
  kind: 'compare';
  probe: string;
  op: CompareOp;
  value: number;
  raw: string;
  line: number;
}

export interface ExpectRange {
  kind: 'range';
  probe: string;
  min: number;
  max: number;
  minRaw: string;
  maxRaw: string;
  line: number;
}

export interface ExpectTableRow {
  inputs: string[];
  outputs: string[];
  line: number;
}

export interface ExpectTable {
  kind: 'table';
  rows: ExpectTableRow[];
  line: number;
}

export type TestExpect = ExpectCompare | ExpectRange | ExpectTable;

export interface TestAnalysis {
  kind: string;
  args: Record<string, string>;
  positional: string[];
  line: number;
}

export interface TestBlock {
  name: string;
  line: number;
  analysis?: TestAnalysis;
  expects: TestExpect[];
}

export interface CnlDoc {
  version: number;
  meta: Record<string, string>;
  circuit: CnlCircuitStmt[];
  breadboard: CnlSectionPlace[];
  schematic: CnlSectionPlace[];
  pcb: CnlSectionPlace[];
  tests: TestBlock[];
  testsText?: string;
}

export interface EditResult {
  statements: number;
  notes: string[];
}
