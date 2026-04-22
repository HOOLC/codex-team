const { spawnSync } = require("node:child_process");
const path = require("node:path");

const extraArgs = process.argv.slice(2);
const TUI_TEST_FILE = "tests/tui.test.ts";
const TUI_TEST_PATH = path.resolve(process.cwd(), TUI_TEST_FILE);
const RETRYABLE_RSTEST_PATTERNS = [
  /Worker exited unexpectedly/i,
];
const MAX_RETRYABLE_ATTEMPTS = 2;

function runRstest(args) {
  return spawnSync("pnpm", ["exec", "rstest", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
  });
}

function exitWithStatus(status) {
  process.exit(typeof status === "number" ? status : 1);
}

function listTasks(args) {
  const result = runRstest(["list", "--json", ...args]);
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    exitWithStatus(result.status);
  }
  return JSON.parse(result.stdout || "[]");
}

function isRetryableRstestFailure(result) {
  if (result.status === 0) {
    return false;
  }

  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  return RETRYABLE_RSTEST_PATTERNS.some((pattern) => pattern.test(combinedOutput));
}

function runWithRetry(label, args) {
  for (let attempt = 1; attempt <= MAX_RETRYABLE_ATTEMPTS; attempt += 1) {
    if (attempt === 1) {
      process.stdout.write(`RUN ${label}\n`);
    } else {
      process.stdout.write(`RETRY ${label} (${attempt}/${MAX_RETRYABLE_ATTEMPTS})\n`);
    }

    const result = runRstest(args);
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");

    if (result.status === 0 || !isRetryableRstestFailure(result) || attempt === MAX_RETRYABLE_ATTEMPTS) {
      return result;
    }
  }

  return runRstest(args);
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

function toGlobPath(file) {
  const relativePath = path.relative(process.cwd(), file);
  return `**/${relativePath.split(path.sep).join("/")}`;
}

function listFiles(args) {
  return listTasks(["--filesOnly", ...args])
    .filter((item) => typeof item?.file === "string" && item.file.endsWith(".test.ts"))
    .map((item) => item.file);
}

function listTestNamesForFile(file, args) {
  return listTasks(["--include", toGlobPath(file), ...args])
    .filter((item) => item?.type === "case" && item.file === file)
    .map((item) => item.name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

const files = [...new Set(listFiles(extraArgs))];

if (files.length === 0) {
  const result = runRstest(["run", ...extraArgs]);
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  exitWithStatus(result.status);
}

const sharedArgs = stripTestNamePatternArgs(extraArgs);

for (const file of files) {
  if (file === TUI_TEST_PATH) {
    const testNames = listTestNamesForFile(file, extraArgs);
    for (const name of testNames) {
      const result = runWithRetry(`${TUI_TEST_FILE} :: ${name}`, [
        "run",
        "--include",
        toGlobPath(file),
        "--testNamePattern",
        name,
        ...sharedArgs,
      ]);
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      if (result.status !== 0) {
        process.stdout.write(`FAILED ${TUI_TEST_FILE} :: ${name} exit=${result.status}\n`);
        exitWithStatus(result.status);
      }
    }
    continue;
  }

  const relativeFile = path.relative(process.cwd(), file);
  const result = runWithRetry(relativeFile, ["run", "--include", toGlobPath(file), ...extraArgs]);
  if (result.status !== 0) {
    process.stdout.write(`FAILED ${relativeFile} exit=${result.status}\n`);
    exitWithStatus(result.status);
  }
}
