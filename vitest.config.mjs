// Les tests sont ceux de src/ : les fichiers compilés de dist/ (npm run build) ne doivent pas être rejoués,
// sinon une partie des tests est comptée deux fois (et peut être périmée).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["dist/**", "node_modules/**", "python-port/**"] },
});
