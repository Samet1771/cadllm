// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import type { PartDef } from '@cadllm/core';
import type { ViewId } from '@cadllm/views';
import type { ConnectionStatus, RpcApi, StateResponse } from './types.ts';

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

export interface RpcClientOptions {
  url: string;
  createSocket?: (url: string) => WebSocketLike;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onStatusChange?: (status: ConnectionStatus) => void;
}

const WS_OPEN = 1;

/** JSON-RPC 2.0 WebSocket client with request/response matching, notifications and auto-reconnect. */
export class RpcClient implements RpcApi {
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly onStatusChange: ((status: ConnectionStatus) => void) | undefined;

  private socket: WebSocketLike | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private _status: ConnectionStatus = 'disconnected';
  private connectWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  constructor(opts: RpcClientOptions) {
    this.url = opts.url;
    this.createSocket = opts.createSocket ?? (u => new WebSocket(u) as unknown as WebSocketLike);
    this.baseDelayMs = opts.reconnectDelayMs ?? 500;
    this.maxDelayMs = opts.maxReconnectDelayMs ?? 5000;
    this.onStatusChange = opts.onStatusChange;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  private setStatus(next: ConnectionStatus): void {
    if (this._status === next) return;
    this._status = next;
    this.onStatusChange?.(next);
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    if (this.socket && this.socket.readyState === WS_OPEN) {
      return Promise.resolve();
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return new Promise((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
      if (!this.socket) this.openSocket();
    });
  }

  private openSocket(): void {
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.url);
    } catch (err) {
      this.handleDisconnect(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.socket = ws;

    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      const waiters = this.connectWaiters.splice(0);
      for (const w of waiters) w.resolve();
    };

    ws.onmessage = ev => {
      if (this.socket !== ws) return;
      this.handleMessage(ev.data);
    };

    ws.onerror = () => {
      // Close event handles cleanup and reconnect scheduling.
    };

    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.handleDisconnect(new Error('WebSocket disconnected'));
    };
  }

  private handleDisconnect(reason: Error): void {
    this.rejectAllPending(reason);
    const waiters = this.connectWaiters.splice(0);
    for (const w of waiters) w.reject(reason);
    this.setStatus('disconnected');
    if (!this.closedByUser) {
      const delay = Math.min(this.baseDelayMs * 2 ** this.reconnectAttempts, this.maxDelayMs);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closedByUser && !this.socket) this.openSocket();
      }, delay);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, req] of this.pending) {
      this.pending.delete(id);
      req.reject(err);
    }
  }

  private handleMessage(raw: unknown): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as JsonRpcResponse;
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const id = Number(msg.id);
      const req = this.pending.get(id);
      if (!req) return;
      this.pending.delete(id);
      if (msg.error) {
        req.reject(new RpcError(msg.error.code, msg.error.message));
      } else {
        req.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const h of handlers) h(msg.params);
      }
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.socket;
    this.socket = null;
    this.rejectAllPending(new Error('Client closed'));
    const waiters = this.connectWaiters.splice(0);
    for (const w of waiters) w.reject(new Error('Client closed'));
    this.setStatus('disconnected');
    ws?.close();
  }

  onNotification<T = unknown>(method: string, handler: (params: T) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    const wrapped = handler as (params: unknown) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  call<T = string>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return Promise.reject(new Error('Not connected to server'));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.socket!.send(payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  state(): Promise<StateResponse> {
    return this.call<StateResponse>('state', {});
  }

  library(): Promise<PartDef[]> {
    return this.call<PartDef[]>('library', {});
  }

  render(params: { view: ViewId; highlight?: string[]; theme?: 'light' | 'dark' }): Promise<string> {
    return this.call<string>('render', params);
  }
}
