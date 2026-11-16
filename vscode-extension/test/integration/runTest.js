/* Launch the integration suite in a downloaded VS Code (headless under
 * xvfb-run). VS Code 1.146's extension-test host no longer injects Mocha
 * globals: the test entry must export a `run` function. That entry is
 * @vscode/test-cli's runner (out/runner.cjs), which sets up Mocha (TDD)
 * and loads the suite files listed in VSCODE_TEST_OPTIONS.
 *
 * Environment notes (this container, as root):
 * - The test-electron download fails here because tar cannot chown the
 *   extracted files to uid 1000 (Operation not permitted), so the
 *   already-extracted binary under .vscode-test/ is reused via
 *   vscodeExecutablePath. That directory is gitignored, never pushed.
 * - --no-sandbox is required because the tests run as root.
 */
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..");
  // The runner is not in the package's `exports` map, so resolve it by
  // direct path instead of require.resolve.
  const extensionTestsPath = path.join(
    extensionDevelopmentPath,
    "node_modules",
    "@vscode/test-cli",
    "out",
    "runner.cjs",
  );
  const workspaceFolder = path.resolve(extensionDevelopmentPath, "..");
  process.env.VSCODE_TEST_OPTIONS = JSON.stringify({
    files: [path.resolve(__dirname, "suite", "index.js")],
    mochaOpts: { timeout: 20000 },
    preload: [],
    colorDefault: false,
  });
  const vscodeExecutablePath = path.resolve(
    extensionDevelopmentPath,
    ".vscode-test",
    "vscode-linux-x64-1.146.0",
    "code",
  );
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    // NOTE: test-electron 2.x has no `workspaceFolder` option — the
    // workspace is opened by passing its path as the first launch arg.
    launchArgs: [workspaceFolder, "--disable-extensions", "--no-sandbox"],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
