// SPDX-License-Identifier: GPL-3.0-or-later WITH LicenseRef-CadLLM-plugin-exception

export interface MarkdownRenderOptions {
  /** Optional hook to rewrite link targets (e.g. `.md` doc links to `.html`). */
  rewriteLink?: (href: string) => string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugifyHeading(text: string): string {
  const plain = text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase();
  const slug = plain
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return true;
  }
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) {
    return true;
  }
  const scheme = schemeMatch[1]!.toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function formatInlineWithoutLinks(escapedText: string): string {
  return escapedText
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

export function renderInline(raw: string, opts: MarkdownRenderOptions = {}): string {
  const codeSpans: string[] = [];
  const linkSpans: string[] = [];

  // 1. Protect inline code spans so characters inside backticks are never parsed as markdown.
  const withoutCode = raw.replace(/`([^`]+)`/g, (_m, code: string) => {
    const idx = codeSpans.length;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE_${idx}_\u0000`;
  });

  // 2. Extract markdown links [label](href) (supporting balanced parentheses in href).
  const withoutLinks = withoutCode.replace(
    /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
    (_m, label: string, rawHref: string) => {
    const idx = linkSpans.length;
    const labelHtml = formatInlineWithoutLinks(escapeHtml(label));
    if (!isSafeHref(rawHref)) {
      linkSpans.push(labelHtml);
    } else {
      const targetHref = opts.rewriteLink ? opts.rewriteLink(rawHref) : rawHref;
      const isExternal = /^https?:\/\//i.test(targetHref);
      const extAttrs = isExternal ? ' rel="noopener noreferrer"' : '';
      linkSpans.push(`<a href="${escapeHtml(targetHref)}"${extAttrs}>${labelHtml}</a>`);
    }
    return `\u0000LINK_${idx}_\u0000`;
  });

  // 3. Escape remaining HTML and apply bold / italic / strikethrough.
  let out = formatInlineWithoutLinks(escapeHtml(withoutLinks));

  // 4. Restore links, then code spans (since link labels may contain code spans).
  out = out.replace(/\u0000LINK_(\d+)_\u0000/g, (_m, idxStr: string) => linkSpans[Number(idxStr)] ?? '');
  out = out.replace(/\u0000CODE_(\d+)_\u0000/g, (_m, idxStr: string) => codeSpans[Number(idxStr)] ?? '');

  return out;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let cur = '';
  let inBackticks = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '`' && (i === 0 || trimmed[i - 1] !== '\\')) {
      inBackticks = !inBackticks;
      cur += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|' && !inBackticks) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function parseTableAlignments(line: string): ('left' | 'center' | 'right' | undefined)[] {
  return splitTableRow(line).map(c => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return undefined;
  });
}

export function renderMarkdown(markdown: string, opts: MarkdownRenderOptions = {}): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  const slugCounts = new Map<string, number>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip blank lines
    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    const fenceMatch = trimmed.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1]!.trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      blocks.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const rawTitle = headingMatch[2]!;
      const baseSlug = slugifyHeading(rawTitle);
      const count = slugCounts.get(baseSlug) ?? 0;
      slugCounts.set(baseSlug, count + 1);
      const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;
      blocks.push(`<h${level} id="${escapeHtml(slug)}">${renderInline(rawTitle, opts)}</h${level}>`);
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      blocks.push('<hr />');
      i += 1;
      continue;
    }

    // GFM Table
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1]!)
    ) {
      const headerCells = splitTableRow(line);
      const alignments = parseTableAlignments(lines[i + 1]!);
      i += 2;
      const bodyRows: string[][] = [];
      while (
        i < lines.length &&
        lines[i]!.trim().length > 0 &&
        lines[i]!.includes('|') &&
        !lines[i]!.trim().startsWith('```')
      ) {
        bodyRows.push(splitTableRow(lines[i]!));
        i += 1;
      }

      const ths = headerCells
        .map((cell, idx) => {
          const align = alignments[idx];
          const alignAttr = align ? ` class="align-${align}"` : '';
          return `<th${alignAttr}>${renderInline(cell, opts)}</th>`;
        })
        .join('');

      const trs = bodyRows
        .map(row => {
          const tds = headerCells
            .map((_h, idx) => {
              const cell = row[idx] ?? '';
              const align = alignments[idx];
              const alignAttr = align ? ` class="align-${align}"` : '';
              return `<td${alignAttr}>${renderInline(cell, opts)}</td>`;
            })
            .join('');
          return `<tr>${tds}</tr>`;
        })
        .join('\n');

      blocks.push(
        `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`,
      );
      continue;
    }

    // Blockquote / GitHub Alert
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i += 1;
      }
      const firstLine = quoteLines[0] ?? '';
      const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        const kind = alertMatch[1]!.toLowerCase();
        const restFirst = alertMatch[2]!.trim();
        const bodyLines = restFirst ? [restFirst, ...quoteLines.slice(1)] : quoteLines.slice(1);
        const bodyHtml = bodyLines.map(l => renderInline(l, opts)).join('<br />');
        blocks.push(
          `<blockquote class="alert alert-${kind}"><div class="alert-title">${escapeHtml(kind.toUpperCase())}</div><p>${bodyHtml}</p></blockquote>`,
        );
      } else {
        const bodyHtml = quoteLines.map(l => renderInline(l, opts)).join('<br />');
        blocks.push(`<blockquote><p>${bodyHtml}</p></blockquote>`);
      }
      continue;
    }

    // Unordered or Ordered List
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const tag = isOrdered ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = isOrdered
          ? cur.match(/^\s*\d+\.\s+(.+)$/)
          : cur.match(/^\s*[-*]\s+(.+)$/);
        if (!m) break;
        let itemText = m[1]!;
        i += 1;
        // Collect indented continuation lines or sub-bullets
        const subItems: string[] = [];
        while (i < lines.length) {
          const next = lines[i]!;
          const subBullet = next.match(/^\s{2,}(?:[-*]|\d+\.)\s+(.+)$/);
          if (subBullet) {
            subItems.push(`<li>${renderInline(subBullet[1]!, opts)}</li>`);
            i += 1;
            continue;
          }
          if (/^\s{2,}\S/.test(next) && !next.trim().startsWith('```')) {
            itemText += ` ${next.trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        const subHtml = subItems.length > 0 ? `<ul>${subItems.join('')}</ul>` : '';
        items.push(`<li>${renderInline(itemText, opts)}${subHtml}</li>`);
      }
      blocks.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i]!;
      const curTrim = cur.trim();
      if (
        !curTrim ||
        curTrim.startsWith('```') ||
        /^#{1,6}\s+/.test(cur) ||
        /^(?:---|\*\*\*|___)\s*$/.test(curTrim) ||
        curTrim.startsWith('>') ||
        /^\s*[-*]\s+/.test(cur) ||
        /^\s*\d+\.\s+/.test(cur) ||
        (curTrim.includes('|') && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(curTrim);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push(`<p>${renderInline(paraLines.join(' '), opts)}</p>`);
    } else {
      i += 1;
    }
  }

  return blocks.join('\n');
}
