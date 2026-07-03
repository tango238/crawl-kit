// packages/structure/src/analyze-cli.ts
//
// `pnpm --filter @crawl-kit/structure analyze <repo-path>`
// Runs the rdra-analyzer-style analysis on a real repository and writes the SAME
// structure outputs the static-fixture `emit` produces — the contract is identical, so
// the reconciler/viewer don't care whether the StructureExtract came from a fixture or
// from live source. With no LLM backend configured the parser yields nothing and we say
// so (point ANTHROPIC_API_KEY or USE_CLAUDE_CODE at it to get a real extraction).

import { analyzeRepo } from "./analyze/index.js";
import { reportCorrections, writeStructureOutputs } from "./outputs.js";

async function main(): Promise<void> {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: analyze <repo-path>");
    process.exit(2);
  }

  const maxRoutes = process.env.ANALYZE_MAX_ROUTES ? Number(process.env.ANALYZE_MAX_ROUTES) : undefined;
  const skipEntityOperations = ["1", "true", "yes"].includes((process.env.ANALYZE_SKIP_ENTITY_OPS ?? "").toLowerCase());

  console.log(`structure/analyze: parsing ${repo} ...`);
  const { extract, provider, parsed, usecases } = await analyzeRepo(repo, { maxRoutes, skipEntityOperations });
  console.log(
    `  provider: ${provider} | routes ${parsed.routes.length} / models ${parsed.models.length} / ` +
      `pages ${parsed.pages.length} / usecases ${usecases.length}`,
  );

  if (extract.entities.length === 0 && extract.routes.length === 0) {
    console.log(
      "  no structure extracted. Configure an LLM backend (ANTHROPIC_API_KEY or USE_CLAUDE_CODE=true) to analyze live source.",
    );
    return;
  }

  const { applied, counts } = await writeStructureOutputs(extract, `analyze-${process.pid}`);
  reportCorrections(applied);
  console.log(`  -> ${counts.entities} entities, ${counts.routes} routes → data/structure.{nodes,rdra}.json + *.mmd`);
}

main().catch((error) => {
  console.error(`analyze failed: ${(error as Error).message}`);
  process.exit(1);
});
