import "dotenv/config";
import { TerminalChat } from "./terminalChat.js";

async function main(): Promise<void> {
  const chat = new TerminalChat();

  let exiting = false;
  const cleanup = async () => {
    if (exiting) return;
    exiting = true;
    console.log("\nReceived shutdown signal. Closing session and exiting...");
    await chat.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  try {
    const resume = process.argv.slice(2).includes("--resume");
    const initialArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
    await chat.start(initialArg, resume);
  } finally {
    await chat.close();
  }
}

main().catch((error) => {
  console.error("Fatal error in terminal client:", error);
  process.exit(1);
});
