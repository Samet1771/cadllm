// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Query, emptyCircuit, type PartDef } from '@cadllm/core';
import { UNIT, bbHoleAt, type Pt, type ViewId } from '@cadllm/views';
import { BottomPanel } from './components/BottomPanel.tsx';
import { CanvasView } from './components/CanvasView.tsx';
import { Inspector } from './components/Inspector.tsx';
import { PartPicker } from './components/PartPicker.tsx';
import { ToastContainer } from './components/ToastContainer.tsx';
import { TopBar } from './components/TopBar.tsx';
import {
  OwnChangeTracker,
  deltaToHighlight,
  formatChangeToast,
} from './lib/delta.ts';
import {
  buildPartResolver,
  parseFindOutput,
  parseRevFromText,
  stripReadHeader,
  type FindHit,
} from './lib/parts.ts';
import {
  buildConnectCnl,
  formatPlaceEdit,
  nextAutoRef,
  rotateSchPlace,
} from './lib/place.ts';
import { RpcClient } from './lib/rpc.ts';
import {
  buildRunCommand,
  defaultProbesForQuery,
  deriveRenderState,
  findButtonRefs,
  findMcuRefs,
  parsePressIntervals,
  parseReadCodeOutput,
  parseTransitionTable,
  type ParsedSimTrace,
} from './lib/sim.ts';
import type {
  ActivityEntry,
  ChangedNotification,
  ConnectionStatus,
  RpcApi,
  StateResponse,
  ThemePreference,
  ToastMessage,
} from './lib/types.ts';

const EMPTY_STATE: StateResponse = {
  project: 'untitled',
  rev: 0,
  projects: [],
  circuit: emptyCircuit(),
  parts: {},
};

