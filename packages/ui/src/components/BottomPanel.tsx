// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useState, type FormEvent } from 'react';
import type { ParsedSimTrace } from '../lib/sim.ts';
import type { ActivityEntry } from '../lib/types.ts';

interface BottomPanelProps {
  checkOutput: string;
  simOutput: string;
  simRunning: boolean;
  activity: ActivityEntry[];
  hasMcu: boolean;
  buttonRefs: string[];
  runDuration: string;
  runPress: string;
  runProbes: string;
  defaultProbes: string[];
  trace: ParsedSimTrace | null;
  playTime: number;
  isPlaying: boolean;
  loopPlay: boolean;
  playSpeed: number;
  pressMode: boolean;
  manualPressed: Set<string>;
  onRunDurationChange: (v: string) => void;
  onRunPressChange: (v: string) => void;
  onRunProbesChange: (v: string) => void;
  onRunTransient: () => void;
  onRunSim: (run: string) => void;
  onRunCheck: () => void;
  onPlayToggle: () => void;
  onStopPlayback: () => void;
  onSeek: (t: number) => void;
  onLoopChange: (loop: boolean) => void;
  onSpeedChange: (speed: number) => void;
  onPressModeChange: (enabled: boolean) => void;
  onManualPress: (ref: string, down: boolean) => void;
}

