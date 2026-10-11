import { Fn, NamedRemoteWorkspace, ref, RemoteBackend, TerraformDataSource, TerraformElement, TerraformStack } from "cdktn";
import { Construct } from "constructs";
import type { Node } from "constructs";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider/index.js";
import {
  DataAwsIamPolicyDocument,
  type DataAwsIamPolicyDocumentStatement,
} from "@cdktn/provider-aws/lib/data-aws-iam-policy-document/index.js";
import type { StateConfig } from "../config.ts";

export const REQUIRED_TOFU = ">= 1.13.0";

export interface BaseProps {
  accountId: string;
  region: string;
  state: StateConfig;
  tags: Record<string, string>;
}

/**
 * A logical group of resources. Each group synthesises to its own `<group>.tf`
 * file (see src/layout.ts), so group ids are file names: short, snake_case.
 */
export class Group extends Construct {}

/**
 * Every stack: one account, state in Artifactory, default tags,
 * OpenTofu >= 1.13, and Terraform-style resource names.
 *
 * Naming: a resource's name is its construct id in snake_case, with no hash
 * suffix. Construct ids must be unique among siblings, so `name:qualifier`
 * lets two resources of different types share a name (e.g. an access entry
 * and its policy association are both `principals`). Two resources of the
 * same type with the same name fail synthesis.
 */
export class BaseStack extends TerraformStack {
  private readonly allocated = new Map<string, string>();
  /** Non-HCL files the root module ships (written next to the .tf files by src/layout.ts). */
  readonly files = new Map<string, string>();

  constructor(scope: Construct, id: string, props: BaseProps) {
    super(scope, id);

    // State in Artifactory's Terraform Backend repository, one workspace per
    // stack. No token here: `tofu login <hostname>` or TF_TOKEN_<host>.
    new RemoteBackend(this, {
      hostname: props.state.hostname,
      organization: props.state.repository,
      workspaces: new NamedRemoteWorkspace(id),
    });

    new AwsProvider(this, "aws", {
      region: props.region,
      allowedAccountIds: [props.accountId],
      defaultTags: [{ tags: { "managed-by": "cdktn", stack: id, ...props.tags } }],
    });
  }

  protected allocateLogicalId(tfElement: TerraformElement | Node): string {
    const node = tfElement instanceof TerraformElement ? tfElement.node : tfElement;
    const name = node.id.split(":")[0].replace(/[^A-Za-z0-9]+/g, "_").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const kind = (tfElement as { terraformResourceType?: string }).terraformResourceType ?? "element";
    const key = `${tfElement instanceof TerraformDataSource ? "data." : ""}${kind}.${name}`;
    const owner = this.allocated.get(key);
    if (owner !== undefined && owner !== node.path) {
      throw new Error(`duplicate Terraform address ${key}: ${owner} and ${node.path}`);
    }
    this.allocated.set(key, node.path);
    return name;
  }

  /** Ship a JSON document as policies/<name>.json and return `file(...)` for it. */
  policyFile(name: string, document: unknown): string {
    const path = `policies/${name}.json`;
    this.files.set(path, JSON.stringify(document, null, 2) + "\n");
    return Fn.file(`${ref("path.module")}/${path}`);
  }

  /** Validations run on synth; also fold in the OpenTofu floor here (the HCL renderer drops overrides). */
  toTerraform(): any {
    const tf = super.toTerraform();
    tf.terraform = { required_version: REQUIRED_TOFU, ...tf.terraform };
    return tf;
  }
}

/** An `aws_iam_policy_document` data source: idiomatic HCL instead of an escaped JSON string. */
export function iamPolicy(scope: Construct, id: string, statement: DataAwsIamPolicyDocumentStatement[]): DataAwsIamPolicyDocument {
  return new DataAwsIamPolicyDocument(scope, id, { statement });
}
