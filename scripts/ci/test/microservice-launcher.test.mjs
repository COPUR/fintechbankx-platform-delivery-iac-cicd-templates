// The chart checks JVM options only in the variables listed by fbx.isJvmOptionsName
// (JAVA_TOOL_OPTIONS, JDK_JAVA_OPTIONS, _JAVA_OPTIONS: the ones the JVM reads itself).
// A launcher variable such as JAVA_OPTS reaches the JVM only when a shell expands it
// into the java command line. The microservice template image starts the JVM in exec
// form and the chart sets no command/args on the application container, so no such
// variable exists today. These tests keep it that way: an image that adds a shell
// launcher must have every variable it expands into the java command line listed in
// fbx.isJvmOptionsName (chart README "Service-side TLS assertion", JVM options).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const templateDir = path.join(repo, "templates/microservice");
const dockerfile = path.join(templateDir, "Dockerfile");
const helpers = path.join(repo, "charts/fintechbankx-service/templates/_helpers.tpl");
const deployment = path.join(repo, "charts/fintechbankx-service/templates/deployment.yaml");

// The regex of fbx.isJvmOptionsName, as the chart evaluates it (Go (?i) -> JS flag i).
const jvmOptionsName = () => {
  const tpl = fs.readFileSync(helpers, "utf8");
  const m = tpl.match(/define "fbx\.isJvmOptionsName"[\s\S]*?regexMatch "([^"]+)"/);
  assert.ok(m, "fbx.isJvmOptionsName not found in _helpers.tpl");
  const src = m[1].replace(/\\\\/g, "\\");
  const ci = src.startsWith("(?i)");
  return new RegExp(ci ? src.slice(4) : src, ci ? "i" : "");
};

// Instructions of the last build stage, with line continuations joined.
const lastStage = (text) => {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map((l) => l.trim());
  const from = lines.map((l, i) => (/^FROM\s/i.test(l) ? i : -1)).filter((i) => i >= 0);
  return lines.slice(from.at(-1) ?? 0).filter((l) => l && !l.startsWith("#"));
};

const VAR = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

// ENTRYPOINT or CMD argument as Docker runs it: exec form (JSON array) as is, shell
// form under /bin/sh -c.
const startArgv = (instruction) => {
  const rest = instruction.replace(/^\S+\s+/, "");
  try {
    const argv = JSON.parse(rest);
    if (Array.isArray(argv) && argv.every((a) => typeof a === "string")) return { argv, shellForm: false };
  } catch {
    // not JSON: shell form
  }
  return { argv: ["/bin/sh", "-c", rest], shellForm: true };
};

const SHELL = /(^|\/)(sh|bash|dash|ash|zsh|ksh)$/;
const JAVA = /(^|\/)java$/;

// The argv the container runs: the last ENTRYPOINT and the last CMD of the stage. An
// exec-form ENTRYPOINT receives CMD as further arguments; a shell-form ENTRYPOINT
// ignores CMD; CMD alone is the whole command.
const effectiveArgv = (stage) => {
  const last = (re) => stage.filter((l) => re.test(l)).at(-1);
  const entry = last(/^ENTRYPOINT\s/i);
  const cmd = last(/^CMD\s/i);
  const e = entry ? startArgv(entry) : null;
  const c = cmd ? startArgv(cmd) : null;
  if (e && e.shellForm) return e.argv;
  return [...(e ? e.argv : []), ...(c ? c.argv : [])];
};

// Variables a container started from this Dockerfile expands into its java command
// line. java itself (exec form) expands nothing. A shell expands every $VAR of its
// arguments. Anything else (a launcher script with or without .sh, an init such as
// tini) is read from the template directory, and every $VAR on a java line of it
// counts; a start that cannot be read is reported as <unreadable launcher ...>, so
// the test fails until someone looks. A .sh argument of a shell is read the same way.
export const launcherVariables = (text, readScript = () => null) => {
  const argv = effectiveArgv(lastStage(text));
  const found = new Set();
  const readLauncher = (arg) => {
    const script = readScript(arg);
    if (script === null) {
      found.add(`<unreadable launcher ${arg}>`);
      return;
    }
    for (const line of script.split(/\r?\n/).filter((l) => /\bjava\b/.test(l) && !/^\s*#/.test(l))) {
      for (const [, v] of line.matchAll(VAR)) found.add(v);
    }
  };
  if (argv.length === 0 || JAVA.test(argv[0])) return [];
  if (SHELL.test(argv[0])) {
    const body = argv.slice(1).join(" ");
    for (const [, v] of body.matchAll(VAR)) found.add(v);
    for (const a of body.split(/\s+/).filter((x) => /\.sh$/.test(x))) readLauncher(a);
  } else {
    readLauncher(argv[0]);
  }
  return [...found].sort();
};

const readTemplateScript = (arg) => {
  const p = path.join(templateDir, path.basename(arg));
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
};

test("every variable the template image expands into the java command line is a JVM options name the chart checks", () => {
  const isJvm = jvmOptionsName();
  const vars = launcherVariables(fs.readFileSync(dockerfile, "utf8"), readTemplateScript);
  const unchecked = vars.filter((v) => !isJvm.test(v));
  assert.deepEqual(
    unchecked,
    [],
    `templates/microservice/Dockerfile expands ${unchecked.join(", ")} into the java command line; add it to fbx.isJvmOptionsName (with must_fail chart tests)`,
  );
});

test("the template image starts the JVM in exec form, so no launcher variable exists today", () => {
  assert.deepEqual(launcherVariables(fs.readFileSync(dockerfile, "utf8"), readTemplateScript), []);
});

test("the chart sets no command or args on the application container (only the preStop exec)", () => {
  const lines = fs.readFileSync(deployment, "utf8").split(/\r?\n/);
  const offending = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s*(command|args)\s*:/.test(l))
    .filter(({ i }) => !/^\s*exec\s*:\s*$/.test(lines[i - 1] ?? ""));
  assert.deepEqual(offending.map(({ l, i }) => `${i + 1}: ${l.trim()}`), []);
});

