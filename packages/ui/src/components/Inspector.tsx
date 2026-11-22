// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useEffect, useState } from 'react';
import { pinKey, type Component, type PartDef, type PcbLayer, type Query } from '@cadllm/core';
import type { ViewId } from '@cadllm/views';
import { CodeEditor } from './CodeEditor.tsx';

export interface SelectedTrackInfo {
  netName: string;
  layer: PcbLayer;
  index: number;
}

interface InspectorProps {
  query: Query;
  activeView: ViewId;
  selectedRef: string | undefined;
  selectedTrack?: SelectedTrackInfo;
  theme: 'light' | 'dark';
  cnlText: string;
  cnlDirty: boolean;
  projectHeader: string;
  mcuRefs: string[];
  activeMcuRef: string | undefined;
  codeText: string;
  codeDirty: boolean;
  codeLoading: boolean;
  onSelectMcuRef: (ref: string) => void;
  onCodeChange: (text: string) => void;
  onSaveCode: () => void;
  onSyncCode: () => void;
  onCnlChange: (text: string) => void;
  onApplyCnl: () => void;
  onSyncCnl: () => void;
  onPatchProp: (ref: string, key: string, value: string) => void;
  onRotate: (ref: string) => void;
  onFlipPcb?: (ref: string) => void;
  onDelete: (ref: string) => void;
  onDeleteSelectedTrack?: () => void;
  onDisconnectPin: (netName: string, pinLabel: string) => void;
}

