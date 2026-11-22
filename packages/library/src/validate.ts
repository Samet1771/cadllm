// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { parseSI, type PartDef, type PinType } from '@cadllm/core';

const PIN_TYPES = new Set<PinType>([
  'passive', 'input', 'output', 'bidir', 'tristate',
  'power_in', 'power_out', 'open_collector', 'nc',
]);
const PROP_TYPES = new Set(['number', 'string', 'enum', 'bool']);
const SIM_KINDS = new Set(['logic', 'spice', 'mcu']);
const DATASHEET_CATS = new Set(['transistor', 'logic', 'ic']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Validate an unknown value as a PartDef. Returns a list of problems (empty when valid). */
export function validatePart(p: unknown): string[] {
  const err: string[] = [];
  if (!isObj(p)) return ['part must be an object'];

  for (const k of ['id', 'name', 'summary', 'category', 'refPrefix'] as const) {
    if (!isStr(p[k])) err.push(`missing or empty "${k}"`);
  }

  if (!Array.isArray(p.pins) || p.pins.length === 0) {
    err.push('pins must be a non-empty array');
  } else {
    const ids = new Set<string>();
    const names = new Set<string>();
    const aliases = new Set<string>();
    const pinRecords: { id: string; name: string; aliases: string[] }[] = [];

    for (let i = 0; i < p.pins.length; i++) {
      const pin = p.pins[i];
      if (!isObj(pin)) { err.push(`pins[${i}] must be an object`); continue; }
      if (!isStr(pin.id)) err.push(`pins[${i}].id missing or empty`);
      if (!isStr(pin.name)) err.push(`pins[${i}].name missing or empty`);
      if (!isStr(pin.type) || !PIN_TYPES.has(pin.type as PinType)) {
        err.push(`pins[${i}].type invalid or missing (${String(pin.type)})`);
      }
      const list: string[] = [];
      if (pin.aliases !== undefined) {
        if (!Array.isArray(pin.aliases) || pin.aliases.some(a => !isStr(a))) {
          err.push(`pins[${i}].aliases must be an array of non-empty strings`);
        } else {
          list.push(...(pin.aliases as string[]));
        }
      }
      if (isStr(pin.id) && isStr(pin.name)) {
        const lid = pin.id.toLowerCase();
        const lname = pin.name.toLowerCase();
        if (ids.has(lid)) err.push(`duplicate pin id "${pin.id}"`);
        ids.add(lid);
        if (names.has(lname)) err.push(`duplicate pin name "${pin.name}"`);
        names.add(lname);
        pinRecords.push({ id: pin.id, name: pin.name, aliases: list });
      }
    }

    for (const rec of pinRecords) {
      const selfId = rec.id.toLowerCase();
      const selfName = rec.name.toLowerCase();
      for (const a of rec.aliases) {
        const la = a.toLowerCase();
        if (aliases.has(la)) err.push(`duplicate pin alias "${a}"`);
        aliases.add(la);
        if (la === selfId || la === selfName) err.push(`pin ${rec.id} alias "${a}" duplicates its own id/name`);
        else if (ids.has(la) || names.has(la)) err.push(`pin ${rec.id} alias "${a}" collides with another pin id/name`);
      }
    }
  }

  const props = p.props;
  if (props !== undefined) {
    if (!isObj(props)) {
      err.push('props must be an object');
    } else {
      for (const [k, def] of Object.entries(props)) {
        if (!isObj(def)) { err.push(`props.${k} must be an object`); continue; }
        if (!isStr(def.type) || !PROP_TYPES.has(def.type)) {
          err.push(`props.${k}.type invalid (${String(def.type)})`);
          continue;
        }
        if (def.type === 'enum') {
          if (!Array.isArray(def.options) || def.options.length === 0 || def.options.some(o => !isStr(o))) {
            err.push(`props.${k}.options must be a non-empty string array`);
          } else if (def.default !== undefined && (typeof def.default !== 'string' || !def.options.includes(def.default))) {
            err.push(`props.${k}.default "${String(def.default)}" not in options`);
          }
        } else if (def.type === 'number' && def.default !== undefined) {
          if (typeof def.default !== 'string' || parseSI(def.default) === undefined) {
            err.push(`props.${k}.default "${String(def.default)}" does not parse with parseSI`);
          }
        } else if (def.type === 'bool' && def.default !== undefined && def.default !== 'true' && def.default !== 'false') {
          err.push(`props.${k}.default "${String(def.default)}" must be "true" or "false"`);
        }
      }
    }
  }

  if (p.valueProp !== undefined) {
    if (!isStr(p.valueProp) || !isObj(props) || !(p.valueProp in props)) {
      err.push(`valueProp "${String(p.valueProp)}" not found in props`);
    }
  }

  if (p.sim !== undefined) {
    if (!Array.isArray(p.sim)) {
      err.push('sim must be an array');
    } else {
      for (let i = 0; i < p.sim.length; i++) {
        const s = p.sim[i];
        if (!isObj(s) || !isStr(s.kind) || !SIM_KINDS.has(s.kind) || !isStr(s.ref)) {
          err.push(`sim[${i}] must have valid kind and non-empty ref`);
        }
      }
    }
  }

  if (isStr(p.category) && DATASHEET_CATS.has(p.category) && !isStr(p.datasheet)) {
    err.push(`datasheet required for category "${p.category}"`);
  }

  return err;
}

export type { PartDef };
