import "dotenv/config";
import { applyJob } from "./applyJob.js";
import { loadCandidateProfile } from "./profile.js";
import { ensureSyntheticResume } from "./resume.js";
import { candidateProfileToCatalog } from "./candidateCatalog.js";

/**
 * npm run apply:test
 *
 * Runs safely in no-submit mode by default. `--factual` loads the private
 * profile without authorizing submission. `npm run apply:submit` loads the
 * same profile and explicitly authorizes one validated submit attempt.
 */
async function main(): Promise<void> {
  const submit = process.argv.includes("--submit");
  const urlFlag = process.argv.indexOf("--url");
  const applicationUrl = urlFlag >= 0 ? process.argv[urlFlag + 1] : process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!applicationUrl) {
    console.error("apply:test requires --url <application-url> or a positional application URL");
    process.exit(1);
  }
  const useFactualProfile = submit || process.argv.includes("--factual");
  let profile;

  if (useFactualProfile) {
    const loaded = await loadCandidateProfile();
    if (!loaded.ok) {
      console.error(`Candidate profile check failed before browser work: ${loaded.error}`);
      process.exit(1);
    }
    profile = loaded.profile;
    console.log(submit
      ? "Loaded approved factual candidate profile; one validated submission attempt is authorized."
      : "Loaded approved factual candidate profile; submission is disabled.");
  } else {
    const resume = await ensureSyntheticResume();
    if (!resume.ok) {
      console.error(`apply:test failed before browser work: ${resume.error}`);
      process.exit(1);
    }
    console.log(`Using approved resume at ${resume.filePath}; submission is disabled.`);
  }

  const candidate = profile ?? (await import("./profile.js")).createSyntheticProfile();
  const result = await applyJob({ applicationUrl, catalog: candidateProfileToCatalog(candidate), submit });
  console.log("Application result:\n", JSON.stringify(result, null, 2));
  process.exit(result.status === (submit ? "submitted" : "ready_to_submit") ? 0 : 1);
}

main().catch((error) => {
  console.error("Unexpected apply:test failure:", error);
  process.exit(1);
});
