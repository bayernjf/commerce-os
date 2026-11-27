#!/usr/bin/env node
/**
 * OpenAPI breaking-change guard.
 *
 * Bundles the current `openapi.yaml` and the version at `HEAD` into JSON and
 * reports contract changes that would break existing clients. The check is
 * intentionally conservative: it only flags removals and new required inputs,
 * never additions.
 *
 * Usage: npm run openapi:breaking
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spec = 'openapi.yaml';
const dir = mkdtempSync(join(tmpdir(), 'openapi-diff-'));
const currentPath = join(dir, 'current.json');
const baselinePath = join(dir, 'baseline.json');

function bundle(input, output) {
  execFileSync('npx', ['redocly', 'bundle', input, '--ext', 'json', '-o', output], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function diffFieldPaths(a = {}, b = {}, prefix = '') {
  const removed = [];
  const aKeys = Object.keys(a ?? {});
  const bKeys = new Set(Object.keys(b ?? {}));
  for (const key of aKeys) {
    if (!bKeys.has(key)) removed.push(`${prefix}${key}`);
  }
  return removed;
}

function checkBreaking(current, baseline) {
  const problems = [];
  const basePaths = baseline.paths ?? {};
  const curPaths = current.paths ?? {};

  for (const [path, baseItem] of Object.entries(basePaths)) {
    if (!curPaths[path]) {
      problems.push(`removed path: ${path}`);
      continue;
    }
    const curItem = curPaths[path];
    for (const [method, baseOp] of Object.entries(baseItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)) continue;
      if (!curItem[method]) {
        problems.push(`removed operation: ${method.toUpperCase()} ${path}`);
        continue;
      }
      const curOp = curItem[method];

      // Removed 2xx response codes break clients that rely on them.
      const base2xx = Object.keys(baseOp.responses ?? {}).filter((s) => s.startsWith('2'));
      const cur2xx = new Set(Object.keys(curOp.responses ?? {}));
      for (const status of base2xx) {
        if (!cur2xx.has(status)) problems.push(`removed ${status} response: ${method.toUpperCase()} ${path}`);
      }

      // New required request-body fields: a client that omits them now fails.
      const baseReq = baseOp.requestBody?.content?.['application/json']?.schema?.required ?? [];
      const curReq = new Set(curOp.requestBody?.content?.['application/json']?.schema?.required ?? []);
      for (const field of baseReq) {
        if (!curReq.has(field)) problems.push(`removed required request field '${field}': ${method.toUpperCase()} ${path}`);
      }

      // Removed required response fields: a client reading them breaks.
      const baseResp = baseOp.responses ?? {};
      const curResp = curOp.responses ?? {};
      for (const [status, baseRespItem] of Object.entries(baseResp)) {
        if (!status.startsWith('2')) continue;
        const curRespItem = curResp[status];
        const baseSchema = baseRespItem?.content?.['application/json']?.schema;
        const curSchema = curRespItem?.content?.['application/json']?.schema;
        if (baseSchema?.required && curSchema?.required) {
          const missing = diffFieldPaths(
            Object.fromEntries(baseSchema.required.map((f) => [f, true])),
            Object.fromEntries(curSchema.required.map((f) => [f, true])),
          );
          for (const field of missing) {
            problems.push(`removed required response field '${field}': ${method.toUpperCase()} ${path} ${status}`);
          }
        }
      }
    }
  }
  return problems;
}

try {
  bundle(spec, currentPath);
  const baselineYaml = join(dir, 'baseline.yaml');
  let hasBaseline = true;
  try {
    execFileSync('bash', ['-c', `git show HEAD:openapi.yaml > "${baselineYaml}"`], { stdio: 'pipe' });
  } catch {
    hasBaseline = false;
  }
  if (!hasBaseline) {
    console.log('openapi-breaking: no baseline spec at HEAD, skipping diff');
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  bundle(baselineYaml, baselinePath);
} catch (err) {
  console.error(`openapi-breaking: failed to bundle specs\n${err.stderr ?? err.message}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const current = JSON.parse(readFileSync(currentPath, 'utf8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
rmSync(dir, { recursive: true, force: true });

const problems = checkBreaking(current, baseline);
if (problems.length > 0) {
  console.error('openapi-breaking: contract regression detected:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('openapi-breaking: no breaking changes detected');
