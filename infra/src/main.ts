// Entry point for `cdktn synth` (cdktf.json "app"). Synthesises every stack,
// then rewrites each one into a conventional multi-file root module.
import { App, TerraformStack } from "cdktn";
import { buildApp } from "./app.ts";
import { writeLayout } from "./layout.ts";

const app = buildApp(new App());
app.synth();
writeLayout(
  app.outdir,
  app.node.children.filter((c): c is TerraformStack => c instanceof TerraformStack),
  process.env.SKIP_TOFU_FMT !== "1",
);
