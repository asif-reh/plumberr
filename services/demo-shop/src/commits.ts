import { randomBytes } from "node:crypto";

/** Simulated git history of the target repo, used when the GitHub App is not configured. */
export interface SimCommit { sha: string; author: string; message: string; files: string[]; timestamp: string; diff: string }
const commits: SimCommit[] = [
  {
    sha: randomBytes(20).toString("hex"),
    author: "shaik",
    message: "docs: README",
    files: ["README.md"],
    timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(),
    diff: "+ This repo is broken on purpose. PRs are by Plumberr.",
  },
];
export function addCommit(c: Omit<SimCommit, "sha" | "timestamp">) {
  const commit = { ...c, sha: randomBytes(20).toString("hex"), timestamp: new Date().toISOString() };
  commits.unshift(commit);
  return commit;
}
export const listCommits = (sinceMinutes = 60) =>
  commits.filter((c) => Date.parse(c.timestamp) >= Date.now() - sinceMinutes * 60_000);
export const getCommit = (sha: string) => commits.find((c) => c.sha.startsWith(sha));
