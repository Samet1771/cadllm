// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export const PANEL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
export const MAX_PANEL_EDIT_CHARS = 32_768;
export const MAX_PANEL_SELECT_CHARS = 512;

const PANEL_BRIDGE_SCRIPT = `(function(){
var nextId=1;
var pending=new Map();
window.addEventListener('message',function(ev){
  if(ev.source!==window.parent)return;
  var d=ev.data;
  if(!d||typeof d!=='object'||d.type!=='cadllm:response')return;
  var p=pending.get(d.id);
  if(!p)return;
  pending.delete(d.id);
  if(d.ok===false||typeof d.error==='string'){
    p.reject(new Error(d.error||'Request denied'));
  }else{
    p.resolve(d.result);
  }
});
function send(type,payload){
  return new Promise(function(resolve,reject){
    var id='p_'+(nextId++);
    pending.set(id,{resolve:resolve,reject:reject});
    var msg=Object.assign({type:type,id:id},payload||{});
    window.parent.postMessage(msg,'*');
  });
}
window.cadllm=Object.freeze({
  read:function(opts){
    var body={};
    if(opts&&typeof opts==='object'){
      if(opts.detail!==undefined)body.detail=opts.detail;
      if(typeof opts.select==='string')body.select=opts.select;
    }
    return send('cadllm:read',body);
  },
  requestEdit:function(cnl){
    return send('cadllm:requestEdit',{cnl:cnl});
  }
});
})();`;

/**
 * Inject the strict Content-Security-Policy meta tag and `window.cadllm` postMessage bridge
 * into plugin panel HTML for hosting inside `<iframe sandbox="allow-scripts" srcdoc=...>`.
 */
export function buildPanelSrcDoc(rawHtml: string): string {
  const safeBridge = PANEL_BRIDGE_SCRIPT.replace(/<\/script/gi, '<\\/script');
  const injected = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}"><script>${safeBridge}</script>`;

  const headMatch = rawHtml.match(/<head(\s[^>]*)?>/i);
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${rawHtml.slice(0, insertAt)}${injected}${rawHtml.slice(insertAt)}`;
  }

  const htmlMatch = rawHtml.match(/<html(\s[^>]*)?>/i);
  if (htmlMatch && htmlMatch.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${rawHtml.slice(0, insertAt)}<head>${injected}</head>${rawHtml.slice(insertAt)}`;
  }

  return `<!doctype html><html><head><meta charset="utf-8">${injected}</head><body>${rawHtml}</body></html>`;
}

export type ValidatedPanelRequest =
  | {
      kind: 'read';
      id: string | number;
      detail?: 0 | 1 | 2;
      select?: string;
    }
  | {
      kind: 'requestEdit';
      id: string | number;
      cnl: string;
    };

export type PanelMessageValidation =
  | { ok: true; request: ValidatedPanelRequest }
  | { ok: false; id?: string | number; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidMessageId(id: unknown): id is string | number {
  if (typeof id === 'string') return id.length > 0 && id.length <= 128;
  if (typeof id === 'number') return Number.isFinite(id);
  return false;
}

/** Validate the exact shape and field bounds of an incoming panel `postMessage` payload. */
export function validatePanelMessage(data: unknown): PanelMessageValidation {
  if (!isPlainObject(data)) {
    return { ok: false, reason: 'message payload must be a plain object' };
  }
  if (!isValidMessageId(data.id)) {
    return { ok: false, reason: 'message id must be a non-empty string or finite number' };
  }
  const id = data.id;
  if (typeof data.type !== 'string') {
    return { ok: false, id, reason: 'message type must be a string' };
  }

  if (data.type === 'cadllm:read' || data.type === 'cadllm:project.read') {
    const optsObj = isPlainObject(data.opts) ? data.opts : data;
    const rawDetail = optsObj.detail;
    let detail: 0 | 1 | 2 | undefined;
    if (rawDetail !== undefined) {
      if (rawDetail !== 0 && rawDetail !== 1 && rawDetail !== 2) {
        return { ok: false, id, reason: 'read detail must be 0, 1, or 2' };
      }
      detail = rawDetail;
    }
    const rawSelect = optsObj.select;
    let select: string | undefined;
    if (rawSelect !== undefined) {
      if (typeof rawSelect !== 'string' || rawSelect.length > MAX_PANEL_SELECT_CHARS) {
        return { ok: false, id, reason: 'read select must be a string within 512 chars' };
      }
      select = rawSelect;
    }
    return {
      ok: true,
      request: {
        kind: 'read',
        id,
        ...(detail !== undefined ? { detail } : {}),
        ...(select !== undefined ? { select } : {}),
      },
    };
  }

  if (data.type === 'cadllm:requestEdit' || data.type === 'cadllm:project.edit') {
    if (typeof data.cnl !== 'string' || !data.cnl.trim()) {
      return { ok: false, id, reason: 'requestEdit requires a non-empty cnl string' };
    }
    if (data.cnl.length > MAX_PANEL_EDIT_CHARS) {
      return { ok: false, id, reason: `requestEdit cnl exceeds ${MAX_PANEL_EDIT_CHARS} characters` };
    }
    return {
      ok: true,
      request: {
        kind: 'requestEdit',
        id,
        cnl: data.cnl,
      },
    };
  }

  return { ok: false, id, reason: `unsupported message type "${data.type}"` };
}

/** Verify that a MessageEvent came directly from the expected sandboxed iframe with an opaque origin. */
export function isTrustedPanelEvent(
  event: { source: unknown; origin?: string },
  expectedWindow: unknown,
): boolean {
  if (!expectedWindow || event.source !== expectedWindow) return false;
  if (typeof event.origin === 'string' && event.origin !== '' && event.origin !== 'null') {
    return false;
  }
  return true;
}

export interface RateLimiterOptions {
  maxRequests?: number;
  windowMs?: number;
  now?: () => number;
}

/** Sliding-window rate limiter guarding the host from noisy or abusive plugin panels. */
export class PanelRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly timestamps: number[] = [];

  constructor(opts: RateLimiterOptions = {}) {
    this.maxRequests = opts.maxRequests ?? 12;
    this.windowMs = opts.windowMs ?? 2000;
    this.now = opts.now ?? (() => Date.now());
  }

  allow(): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(t);
    return true;
  }
}

