'use strict';
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '4', 10);
const TIME_LIMIT_MS = parseInt(process.env.TIME_LIMIT_MS || '2000', 10);
const MEM_LIMIT_BYTES = 256 * 1024 * 1024;
const MAX_OUT = 64 * 1024;
const MAX_CODE = 100 * 1024;
const MAX_INPUT = 100 * 1024;
const SANDBOX_UID = 65534; // "nobody"
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const IS_WIN = process.platform === 'win32';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const BIN = path.join('prog' + (IS_WIN ? '.exe' : ''));

// prlimit (Linux only) gives hard CPU/memory limits. Without it we still use the wall-clock timeout.
let HAS_PRLIMIT = false;
try {
  HAS_PRLIMIT = process.platform === 'linux' && !process.env.NO_PRLIMIT &&
    require('child_process').spawnSync('prlimit', ['--version']).status === 0;
} catch (_) { /* not available */ }
function limited(limits, cmd, args) {
  return HAS_PRLIMIT ? ['prlimit', [...limits, cmd, ...args]] : [cmd, args];
}

const ARRAY_PROBLEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'array.json'), 'utf8'))
  .map((p) => ({ ...p, category: p.category || 'Array' }));
const TWO_D_ARRAY_PROBLEMS = JSON.parse(fs.readFileSync(path.join(__dirname, '2d array.json'), 'utf8'))
  .map((p) => ({ ...p, category: p.category || '2D Arrays' }));
const LOGICAL_PROBLEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'logical.json'), 'utf8'))
  .map((p) => ({ ...p, category: p.category || 'Logical' }));
const STRING_PROBLEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'strings.json'), 'utf8'));
const FUNCTION_PROBLEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'functions.json'), 'utf8'));
const SORTING_PROBLEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'sorting.json'), 'utf8'))
  .map((p) => ({ ...p, category: p.category || 'Sorting' }))
  .sort((a, b) => ({ sort7: 1, sort2: 2, sort1: 3, sort3: 4, sort6: 5, sort4: 6, sort5: 7 }[a.id] || 99) - ({ sort7: 1, sort2: 2, sort1: 3, sort3: 4, sort6: 5, sort4: 6, sort5: 7 }[b.id] || 99));
const PROBLEMS = [...LOGICAL_PROBLEMS, ...ARRAY_PROBLEMS, ...TWO_D_ARRAY_PROBLEMS, ...STRING_PROBLEMS, ...FUNCTION_PROBLEMS, ...SORTING_PROBLEMS];
const BY_ID = new Map(PROBLEMS.map((p) => [p.id, p]));

// ---------- tiny job semaphore ----------
let active = 0;
const waiting = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_JOBS) { active++; resolve(); } else waiting.push(resolve);
  });
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active--;
}

// ---------- process helper ----------
function killGroup(p) {
  try {
    if (IS_WIN) p.kill();
    else process.kill(-p.pid, 'SIGKILL');
  } catch (_) { /* already gone */ }
}

function exec(cmd, args, { input = '', timeoutMs, cwd }) {
  return new Promise((resolve) => {
    // As root on Linux (Docker) the child gets a minimal environment. On a laptop the compiler needs the
    // normal PATH etc., so pass the environment through, minus the access code.
    const env = IS_ROOT
      ? { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', HOME: cwd, TMPDIR: cwd }
      : { ...process.env, HOME: cwd, TMPDIR: cwd, TMP: cwd, TEMP: cwd };
    delete env.ACCESS_CODE;
    const opts = {
      cwd,
      detached: !IS_WIN,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    };
    if (IS_ROOT) { opts.uid = SANDBOX_UID; opts.gid = SANDBOX_UID; }

    let p;
    try { p = spawn(cmd, args, opts); } catch (e) {
      return resolve({ code: -1, signal: null, out: '', err: String(e), timedOut: false, truncated: false, ms: 0 });
    }
    let out = '', err = '', timedOut = false, truncated = false, done = false;
    const start = Date.now();
    const timer = setTimeout(() => { timedOut = true; killGroup(p); }, timeoutMs);

    p.stdout.on('data', (d) => {
      if (out.length < MAX_OUT) out += d.toString('latin1');
      else if (!truncated) { truncated = true; killGroup(p); }
    });
    p.stderr.on('data', (d) => { if (err.length < MAX_OUT) err += d.toString('latin1'); });
    p.stdin.on('error', () => {});
    p.stdin.end(input);

    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(p);
      resolve({ code, signal, out, err, timedOut, truncated, ms: Date.now() - start });
    };
    p.on('error', (e) => { err += String(e); finish(-1, null); });
    p.on('close', finish);
  });
}

