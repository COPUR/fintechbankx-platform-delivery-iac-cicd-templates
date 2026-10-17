#!/usr/bin/env node
// Memory plan of the local / ephemeral stack for a set of compose profiles.
//
//   node plan-memory.mjs --config FILE --profiles "payments monolith" [--budget-mib N] [--json]
//
// FILE is the compose model as JSON: `docker compose config --format json` (fbx-local.sh plan
// writes it; values are already interpolated and mem_limit is in bytes), or docker-compose.yml
// parsed as is (the tests), in which case ${VAR:-default} in mem_limit is read from the
// environment. Every container in the requested profiles must have a mem_limit.
//
// steady: the long-running containers together. peak: the largest total of containers that can
// run at the same time. A one-shot job (restart: "no") has ended before any container that waits
// for it (depends_on condition service_completed_successfully, directly or through another
// dependency) starts, so it never counts together with that container; every other pair can
// overlap. With --budget-mib N (N > 0) the plan fails when peak exceeds N.
import fs from "node:fs";

const args = { json: false, budget: 0 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--json") args.json = true;
  else if (a === "--config") args.config = process.argv[++i];
  else if (a === "--profiles") args.profiles = process.argv[++i];
  else if (a === "--budget-mib") args.budget = Number(process.argv[++i]);
  else { console.error(`[plan-memory] unknown argument: ${a}`); process.exit(2); }
}
if (!args.config || args.profiles === undefined) {
  console.error("usage: plan-memory.mjs --config FILE --profiles \"<profile ...>\" [--budget-mib N] [--json]");
  process.exit(2);
}
if (!Number.isFinite(args.budget) || args.budget < 0) { console.error("[plan-memory] --budget-mib must be a number >= 0"); process.exit(2); }

const fail = (msg) => { console.error(`[plan-memory] ${msg}`); process.exit(2); };
const readModel = () => {
  try {
    return JSON.parse(fs.readFileSync(args.config, "utf8"));
  } catch (e) {
    return fail(`cannot read the compose model from ${args.config} (did docker compose config fail?): ${e.message}`);
  }
};
const services = readModel().services ?? {};
const requested = new Set(args.profiles.split(/\s+/).filter(Boolean));

const interpolate = (value) =>
  String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g, (_, name, def) => process.env[name] || def || "");
const toMiB = (value, name) => {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(interpolate(value).trim());
  if (!m) fail(`${name}: mem_limit ${JSON.stringify(value)} is not a size`);
  const factor = { b: 1 / 1048576, k: 1 / 1024, m: 1, g: 1024 }[(m[2] ?? "b").toLowerCase()];
  return Math.ceil(Number(m[1]) * factor);
};

const active = Object.entries(services).filter(([, s]) => !s.profiles?.length || s.profiles.some((p) => requested.has(p)));
const names = new Set(active.map(([n]) => n));
const containers = active.map(([name, s]) => {
  if (s.mem_limit === undefined || s.mem_limit === null || s.mem_limit === "") fail(`${name} has no mem_limit`);
  return { name, mib: toMiB(s.mem_limit, name), oneShot: String(s.restart ?? "") === "no", deps: s.depends_on ?? {} };
});
const byName = Object.fromEntries(containers.map((c) => [c.name, c]));

// before(x): the jobs that have completed before x starts.
const memo = new Map();
const before = (name, stack = new Set()) => {
  if (memo.has(name)) return memo.get(name);
  if (stack.has(name)) fail(`dependency cycle at ${name}`);
  stack.add(name);
  const out = new Set();
  const deps = byName[name].deps;
  const entries = Array.isArray(deps) ? deps.map((d) => [d, {}]) : Object.entries(deps);
  for (const [dep, spec] of entries) {
    if (!names.has(dep)) continue; // a dependency outside the profiles (required: false)
    if ((spec?.condition ?? "service_started") === "service_completed_successfully") out.add(dep);
    for (const j of before(dep, stack)) out.add(j);
  }
  stack.delete(name);
  memo.set(name, out);
  return out;
};
for (const c of containers) c.before = before(c.name);

const longRunning = containers.filter((c) => !c.oneShot);
const jobs = containers.filter((c) => c.oneShot);
const steadyMiB = longRunning.reduce((s, c) => s + c.mib, 0);
if (jobs.length > 20) fail(`${jobs.length} one-shot jobs: too many to plan exactly`);
let peakMiB = steadyMiB;
let peakSet = longRunning.map((c) => c.name);
for (let mask = 1; mask < 1 << jobs.length; mask++) {
  const chosen = jobs.filter((_, i) => mask & (1 << i));
  if (chosen.some((a) => chosen.some((b) => a !== b && b.before.has(a.name)))) continue;
  const alongside = longRunning.filter((c) => !chosen.some((j) => c.before.has(j.name)));
  const total = [...chosen, ...alongside].reduce((s, c) => s + c.mib, 0);
  if (total > peakMiB) { peakMiB = total; peakSet = [...chosen, ...alongside].map((c) => c.name); }
}

const result = {
  profiles: [...requested],
  containers: containers.map(({ name, mib, oneShot }) => ({ name, mib, oneShot })),
  steadyMiB, peakMiB, peakSet, budgetMiB: args.budget,
};
if (args.json) console.log(JSON.stringify(result));
else {
  for (const c of containers) console.log(`${c.name.padEnd(42)} ${String(c.mib).padStart(6)} MiB${c.oneShot ? "  one-shot" : ""}`);
  console.log(`steady ${steadyMiB} MiB (long-running containers), peak ${peakMiB} MiB (largest set that can run at once)`);
}
if (args.budget > 0 && peakMiB > args.budget) {
  console.error(`[plan-memory] planned peak ${peakMiB} MiB for profiles "${args.profiles}" exceeds the memory budget of ${args.budget} MiB; run one lane at a time (compose/lanes.tsv) or lower FBX_SERVICE_MEM_LIMIT`);
  process.exit(1);
}
