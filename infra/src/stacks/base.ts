import { S3Backend, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider/index.js";
import type { StateConfig } from "../config.ts";

export const REQUIRED_TOFU = ">= 1.13.0";

export interface BaseProps {
  accountId: string;
  region: string;
  state: StateConfig;
  tags: Record<string, string>;
}

/** Every stack: one account, S3 state with native locking, default tags, OpenTofu >= 1.13. */
export class BaseStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: BaseProps) {
    super(scope, id);
    this.addOverride("terraform.required_version", REQUIRED_TOFU);

    new S3Backend(this, {
      bucket: props.state.bucket,
      key: `${id}/terraform.tfstate`,
      region: props.state.region,
      encrypt: true,
      useLockfile: true,
    });

    new AwsProvider(this, "aws", {
      region: props.region,
      allowedAccountIds: [props.accountId],
      defaultTags: [{ tags: { "managed-by": "cdktn", stack: id, ...props.tags } }],
    });
  }
}

/** IAM JSON helper: tokens inside strings resolve to ${...} interpolations at synth. */
export const iamDoc = (...Statement: object[]) => JSON.stringify({ Version: "2012-10-17", Statement });