function ComponentInspector({
  comp,
  part,
  query,
  activeView,
  onPatchProp,
  onRotate,
  onFlipPcb,
  onDelete,
  onDisconnectPin,
}: {
  comp: Component;
  part: PartDef | undefined;
  query: Query;
  activeView: ViewId;
  onPatchProp: (ref: string, key: string, value: string) => void;
  onRotate: (ref: string) => void;
  onFlipPcb?: (ref: string) => void;
  onDelete: (ref: string) => void;
  onDisconnectPin: (netName: string, pinLabel: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts({});
  }, [comp.id, comp.props]);

  const propEntries = (() => {
    const keys = new Set<string>([
      ...Object.keys(part?.props ?? {}),
      ...Object.keys(comp.props),
    ]);
    return [...keys].map(k => ({
      key: k,
      def: part?.props?.[k],
      value: comp.props[k] ?? part?.props?.[k]?.default ?? '',
    }));
  })();

  const commitProp = (key: string, currentVal: string) => {
    const next = drafts[key];
    if (next === undefined || next === currentVal) return;
    onPatchProp(comp.ref, key, next);
  };

  return (
    <div className="inspector-body">
      <div className="inspector-comp-head">
        <div>
          <div className="inspector-ref">{comp.ref}</div>
          <div className="inspector-part">
            {comp.part}
            {part ? ` · ${part.name}` : ''}
          </div>
        </div>
        <div className="btn-group">
          {(activeView === 'sch' || activeView === 'pcb') && (
            <button type="button" className="btn btn-sm" onClick={() => onRotate(comp.ref)} title="Rotate 90° (R)">
              Rotate
            </button>
          )}
          {activeView === 'pcb' && onFlipPcb && (
            <button type="button" className="btn btn-sm" onClick={() => onFlipPcb(comp.ref)} title="Flip top/bottom (F)">
              Flip
            </button>
          )}
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onDelete(comp.ref)} title="Delete component (Del)">
            Delete
          </button>
        </div>
      </div>

      <div className="place-badges">
        <span className="place-badge">@sch: {comp.place.sch ?? 'unplaced'}</span>
        <span className="place-badge">@bb: {comp.place.bb ?? 'unplaced'}</span>
        <span className="place-badge">@pcb: {comp.place.pcb ?? 'unplaced'}</span>
      </div>

      {propEntries.length > 0 && (
        <div className="inspector-section">
          <div className="section-label">Properties</div>
          <div className="props-grid">
            {propEntries.map(({ key, def, value }) => {
              const draft = drafts[key] ?? value;
              return (
                <label key={key} className="prop-row">
                  <span className="prop-key" title={def?.description}>
                    {key}
                    {def?.unit ? ` (${def.unit})` : ''}
                  </span>
                  {def?.type === 'enum' && def.options ? (
                    <select
                      className="select select-sm"
                      value={value}
                      onChange={e => onPatchProp(comp.ref, key, e.target.value)}
                    >
                      {def.options.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : def?.type === 'bool' ? (
                    <select
                      className="select select-sm"
                      value={value}
                      onChange={e => onPatchProp(comp.ref, key, e.target.value)}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input input-sm"
                      value={draft}
                      onChange={e => setDrafts(prev => ({ ...prev, [key]: e.target.value }))}
                      onBlur={() => commitProp(key, value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                          commitProp(key, value);
                        }
                      }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {part && part.pins.length > 0 && (
        <div className="inspector-section">
          <div className="section-label">Pins ({part.pins.length})</div>
          <div className="pin-list">
            {part.pins.map(pin => {
              const pk = pinKey(comp.id, pin.id);
              const net = query.netOfPin(pk);
              const label = query.pinLabel(pk);
              return (
                <div key={pin.id} className="pin-row">
                  <span className="pin-name">{pin.id === pin.name ? pin.name : `${pin.id}:${pin.name}`}</span>
                  {net ? (
                    <span className="pin-net">
                      <span>{net.name}</span>
                      <button
                        type="button"
                        className="pin-disconnect"
                        title={`Disconnect ${label} from ${net.name}`}
                        onClick={() => onDisconnectPin(net.name, label)}
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <span className="pin-unconnected">nc</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Inspector({
  query,
  activeView,
  selectedRef,
  selectedTrack,
  theme,
  cnlText,
  cnlDirty,
  projectHeader,
  mcuRefs,
  activeMcuRef,
  codeText,
  codeDirty,
  codeLoading,
  onSelectMcuRef,
  onCodeChange,
  onSaveCode,
  onSyncCode,
  onCnlChange,
  onApplyCnl,
  onSyncCnl,
  onPatchProp,
  onRotate,
  onFlipPcb,
  onDelete,
  onDeleteSelectedTrack,
  onDisconnectPin,
}: InspectorProps) {
  const comp = selectedRef ? query.component(selectedRef) : undefined;
  const part = comp ? query.parts.get(comp.part) : undefined;
  const hasMcu = mcuRefs.length > 0;
  const [editorTab, setEditorTab] = useState<'code' | 'cnl'>(hasMcu ? 'code' : 'cnl');

  useEffect(() => {
    if (!hasMcu) {
      setEditorTab('cnl');
    } else if (selectedRef && mcuRefs.some(r => r.toUpperCase() === selectedRef.toUpperCase())) {
      setEditorTab('code');
    } else if (editorTab === 'cnl' && hasMcu && !cnlDirty) {
      // Auto-open Code tab when loading a circuit that has an MCU.
      setEditorTab('code');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMcu, selectedRef]);

  return (
    <aside className="panel panel-right">
      <section className="inspector-pane">
        <div className="panel-header">
          <span className="panel-title">Inspector</span>
          {comp && <span className="muted-tag">{comp.ref}</span>}
          {!comp && selectedTrack && <span className="muted-tag">track: {selectedTrack.netName}</span>}
        </div>
        {comp ? (
          <ComponentInspector
            comp={comp}
            part={part}
            query={query}
            activeView={activeView}
            onPatchProp={onPatchProp}
            onRotate={onRotate}
            onFlipPcb={onFlipPcb}
            onDelete={onDelete}
            onDisconnectPin={onDisconnectPin}
          />
        ) : selectedTrack ? (
          <div className="inspector-body">
            <div className="inspector-comp-head">
              <div>
                <div className="inspector-ref">Net {selectedTrack.netName}</div>
                <div className="inspector-part">Selected PCB copper on layer {selectedTrack.layer}</div>
              </div>
              {onDeleteSelectedTrack && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={onDeleteSelectedTrack}
                  title="Remove all tracks & vias on this net (Del)"
                >
                  Remove Copper
                </button>
              )}
            </div>
            <div className="empty-hint">
              Press <kbd>Del</kbd> or click Remove Copper to execute <code>-tracks {selectedTrack.netName}</code>.
            </div>
          </div>
        ) : (
          <div className="empty-hint">
            Click a component on the canvas to inspect properties and pins.
          </div>
        )}
      </section>

      <section className="cnl-pane">
        <div className="panel-header">
          <div className="view-tabs">
            {hasMcu && (
              <button
                type="button"
                className={`view-tab ${editorTab === 'code' ? 'active' : ''}`}
                onClick={() => setEditorTab('code')}
              >
                Code{codeDirty ? ' •' : ''}
              </button>
            )}
            <button
              type="button"
              className={`view-tab ${editorTab === 'cnl' ? 'active' : ''}`}
              onClick={() => setEditorTab('cnl')}
            >
              CNL{cnlDirty ? ' •' : ''}
            </button>
          </div>

          {editorTab === 'code' && activeMcuRef ? (
            <div className="btn-group">
              {mcuRefs.length > 1 ? (
                <select
                  aria-label="MCU target"
                  className="select select-sm"
                  value={activeMcuRef}
                  onChange={e => onSelectMcuRef(e.target.value)}
                >
                  {mcuRefs.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              ) : (
                <span className="muted-tag">{activeMcuRef}</span>
              )}
              {codeDirty && (
                <button type="button" className="btn btn-sm" onClick={onSyncCode} title="Reload sketch from workspace">
                  Sync
                </button>
              )}
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={codeLoading}
                onClick={onSaveCode}
                title="Save sketch (Ctrl+S)"
              >
                Save
              </button>
            </div>
          ) : (
            <>
              <span className="muted-tag">{projectHeader}</span>
              <div className="btn-group">
                {cnlDirty && (
                  <button type="button" className="btn btn-sm" onClick={onSyncCnl} title="Reload circuit text">
                    Sync
                  </button>
                )}
                <button type="button" className="btn btn-sm btn-primary" onClick={onApplyCnl} title="Apply CNL edit (Ctrl+Enter)">
                  Apply
                </button>
              </div>
            </>
          )}
        </div>

        {editorTab === 'code' && activeMcuRef ? (
          <CodeEditor
            value={codeText}
            theme={theme}
            onChange={onCodeChange}
            onSave={onSaveCode}
          />
        ) : (
          <textarea
            className="cnl-editor"
            spellCheck={false}
            value={cnlText}
            onChange={e => onCnlChange(e.target.value)}
            onKeyDown={e => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                onApplyCnl();
              }
            }}
            placeholder={'# Add/edit parts & nets:\nR1 res 330 @sch:10,6\n~R1 resistance=470\nVCC: BAT1.+ R1.1'}
            aria-label="CNL text editor"
          />
        )}
      </section>
    </aside>
  );
}
