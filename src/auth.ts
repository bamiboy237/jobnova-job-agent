import readline from "node:readline";
import "dotenv/config";
import { createLocalSession, createRemoteSession, saveLocalBrowserState } from "./browser/session.js";

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [process.env.BROWSERBASE_API_KEY, process.env.GEMINI_API_KEY]) {
    if (secret) message = message.replaceAll(secret, "***");
  }
  return message.replace(/wss:\/\/[^\s]+/g, "wss://***");
}

async function promptUser(questionText: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(questionText, () => {
      rl.close();
      resolve();
    });
  });
}

export async function runLinkedInAuth(): Promise<void> {
  const useLocalBrowser = process.env.BROWSER_PROVIDER === "local";
  const contextId = process.env.BROWSERBASE_CONTEXT_ID;
  if (!useLocalBrowser && !contextId) {
    throw new Error("BROWSERBASE_CONTEXT_ID is not configured in .env");
  }

  console.log(`Creating ${useLocalBrowser ? "local Chrome" : "Browserbase"} persistent session for LinkedIn authentication...`);
  const session = useLocalBrowser
    ? await createLocalSession()
    : await createRemoteSession({ persistContext: true });

  try {
    console.log("Navigating to LinkedIn login page...");
    await session.page.goto("https://www.linkedin.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log("\n=======================================================");
    console.log("LINKEDIN AUTHENTICATION SETUP");
    console.log("=======================================================");
    if (session.inspectorUrl) {
      console.log(`Session Inspector: ${session.inspectorUrl}`);
    } else {
      console.log("Use the local Chrome window that opened.");
    }
    console.log("=======================================================\n");
    console.log(useLocalBrowser ? "1. Use the local Chrome window." : "1. Open the Live View or Session Inspector link in your browser.");
    console.log("2. Complete LinkedIn login and any verification prompts.");
    console.log("3. Once you see your LinkedIn feed or confirm you are signed in, return here.\n");

    await promptUser("Press [ENTER] after you have completed sign-in in the browser: ");

    await session.page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const cookies = await session.context.cookies("https://www.linkedin.com");
    const hasAuthenticatedSession = cookies.some((cookie) => cookie.name === "li_at" && cookie.value.length > 0);

    if (!hasAuthenticatedSession) {
      throw new Error("LinkedIn authentication was not completed before confirmation");
    }

    if (useLocalBrowser) {
      await saveLocalBrowserState(session.context);
    }

    console.log("\nAuthenticated state verified successfully! Closing session to save context...");
  } finally {
    await session.close();
  }

  console.log(`Authenticated state saved to the ${useLocalBrowser ? "local Chrome profile" : "configured Browserbase context"}.`);
}

// Direct execution
if (process.argv[1] && (process.argv[1].endsWith("auth.ts") || process.argv[1].endsWith("auth.js"))) {
  runLinkedInAuth().catch((err) => {
    console.error("Auth setup error:", safeError(err));
    process.exit(1);
  });
}
