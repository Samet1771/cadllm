// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcClient, RpcError, type WebSocketLike } from '../src/lib/rpc.ts';
import type { ConnectionStatus } from '../src/lib/types.ts';

class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

describe('RpcClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches JSON-RPC requests and responses out of order', async () => {
    const sockets: FakeSocket[] = [];
    const statuses: ConnectionStatus[] = [];
    const client = new RpcClient({
      url: 'ws://localhost:5170/ws',
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatusChange: s => statuses.push(s),
    });

    const pConn = client.connect();
    expect(statuses).toEqual(['connecting']);
    sockets[0]!.open();
    await pConn;
    expect(statuses).toEqual(['connecting', 'connected']);

    const p1 = client.call<string>('read', { detail: 1 });
    const p2 = client.call<string>('check', {});
    const req1 = JSON.parse(sockets[0]!.sent[0]!) as { id: number; method: string };
    const req2 = JSON.parse(sockets[0]!.sent[1]!) as { id: number; method: string };
    expect(req1.method).toBe('read');
    expect(req2.method).toBe('check');

    // Respond out of order
    sockets[0]!.receive({ jsonrpc: '2.0', id: req2.id, result: 'ok 0 err' });
    sockets[0]!.receive({ jsonrpc: '2.0', id: req1.id, result: 'untitled rev=0' });
    await expect(p2).resolves.toBe('ok 0 err');
    await expect(p1).resolves.toBe('untitled rev=0');

    client.close();
  });

  it('rejects with RpcError on server error response', async () => {
    const sockets: FakeSocket[] = [];
    const client = new RpcClient({
      url: 'ws://localhost:5170/ws',
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    const pConn = client.connect();
    sockets[0]!.open();
    await pConn;

    const p = client.call('edit', { cnl: 'bad' });
    const req = JSON.parse(sockets[0]!.sent[0]!) as { id: number };
    sockets[0]!.receive({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32000, message: 'line 1: unknown part bad' },
    });

    await expect(p).rejects.toBeInstanceOf(RpcError);
    await expect(p).rejects.toMatchObject({ code: -32000, message: 'line 1: unknown part bad' });
    client.close();
  });

  it('dispatches server notifications and reconnects with status updates', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: ConnectionStatus[] = [];
    const client = new RpcClient({
      url: 'ws://localhost:5170/ws',
      reconnectDelayMs: 100,
      maxReconnectDelayMs: 400,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      onStatusChange: s => statuses.push(s),
    });

    const pConn = client.connect();
    sockets[0]!.open();
    await pConn;

    const received: unknown[] = [];
    client.onNotification('changed', params => received.push(params));
    sockets[0]!.receive({
      jsonrpc: '2.0',
      method: 'changed',
      params: { project: 'led', rev: 2, source: 'ai', summary: '~R1' },
    });
    expect(received).toEqual([{ project: 'led', rev: 2, source: 'ai', summary: '~R1' }]);

    // Drop connection with an in-flight call
    const inflight = client.call('state');
    sockets[0]!.drop();
    await expect(inflight).rejects.toThrow('WebSocket disconnected');
    expect(statuses).toContain('disconnected');

    // Reconnect timer triggers a new socket
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    expect(statuses[statuses.length - 1]).toBe('connecting');
    sockets[1]!.open();
    expect(statuses[statuses.length - 1]).toBe('connected');

    client.close();
  });
});
