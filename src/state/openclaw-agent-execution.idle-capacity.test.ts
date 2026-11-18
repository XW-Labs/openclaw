import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  resolveIdleAgentExecutionCapacity,
} from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const source: AgentDatabaseRequestExecutionSource = {
  assertCurrent: () => undefined,
  createAdmission(binding) {
    return () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Idle capacity fixture lost admission");
        }
      }, binding.attachment),
    });
  },
};

it.each([
  { value: undefined, expected: 1 },
  { value: "4", expected: 4 },
  { value: "0", expected: 1 },
  { value: "2.5", expected: 1 },
  { value: "99", expected: 16 },
])("resolves idle capacity $value to $expected", ({ value, expected }) => {
  expect(resolveIdleAgentExecutionCapacity({ OPENCLAW_AGENT_DB_IDLE_EXECUTIONS: value })).toBe(
    expected,
  );
});

it.each([
  { capacity: undefined, warm: ["c"] },
  { capacity: "2", warm: ["b", "c"] },
])("keeps the newest idle agent databases open (capacity $capacity)", async ({ capacity, warm }) => {
  if (capacity) {
    vi.stubEnv("OPENCLAW_AGENT_DB_IDLE_EXECUTIONS", capacity);
  }
  const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("agent-idle-capacity-")) };
  for (const agentId of ["a", "b", "c"]) {
    const execution = captureOpenClawAgentDatabaseExecution({ agentId, env });
    await execution.prepare(source);
    expect(await execution.runExisting(source, async () => agentId)).toBe(agentId);
    await execution.release();
  }
  const prepared: string[] = [];
  for (const agentId of ["c", "b", "a"]) {
    const probe = captureOpenClawAgentDatabaseExecution({ agentId, env });
    if (probe.capturePreparedGenerationClaim() !== undefined) {
      prepared.push(agentId);
    }
    await probe.release();
  }
  expect(prepared.toSorted()).toEqual(warm);
});
