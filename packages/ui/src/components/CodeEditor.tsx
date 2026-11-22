// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { cpp } from '@codemirror/lang-cpp';

interface CodeEditorProps {
  value: string;
  theme: 'light' | 'dark';
  onChange: (next: string) => void;
  onSave: () => void;
}

export function CodeEditor({ value, theme, onChange, onSave }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const valueRef = useRef(value);
  const applyingExternalRef = useRef(false);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  valueRef.current = value;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;

    const dark = theme === 'dark';
    const editorTheme = EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: '11.5px',
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
        },
        '.cm-scroller': {
          fontFamily: 'var(--font-mono)',
          lineHeight: '1.45',
          overflow: 'auto',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--surface-alt)',
          color: 'var(--text-muted)',
          borderRight: '1px solid var(--border)',
        },
        '.cm-activeLine': {
          backgroundColor: dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(15, 23, 42, 0.04)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.06)',
        },
        '.cm-cursor': {
          borderLeftColor: 'var(--text)',
        },
      },
      { dark },
    );

    const view = new EditorView({
      doc: valueRef.current,
      extensions: [
        basicSetup,
        cpp(),
        editorTheme,
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applyingExternalRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.domEventHandlers({
          keydown: event => {
            if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 's' || event.key === 'Enter')) {
              event.preventDefault();
              onSaveRef.current();
              return true;
            }
            return false;
          },
        }),
      ],
      parent,
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    applyingExternalRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
    applyingExternalRef.current = false;
  }, [value]);

  return <div ref={hostRef} className="cm-host" aria-label="Arduino sketch editor" />;
}
