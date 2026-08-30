import "dotenv/config";
import { resolveDirectLinkedInJob } from "./resolver/directResolver.js";

export * from "./types.js";
export * from "./resolver/directResolver.js";
export * from "./resolver/validateDestination.js";

// If executed directly as a CLI script
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("src/index.ts") ||
    process.argv[1].endsWith("dist/index.js") ||
    process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js"));

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
