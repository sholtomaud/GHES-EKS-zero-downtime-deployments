import type { TerraformStack } from "cdktn";
import { Testing } from "cdktn";

/** Synthesised OpenTofu JSON for one stack. */
export interface Synth {
  terraform?: Record<string, any>;
  provider?: Record<string, any[]>;
  resource?: Record<string, Record<string, any>>;
  data?: Record<string, Record<string, any>>;
  output?: Record<string, any>;
}

export function synth(stack: TerraformStack): Synth {
  return JSON.parse(Testing.synth(stack));
}

/** All resources of one type, as an array of their synthesised bodies. */
export function resources(s: Synth, type: string): any[] {
  return Object.values(s.resource?.[type] ?? {});
}

export function one(s: Synth, type: string): any {
  const all = resources(s, type);
  if (all.length !== 1) throw new Error(`expected exactly one ${type}, found ${all.length}`);
  return all[0];
}

/** IAM JSON documents are synthesised as strings that contain ${...} interpolations; they still parse. */
export function policy(doc: string): { Statement: any[] } {
  return JSON.parse(doc);
}

export function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
