// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { ChangeSource, Circuit, Delta, PartDef } from '@cadllm/core';

export interface ProjectSummary {
  name: string;
  rev: number;
  source?: string;
}

export interface StateResponse {
  project: string;
  rev: number;
  projects: ProjectSummary[];
  circuit: Circuit;
  parts: Record<string, PartDef>;
}

export interface ChangedNotification {
  project: string;
  rev: number;
  source: ChangeSource;
  label?: string;
  delta: Delta;
  summary: string;
}

export interface ProjectsNotification {
  names: string[];
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'demo';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface ActivityEntry {
  id: number;
  time: string;
  rev?: number;
  source: ChangeSource | 'ui';
  text: string;
  kind?: 'change' | 'info' | 'error';
}

export interface ToastMessage {
  id: number;
  text: string;
  source: ChangeSource | 'ui';
}

/** Minimal RPC surface shared by the WebSocket client and the ?demo adapter. */
export interface RpcApi {
  call<T = string>(method: string, params?: Record<string, unknown>): Promise<T>;
  state(): Promise<StateResponse>;
  library(): Promise<PartDef[]>;
}
