// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Query } from '@cadllm/core';
import { UNIT, VIEWS, bbHoleAt, type Pt, type ViewId } from '@cadllm/views';
import {
  formatGridPlace,
  moveSchPlace,
  shiftBbPlace,
  snapToGrid,
} from '../lib/place.ts';

interface CanvasViewProps {
  query: Query;
  activeView: ViewId;
  theme: 'light' | 'dark';
  selectedRef: string | undefined;
  highlight: string[];
  onViewChange: (view: ViewId) => void;
  onSelectRef: (ref: string | undefined) => void;
  onMovePart: (ref: string, view: ViewId, placeStr: string) => void;
  onConnectPins: (pinA: string, pinB: string) => void;
  onViewportCenterChange: (gridPt: Pt) => void;
  onNotice: (msg: string) => void;
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

function findAttrEl(target: EventTarget | null, attr: string): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest(`[${attr}]`);
}

export function CanvasView({
  query,
  activeView,
  theme,
  selectedRef,
  highlight,
  onViewChange,
  onSelectRef,
  onMovePart,
  onConnectPins,
  onViewportCenterChange,
  onNotice,
}: CanvasViewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoom] = useState(1.5);
  const [pan, setPan] = useState<Pt>({ x: 40, y: 40 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [hoverHole, setHoverHole] = useState<string | undefined>(undefined);
  const [dragHud, setDragHud] = useState<string | undefined>(undefined);
  const [pinDrag, setPinDrag] = useState<PinDragState | null>(null);

  const compDragRef = useRef<CompDragState | null>(null);
  const panDragRef = useRef<PanDragState | null>(null);
  const pinDragRef = useRef<PinDragState | null>(null);

  const rendered = useMemo(() => {
    try {
      const svg = VIEWS[activeView].render(query, {
        ...(highlight.length > 0 ? { highlight } : {}),
        theme,
      });
      return { svg, error: undefined };
    } catch (err) {
      return {
        svg: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [query, activeView, highlight, theme]);

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
  }, [rendered.svg, selectedRef]);

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

  // Track Space key for pan-anywhere mode.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        setSpaceDown(true);
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
  }, []);

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

    if (e.button !== 0) return;

    const pinEl = findAttrEl(e.target, 'data-pin');
    if (pinEl) {
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

    if (pinDragRef.current && vp) {
      const vpRect = vp.getBoundingClientRect();
      // Temporarily look up element under pointer; overlay SVG has pointer-events: none.
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
        onSelectRef(drag.ref);
        return;
      }

      onSelectRef(drag.ref);
      const endSvg = clientToSvg(svgEl, e.clientX, e.clientY);
      const comp = query.component(drag.ref);

      if (activeView === 'sch') {
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
      if (!panDrag.moved) onSelectRef(undefined);
    }
  };

  const compsCount = query.components().length;
  const netsCount = query.nets().length;

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
        </div>

        <div className="canvas-hint">
          Click select · Drag move · Pin→Pin wire · {activeView === 'sch' ? 'R rotate · ' : ''}Del remove · Drag bg pan
        </div>

        <div className="zoom-controls">
          <button type="button" className="btn btn-sm" onClick={() => setZoom(z => Math.max(0.2, z / 1.2))} title="Zoom out">−</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-sm" onClick={() => setZoom(z => Math.min(6, z * 1.2))} title="Zoom in">+</button>
          <button type="button" className="btn btn-sm" onClick={fitView} title="Fit drawing to view">Fit</button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className={`canvas-viewport ${spaceDown ? 'pan-cursor' : ''}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {rendered.error ? (
          <div className="canvas-error-card">
            <div className="canvas-error-title">
              {activeView === 'sch' ? 'Schematic' : 'Breadboard'} renderer unavailable
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

        {(dragHud || hoverHole || pinDrag) && (
          <div className="canvas-hud">
            {pinDrag
              ? `Wire ${pinDrag.pinA} → ${pinDrag.hoverPin ?? '…'}`
              : dragHud ?? `Hole ${hoverHole}`}
          </div>
        )}
      </div>
    </main>
  );
}
