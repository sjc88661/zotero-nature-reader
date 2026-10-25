import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const LAYOUT_VERSION = 1;
export function layoutContentHash(blocks) {
  return createHash('sha256').update(JSON.stringify(blocks.map(block => [block.id ?? null, block.page ?? null,
    block.order ?? null, block.bbox ?? null, block.original || '']))).digest('hex');
}

export function makeLayoutExtractor(python, script) {
  return async ({ pdf, directory, fingerprint, contentHash, blocks, signal }) => {
    const output = path.join(directory, `layout-v${LAYOUT_VERSION}`);
    await mkdir(output, { recursive: true });
    const input = path.join(output, 'blocks-input.json');
    // Only the immutable source properties cross this extraction boundary.
    await writeFile(input, JSON.stringify(blocks.map(({ id, page, order, original, bbox }) => ({ id, page, order, original, bbox }))), 'utf8');
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(python, [script, '--pdf', pdf, '--blocks', input, '--out', output,
          '--fingerprint', fingerprint, '--content-hash', contentHash], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', text => { stdout += text; });
        child.stderr.on('data', text => { stderr = (stderr + text).slice(-6000); });
        child.on('error', reject);
        child.on('close', code => {
          if (code !== 0) return reject(new Error(stderr || `PDF 版式提取进程退出（${code}）。`));
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error('PDF 版式提取器未返回有效 JSON。')); }
        });
      });
    } finally { await unlink(input).catch(() => {}); }
  };
}
