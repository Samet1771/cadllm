// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PcbLayer, Query } from '@cadllm/core';
import type { PadInstance, PcbRenderLayer } from '@cadllm/pcb';
import { UNIT, VIEWS, bbHoleAt, type Pt, type RenderState, type ViewId } from '@cadllm/views';
import {
  PCB_LAYER_ORDER,
  PCB_SNAP_MM,
  fmtMm,
  getPcbRules,
  hitTestPads,
  hitTestTrack,
  movePcbPlace,
  padLabel,
  snapMm,
  snapPointMm,
  visibleLayersToArray,
  type PcbLayerVisibility,
} from '../lib/pcb.ts';
import { resolvePcbPads, renderPcbWithFallback } from '../lib/pcbFallback.ts';
import {
  addRouteBend,
  finishPcbRoute,
  insertRouteVia,
  isPadReachableOnLayer,
  isSameNetPad,
  previewRoutePaths,
  routeLastPoint,
  startPcbRoute,
  updateRouteCursor,
  type PcbRouteState,
} from '../lib/pcbRoute.ts';
import {
  formatGridPlace,
  moveSchPlace,
  shiftBbPlace,
  snapToGrid,
} from '../lib/place.ts';
import type { SelectedTrackInfo } from './Inspector.tsx';

export interface PcbFocusTarget {
  seq: number;
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

interface CanvasViewProps {
  query: Query;
  activeView: ViewId;
  theme: 'light' | 'dark';
  isDemo: boolean;
  selectedRef: string | undefined;
  selectedTrack?: SelectedTrackInfo;
  highlight: string[];
  simState?: RenderState;
  pressMode?: boolean;
  pcbLayers: PcbLayerVisibility;
  activePcbLayer: PcbLayer;
  drcCount: { errors: number; warns: number; pending: boolean };
  exportedPath?: string;
  pcbBusy?: string;
  focusTarget?: PcbFocusTarget;
  onViewChange: (view: ViewId) => void;
  onSelectRef: (ref: string | undefined) => void;
  onSelectTrack: (track: SelectedTrackInfo | undefined) => void;
  onMovePart: (ref: string, view: ViewId, placeStr: string) => void;
  onConnectPins: (pinA: string, pinB: string) => void;
  onCommitPcbRoute: (editCnl: string) => void;
  onTogglePcbLayer: (layer: PcbRenderLayer) => void;
  onActivePcbLayerChange: (layer: PcbLayer) => void;
  onAutoPlacePcb: () => void;
  onAutoroutePcb: () => void;
  onExportFab: () => void;
  onOpenDrcPanel: () => void;
  onClearExportedPath: () => void;
  onViewportCenterChange: (gridPt: Pt) => void;
  onNotice: (msg: string) => void;
  onPressButton?: (ref: string, down: boolean) => void;
}

interface PinDragState {
  pinA: string;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  hoverPin?: string;
}

interface CompDragState {
  ref: string;
  el: SVGGElement;
  startClient: Pt;
  startSvg: Pt;
  startHole?: string;
  startPad?: PadInstance;
  moved: boolean;
}

interface PanDragState {
  startClient: Pt;
  startPan: Pt;
  moved: boolean;
}

function clientToSvg(svgEl: SVGSVGElement, clientX: number, clientY: number): Pt {
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const transformed = pt.matrixTransform(ctm.inverse());
  return { x: transformed.x, y: transformed.y };
}

function svgToViewport(svgEl: SVGSVGElement, vpEl: HTMLElement, ux: number, uy: number): Pt {
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return { x: ux, y: uy };
  const pt = svgEl.createSVGPoint();
  pt.x = ux;
  pt.y = uy;
  const screen = pt.matrixTransform(ctm);
  const vpRect = vpEl.getBoundingClientRect();
  return { x: screen.x - vpRect.left, y: screen.y - vpRect.top };
}

function findAttrEl(target: EventTarget | null, attr: string): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest(`[${attr}]`);
}

const LAYER_LABELS: Record<PcbRenderLayer, string> = {
  F: 'F.Cu',
  B: 'B.Cu',
  silk: 'Silk',
  outline: 'Outline',
  ratsnest: 'Ratsnest',
  courtyard: 'Courtyard',
};

