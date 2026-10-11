// The IP budget model from docs/03-ip-address-budget.md §2 as code, so a design
// change that breaks NET-01/NET-02 fails a test. Routable IPs only: there is no
// secondary CIDR (Q3). Figures are estimates until slice 2 measures them.
import type { InstallProfile } from "./config.ts";

export const NET_01_LIMIT = 50;

/** Fixed facts of the chosen design (ADR-0004). */
const design = {
  services: 8,
  azs: 2,
  controlPlaneEnis: 4, // (verify) EKS places 2–4 cross-account ENIs in cluster subnets
  platformPods: 4, // CoreDNS ×2 + AWS Load Balancer Controller ×2, all on Fargate
  albPerAzMin: 1,
  albPeakTotal: 8, // ALB can scale out during a release; AWS advises headroom
  maxSurgePerService: 1, // rolling update; Helm/Argo roll all 8 Deployments at once
};

const replicas: Record<InstallProfile, number> = { minimal: 1, standard: 2, ha: 2 };
const rdsEnis: Record<InstallProfile, number> = { minimal: 1, standard: 1, ha: 2 };

export interface Line {
  steady: number;
  peak: number;
}

export interface Budget {
  steady: number;
  peak: number;
  lines: Record<
    "controlPlane" | "nodes" | "appPods" | "platformPods" | "warmPool" | "loadBalancer" | "database" | "vpcEndpoints" | "delivery",
    Line
  >;
}

export function budget(profile: InstallProfile): Budget {
  const app = design.services * replicas[profile];
  const lines: Budget["lines"] = {
    controlPlane: { steady: design.controlPlaneEnis, peak: design.controlPlaneEnis },
    nodes: { steady: 0, peak: 0 }, // Fargate: no nodes
    appPods: { steady: app, peak: app + design.services * design.maxSurgePerService },
    platformPods: { steady: design.platformPods, peak: design.platformPods },
    warmPool: { steady: 0, peak: 0 }, // Fargate: exactly one IP per pod
    loadBalancer: { steady: design.albPerAzMin * design.azs, peak: design.albPeakTotal },
    database: { steady: rdsEnis[profile], peak: rdsEnis[profile] },
    vpcEndpoints: { steady: 0, peak: 0 }, // not a constraint (Q14)
    delivery: { steady: 0, peak: 0 }, // managed Argo CD runs outside the VPC; CodeConnections ENIs are in the tooling VPC
  };
  const sum = (k: keyof Line) => Object.values(lines).reduce((n, l) => n + l[k], 0);
  return { steady: sum("steady"), peak: sum("peak"), lines };
}

/** NET-02: the peak must leave at least `headroom` of the account's usable IPs free. */
export function fitsAccount(b: Budget, usableIps: number, headroom: number): boolean {
  return b.peak <= usableIps * (1 - headroom);
}
