import type { TerraformStack } from "cdktn";
import { Testing } from "cdktn";

/** Synthesised OpenTofu JSON for one stack. Semantic tests read this; layout tests read the HCL. */
export interface Synth {
  terraform?: Record<string, any>;
  provider?: Record<string, any[]>;
  resource?: Record<string, Record<string, any>>;
  data?: Record<string, Record<string, any>>;
  locals?: Record<string, any>;
}

export function synth(stack: TerraformStack): Synth {
  return JSON.parse(Testing.synth(stack));
}

/** Resource bodies of one type, keyed by Terraform name. */
export function byName(s: Synth, type: string): Record<string, any> {
  return s.resource?.[type] ?? {};
}

export function resources(s: Synth, type: string): any[] {
  return Object.values(byName(s, type));
}

export function one(s: Synth, type: string): any {
  const all = resources(s, type);
  if (all.length !== 1) throw new Error(`expected exactly one ${type}, found ${all.length}`);
  return all[0];
}

/** Statements of the aws_iam_policy_document referenced by `${data.aws_iam_policy_document.<name>.json}`. */
export function statements(s: Synth, reference: string): any[] {
  const m = /^\$\{data\.aws_iam_policy_document\.([a-z0-9_]+)\.json\}$/.exec(reference);
  if (!m) throw new Error(`not a policy document reference: ${reference}`);
  return asArray(s.data?.aws_iam_policy_document?.[m[1]]?.statement);
}

/** Condition values for one (test, variable) pair of a statement. */
export function condition(stmt: any, test: string, variable: string): string[] | undefined {
  return asArray<any>(stmt.condition).find((c) => c.test === test && c.variable === variable)?.values;
}

export function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
