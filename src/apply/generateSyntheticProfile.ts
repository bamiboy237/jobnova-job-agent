import fs from "node:fs/promises";
import path from "node:path";
import { createSyntheticProfile } from "./profile.js";

const target = path.resolve(process.cwd(), "data/candidate/profile.json");
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify(createSyntheticProfile(), null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote synthetic candidate profile to ${target}`);