test("launcherVariables finds JAVA_OPTS in a shell-form start, a sh -c start and a launcher script", () => {
  const isJvm = jvmOptionsName();
  const shellForm = "FROM x\nENTRYPOINT exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher\n";
  const shC = 'FROM x\nENTRYPOINT ["sh", "-c", "exec java ${JAVA_OPTS} -cp /app Main"]\n';
  const script = 'FROM a AS build\nFROM b\nENTRYPOINT ["/app/run.sh"]\n';
  const runSh = "#!/bin/sh\n# JAVA_HOME is not a launcher variable\nexec java $JVM_OPTS -cp /app Main\n";
  assert.deepEqual(launcherVariables(shellForm), ["JAVA_OPTS"]);
  assert.deepEqual(launcherVariables(shC), ["JAVA_OPTS"]);
  assert.deepEqual(launcherVariables(script, () => runSh), ["JVM_OPTS"]);
  assert.deepEqual(launcherVariables(script), ["<unreadable launcher /app/run.sh>"]);
  assert.equal(isJvm.test("JAVA_OPTS"), false, "JAVA_OPTS is not a JVM options name today; a launcher using it must add it");
  assert.equal(isJvm.test("java_tool_options"), true);
});

test("launcherVariables follows a launcher script without a .sh extension", () => {
  const text = 'FROM b\nCOPY entrypoint /app/entrypoint\nENTRYPOINT ["/app/entrypoint"]\n';
  const entrypoint = "#!/bin/sh\nexec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher\n";
  assert.deepEqual(launcherVariables(text, (arg) => (arg === "/app/entrypoint" ? entrypoint : null)), ["JAVA_OPTS"]);
  // A start that is neither java nor a shell and cannot be read is reported, not trusted.
  assert.deepEqual(launcherVariables(text), ["<unreadable launcher /app/entrypoint>"]);
  assert.deepEqual(launcherVariables('FROM b\nENTRYPOINT ["tini", "--"]\nCMD ["java", "Main"]\n'), [
    "<unreadable launcher tini>",
  ]);
});

test("launcherVariables reads CMD as arguments of an exec-form ENTRYPOINT (Docker joins them)", () => {
  const shEntry = 'FROM b\nENTRYPOINT ["/bin/sh", "-c"]\nCMD ["exec java $JAVA_OPTS org.springframework.boot.loader.launch.JarLauncher"]\n';
  assert.deepEqual(launcherVariables(shEntry), ["JAVA_OPTS"]);
  // CMD before ENTRYPOINT in the same stage is kept as well.
  const cmdFirst = 'FROM b\nCMD ["exec java ${JVM_ARGS} Main"]\nENTRYPOINT ["bash", "-c"]\n';
  assert.deepEqual(launcherVariables(cmdFirst), ["JVM_ARGS"]);
  // A shell-form CMD alone runs under /bin/sh -c.
  assert.deepEqual(launcherVariables("FROM b\nCMD java $JAVA_OPTS Main\n"), ["JAVA_OPTS"]);
  // A shell-form ENTRYPOINT ignores CMD; an exec-form java ENTRYPOINT passes CMD unexpanded.
  assert.deepEqual(launcherVariables('FROM b\nENTRYPOINT java Main\nCMD ["$IGNORED"]\n'), []);
  assert.deepEqual(launcherVariables('FROM b\nENTRYPOINT ["java", "Main"]\nCMD ["$NOT_EXPANDED"]\n'), []);
  // Only the last ENTRYPOINT and the last CMD take effect.
  assert.deepEqual(launcherVariables('FROM b\nENTRYPOINT sh -c "java $OLD"\nENTRYPOINT ["java", "Main"]\n'), []);
});

test("launcherVariables ignores exec-form java starts and earlier build stages", () => {
  const text =
    'FROM a AS build\nENTRYPOINT sh -c "java $BUILD_OPTS"\nFROM b\nENV JAVA_TOOL_OPTIONS="-Xmx1g"\nENTRYPOINT ["java", "$JAVA_OPTS", "Main"]\n';
  assert.deepEqual(launcherVariables(text), []);
});
