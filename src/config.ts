import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJson } from "./util/fs.js";

export const BUILTIN_AGENTS = ["oracle", "noop", "gold-first-hunk"] as const;
export type BuiltinAgent = (typeof BUILTIN_AGENTS)[number];

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "letters, digits, '.', '_' and '-' only");

export const SetupSchema = z
  .object({
    name,
    /** Shown next to the name in reports, e.g. the model id. */
    label: z.string().optional(),
    /** One of hometurf's calibration agents. */
    builtin: z.enum(BUILTIN_AGENTS).optional(),
    /** Command line run through the shell in the task workspace. The prompt arrives on stdin. */
    command: z.string().optional(),
    /** Files copied into the workspace before the agent starts: workspace path -> file (relative to hometurf.json). */
    files: z.record(z.string(), z.string()).default({}),
    /** Workspace paths deleted before the agent starts, e.g. the repo's own CLAUDE.md. */
    remove: z.array(z.string()).default([]),
    /** Prompt template file (relative to hometurf.json). `{{description}}` and `{{task}}` are filled in. */
    prompt: z.string().optional(),
    /** Where to read cost and tokens from: Claude Code's `--output-format json` stdout, or $HOMETURF_USAGE_FILE. */
    usage: z.enum(["file", "claude-code", "none"]).default("file"),
    timeoutSec: z.number().positive().optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .refine((s) => (s.builtin === undefined) !== (s.command === undefined), {
    message: "a setup needs exactly one of `builtin` or `command`",
  });
export type Setup = z.infer<typeof SetupSchema>;

export const DEFAULT_MATCH =
  "\\b(fix|fixes|fixed|fixing|bug|bugfix|bugs|regression|crash|crashes|broken|wrong|incorrect|prevent|prevents|handle|handles)\\b|\\bissue|#\\d+|GHSA-";

export const DEFAULT_IGNORE = [
  "*.md",
  "*.rst",
  "*.adoc",
  "docs/**",
  "doc/**",
  "CHANGELOG*",
  "CHANGES*",
  "HISTORY*",
  "NEWS*",
  "AUTHORS*",
  "CONTRIBUTORS*",
  "LICENSE*",
  ".github/**",
  ".gitignore",
  ".gitattributes",
];

const ConfigSchema = z.object({
  /** Path to the repository, relative to hometurf.json. */
  repo: z.string(),
  /** Short name used in task ids. Defaults to the repository folder's name. */
  name: name.optional(),
  ref: z.string().default("HEAD"),
  /** Shell command run in every fresh checkout before tests or the agent run (install dependencies, build). */
  setup: z.string().nullable().default(null),
  setupTimeoutSec: z.number().positive().default(900),
  tests: z.object({
    /** Globs for test files. A fix's changes to these become the hidden tests; an agent's changes to them are discarded. */
    files: z.array(z.string()).min(1),
    /** Which changed test files to pass as {files}. Defaults to `files`. */
    run: z.array(z.string()).optional(),
    /** More globs the agent may not change (test config such as pytest.ini). Treated like test files. */
    protect: z.array(z.string()).default([]),
    /** Must write a JUnit XML report to {junit}. {files} is replaced by the changed test files. */
    command: z.string(),
    timeoutSec: z.number().positive().default(600),
  }),
  mine: z
    .object({
      since: z.string().optional(),
      maxCommits: z.number().int().positive().default(5000),
      /** Case-insensitive regex a commit message must match. Ignored with `all`. */
      match: z.string().default(DEFAULT_MATCH),
      all: z.boolean().default(false),
      /** Changes to these are dropped from the reference fix (docs, changelogs). */
      ignore: z.array(z.string()).default(DEFAULT_IGNORE),
      /** A commit touching these is skipped: the environment would need rebuilding (manifests, lockfiles). */
      env: z.array(z.string()).default([]),
      maxSourceFiles: z.number().int().positive().default(10),
      maxSourceLines: z.number().int().positive().default(400),
    })
    .prefault({}),
  validate: z
    .object({
      beforeRuns: z.number().int().min(1).default(2),
      afterRuns: z.number().int().min(1).default(3),
    })
    .prefault({}),
  agentTimeoutSec: z.number().positive().default(1800),
  /** Extra .gitignore-style patterns never counted as part of an agent's change. */
  scratch: z.array(z.string()).default([]),
  /** Where temporary checkouts go. Defaults to the system temp directory. */
  workDir: z.string().optional(),
  setups: z.array(SetupSchema).default([]),
});
export type ConfigFile = z.infer<typeof ConfigSchema>;

export interface Config extends ConfigFile {
  /** Directory holding hometurf.json: the benchmark directory. */
  benchDir: string;
  repoPath: string;
  repoName: string;
  runGlobs: string[];
}

export const CONFIG_FILE = "hometurf.json";

export function loadConfig(benchDir: string): Config {
  const file = path.join(benchDir, CONFIG_FILE);
  if (!fs.existsSync(file)) throw new Error(`no ${CONFIG_FILE} in ${benchDir} (create one with \`hometurf init\`)`);
  const parsed = ConfigSchema.safeParse(readJson(file));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`${file} is invalid:\n${issues}`);
  }
  const cfg = parsed.data;
  const names = new Set<string>();
  for (const s of cfg.setups) {
    if (names.has(s.name)) throw new Error(`${file}: two setups are named "${s.name}"`);
    names.add(s.name);
  }
  try {
    new RegExp(cfg.mine.match, "i");
  } catch (error) {
    throw new Error(`${file}: mine.match is not a valid regex: ${(error as Error).message}`);
  }
  const root = path.resolve(benchDir);
  for (const s of cfg.setups) {
    const needed = [...Object.values(s.files), ...(s.prompt ? [s.prompt] : [])];
    for (const rel of needed) {
      if (!fs.existsSync(path.resolve(root, rel))) throw new Error(`${file}: setup "${s.name}" refers to ${rel}, which doesn't exist`);
    }
  }
  const repoPath = path.resolve(root, cfg.repo);
  return {
    ...cfg,
    benchDir: root,
    repoPath,
    repoName: cfg.name ?? sanitizeName(path.basename(repoPath)),
    runGlobs: cfg.tests.run ?? cfg.tests.files,
    workDir: cfg.workDir ? path.resolve(root, cfg.workDir) : undefined,
  };
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40) || "repo";
}

