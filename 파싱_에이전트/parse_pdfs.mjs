#!/usr/bin/env node
// Node.js >=20. Install: pnpm install --frozen-lockfile. See README.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { parse as parseCsv } from 'csv-parse/sync';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OPTIONS = { ocr: true, images: false, scriptTags: true };
const VERSION = '4.21.22';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = async p => { try { await fs.access(p); return true; } catch { return false; } };
const escapeCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const clean = value => String(value ?? '').replace(/[\r\n|]/g, ' ').slice(0, 2000);

export function argumentsFor(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--dry-run', '--help'].includes(flag)) args[flag.slice(2)] = true;
    else if (['--catalog', '--output', '--ids', '--approval-note'].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag}: 값이 필요합니다.`);
      if (args[flag.slice(2)] !== undefined) throw new Error(`${flag}: 중복 옵션`);
      args[flag.slice(2)] = argv[++i];
    } else throw new Error(`알 수 없는 옵션: ${flag}`);
  }
  if (args.help) return args;
  if (!args.catalog) throw new Error('--catalog가 필요합니다.');
  if (!args['dry-run'] && (!args.ids?.trim() || !args['approval-note']?.trim())) {
    throw new Error('실제 파싱에는 승인된 --ids와 사용자 승인 근거 --approval-note가 필요합니다.');
  }
  return args;
}

export async function catalogRows(catalog, ids) {
  const raw = await fs.readFile(catalog);
  const rows = parseCsv(raw, { bom: true, columns: true, skip_empty_lines: true, trim: true });
  for (const field of ['literature_id', 'pdf_status', 'file_path']) {
    if (!rows.length || !Object.hasOwn(rows[0], field)) throw new Error(`CSV 필수 열 누락 또는 빈 목록: ${field}`);
  }
  const seen = new Set();
  for (const row of rows) {
    if (!row.literature_id || seen.has(row.literature_id)) throw new Error(`비어 있거나 중복된 문헌 ID: ${row.literature_id}`);
    seen.add(row.literature_id);
  }
  const selected = ids ? new Set(ids.split(',').map(s => s.trim()).filter(Boolean)) : null;
  if (selected?.size === 0) throw new Error('선택한 ID가 없습니다.');
  if (selected) for (const id of selected) if (!seen.has(id)) throw new Error(`목록에 없는 ID: ${id}`);
  return { rows: rows.filter(r => !selected || selected.has(r.literature_id)), catalogHash: hash(raw) };
}

export function qualityOf(result) {
  const issues = [];
  const text = result.markdown ?? '';
  const pages = result.pages ?? [];
  if (!text.trim()) issues.push('빈 본문: OCR 모델·의존성 또는 원문 확인 필요');
  if (text.includes('\uFFFD')) issues.push('대체 문자 발견: 한글·문자 인코딩 깨짐 의심');
  if (!pages.length) issues.push('페이지별 본문 없음: 페이지 누락 여부 확인 필요');
  const numbers = pages.map(p => p.pageNumber);
  if (numbers.some((n, i) => n !== i + 1)) issues.push('PDF 페이지 번호 중복·불연속');
  const pageCount = result.metadata?.pageCount;
  if (Number.isInteger(pageCount) && pageCount !== pages.length) issues.push('페이지 수와 추출 페이지 수 불일치');
  for (const p of pages) if (!(p.markdown ?? '').trim()) issues.push(`PDF ${p.pageNumber}쪽 빈 추출: 빈 페이지 또는 OCR 필요`);
  const structured = JSON.stringify(result.blocks ?? []);
  if (/"type":"table"/.test(structured) || /<table|\|.+\|/.test(text)) issues.push('표 구조 원문 대조 필요');
  const warnings = [result.warnings, result.metadata?.warnings].flat().filter(Boolean);
  for (const warning of warnings) issues.push(`kordoc 경고: ${typeof warning === 'string' ? warning : JSON.stringify(warning)}`);
  return {
    status: issues.length ? '검토 필요' : '변환 완료', issues,
    automatedChecks: ['본문 공백', '대체 문자', '페이지 순서·공백·개수(제공 시)', '표 존재', 'kordoc 경고'],
    visualComparison: '미실시', readingOrder: '미검증: 다단·표·각주 읽기 순서는 원문 대조 필요',
    pageNumberMeaning: 'PDF 파일 내 1부터 시작하는 순서. 인쇄된 논문 쪽수가 아님.',
  };
}

export function parseIsolated(source, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(here, 'parse_worker.mjs'), [source], {
      cwd: here, env: { ...process.env, KORDOC_OFFLINE: '1', KORDOC_MODEL_CACHE: process.env.KORDOC_MODEL_CACHE || path.join(here, '.cache', 'models') },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let tail = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve(result);
    };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { tail = (tail + d.toString()).slice(-6000); });
    const timer = setTimeout(() => finish(new Error('파일 처리 제한 180초 초과')), timeoutMs);
    child.on('message', msg => {
      if (msg.error) finish(new Error(msg.error));
      else {
        const result = msg.result;
        if (/warn|error|missing|offline|unavailable|not found|failed/i.test(tail)) {
          result.warnings = [...(result.warnings ?? []), tail];
        }
        finish(null, result);
      }
    });
    child.on('error', error => finish(error));
    child.on('exit', code => { if (!settled) finish(new Error(`파서 프로세스 종료 (${code}): ${tail}`)); });
  });
}

async function reuseResult(docDir, key) {
  if (!(await exists(docDir))) return null;
  for (const name of (await fs.readdir(docDir)).sort().reverse()) {
    const folder = path.join(docDir, name);
    try {
      const data = JSON.parse(await fs.readFile(path.join(folder, 'document.json'), 'utf8'));
      const md = await fs.readFile(path.join(folder, 'document.md'));
      if (data.cacheKey === key && data.quality.status === '변환 완료' && data.markdownHash === hash(md)) return { folder, data };
    } catch { /* Incomplete or edited artifacts are never overwritten. */ }
  }
  return null;
}

export async function run(args, dependencies = {}) {
  const catalog = await fs.realpath(path.resolve(args.catalog));
  const output = path.resolve(args.output ?? path.join(path.dirname(catalog), '파싱'));
  const { rows, catalogHash } = await catalogRows(catalog, args.ids);
  const preview = [];
  for (const row of rows) {
    const source = row.file_path ? path.resolve(path.dirname(catalog), row.file_path) : null;
    preview.push({ literature_id: row.literature_id, pdf_status: row.pdf_status, source,
      eligible: row.pdf_status === '확보 완료', fileExists: source ? await exists(source) : false });
  }
  if (args['dry-run']) return { dryRun: true, catalog, output, targets: preview };
  if (!args.ids?.trim() || !args['approval-note']?.trim()) throw new Error('승인 ID 및 근거가 필요합니다.');
  const packageInfo = JSON.parse(await fs.readFile(path.join(here, 'node_modules/kordoc/package.json'), 'utf8'));
  if (packageInfo.version !== VERSION) throw new Error(`kordoc 버전 불일치: ${packageInfo.version} (필요: ${VERSION})`);
  const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
  const records = [];
  const parser = dependencies.parser ?? parseIsolated;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], target = preview[i];
    const record = { literature_id: row.literature_id, source: target.source, status: '건너뜀', reason: '', reused: false, result: '' };
    records.push(record);
    if (!target.eligible) { record.reason = `PDF 확보 상태: ${row.pdf_status}`; continue; }
    try {
      if (!target.source || !target.fileExists) throw new Error('PDF 파일 경로가 없거나 파일이 존재하지 않음');
      if (path.extname(target.source).toLowerCase() !== '.pdf') throw new Error('PDF 확장자가 아님');
      const bytes = await fs.readFile(target.source);
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('PDF 헤더 없음: HTML 또는 잘못된 파일');
      const sourceHash = hash(bytes);
      const cacheKey = hash(JSON.stringify({ sourceHash, version: VERSION, options: OPTIONS, policyVersion: 1 }));
      const safeId = row.literature_id.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60) || 'document';
      const docDir = path.join(output, 'documents', `${safeId}-${hash(row.literature_id).slice(0, 8)}`);
      const cached = await reuseResult(docDir, cacheKey);
      if (cached) {
        record.status = '변환 완료'; record.reused = true; record.result = cached.folder;
        record.reason = '동일 원본 해시·버전·옵션 및 Markdown 무결성 확인 후 재사용'; continue;
      }
      const result = await parser(target.source);
      if (!result?.success) throw new Error(`kordoc 실패: ${JSON.stringify(result?.error ?? result?.errors ?? '상세 오류 없음')}`);
      // Detect a source changed while the parser was running.
      if (hash(await fs.readFile(target.source)) !== sourceHash) throw new Error('처리 중 원본 변경: 결과 저장 중단');
      const quality = qualityOf(result);
      const folder = path.join(docDir, runId);
      await fs.mkdir(folder, { recursive: true });
      const markdown = result.markdown ?? '';
      const data = { schemaVersion: 1, literatureId: row.literature_id, source: target.source,
        sourceHash, catalog, catalogHash, cacheKey, parsedAt: new Date().toISOString(),
        kordocVersion: VERSION, options: OPTIONS, offline: true, quality,
        markdownHash: hash(markdown), metadata: result.metadata ?? {}, pages: result.pages ?? [],
        blocks: result.blocks ?? [], warnings: result.warnings ?? [],
      };
      await fs.writeFile(path.join(folder, 'document.md'), markdown, { flag: 'wx' });
      await fs.writeFile(path.join(folder, 'document.json'), json(data), { flag: 'wx' });
      record.status = quality.status; record.reason = quality.issues.join('; '); record.result = folder;
    } catch (error) { record.status = '실패'; record.reason = String(error.message); }
  }
  const runDir = path.join(output, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  const manifest = { runId, catalog, catalogHash, approvalNote: args['approval-note'], approvedIds: args.ids,
    kordocVersion: VERSION, options: OPTIONS, records };
  await fs.writeFile(path.join(runDir, 'manifest.json'), json(manifest), { flag: 'wx' });
  const fields = ['literature_id', 'status', 'reason', 'reused', 'source', 'result'];
  const csv = '\uFEFF' + fields.join(',') + '\r\n' + records.map(r => fields.map(f => escapeCell(r[f])).join(',')).join('\r\n') + '\r\n';
  await fs.writeFile(path.join(runDir, 'parsing_catalog.csv'), csv, { flag: 'wx' });
  const report = ['# PDF 파싱 검증 보고서', '', `실행: ${runId}`, `kordoc: ${VERSION}`, '',
    '자동 점검 결과입니다. 변환 완료는 원문 전체 검토 완료가 아닙니다.',
    '시각적 원문 대조: 미실시. 표·다단·각주 읽기 순서: 별도 검토 필요.',
    '페이지 번호는 PDF 파일 내 순서이며 논문 인쇄 쪽수와 다릅니다.',
    'OCR 설치·모델 누락은 경고/실패 사유를 확인하고 README의 로컬 설치 절차로 해결합니다.', '',
    '| 문헌 ID | 상태 | 재사용 | 사유 |', '| --- | --- | --- | --- |',
    ...records.map(r => `| ${clean(r.literature_id)} | ${r.status} | ${r.reused} | ${clean(r.reason)} |`), '',
    '상세 경로·승인 근거·원본 목록 해시는 manifest.json에 기록했습니다.', ''].join('\n');
  await fs.writeFile(path.join(runDir, 'verification_report.md'), report, { flag: 'wx' });
  return { runDir, records };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFor(process.argv.slice(2));
    if (args.help) console.log('node parse_pdfs.mjs --catalog <CSV> [--output <폴더>] [--ids ID1,ID2] [--dry-run] [--approval-note <승인 근거>]');
    else {
      const result = await run(args); console.log(json(result));
      if (result.records?.some(r => r.status === '실패')) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
