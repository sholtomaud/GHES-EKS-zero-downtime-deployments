import type { App } from "cdktn";
import { tooling, workloads } from "./config.ts";
import { ToolingStack } from "./stacks/tooling-stack.ts";
import { WorkloadStack } from "./stacks/workload-stack.ts";

/** One stack per AWS account; each has its own state and provider. */
export function buildApp(app: App): App {
  new ToolingStack(app, "tooling", { tooling, workloads });
  for (const env of workloads) new WorkloadStack(app, `workload-${env.name}`, { env, tooling });
  return app;
}
