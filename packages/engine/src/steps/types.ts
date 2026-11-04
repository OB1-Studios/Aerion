import type { RunStepName } from "@ebo/db";
import type { EngineDeps, WorkspaceContext } from "../context";

export interface StepContext {
  deps: EngineDeps;
  w: WorkspaceContext;
  runId: string;
  stepId: string;
  /** Totals that end up on the run row. */
  counts: Record<string, number>;
  /** Plain-language lines for the run report, in order. */
  report: string[];
}

export type StepOutput = Record<string, unknown>;

export interface Step {
  name: RunStepName;
  run(c: StepContext): Promise<StepOutput>;
}

export const bump = (c: StepContext, key: string, by = 1) => {
  c.counts[key] = (c.counts[key] ?? 0) + by;
};