function nowStamp(): string {
  return new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function App() {
  const isDemo = useMemo(() => new URLSearchParams(window.location.search).has('demo'), []);

  const [status, setStatus] = useState<ConnectionStatus>(isDemo ? 'demo' : 'connecting');
  const [state, setState] = useState<StateResponse>(EMPTY_STATE);
  const [libraryParts, setLibraryParts] = useState<PartDef[]>([]);
  const [activeView, setActiveView] = useState<ViewId>('sch');
  const [selectedRef, setSelectedRef] = useState<string | undefined>(undefined);
  const [highlight, setHighlight] = useState<string[]>([]);

  const [themePref, setThemePref] = useState<ThemePreference>('system');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  const [partQuery, setPartQuery] = useState('');
  const [partHits, setPartHits] = useState<FindHit[]>([]);
  const [partsLoading, setPartsLoading] = useState(false);
  const [partsEmptyMsg, setPartsEmptyMsg] = useState<string | undefined>(undefined);

  const [cnlText, setCnlText] = useState('');
  const [cnlDirty, setCnlDirty] = useState(false);

  const [targetMcuRef, setTargetMcuRef] = useState<string | undefined>(undefined);
  const [codeText, setCodeText] = useState('');
  const [codeDirty, setCodeDirty] = useState(false);
  const [codeLoading, setCodeLoading] = useState(false);

  const [checkOutput, setCheckOutput] = useState('');
  const [simOutput, setSimOutput] = useState('');
  const [simRunning, setSimRunning] = useState(false);
  const [runDuration, setRunDuration] = useState('4s');
  const [runPress, setRunPress] = useState('');
  const [runProbes, setRunProbes] = useState('');
  const [simTrace, setSimTrace] = useState<ParsedSimTrace | null>(null);
  const [playTime, setPlayTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopPlay, setLoopPlay] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [pressMode, setPressMode] = useState(false);
  const [manualPressed, setManualPressed] = useState<Set<string>>(() => new Set());

  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const rpcRef = useRef<RpcApi | null>(null);
  const demoSimRef = useRef<(() => void) | null>(null);
  const ownTrackerRef = useRef(new OwnChangeTracker());
  const nextIdRef = useRef(1);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportCenterRef = useRef<Pt>({ x: 12, y: 8 });
  const cnlDirtyRef = useRef(cnlDirty);
  cnlDirtyRef.current = cnlDirty;
  const codeDirtyRef = useRef(codeDirty);
  codeDirtyRef.current = codeDirty;
  const projectRef = useRef(state.project);
  projectRef.current = state.project;

  const effectiveTheme: 'light' | 'dark' =
    themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
  }, [effectiveTheme]);

  const resolver = useMemo(
    () => buildPartResolver(libraryParts, state.parts),
    [libraryParts, state.parts],
  );
  const query = useMemo(() => new Query(state.circuit, resolver), [state.circuit, resolver]);
  const mcuRefs = useMemo(() => findMcuRefs(query), [query]);
  const buttonRefs = useMemo(() => findButtonRefs(query), [query]);
  const defaultProbes = useMemo(() => defaultProbesForQuery(query), [query]);

  const activeMcuRef = useMemo(() => {
    if (mcuRefs.length === 0) return undefined;
    if (selectedRef) {
      const selMatch = mcuRefs.find(r => r.toUpperCase() === selectedRef.toUpperCase());
      if (selMatch) return selMatch;
    }
    if (targetMcuRef) {
      const tgtMatch = mcuRefs.find(r => r.toUpperCase() === targetMcuRef.toUpperCase());
      if (tgtMatch) return tgtMatch;
    }
    return mcuRefs[0];
  }, [mcuRefs, selectedRef, targetMcuRef]);

  const activeMcuRefRef = useRef(activeMcuRef);
  activeMcuRefRef.current = activeMcuRef;

  const pushToast = useCallback((text: string, source: ToastMessage['source'] = 'ui') => {
    const id = nextIdRef.current++;
    setToasts(prev => [...prev.slice(-3), { id, text, source }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4200);
  }, []);

  const pushActivity = useCallback(
    (text: string, source: ActivityEntry['source'], rev?: number, kind: ActivityEntry['kind'] = 'change') => {
      const id = nextIdRef.current++;
      setActivity(prev => [{ id, time: nowStamp(), source, text, kind, ...(rev !== undefined ? { rev } : {}) }, ...prev].slice(0, 100));
    },
    [],
  );

  const triggerExternalHighlight = useCallback((notifications: ChangedNotification[]) => {
    if (notifications.length === 0) return;
    const extraCodeRefs = notifications.flatMap(n => {
      const m = n.summary.match(/\bcode\s+([A-Za-z0-9_]+)/i);
      return m ? [m[1]!] : [];
    });
    const allItems = [...notifications.flatMap(n => deltaToHighlight(n.delta)), ...extraCodeRefs];
    if (allItems.length > 0) {
      setHighlight([...new Set(allItems)]);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => {
        setHighlight([]);
        highlightTimerRef.current = null;
      }, 3000);
    }
    for (const n of notifications) {
      pushToast(formatChangeToast(n), n.source);
    }
  }, [pushToast]);

  const loadMcuCode = useCallback(async (ref: string, force = false) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    if (!force && codeDirtyRef.current) return;
    setCodeLoading(true);
    try {
      const res = await rpc.call<string>('read', { code: ref });
      setCodeText(parseReadCodeOutput(res, ref));
      setCodeDirty(false);
    } catch {
      // Ignore if component was just removed
    } finally {
      setCodeLoading(false);
    }
  }, []);

  const refreshWorkspace = useCallback(async (forceSync = false) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    try {
      const nextState = await rpc.state();
      setState(nextState);
      const [readRes, checkRes] = await Promise.all([
        rpc.call<string>('read', { detail: 1, place: true }),
        rpc.call<string>('check', {}),
      ]);
      setCheckOutput(checkRes);
      if (forceSync || !cnlDirtyRef.current) {
        setCnlText(stripReadHeader(readRes));
        setCnlDirty(false);
      }
      const mcu = activeMcuRefRef.current;
      if (mcu && (forceSync || !codeDirtyRef.current)) {
        const codeRes = await rpc.call<string>('read', { code: mcu });
        setCodeText(parseReadCodeOutput(codeRes, mcu));
        setCodeDirty(false);
      }
    } catch (err) {
      pushActivity(err instanceof Error ? err.message : String(err), 'ui', undefined, 'error');
    }
  }, [pushActivity]);

  // Reload code when active MCU selection or connection settles.
  useEffect(() => {
    if (status === 'connecting' || status === 'disconnected') return;
    if (!activeMcuRef) {
      setCodeText('');
      setCodeDirty(false);
      return;
    }
    void loadMcuCode(activeMcuRef, true);
  }, [activeMcuRef, state.project, status, loadMcuCode]);

  const handleChanged = useCallback((n: ChangedNotification) => {
    const summary = n.summary || n.label || '(updated)';
    pushActivity(`${n.project}: ${summary}`, n.source, n.rev, 'change');
    const external = ownTrackerRef.current.onChanged(n);
    if (external.length > 0) {
      triggerExternalHighlight(external);
    }
    if (n.project === projectRef.current) {
      void refreshWorkspace(false);
    } else {
      void rpcRef.current?.state().then(setState).catch(() => undefined);
    }
  }, [pushActivity, refreshWorkspace, triggerExternalHighlight]);

  // Initialize connection (live WebSocket or ?demo).
  useEffect(() => {
    let disposed = false;

    if (isDemo) {
      void import('./lib/demo.ts').then(async ({ createDemoBackend }) => {
        if (disposed) return;
        const demo = createDemoBackend();
        rpcRef.current = demo;
        demoSimRef.current = () => demo.simulateAiEdit();
        demo.onChanged(handleChanged);
        const libs = await demo.library();
        if (disposed) return;
        setLibraryParts(libs);
        await refreshWorkspace(true);
      });
      return () => {
        disposed = true;
      };
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    const client = new RpcClient({
      url: wsUrl,
      onStatusChange: next => {
        if (!disposed) setStatus(next);
      },
    });
    rpcRef.current = client;

    const unsubChanged = client.onNotification<ChangedNotification>('changed', handleChanged);
    const unsubProjects = client.onNotification('projects', () => {
      void client.state().then(setState).catch(() => undefined);
    });

    const bootstrap = async () => {
      try {
        await client.connect();
        if (disposed) return;
        const libs = await client.library();
        if (disposed) return;
        setLibraryParts(libs);
        await refreshWorkspace(true);
      } catch (err) {
        if (!disposed) {
          pushActivity(`Connection failed: ${err instanceof Error ? err.message : String(err)}`, 'ui', undefined, 'error');
        }
      }
    };
    void bootstrap();

    return () => {
      disposed = true;
      unsubChanged();
      unsubProjects();
      client.close();
    };
  }, [handleChanged, isDemo, pushActivity, refreshWorkspace]);

  // Search parts via `find` RPC whenever search query or connection settles.
  useEffect(() => {
    if (status === 'connecting' || status === 'disconnected') return;
    const timer = setTimeout(() => {
      const rpc = rpcRef.current;
      if (!rpc) return;
      setPartsLoading(true);
      void rpc
        .call<string>('find', { q: partQuery, limit: 30 })
        .then(text => {
          const parsed = parseFindOutput(text, resolver);
          setPartHits(parsed);
          setPartsEmptyMsg(parsed.length === 0 ? text : undefined);
        })
        .catch(err => {
          setPartHits([]);
          setPartsEmptyMsg(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setPartsLoading(false));
    }, 120);
    return () => clearTimeout(timer);
  }, [partQuery, resolver, status]);

  // Real-time simulation playback timer.
  useEffect(() => {
    if (!isPlaying || !simTrace) return;
    let rafId = 0;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - lastTs) / 1000)) * playSpeed;
      lastTs = now;
      setPlayTime(prev => {
        const next = prev + dt;
        if (next >= simTrace.duration) {
          if (loopPlay && simTrace.duration > 0) {
            return next % simTrace.duration;
          }
          setIsPlaying(false);
          return simTrace.duration;
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, loopPlay, playSpeed, simTrace]);

  const pressIntervals = useMemo(() => parsePressIntervals(runPress), [runPress]);
  const simState = useMemo(
    () => deriveRenderState(query, simTrace, playTime, pressIntervals, manualPressed),
    [query, simTrace, playTime, pressIntervals, manualPressed],
  );

  const runMutation = useCallback(async (method: string, params: Record<string, unknown>, syncCnl = false): Promise<string | undefined> => {
    const rpc = rpcRef.current;
    if (!rpc) return undefined;
    ownTrackerRef.current.beginMutation();
    try {
      const res = await rpc.call<string>(method, params);
      const rev = parseRevFromText(res);
      const bufferedExternal = ownTrackerRef.current.endMutation(rev);
      if (bufferedExternal.length > 0) {
        triggerExternalHighlight(bufferedExternal);
      }
      await refreshWorkspace(syncCnl);
      return res;
    } catch (err) {
      const bufferedExternal = ownTrackerRef.current.endMutation(undefined);
      if (bufferedExternal.length > 0) {
        triggerExternalHighlight(bufferedExternal);
      }
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(msg, 'ui');
      pushActivity(msg, 'ui', undefined, 'error');
      return undefined;
    }
  }, [pushActivity, pushToast, refreshWorkspace, triggerExternalHighlight]);

  const handleMovePart = useCallback((ref: string, view: ViewId, placeStr: string) => {
    void runMutation('edit', { cnl: formatPlaceEdit(ref, view, placeStr) });
  }, [runMutation]);

  const handleConnectPins = useCallback((pinA: string, pinB: string) => {
    try {
      const cnl = buildConnectCnl(query, pinA, pinB);
      if (!cnl) return;
      void runMutation('edit', { cnl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(msg, 'ui');
    }
  }, [pushToast, query, runMutation]);

  const handleRotate = useCallback((ref: string) => {
    const comp = query.component(ref);
    if (!comp) return;
    const next = rotateSchPlace(comp.place.sch, 90);
    void runMutation('edit', { cnl: formatPlaceEdit(comp.ref, 'sch', next) });
  }, [query, runMutation]);

  const handleDelete = useCallback((ref: string) => {
    void runMutation('edit', { cnl: `-${ref}` }).then(res => {
      if (res !== undefined) setSelectedRef(undefined);
    });
  }, [runMutation]);

  const handleAddPart = useCallback((hit: FindHit) => {
    const prefix = hit.part?.refPrefix ?? 'X';
    const ref = nextAutoRef(prefix, query.components().map(c => c.ref));
    const center = viewportCenterRef.current;
    let placeToken = '';
    if (activeView === 'sch') {
      placeToken = ` @sch:${center.x},${center.y}`;
    } else {
      try {
        const hole = bbHoleAt(query, { x: center.x * UNIT, y: center.y * UNIT });
        if (hole) placeToken = ` @bb:${hole}`;
      } catch {
        // bbHoleAt stub may not be implemented yet
      }
    }
    void runMutation('edit', { cnl: `${ref} ${hit.id}${placeToken}` }).then(res => {
      if (res !== undefined) setSelectedRef(ref);
    });
  }, [activeView, query, runMutation]);

  const handlePatchProp = useCallback((ref: string, key: string, value: string) => {
    const trimmed = value.trim();
    const quoted = /[\s;#"]/.test(trimmed) ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed;
    const cnl = `~${ref} ${key}=${quoted}`;
    void runMutation('edit', { cnl });
  }, [runMutation]);

  const handleDisconnectPin = useCallback((netName: string, pinLabel: string) => {
    void runMutation('edit', { cnl: `-${netName}: ${pinLabel}` });
  }, [runMutation]);

  const handleApplyCnl = useCallback(() => {
    const trimmed = cnlText.trim();
    if (!trimmed) return;
    void runMutation('edit', { cnl: trimmed }, true);
  }, [cnlText, runMutation]);

  const handleSyncCnl = useCallback(() => {
    void refreshWorkspace(true);
  }, [refreshWorkspace]);

  const handleSaveCode = useCallback(() => {
    if (!activeMcuRef) return;
    void runMutation('edit', { code: { ref: activeMcuRef, text: codeText } }).then(res => {
      if (res !== undefined) {
        setCodeDirty(false);
        pushToast(`Saved ${activeMcuRef} sketch`, 'ui');
      }
    });
  }, [activeMcuRef, codeText, pushToast, runMutation]);

  const handleSyncCode = useCallback(() => {
    if (!activeMcuRef) return;
    void loadMcuCode(activeMcuRef, true);
  }, [activeMcuRef, loadMcuCode]);

  const handleUndo = useCallback(() => {
    void runMutation('history', { op: 'undo' }, true);
  }, [runMutation]);

  const handleRedo = useCallback(() => {
    void runMutation('history', { op: 'redo' }, true);
  }, [runMutation]);

  const handleAutoLayout = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    ownTrackerRef.current.beginMutation();
    try {
      const res = await rpc.call<string>('layout', { view: activeView });
      const rev = parseRevFromText(res);
      const buffered = ownTrackerRef.current.endMutation(rev);
      if (buffered.length > 0) triggerExternalHighlight(buffered);
      pushToast(res, 'ui');
      pushActivity(res, 'ui', rev, 'info');
      await refreshWorkspace(false);
    } catch (err) {
      ownTrackerRef.current.endMutation(undefined);
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(msg, 'ui');
      pushActivity(msg, 'ui', undefined, 'error');
    }
  }, [activeView, pushActivity, pushToast, refreshWorkspace, triggerExternalHighlight]);

  const handleProjectCmd = useCallback(async (params: Record<string, unknown>) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    try {
      const res = await rpc.call<string>('project', params);
      pushActivity(res, 'ui', parseRevFromText(res), 'info');
      setSelectedRef(undefined);
      setSimTrace(null);
      setIsPlaying(false);
      setPlayTime(0);
      await refreshWorkspace(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast(msg, 'ui');
      pushActivity(msg, 'ui', undefined, 'error');
    }
  }, [pushActivity, pushToast, refreshWorkspace]);

  const handleRunSim = useCallback(async (run: string) => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    setSimRunning(true);
    try {
      const res = await rpc.call<string>('sim', { run });
      setSimOutput(res);
      const parsed = parseTransitionTable(res);
      if (parsed) {
        setSimTrace(parsed);
        setPlayTime(0);
        setIsPlaying(true);
      } else {
        setIsPlaying(false);
      }
    } catch (err) {
      setSimOutput(`error: ${err instanceof Error ? err.message : String(err)}`);
      setIsPlaying(false);
    } finally {
      setSimRunning(false);
    }
  }, []);

  const handleRunTransient = useCallback(() => {
    const probes = runProbes.trim() || defaultProbes.join(',');
    const cmd = buildRunCommand({ duration: runDuration, press: runPress, probes });
    void handleRunSim(cmd);
  }, [defaultProbes, handleRunSim, runDuration, runPress, runProbes]);

  const handleManualPress = useCallback((ref: string, down: boolean) => {
    const up = ref.toUpperCase();
    setManualPressed(prev => {
      const has = prev.has(up);
      if (down === has) return prev;
      const next = new Set(prev);
      if (down) next.add(up);
      else next.delete(up);
      return next;
    });
  }, []);

  const handleRunCheck = useCallback(async () => {
    const rpc = rpcRef.current;
    if (!rpc) return;
    try {
      const res = await rpc.call<string>('check', {});
      setCheckOutput(res);
    } catch (err) {
      setCheckOutput(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Global keyboard shortcuts (R rotate, Del remove, Ctrl+Z/Y undo/redo).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && (target.isContentEditable || target.closest('.cm-editor')))
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'r') {
        if (activeView === 'sch' && selectedRef) {
          e.preventDefault();
          handleRotate(selectedRef);
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedRef) {
          e.preventDefault();
          handleDelete(selectedRef);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeView, handleDelete, handleRedo, handleRotate, handleUndo, selectedRef]);

  return (
    <div className="app-shell">
      <TopBar
        projectName={state.project}
        rev={state.rev}
        projects={state.projects}
        status={status}
        themePref={themePref}
        isDemo={isDemo}
        onThemePrefChange={setThemePref}
        onSelectProject={name => void handleProjectCmd({ op: 'use', name })}
        onNewProject={name => void handleProjectCmd({ op: 'new', ...(name ? { name } : {}) })}
        onOpenProject={path => void handleProjectCmd({ op: 'open', path })}
        onSaveProject={path => void handleProjectCmd({ op: 'save', ...(path ? { path } : {}) })}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAutoLayout={() => void handleAutoLayout()}
        onReconnect={() => {
          if (rpcRef.current instanceof RpcClient) {
            void rpcRef.current.connect().then(() => refreshWorkspace(true));
          }
        }}
        onSimulateAiEdit={demoSimRef.current ?? undefined}
      />

      <div className="workspace-grid">
        <PartPicker
          query={partQuery}
          hits={partHits}
          loading={partsLoading}
          emptyMessage={partsEmptyMsg}
          onQueryChange={setPartQuery}
          onAddPart={handleAddPart}
        />

        <CanvasView
          query={query}
          activeView={activeView}
          theme={effectiveTheme}
          selectedRef={selectedRef}
          highlight={highlight}
          simState={simState}
          pressMode={pressMode}
          onViewChange={setActiveView}
          onSelectRef={setSelectedRef}
          onMovePart={handleMovePart}
          onConnectPins={handleConnectPins}
          onViewportCenterChange={pt => { viewportCenterRef.current = pt; }}
          onNotice={msg => pushToast(msg, 'ui')}
          onPressButton={handleManualPress}
        />

        <Inspector
          query={query}
          activeView={activeView}
          selectedRef={selectedRef}
          theme={effectiveTheme}
          cnlText={cnlText}
          cnlDirty={cnlDirty}
          projectHeader={`${state.project} rev=${state.rev}`}
          mcuRefs={mcuRefs}
          activeMcuRef={activeMcuRef}
          codeText={codeText}
          codeDirty={codeDirty}
          codeLoading={codeLoading}
          onSelectMcuRef={ref => setTargetMcuRef(ref)}
          onCodeChange={text => { setCodeText(text); setCodeDirty(true); }}
          onSaveCode={handleSaveCode}
          onSyncCode={handleSyncCode}
          onCnlChange={text => { setCnlText(text); setCnlDirty(true); }}
          onApplyCnl={handleApplyCnl}
          onSyncCnl={handleSyncCnl}
          onPatchProp={handlePatchProp}
          onRotate={handleRotate}
          onDelete={handleDelete}
          onDisconnectPin={handleDisconnectPin}
        />
      </div>

      <BottomPanel
        checkOutput={checkOutput}
        simOutput={simOutput}
        simRunning={simRunning}
        activity={activity}
        hasMcu={mcuRefs.length > 0}
        buttonRefs={buttonRefs}
        runDuration={runDuration}
        runPress={runPress}
        runProbes={runProbes}
        defaultProbes={defaultProbes}
        trace={simTrace}
        playTime={playTime}
        isPlaying={isPlaying}
        loopPlay={loopPlay}
        playSpeed={playSpeed}
        pressMode={pressMode}
        manualPressed={manualPressed}
        onRunDurationChange={setRunDuration}
        onRunPressChange={setRunPress}
        onRunProbesChange={setRunProbes}
        onRunTransient={handleRunTransient}
        onRunSim={cmd => void handleRunSim(cmd)}
        onRunCheck={() => void handleRunCheck()}
        onPlayToggle={() => {
          if (!simTrace) return;
          if (!isPlaying && playTime >= simTrace.duration) setPlayTime(0);
          setIsPlaying(p => !p);
        }}
        onStopPlayback={() => { setIsPlaying(false); setPlayTime(0); }}
        onSeek={t => { setIsPlaying(false); setPlayTime(t); }}
        onLoopChange={setLoopPlay}
        onSpeedChange={setPlaySpeed}
        onPressModeChange={setPressMode}
        onManualPress={handleManualPress}
      />

      <ToastContainer
        toasts={toasts}
        onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))}
      />
    </div>
  );
}