export interface PanelMessageHandlerDeps {
  getContentWindow: () => { postMessage(message: unknown, targetOrigin: string): void } | null;
  getGrantedPermissions: () => readonly string[];
  readProject: (opts: { detail?: 0 | 1 | 2; select?: string }) => Promise<string>;
  requestEditConfirmation: (cnl: string) => Promise<boolean>;
  applyEdit: (cnl: string) => Promise<string>;
  rateLimiter?: PanelRateLimiter;
}

/**
 * Create the host-side `postMessage` handler for a sandboxed plugin panel iframe.
 * Enforces source/origin checks, schema validation, rate limiting, permission checks,
 * and explicit user confirmation before applying any CNL edit.
 */
export function createPanelMessageHandler(deps: PanelMessageHandlerDeps): (event: {
  source: unknown;
  origin?: string;
  data: unknown;
}) => Promise<void> {
  const limiter = deps.rateLimiter ?? new PanelRateLimiter();
  let editPending = false;

  const reply = (id: string | number, payload: { ok: true; result: string } | { ok: false; error: string }) => {
    const win = deps.getContentWindow();
    if (!win) return;
    win.postMessage({ type: 'cadllm:response', id, ...payload }, '*');
  };

  return async event => {
    const targetWindow = deps.getContentWindow();
    if (!isTrustedPanelEvent(event, targetWindow)) return;

    const validated = validatePanelMessage(event.data);
    if (!validated.ok) {
      if (validated.id !== undefined) {
        reply(validated.id, { ok: false, error: validated.reason });
      }
      return;
    }

    const req = validated.request;
    if (!limiter.allow()) {
      reply(req.id, { ok: false, error: 'Rate limit exceeded; please slow down' });
      return;
    }

    const grants = deps.getGrantedPermissions();

    if (req.kind === 'read') {
      if (!grants.includes('project:read')) {
        reply(req.id, { ok: false, error: 'Permission denied: project:read is not granted' });
        return;
      }
      try {
        const text = await deps.readProject({
          ...(req.detail !== undefined ? { detail: req.detail } : {}),
          ...(req.select !== undefined ? { select: req.select } : {}),
        });
        reply(req.id, { ok: true, result: text });
      } catch (err) {
        reply(req.id, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (!grants.includes('project:write')) {
      reply(req.id, { ok: false, error: 'Permission denied: project:write is not granted' });
      return;
    }

    if (editPending) {
      reply(req.id, { ok: false, error: 'Another edit confirmation dialog is already open' });
      return;
    }

    editPending = true;
    try {
      const approved = await deps.requestEditConfirmation(req.cnl);
      if (!approved) {
        reply(req.id, { ok: false, error: 'Edit rejected by user' });
        return;
      }
      if (!deps.getGrantedPermissions().includes('project:write')) {
        reply(req.id, { ok: false, error: 'Permission denied: project:write was revoked' });
        return;
      }
      const res = await deps.applyEdit(req.cnl);
      reply(req.id, { ok: true, result: res });
    } catch (err) {
      reply(req.id, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      editPending = false;
    }
  };
}
