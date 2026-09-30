import { defineConfig } from "vitest/config";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  test: {
    env: {
      VF_DB_PATH: ":memory:",
      VF_DATA_DIR: path.join(os.tmpdir(), "vf-test-data"),
      MOCK_API_KEY: "test-api-key",
      MOCK_API_BEARER_TOKEN: "test-bearer-token",
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
