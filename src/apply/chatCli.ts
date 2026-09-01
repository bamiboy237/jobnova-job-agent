import "dotenv/config";
import { TerminalChat } from "./terminalChat.js";

async function main(): Promise<void> {
  const chat = new TerminalChat();

  let exiting = false;
  const cleanup = async () => {
    if (exiting) return;
    exiting = true;
    console.log("\nReceived shutdown signal. Closing browser and exiting...");
    await chat.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  try {
    const initialArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    await chat.start(initialArg);
  } finally {
    await chat.close();
  }
}

main().catch((error) => {
  console.error("Fatal error in terminal client:", error);
  process.exit(1);
});
