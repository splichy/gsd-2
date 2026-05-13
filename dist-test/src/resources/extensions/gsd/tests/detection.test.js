import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectProjectState,
  detectV1Planning,
  detectProjectSignals,
  classifyProject,
  scanProjectFiles
} from "../detection.js";
function makeTempDir(prefix) {
  const dir = join(
    tmpdir(),
    `gsd-detection-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
function git(dir, args) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}
function makeGitRepo(prefix) {
  const dir = makeTempDir(prefix);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  return dir;
}
test("detectProjectState: empty directory returns state=none", (t) => {
  const dir = makeTempDir("empty");
  t.after(() => cleanup(dir));
  const result = detectProjectState(dir);
  assert.equal(result.state, "none");
  assert.equal(result.v1, void 0);
  assert.equal(result.v2, void 0);
});
test("classifyProject: no git repo is invalid", (t) => {
  const dir = makeTempDir("classify-invalid");
  t.after(() => cleanup(dir));
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "invalid-repo");
});
test("classifyProject: empty git repo is greenfield", (t) => {
  const dir = makeGitRepo("classify-greenfield");
  t.after(() => cleanup(dir));
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "greenfield");
});
test("classifyProject: nested empty git repo does not inherit ancestor markers", (t) => {
  const parent = makeGitRepo("classify-parent-marker");
  t.after(() => cleanup(parent));
  writeFileSync(join(parent, "package.json"), JSON.stringify({ name: "parent" }), "utf-8");
  git(parent, ["add", "package.json"]);
  git(parent, ["commit", "-m", "add parent marker"]);
  const child = join(parent, "nested");
  mkdirSync(child, { recursive: true });
  git(child, ["init"]);
  git(child, ["config", "user.email", "test@example.com"]);
  git(child, ["config", "user.name", "Test User"]);
  const classification = classifyProject(child);
  assert.equal(classification.kind, "greenfield");
});
test("classifyProject: tracked static HTML is existing untyped content", (t) => {
  const dir = makeGitRepo("classify-index");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "index.html"), "<main></main>\n", "utf-8");
  git(dir, ["add", "index.html"]);
  git(dir, ["commit", "-m", "add static page"]);
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "untyped-existing");
  assert.deepEqual(classification.contentFiles, ["index.html"]);
});
test("classifyProject: README-only repo is existing untyped content", (t) => {
  const dir = makeGitRepo("classify-readme");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "README.md"), "# docs\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "add docs"]);
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "untyped-existing");
});
test("classifyProject: src-only content is untyped existing, not typed marker", (t) => {
  const dir = makeGitRepo("classify-src-only");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.txt"), "content\n", "utf-8");
  git(dir, ["add", "src/index.txt"]);
  git(dir, ["commit", "-m", "add source content"]);
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "untyped-existing");
  assert.deepEqual(classification.contentFiles, ["src/index.txt"]);
});
test("classifyProject: nested untracked files count as project content", (t) => {
  const dir = makeGitRepo("classify-untracked-nested");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "index.html"), "<main></main>\n", "utf-8");
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "untyped-existing");
  assert.deepEqual(classification.untrackedFiles, ["docs/index.html"]);
});
test("classifyProject: known markers produce typed existing project", (t) => {
  const dir = makeGitRepo("classify-typed");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "typed" }), "utf-8");
  git(dir, ["add", "package.json"]);
  git(dir, ["commit", "-m", "add package"]);
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "typed-existing");
  assert.ok(classification.markers.includes("package.json"));
});
test("classifyProject: ignored build/cache-only files do not count as content", (t) => {
  const dir = makeGitRepo("classify-ignored");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, ".gitignore"), "dist/\n.cache/\n", "utf-8");
  git(dir, ["add", ".gitignore"]);
  git(dir, ["commit", "-m", "ignore generated files"]);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "bundle.js"), "generated\n", "utf-8");
  mkdirSync(join(dir, ".cache"), { recursive: true });
  writeFileSync(join(dir, ".cache", "x"), "cache\n", "utf-8");
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "greenfield");
});
test("classifyProject: generated framework/cache dirs do not count as content", (t) => {
  const dir = makeGitRepo("classify-generated-dirs");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".next", "server"), { recursive: true });
  writeFileSync(join(dir, ".next", "server", "page.js"), "generated\n", "utf-8");
  mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
  writeFileSync(join(dir, ".venv", "lib", "site.py"), "generated\n", "utf-8");
  const classification = classifyProject(dir);
  assert.equal(classification.kind, "greenfield");
});
test("detectProjectState: directory with .gsd/milestones/M001 returns v2-gsd", (t) => {
  const dir = makeTempDir("v2-gsd");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  const result = detectProjectState(dir);
  assert.equal(result.state, "v2-gsd");
  assert.ok(result.v2);
  assert.equal(result.v2.milestoneCount, 1);
});
test("detectProjectState: directory with empty .gsd/milestones returns v2-gsd-empty", (t) => {
  const dir = makeTempDir("v2-empty");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  const result = detectProjectState(dir);
  assert.equal(result.state, "v2-gsd-empty");
  assert.ok(result.v2);
  assert.equal(result.v2.milestoneCount, 0);
});
test("detectProjectState: directory with .planning/ returns v1-planning", (t) => {
  const dir = makeTempDir("v1-planning");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".planning", "phases", "01-setup"), { recursive: true });
  writeFileSync(join(dir, ".planning", "ROADMAP.md"), "# Roadmap\n", "utf-8");
  const result = detectProjectState(dir);
  assert.equal(result.state, "v1-planning");
  assert.ok(result.v1);
  assert.equal(result.v1.hasRoadmap, true);
  assert.equal(result.v1.hasPhasesDir, true);
  assert.equal(result.v1.phaseCount, 1);
});
test("detectProjectState: v2 takes priority over v1 when both exist", (t) => {
  const dir = makeTempDir("both");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(dir, ".planning"), { recursive: true });
  const result = detectProjectState(dir);
  assert.equal(result.state, "v2-gsd");
});
test("detectProjectState: detects preferences in .gsd/", (t) => {
  const dir = makeTempDir("prefs");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".gsd", "milestones"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\nversion: 1\n---\n", "utf-8");
  const result = detectProjectState(dir);
  assert.ok(result.v2);
  assert.equal(result.v2.hasPreferences, true);
});
test("detectV1Planning: returns null for missing .planning/", (t) => {
  const dir = makeTempDir("no-v1");
  t.after(() => cleanup(dir));
  assert.equal(detectV1Planning(dir), null);
});
test("detectV1Planning: returns null when .planning is a file", (t) => {
  const dir = makeTempDir("v1-file");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, ".planning"), "not a directory", "utf-8");
  assert.equal(detectV1Planning(dir), null);
});
test("detectV1Planning: detects phases directory with multiple phases", (t) => {
  const dir = makeTempDir("v1-phases");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".planning", "phases", "01-setup"), { recursive: true });
  mkdirSync(join(dir, ".planning", "phases", "02-core"), { recursive: true });
  mkdirSync(join(dir, ".planning", "phases", "03-deploy"), { recursive: true });
  const result = detectV1Planning(dir);
  assert.ok(result);
  assert.equal(result.phaseCount, 3);
  assert.equal(result.hasPhasesDir, true);
});
test("detectV1Planning: detects ROADMAP.md", (t) => {
  const dir = makeTempDir("v1-roadmap");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".planning"), { recursive: true });
  writeFileSync(join(dir, ".planning", "ROADMAP.md"), "# Roadmap", "utf-8");
  const result = detectV1Planning(dir);
  assert.ok(result);
  assert.equal(result.hasRoadmap, true);
  assert.equal(result.hasPhasesDir, false);
  assert.equal(result.phaseCount, 0);
});
test("detectProjectSignals: empty directory", (t) => {
  const dir = makeTempDir("signals-empty");
  t.after(() => cleanup(dir));
  const signals = detectProjectSignals(dir);
  assert.deepEqual(signals.detectedFiles, []);
  assert.equal(signals.isGitRepo, false);
  assert.equal(signals.isMonorepo, false);
  assert.equal(signals.primaryLanguage, void 0);
  assert.equal(signals.hasCI, false);
  assert.equal(signals.hasTests, false);
  assert.deepEqual(signals.verificationCommands, []);
});
test("detectProjectSignals: Node.js project", (t) => {
  const dir = makeTempDir("signals-node");
  t.after(() => cleanup(dir));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-project",
      scripts: {
        test: "jest",
        build: "tsc",
        lint: "eslint ."
      }
    }),
    "utf-8"
  );
  writeFileSync(join(dir, "package-lock.json"), "{}", "utf-8");
  mkdirSync(join(dir, ".git"), { recursive: true });
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("package.json"));
  assert.equal(signals.primaryLanguage, "javascript/typescript");
  assert.equal(signals.isGitRepo, true);
  assert.equal(signals.packageManager, "npm");
  assert.ok(signals.verificationCommands.includes("npm test"));
  assert.ok(signals.verificationCommands.some((c) => c.includes("build")));
  assert.ok(signals.verificationCommands.some((c) => c.includes("lint")));
});
test("detectProjectSignals: Rust project", (t) => {
  const dir = makeTempDir("signals-rust");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "test"\n', "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("Cargo.toml"));
  assert.equal(signals.primaryLanguage, "rust");
  assert.ok(signals.verificationCommands.includes("cargo test"));
  assert.ok(signals.verificationCommands.includes("cargo clippy"));
});
test("detectProjectSignals: Go project", (t) => {
  const dir = makeTempDir("signals-go");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "go.mod"), "module example.com/test\n", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("go.mod"));
  assert.equal(signals.primaryLanguage, "go");
  assert.ok(signals.verificationCommands.includes("go test ./..."));
});
test("detectProjectSignals: Python project", (t) => {
  const dir = makeTempDir("signals-python");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "pyproject.toml"), "[tool.poetry]\n", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("pyproject.toml"));
  assert.equal(signals.primaryLanguage, "python");
  assert.ok(signals.verificationCommands.includes("pytest"));
});
test("detectProjectSignals: monorepo detection via workspaces", (t) => {
  const dir = makeTempDir("signals-monorepo");
  t.after(() => cleanup(dir));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mono", workspaces: ["packages/*"] }),
    "utf-8"
  );
  const signals = detectProjectSignals(dir);
  assert.equal(signals.isMonorepo, true);
});
test("detectProjectSignals: monorepo detection via turbo.json", (t) => {
  const dir = makeTempDir("signals-turbo");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }), "utf-8");
  writeFileSync(join(dir, "turbo.json"), "{}", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.equal(signals.isMonorepo, true);
});
test("detectProjectSignals: CI detection", (t) => {
  const dir = makeTempDir("signals-ci");
  t.after(() => cleanup(dir));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  const signals = detectProjectSignals(dir);
  assert.equal(signals.hasCI, true);
});
test("detectProjectSignals: test detection via jest config", (t) => {
  const dir = makeTempDir("signals-tests");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "jest.config.ts"), "export default {}", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.equal(signals.hasTests, true);
});
test("detectProjectSignals: package manager detection", (t) => {
  const dir1 = makeTempDir("pm-pnpm");
  const dir2 = makeTempDir("pm-yarn");
  const dir3 = makeTempDir("pm-bun");
  t.after(() => {
    cleanup(dir1);
    cleanup(dir2);
    cleanup(dir3);
  });
  writeFileSync(join(dir1, "pnpm-lock.yaml"), "", "utf-8");
  writeFileSync(join(dir1, "package.json"), "{}", "utf-8");
  assert.equal(detectProjectSignals(dir1).packageManager, "pnpm");
  writeFileSync(join(dir2, "yarn.lock"), "", "utf-8");
  writeFileSync(join(dir2, "package.json"), "{}", "utf-8");
  assert.equal(detectProjectSignals(dir2).packageManager, "yarn");
  writeFileSync(join(dir3, "bun.lockb"), "", "utf-8");
  writeFileSync(join(dir3, "package.json"), "{}", "utf-8");
  assert.equal(detectProjectSignals(dir3).packageManager, "bun");
});
test("detectProjectSignals: skips default npm test script", (t) => {
  const dir = makeTempDir("signals-default-test");
  t.after(() => cleanup(dir));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test",
      scripts: { test: 'echo "Error: no test specified" && exit 1' }
    }),
    "utf-8"
  );
  const signals = detectProjectSignals(dir);
  assert.equal(
    signals.verificationCommands.some((c) => c.includes("test")),
    false
  );
});
test("detectProjectSignals: pnpm uses pnpm commands", (t) => {
  const dir = makeTempDir("signals-pnpm-cmds");
  t.after(() => cleanup(dir));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test",
      scripts: { test: "vitest", build: "tsc" }
    }),
    "utf-8"
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.verificationCommands.includes("pnpm test"));
  assert.ok(signals.verificationCommands.includes("pnpm run build"));
});
test("detectProjectSignals: Ruby project with rspec", (t) => {
  const dir = makeTempDir("signals-ruby");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "Gemfile"), 'source "https://rubygems.org"\n', "utf-8");
  mkdirSync(join(dir, "spec"), { recursive: true });
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("Gemfile"));
  assert.equal(signals.primaryLanguage, "ruby");
  assert.ok(signals.verificationCommands.includes("bundle exec rspec"));
});
test("detectProjectSignals: Makefile with test target", (t) => {
  const dir = makeTempDir("signals-make");
  t.after(() => cleanup(dir));
  writeFileSync(join(dir, "Makefile"), "test:\n	go test ./...\n\nbuild:\n	go build\n", "utf-8");
  const signals = detectProjectSignals(dir);
  assert.ok(signals.detectedFiles.includes("Makefile"));
  assert.ok(signals.verificationCommands.includes("make test"));
});
test("detectProjectSignals: SQLite file detection via extensions", () => {
  const dir = makeTempDir("signals-sqlite");
  try {
    writeFileSync(join(dir, "app.sqlite3"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sqlite"), "should add synthetic *.sqlite marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: SQL file detection", () => {
  const dir = makeTempDir("signals-sql");
  try {
    writeFileSync(join(dir, "migrations.sql"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sql"), "should add synthetic *.sql marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested SQL file detection", () => {
  const dir = makeTempDir("signals-sql-nested");
  try {
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    writeFileSync(join(dir, "db", "migrations", "001_init.sql"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sql"), "should detect nested SQL files");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: .db file triggers SQLite detection", () => {
  const dir = makeTempDir("signals-db");
  try {
    writeFileSync(join(dir, "data.db"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sqlite"), "should add synthetic *.sqlite marker for .db files");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: no SQLite markers without matching files", () => {
  const dir = makeTempDir("signals-no-sqlite");
  try {
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("*.sqlite"), "should not have *.sqlite marker");
    assert.ok(!signals.detectedFiles.includes("*.sql"), "should not have *.sql marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: .NET project via .csproj extension", () => {
  const dir = makeTempDir("signals-dotnet");
  try {
    writeFileSync(join(dir, "MyApp.csproj"), "<Project></Project>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.csproj"), "should add synthetic *.csproj marker");
    assert.equal(signals.primaryLanguage, "csharp");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested .csproj detection", () => {
  const dir = makeTempDir("signals-dotnet-nested");
  try {
    mkdirSync(join(dir, "src", "App"), { recursive: true });
    writeFileSync(join(dir, "src", "App", "App.csproj"), "<Project></Project>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.csproj"), "should detect nested .csproj files");
    assert.equal(signals.primaryLanguage, "csharp");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: .NET project via .sln extension", () => {
  const dir = makeTempDir("signals-sln");
  try {
    writeFileSync(join(dir, "MyApp.sln"), "", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.sln"), "should add synthetic *.sln marker for .sln files");
    assert.equal(signals.primaryLanguage, "dotnet");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: F# project via .fsproj extension", () => {
  const dir = makeTempDir("signals-fsharp");
  try {
    writeFileSync(join(dir, "MyApp.fsproj"), "<Project></Project>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.fsproj"), "should add synthetic *.fsproj marker");
    assert.equal(signals.primaryLanguage, "fsharp");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Angular project via angular.json", () => {
  const dir = makeTempDir("signals-angular");
  try {
    writeFileSync(join(dir, "angular.json"), "{}", "utf-8");
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("angular.json"));
    assert.equal(signals.primaryLanguage, "javascript/typescript");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Next.js project via next.config.ts", () => {
  const dir = makeTempDir("signals-nextjs");
  try {
    writeFileSync(join(dir, "next.config.ts"), "export default {}", "utf-8");
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("next.config.ts"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested Next.js config via packages/web/next.config.ts", () => {
  const dir = makeTempDir("signals-nextjs-nested");
  try {
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    writeFileSync(join(dir, "packages", "web", "next.config.ts"), "export default {}", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("next.config.ts"), "should detect nested Next.js config");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Flutter project via pubspec.yaml", () => {
  const dir = makeTempDir("signals-flutter");
  try {
    writeFileSync(join(dir, "pubspec.yaml"), "name: my_app", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("pubspec.yaml"));
    assert.equal(signals.primaryLanguage, "dart/flutter");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Django project via manage.py", () => {
  const dir = makeTempDir("signals-django");
  try {
    writeFileSync(join(dir, "manage.py"), "#!/usr/bin/env python", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("manage.py"));
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested Django manage.py", () => {
  const dir = makeTempDir("signals-django-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(join(dir, "services", "api", "manage.py"), "#!/usr/bin/env python", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("manage.py"), "should detect nested manage.py");
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Docker project via Dockerfile", () => {
  const dir = makeTempDir("signals-docker");
  try {
    writeFileSync(join(dir, "Dockerfile"), "FROM node:18", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("Dockerfile"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Terraform project via main.tf", () => {
  const dir = makeTempDir("signals-terraform");
  try {
    writeFileSync(join(dir, "main.tf"), 'provider "aws" {}', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("main.tf"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Vue.js via .vue files in src/", () => {
  const dir = makeTempDir("signals-vue");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"vue-app"}', "utf-8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "App.vue"), "<template></template>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.vue"), "should add *.vue synthetic marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Vue.js via nested .vue file in src/components/", () => {
  const dir = makeTempDir("signals-vue-nested");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"vue-app"}', "utf-8");
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    writeFileSync(join(dir, "src", "components", "Card.vue"), "<template></template>", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("*.vue"), "should detect nested .vue files");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Vue CLI via vue.config.js", () => {
  const dir = makeTempDir("signals-vue-cli");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"vue-cli-app"}', "utf-8");
    writeFileSync(join(dir, "vue.config.js"), "module.exports = {};", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("vue.config.js"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: requirements.txt sets Python language", () => {
  const dir = makeTempDir("signals-requirements");
  try {
    writeFileSync(join(dir, "requirements.txt"), "flask==3.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("requirements.txt"));
    assert.equal(signals.primaryLanguage, "python");
    assert.ok(signals.verificationCommands.includes("pytest"), "should suggest pytest for requirements.txt projects");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Android project via app/build.gradle", () => {
  const dir = makeTempDir("signals-android");
  try {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle"), "apply plugin: 'com.android.application'", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("app/build.gradle"));
    assert.equal(signals.primaryLanguage, "java/kotlin");
    assert.ok(!signals.detectedFiles.includes("build.gradle"), "should not collapse Android app/build.gradle into generic build.gradle");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested app/build.gradle normalizes to Android marker", () => {
  const dir = makeTempDir("signals-android-nested");
  try {
    mkdirSync(join(dir, "apps", "mobile", "app"), { recursive: true });
    writeFileSync(join(dir, "apps", "mobile", "app", "build.gradle"), "apply plugin: 'com.android.application'", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("app/build.gradle"), "should detect nested Android app/build.gradle");
    assert.ok(!signals.detectedFiles.includes("build.gradle"), "should not emit generic build.gradle marker for nested Android modules");
    assert.equal(signals.primaryLanguage, "java/kotlin");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Unity project via ProjectSettings/ProjectVersion.txt", () => {
  const dir = makeTempDir("signals-unity");
  try {
    mkdirSync(join(dir, "ProjectSettings"), { recursive: true });
    writeFileSync(join(dir, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("ProjectSettings/ProjectVersion.txt"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Godot project via project.godot", () => {
  const dir = makeTempDir("signals-godot");
  try {
    writeFileSync(join(dir, "project.godot"), "[application]", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("project.godot"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Airflow via airflow.cfg", () => {
  const dir = makeTempDir("signals-airflow");
  try {
    writeFileSync(join(dir, "airflow.cfg"), "[core]\ndags_folder = ./dags", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("airflow.cfg"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Kubernetes via Chart.yaml (Helm)", () => {
  const dir = makeTempDir("signals-k8s");
  try {
    writeFileSync(join(dir, "Chart.yaml"), "apiVersion: v2\nname: my-chart", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("Chart.yaml"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Blockchain via hardhat.config.ts", () => {
  const dir = makeTempDir("signals-blockchain");
  try {
    writeFileSync(join(dir, "hardhat.config.ts"), 'import "@nomiclabs/hardhat-ethers"', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("hardhat.config.ts"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: CI/CD via .github/workflows", () => {
  const dir = makeTempDir("signals-cicd");
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes(".github/workflows"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Tailwind via tailwind.config.ts", () => {
  const dir = makeTempDir("signals-tailwind");
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"tw-app"}', "utf-8");
    writeFileSync(join(dir, "tailwind.config.ts"), "export default {};", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("tailwind.config.ts"));
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected via requirements.txt dependency", () => {
  const dir = makeTempDir("signals-fastapi-req");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi==0.115.0\nuvicorn[standard]\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should add dep:fastapi marker");
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected via pyproject.toml dependency", () => {
  const dir = makeTempDir("signals-fastapi-pyproject");
  try {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi>=0.100"]\n', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should add dep:fastapi marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected with PEP 508 ~= operator", () => {
  const dir = makeTempDir("signals-fastapi-compatible-release");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi~=0.115\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "~= should count as a FastAPI dependency");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: pyproject metadata mention does not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-metadata");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "example"\nkeywords = ["fastapi"]\ndependencies = ["flask>=3.0"]\n',
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "metadata-only mentions should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: pyproject dependency table extras do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-table-extra");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[tool.poetry.dependencies]\npython = "^3.12"\nmy-sdk = { version = "^1.0", extras = ["fastapi"] }\n',
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "dependency table extras should not imply FastAPI framework usage");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Poetry group FastAPI dependency does not imply app framework usage", () => {
  const dir = makeTempDir("signals-fastapi-poetry-group");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3.0"\n\n[tool.poetry.group.dev.dependencies]\nfastapi = "^0.115"\n',
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "Poetry dev-group dependencies should not imply FastAPI app usage");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: pyproject optional-dependency group name does not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-extra-name");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["flask>=3.0"]\n\n[project.optional-dependencies]\nfastapi = ["orjson>=3"]\n',
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "optional-dependency extra names should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: pyproject multiline optional dependency emits dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-pyproject-optional-multiline");
  try {
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["flask>=3.0"]\n\n[project.optional-dependencies]\napi = [\n  "fastapi>=0.115",\n  "uvicorn>=0.30",\n]\n',
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "multiline optional dependency arrays should trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI direct reference with @ emits dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-direct-reference");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi @ https://example.com/fastapi.whl\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "direct-reference dependencies should trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected via requirements.in", () => {
  const dir = makeTempDir("signals-fastapi-requirements-in");
  try {
    writeFileSync(join(dir, "requirements.in"), "fastapi>=0.115\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "requirements.in should trigger FastAPI detection");
    assert.ok(signals.detectedFiles.includes("requirements.txt"), "requirements.in should normalize to requirements.txt marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected via nested requirements/base.in", () => {
  const dir = makeTempDir("signals-fastapi-requirements-dir-in");
  try {
    mkdirSync(join(dir, "requirements"), { recursive: true });
    writeFileSync(join(dir, "requirements", "base.in"), "fastapi>=0.115\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "requirements/base.in should trigger FastAPI detection");
    assert.ok(signals.detectedFiles.includes("requirements.txt"), "requirements/base.in should normalize to requirements.txt marker");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI comments do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-comment");
  try {
    writeFileSync(join(dir, "requirements.txt"), "# maybe evaluate fastapi later\nflask==3.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "comments should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI inline comments do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-inline-comment");
  try {
    writeFileSync(join(dir, "requirements.txt"), "flask==3.0  # maybe fastapi later\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "inline comments should not trigger FastAPI detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: fastapi-* packages do not trigger dep:fastapi without fastapi itself", () => {
  const dir = makeTempDir("signals-fastapi-suffix-only");
  try {
    writeFileSync(join(dir, "requirements.txt"), "fastapi-users==13.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "fastapi-* packages alone should not imply FastAPI framework usage");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: dependency extras mentioning fastapi do not trigger dep:fastapi", () => {
  const dir = makeTempDir("signals-fastapi-extra-only");
  try {
    writeFileSync(join(dir, "requirements.txt"), "my-sdk[fastapi]>=1.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "dependency extras should not imply FastAPI framework usage");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Django project does NOT get dep:fastapi marker", () => {
  const dir = makeTempDir("signals-django-no-fastapi");
  try {
    writeFileSync(join(dir, "requirements.txt"), "django==5.0\ncelery\n", "utf-8");
    writeFileSync(join(dir, "manage.py"), "#!/usr/bin/env python", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:fastapi"), "should NOT add dep:fastapi for Django");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected case-insensitively (PyPI canonical name)", () => {
  const dir = makeTempDir("signals-fastapi-case");
  try {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["FastAPI>=0.100"]\n', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should detect FastAPI (mixed case)");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: FastAPI detected via nested service requirements.txt", () => {
  const dir = makeTempDir("signals-fastapi-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(join(dir, "services", "api", "requirements.txt"), "fastapi==0.115.0\n", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:fastapi"), "should detect FastAPI in nested service requirements.txt");
    assert.ok(signals.detectedFiles.includes("requirements.txt"), "should normalize nested requirements.txt marker");
    assert.equal(signals.primaryLanguage, "python");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested Prisma schema normalizes to prisma/schema.prisma", () => {
  const dir = makeTempDir("signals-prisma-nested");
  try {
    mkdirSync(join(dir, "services", "api", "prisma"), { recursive: true });
    writeFileSync(join(dir, "services", "api", "prisma", "schema.prisma"), 'datasource db { provider = "sqlite" }', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("prisma/schema.prisma"), "should detect nested Prisma schema");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested Spring Boot Gradle service emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-gradle-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(
      join(dir, "services", "api", "build.gradle"),
      "plugins { id 'org.springframework.boot' version '3.2.0' }",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "should detect nested Spring Boot Gradle service");
    assert.equal(signals.primaryLanguage, "java/kotlin");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: legacy apply plugin syntax emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-apply-plugin");
  try {
    writeFileSync(join(dir, "build.gradle"), "apply plugin: 'org.springframework.boot'", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "apply plugin syntax should trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: nested Spring Boot Kotlin DSL service still uses neutral java/kotlin language hint", () => {
  const dir = makeTempDir("signals-spring-gradle-kts-nested");
  try {
    mkdirSync(join(dir, "services", "api"), { recursive: true });
    writeFileSync(
      join(dir, "services", "api", "build.gradle.kts"),
      'plugins { id("org.springframework.boot") version "3.2.0" }',
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"));
    assert.equal(signals.primaryLanguage, "java/kotlin");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Android Gradle project does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-android-no-spring");
  try {
    writeFileSync(join(dir, "build.gradle"), "plugins { id 'com.android.application' }", "utf-8");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle"), "plugins { id 'com.android.application' }", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "Android Gradle files should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Android inline comments do not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-android-inline-comment");
  try {
    writeFileSync(join(dir, "build.gradle"), "plugins { id 'com.android.application' } // spring-boot maybe later", "utf-8");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "build.gradle"), "plugins { id 'com.android.application' }", "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "inline comments should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: build metadata mentioning spring-boot does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-metadata-only");
  try {
    writeFileSync(join(dir, "build.gradle"), 'def notes = "spring-boot migration planned later"', "utf-8");
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "arbitrary metadata text should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Maven artifactId alone does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-maven-artifact-only");
  try {
    writeFileSync(
      join(dir, "pom.xml"),
      "<project><modelVersion>4.0.0</modelVersion><groupId>com.example</groupId><artifactId>spring-boot-tools</artifactId></project>",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "artifactId alone should not imply Spring Boot");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Spring Boot version-catalog alias emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\nbackend-web = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "should detect Spring Boot via version-catalog alias");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: commented Spring Boot alias in libs.versions.toml does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-comment");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\n# backend-web = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "commented aliases should not trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: unused Spring Boot alias in libs.versions.toml does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-unused");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\nother-plugin = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "unused Spring Boot aliases should not trigger detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: spring-like alias name without Spring Boot id does not emit dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-false-alias");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(libs.plugins.spring.boot.conventions) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[plugins]\nspring-boot-conventions = { id = 'com.example.conventions', version = '1.0.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(!signals.detectedFiles.includes("dep:spring-boot"), "spring-looking alias names should not imply Spring Boot without matching id");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Spring Boot version-catalog library alias emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-library");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "dependencies { implementation(libs.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[libraries]\nbackend-web = { module = 'org.springframework.boot:spring-boot-starter-web', version = '3.2.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "Spring Boot library aliases should trigger detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Spring Boot version-catalog bundle alias emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-bundle");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "dependencies { implementation(libs.bundles.backend.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "libs.versions.toml"),
      "[libraries]\nspring-boot-starter-web = { module = 'org.springframework.boot:spring-boot-starter-web', version = '3.2.0' }\n\n[bundles]\nbackend-web = ['spring-boot-starter-web']\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "Spring Boot bundle aliases should trigger detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Spring Boot custom version-catalog accessor emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-custom-accessor");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(backend.plugins.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "backend.versions.toml"),
      "[plugins]\nweb = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "custom version-catalog accessors should trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("detectProjectSignals: Spring Boot settings-defined catalog accessor emits dep:spring-boot", () => {
  const dir = makeTempDir("signals-spring-version-catalog-settings-accessor");
  try {
    mkdirSync(join(dir, "gradle"), { recursive: true });
    writeFileSync(
      join(dir, "settings.gradle.kts"),
      'dependencyResolutionManagement { versionCatalogs { create("backendLibs") { from(files("./gradle/backend.versions.toml")) } } }',
      "utf-8"
    );
    writeFileSync(join(dir, "build.gradle.kts"), "plugins { alias(backendLibs.plugins.web) }", "utf-8");
    writeFileSync(
      join(dir, "gradle", "backend.versions.toml"),
      "[plugins]\nweb = { id = 'org.springframework.boot', version = '3.2.0' }\n",
      "utf-8"
    );
    const signals = detectProjectSignals(dir);
    assert.ok(signals.detectedFiles.includes("dep:spring-boot"), "settings-defined catalog accessors should trigger Spring Boot detection");
  } finally {
    cleanup(dir);
  }
});
test("scanProjectFiles: excludes .claude, .gsd, .planning, .plans, .cursor, .vscode directories", () => {
  const dir = makeTempDir("scan-ignore-dotdirs");
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "// main\n", "utf-8");
    writeFileSync(join(dir, "README.md"), "# Project\n", "utf-8");
    const excludedDirs = [".claude", ".gsd", ".planning", ".plans", ".cursor", ".vscode"];
    for (const d of excludedDirs) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, "config.json"), "{}\n", "utf-8");
    }
    mkdirSync(join(dir, ".claude", "memory"), { recursive: true });
    writeFileSync(join(dir, ".claude", "memory", "user.md"), "# Memory\n", "utf-8");
    const files = scanProjectFiles(dir);
    assert.ok(files.includes("src/main.ts"), "should include src/main.ts");
    assert.ok(files.includes("README.md"), "should include README.md");
    for (const d of excludedDirs) {
      const hasExcluded = files.some((f) => f.startsWith(`${d}/`));
      assert.ok(!hasExcluded, `should exclude ${d}/ directory but found: ${files.filter((f) => f.startsWith(`${d}/`)).join(", ")}`);
    }
  } finally {
    cleanup(dir);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZXRlY3Rpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBVbml0IHRlc3RzIGZvciBHU0QgRGV0ZWN0aW9uIFx1MjAxNCBwcm9qZWN0IHN0YXRlIGFuZCBlY29zeXN0ZW0gZGV0ZWN0aW9uLlxuICpcbiAqIEV4ZXJjaXNlcyB0aGUgcHVyZSBkZXRlY3Rpb24gZnVuY3Rpb25zIGluIGRldGVjdGlvbi50czpcbiAqIC0gZGV0ZWN0UHJvamVjdFN0YXRlKCkgd2l0aCB2YXJpb3VzIGZvbGRlciBsYXlvdXRzXG4gKiAtIGRldGVjdFYxUGxhbm5pbmcoKSB3aXRoIHJlYWwgYW5kIGZha2UgLnBsYW5uaW5nLyBkaXJzXG4gKiAtIGRldGVjdFByb2plY3RTaWduYWxzKCkgd2l0aCBkaWZmZXJlbnQgcHJvamVjdCB0eXBlc1xuICogLSBpc0ZpcnN0RXZlckxhdW5jaCgpIC8gaGFzR2xvYmFsU2V0dXAoKVxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQge1xuICBkZXRlY3RQcm9qZWN0U3RhdGUsXG4gIGRldGVjdFYxUGxhbm5pbmcsXG4gIGRldGVjdFByb2plY3RTaWduYWxzLFxuICBjbGFzc2lmeVByb2plY3QsXG4gIHNjYW5Qcm9qZWN0RmlsZXMsXG59IGZyb20gXCIuLi9kZXRlY3Rpb24udHNcIjtcblxuZnVuY3Rpb24gbWFrZVRlbXBEaXIocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBqb2luKFxuICAgIHRtcGRpcigpLFxuICAgIGBnc2QtZGV0ZWN0aW9uLXRlc3QtJHtwcmVmaXh9LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLFxuICApO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChkaXI6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxufVxuXG5mdW5jdGlvbiBnaXQoZGlyOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogdm9pZCB7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBhcmdzLCB7IGN3ZDogZGlyLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZUdpdFJlcG8ocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihwcmVmaXgpO1xuICBnaXQoZGlyLCBbXCJpbml0XCJdKTtcbiAgZ2l0KGRpciwgW1wiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAZXhhbXBsZS5jb21cIl0pO1xuICBnaXQoZGlyLCBbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0IFVzZXJcIl0pO1xuICByZXR1cm4gZGlyO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZGV0ZWN0UHJvamVjdFN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFN0YXRlOiBlbXB0eSBkaXJlY3RvcnkgcmV0dXJucyBzdGF0ZT1ub25lXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwiZW1wdHlcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBjb25zdCByZXN1bHQgPSBkZXRlY3RQcm9qZWN0U3RhdGUoZGlyKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0ZSwgXCJub25lXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnYxLCB1bmRlZmluZWQpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnYyLCB1bmRlZmluZWQpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeVByb2plY3Q6IG5vIGdpdCByZXBvIGlzIGludmFsaWRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJjbGFzc2lmeS1pbnZhbGlkXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeVByb2plY3QoZGlyKTtcbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIFwiaW52YWxpZC1yZXBvXCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeVByb2plY3Q6IGVtcHR5IGdpdCByZXBvIGlzIGdyZWVuZmllbGRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZUdpdFJlcG8oXCJjbGFzc2lmeS1ncmVlbmZpZWxkXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeVByb2plY3QoZGlyKTtcbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIFwiZ3JlZW5maWVsZFwiKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlQcm9qZWN0OiBuZXN0ZWQgZW1wdHkgZ2l0IHJlcG8gZG9lcyBub3QgaW5oZXJpdCBhbmNlc3RvciBtYXJrZXJzXCIsICh0KSA9PiB7XG4gIGNvbnN0IHBhcmVudCA9IG1ha2VHaXRSZXBvKFwiY2xhc3NpZnktcGFyZW50LW1hcmtlclwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKHBhcmVudCkpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihwYXJlbnQsIFwicGFja2FnZS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7IG5hbWU6IFwicGFyZW50XCIgfSksIFwidXRmLThcIik7XG4gIGdpdChwYXJlbnQsIFtcImFkZFwiLCBcInBhY2thZ2UuanNvblwiXSk7XG4gIGdpdChwYXJlbnQsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiYWRkIHBhcmVudCBtYXJrZXJcIl0pO1xuICBjb25zdCBjaGlsZCA9IGpvaW4ocGFyZW50LCBcIm5lc3RlZFwiKTtcbiAgbWtkaXJTeW5jKGNoaWxkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgZ2l0KGNoaWxkLCBbXCJpbml0XCJdKTtcbiAgZ2l0KGNoaWxkLCBbXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwidGVzdEBleGFtcGxlLmNvbVwiXSk7XG4gIGdpdChjaGlsZCwgW1wiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwiVGVzdCBVc2VyXCJdKTtcblxuICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5UHJvamVjdChjaGlsZCk7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmaWNhdGlvbi5raW5kLCBcImdyZWVuZmllbGRcIik7XG59KTtcblxudGVzdChcImNsYXNzaWZ5UHJvamVjdDogdHJhY2tlZCBzdGF0aWMgSFRNTCBpcyBleGlzdGluZyB1bnR5cGVkIGNvbnRlbnRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZUdpdFJlcG8oXCJjbGFzc2lmeS1pbmRleFwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiaW5kZXguaHRtbFwiKSwgXCI8bWFpbj48L21haW4+XFxuXCIsIFwidXRmLThcIik7XG4gIGdpdChkaXIsIFtcImFkZFwiLCBcImluZGV4Lmh0bWxcIl0pO1xuICBnaXQoZGlyLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImFkZCBzdGF0aWMgcGFnZVwiXSk7XG5cbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeVByb2plY3QoZGlyKTtcbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIFwidW50eXBlZC1leGlzdGluZ1wiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjbGFzc2lmaWNhdGlvbi5jb250ZW50RmlsZXMsIFtcImluZGV4Lmh0bWxcIl0pO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeVByb2plY3Q6IFJFQURNRS1vbmx5IHJlcG8gaXMgZXhpc3RpbmcgdW50eXBlZCBjb250ZW50XCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VHaXRSZXBvKFwiY2xhc3NpZnktcmVhZG1lXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJSRUFETUUubWRcIiksIFwiIyBkb2NzXFxuXCIsIFwidXRmLThcIik7XG4gIGdpdChkaXIsIFtcImFkZFwiLCBcIlJFQURNRS5tZFwiXSk7XG4gIGdpdChkaXIsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiYWRkIGRvY3NcIl0pO1xuXG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlQcm9qZWN0KGRpcik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmaWNhdGlvbi5raW5kLCBcInVudHlwZWQtZXhpc3RpbmdcIik7XG59KTtcblxudGVzdChcImNsYXNzaWZ5UHJvamVjdDogc3JjLW9ubHkgY29udGVudCBpcyB1bnR5cGVkIGV4aXN0aW5nLCBub3QgdHlwZWQgbWFya2VyXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VHaXRSZXBvKFwiY2xhc3NpZnktc3JjLW9ubHlcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBta2RpclN5bmMoam9pbihkaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzcmNcIiwgXCJpbmRleC50eHRcIiksIFwiY29udGVudFxcblwiLCBcInV0Zi04XCIpO1xuICBnaXQoZGlyLCBbXCJhZGRcIiwgXCJzcmMvaW5kZXgudHh0XCJdKTtcbiAgZ2l0KGRpciwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJhZGQgc291cmNlIGNvbnRlbnRcIl0pO1xuXG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlQcm9qZWN0KGRpcik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmaWNhdGlvbi5raW5kLCBcInVudHlwZWQtZXhpc3RpbmdcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoY2xhc3NpZmljYXRpb24uY29udGVudEZpbGVzLCBbXCJzcmMvaW5kZXgudHh0XCJdKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlQcm9qZWN0OiBuZXN0ZWQgdW50cmFja2VkIGZpbGVzIGNvdW50IGFzIHByb2plY3QgY29udGVudFwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlR2l0UmVwbyhcImNsYXNzaWZ5LXVudHJhY2tlZC1uZXN0ZWRcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBta2RpclN5bmMoam9pbihkaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZG9jc1wiLCBcImluZGV4Lmh0bWxcIiksIFwiPG1haW4+PC9tYWluPlxcblwiLCBcInV0Zi04XCIpO1xuXG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlQcm9qZWN0KGRpcik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmaWNhdGlvbi5raW5kLCBcInVudHlwZWQtZXhpc3RpbmdcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoY2xhc3NpZmljYXRpb24udW50cmFja2VkRmlsZXMsIFtcImRvY3MvaW5kZXguaHRtbFwiXSk7XG59KTtcblxudGVzdChcImNsYXNzaWZ5UHJvamVjdDoga25vd24gbWFya2VycyBwcm9kdWNlIHR5cGVkIGV4aXN0aW5nIHByb2plY3RcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZUdpdFJlcG8oXCJjbGFzc2lmeS10eXBlZFwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicGFja2FnZS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7IG5hbWU6IFwidHlwZWRcIiB9KSwgXCJ1dGYtOFwiKTtcbiAgZ2l0KGRpciwgW1wiYWRkXCIsIFwicGFja2FnZS5qc29uXCJdKTtcbiAgZ2l0KGRpciwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJhZGQgcGFja2FnZVwiXSk7XG5cbiAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeVByb2plY3QoZGlyKTtcbiAgYXNzZXJ0LmVxdWFsKGNsYXNzaWZpY2F0aW9uLmtpbmQsIFwidHlwZWQtZXhpc3RpbmdcIik7XG4gIGFzc2VydC5vayhjbGFzc2lmaWNhdGlvbi5tYXJrZXJzLmluY2x1ZGVzKFwicGFja2FnZS5qc29uXCIpKTtcbn0pO1xuXG50ZXN0KFwiY2xhc3NpZnlQcm9qZWN0OiBpZ25vcmVkIGJ1aWxkL2NhY2hlLW9ubHkgZmlsZXMgZG8gbm90IGNvdW50IGFzIGNvbnRlbnRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZUdpdFJlcG8oXCJjbGFzc2lmeS1pZ25vcmVkXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCIuZ2l0aWdub3JlXCIpLCBcImRpc3QvXFxuLmNhY2hlL1xcblwiLCBcInV0Zi04XCIpO1xuICBnaXQoZGlyLCBbXCJhZGRcIiwgXCIuZ2l0aWdub3JlXCJdKTtcbiAgZ2l0KGRpciwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJpZ25vcmUgZ2VuZXJhdGVkIGZpbGVzXCJdKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImRpc3RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImRpc3RcIiwgXCJidW5kbGUuanNcIiksIFwiZ2VuZXJhdGVkXFxuXCIsIFwidXRmLThcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuY2FjaGVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIi5jYWNoZVwiLCBcInhcIiksIFwiY2FjaGVcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICBjb25zdCBjbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5UHJvamVjdChkaXIpO1xuICBhc3NlcnQuZXF1YWwoY2xhc3NpZmljYXRpb24ua2luZCwgXCJncmVlbmZpZWxkXCIpO1xufSk7XG5cbnRlc3QoXCJjbGFzc2lmeVByb2plY3Q6IGdlbmVyYXRlZCBmcmFtZXdvcmsvY2FjaGUgZGlycyBkbyBub3QgY291bnQgYXMgY29udGVudFwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlR2l0UmVwbyhcImNsYXNzaWZ5LWdlbmVyYXRlZC1kaXJzXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5uZXh0XCIsIFwic2VydmVyXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCIubmV4dFwiLCBcInNlcnZlclwiLCBcInBhZ2UuanNcIiksIFwiZ2VuZXJhdGVkXFxuXCIsIFwidXRmLThcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIudmVudlwiLCBcImxpYlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLnZlbnZcIiwgXCJsaWJcIiwgXCJzaXRlLnB5XCIpLCBcImdlbmVyYXRlZFxcblwiLCBcInV0Zi04XCIpO1xuXG4gIGNvbnN0IGNsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlQcm9qZWN0KGRpcik7XG4gIGFzc2VydC5lcXVhbChjbGFzc2lmaWNhdGlvbi5raW5kLCBcImdyZWVuZmllbGRcIik7XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTdGF0ZTogZGlyZWN0b3J5IHdpdGggLmdzZC9taWxlc3RvbmVzL00wMDEgcmV0dXJucyB2Mi1nc2RcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJ2Mi1nc2RcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0UHJvamVjdFN0YXRlKGRpcik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdGUsIFwidjItZ3NkXCIpO1xuICBhc3NlcnQub2socmVzdWx0LnYyKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52MiEubWlsZXN0b25lQ291bnQsIDEpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U3RhdGU6IGRpcmVjdG9yeSB3aXRoIGVtcHR5IC5nc2QvbWlsZXN0b25lcyByZXR1cm5zIHYyLWdzZC1lbXB0eVwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInYyLWVtcHR5XCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0UHJvamVjdFN0YXRlKGRpcik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdGUsIFwidjItZ3NkLWVtcHR5XCIpO1xuICBhc3NlcnQub2socmVzdWx0LnYyKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52MiEubWlsZXN0b25lQ291bnQsIDApO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U3RhdGU6IGRpcmVjdG9yeSB3aXRoIC5wbGFubmluZy8gcmV0dXJucyB2MS1wbGFubmluZ1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInYxLXBsYW5uaW5nXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5wbGFubmluZ1wiLCBcInBoYXNlc1wiLCBcIjAxLXNldHVwXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCIucGxhbm5pbmdcIiwgXCJST0FETUFQLm1kXCIpLCBcIiMgUm9hZG1hcFxcblwiLCBcInV0Zi04XCIpO1xuICBjb25zdCByZXN1bHQgPSBkZXRlY3RQcm9qZWN0U3RhdGUoZGlyKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0ZSwgXCJ2MS1wbGFubmluZ1wiKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC52MSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQudjEhLmhhc1JvYWRtYXAsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnYxIS5oYXNQaGFzZXNEaXIsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnYxIS5waGFzZUNvdW50LCAxKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFN0YXRlOiB2MiB0YWtlcyBwcmlvcml0eSBvdmVyIHYxIHdoZW4gYm90aCBleGlzdFwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcImJvdGhcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5wbGFubmluZ1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHJlc3VsdCA9IGRldGVjdFByb2plY3RTdGF0ZShkaXIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXRlLCBcInYyLWdzZFwiKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFN0YXRlOiBkZXRlY3RzIHByZWZlcmVuY2VzIGluIC5nc2QvXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwicHJlZnNcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCItLS1cXG52ZXJzaW9uOiAxXFxuLS0tXFxuXCIsIFwidXRmLThcIik7XG4gIGNvbnN0IHJlc3VsdCA9IGRldGVjdFByb2plY3RTdGF0ZShkaXIpO1xuICBhc3NlcnQub2socmVzdWx0LnYyKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52MiEuaGFzUHJlZmVyZW5jZXMsIHRydWUpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBkZXRlY3RWMVBsYW5uaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiZGV0ZWN0VjFQbGFubmluZzogcmV0dXJucyBudWxsIGZvciBtaXNzaW5nIC5wbGFubmluZy9cIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJuby12MVwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIGFzc2VydC5lcXVhbChkZXRlY3RWMVBsYW5uaW5nKGRpciksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RWMVBsYW5uaW5nOiByZXR1cm5zIG51bGwgd2hlbiAucGxhbm5pbmcgaXMgYSBmaWxlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwidjEtZmlsZVwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLnBsYW5uaW5nXCIpLCBcIm5vdCBhIGRpcmVjdG9yeVwiLCBcInV0Zi04XCIpO1xuICBhc3NlcnQuZXF1YWwoZGV0ZWN0VjFQbGFubmluZyhkaXIpLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0VjFQbGFubmluZzogZGV0ZWN0cyBwaGFzZXMgZGlyZWN0b3J5IHdpdGggbXVsdGlwbGUgcGhhc2VzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwidjEtcGhhc2VzXCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5wbGFubmluZ1wiLCBcInBoYXNlc1wiLCBcIjAxLXNldHVwXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5wbGFubmluZ1wiLCBcInBoYXNlc1wiLCBcIjAyLWNvcmVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLnBsYW5uaW5nXCIsIFwicGhhc2VzXCIsIFwiMDMtZGVwbG95XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0VjFQbGFubmluZyhkaXIpO1xuICBhc3NlcnQub2socmVzdWx0KTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCEucGhhc2VDb3VudCwgMyk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQhLmhhc1BoYXNlc0RpciwgdHJ1ZSk7XG59KTtcblxudGVzdChcImRldGVjdFYxUGxhbm5pbmc6IGRldGVjdHMgUk9BRE1BUC5tZFwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInYxLXJvYWRtYXBcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBta2RpclN5bmMoam9pbihkaXIsIFwiLnBsYW5uaW5nXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCIucGxhbm5pbmdcIiwgXCJST0FETUFQLm1kXCIpLCBcIiMgUm9hZG1hcFwiLCBcInV0Zi04XCIpO1xuICBjb25zdCByZXN1bHQgPSBkZXRlY3RWMVBsYW5uaW5nKGRpcik7XG4gIGFzc2VydC5vayhyZXN1bHQpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0IS5oYXNSb2FkbWFwLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCEuaGFzUGhhc2VzRGlyLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQhLnBoYXNlQ291bnQsIDApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBkZXRlY3RQcm9qZWN0U2lnbmFscyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBlbXB0eSBkaXJlY3RvcnlcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWVtcHR5XCIpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoZGlyKSk7XG5cbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gIGFzc2VydC5kZWVwRXF1YWwoc2lnbmFscy5kZXRlY3RlZEZpbGVzLCBbXSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLmlzR2l0UmVwbywgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoc2lnbmFscy5pc01vbm9yZXBvLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgdW5kZWZpbmVkKTtcbiAgYXNzZXJ0LmVxdWFsKHNpZ25hbHMuaGFzQ0ksIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHNpZ25hbHMuaGFzVGVzdHMsIGZhbHNlKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChzaWduYWxzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLCBbXSk7XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBOb2RlLmpzIHByb2plY3RcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLW5vZGVcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBuYW1lOiBcInRlc3QtcHJvamVjdFwiLFxuICAgICAgc2NyaXB0czoge1xuICAgICAgICB0ZXN0OiBcImplc3RcIixcbiAgICAgICAgYnVpbGQ6IFwidHNjXCIsXG4gICAgICAgIGxpbnQ6IFwiZXNsaW50IC5cIixcbiAgICAgIH0sXG4gICAgfSksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInBhY2thZ2UtbG9jay5qc29uXCIpLCBcInt9XCIsIFwidXRmLThcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ2l0XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcInBhY2thZ2UuanNvblwiKSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJqYXZhc2NyaXB0L3R5cGVzY3JpcHRcIik7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLmlzR2l0UmVwbywgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLnBhY2thZ2VNYW5hZ2VyLCBcIm5wbVwiKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuaW5jbHVkZXMoXCJucG0gdGVzdFwiKSk7XG4gIGFzc2VydC5vayhzaWduYWxzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLnNvbWUoYyA9PiBjLmluY2x1ZGVzKFwiYnVpbGRcIikpKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuc29tZShjID0+IGMuaW5jbHVkZXMoXCJsaW50XCIpKSk7XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBSdXN0IHByb2plY3RcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXJ1c3RcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIkNhcmdvLnRvbWxcIiksICdbcGFja2FnZV1cXG5uYW1lID0gXCJ0ZXN0XCJcXG4nLCBcInV0Zi04XCIpO1xuICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIkNhcmdvLnRvbWxcIikpO1xuICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwicnVzdFwiKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuaW5jbHVkZXMoXCJjYXJnbyB0ZXN0XCIpKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuaW5jbHVkZXMoXCJjYXJnbyBjbGlwcHlcIikpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogR28gcHJvamVjdFwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZ29cIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImdvLm1vZFwiKSwgXCJtb2R1bGUgZXhhbXBsZS5jb20vdGVzdFxcblwiLCBcInV0Zi04XCIpO1xuICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImdvLm1vZFwiKSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJnb1wiKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuaW5jbHVkZXMoXCJnbyB0ZXN0IC4vLi4uXCIpKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFB5dGhvbiBwcm9qZWN0XCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1weXRob25cIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInB5cHJvamVjdC50b21sXCIpLCBcIlt0b29sLnBvZXRyeV1cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJweXByb2plY3QudG9tbFwiKSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJweXRob25cIik7XG4gIGFzc2VydC5vayhzaWduYWxzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLmluY2x1ZGVzKFwicHl0ZXN0XCIpKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IG1vbm9yZXBvIGRldGVjdGlvbiB2aWEgd29ya3NwYWNlc1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtbW9ub3JlcG9cIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7IG5hbWU6IFwibW9ub1wiLCB3b3Jrc3BhY2VzOiBbXCJwYWNrYWdlcy8qXCJdIH0pLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLmlzTW9ub3JlcG8sIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogbW9ub3JlcG8gZGV0ZWN0aW9uIHZpYSB0dXJiby5qc29uXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy10dXJib1wiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicGFja2FnZS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh7IG5hbWU6IFwidGVzdFwiIH0pLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInR1cmJvLmpzb25cIiksIFwie31cIiwgXCJ1dGYtOFwiKTtcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLmlzTW9ub3JlcG8sIHRydWUpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogQ0kgZGV0ZWN0aW9uXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1jaVwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ2l0aHViXCIsIFwid29ya2Zsb3dzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLmhhc0NJLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IHRlc3QgZGV0ZWN0aW9uIHZpYSBqZXN0IGNvbmZpZ1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtdGVzdHNcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImplc3QuY29uZmlnLnRzXCIpLCBcImV4cG9ydCBkZWZhdWx0IHt9XCIsIFwidXRmLThcIik7XG4gIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICBhc3NlcnQuZXF1YWwoc2lnbmFscy5oYXNUZXN0cywgdHJ1ZSk7XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBwYWNrYWdlIG1hbmFnZXIgZGV0ZWN0aW9uXCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpcjEgPSBtYWtlVGVtcERpcihcInBtLXBucG1cIik7XG4gIGNvbnN0IGRpcjIgPSBtYWtlVGVtcERpcihcInBtLXlhcm5cIik7XG4gIGNvbnN0IGRpcjMgPSBtYWtlVGVtcERpcihcInBtLWJ1blwiKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xlYW51cChkaXIxKTtcbiAgICBjbGVhbnVwKGRpcjIpO1xuICAgIGNsZWFudXAoZGlyMyk7XG4gIH0pO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIxLCBcInBucG0tbG9jay55YW1sXCIpLCBcIlwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyMSwgXCJwYWNrYWdlLmpzb25cIiksIFwie31cIiwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdFByb2plY3RTaWduYWxzKGRpcjEpLnBhY2thZ2VNYW5hZ2VyLCBcInBucG1cIik7XG5cbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpcjIsIFwieWFybi5sb2NrXCIpLCBcIlwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyMiwgXCJwYWNrYWdlLmpzb25cIiksIFwie31cIiwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdFByb2plY3RTaWduYWxzKGRpcjIpLnBhY2thZ2VNYW5hZ2VyLCBcInlhcm5cIik7XG5cbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpcjMsIFwiYnVuLmxvY2tiXCIpLCBcIlwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyMywgXCJwYWNrYWdlLmpzb25cIiksIFwie31cIiwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdFByb2plY3RTaWduYWxzKGRpcjMpLnBhY2thZ2VNYW5hZ2VyLCBcImJ1blwiKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IHNraXBzIGRlZmF1bHQgbnBtIHRlc3Qgc2NyaXB0XCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1kZWZhdWx0LXRlc3RcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBuYW1lOiBcInRlc3RcIixcbiAgICAgIHNjcmlwdHM6IHsgdGVzdDogJ2VjaG8gXCJFcnJvcjogbm8gdGVzdCBzcGVjaWZpZWRcIiAmJiBleGl0IDEnIH0sXG4gICAgfSksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgLy8gU2hvdWxkIE5PVCBpbmNsdWRlIHRoZSBkZWZhdWx0IG5wbSB0ZXN0IHNjcmlwdFxuICBhc3NlcnQuZXF1YWwoXG4gICAgc2lnbmFscy52ZXJpZmljYXRpb25Db21tYW5kcy5zb21lKGMgPT4gYy5pbmNsdWRlcyhcInRlc3RcIikpLFxuICAgIGZhbHNlLFxuICApO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogcG5wbSB1c2VzIHBucG0gY29tbWFuZHNcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXBucG0tY21kc1wiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihkaXIsIFwicGFja2FnZS5qc29uXCIpLFxuICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG5hbWU6IFwidGVzdFwiLFxuICAgICAgc2NyaXB0czogeyB0ZXN0OiBcInZpdGVzdFwiLCBidWlsZDogXCJ0c2NcIiB9LFxuICAgIH0pLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJwbnBtLWxvY2sueWFtbFwiKSwgXCJcIiwgXCJ1dGYtOFwiKTtcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gIGFzc2VydC5vayhzaWduYWxzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLmluY2x1ZGVzKFwicG5wbSB0ZXN0XCIpKTtcbiAgYXNzZXJ0Lm9rKHNpZ25hbHMudmVyaWZpY2F0aW9uQ29tbWFuZHMuaW5jbHVkZXMoXCJwbnBtIHJ1biBidWlsZFwiKSk7XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBSdWJ5IHByb2plY3Qgd2l0aCByc3BlY1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtcnVieVwiKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiR2VtZmlsZVwiKSwgJ3NvdXJjZSBcImh0dHBzOi8vcnVieWdlbXMub3JnXCJcXG4nLCBcInV0Zi04XCIpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwic3BlY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiR2VtZmlsZVwiKSk7XG4gIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJydWJ5XCIpO1xuICBhc3NlcnQub2soc2lnbmFscy52ZXJpZmljYXRpb25Db21tYW5kcy5pbmNsdWRlcyhcImJ1bmRsZSBleGVjIHJzcGVjXCIpKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IE1ha2VmaWxlIHdpdGggdGVzdCB0YXJnZXRcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLW1ha2VcIik7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIk1ha2VmaWxlXCIpLCBcInRlc3Q6XFxuXFx0Z28gdGVzdCAuLy4uLlxcblxcbmJ1aWxkOlxcblxcdGdvIGJ1aWxkXFxuXCIsIFwidXRmLThcIik7XG4gIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiTWFrZWZpbGVcIikpO1xuICBhc3NlcnQub2soc2lnbmFscy52ZXJpZmljYXRpb25Db21tYW5kcy5pbmNsdWRlcyhcIm1ha2UgdGVzdFwiKSk7XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBTUUxpdGUgZmlsZSBkZXRlY3Rpb24gdmlhIGV4dGVuc2lvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3FsaXRlXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYXBwLnNxbGl0ZTNcIiksIFwiXCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIiouc3FsaXRlXCIpLCBcInNob3VsZCBhZGQgc3ludGhldGljICouc3FsaXRlIG1hcmtlclwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFNRTCBmaWxlIGRldGVjdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1zcWxcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJtaWdyYXRpb25zLnNxbFwiKSwgXCJcIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiKi5zcWxcIiksIFwic2hvdWxkIGFkZCBzeW50aGV0aWMgKi5zcWwgbWFya2VyXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogbmVzdGVkIFNRTCBmaWxlIGRldGVjdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1zcWwtbmVzdGVkXCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJkYlwiLCBcIm1pZ3JhdGlvbnNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZGJcIiwgXCJtaWdyYXRpb25zXCIsIFwiMDAxX2luaXQuc3FsXCIpLCBcIlwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCIqLnNxbFwiKSwgXCJzaG91bGQgZGV0ZWN0IG5lc3RlZCBTUUwgZmlsZXNcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiAuZGIgZmlsZSB0cmlnZ2VycyBTUUxpdGUgZGV0ZWN0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWRiXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiZGF0YS5kYlwiKSwgXCJcIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiKi5zcWxpdGVcIiksIFwic2hvdWxkIGFkZCBzeW50aGV0aWMgKi5zcWxpdGUgbWFya2VyIGZvciAuZGIgZmlsZXNcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBubyBTUUxpdGUgbWFya2VycyB3aXRob3V0IG1hdGNoaW5nIGZpbGVzXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLW5vLXNxbGl0ZVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSwgXCJ7fVwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiKi5zcWxpdGVcIiksIFwic2hvdWxkIG5vdCBoYXZlICouc3FsaXRlIG1hcmtlclwiKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIiouc3FsXCIpLCBcInNob3VsZCBub3QgaGF2ZSAqLnNxbCBtYXJrZXJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiAuTkVUIHByb2plY3QgdmlhIC5jc3Byb2ogZXh0ZW5zaW9uXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWRvdG5ldFwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIk15QXBwLmNzcHJvalwiKSwgXCI8UHJvamVjdD48L1Byb2plY3Q+XCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIiouY3Nwcm9qXCIpLCBcInNob3VsZCBhZGQgc3ludGhldGljICouY3Nwcm9qIG1hcmtlclwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwiY3NoYXJwXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogbmVzdGVkIC5jc3Byb2ogZGV0ZWN0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWRvdG5ldC1uZXN0ZWRcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcIkFwcFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzcmNcIiwgXCJBcHBcIiwgXCJBcHAuY3Nwcm9qXCIpLCBcIjxQcm9qZWN0PjwvUHJvamVjdD5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiKi5jc3Byb2pcIiksIFwic2hvdWxkIGRldGVjdCBuZXN0ZWQgLmNzcHJvaiBmaWxlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwiY3NoYXJwXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogLk5FVCBwcm9qZWN0IHZpYSAuc2xuIGV4dGVuc2lvblwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1zbG5cIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJNeUFwcC5zbG5cIiksIFwiXCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIiouc2xuXCIpLCBcInNob3VsZCBhZGQgc3ludGhldGljICouc2xuIG1hcmtlciBmb3IgLnNsbiBmaWxlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwiZG90bmV0XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogRiMgcHJvamVjdCB2aWEgLmZzcHJvaiBleHRlbnNpb25cIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZnNoYXJwXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiTXlBcHAuZnNwcm9qXCIpLCBcIjxQcm9qZWN0PjwvUHJvamVjdD5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiKi5mc3Byb2pcIiksIFwic2hvdWxkIGFkZCBzeW50aGV0aWMgKi5mc3Byb2ogbWFya2VyXCIpO1xuICAgIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJmc2hhcnBcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBBbmd1bGFyIHByb2plY3QgdmlhIGFuZ3VsYXIuanNvblwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1hbmd1bGFyXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYW5ndWxhci5qc29uXCIpLCBcInt9XCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJwYWNrYWdlLmpzb25cIiksIFwie31cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiYW5ndWxhci5qc29uXCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwiamF2YXNjcmlwdC90eXBlc2NyaXB0XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogTmV4dC5qcyBwcm9qZWN0IHZpYSBuZXh0LmNvbmZpZy50c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1uZXh0anNcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJuZXh0LmNvbmZpZy50c1wiKSwgXCJleHBvcnQgZGVmYXVsdCB7fVwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicGFja2FnZS5qc29uXCIpLCBcInt9XCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIm5leHQuY29uZmlnLnRzXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IG5lc3RlZCBOZXh0LmpzIGNvbmZpZyB2aWEgcGFja2FnZXMvd2ViL25leHQuY29uZmlnLnRzXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLW5leHRqcy1uZXN0ZWRcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInBhY2thZ2VzXCIsIFwid2ViXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInBhY2thZ2VzXCIsIFwid2ViXCIsIFwibmV4dC5jb25maWcudHNcIiksIFwiZXhwb3J0IGRlZmF1bHQge31cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwibmV4dC5jb25maWcudHNcIiksIFwic2hvdWxkIGRldGVjdCBuZXN0ZWQgTmV4dC5qcyBjb25maWdcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBGbHV0dGVyIHByb2plY3QgdmlhIHB1YnNwZWMueWFtbFwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1mbHV0dGVyXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicHVic3BlYy55YW1sXCIpLCBcIm5hbWU6IG15X2FwcFwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJwdWJzcGVjLnlhbWxcIikpO1xuICAgIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJkYXJ0L2ZsdXR0ZXJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBEamFuZ28gcHJvamVjdCB2aWEgbWFuYWdlLnB5XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWRqYW5nb1wiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIm1hbmFnZS5weVwiKSwgXCIjIS91c3IvYmluL2VudiBweXRob25cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwibWFuYWdlLnB5XCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwicHl0aG9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogbmVzdGVkIERqYW5nbyBtYW5hZ2UucHlcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZGphbmdvLW5lc3RlZFwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic2VydmljZXNcIiwgXCJhcGlcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic2VydmljZXNcIiwgXCJhcGlcIiwgXCJtYW5hZ2UucHlcIiksIFwiIyEvdXNyL2Jpbi9lbnYgcHl0aG9uXCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIm1hbmFnZS5weVwiKSwgXCJzaG91bGQgZGV0ZWN0IG5lc3RlZCBtYW5hZ2UucHlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNpZ25hbHMucHJpbWFyeUxhbmd1YWdlLCBcInB5dGhvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IERvY2tlciBwcm9qZWN0IHZpYSBEb2NrZXJmaWxlXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWRvY2tlclwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIkRvY2tlcmZpbGVcIiksIFwiRlJPTSBub2RlOjE4XCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIkRvY2tlcmZpbGVcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogVGVycmFmb3JtIHByb2plY3QgdmlhIG1haW4udGZcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtdGVycmFmb3JtXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwibWFpbi50ZlwiKSwgJ3Byb3ZpZGVyIFwiYXdzXCIge30nLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJtYWluLnRmXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgUUE0L1FBNSBcdTIwMTQgbmV3IGRldGVjdGlvbiB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBWdWUuanMgdmlhIC52dWUgZmlsZXMgaW4gc3JjL1wiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy12dWVcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJwYWNrYWdlLmpzb25cIiksICd7XCJuYW1lXCI6XCJ2dWUtYXBwXCJ9JywgXCJ1dGYtOFwiKTtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcIkFwcC52dWVcIiksIFwiPHRlbXBsYXRlPjwvdGVtcGxhdGU+XCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIioudnVlXCIpLCBcInNob3VsZCBhZGQgKi52dWUgc3ludGhldGljIG1hcmtlclwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFZ1ZS5qcyB2aWEgbmVzdGVkIC52dWUgZmlsZSBpbiBzcmMvY29tcG9uZW50cy9cIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtdnVlLW5lc3RlZFwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSwgJ3tcIm5hbWVcIjpcInZ1ZS1hcHBcIn0nLCBcInV0Zi04XCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJzcmNcIiwgXCJjb21wb25lbnRzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNyY1wiLCBcImNvbXBvbmVudHNcIiwgXCJDYXJkLnZ1ZVwiKSwgXCI8dGVtcGxhdGU+PC90ZW1wbGF0ZT5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiKi52dWVcIiksIFwic2hvdWxkIGRldGVjdCBuZXN0ZWQgLnZ1ZSBmaWxlc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFZ1ZSBDTEkgdmlhIHZ1ZS5jb25maWcuanNcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtdnVlLWNsaVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSwgJ3tcIm5hbWVcIjpcInZ1ZS1jbGktYXBwXCJ9JywgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInZ1ZS5jb25maWcuanNcIiksIFwibW9kdWxlLmV4cG9ydHMgPSB7fTtcIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwidnVlLmNvbmZpZy5qc1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiByZXF1aXJlbWVudHMudHh0IHNldHMgUHl0aG9uIGxhbmd1YWdlXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXJlcXVpcmVtZW50c1wiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInJlcXVpcmVtZW50cy50eHRcIiksIFwiZmxhc2s9PTMuMFxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJyZXF1aXJlbWVudHMudHh0XCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwicHl0aG9uXCIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLnZlcmlmaWNhdGlvbkNvbW1hbmRzLmluY2x1ZGVzKFwicHl0ZXN0XCIpLCBcInNob3VsZCBzdWdnZXN0IHB5dGVzdCBmb3IgcmVxdWlyZW1lbnRzLnR4dCBwcm9qZWN0c1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEFuZHJvaWQgcHJvamVjdCB2aWEgYXBwL2J1aWxkLmdyYWRsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1hbmRyb2lkXCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJhcHBcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYXBwXCIsIFwiYnVpbGQuZ3JhZGxlXCIpLCBcImFwcGx5IHBsdWdpbjogJ2NvbS5hbmRyb2lkLmFwcGxpY2F0aW9uJ1wiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJhcHAvYnVpbGQuZ3JhZGxlXCIpKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwiamF2YS9rb3RsaW5cIik7XG4gICAgYXNzZXJ0Lm9rKCFzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJidWlsZC5ncmFkbGVcIiksIFwic2hvdWxkIG5vdCBjb2xsYXBzZSBBbmRyb2lkIGFwcC9idWlsZC5ncmFkbGUgaW50byBnZW5lcmljIGJ1aWxkLmdyYWRsZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IG5lc3RlZCBhcHAvYnVpbGQuZ3JhZGxlIG5vcm1hbGl6ZXMgdG8gQW5kcm9pZCBtYXJrZXJcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtYW5kcm9pZC1uZXN0ZWRcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImFwcHNcIiwgXCJtb2JpbGVcIiwgXCJhcHBcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYXBwc1wiLCBcIm1vYmlsZVwiLCBcImFwcFwiLCBcImJ1aWxkLmdyYWRsZVwiKSwgXCJhcHBseSBwbHVnaW46ICdjb20uYW5kcm9pZC5hcHBsaWNhdGlvbidcIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiYXBwL2J1aWxkLmdyYWRsZVwiKSwgXCJzaG91bGQgZGV0ZWN0IG5lc3RlZCBBbmRyb2lkIGFwcC9idWlsZC5ncmFkbGVcIik7XG4gICAgYXNzZXJ0Lm9rKCFzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJidWlsZC5ncmFkbGVcIiksIFwic2hvdWxkIG5vdCBlbWl0IGdlbmVyaWMgYnVpbGQuZ3JhZGxlIG1hcmtlciBmb3IgbmVzdGVkIEFuZHJvaWQgbW9kdWxlc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFscy5wcmltYXJ5TGFuZ3VhZ2UsIFwiamF2YS9rb3RsaW5cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBVbml0eSBwcm9qZWN0IHZpYSBQcm9qZWN0U2V0dGluZ3MvUHJvamVjdFZlcnNpb24udHh0XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXVuaXR5XCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJQcm9qZWN0U2V0dGluZ3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiUHJvamVjdFNldHRpbmdzXCIsIFwiUHJvamVjdFZlcnNpb24udHh0XCIpLCBcIm1fRWRpdG9yVmVyc2lvbjogMjAyMi4zXCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIlByb2plY3RTZXR0aW5ncy9Qcm9qZWN0VmVyc2lvbi50eHRcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogR29kb3QgcHJvamVjdCB2aWEgcHJvamVjdC5nb2RvdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1nb2RvdFwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInByb2plY3QuZ29kb3RcIiksIFwiW2FwcGxpY2F0aW9uXVwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJwcm9qZWN0LmdvZG90XCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEFpcmZsb3cgdmlhIGFpcmZsb3cuY2ZnXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWFpcmZsb3dcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJhaXJmbG93LmNmZ1wiKSwgXCJbY29yZV1cXG5kYWdzX2ZvbGRlciA9IC4vZGFnc1wiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJhaXJmbG93LmNmZ1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBLdWJlcm5ldGVzIHZpYSBDaGFydC55YW1sIChIZWxtKVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1rOHNcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJDaGFydC55YW1sXCIpLCBcImFwaVZlcnNpb246IHYyXFxubmFtZTogbXktY2hhcnRcIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiQ2hhcnQueWFtbFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBCbG9ja2NoYWluIHZpYSBoYXJkaGF0LmNvbmZpZy50c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1ibG9ja2NoYWluXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiaGFyZGhhdC5jb25maWcudHNcIiksICdpbXBvcnQgXCJAbm9taWNsYWJzL2hhcmRoYXQtZXRoZXJzXCInLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJoYXJkaGF0LmNvbmZpZy50c1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBDSS9DRCB2aWEgLmdpdGh1Yi93b3JrZmxvd3NcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtY2ljZFwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdpdGh1YlwiLCBcIndvcmtmbG93c1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIi5naXRodWIvd29ya2Zsb3dzXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFRhaWx3aW5kIHZpYSB0YWlsd2luZC5jb25maWcudHNcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtdGFpbHdpbmRcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJwYWNrYWdlLmpzb25cIiksICd7XCJuYW1lXCI6XCJ0dy1hcHBcIn0nLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwidGFpbHdpbmQuY29uZmlnLnRzXCIpLCBcImV4cG9ydCBkZWZhdWx0IHt9O1wiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJ0YWlsd2luZC5jb25maWcudHNcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogRmFzdEFQSSBkZXRlY3RlZCB2aWEgcmVxdWlyZW1lbnRzLnR4dCBkZXBlbmRlbmN5XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWZhc3RhcGktcmVxXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicmVxdWlyZW1lbnRzLnR4dFwiKSwgXCJmYXN0YXBpPT0wLjExNS4wXFxudXZpY29ybltzdGFuZGFyZF1cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwic2hvdWxkIGFkZCBkZXA6ZmFzdGFwaSBtYXJrZXJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNpZ25hbHMucHJpbWFyeUxhbmd1YWdlLCBcInB5dGhvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEZhc3RBUEkgZGV0ZWN0ZWQgdmlhIHB5cHJvamVjdC50b21sIGRlcGVuZGVuY3lcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZmFzdGFwaS1weXByb2plY3RcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJweXByb2plY3QudG9tbFwiKSwgJ1twcm9qZWN0XVxcbmRlcGVuZGVuY2llcyA9IFtcImZhc3RhcGk+PTAuMTAwXCJdXFxuJywgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwic2hvdWxkIGFkZCBkZXA6ZmFzdGFwaSBtYXJrZXJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBGYXN0QVBJIGRldGVjdGVkIHdpdGggUEVQIDUwOCB+PSBvcGVyYXRvclwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1mYXN0YXBpLWNvbXBhdGlibGUtcmVsZWFzZVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInJlcXVpcmVtZW50cy50eHRcIiksIFwiZmFzdGFwaX49MC4xMTVcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwifj0gc2hvdWxkIGNvdW50IGFzIGEgRmFzdEFQSSBkZXBlbmRlbmN5XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogcHlwcm9qZWN0IG1ldGFkYXRhIG1lbnRpb24gZG9lcyBub3QgdHJpZ2dlciBkZXA6ZmFzdGFwaVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1mYXN0YXBpLXB5cHJvamVjdC1tZXRhZGF0YVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwicHlwcm9qZWN0LnRvbWxcIiksXG4gICAgICAnW3Byb2plY3RdXFxubmFtZSA9IFwiZXhhbXBsZVwiXFxua2V5d29yZHMgPSBbXCJmYXN0YXBpXCJdXFxuZGVwZW5kZW5jaWVzID0gW1wiZmxhc2s+PTMuMFwiXVxcbicsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcIm1ldGFkYXRhLW9ubHkgbWVudGlvbnMgc2hvdWxkIG5vdCB0cmlnZ2VyIEZhc3RBUEkgZGV0ZWN0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogcHlwcm9qZWN0IGRlcGVuZGVuY3kgdGFibGUgZXh0cmFzIGRvIG5vdCB0cmlnZ2VyIGRlcDpmYXN0YXBpXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWZhc3RhcGktcHlwcm9qZWN0LXRhYmxlLWV4dHJhXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJweXByb2plY3QudG9tbFwiKSxcbiAgICAgICdbdG9vbC5wb2V0cnkuZGVwZW5kZW5jaWVzXVxcbnB5dGhvbiA9IFwiXjMuMTJcIlxcbm15LXNkayA9IHsgdmVyc2lvbiA9IFwiXjEuMFwiLCBleHRyYXMgPSBbXCJmYXN0YXBpXCJdIH1cXG4nLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKCFzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6ZmFzdGFwaVwiKSwgXCJkZXBlbmRlbmN5IHRhYmxlIGV4dHJhcyBzaG91bGQgbm90IGltcGx5IEZhc3RBUEkgZnJhbWV3b3JrIHVzYWdlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogUG9ldHJ5IGdyb3VwIEZhc3RBUEkgZGVwZW5kZW5jeSBkb2VzIG5vdCBpbXBseSBhcHAgZnJhbWV3b3JrIHVzYWdlXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWZhc3RhcGktcG9ldHJ5LWdyb3VwXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJweXByb2plY3QudG9tbFwiKSxcbiAgICAgICdbdG9vbC5wb2V0cnkuZGVwZW5kZW5jaWVzXVxcbnB5dGhvbiA9IFwiXjMuMTJcIlxcbmZsYXNrID0gXCJeMy4wXCJcXG5cXG5bdG9vbC5wb2V0cnkuZ3JvdXAuZGV2LmRlcGVuZGVuY2llc11cXG5mYXN0YXBpID0gXCJeMC4xMTVcIlxcbicsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcIlBvZXRyeSBkZXYtZ3JvdXAgZGVwZW5kZW5jaWVzIHNob3VsZCBub3QgaW1wbHkgRmFzdEFQSSBhcHAgdXNhZ2VcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBweXByb2plY3Qgb3B0aW9uYWwtZGVwZW5kZW5jeSBncm91cCBuYW1lIGRvZXMgbm90IHRyaWdnZXIgZGVwOmZhc3RhcGlcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZmFzdGFwaS1weXByb2plY3QtZXh0cmEtbmFtZVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwicHlwcm9qZWN0LnRvbWxcIiksXG4gICAgICAnW3Byb2plY3RdXFxuZGVwZW5kZW5jaWVzID0gW1wiZmxhc2s+PTMuMFwiXVxcblxcbltwcm9qZWN0Lm9wdGlvbmFsLWRlcGVuZGVuY2llc11cXG5mYXN0YXBpID0gW1wib3Jqc29uPj0zXCJdXFxuJyxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwib3B0aW9uYWwtZGVwZW5kZW5jeSBleHRyYSBuYW1lcyBzaG91bGQgbm90IHRyaWdnZXIgRmFzdEFQSSBkZXRlY3Rpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBweXByb2plY3QgbXVsdGlsaW5lIG9wdGlvbmFsIGRlcGVuZGVuY3kgZW1pdHMgZGVwOmZhc3RhcGlcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZmFzdGFwaS1weXByb2plY3Qtb3B0aW9uYWwtbXVsdGlsaW5lXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJweXByb2plY3QudG9tbFwiKSxcbiAgICAgICdbcHJvamVjdF1cXG5kZXBlbmRlbmNpZXMgPSBbXCJmbGFzaz49My4wXCJdXFxuXFxuW3Byb2plY3Qub3B0aW9uYWwtZGVwZW5kZW5jaWVzXVxcbmFwaSA9IFtcXG4gIFwiZmFzdGFwaT49MC4xMTVcIixcXG4gIFwidXZpY29ybj49MC4zMFwiLFxcbl1cXG4nLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcIm11bHRpbGluZSBvcHRpb25hbCBkZXBlbmRlbmN5IGFycmF5cyBzaG91bGQgdHJpZ2dlciBGYXN0QVBJIGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEZhc3RBUEkgZGlyZWN0IHJlZmVyZW5jZSB3aXRoIEAgZW1pdHMgZGVwOmZhc3RhcGlcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZmFzdGFwaS1kaXJlY3QtcmVmZXJlbmNlXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicmVxdWlyZW1lbnRzLnR4dFwiKSwgXCJmYXN0YXBpIEAgaHR0cHM6Ly9leGFtcGxlLmNvbS9mYXN0YXBpLndobFxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6ZmFzdGFwaVwiKSwgXCJkaXJlY3QtcmVmZXJlbmNlIGRlcGVuZGVuY2llcyBzaG91bGQgdHJpZ2dlciBGYXN0QVBJIGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEZhc3RBUEkgZGV0ZWN0ZWQgdmlhIHJlcXVpcmVtZW50cy5pblwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1mYXN0YXBpLXJlcXVpcmVtZW50cy1pblwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInJlcXVpcmVtZW50cy5pblwiKSwgXCJmYXN0YXBpPj0wLjExNVxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6ZmFzdGFwaVwiKSwgXCJyZXF1aXJlbWVudHMuaW4gc2hvdWxkIHRyaWdnZXIgRmFzdEFQSSBkZXRlY3Rpb25cIik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcInJlcXVpcmVtZW50cy50eHRcIiksIFwicmVxdWlyZW1lbnRzLmluIHNob3VsZCBub3JtYWxpemUgdG8gcmVxdWlyZW1lbnRzLnR4dCBtYXJrZXJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBGYXN0QVBJIGRldGVjdGVkIHZpYSBuZXN0ZWQgcmVxdWlyZW1lbnRzL2Jhc2UuaW5cIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZmFzdGFwaS1yZXF1aXJlbWVudHMtZGlyLWluXCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJyZXF1aXJlbWVudHNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicmVxdWlyZW1lbnRzXCIsIFwiYmFzZS5pblwiKSwgXCJmYXN0YXBpPj0wLjExNVxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6ZmFzdGFwaVwiKSwgXCJyZXF1aXJlbWVudHMvYmFzZS5pbiBzaG91bGQgdHJpZ2dlciBGYXN0QVBJIGRldGVjdGlvblwiKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwicmVxdWlyZW1lbnRzLnR4dFwiKSwgXCJyZXF1aXJlbWVudHMvYmFzZS5pbiBzaG91bGQgbm9ybWFsaXplIHRvIHJlcXVpcmVtZW50cy50eHQgbWFya2VyXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogRmFzdEFQSSBjb21tZW50cyBkbyBub3QgdHJpZ2dlciBkZXA6ZmFzdGFwaVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1mYXN0YXBpLWNvbW1lbnRcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJyZXF1aXJlbWVudHMudHh0XCIpLCBcIiMgbWF5YmUgZXZhbHVhdGUgZmFzdGFwaSBsYXRlclxcbmZsYXNrPT0zLjBcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcImNvbW1lbnRzIHNob3VsZCBub3QgdHJpZ2dlciBGYXN0QVBJIGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEZhc3RBUEkgaW5saW5lIGNvbW1lbnRzIGRvIG5vdCB0cmlnZ2VyIGRlcDpmYXN0YXBpXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWZhc3RhcGktaW5saW5lLWNvbW1lbnRcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJyZXF1aXJlbWVudHMudHh0XCIpLCBcImZsYXNrPT0zLjAgICMgbWF5YmUgZmFzdGFwaSBsYXRlclxcblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwiaW5saW5lIGNvbW1lbnRzIHNob3VsZCBub3QgdHJpZ2dlciBGYXN0QVBJIGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IGZhc3RhcGktKiBwYWNrYWdlcyBkbyBub3QgdHJpZ2dlciBkZXA6ZmFzdGFwaSB3aXRob3V0IGZhc3RhcGkgaXRzZWxmXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWZhc3RhcGktc3VmZml4LW9ubHlcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJyZXF1aXJlbWVudHMudHh0XCIpLCBcImZhc3RhcGktdXNlcnM9PTEzLjBcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcImZhc3RhcGktKiBwYWNrYWdlcyBhbG9uZSBzaG91bGQgbm90IGltcGx5IEZhc3RBUEkgZnJhbWV3b3JrIHVzYWdlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogZGVwZW5kZW5jeSBleHRyYXMgbWVudGlvbmluZyBmYXN0YXBpIGRvIG5vdCB0cmlnZ2VyIGRlcDpmYXN0YXBpXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWZhc3RhcGktZXh0cmEtb25seVwiKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInJlcXVpcmVtZW50cy50eHRcIiksIFwibXktc2RrW2Zhc3RhcGldPj0xLjBcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcImRlcGVuZGVuY3kgZXh0cmFzIHNob3VsZCBub3QgaW1wbHkgRmFzdEFQSSBmcmFtZXdvcmsgdXNhZ2VcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBEamFuZ28gcHJvamVjdCBkb2VzIE5PVCBnZXQgZGVwOmZhc3RhcGkgbWFya2VyXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWRqYW5nby1uby1mYXN0YXBpXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwicmVxdWlyZW1lbnRzLnR4dFwiKSwgXCJkamFuZ289PTUuMFxcbmNlbGVyeVxcblwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwibWFuYWdlLnB5XCIpLCBcIiMhL3Vzci9iaW4vZW52IHB5dGhvblwiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwic2hvdWxkIE5PVCBhZGQgZGVwOmZhc3RhcGkgZm9yIERqYW5nb1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEZhc3RBUEkgZGV0ZWN0ZWQgY2FzZS1pbnNlbnNpdGl2ZWx5IChQeVBJIGNhbm9uaWNhbCBuYW1lKVwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1mYXN0YXBpLWNhc2VcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJweXByb2plY3QudG9tbFwiKSwgJ1twcm9qZWN0XVxcbmRlcGVuZGVuY2llcyA9IFtcIkZhc3RBUEk+PTAuMTAwXCJdXFxuJywgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOmZhc3RhcGlcIiksIFwic2hvdWxkIGRldGVjdCBGYXN0QVBJIChtaXhlZCBjYXNlKVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEZhc3RBUEkgZGV0ZWN0ZWQgdmlhIG5lc3RlZCBzZXJ2aWNlIHJlcXVpcmVtZW50cy50eHRcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtZmFzdGFwaS1uZXN0ZWRcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInNlcnZpY2VzXCIsIFwiYXBpXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNlcnZpY2VzXCIsIFwiYXBpXCIsIFwicmVxdWlyZW1lbnRzLnR4dFwiKSwgXCJmYXN0YXBpPT0wLjExNS4wXFxuXCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpmYXN0YXBpXCIpLCBcInNob3VsZCBkZXRlY3QgRmFzdEFQSSBpbiBuZXN0ZWQgc2VydmljZSByZXF1aXJlbWVudHMudHh0XCIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJyZXF1aXJlbWVudHMudHh0XCIpLCBcInNob3VsZCBub3JtYWxpemUgbmVzdGVkIHJlcXVpcmVtZW50cy50eHQgbWFya2VyXCIpO1xuICAgIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJweXRob25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBuZXN0ZWQgUHJpc21hIHNjaGVtYSBub3JtYWxpemVzIHRvIHByaXNtYS9zY2hlbWEucHJpc21hXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXByaXNtYS1uZXN0ZWRcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInNlcnZpY2VzXCIsIFwiYXBpXCIsIFwicHJpc21hXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcInNlcnZpY2VzXCIsIFwiYXBpXCIsIFwicHJpc21hXCIsIFwic2NoZW1hLnByaXNtYVwiKSwgXCJkYXRhc291cmNlIGRiIHsgcHJvdmlkZXIgPSBcXFwic3FsaXRlXFxcIiB9XCIsIFwidXRmLThcIik7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcInByaXNtYS9zY2hlbWEucHJpc21hXCIpLCBcInNob3VsZCBkZXRlY3QgbmVzdGVkIFByaXNtYSBzY2hlbWFcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBuZXN0ZWQgU3ByaW5nIEJvb3QgR3JhZGxlIHNlcnZpY2UgZW1pdHMgZGVwOnNwcmluZy1ib290XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXNwcmluZy1ncmFkbGUtbmVzdGVkXCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJzZXJ2aWNlc1wiLCBcImFwaVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZGlyLCBcInNlcnZpY2VzXCIsIFwiYXBpXCIsIFwiYnVpbGQuZ3JhZGxlXCIpLFxuICAgICAgXCJwbHVnaW5zIHsgaWQgJ29yZy5zcHJpbmdmcmFtZXdvcmsuYm9vdCcgdmVyc2lvbiAnMy4yLjAnIH1cIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6c3ByaW5nLWJvb3RcIiksIFwic2hvdWxkIGRldGVjdCBuZXN0ZWQgU3ByaW5nIEJvb3QgR3JhZGxlIHNlcnZpY2VcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNpZ25hbHMucHJpbWFyeUxhbmd1YWdlLCBcImphdmEva290bGluXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogbGVnYWN5IGFwcGx5IHBsdWdpbiBzeW50YXggZW1pdHMgZGVwOnNwcmluZy1ib290XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXNwcmluZy1hcHBseS1wbHVnaW5cIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGVcIiksIFwiYXBwbHkgcGx1Z2luOiAnb3JnLnNwcmluZ2ZyYW1ld29yay5ib290J1wiLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6c3ByaW5nLWJvb3RcIiksIFwiYXBwbHkgcGx1Z2luIHN5bnRheCBzaG91bGQgdHJpZ2dlciBTcHJpbmcgQm9vdCBkZXRlY3Rpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBuZXN0ZWQgU3ByaW5nIEJvb3QgS290bGluIERTTCBzZXJ2aWNlIHN0aWxsIHVzZXMgbmV1dHJhbCBqYXZhL2tvdGxpbiBsYW5ndWFnZSBoaW50XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXNwcmluZy1ncmFkbGUta3RzLW5lc3RlZFwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwic2VydmljZXNcIiwgXCJhcGlcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJzZXJ2aWNlc1wiLCBcImFwaVwiLCBcImJ1aWxkLmdyYWRsZS5rdHNcIiksXG4gICAgICBcInBsdWdpbnMgeyBpZChcXFwib3JnLnNwcmluZ2ZyYW1ld29yay5ib290XFxcIikgdmVyc2lvbiBcXFwiMy4yLjBcXFwiIH1cIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6c3ByaW5nLWJvb3RcIikpO1xuICAgIGFzc2VydC5lcXVhbChzaWduYWxzLnByaW1hcnlMYW5ndWFnZSwgXCJqYXZhL2tvdGxpblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IEFuZHJvaWQgR3JhZGxlIHByb2plY3QgZG9lcyBub3QgZW1pdCBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtYW5kcm9pZC1uby1zcHJpbmdcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGVcIiksIFwicGx1Z2lucyB7IGlkICdjb20uYW5kcm9pZC5hcHBsaWNhdGlvbicgfVwiLCBcInV0Zi04XCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJhcHBcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYXBwXCIsIFwiYnVpbGQuZ3JhZGxlXCIpLCBcInBsdWdpbnMgeyBpZCAnY29tLmFuZHJvaWQuYXBwbGljYXRpb24nIH1cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpzcHJpbmctYm9vdFwiKSwgXCJBbmRyb2lkIEdyYWRsZSBmaWxlcyBzaG91bGQgbm90IHRyaWdnZXIgU3ByaW5nIEJvb3QgZGV0ZWN0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogQW5kcm9pZCBpbmxpbmUgY29tbWVudHMgZG8gbm90IGVtaXQgZGVwOnNwcmluZy1ib290XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLWFuZHJvaWQtaW5saW5lLWNvbW1lbnRcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGVcIiksIFwicGx1Z2lucyB7IGlkICdjb20uYW5kcm9pZC5hcHBsaWNhdGlvbicgfSAvLyBzcHJpbmctYm9vdCBtYXliZSBsYXRlclwiLCBcInV0Zi04XCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJhcHBcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYXBwXCIsIFwiYnVpbGQuZ3JhZGxlXCIpLCBcInBsdWdpbnMgeyBpZCAnY29tLmFuZHJvaWQuYXBwbGljYXRpb24nIH1cIiwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soIXNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpzcHJpbmctYm9vdFwiKSwgXCJpbmxpbmUgY29tbWVudHMgc2hvdWxkIG5vdCB0cmlnZ2VyIFNwcmluZyBCb290IGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IGJ1aWxkIG1ldGFkYXRhIG1lbnRpb25pbmcgc3ByaW5nLWJvb3QgZG9lcyBub3QgZW1pdCBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLW1ldGFkYXRhLW9ubHlcIik7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGVcIiksICdkZWYgbm90ZXMgPSBcInNwcmluZy1ib290IG1pZ3JhdGlvbiBwbGFubmVkIGxhdGVyXCInLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOnNwcmluZy1ib290XCIpLCBcImFyYml0cmFyeSBtZXRhZGF0YSB0ZXh0IHNob3VsZCBub3QgdHJpZ2dlciBTcHJpbmcgQm9vdCBkZXRlY3Rpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBNYXZlbiBhcnRpZmFjdElkIGFsb25lIGRvZXMgbm90IGVtaXQgZGVwOnNwcmluZy1ib290XCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzaWduYWxzLXNwcmluZy1tYXZlbi1hcnRpZmFjdC1vbmx5XCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJwb20ueG1sXCIpLFxuICAgICAgJzxwcm9qZWN0Pjxtb2RlbFZlcnNpb24+NC4wLjA8L21vZGVsVmVyc2lvbj48Z3JvdXBJZD5jb20uZXhhbXBsZTwvZ3JvdXBJZD48YXJ0aWZhY3RJZD5zcHJpbmctYm9vdC10b29sczwvYXJ0aWZhY3RJZD48L3Byb2plY3Q+JyxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOnNwcmluZy1ib290XCIpLCBcImFydGlmYWN0SWQgYWxvbmUgc2hvdWxkIG5vdCBpbXBseSBTcHJpbmcgQm9vdFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFNwcmluZyBCb290IHZlcnNpb24tY2F0YWxvZyBhbGlhcyBlbWl0cyBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZ1wiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiZ3JhZGxlXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImJ1aWxkLmdyYWRsZS5rdHNcIiksIFwicGx1Z2lucyB7IGFsaWFzKGxpYnMucGx1Z2lucy5iYWNrZW5kLndlYikgfVwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJncmFkbGVcIiwgXCJsaWJzLnZlcnNpb25zLnRvbWxcIiksXG4gICAgICBcIltwbHVnaW5zXVxcbmJhY2tlbmQtd2ViID0geyBpZCA9ICdvcmcuc3ByaW5nZnJhbWV3b3JrLmJvb3QnLCB2ZXJzaW9uID0gJzMuMi4wJyB9XFxuXCIsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOnNwcmluZy1ib290XCIpLCBcInNob3VsZCBkZXRlY3QgU3ByaW5nIEJvb3QgdmlhIHZlcnNpb24tY2F0YWxvZyBhbGlhc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IGNvbW1lbnRlZCBTcHJpbmcgQm9vdCBhbGlhcyBpbiBsaWJzLnZlcnNpb25zLnRvbWwgZG9lcyBub3QgZW1pdCBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZy1jb21tZW50XCIpO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGRpciwgXCJncmFkbGVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYnVpbGQuZ3JhZGxlLmt0c1wiKSwgXCJwbHVnaW5zIHsgYWxpYXMobGlicy5wbHVnaW5zLmJhY2tlbmQud2ViKSB9XCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZGlyLCBcImdyYWRsZVwiLCBcImxpYnMudmVyc2lvbnMudG9tbFwiKSxcbiAgICAgIFwiW3BsdWdpbnNdXFxuIyBiYWNrZW5kLXdlYiA9IHsgaWQgPSAnb3JnLnNwcmluZ2ZyYW1ld29yay5ib290JywgdmVyc2lvbiA9ICczLjIuMCcgfVxcblwiLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKCFzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6c3ByaW5nLWJvb3RcIiksIFwiY29tbWVudGVkIGFsaWFzZXMgc2hvdWxkIG5vdCB0cmlnZ2VyIFNwcmluZyBCb290IGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IHVudXNlZCBTcHJpbmcgQm9vdCBhbGlhcyBpbiBsaWJzLnZlcnNpb25zLnRvbWwgZG9lcyBub3QgZW1pdCBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZy11bnVzZWRcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImdyYWRsZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGUua3RzXCIpLCBcInBsdWdpbnMgeyBhbGlhcyhsaWJzLnBsdWdpbnMuYmFja2VuZC53ZWIpIH1cIiwgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiZ3JhZGxlXCIsIFwibGlicy52ZXJzaW9ucy50b21sXCIpLFxuICAgICAgXCJbcGx1Z2luc11cXG5vdGhlci1wbHVnaW4gPSB7IGlkID0gJ29yZy5zcHJpbmdmcmFtZXdvcmsuYm9vdCcsIHZlcnNpb24gPSAnMy4yLjAnIH1cXG5cIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOnNwcmluZy1ib290XCIpLCBcInVudXNlZCBTcHJpbmcgQm9vdCBhbGlhc2VzIHNob3VsZCBub3QgdHJpZ2dlciBkZXRlY3Rpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxudGVzdChcImRldGVjdFByb2plY3RTaWduYWxzOiBzcHJpbmctbGlrZSBhbGlhcyBuYW1lIHdpdGhvdXQgU3ByaW5nIEJvb3QgaWQgZG9lcyBub3QgZW1pdCBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZy1mYWxzZS1hbGlhc1wiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiZ3JhZGxlXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcImJ1aWxkLmdyYWRsZS5rdHNcIiksIFwicGx1Z2lucyB7IGFsaWFzKGxpYnMucGx1Z2lucy5zcHJpbmcuYm9vdC5jb252ZW50aW9ucykgfVwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJncmFkbGVcIiwgXCJsaWJzLnZlcnNpb25zLnRvbWxcIiksXG4gICAgICBcIltwbHVnaW5zXVxcbnNwcmluZy1ib290LWNvbnZlbnRpb25zID0geyBpZCA9ICdjb20uZXhhbXBsZS5jb252ZW50aW9ucycsIHZlcnNpb24gPSAnMS4wLjAnIH1cXG5cIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayghc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOnNwcmluZy1ib290XCIpLCBcInNwcmluZy1sb29raW5nIGFsaWFzIG5hbWVzIHNob3VsZCBub3QgaW1wbHkgU3ByaW5nIEJvb3Qgd2l0aG91dCBtYXRjaGluZyBpZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFNwcmluZyBCb290IHZlcnNpb24tY2F0YWxvZyBsaWJyYXJ5IGFsaWFzIGVtaXRzIGRlcDpzcHJpbmctYm9vdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwic2lnbmFscy1zcHJpbmctdmVyc2lvbi1jYXRhbG9nLWxpYnJhcnlcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImdyYWRsZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGUua3RzXCIpLCBcImRlcGVuZGVuY2llcyB7IGltcGxlbWVudGF0aW9uKGxpYnMuYmFja2VuZC53ZWIpIH1cIiwgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiZ3JhZGxlXCIsIFwibGlicy52ZXJzaW9ucy50b21sXCIpLFxuICAgICAgXCJbbGlicmFyaWVzXVxcbmJhY2tlbmQtd2ViID0geyBtb2R1bGUgPSAnb3JnLnNwcmluZ2ZyYW1ld29yay5ib290OnNwcmluZy1ib290LXN0YXJ0ZXItd2ViJywgdmVyc2lvbiA9ICczLjIuMCcgfVxcblwiLFxuICAgICAgXCJ1dGYtOFwiLFxuICAgICk7XG4gICAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGRpcik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbHMuZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcImRlcDpzcHJpbmctYm9vdFwiKSwgXCJTcHJpbmcgQm9vdCBsaWJyYXJ5IGFsaWFzZXMgc2hvdWxkIHRyaWdnZXIgZGV0ZWN0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogU3ByaW5nIEJvb3QgdmVyc2lvbi1jYXRhbG9nIGJ1bmRsZSBhbGlhcyBlbWl0cyBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZy1idW5kbGVcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImdyYWRsZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGUua3RzXCIpLCBcImRlcGVuZGVuY2llcyB7IGltcGxlbWVudGF0aW9uKGxpYnMuYnVuZGxlcy5iYWNrZW5kLndlYikgfVwiLCBcInV0Zi04XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGRpciwgXCJncmFkbGVcIiwgXCJsaWJzLnZlcnNpb25zLnRvbWxcIiksXG4gICAgICBcIltsaWJyYXJpZXNdXFxuc3ByaW5nLWJvb3Qtc3RhcnRlci13ZWIgPSB7IG1vZHVsZSA9ICdvcmcuc3ByaW5nZnJhbWV3b3JrLmJvb3Q6c3ByaW5nLWJvb3Qtc3RhcnRlci13ZWInLCB2ZXJzaW9uID0gJzMuMi4wJyB9XFxuXFxuW2J1bmRsZXNdXFxuYmFja2VuZC13ZWIgPSBbJ3NwcmluZy1ib290LXN0YXJ0ZXItd2ViJ11cXG5cIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6c3ByaW5nLWJvb3RcIiksIFwiU3ByaW5nIEJvb3QgYnVuZGxlIGFsaWFzZXMgc2hvdWxkIHRyaWdnZXIgZGV0ZWN0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkZXRlY3RQcm9qZWN0U2lnbmFsczogU3ByaW5nIEJvb3QgY3VzdG9tIHZlcnNpb24tY2F0YWxvZyBhY2Nlc3NvciBlbWl0cyBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZy1jdXN0b20tYWNjZXNzb3JcIik7XG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcImdyYWRsZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJidWlsZC5ncmFkbGUua3RzXCIpLCBcInBsdWdpbnMgeyBhbGlhcyhiYWNrZW5kLnBsdWdpbnMud2ViKSB9XCIsIFwidXRmLThcIik7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oZGlyLCBcImdyYWRsZVwiLCBcImJhY2tlbmQudmVyc2lvbnMudG9tbFwiKSxcbiAgICAgIFwiW3BsdWdpbnNdXFxud2ViID0geyBpZCA9ICdvcmcuc3ByaW5nZnJhbWV3b3JrLmJvb3QnLCB2ZXJzaW9uID0gJzMuMi4wJyB9XFxuXCIsXG4gICAgICBcInV0Zi04XCIsXG4gICAgKTtcbiAgICBjb25zdCBzaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoZGlyKTtcbiAgICBhc3NlcnQub2soc2lnbmFscy5kZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZGVwOnNwcmluZy1ib290XCIpLCBcImN1c3RvbSB2ZXJzaW9uLWNhdGFsb2cgYWNjZXNzb3JzIHNob3VsZCB0cmlnZ2VyIFNwcmluZyBCb290IGRldGVjdGlvblwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGRpcik7XG4gIH1cbn0pO1xuXG50ZXN0KFwiZGV0ZWN0UHJvamVjdFNpZ25hbHM6IFNwcmluZyBCb290IHNldHRpbmdzLWRlZmluZWQgY2F0YWxvZyBhY2Nlc3NvciBlbWl0cyBkZXA6c3ByaW5nLWJvb3RcIiwgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInNpZ25hbHMtc3ByaW5nLXZlcnNpb24tY2F0YWxvZy1zZXR0aW5ncy1hY2Nlc3NvclwiKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihkaXIsIFwiZ3JhZGxlXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwic2V0dGluZ3MuZ3JhZGxlLmt0c1wiKSxcbiAgICAgICdkZXBlbmRlbmN5UmVzb2x1dGlvbk1hbmFnZW1lbnQgeyB2ZXJzaW9uQ2F0YWxvZ3MgeyBjcmVhdGUoXCJiYWNrZW5kTGlic1wiKSB7IGZyb20oZmlsZXMoXCIuL2dyYWRsZS9iYWNrZW5kLnZlcnNpb25zLnRvbWxcIikpIH0gfSB9JyxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiYnVpbGQuZ3JhZGxlLmt0c1wiKSwgXCJwbHVnaW5zIHsgYWxpYXMoYmFja2VuZExpYnMucGx1Z2lucy53ZWIpIH1cIiwgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihkaXIsIFwiZ3JhZGxlXCIsIFwiYmFja2VuZC52ZXJzaW9ucy50b21sXCIpLFxuICAgICAgXCJbcGx1Z2luc11cXG53ZWIgPSB7IGlkID0gJ29yZy5zcHJpbmdmcmFtZXdvcmsuYm9vdCcsIHZlcnNpb24gPSAnMy4yLjAnIH1cXG5cIixcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuICAgIGNvbnN0IHNpZ25hbHMgPSBkZXRlY3RQcm9qZWN0U2lnbmFscyhkaXIpO1xuICAgIGFzc2VydC5vayhzaWduYWxzLmRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJkZXA6c3ByaW5nLWJvb3RcIiksIFwic2V0dGluZ3MtZGVmaW5lZCBjYXRhbG9nIGFjY2Vzc29ycyBzaG91bGQgdHJpZ2dlciBTcHJpbmcgQm9vdCBkZXRlY3Rpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChkaXIpO1xuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHNjYW5Qcm9qZWN0RmlsZXM6IFJFQ1VSU0lWRV9TQ0FOX0lHTk9SRURfRElSUyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInNjYW5Qcm9qZWN0RmlsZXM6IGV4Y2x1ZGVzIC5jbGF1ZGUsIC5nc2QsIC5wbGFubmluZywgLnBsYW5zLCAuY3Vyc29yLCAudnNjb2RlIGRpcmVjdG9yaWVzXCIsICgpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzY2FuLWlnbm9yZS1kb3RkaXJzXCIpO1xuICB0cnkge1xuICAgIC8vIENyZWF0ZSBwcm9qZWN0IGZpbGVzIHRoYXQgc2hvdWxkIGJlIGluY2x1ZGVkXG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInNyY1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJzcmNcIiwgXCJtYWluLnRzXCIpLCBcIi8vIG1haW5cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlJFQURNRS5tZFwiKSwgXCIjIFByb2plY3RcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICAgIC8vIENyZWF0ZSB0b29sIGRpcmVjdG9yaWVzIHRoYXQgc2hvdWxkIGJlIGV4Y2x1ZGVkXG4gICAgY29uc3QgZXhjbHVkZWREaXJzID0gW1wiLmNsYXVkZVwiLCBcIi5nc2RcIiwgXCIucGxhbm5pbmdcIiwgXCIucGxhbnNcIiwgXCIuY3Vyc29yXCIsIFwiLnZzY29kZVwiXTtcbiAgICBmb3IgKGNvbnN0IGQgb2YgZXhjbHVkZWREaXJzKSB7XG4gICAgICBta2RpclN5bmMoam9pbihkaXIsIGQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIGQsIFwiY29uZmlnLmpzb25cIiksIFwie31cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICB9XG4gICAgLy8gTmVzdGVkIC5jbGF1ZGUgZGlyZWN0b3J5XG4gICAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5jbGF1ZGVcIiwgXCJtZW1vcnlcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiLmNsYXVkZVwiLCBcIm1lbW9yeVwiLCBcInVzZXIubWRcIiksIFwiIyBNZW1vcnlcXG5cIiwgXCJ1dGYtOFwiKTtcblxuICAgIGNvbnN0IGZpbGVzID0gc2NhblByb2plY3RGaWxlcyhkaXIpO1xuXG4gICAgLy8gU2hvdWxkIGluY2x1ZGUgcHJvamVjdCBmaWxlc1xuICAgIGFzc2VydC5vayhmaWxlcy5pbmNsdWRlcyhcInNyYy9tYWluLnRzXCIpLCBcInNob3VsZCBpbmNsdWRlIHNyYy9tYWluLnRzXCIpO1xuICAgIGFzc2VydC5vayhmaWxlcy5pbmNsdWRlcyhcIlJFQURNRS5tZFwiKSwgXCJzaG91bGQgaW5jbHVkZSBSRUFETUUubWRcIik7XG5cbiAgICAvLyBTaG91bGQgZXhjbHVkZSBhbGwgdG9vbCBkaXJlY3Rvcmllc1xuICAgIGZvciAoY29uc3QgZCBvZiBleGNsdWRlZERpcnMpIHtcbiAgICAgIGNvbnN0IGhhc0V4Y2x1ZGVkID0gZmlsZXMuc29tZSgoZikgPT4gZi5zdGFydHNXaXRoKGAke2R9L2ApKTtcbiAgICAgIGFzc2VydC5vayghaGFzRXhjbHVkZWQsIGBzaG91bGQgZXhjbHVkZSAke2R9LyBkaXJlY3RvcnkgYnV0IGZvdW5kOiAke2ZpbGVzLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKGAke2R9L2ApKS5qb2luKFwiLCBcIil9YCk7XG4gICAgfVxuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoZGlyKTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxlQUFlLGNBQTBCO0FBQzdELFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLFlBQVksUUFBd0I7QUFDM0MsUUFBTSxNQUFNO0FBQUEsSUFDVixPQUFPO0FBQUEsSUFDUCxzQkFBc0IsTUFBTSxJQUFJLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUFBLEVBQ3RGO0FBQ0EsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsU0FBTztBQUNUO0FBRUEsU0FBUyxRQUFRLEtBQW1CO0FBQ2xDLE1BQUk7QUFDRixXQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM5QyxRQUFRO0FBQUEsRUFFUjtBQUNGO0FBRUEsU0FBUyxJQUFJLEtBQWEsTUFBc0I7QUFDOUMsZUFBYSxPQUFPLE1BQU0sRUFBRSxLQUFLLEtBQUssT0FBTyxTQUFTLENBQUM7QUFDekQ7QUFFQSxTQUFTLFlBQVksUUFBd0I7QUFDM0MsUUFBTSxNQUFNLFlBQVksTUFBTTtBQUM5QixNQUFJLEtBQUssQ0FBQyxNQUFNLENBQUM7QUFDakIsTUFBSSxLQUFLLENBQUMsVUFBVSxjQUFjLGtCQUFrQixDQUFDO0FBQ3JELE1BQUksS0FBSyxDQUFDLFVBQVUsYUFBYSxXQUFXLENBQUM7QUFDN0MsU0FBTztBQUNUO0FBSUEsS0FBSywwREFBMEQsQ0FBQyxNQUFNO0FBQ3BF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
