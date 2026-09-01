import "dotenv/config";
import { pathToFileURL } from "node:url";
import { resolveDirectLinkedInJob } from "./resolver/directResolver.js";

export * from "./types.js";
export * from "./resolver/directResolver.js";
export * from "./resolver/validateDestination.js";
export * from "./apply/applyLever.js";
export * from "./apply/applyJob.js";
export * from "./apply/generalFacts.js";
export * from "./apply/runLedger.js";
export * from "./apply/generalSafety.js";
export * from "./apply/applyAgent.js";
export * from "./apply/applicationResult.js";
export * from "./apply/candidateCatalog.js";
export * from "./apply/terminalChat.js";

const isDirectExecution = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isDirectExecution && process.argv.length > 2) {
  const linkedinUrl = process.argv[2];

  console.log(`Starting direct LinkedIn resolution for: ${linkedinUrl}\n`);

  resolveDirectLinkedInJob({ linkedinUrl })
    .then((result) => {
      console.log("Result:\n", JSON.stringify(result, null, 2));
      if (!result.success) {
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("Unexpected failure:", error);
      process.exit(1);
    });
}
