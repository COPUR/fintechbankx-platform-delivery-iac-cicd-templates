// Structure tests for the ephemeral-env reusable workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- ephemeral-env workflow -----------------------------------------------------

test("ephemeral-env workflow: inputs, health wait, always uploads and always tears down", () => {
  const wf = YAML.parse(fs.readFileSync(path.join(repo, ".github", "workflows", "ephemeral-env.yml"), "utf8"));
  const inputs = wf.on.workflow_call.inputs;
  for (const name of ["service-images", "monolith-image", "test-command", "profiles", "mode", "platform-ref"]) {
    assert.ok(inputs[name], `input ${name} missing`);
  }
  assert.deepEqual(wf.permissions, { contents: "read" });
  for (const [id, job] of Object.entries(wf.jobs)) {
    assert.ok(job["timeout-minutes"], `${id} needs a timeout`);
    const steps = job.steps;
    const teardown = steps.find((s) => /tear ?down/i.test(s.name ?? ""));
    assert.ok(teardown, `${id} has no teardown step`);
    assert.equal(teardown.if, "${{ always() }}");
    assert.equal(steps.indexOf(teardown), steps.length - 1, `${id}: teardown must be the last step`);
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
    assert.ok(upload && upload.if === "${{ always() }}", `${id} must always upload results`);
    assert.ok(steps.some((s) => /wait|health/i.test(s.name ?? "")), `${id} must wait for health`);
    assert.ok(steps.some((s) => String(s.env?.TEST_COMMAND ?? "").includes("inputs.test-command")), `${id} must pass the test command via env`);
  }
});

// --- regression-parity additions -------------------------------------------------------

const workflow = () => YAML.parse(fs.readFileSync(path.join(repo, ".github", "workflows", "ephemeral-env.yml"), "utf8"));
const stepIndex = (steps, re) => steps.findIndex((s) => re.test(s.name ?? ""));

test("ephemeral-env: parity fixtures, SQL fixtures, seed hook and service env, in order before the test command", () => {
  const wf = workflow();
  const inputs = wf.on.workflow_call.inputs;
  assert.equal(inputs["parity-fixtures"].type, "boolean");
  assert.equal(inputs["parity-fixtures"].default, false);
  for (const name of ["seed-command", "service-env", "sql-fixtures"]) {
    assert.equal(inputs[name].type, "string", name);
    assert.equal(inputs[name].default, "", `${name} is optional`);
  }
  const steps = wf.jobs.ephemeral.steps;
  const text = JSON.stringify(steps);
  const validate = stepIndex(steps, /^Validate inputs/);
  const init = stepIndex(steps, /generate dev-only credentials/);
  const up = stepIndex(steps, /Start stack/);
  const exportEnv = stepIndex(steps, /Export test environment/);
  const sql = stepIndex(steps, /SQL fixtures/);
  const seed = stepIndex(steps, /seed command/i);
  const testStep = stepIndex(steps, /Run test command/);
  for (const [n, i] of Object.entries({ validate, init, up, exportEnv, sql, seed, testStep })) assert.ok(i >= 0, `${n} step missing`);
  assert.ok(validate < init && init < up && up < exportEnv && exportEnv < sql && sql < seed && seed < testStep, "step order");
  // Parity fixtures: init-env flag plus the compose profile.
  assert.match(steps[init].run, /--parity-fixtures/);
  assert.match(text, /parity-fixtures/);
  // Service env and SQL fixture lists are validated before anything starts.
  assert.match(steps[validate].run, /service-env/);
  assert.match(steps[validate].run, /apply-sql-fixtures\.sh.*--check/s);
  assert.equal(steps[sql].if, "${{ inputs.sql-fixtures != '' }}");
  assert.equal(steps[seed].if, "${{ inputs.seed-command != '' }}");
  assert.ok(String(steps[seed].env.SEED_COMMAND).includes("inputs.seed-command"), "seed command via env, never inlined");
  assert.equal(steps[seed]["working-directory"], "${{ inputs.working-directory }}");
  assert.ok(!/\$\{\{\s*inputs\.(seed-command|test-command|service-env|sql-fixtures)/.test(
    steps.map((s) => s.run ?? "").join("\n")), "untrusted inputs never interpolated into scripts");
  // The env file stays a file reference; generated credentials are masked in logs.
  assert.match(steps[exportEnv].run, /FBX_ENV_FILE=/);
  assert.match(steps[init].run, /add-mask/);
  assert.match(steps[init].run, /PARITY_TPP_PRIVATE_JWK/, "private JWK members are masked too");
});

test("ephemeral-env: monolith from a pinned image or built from the caller's context", () => {
  const wf = workflow();
  const inputs = wf.on.workflow_call.inputs;
  for (const name of ["monolith-build-context", "monolith-build-command", "monolith-health-path"]) {
    assert.equal(inputs[name].type, "string", name);
  }
  assert.equal(inputs["monolith-spring-profiles"].default, "local", "the oracle's own profile");
  assert.equal(inputs["monolith-health-path"].default, "/actuator/health");
  const steps = wf.jobs.ephemeral.steps;
  const validate = steps[stepIndex(steps, /^Validate inputs/)];
  assert.match(validate.run, /image_ok "\$MONOLITH_IMAGE"/, "pulled images stay pinned");
  assert.match(validate.run, /not both/, "image and build context are exclusive");
  const build = stepIndex(steps, /Build monolith image/);
  assert.ok(build >= 0, "build step missing");
  assert.equal(steps[build].if, "${{ inputs.monolith-build-context != '' }}");
  assert.ok(String(steps[build].env.BUILD_COMMAND).includes("inputs.monolith-build-command"));
  assert.match(steps[build].run, /docker build/);
  assert.match(steps[build].run, /FBX_MONOLITH_IMAGE=/);
  assert.ok(build < stepIndex(steps, /Start stack/));
});
