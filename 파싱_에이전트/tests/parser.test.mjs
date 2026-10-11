import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, catalogRows, qualityOf, run, parseIsolated } from '../parse_pdfs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated');
const fixtures = path.join(root, '한글 경로');
const catalog = path.join(fixtures, 'catalog.csv');
const good = { success: true, markdown: '한글 본문', pages: [{ pageNumber: 1, markdown: '한글 본문' }], blocks: [], metadata: { pageCount: 1 } };
const outputFor = async () => { await fs.mkdir(root, { recursive: true }); return fs.mkdtemp(path.join(root, 'test-')); };
const opts = output => ({ catalog, output, ids: 'T01', 'approval-note': '합성 PDF 시험 승인' });

test('approval and ID arguments required for actual execution', () => {
  assert.throws(() => argumentsFor(['--catalog', catalog]), /승인/);
  assert.throws(() => argumentsFor(['--catalog', catalog, '--ids', 'T01']), /승인/);
  assert.equal(argumentsFor(['--catalog', catalog, '--dry-run'])['dry-run'], true);
  assert.throws(() => argumentsFor(['--catalog']), /값/);
});

test('CSV BOM, quotes and unknown ID handling', async () => {
  const data = await catalogRows(catalog, 'T01');
  assert.equal(data.rows[0].title, '정상, "한글"');
  await assert.rejects(catalogRows(catalog, 'UNKNOWN'), /목록에 없는/);
});

test('duplicate IDs and required columns fail before processing', async () => {
  const dir = await outputFor(), file = path.join(dir, 'bad.csv');
  await fs.writeFile(file, 'literature_id,pdf_status,file_path\na,확보 완료,a.pdf\na,확보 완료,b.pdf\n');
  await assert.rejects(catalogRows(file), /중복/);
  await fs.writeFile(file, 'literature_id,title\na,title\n');
  await assert.rejects(catalogRows(file), /필수 열/);
});

test('dry-run invokes no parser and creates no output', async () => {
  const dir = await outputFor(), output = path.join(dir, 'must-not-exist');
  const result = await run({ catalog, output, 'dry-run': true }, { parser: () => assert.fail('parser called') });
  assert.equal(result.targets.length, 6);
  await assert.rejects(fs.access(output));
});

test('quality flags empty text, replacement characters, pages, tables and OCR warnings', () => {
  assert.equal(qualityOf(good).status, '변환 완료');
  assert.equal(qualityOf({ markdown: '', pages: [] }).status, '검토 필요');
  const q = qualityOf({ markdown: '�', pages: [{ pageNumber: 2, markdown: '' }], blocks: [{ type: 'table' }], warnings: [{ code: 'OCR_FAILED' }] });
  assert.ok(q.issues.length >= 4);
  assert.equal(q.visualComparison, '미실시');
});

test('cache reuses complete result and preserves manually edited output', async () => {
  const output = await outputFor(); let count = 0;
  const parser = async () => { count++; return good; };
  const first = await run(opts(output), { parser });
  const second = await run(opts(output), { parser });
  assert.equal(count, 1); assert.equal(second.records[0].reused, true);
  const md = path.join(first.records[0].result, 'document.md');
  await fs.writeFile(md, '사용자 수정');
  const third = await run(opts(output), { parser });
  assert.equal(count, 2);
  assert.notEqual(third.records[0].result, first.records[0].result);
  assert.equal(await fs.readFile(md, 'utf8'), '사용자 수정');
});

test('review-needed results are retried, not cached as complete', async () => {
  const output = await outputFor(); let count = 0;
  const parser = async () => { count++; return { ...good, warnings: ['OCR unavailable'] }; };
  await run(opts(output), { parser }); await run(opts(output), { parser });
  assert.equal(count, 2);
});

test('changed PDF hash creates a new version without touching previous result', async () => {
  const output = await outputFor(), localCatalog = path.join(output, 'catalog.csv');
  const source = path.join(output, 'copy.pdf');
  await fs.copyFile(path.join(fixtures, '정상.pdf'), source);
  await fs.writeFile(localCatalog, 'literature_id,pdf_status,file_path\nCOPY,확보 완료,copy.pdf\n');
  const args = { ...opts(path.join(output, 'results')), catalog: localCatalog, ids: 'COPY' };
  const first = await run(args, { parser: async () => good });
  await fs.appendFile(source, '\n% synthetic change\n');
  const second = await run(args, { parser: async () => good });
  assert.equal(second.records[0].reused, false);
  assert.notEqual(first.records[0].result, second.records[0].result);
  assert.equal(await fs.readFile(path.join(first.records[0].result, 'document.md'), 'utf8'), good.markdown);
});

test('missing path, HTML, unacquired files and parser failure are isolated', async () => {
  const output = await outputFor(); let count = 0;
  const result = await run({ ...opts(output), ids: 'T01,T02,T03,T05,T06' }, { parser: async source => {
    count++; if (source.endsWith('손상.pdf')) throw new Error('synthetic parser failure'); return good;
  } });
  assert.equal(count, 2);
  assert.deepEqual(result.records.map(r => r.status), ['변환 완료', '실패', '실패', '건너뜀', '실패']);
});

test('real kordoc extracts Korean text and two PDF pages', { timeout: 190000 }, async () => {
  const result = await parseIsolated(path.join(fixtures, '정상.pdf'));
  assert.equal(result.success, true);
  assert.match(result.markdown, /학습자는/);
  assert.equal(result.pages.length, 2);
});

test('real kordoc rejects corrupt PDF', { timeout: 190000 }, async () => {
  const result = await parseIsolated(path.join(fixtures, '손상.pdf'));
  assert.equal(result.success, false);
});

test('real scan either extracts Korean or explicitly reports OCR unavailable', { timeout: 190000 }, async () => {
  const result = await parseIsolated(path.join(fixtures, '스캔.pdf'));
  assert.equal(result.success, true);
  const warnings = JSON.stringify(result.warnings ?? []);
  assert.ok(/학습자/.test(result.markdown) || /OCR_FAILED|NEEDS_OCR/.test(warnings));
  if (/OCR_FAILED|NEEDS_OCR/.test(warnings)) assert.equal(qualityOf(result).status, '검토 필요');
});
