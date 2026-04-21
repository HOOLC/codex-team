const { spawnSync } = require("node:child_process");

const extraArgs = process.argv.slice(2);
const TUI_TEST_FILE = "tests/tui.test.ts";

function runRstest(args) {
  return spawnSync("pnpm", ["exec", "rstest", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
}

function listTasks(args) {
  const result = runRstest(["list", ...args]);
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
  return (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripTestNamePatternArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--testNamePattern" || arg === "-t") {
      index += 1;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

const listLines = listTasks(extraArgs);
const files = [...new Set(
  listLines
    .map((line) => line.split(" > ")[0])
    .filter((line) => line.endsWith(".test.ts")),
)];

if (files.length === 0) {
  const result = runRstest(["run", ...extraArgs]);
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status || 1);
}

const sharedArgs = stripTestNamePatternArgs(extraArgs);

for (const file of files) {
  if (file === TUI_TEST_FILE) {
    const testNames = listLines
      .filter((line) => line.startsWith(`${TUI_TEST_FILE} > `))
      .map((line) => line.replace(`${TUI_TEST_FILE} > `, ""));
    for (const name of testNames) {
      process.stdout.write(`RUN ${TUI_TEST_FILE} :: ${name}\n`);
      const result = runRstest(["run", TUI_TEST_FILE, "--testNamePattern", name, ...sharedArgs]);
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      if (result.status !== 0) {
        process.stdout.write(`FAILED ${TUI_TEST_FILE} :: ${name} exit=${result.status}\n`);
        process.exit(result.status || 1);
      }
    }
    continue;
  }

  process.stdout.write(`RUN ${file}\n`);
  const result = runRstest(["run", file, ...extraArgs]);
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    process.stdout.write(`FAILED ${file} exit=${result.status}\n`);
    process.exit(result.status || 1);
  }
}
