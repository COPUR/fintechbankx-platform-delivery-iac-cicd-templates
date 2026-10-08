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
