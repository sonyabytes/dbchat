// Called by changesets/action after the "Version Packages" PR merges.
// Creates and pushes the v<version> tag, which triggers .github/workflows/release.yml.
import { $ } from "bun";
import pkg from "../apps/desktop/package.json";

const tag = `v${pkg.version}`;
const existing = (await $`git tag -l ${tag}`.text()).trim();
if (existing) {
  console.log(`${tag} already exists, skipping`);
  process.exit(0);
}
await $`git tag ${tag}`;
await $`git push origin ${tag}`;
console.log(`pushed ${tag}`);
