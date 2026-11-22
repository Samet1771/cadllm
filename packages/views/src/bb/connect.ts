// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { naturalCompare, type Net, type Query } from '@cadllm/core';
import type { Pt, ViewIssue } from '../types.ts';
import {
  holePosOnBoard,
  holesInStrip,
  resolveBoard,
  type BoardSpec,
  type RailRow,
  type StripInfo,
} from './board.ts';
import { familyOf, resolveCompPlace, type PinPlacement, type PlacedComp } from './place.ts';

export type NetRole = 'plus' | 'gnd' | 'signal';

export interface Jumper {
  netName: string;
  role: NetRole;
  colorIndex: number;
  from: Pt;
  to: Pt;
  fromHole?: string;
  toHole?: string;
  isBridge?: boolean;
}

export interface BreadboardAnalysis {
  board: BoardSpec;
  placed: PlacedComp[];
  unplacedRefs: string[];
  jumpers: Jumper[];
  issues: ViewIssue[];
  railNets: Map<RailRow, Net>;
}

const PLUS_NET_RE = /^(VCC|VDD|V\+|PWR|\+?\d+(?:\.\d+)?V\d*|\d+V\d+)$/i;
const GND_NET_RE = /^(GND|VSS|GROUND|0V|V-)$/i;

/** Deterministic FNV-1a hash mod n. */
export function netColorIndex(name: string, paletteSize: number): number {
  let h = 2166136261;
  const upper = name.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    h ^= upper.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % paletteSize;
}

export const SIGNAL_PALETTE_SIZE = 8;

export function classifyNetRole(q: Query, net: Net): NetRole {
  let isPlus = false;
  let isGnd = false;

  for (const key of net.pins) {
    const [cid, pid] = key.split(':') as [string, string];
    const comp = q.circuit.components[cid];
    if (!comp) continue;
    const part = q.parts.get(comp.part);
    const fam = familyOf(q, comp);
    const pin = part?.pins.find(p => p.id === pid);
    if (fam === 'vcc_symbol' || fam === 'vcc' || comp.part === 'vcc_symbol') isPlus = true;
    if (fam === 'gnd_symbol' || fam === 'gnd' || comp.part === 'gnd_symbol') isGnd = true;
    if (fam === 'battery' || fam === 'supply') {
      if (pin?.name === '+' || pin?.id === '1') isPlus = true;
      if (pin?.name === '-' || pin?.id === '2') isGnd = true;
    }
  }

  if (PLUS_NET_RE.test(net.name)) isPlus = true;
  if (GND_NET_RE.test(net.name)) isGnd = true;

  if (isPlus && !isGnd) return 'plus';
  if (isGnd && !isPlus) return 'gnd';
  if (isPlus) return 'plus';
  return 'signal';
}

interface NodeEndpoint {
  id: string;
  label: string;
  kind: 'strip' | 'rail' | 'offboard';
  half?: 'T' | 'B';
  rail?: RailRow;
  pt?: Pt;
  holes?: string[];
}