export interface Preset {
  description: string;
  tests: { files: string[]; run: string[]; protect: string[]; command: string };
  env: string[];
  scratch: string[];
}

export const PRESETS: Record<string, Preset> = {
  "python-pytest": {
    description: "pytest, with a JUnit report via --junitxml",
    tests: {
      files: ["tests/**", "test/**", "test_*.py", "*_test.py", "conftest.py"],
      run: ["test_*.py", "*_test.py"],
      protect: ["pytest.ini", "tox.ini", "noxfile.py", "sitecustomize.py", "usercustomize.py"],
      command: "python -m pytest -p no:cacheprovider -q --junitxml={junit} {files}",
    },
    env: ["pyproject.toml", "setup.py", "setup.cfg", "requirements*.txt", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "pdm.lock"],
    scratch: ["__pycache__/", "*.py[cod]", ".pytest_cache/", ".venv/", ".tox/", ".mypy_cache/", ".ruff_cache/"],
  },
  "node-test": {
    description: "Node's built-in test runner, with its JUnit reporter",
    tests: {
      files: ["test/**", "tests/**", "__tests__/**", "*.test.{js,mjs,cjs}", "*.spec.{js,mjs,cjs}"],
      run: ["*.test.{js,mjs,cjs}", "*.spec.{js,mjs,cjs}", "test/**/*.{js,mjs,cjs}"],
      protect: [],
      command: "node --test --test-reporter=junit --test-reporter-destination={junit} {files}",
    },
    env: ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", ".npmrc", ".nvmrc"],
    scratch: ["node_modules/", "coverage/"],
  },
};

export function presetConfig(preset: Preset, repo: string): Record<string, unknown> {
  return {
    repo,
    ref: "HEAD",
    setup: null,
    tests: { ...preset.tests, timeoutSec: 600 },
    mine: { env: preset.env, maxSourceFiles: 10, maxSourceLines: 400 },
    validate: { beforeRuns: 2, afterRuns: 3 },
    agentTimeoutSec: 1800,
    scratch: preset.scratch,
    setups: [
      { name: "oracle", builtin: "oracle" },
      { name: "noop", builtin: "noop" },
    ],
  };
}
