// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { describe, expect, it } from 'vitest';
import type { Delta } from '@cadllm/core';
import {
  OwnChangeTracker,
  deltaToHighlight,
  formatChangeToast,
} from '../src/lib/delta.ts';
import type { ChangedNotification } from '../src/lib/types.ts';

const emptyDelta: Delta = {
  added: [],
  removed: [],
  changed: [],
  renamed: [],
  netsAdded: [],
  netsRemoved: [],
  netsChanged: [],
  netsRenamed: [],
};

describe('deltaToHighlight', () => {
  it('maps component refs and net:NAME entries deduplicated', () => {
    const delta: Delta = {
      ...emptyDelta,
      added: ['R2'],
      changed: ['R1', 'R2'],
      renamed: [['U9', 'U1']],
      netsAdded: ['LA'],
      netsChanged: ['VCC', 'LA'],
      netsRenamed: [['N1', 'IN']],
    };
    expect(deltaToHighlight(delta)).toEqual([
      'R2',
      'R1',
      'U1',
      'net:LA',
      'net:VCC',
      'net:IN',
    ]);
  });
});

describe('formatChangeToast', () => {
  it('formats AI change notifications cleanly', () => {
    const n: ChangedNotification = {
      project: 'led',
      rev: 4,
      source: 'ai',
      delta: emptyDelta,
      summary: 'R1 ~LA',
    };
    expect(formatChangeToast(n)).toBe('AI changed R1 ~LA');
  });

  it('falls back to delta formatting when summary is empty', () => {
    const n: ChangedNotification = {
      project: 'led',
      rev: 5,
      source: 'plugin',
      delta: { ...emptyDelta, added: ['C1'], netsAdded: ['VCC'] },
      summary: '',
    };
    expect(formatChangeToast(n)).toBe('Plugin changed +C1 +VCC');
  });
});

describe('OwnChangeTracker', () => {
  const userNote = (rev: number): ChangedNotification => ({
    project: 'p',
    rev,
    source: 'user',
    delta: emptyDelta,
    summary: '~R1',
  });

  it('suppresses own notification when RPC reply arrives first', () => {
    const tracker = new OwnChangeTracker();
    tracker.beginMutation();
    expect(tracker.endMutation(3)).toEqual([]);
    expect(tracker.onChanged(userNote(3))).toEqual([]);
  });

  it('suppresses own notification when WS notification arrives before RPC reply', () => {
    const tracker = new OwnChangeTracker();
    tracker.beginMutation();
    expect(tracker.onChanged(userNote(4))).toEqual([]);
    expect(tracker.endMutation(4)).toEqual([]);
  });

  it('passes through notifications from AI or other user tabs', () => {
    const tracker = new OwnChangeTracker();
    const aiNote: ChangedNotification = { ...userNote(2), source: 'ai' };
    expect(tracker.onChanged(aiNote)).toEqual([aiNote]);

    // Another user tab edited while we had an edit in flight
    tracker.beginMutation();
    const otherTab = userNote(5);
    const own = userNote(6);
    expect(tracker.onChanged(otherTab)).toEqual([]);
    expect(tracker.onChanged(own)).toEqual([]);
    expect(tracker.endMutation(6)).toEqual([otherTab]);

    // Other user tab edited while we are idle
    expect(tracker.onChanged(userNote(7))).toEqual([userNote(7)]);
  });
});