// ---------- compile / run ----------
async function withWorkdir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sub-'));
  try {
    if (IS_ROOT) await fsp.chown(dir, SANDBOX_UID, SANDBOX_UID);
    return await fn(dir);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function compile(dir, code) {
  const src = path.join(dir, 'main.c');
  await fsp.writeFile(src, code);
  if (IS_ROOT) await fsp.chown(src, SANDBOX_UID, SANDBOX_UID);
  const [cmd, args] = limited(
    ['--cpu=20', '--fsize=33554432'],
    'gcc',
    ['-O2', '-std=gnu17', '-o', BIN, 'main.c', '-lm', '-lpthread']
  );
  const r = await exec(cmd, args, { cwd: dir, timeoutMs: 20000 });
  if (r.timedOut) return { ok: false, message: 'Compilation timed out.' };
  if (r.code !== 0) {
    const msg = (r.err || r.out || 'Compilation failed.').split(dir + '/').join('');
    return { ok: false, message: msg.slice(0, 8000) };
  }
  return { ok: true, warnings: (r.err || '').split(dir + '/').join('').slice(0, 4000) };
}

function runBinary(dir, input, timeLimitMs) {
  const cpuSecs = Math.ceil(timeLimitMs / 1000) + 1;
  const [cmd, args] = limited(
    [`--as=${MEM_LIMIT_BYTES}`, `--cpu=${cpuSecs}`, '--fsize=1048576', '--core=0', '--nofile=32'],
    path.join(dir, BIN),
    []
  );
  return exec(cmd, args, { cwd: dir, input, timeoutMs: timeLimitMs });
}

function verdictOf(r) {
  if (r.timedOut) return 'TLE';
  if (r.truncated) return 'OLE';
  if (r.signal || r.code !== 0) return 'RE';
  return null;
}

// ---------- output comparison ----------
const toks = (s) => s.replace(/\r/g, '').trim().split(/\s+/).filter(Boolean);

function tokEq(a, b) {
  if (a === b) return true;
  const x = Number(a), y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && /[.eE]/.test(a + b)) {
    return Math.abs(x - y) <= 1e-3 * Math.max(1, Math.abs(y));
  }
  return false;
}

function matches(expected, actual, mode) {
  const e = toks(expected), a = toks(actual);
  if (mode === 'contains') return a.join(' ').includes(e.join(' '));
  if (e.length !== a.length) return false;
  return e.every((t, i) => tokEq(a[i], t));
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '300kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Optional shared access code (set ACCESS_CODE=...). Strongly recommended when sharing a public link.
app.use('/api', (req, res, next) => {
  if (!ACCESS_CODE || req.get('x-access-code') === ACCESS_CODE) return next();
  res.status(401).json({ error: 'Access code required.' });
});

// crude per-IP cooldown so nobody hammers the compiler
const last = new Map();
function cooldown(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  if (now - (last.get(ip) || 0) < 1500) return res.status(429).json({ error: 'Slow down a little.' });
  last.set(ip, now);
  next();
}

// Hidden tests are NEVER included here.
app.get('/api/problems', (req, res) => {
  res.json(PROBLEMS.map((p) => ({
    id: p.id,
    category: p.category,
    title: p.title,
    statement: p.statement,
    template: p.template || null,
    tests: p.tests.filter((t) => t.visible).map((t) => ({ input: t.input, expected: t.expected })),
    hiddenCount: p.tests.filter((t) => !t.visible).length,
  })));
});

app.post('/api/run', cooldown, async (req, res) => {
  const { code, input } = req.body || {};
  if (typeof code !== 'string' || code.length > MAX_CODE) return res.status(400).json({ error: 'Bad code.' });
  const stdin = typeof input === 'string' ? input.slice(0, MAX_INPUT) : '';
  await acquire();
  try {
    const result = await withWorkdir(async (dir) => {
      const c = await compile(dir, code);
      if (!c.ok) return { status: 'CE', compileError: c.message };
      const r = await runBinary(dir, stdin, TIME_LIMIT_MS);
      const v = verdictOf(r);
      return {
        status: v || 'OK',
        stdout: r.out,
        stderr: r.err.slice(0, 4000),
        exitCode: r.code,
        signal: r.signal,
        timeMs: r.ms,
        warnings: c.warnings,
      };
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    release();
  }
});

app.post('/api/submit', cooldown, async (req, res) => {
  const { code, problemId } = req.body || {};
  const prob = BY_ID.get(problemId);
  if (!prob) return res.status(404).json({ error: 'Unknown problem.' });
  if (typeof code !== 'string' || code.length > MAX_CODE) return res.status(400).json({ error: 'Bad code.' });
  await acquire();
  try {
    const result = await withWorkdir(async (dir) => {
      const c = await compile(dir, code);
      if (!c.ok) return { compiled: false, compileError: c.message };
      const results = [];
      let vi = 0, hi = 0;
      for (const t of prob.tests) {
        const r = await runBinary(dir, t.input, prob.timeLimitMs || TIME_LIMIT_MS);
        let status = verdictOf(r);
        if (!status) status = matches(t.expected, r.out, prob.compare) ? 'AC' : 'WA';
        if (t.visible) {
          results.push({ kind: 'visible', index: ++vi, status, input: t.input, expected: t.expected, output: r.out.slice(0, 4000), timeMs: r.ms });
        } else {
          // hidden: verdict only, nothing else leaves the server
          results.push({ kind: 'hidden', index: ++hi, status });
        }
      }
      const passed = results.filter((x) => x.status === 'AC').length;
      return { compiled: true, results, passed, total: results.length };
    });
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    release();
  }
});

app.listen(PORT, () => {
  console.log(`C practice running on http://localhost:${PORT}`);
  console.log(`  sandbox user: ${IS_ROOT ? 'nobody (uid ' + SANDBOX_UID + ')' : 'same user as this server (use Docker for isolation)'}`);
  console.log(`  resource limits (prlimit): ${HAS_PRLIMIT ? 'on' : 'off, only the time limit applies'}`);
  console.log(`  access code: ${ACCESS_CODE ? 'required' : 'NOT set (anyone who can reach this port can use it)'}`);
});