function distPt(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function minDistBetweenNodes(
  board: BoardSpec,
  a: NodeEndpoint,
  b: NodeEndpoint,
  occupied: Set<string>,
): { dist: number; fromPt: Pt; toPt: Pt; fromHole?: string; toHole?: string } | undefined {
  if (a.kind === 'offboard' && b.kind === 'offboard') {
    return { dist: distPt(a.pt!, b.pt!), fromPt: a.pt!, toPt: b.pt! };
  }
  if (a.kind === 'offboard') {
    let best: { dist: number; toPt: Pt; toHole: string } | undefined;
    for (const h of b.holes!) {
      if (occupied.has(h)) continue;
      const pt = holePosOnBoard(board, h)!;
      const d = distPt(a.pt!, pt);
      if (!best || d < best.dist - 1e-6 || (Math.abs(d - best.dist) <= 1e-6 && naturalCompare(h, best.toHole) < 0)) {
        best = { dist: d, toPt: pt, toHole: h };
      }
    }
    return best ? { dist: best.dist, fromPt: a.pt!, toPt: best.toPt, toHole: best.toHole } : undefined;
  }
  if (b.kind === 'offboard') {
    const rev = minDistBetweenNodes(board, b, a, occupied);
    if (!rev) return undefined;
    return {
      dist: rev.dist,
      fromPt: rev.toPt,
      toPt: rev.fromPt,
      ...(rev.toHole ? { fromHole: rev.toHole } : {}),
    };
  }

  let best: { dist: number; fromPt: Pt; toPt: Pt; fromHole: string; toHole: string } | undefined;
  for (const ha of a.holes!) {
    if (occupied.has(ha)) continue;
    const pta = holePosOnBoard(board, ha)!;
    for (const hb of b.holes!) {
      if (occupied.has(hb)) continue;
      const ptb = holePosOnBoard(board, hb)!;
      const d = distPt(pta, ptb);
      if (
        !best
        || d < best.dist - 1e-6
        || (Math.abs(d - best.dist) <= 1e-6
          && (naturalCompare(ha, best.fromHole) < 0
            || (ha === best.fromHole && naturalCompare(hb, best.toHole) < 0)))
      ) {
        best = { dist: d, fromPt: pta, toPt: ptb, fromHole: ha, toHole: hb };
      }
    }
  }
  return best;
}

export function analyzeBreadboard(q: Query): BreadboardAnalysis {
  const board = resolveBoard(q);
  const placed: PlacedComp[] = [];
  const unplacedRefs: string[] = [];
  const issues: ViewIssue[] = [];

  for (const comp of q.components()) {
    const res = resolveCompPlace(q, board, comp);
    issues.push(...res.issues);
    if (res.unplaced) unplacedRefs.push(comp.ref);
    if (res.placed) placed.push(res.placed);
  }

  if (unplacedRefs.length > 0) {
    issues.push({
      level: 'warn',
      code: 'unplaced',
      message: `${unplacedRefs.join(' ')} not placed in breadboard view`,
      at: unplacedRefs,
    });
  }

  // Track holes occupied by component pins and detect overlaps
  const holePins = new Map<string, PinPlacement[]>();
  const stripMap = new Map<string, { strip: StripInfo; entries: { pin: PinPlacement; net?: Net }[] }>();
  const dipCols = new Set<number>();

  for (const pc of placed) {
    if (pc.family === 'dip') {
      for (const pin of pc.pins) {
        if (pin.parsedHole) dipCols.add(pin.parsedHole.col);
      }
    }
    for (const pin of pc.pins) {
      if (!pin.onBoard || !pin.hole || !pin.strip) continue;
      const list = holePins.get(pin.hole) ?? [];
      list.push(pin);
      holePins.set(pin.hole, list);

      let sEntry = stripMap.get(pin.strip.id);
      if (!sEntry) {
        sEntry = { strip: pin.strip, entries: [] };
        stripMap.set(pin.strip.id, sEntry);
      }
      const net = q.netOfPin(pin.key);
      sEntry.entries.push(net ? { pin, net } : { pin });
    }
  }

  for (const [hole, list] of [...holePins.entries()].sort((a, b) => naturalCompare(a[0], b[0]))) {
    if (list.length > 1) {
      const labels = list.map(p => p.label);
      issues.push({
        level: 'error',
        code: 'overlap',
        message: `hole ${hole} occupied by ${labels.join(' and ')}`,
        at: [...labels, hole],
      });
    }
  }

  // Detect bb_short per individual strip/rail first
  const shortedStrips = new Set<string>();
  const stripSingleNet = new Map<string, Net>();
  for (const [stripId, entry] of [...stripMap.entries()].sort((a, b) => naturalCompare(a[0], b[0]))) {
    const nets = new Map<string, Net>();
    for (const e of entry.entries) {
      if (e.net) nets.set(e.net.id, e.net);
    }
    if (nets.size > 1) {
      shortedStrips.add(stripId);
      const netNames = [...nets.values()].map(n => n.name).sort(naturalCompare);
      const pinLabels = entry.entries.filter(e => e.net).map(e => e.pin.label);
      issues.push({
        level: 'error',
        code: 'bb_short',
        message: `strip ${entry.strip.label} shorts nets ${netNames.join(', ')}`,
        at: [entry.strip.label, ...netNames, ...pinLabels],
      });
    } else if (nets.size === 1) {
      stripSingleNet.set(stripId, [...nets.values()][0]!);
    }
  }

  const occupied = new Set<string>(holePins.keys());

  // Map pinKey -> PinPlacement for placed pins
  const pinLookup = new Map<string, PinPlacement>();
  for (const pc of placed) {
    for (const pin of pc.pins) {
      if (pin.offBoard || pin.onBoard) pinLookup.set(pin.key, pin);
    }
  }

  const nets = q.nets();
  const netRoles = new Map<string, NetRole>();
  const railNets = new Map<RailRow, Net>();
  const bridgedPolarities = new Set<'plus' | 'gnd'>();

  for (const net of nets) {
    netRoles.set(net.id, classifyNetRole(q, net));
  }

  // Collect endpoints per net
  const collectNetNodes = (net: Net): Map<string, NodeEndpoint> => {
    const nodes = new Map<string, NodeEndpoint>();
    for (const key of net.pins) {
      const pp = pinLookup.get(key);
      if (!pp) continue;
      if (pp.offBoard) {
        nodes.set(`pin:${key}`, {
          id: `pin:${key}`,
          label: pp.label,
          kind: 'offboard',
          pt: pp.pt,
        });
      } else if (pp.strip && !shortedStrips.has(pp.strip.id)) {
        if (!nodes.has(pp.strip.id)) {
          nodes.set(pp.strip.id, {
            id: pp.strip.id,
            label: pp.strip.label,
            kind: pp.strip.kind,
            ...(pp.strip.half ? { half: pp.strip.half } : {}),
            ...(pp.strip.rail ? { rail: pp.strip.rail } : {}),
            holes: holesInStrip(board, pp.strip.id),
          });
        }
      }
    }
    return nodes;
  };

  // Determine rail pairing per power net:
  // Upper half (A-E) + off-board sources -> T+/T-; Lower half (F-J) -> B+/B-.
  // When a power net uses both halves, its polarity pair (T+ & B+ or T- & B-) is bridged as one node.
  const netRailConfig = new Map<string, { top?: RailRow; bot?: RailRow; bridge: boolean }>();
  const claimedRails = new Set<RailRow>();

  for (const polarity of ['plus', 'gnd'] as const) {
    const topRail: RailRow = polarity === 'plus' ? 'T+' : 'T-';
    const botRail: RailRow = polarity === 'plus' ? 'B+' : 'B-';
    const polNets = nets.filter(n => netRoles.get(n.id) === polarity);

    for (const net of polNets) {
      const nodes = collectNetNodes(net);
      if (nodes.size === 0) continue;

      const usesTop = [...nodes.values()].some(
        n => n.kind === 'offboard' || (n.kind === 'strip' && n.half === 'T') || n.rail === topRail,
      );
      const usesBot = [...nodes.values()].some(
        n => (n.kind === 'strip' && n.half === 'B') || n.rail === botRail,
      );

      if (usesTop && usesBot && !bridgedPolarities.has(polarity)) {
        const topOwner = stripSingleNet.get(`rail:${topRail}`);
        const botOwner = stripSingleNet.get(`rail:${botRail}`);
        // If both rails are bridged as one node, check for bb_short across the bridged pair
        if (topOwner && botOwner && topOwner.id !== botOwner.id) {
          const pairLabel = `${topRail}/${botRail}`;
          const netNames = [topOwner.name, botOwner.name].sort(naturalCompare);
          issues.push({
            level: 'error',
            code: 'bb_short',
            message: `bridged rails ${pairLabel} short nets ${netNames.join(', ')}`,
            at: [pairLabel, ...netNames],
          });
        } else if (!claimedRails.has(topRail) && !claimedRails.has(botRail)) {
          bridgedPolarities.add(polarity);
          claimedRails.add(topRail);
          claimedRails.add(botRail);
          railNets.set(topRail, net);
          railNets.set(botRail, net);
          netRailConfig.set(net.id, { top: topRail, bot: botRail, bridge: true });
        }
      } else {
        // Single-half power net (or fallback for a second net of same polarity)
        const cfg: { top?: RailRow; bot?: RailRow; bridge: boolean } = { bridge: false };
        if (usesTop && !claimedRails.has(topRail)) {
          const owner = stripSingleNet.get(`rail:${topRail}`);
          if (!owner || owner.id === net.id) {
            claimedRails.add(topRail);
            railNets.set(topRail, net);
            cfg.top = topRail;
          }
        } else if (usesBot && !claimedRails.has(botRail)) {
          const owner = stripSingleNet.get(`rail:${botRail}`);
          if (!owner || owner.id === net.id) {
            claimedRails.add(botRail);
            railNets.set(botRail, net);
            cfg.bot = botRail;
          }
        }
        if (cfg.top || cfg.bot) {
          netRailConfig.set(net.id, cfg);
        }
      }
    }
  }

  // Generate jumpers per net
  const jumpers: Jumper[] = [];
  const pendingBridges: { net: Net; role: NetRole; colorIndex: number; top: RailRow; bot: RailRow }[] = [];

  for (const net of nets) {
    const role = netRoles.get(net.id)!;
    const colorIndex = netColorIndex(net.name, SIGNAL_PALETTE_SIZE);
    const nodes = collectNetNodes(net);
    const railCfg = netRailConfig.get(net.id);

    if (railCfg && nodes.size > 0) {
      const targetRailFor = (ep: NodeEndpoint): RailRow | undefined => {
        if (ep.kind === 'rail') return undefined;
        if (ep.kind === 'offboard' || ep.half === 'T') return railCfg.top ?? railCfg.bot;
        return railCfg.bot ?? railCfg.top;
      };

      const targets = [...nodes.values()]
        .filter(n => n.kind !== 'rail')
        .sort((a, b) => naturalCompare(a.id, b.id));

      for (const target of targets) {
        const destRail = targetRailFor(target);
        if (!destRail) continue;
        const railId = `rail:${destRail}`;
        const railNode: NodeEndpoint = {
          id: railId,
          label: destRail,
          kind: 'rail',
          rail: destRail,
          holes: holesInStrip(board, railId),
        };
        const match = minDistBetweenNodes(board, target, railNode, occupied);
        if (!match) {
          const fullLabel = target.kind !== 'offboard' && target.holes!.every(h => occupied.has(h))
            ? target.label
            : railNode.label;
          issues.push({
            level: 'warn',
            code: 'strip_full',
            message: `no free hole left in ${fullLabel} for net ${net.name} jumper`,
            at: [net.name, fullLabel],
          });
          continue;
        }
        if (match.fromHole) occupied.add(match.fromHole);
        if (match.toHole) occupied.add(match.toHole);
        jumpers.push({
          netName: net.name,
          role,
          colorIndex,
          from: match.fromPt,
          to: match.toPt,
          ...(match.fromHole ? { fromHole: match.fromHole } : {}),
          ...(match.toHole ? { toHole: match.toHole } : {}),
        });
      }

      if (railCfg.bridge && railCfg.top && railCfg.bot) {
        pendingBridges.push({ net, role, colorIndex, top: railCfg.top, bot: railCfg.bot });
      }
      continue;
    }

    // Signal net (or power net with no rail claimed): deterministic MST over nodes
    const nodeList = [...nodes.values()].sort((a, b) => naturalCompare(a.id, b.id));
    if (nodeList.length <= 1) continue;

    const edges: { dist: number; u: number; v: number }[] = [];
    for (let i = 0; i < nodeList.length; i++) {
      for (let j = i + 1; j < nodeList.length; j++) {
        const m =
          minDistBetweenNodes(board, nodeList[i]!, nodeList[j]!, occupied)
          ?? minDistBetweenNodes(board, nodeList[i]!, nodeList[j]!, new Set());
        if (m) edges.push({ dist: m.dist, u: i, v: j });
      }
    }
    edges.sort((a, b) => a.dist - b.dist || a.u - b.u || a.v - b.v);

    const parent = nodeList.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };

    const chosenEdges: { u: number; v: number }[] = [];
    for (const e of edges) {
      const ru = find(e.u);
      const rv = find(e.v);
      if (ru === rv) continue;
      parent[ru] = rv;
      chosenEdges.push({ u: e.u, v: e.v });
      if (chosenEdges.length === nodeList.length - 1) break;
    }

    for (const e of chosenEdges) {
      const na = nodeList[e.u]!;
      const nb = nodeList[e.v]!;
      const match = minDistBetweenNodes(board, na, nb, occupied);
      if (!match) {
        const fullLabel = na.kind !== 'offboard' && na.holes!.every(h => occupied.has(h)) ? na.label : nb.label;
        issues.push({
          level: 'warn',
          code: 'strip_full',
          message: `no free hole left in ${fullLabel} for net ${net.name} jumper`,
          at: [net.name, fullLabel],
        });
        continue;
      }
      if (match.fromHole) occupied.add(match.fromHole);
      if (match.toHole) occupied.add(match.toHole);
      jumpers.push({
        netName: net.name,
        role,
        colorIndex,
        from: match.fromPt,
        to: match.toPt,
        ...(match.fromHole ? { fromHole: match.fromHole } : {}),
        ...(match.toHole ? { toHole: match.toHole } : {}),
      });
    }
  }

  // Place rail-to-rail bridge jumpers at the board's left edge, avoiding used columns and DIP ICs
  const usedCols = new Set<number>(dipCols);
  for (const h of occupied) {
    const m = h.match(/(\d+)$/);
    if (m) usedCols.add(Number(m[1]));
  }
  const usedBridgeCols = new Set<number>();

  for (const br of pendingBridges) {
    let chosenCol: number | undefined;
    // Pass 1: completely unused column on the left edge
    for (let c = 1; c <= board.cols; c++) {
      if (usedCols.has(c) || usedBridgeCols.has(c)) continue;
      const th = `${br.top}${c}`;
      const bh = `${br.bot}${c}`;
      if (!occupied.has(th) && !occupied.has(bh)) {
        chosenCol = c;
        break;
      }
    }
    // Pass 2: fallback to any column where bridge holes + no DIP/bridge conflict
    if (chosenCol === undefined) {
      for (let c = 1; c <= board.cols; c++) {
        if (dipCols.has(c) || usedBridgeCols.has(c)) continue;
        const th = `${br.top}${c}`;
        const bh = `${br.bot}${c}`;
        if (!occupied.has(th) && !occupied.has(bh)) {
          chosenCol = c;
          break;
        }
      }
    }
    if (chosenCol === undefined) {
      issues.push({
        level: 'warn',
        code: 'strip_full',
        message: `no free column left to bridge ${br.top} and ${br.bot} for net ${br.net.name}`,
        at: [br.net.name, br.top, br.bot],
      });
      continue;
    }
    const fromHole = `${br.top}${chosenCol}`;
    const toHole = `${br.bot}${chosenCol}`;
    occupied.add(fromHole);
    occupied.add(toHole);
    usedBridgeCols.add(chosenCol);
    usedCols.add(chosenCol);
    jumpers.push({
      netName: br.net.name,
      role: br.role,
      colorIndex: br.colorIndex,
      from: holePosOnBoard(board, fromHole)!,
      to: holePosOnBoard(board, toHole)!,
      fromHole,
      toHole,
      isBridge: true,
    });
  }

  return { board, placed, unplacedRefs, jumpers, issues, railNets };
}
