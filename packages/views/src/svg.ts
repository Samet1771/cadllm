// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export const esc = (s: string): string => s.replace(/[&<>"]/g, c => ESC[c]!);

/** Numbers in SVG output: at most 2 decimals, no trailing zeros, no "-0". */
export const num = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

type Attrs = Record<string, string | number | undefined>;

/** One element. Attribute order is the insertion order, so output stays deterministic. */
export function el(tag: string, attrs: Attrs = {}, children: string | string[] = ''): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${typeof v === 'number' ? num(v) : esc(v!)}"`)
    .join('');
  const body = Array.isArray(children) ? children.join('') : children;
  return body ? `<${tag}${a}>${body}</${tag}>` : `<${tag}${a}/>`;
}

export const path = (d: (string | number)[]): string => d.map(p => (typeof p === 'number' ? num(p) : p)).join(' ');

/** Wrap content as a standalone SVG document. */
export function svgDoc(view: string, box: { x: number; y: number; w: number; h: number }, body: string[], style = ''): string {
  return el('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: `${num(box.x)} ${num(box.y)} ${num(box.w)} ${num(box.h)}`,
    width: box.w,
    height: box.h,
    'data-view': view,
  }, [style ? el('style', {}, style) : '', ...body]);
}