export function CanvasView({
  query,
  activeView,
  theme,
  isDemo,
  selectedRef,
  selectedTrack,
  highlight,
  simState,
  pressMode = false,
  pcbLayers,
  activePcbLayer,
  drcCount,
  exportedPath,
  pcbBusy,
  focusTarget,
  onViewChange,
  onSelectRef,
  onSelectTrack,
  onMovePart,
  onConnectPins,
  onCommitPcbRoute,
  onTogglePcbLayer,
  onActivePcbLayerChange,
  onAutoPlacePcb,
  onAutoroutePcb,
  onExportFab,
  onOpenDrcPanel,
  onClearExportedPath,
  onViewportCenterChange,
  onNotice,
  onPressButton,
}: CanvasViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoom] = useState(1.5);
  const [pan, setPan] = useState<Pt>({ x: 40, y: 40 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [hoverHole, setHoverHole] = useState<string | undefined>(undefined);
  const [hoverPadHint, setHoverPadHint] = useState<string | undefined>(undefined);
  const [dragHud, setDragHud] = useState<string | undefined>(undefined);
  const [pinDrag, setPinDrag] = useState<PinDragState | null>(null);
  const [pcbTool, setPcbTool] = useState<'select' | 'route'>('select');
  const [pcbRoute, setPcbRoute] = useState<PcbRouteState | null>(null);

  const compDragRef = useRef<CompDragState | null>(null);
  const panDragRef = useRef<PanDragState | null>(null);
  const pinDragRef = useRef<PinDragState | null>(null);
  const activeButtonPressRef = useRef<string | null>(null);
  const pcbRouteRef = useRef<PcbRouteState | null>(pcbRoute);
  pcbRouteRef.current = pcbRoute;

  const pcbPads = useMemo(
    () => (activeView === 'pcb' ? resolvePcbPads(query, isDemo) : []),
    [activeView, isDemo, query],
  );

  const visibleCopperLayers = useMemo(() => {
    const s = new Set<PcbLayer>();
    if (pcbLayers.F) s.add('F');
    if (pcbLayers.B) s.add('B');
    return s;
  }, [pcbLayers.B, pcbLayers.F]);

  const effectiveHighlight = useMemo(() => {
    if (activeView === 'pcb' && selectedTrack) {
      return [...new Set([...highlight, `net:${selectedTrack.netName}`])];
    }
    return highlight;
  }, [activeView, highlight, selectedTrack]);

  const rendered = useMemo(() => {
    try {
      if (activeView === 'pcb') {
        const res = renderPcbWithFallback(
          query,
          {
            ...(effectiveHighlight.length > 0 ? { highlight: effectiveHighlight } : {}),
            ...(simState ? { state: simState } : {}),
            theme,
            layers: visibleLayersToArray(pcbLayers),
          },
          isDemo,
        );
        return { svg: res.svg, isFallback: res.isFallback, error: undefined };
      }
      const svg = VIEWS[activeView].render(query, {
        ...(effectiveHighlight.length > 0 ? { highlight: effectiveHighlight } : {}),
        ...(simState ? { state: simState } : {}),
        theme,
      });
      return { svg, isFallback: false, error: undefined };
    } catch (err) {
      return {
        svg: '',
        isFallback: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [query, activeView, effectiveHighlight, simState, theme, pcbLayers, isDemo]);

  // Cancel any in-flight PCB route when leaving PCB view.
  useEffect(() => {
    if (activeView !== 'pcb') {
      setPcbRoute(null);
      setHoverPadHint(undefined);
    }
  }, [activeView]);

  // Apply selection attribute directly on the mounted SVG without mutating the source string.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const items = host.querySelectorAll('[data-ref]');
    const want = selectedRef?.toUpperCase();
    for (const el of items) {
      const ref = el.getAttribute('data-ref');
      if (want && ref?.toUpperCase() === want) {
        el.setAttribute('data-selected', 'true');
      } else {
        el.removeAttribute('data-selected');
      }
    }
    const nets = host.querySelectorAll('[data-net]');
    const wantNet = activeView === 'pcb' ? selectedTrack?.netName.toUpperCase() : undefined;
    for (const el of nets) {
      const n = el.getAttribute('data-net');
      if (wantNet && n?.toUpperCase() === wantNet) {
        el.setAttribute('data-selected', 'true');
      } else {
        el.removeAttribute('data-selected');
      }
    }
  }, [rendered.svg, selectedRef, selectedTrack, activeView]);

  // Focus (pan & zoom) when clicking a DRC issue.
  useEffect(() => {
    if (!focusTarget || activeView !== 'pcb') return;
    const vp = viewportRef.current;
    const svgEl = hostRef.current?.querySelector('svg');
    if (!vp || !svgEl) return;
    const vb = svgEl.viewBox.baseVal;
    const rect = vp.getBoundingClientRect();
    const { minX, minY, maxX, maxY } = focusTarget.box;
    const boxW = Math.max(4, maxX - minX) * UNIT;
    const boxH = Math.max(4, maxY - minY) * UNIT;
    const nextZoom = Math.max(1.0, Math.min(4.5, Math.min((rect.width * 0.6) / boxW, (rect.height * 0.6) / boxH)));
    const cxSvg = ((minX + maxX) / 2) * UNIT;
    const cySvg = ((minY + maxY) / 2) * UNIT;
    setZoom(nextZoom);
    setPan({
      x: rect.width / 2 - (cxSvg - vb.x) * nextZoom,
      y: rect.height / 2 - (cySvg - vb.y) * nextZoom,
    });
  }, [focusTarget, activeView]);

  const reportCenter = useCallback(() => {
    const vp = viewportRef.current;
    const svgEl = hostRef.current?.querySelector('svg');
    if (!vp || !svgEl) {
      onViewportCenterChange({ x: 10, y: 8 });
      return;
    }
    const rect = vp.getBoundingClientRect();
    const svgPt = clientToSvg(svgEl, rect.left + rect.width / 2, rect.top + rect.height / 2);
    onViewportCenterChange(snapToGrid(svgPt));
  }, [onViewportCenterChange]);

  useEffect(() => {
    reportCenter();
  }, [reportCenter, pan, zoom, rendered.svg]);

  // Track Space key for pan-anywhere mode, and V / Esc during interactive PCB routing.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && (target.isContentEditable || target.closest('.cm-editor')))
      ) {
        return;
      }

      if (e.code === 'Space') {
        setSpaceDown(true);
        return;
      }

      if (activeView === 'pcb' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'Escape') {
          if (pcbRouteRef.current) {
            e.preventDefault();
            setPcbRoute(null);
            onNotice('Cancelled routing');
          } else if (pcbTool === 'route') {
            e.preventDefault();
            setPcbTool('select');
          }
          return;
        }
        if (e.key.toLowerCase() === 'v' && pcbRouteRef.current) {
          e.preventDefault();
          const next = insertRouteVia(pcbRouteRef.current, undefined, PCB_SNAP_MM);
          setPcbRoute(next);
          onActivePcbLayerChange(next.activeLayer);
          onNotice(`Inserted via → layer ${next.activeLayer}`);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [activeView, onActivePcbLayerChange, onNotice, pcbTool]);

  const fitView = useCallback(() => {
    const vp = viewportRef.current;
    const svgEl = hostRef.current?.querySelector('svg');
    if (!vp || !svgEl) {
      setZoom(1.5);
      setPan({ x: 40, y: 40 });
      return;
    }
    const vb = svgEl.viewBox.baseVal;
    const w = vb && vb.width > 0 ? vb.width : svgEl.getBoundingClientRect().width / zoom || 400;
    const h = vb && vb.height > 0 ? vb.height : svgEl.getBoundingClientRect().height / zoom || 300;
    const rect = vp.getBoundingClientRect();
    const pad = 48;
    const nextZoom = Math.max(0.25, Math.min(4, Math.min((rect.width - pad) / w, (rect.height - pad) / h)));
    setZoom(nextZoom);
    setPan({
      x: (rect.width - w * nextZoom) / 2,
      y: (rect.height - h * nextZoom) / 2,
    });
  }, [zoom]);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = Math.max(0.2, Math.min(6, zoom * factor));
    const ratio = nextZoom / zoom;
    setZoom(nextZoom);
    setPan(prev => ({
      x: cx - (cx - prev.x) * ratio,
      y: cy - (cy - prev.y) * ratio,
    }));
  };

  const isButtonRef = (ref: string): boolean => {
    const comp = query.component(ref);
    if (!comp) return false;
    const part = query.parts.get(comp.part);
    return comp.part === 'button' || part?.views?.sch === 'button' || part?.views?.bb === 'button';
  };

  const beginRouteFromPad = useCallback((pad: PadInstance) => {
    const res = startPcbRoute(pad, activePcbLayer, getPcbRules(query));
    if (!res.ok) {
      onNotice(res.error);
      onSelectRef(pad.ref);
      return;
    }
    setPcbRoute(res.state);
    onActivePcbLayerChange(res.state.activeLayer);
    onSelectTrack(undefined);
    onSelectRef(undefined);
  }, [activePcbLayer, onActivePcbLayerChange, onNotice, onSelectRef, onSelectTrack, query]);

  const findPadAtWorldMm = useCallback((worldMm: [number, number], preferNetId?: string, preferLayer?: PcbLayer): PadInstance | undefined => {
    if (preferNetId && preferLayer) {
      const sameNetLayer = hitTestPads(
        pcbPads.filter(p => p.netId === preferNetId),
        worldMm,
        { layer: preferLayer },
      );
      if (sameNetLayer) return sameNetLayer;
    }
    if (preferNetId) {
      const sameNet = hitTestPads(
        pcbPads.filter(p => p.netId === preferNetId),
        worldMm,
      );
      if (sameNet) return sameNet;
    }
    return hitTestPads(pcbPads, worldMm, { visibleLayers: visibleCopperLayers });
  }, [pcbPads, visibleCopperLayers]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const svgEl = hostRef.current?.querySelector('svg');

    // Middle-click or Space+left-click always pans.
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      panDragRef.current = {
        startClient: { x: e.clientX, y: e.clientY },
        startPan: pan,
        moved: false,
      };
      vp.setPointerCapture(e.pointerId);
      return;
    }

    // Right-click cancels active PCB route.
    if (e.button === 2 && activeView === 'pcb' && pcbRouteRef.current) {
      e.preventDefault();
      setPcbRoute(null);
      onNotice('Cancelled routing');
      return;
    }

    if (e.button !== 0) return;

    // Interactive PCB routing / PCB interactions
    if (activeView === 'pcb' && svgEl) {
      const svgPt = clientToSvg(svgEl, e.clientX, e.clientY);
      const worldMm: [number, number] = [svgPt.x / UNIT, svgPt.y / UNIT];

      // 1. Active routing session: click target pad to finish or click bend point.
      if (pcbRouteRef.current) {
        e.preventDefault();
        const curRoute = pcbRouteRef.current;
        const hitPad = findPadAtWorldMm(worldMm, curRoute.netId, curRoute.activeLayer);
        if (hitPad) {
          if (hitPad.compId === curRoute.startPad.compId && hitPad.pinId === curRoute.startPad.pinId) {
            onNotice('Click a bend point or another pad on the same net to finish');
            return;
          }
          if (!hitPad.netId || hitPad.netId !== curRoute.netId) {
            onNotice(`Pad ${padLabel(hitPad)} is on ${hitPad.net ?? 'no net'}, expected ${curRoute.netName}`);
            return;
          }
          const finished = finishPcbRoute(curRoute, hitPad);
          if (!finished.ok) {
            onNotice(finished.error);
            return;
          }
          setPcbRoute(null);
          onCommitPcbRoute(finished.editCnl);
          onNotice(
            `Routed ${curRoute.netName} (${finished.trackCount} track${finished.trackCount === 1 ? '' : 's'}${finished.viaCount ? `, ${finished.viaCount} via` : ''})`,
          );
          return;
        }
        setPcbRoute(prev => (prev ? addRouteBend(prev, worldMm, PCB_SNAP_MM) : null));
        return;
      }

      // 2. Idle in Route mode: clicking a pad starts routing.
      const hitPad = findPadAtWorldMm(worldMm);
      if (pcbTool === 'route') {
        if (hitPad) {
          e.preventDefault();
          beginRouteFromPad(hitPad);
          return;
        }
        panDragRef.current = {
          startClient: { x: e.clientX, y: e.clientY },
          startPan: pan,
          moved: false,
        };
        vp.setPointerCapture(e.pointerId);
        return;
      }

      // 3. Idle in Select mode: clicking/dragging a footprint or clicking a pad starts routing.
      const refEl = findAttrEl(e.target, 'data-ref');
      if (refEl && refEl instanceof SVGGElement) {
        const ref = refEl.getAttribute('data-ref');
        if (ref) {
          e.preventDefault();
          compDragRef.current = {
            ref,
            el: refEl,
            startClient: { x: e.clientX, y: e.clientY },
            startSvg: svgPt,
            startPad: hitPad,
            moved: false,
          };
          vp.setPointerCapture(e.pointerId);
          return;
        }
      }

      // 4. Background / track click
      panDragRef.current = {
        startClient: { x: e.clientX, y: e.clientY },
        startPan: pan,
        moved: false,
      };
      vp.setPointerCapture(e.pointerId);
      return;
    }

    // Schematic & Breadboard interactions
    const pinEl = findAttrEl(e.target, 'data-pin');
    if (pinEl && !pressMode) {
      const pinName = pinEl.getAttribute('data-pin');
      if (pinName) {
        e.preventDefault();
        const vpRect = vp.getBoundingClientRect();
        const pRect = pinEl.getBoundingClientRect();
        const startX = pRect.left + pRect.width / 2 - vpRect.left;
        const startY = pRect.top + pRect.height / 2 - vpRect.top;
        const next: PinDragState = {
          pinA: pinName,
          startX,
          startY,
          curX: e.clientX - vpRect.left,
          curY: e.clientY - vpRect.top,
        };
        pinDragRef.current = next;
        setPinDrag(next);
        vp.setPointerCapture(e.pointerId);
        return;
      }
    }

    const refEl = findAttrEl(e.target, 'data-ref');
    if (refEl && refEl instanceof SVGGElement && svgEl) {
      const ref = refEl.getAttribute('data-ref');
      if (ref) {
        if ((pressMode || e.altKey) && onPressButton && isButtonRef(ref)) {
          e.preventDefault();
          activeButtonPressRef.current = ref;
          onPressButton(ref, true);
          vp.setPointerCapture(e.pointerId);
          return;
        }
        e.preventDefault();
        const startSvg = clientToSvg(svgEl, e.clientX, e.clientY);
        let startHole = findAttrEl(e.target, 'data-hole')?.getAttribute('data-hole') ?? undefined;
        if (!startHole && activeView === 'bb') {
          try {
            startHole = bbHoleAt(query, startSvg);
          } catch {
            // bbHoleAt may still be unimplemented
          }
        }
        compDragRef.current = {
          ref,
          el: refEl,
          startClient: { x: e.clientX, y: e.clientY },
          startSvg,
          startHole,
          moved: false,
        };
        vp.setPointerCapture(e.pointerId);
        return;
      }
    }

    // Background drag pans; background click clears selection.
    panDragRef.current = {
      startClient: { x: e.clientX, y: e.clientY },
      startPan: pan,
      moved: false,
    };
    vp.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const vp = viewportRef.current;
    const svgEl = hostRef.current?.querySelector('svg');

    if (activeButtonPressRef.current) return;

    if (pinDragRef.current && vp) {
      const vpRect = vp.getBoundingClientRect();
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const hoverPinEl = findAttrEl(under, 'data-pin');
      const hoverPin = hoverPinEl?.getAttribute('data-pin') ?? undefined;
      const next: PinDragState = {
        ...pinDragRef.current,
        curX: e.clientX - vpRect.left,
        curY: e.clientY - vpRect.top,
        hoverPin: hoverPin !== pinDragRef.current.pinA ? hoverPin : undefined,
      };
      pinDragRef.current = next;
      setPinDrag(next);
      return;
    }

    const compDrag = compDragRef.current;
    if (compDrag && svgEl) {
      const dist = Math.hypot(e.clientX - compDrag.startClient.x, e.clientY - compDrag.startClient.y);
      if (dist > 4) compDrag.moved = true;
      if (compDrag.moved) {
        const curSvg = clientToSvg(svgEl, e.clientX, e.clientY);
        if (activeView === 'pcb') {
          const dxMm = snapMm((curSvg.x - compDrag.startSvg.x) / UNIT, PCB_SNAP_MM);
          const dyMm = snapMm((curSvg.y - compDrag.startSvg.y) / UNIT, PCB_SNAP_MM);
          compDrag.el.style.translate = `${dxMm * UNIT}px ${dyMm * UNIT}px`;
          const comp = query.component(compDrag.ref);
          const nextPlace = movePcbPlace(
            comp?.place.pcb,
            dxMm,
            dyMm,
            snapPointMm([curSvg.x / UNIT, curSvg.y / UNIT]),
          );
          setDragHud(`${compDrag.ref} → @pcb:${nextPlace}`);
        } else {
          const dxGrid = Math.round((curSvg.x - compDrag.startSvg.x) / UNIT);
          const dyGrid = Math.round((curSvg.y - compDrag.startSvg.y) / UNIT);
          compDrag.el.style.translate = `${dxGrid * UNIT}px ${dyGrid * UNIT}px`;
          if (activeView === 'sch') {
            const comp = query.component(compDrag.ref);
            const nextPlace = moveSchPlace(comp?.place.sch, dxGrid, dyGrid, snapToGrid(curSvg));
            setDragHud(`${compDrag.ref} → @sch:${nextPlace}`);
          } else {
            try {
              const hole = bbHoleAt(query, curSvg);
              setDragHud(hole ? `${compDrag.ref} → @bb:${hole}` : `${compDrag.ref} → off-board`);
            } catch {
              setDragHud(`${compDrag.ref} (${dxGrid},${dyGrid})`);
            }
          }
        }
      }
      return;
    }

    const panDrag = panDragRef.current;
    if (panDrag) {
      const dx = e.clientX - panDrag.startClient.x;
      const dy = e.clientY - panDrag.startClient.y;
      if (Math.hypot(dx, dy) > 3) panDrag.moved = true;
      if (panDrag.moved) {
        setPan({ x: panDrag.startPan.x + dx, y: panDrag.startPan.y + dy });
      }
      return;
    }

    // Active PCB routing cursor preview
    if (activeView === 'pcb' && svgEl) {
      const curSvg = clientToSvg(svgEl, e.clientX, e.clientY);
      const worldMm: [number, number] = [curSvg.x / UNIT, curSvg.y / UNIT];
      if (pcbRouteRef.current) {
        const curRoute = pcbRouteRef.current;
        const hoverPad = findPadAtWorldMm(worldMm, curRoute.netId, curRoute.activeLayer);
        setPcbRoute(prev => (prev ? updateRouteCursor(prev, worldMm, hoverPad) : null));
        setHoverPadHint(
          hoverPad
            ? `${padLabel(hoverPad)} (${hoverPad.net ?? 'nc'})`
            : undefined,
        );
        return;
      }
      const hoverPad = findPadAtWorldMm(worldMm);
      setHoverPadHint(
        hoverPad
          ? `Pad ${padLabel(hoverPad)}${hoverPad.net ? ` [${hoverPad.net}]` : ' (nc)'}`
          : undefined,
      );
      return;
    }

    // Hover feedback for breadboard holes.
    if (activeView === 'bb') {
      const hole = findAttrEl(e.target, 'data-hole')?.getAttribute('data-hole') ?? undefined;
      setHoverHole(hole);
    } else if (hoverHole !== undefined) {
      setHoverHole(undefined);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const vp = viewportRef.current;
    if (vp && vp.hasPointerCapture(e.pointerId)) {
      vp.releasePointerCapture(e.pointerId);
    }
    const svgEl = hostRef.current?.querySelector('svg');

    if (activeButtonPressRef.current) {
      const ref = activeButtonPressRef.current;
      activeButtonPressRef.current = null;
      onPressButton?.(ref, false);
      return;
    }

    if (pinDragRef.current) {
      const drag = pinDragRef.current;
      pinDragRef.current = null;
      setPinDrag(null);
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const targetPin = findAttrEl(under, 'data-pin')?.getAttribute('data-pin');
      if (targetPin && targetPin !== drag.pinA) {
        onConnectPins(drag.pinA, targetPin);
      }
      return;
    }

    if (compDragRef.current) {
      const drag = compDragRef.current;
      compDragRef.current = null;
      drag.el.style.translate = '';
      setDragHud(undefined);

      if (!drag.moved || !svgEl) {
        if (activeView === 'pcb' && drag.startPad) {
          beginRouteFromPad(drag.startPad);
          return;
        }
        onSelectTrack(undefined);
        onSelectRef(drag.ref);
        return;
      }

      onSelectTrack(undefined);
      onSelectRef(drag.ref);
      const endSvg = clientToSvg(svgEl, e.clientX, e.clientY);
      const comp = query.component(drag.ref);

      if (activeView === 'pcb') {
        const dxMm = snapMm((endSvg.x - drag.startSvg.x) / UNIT, PCB_SNAP_MM);
        const dyMm = snapMm((endSvg.y - drag.startSvg.y) / UNIT, PCB_SNAP_MM);
        if (dxMm !== 0 || dyMm !== 0 || !comp?.place.pcb) {
          const nextPlace = movePcbPlace(
            comp?.place.pcb,
            dxMm,
            dyMm,
            snapPointMm([endSvg.x / UNIT, endSvg.y / UNIT]),
          );
          onMovePart(drag.ref, 'pcb', nextPlace);
        }
      } else if (activeView === 'sch') {
        const dxGrid = Math.round((endSvg.x - drag.startSvg.x) / UNIT);
        const dyGrid = Math.round((endSvg.y - drag.startSvg.y) / UNIT);
        if (dxGrid !== 0 || dyGrid !== 0) {
          const nextPlace = moveSchPlace(comp?.place.sch, dxGrid, dyGrid, snapToGrid(endSvg));
          onMovePart(drag.ref, 'sch', nextPlace);
        }
      } else {
        try {
          const toHole = bbHoleAt(query, endSvg);
          if (toHole) {
            const nextPlace = shiftBbPlace(comp?.place.bb, drag.startHole, toHole);
            if (nextPlace !== comp?.place.bb) onMovePart(drag.ref, 'bb', nextPlace);
          } else {
            const offBoard = formatGridPlace(snapToGrid(endSvg));
            if (offBoard !== comp?.place.bb) onMovePart(drag.ref, 'bb', offBoard);
          }
        } catch (err) {
          onNotice(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }

    if (panDragRef.current) {
      const panDrag = panDragRef.current;
      panDragRef.current = null;
      if (!panDrag.moved) {
        if (activeView === 'pcb' && svgEl && !pcbRouteRef.current) {
          const endSvg = clientToSvg(svgEl, e.clientX, e.clientY);
          const worldMm: [number, number] = [endSvg.x / UNIT, endSvg.y / UNIT];
          const trackHit = hitTestTrack(
            query.circuit.pcb?.tracks ?? [],
            query,
            worldMm,
            visibleCopperLayers,
          );
          if (trackHit) {
            onSelectRef(undefined);
            onSelectTrack({
              netName: trackHit.netName,
              layer: trackHit.track.layer,
              index: trackHit.index,
            });
            return;
          }
        }
        onSelectTrack(undefined);
        onSelectRef(undefined);
      }
    }
  };

  const compsCount = query.components().length;
  const netsCount = query.nets().length;

  // Build viewport-pixel preview for active PCB route.
  const routeOverlay = useMemo(() => {
    if (activeView !== 'pcb' || !pcbRoute) return null;
    const svgEl = hostRef.current?.querySelector('svg');
    const vp = viewportRef.current;
    if (!svgEl || !vp) return null;

    const preview = previewRoutePaths(pcbRoute, PCB_SNAP_MM);
    const toVpPts = (pts: readonly [number, number][]) =>
      pts
        .map(([x, y]) => {
          const p = svgToViewport(svgEl, vp, x * UNIT, y * UNIT);
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(' ');

    return {
      widthPx: Math.max(2, pcbRoute.width * UNIT * zoom),
      viaRadiusPx: Math.max(4, (pcbRoute.viaSize / 2) * UNIT * zoom),
      viaHolePx: Math.max(2, (pcbRoute.viaDrill / 2) * UNIT * zoom),
      committed: preview.committed
        .filter(g => g.points.length >= 2)
        .map(g => ({ layer: g.layer, pointsStr: toVpPts(g.points) })),
      activeStr: preview.activePreview.length >= 2 ? toVpPts(preview.activePreview) : '',
      snappedToPad: preview.snappedToPad,
      vias: pcbRoute.vias.map(([x, y]) => svgToViewport(svgEl, vp, x * UNIT, y * UNIT)),
      activeLayer: pcbRoute.activeLayer,
    };
    // `pan` and `zoom` are read via SVG getScreenCTM(), so keep them in deps
  }, [activeView, pcbRoute, pan, zoom, rendered.svg]);

  const routeHudText = useMemo(() => {
    if (!pcbRoute) return undefined;
    const last = routeLastPoint(pcbRoute);
    const target = pcbRoute.hoverPad && isSameNetPad(pcbRoute, pcbRoute.hoverPad)
      ? isPadReachableOnLayer(pcbRoute.hoverPad, pcbRoute.activeLayer)
        ? ` → finish ${padLabel(pcbRoute.hoverPad)}`
        : ` → press V for via to ${pcbRoute.hoverPad.layers}`
      : '';
    return `Routing ${pcbRoute.netName} [${pcbRoute.activeLayer}, ${fmtMm(pcbRoute.width)}mm] @ ${fmtMm(last[0])},${fmtMm(last[1])}${target} · V via · Esc cancel`;
  }, [pcbRoute]);

  return (
    <main className="canvas-pane">
      <div className="canvas-toolbar">
        <div className="view-tabs" role="tablist" aria-label="Circuit views">
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'sch'}
            className={`view-tab ${activeView === 'sch' ? 'active' : ''}`}
            onClick={() => onViewChange('sch')}
          >
            Schematic
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'bb'}
            className={`view-tab ${activeView === 'bb' ? 'active' : ''}`}
            onClick={() => onViewChange('bb')}
          >
            Breadboard
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'pcb'}
            className={`view-tab ${activeView === 'pcb' ? 'active' : ''}`}
            onClick={() => onViewChange('pcb')}
          >
            PCB
          </button>
        </div>

        <div className="canvas-hint">
          {activeView === 'pcb'
            ? pcbRoute
              ? 'Click bend (45°/90°) · Click same-net pad to finish · V insert via · Esc cancel'
              : 'Click pad to route · Drag footprint (0.5mm) · R rotate · F flip · Click track + Del clear'
            : pressMode
              ? 'Press Mode active: hold any push button to press · toggle Press Mode off to drag'
              : `Click select · Drag move · Pin→Pin wire · ${activeView === 'sch' ? 'R rotate · ' : ''}Del remove · Alt+Click press button`}
        </div>

        <div className="zoom-controls">
          <button type="button" className="btn btn-sm" onClick={() => setZoom(z => Math.max(0.2, z / 1.2))} title="Zoom out">−</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-sm" onClick={() => setZoom(z => Math.min(6, z * 1.2))} title="Zoom in">+</button>
          <button type="button" className="btn btn-sm" onClick={fitView} title="Fit drawing to view">Fit</button>
        </div>
      </div>

      {activeView === 'pcb' && (
        <div className="pcb-toolbar">
          <div className="pcb-tool-group">
            <button
              type="button"
              className={`btn btn-sm ${pcbTool === 'select' && !pcbRoute ? 'btn-accent' : ''}`}
              onClick={() => { setPcbTool('select'); setPcbRoute(null); }}
              title="Select & drag footprints or click a pad to route"
            >
              Select
            </button>
            <button
              type="button"
              className={`btn btn-sm ${pcbTool === 'route' || pcbRoute ? 'btn-primary' : ''}`}
              onClick={() => setPcbTool(t => (t === 'route' ? 'select' : 'route'))}
              title="Interactive routing mode (Esc exits)"
            >
              Route
            </button>
            <button
              type="button"
              className={`pcb-active-layer layer-${pcbRoute?.activeLayer ?? activePcbLayer}`}
              onClick={() => {
                if (pcbRoute) {
                  const next = insertRouteVia(pcbRoute, undefined, PCB_SNAP_MM);
                  setPcbRoute(next);
                  onActivePcbLayerChange(next.activeLayer);
                } else {
                  onActivePcbLayerChange(activePcbLayer === 'F' ? 'B' : 'F');
                }
              }}
              title={pcbRoute ? 'Insert via and switch layer (V)' : 'Toggle active routing copper layer (F / B)'}
            >
              <span className="layer-dot" />
              Active: {pcbRoute?.activeLayer ?? activePcbLayer}
            </button>
          </div>

          <div className="pcb-layer-group" role="group" aria-label="PCB layers">
            {PCB_LAYER_ORDER.map(layer => (
              <button
                key={layer}
                type="button"
                className={`layer-pill ${pcbLayers[layer] ? 'on' : ''} layer-pill-${layer}`}
                aria-pressed={pcbLayers[layer]}
                onClick={() => onTogglePcbLayer(layer)}
                title={`Toggle ${LAYER_LABELS[layer]} visibility`}
              >
                {(layer === 'F' || layer === 'B') && <span className="layer-dot" />}
                {LAYER_LABELS[layer]}
              </button>
            ))}
          </div>

          <div className="pcb-action-group">
            <button
              type="button"
              className="btn btn-sm"
              disabled={Boolean(pcbBusy)}
              onClick={onAutoPlacePcb}
              title="Auto-place footprints (layout view=pcb)"
            >
              {pcbBusy === 'autoplace' ? 'Placing…' : 'Auto-place'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-accent"
              disabled={Boolean(pcbBusy)}
              onClick={onAutoroutePcb}
              title="Autoroute unrouted nets (layout view=pcb op=route)"
            >
              {pcbBusy === 'route' ? 'Routing…' : 'Autoroute'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={Boolean(pcbBusy)}
              onClick={onExportFab}
              title="Export Gerber + drill + BOM/PnP fab zip (export format=fab)"
            >
              {pcbBusy === 'export' ? 'Exporting…' : 'Export Fab'}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${drcCount.errors > 0 ? 'btn-danger' : ''}`}
              onClick={onOpenDrcPanel}
              title="Open DRC issues panel"
            >
              {drcCount.pending
                ? 'DRC: pending'
                : `DRC: ${drcCount.errors}E/${drcCount.warns}W`}
            </button>
          </div>
        </div>
      )}

      {activeView === 'pcb' && exportedPath && (
        <div className="pcb-export-banner">
          <span>Exported fab zip:</span>
          <code className="pcb-export-path">{exportedPath}</code>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss export path"
            onClick={onClearExportedPath}
          >
            ×
          </button>
        </div>
      )}

      <div
        ref={viewportRef}
        className={`canvas-viewport ${spaceDown ? 'pan-cursor' : ''} ${activeView === 'pcb' && (pcbRoute || pcbTool === 'route') ? 'route-cursor' : ''}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={e => {
          if (activeView === 'pcb' && pcbRouteRef.current) e.preventDefault();
        }}
      >
        {rendered.error ? (
          <div className="canvas-error-card">
            <div className="canvas-error-title">
              {activeView === 'sch' ? 'Schematic' : activeView === 'bb' ? 'Breadboard' : 'PCB'} renderer unavailable
            </div>
            <pre className="canvas-error-msg">{rendered.error}</pre>
            <div className="canvas-error-meta">
              Circuit loaded: {compsCount} {compsCount === 1 ? 'component' : 'components'}, {netsCount} {netsCount === 1 ? 'net' : 'nets'}.
              You can edit via CNL, Inspector, or Sim/Check while view renderers are loading.
            </div>
          </div>
        ) : (
          <div
            className="canvas-stage"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <div
              ref={hostRef}
              className="canvas-svg-host"
              dangerouslySetInnerHTML={{ __html: rendered.svg }}
            />
          </div>
        )}

        {pinDrag && (
          <svg className="canvas-overlay" aria-hidden="true">
            <line
              x1={pinDrag.startX}
              y1={pinDrag.startY}
              x2={pinDrag.curX}
              y2={pinDrag.curY}
              className={`wire-preview ${pinDrag.hoverPin ? 'snapped' : ''}`}
            />
          </svg>
        )}

        {routeOverlay && (
          <svg className="canvas-overlay" aria-hidden="true">
            {routeOverlay.committed.map((seg, i) => (
              <polyline
                key={i}
                points={seg.pointsStr}
                fill="none"
                stroke={seg.layer === 'F' ? '#ef4444' : '#3b82f6'}
                strokeWidth={routeOverlay.widthPx}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {routeOverlay.activeStr && (
              <polyline
                points={routeOverlay.activeStr}
                fill="none"
                stroke={routeOverlay.snappedToPad ? '#22c55e' : routeOverlay.activeLayer === 'F' ? '#ef4444' : '#3b82f6'}
                strokeWidth={routeOverlay.widthPx}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={routeOverlay.snappedToPad ? undefined : '6 4'}
              />
            )}
            {routeOverlay.vias.map((pt, i) => (
              <g key={i}>
                <circle cx={pt.x} cy={pt.y} r={routeOverlay.viaRadiusPx} fill="#eab308" stroke="#111827" strokeWidth={1} />
                <circle cx={pt.x} cy={pt.y} r={routeOverlay.viaHolePx} fill="#111827" />
              </g>
            ))}
          </svg>
        )}

        {(routeHudText || dragHud || hoverHole || hoverPadHint || pinDrag || (activeView === 'pcb' && selectedTrack)) && (
          <div className="canvas-hud">
            {pinDrag
              ? `Wire ${pinDrag.pinA} → ${pinDrag.hoverPin ?? '…'}`
              : routeHudText
                ?? dragHud
                ?? (selectedTrack
                  ? `Selected net ${selectedTrack.netName} (${selectedTrack.layer}) · Del to remove copper (-tracks ${selectedTrack.netName})`
                  : hoverPadHint ?? (hoverHole ? `Hole ${hoverHole}` : ''))}
          </div>
        )}
      </div>
    </main>
  );
}