export function BottomPanel({
  checkOutput,
  simOutput,
  simRunning,
  activity,
  hasMcu,
  buttonRefs,
  runDuration,
  runPress,
  runProbes,
  defaultProbes,
  trace,
  playTime,
  isPlaying,
  loopPlay,
  playSpeed,
  pressMode,
  manualPressed,
  onRunDurationChange,
  onRunPressChange,
  onRunProbesChange,
  onRunTransient,
  onRunSim,
  onRunCheck,
  onPlayToggle,
  onStopPlayback,
  onSeek,
  onLoopChange,
  onSpeedChange,
  onPressModeChange,
  onManualPress,
}: BottomPanelProps) {
  const [tab, setTab] = useState<'console' | 'serial' | 'activity'>('console');
  const [simInput, setSimInput] = useState('dc');

  const serialEntries = trace ? Object.entries(trace.serial) : [];

  const submitSim = (e: FormEvent) => {
    e.preventDefault();
    const cmd = simInput.trim();
    if (!cmd) return;
    onRunSim(cmd);
  };

  const togglePressSnippet = (ref: string) => {
    const tokens = runPress.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const has = tokens.some(t => t.toUpperCase().startsWith(`${ref.toUpperCase()}@`) || t.toUpperCase() === ref.toUpperCase());
    const next = has
      ? tokens.filter(t => !t.toUpperCase().startsWith(`${ref.toUpperCase()}@`) && t.toUpperCase() !== ref.toUpperCase())
      : [...tokens, `${ref}@0.5s-1.5s`];
    onRunPressChange(next.join(','));
  };

  return (
    <footer className="bottom-panel">
      <div className="bottom-header">
        <div className="view-tabs">
          <button
            type="button"
            className={`view-tab ${tab === 'console' ? 'active' : ''}`}
            onClick={() => setTab('console')}
          >
            Sim &amp; Check
          </button>
          <button
            type="button"
            className={`view-tab ${tab === 'serial' ? 'active' : ''}`}
            onClick={() => setTab('serial')}
          >
            Serial{serialEntries.length > 0 ? ` (${serialEntries.length})` : ''}
          </button>
          <button
            type="button"
            className={`view-tab ${tab === 'activity' ? 'active' : ''}`}
            onClick={() => setTab('activity')}
          >
            Activity ({activity.length})
          </button>
        </div>

        {tab === 'console' && (
          <div className="sim-controls-wrap">
            <form
              className="run-bar"
              onSubmit={e => {
                e.preventDefault();
                onRunTransient();
              }}
            >
              <label className="run-field">
                <span className="run-lbl">Dur</span>
                <input
                  className="input input-sm run-dur"
                  value={runDuration}
                  onChange={e => onRunDurationChange(e.target.value)}
                  placeholder="4s"
                  aria-label="Run duration"
                />
              </label>
              <label className="run-field">
                <span className="run-lbl">Press</span>
                <input
                  className="input input-sm run-press"
                  value={runPress}
                  onChange={e => onRunPressChange(e.target.value)}
                  placeholder="SW1@0.5s-1.0s"
                  aria-label="Button press schedule"
                />
              </label>
              <label className="run-field">
                <span className="run-lbl">Probes</span>
                <input
                  className="input input-sm run-probes"
                  value={runProbes}
                  onChange={e => onRunProbesChange(e.target.value)}
                  placeholder={defaultProbes.join(',') || 'D13'}
                  aria-label="Simulation probes"
                />
              </label>
              <button
                type="submit"
                className="btn btn-sm btn-primary"
                disabled={simRunning}
                title={hasMcu ? 'Compile & run MCU mixed-signal simulation' : 'Run simulation'}
              >
                {simRunning ? 'Running…' : 'Run Sim'}
              </button>
              {buttonRefs.length > 0 && (
                <>
                  <button
                    type="button"
                    className={`btn btn-sm ${pressMode ? 'btn-accent' : ''}`}
                    onClick={() => onPressModeChange(!pressMode)}
                    title="Click buttons directly on the canvas to press them"
                  >
                    {pressMode ? 'Press Mode: On' : 'Press Mode'}
                  </button>
                  {buttonRefs.map(ref => {
                    const down = manualPressed.has(ref.toUpperCase());
                    return (
                      <button
                        key={ref}
                        type="button"
                        className={`btn btn-sm ${down ? 'btn-primary' : ''}`}
                        onPointerDown={() => onManualPress(ref, true)}
                        onPointerUp={() => onManualPress(ref, false)}
                        onPointerLeave={() => { if (down) onManualPress(ref, false); }}
                        onClick={e => { if (e.shiftKey) togglePressSnippet(ref); }}
                        title={`Hold to press ${ref} live (Shift+Click to add ${ref}@0.5s-1.5s)`}
                      >
                        {ref}
                      </button>
                    );
                  })}
                </>
              )}
            </form>

            <form className="sim-bar" onSubmit={submitSim}>
              <input
                className="input input-sm sim-input"
                value={simInput}
                onChange={e => setSimInput(e.target.value)}
                placeholder='sim command: dc · logic in=SW1 out=Y · test'
                aria-label="Simulation command"
              />
              <button type="submit" className="btn btn-sm" disabled={simRunning}>
                Eval
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setSimInput('dc'); onRunSim('dc'); }}>
                dc
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setSimInput('test'); onRunSim('test'); }}>
                test
              </button>
              <button type="button" className="btn btn-sm" onClick={onRunCheck}>
                Check
              </button>
            </form>
          </div>
        )}
      </div>

      {trace && tab === 'console' && (
        <div className="playback-bar">
          <button type="button" className="btn btn-sm btn-primary" onClick={onPlayToggle}>
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="btn btn-sm" onClick={onStopPlayback}>
            Reset
          </button>
          <label className="playback-check">
            <input
              type="checkbox"
              checked={loopPlay}
              onChange={e => onLoopChange(e.target.checked)}
            />
            Loop
          </label>
          <select
            aria-label="Playback speed"
            className="select select-sm"
            value={String(playSpeed)}
            onChange={e => onSpeedChange(Number(e.target.value))}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
          </select>
          <input
            type="range"
            className="playback-scrubber"
            min={0}
            max={Math.max(trace.duration, 0.001)}
            step={Math.max(trace.duration / 400, 0.001)}
            value={Math.min(playTime, Math.max(trace.duration, 0.001))}
            onChange={e => onSeek(Number(e.target.value))}
            aria-label="Simulation timeline scrubber"
          />
          <span className="playback-time">
            t = {playTime.toFixed(2)}s / {trace.duration.toFixed(2)}s
          </span>
        </div>
      )}

      {tab === 'console' ? (
        <div className="console-split">
          <div className="console-col">
            <div className="console-col-title">Check</div>
            <pre className="console-pre">{checkOutput || 'No check output yet.'}</pre>
          </div>
          <div className="console-col">
            <div className="console-col-title">Simulation</div>
            <pre className="console-pre">{simOutput || 'Use Run Sim (or dc / logic / test) to simulate.'}</pre>
          </div>
        </div>
      ) : tab === 'serial' ? (
        <div className="serial-pane">
          {serialEntries.length === 0 ? (
            <div className="empty-hint">No Serial output captured yet. Run an MCU sketch that uses Serial.print/println.</div>
          ) : (
            <pre className="console-pre">
              {serialEntries.map(([ref, text]) => `[${ref}]\n${text}`).join('\n\n')}
            </pre>
          )}
        </div>
      ) : (
        <div className="activity-list">
          {activity.length === 0 ? (
            <div className="empty-hint">No workspace activity yet.</div>
          ) : (
            activity.map(entry => (
              <div key={entry.id} className={`activity-row activity-${entry.kind ?? 'change'}`}>
                <span className="activity-time">{entry.time}</span>
                <span className={`activity-source source-${entry.source}`}>{entry.source}</span>
                {entry.rev !== undefined && <span className="activity-rev">rev {entry.rev}</span>}
                <span className="activity-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </footer>
  );
}
