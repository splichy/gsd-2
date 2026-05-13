import { execFileSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { gsdRoot } from "./paths.js";
import { gsdHome } from "./gsd-home.js";
const PROJECT_FILES = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "composer.json",
  "pubspec.yaml",
  "Package.swift",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
  // .NET
  ".sln",
  ".csproj",
  "Directory.Build.props",
  // Git submodules
  ".gitmodules",
  // Xcode
  "project.yml",
  ".xcodeproj",
  ".xcworkspace",
  // Cloud platform config files
  "firebase.json",
  "cdk.json",
  "samconfig.toml",
  "serverless.yml",
  "serverless.yaml",
  "azure-pipelines.yml",
  // Database / ORM config files
  "prisma/schema.prisma",
  "supabase/config.toml",
  "drizzle.config.ts",
  "drizzle.config.js",
  "redis.conf",
  // React Native markers
  "metro.config.js",
  "metro.config.ts",
  "react-native.config.js",
  // Frontend framework config files
  "angular.json",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "nuxt.config.ts",
  "nuxt.config.js",
  "svelte.config.js",
  "svelte.config.ts",
  // Vue CLI config files
  "vue.config.js",
  "vue.config.ts",
  // Frontend tooling
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
  // Android project markers
  "app/build.gradle",
  "app/build.gradle.kts",
  // Container / DevOps config files
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  // Infrastructure as Code
  "main.tf",
  // Kubernetes / Helm markers
  "Chart.yaml",
  "kustomization.yaml",
  // CI/CD markers
  ".github/workflows",
  // Blockchain / Web3 markers
  "hardhat.config.js",
  "hardhat.config.ts",
  "foundry.toml",
  // Data engineering markers
  "dbt_project.yml",
  "airflow.cfg",
  // Game engine markers
  "ProjectSettings/ProjectVersion.txt",
  "project.godot",
  // Python framework markers
  "manage.py",
  "requirements.txt"
];
const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
const SQL_EXTENSIONS = [".sql"];
const DOTNET_EXTENSIONS = [".csproj", ".sln", ".fsproj"];
const VUE_EXTENSIONS = [".vue"];
const LANGUAGE_MAP = {
  "package.json": "javascript/typescript",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pyproject.toml": "python",
  "setup.py": "python",
  "Gemfile": "ruby",
  "pom.xml": "java",
  "build.gradle": "java/kotlin",
  "build.gradle.kts": "kotlin",
  "app/build.gradle": "java/kotlin",
  "app/build.gradle.kts": "kotlin",
  "CMakeLists.txt": "c/c++",
  "composer.json": "php",
  "pubspec.yaml": "dart/flutter",
  "Package.swift": "swift",
  "mix.exs": "elixir",
  "deno.json": "typescript/deno",
  "deno.jsonc": "typescript/deno",
  ".sln": "dotnet",
  ".csproj": "dotnet",
  "Directory.Build.props": "dotnet",
  "project.yml": "swift/xcode",
  ".xcodeproj": "swift/xcode",
  ".xcworkspace": "swift/xcode",
  "Dockerfile": "docker",
  "manage.py": "python",
  "requirements.txt": "python"
};
const MONOREPO_MARKERS = [
  "lerna.json",
  "nx.json",
  "turbo.json",
  "pnpm-workspace.yaml"
];
const CI_MARKERS = [
  ".github/workflows",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".circleci",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml"
];
const TEST_MARKERS = [
  "__tests__",
  "tests",
  "test",
  "spec",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.js",
  ".mocharc.yml",
  "pytest.ini",
  "conftest.py",
  "phpunit.xml"
];
const RECURSIVE_SCAN_IGNORED_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".gsd",
  ".bg-shell",
  ".planning",
  ".plans",
  ".claude",
  ".cursor",
  ".vscode",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  ".turbo",
  "Pods",
  "bin",
  "obj",
  ".gradle",
  "DerivedData",
  "out"
]);
const PROJECT_CONTENT_EXCLUDE_DIRS = RECURSIVE_SCAN_IGNORED_DIRS;
const ROOT_ONLY_PROJECT_FILES = /* @__PURE__ */ new Set([
  ".github/workflows",
  "package.json",
  "Gemfile",
  "Makefile",
  "CMakeLists.txt",
  "build.gradle",
  "build.gradle.kts",
  "deno.json",
  "deno.jsonc"
]);
const MAX_RECURSIVE_SCAN_FILES = 2e3;
const MAX_RECURSIVE_SCAN_DEPTH = 6;
function detectProjectState(basePath) {
  const v1 = detectV1Planning(basePath);
  const v2 = detectV2Gsd(basePath);
  const projectSignals = detectProjectSignals(basePath);
  const globalSetup = hasGlobalSetup();
  const firstEver = isFirstEverLaunch();
  let state;
  if (v2 && v2.milestoneCount > 0) {
    state = "v2-gsd";
  } else if (v2 && v2.milestoneCount === 0) {
    state = "v2-gsd-empty";
  } else if (v1) {
    state = "v1-planning";
  } else {
    state = "none";
  }
  return {
    state,
    isFirstEverLaunch: firstEver,
    hasGlobalSetup: globalSetup,
    v1: v1 ?? void 0,
    v2: v2 ?? void 0,
    projectSignals
  };
}
function detectV1Planning(basePath) {
  const planningPath = join(basePath, ".planning");
  if (!existsSync(planningPath)) return null;
  try {
    const stat = statSync(planningPath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const hasRoadmap = existsSync(join(planningPath, "ROADMAP.md"));
  const phasesPath = join(planningPath, "phases");
  const hasPhasesDir = existsSync(phasesPath);
  let phaseCount = 0;
  if (hasPhasesDir) {
    try {
      const entries = readdirSync(phasesPath, { withFileTypes: true });
      phaseCount = entries.filter((e) => e.isDirectory()).length;
    } catch {
    }
  }
  return {
    path: planningPath,
    hasPhasesDir,
    hasRoadmap,
    phaseCount
  };
}
function detectV2Gsd(basePath) {
  const gsdPath = gsdRoot(basePath);
  if (!existsSync(gsdPath)) return null;
  const hasPreferences = existsSync(join(gsdPath, "PREFERENCES.md")) || existsSync(join(gsdPath, "preferences.md"));
  const hasContext = existsSync(join(gsdPath, "CONTEXT.md"));
  let milestoneCount = 0;
  const milestonesPath = join(gsdPath, "milestones");
  if (existsSync(milestonesPath)) {
    try {
      const entries = readdirSync(milestonesPath, { withFileTypes: true });
      milestoneCount = entries.filter((e) => e.isDirectory()).length;
    } catch {
    }
  }
  return { milestoneCount, hasPreferences, hasContext };
}
function detectProjectSignals(basePath) {
  const detectedFiles = [];
  let primaryLanguage;
  for (const file of PROJECT_FILES) {
    if (existsSync(join(basePath, file))) {
      detectedFiles.push(file);
      if (!primaryLanguage) {
        primaryLanguage = LANGUAGE_MAP[file];
      }
    }
  }
  const scannedFiles = scanProjectFiles(basePath);
  for (const file of PROJECT_FILES) {
    if (detectedFiles.includes(file) || ROOT_ONLY_PROJECT_FILES.has(file)) continue;
    const hasMatch = file === "requirements.txt" ? scannedFiles.some(isPythonRequirementsFile) : scannedFiles.some((scannedFile) => matchesProjectFileMarker(scannedFile, file));
    if (hasMatch) {
      pushUnique(detectedFiles, file);
      if (!primaryLanguage && LANGUAGE_MAP[file]) {
        primaryLanguage = LANGUAGE_MAP[file];
      }
    }
  }
  if (scannedFiles.some((file) => SQLITE_EXTENSIONS.some((ext) => file.endsWith(ext)))) {
    pushUnique(detectedFiles, "*.sqlite");
  }
  if (scannedFiles.some((file) => SQL_EXTENSIONS.some((ext) => file.endsWith(ext)))) {
    pushUnique(detectedFiles, "*.sql");
  }
  const hasCsproj = scannedFiles.some((file) => file.endsWith(".csproj"));
  const hasFsproj = scannedFiles.some((file) => file.endsWith(".fsproj"));
  const hasSln = scannedFiles.some((file) => file.endsWith(".sln"));
  if (hasCsproj) {
    pushUnique(detectedFiles, "*.csproj");
    if (!primaryLanguage) primaryLanguage = "csharp";
  }
  if (hasFsproj) {
    pushUnique(detectedFiles, "*.fsproj");
    if (!primaryLanguage) primaryLanguage = "fsharp";
  }
  if (hasSln) {
    pushUnique(detectedFiles, "*.sln");
    if (!primaryLanguage) primaryLanguage = "dotnet";
  }
  if (scannedFiles.some((file) => VUE_EXTENSIONS.some((ext) => file.endsWith(ext)))) {
    pushUnique(detectedFiles, "*.vue");
  }
  const dependencyFiles = scannedFiles.filter(
    (file) => isPythonRequirementsFile(file) || file.endsWith("pyproject.toml")
  );
  if (containsFastapiDependency(basePath, dependencyFiles)) {
    pushUnique(detectedFiles, "dep:fastapi");
  }
  const springBootBuildFiles = scannedFiles.filter(
    (file) => file.endsWith("pom.xml") || file.endsWith("build.gradle") || file.endsWith("build.gradle.kts")
  );
  const springBootVersionCatalogs = scannedFiles.filter((file) => file.endsWith(".versions.toml"));
  const springBootSettingsFiles = scannedFiles.filter(
    (file) => file.endsWith("settings.gradle") || file.endsWith("settings.gradle.kts")
  );
  if (containsSpringBootMarker(basePath, springBootBuildFiles, springBootVersionCatalogs, springBootSettingsFiles)) {
    pushUnique(detectedFiles, "dep:spring-boot");
    if (!primaryLanguage) {
      primaryLanguage = "java/kotlin";
    }
  }
  const isGitRepo = existsSync(join(basePath, ".git"));
  const xcodePlatforms = detectXcodePlatforms(basePath);
  if (!primaryLanguage && xcodePlatforms.length > 0) {
    primaryLanguage = "swift";
  }
  let isMonorepo = false;
  for (const marker of MONOREPO_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      isMonorepo = true;
      break;
    }
  }
  if (!isMonorepo && detectedFiles.includes("package.json")) {
    isMonorepo = packageJsonHasWorkspaces(basePath);
  }
  let hasCI = false;
  for (const marker of CI_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      hasCI = true;
      break;
    }
  }
  let hasTests = false;
  for (const marker of TEST_MARKERS) {
    if (existsSync(join(basePath, marker))) {
      hasTests = true;
      break;
    }
  }
  const packageManager = detectPackageManager(basePath);
  const verificationCommands = detectVerificationCommands(basePath, detectedFiles, packageManager);
  return {
    detectedFiles,
    isGitRepo,
    isMonorepo,
    primaryLanguage,
    xcodePlatforms,
    hasCI,
    hasTests,
    packageManager,
    verificationCommands
  };
}
function normalizeGitPath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}
function isProjectContentFile(file) {
  const normalized = normalizeGitPath(file);
  if (!normalized || normalized.endsWith("/")) return false;
  if (normalized === ".gitignore" || normalized === ".gitattributes") return false;
  const parts = normalized.split("/");
  if (parts.some((part) => PROJECT_CONTENT_EXCLUDE_DIRS.has(part))) return false;
  if (normalized.endsWith(".DS_Store")) return false;
  return true;
}
function runGitLines(basePath, args) {
  try {
    const output = execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8"
    }).trim();
    return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function listTrackedProjectFiles(basePath) {
  return runGitLines(basePath, ["ls-files"]).map(normalizeGitPath).filter(isProjectContentFile);
}
function listUntrackedProjectFiles(basePath) {
  return runGitLines(basePath, ["ls-files", "--others", "--exclude-standard"]).map(normalizeGitPath).filter(isProjectContentFile);
}
function hasKnownProjectMarkers(basePath, signals) {
  if (signals.detectedFiles.length > 0) return true;
  if (signals.xcodePlatforms.length > 0) return true;
  return false;
}
function classifyProject(basePath) {
  const signals = detectProjectSignals(basePath);
  const markers = [...signals.detectedFiles];
  if (!signals.isGitRepo) {
    return {
      kind: "invalid-repo",
      signals,
      trackedFiles: [],
      untrackedFiles: [],
      contentFiles: [],
      markers,
      reason: "missing .git"
    };
  }
  const trackedFiles = listTrackedProjectFiles(basePath);
  const untrackedFiles = listUntrackedProjectFiles(basePath);
  const contentFiles = [.../* @__PURE__ */ new Set([...trackedFiles, ...untrackedFiles])];
  const hasMarkers = hasKnownProjectMarkers(basePath, signals);
  if (hasMarkers) {
    return {
      kind: "typed-existing",
      signals,
      trackedFiles,
      untrackedFiles,
      contentFiles,
      markers,
      reason: markers.length > 0 ? `detected markers: ${markers.join(", ")}` : "detected project structure"
    };
  }
  if (contentFiles.length > 0) {
    return {
      kind: "untyped-existing",
      signals,
      trackedFiles,
      untrackedFiles,
      contentFiles,
      markers,
      reason: "project content exists but no recognized tooling markers were found"
    };
  }
  return {
    kind: "greenfield",
    signals,
    trackedFiles,
    untrackedFiles,
    contentFiles,
    markers,
    reason: "no tracked or non-ignored project content"
  };
}
const SDKROOT_MAP = {
  iphoneos: "iphoneos",
  iphonesimulator: "iphoneos",
  // simulator builds still target iOS
  macosx: "macosx",
  watchos: "watchos",
  watchsimulator: "watchos",
  appletvos: "appletvos",
  appletvsimulator: "appletvos",
  xros: "xros",
  xrsimulator: "xros"
};
const SUPPORTED_PLATFORMS_RE = /SUPPORTED_PLATFORMS\s*=\s*"([^"]+)"/gi;
function readBounded(filePath, maxBytes) {
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
const XCODE_SUBDIRS = ["ios", "macos", "app", "apps"];
function detectXcodePlatforms(basePath) {
  const platforms = /* @__PURE__ */ new Set();
  const dirsToScan = [basePath];
  for (const sub of XCODE_SUBDIRS) {
    const subPath = join(basePath, sub);
    if (existsSync(subPath)) dirsToScan.push(subPath);
  }
  for (const dir of dirsToScan) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith(".xcodeproj")) continue;
        const pbxprojPath = join(dir, entry.name, "project.pbxproj");
        try {
          const content = readBounded(pbxprojPath, 1024 * 1024);
          const sdkRe = /SDKROOT\s*=\s*"?([a-z]+)"?\s*;/gi;
          let m;
          let foundExplicit = false;
          while ((m = sdkRe.exec(content)) !== null) {
            const val = m[1].toLowerCase();
            if (val === "auto") continue;
            const canonical = SDKROOT_MAP[val];
            if (canonical) {
              platforms.add(canonical);
              foundExplicit = true;
            }
          }
          if (!foundExplicit) {
            let sp;
            while ((sp = SUPPORTED_PLATFORMS_RE.exec(content)) !== null) {
              for (const tok of sp[1].split(/\s+/)) {
                const canonical = SDKROOT_MAP[tok.toLowerCase()];
                if (canonical) platforms.add(canonical);
              }
            }
            SUPPORTED_PLATFORMS_RE.lastIndex = 0;
          }
        } catch {
        }
      }
    } catch {
    }
  }
  return [...platforms];
}
function detectPackageManager(basePath) {
  if (existsSync(join(basePath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(basePath, "yarn.lock"))) return "yarn";
  if (existsSync(join(basePath, "bun.lockb")) || existsSync(join(basePath, "bun.lock"))) return "bun";
  if (existsSync(join(basePath, "package-lock.json"))) return "npm";
  if (existsSync(join(basePath, "package.json"))) return "npm";
  return void 0;
}
function detectVerificationCommands(basePath, detectedFiles, packageManager) {
  const commands = [];
  const pm = packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : pm === "bun" ? "bun run" : `${pm} run`;
  if (detectedFiles.includes("package.json")) {
    const scripts = readPackageJsonScripts(basePath);
    if (scripts) {
      if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
        commands.push(pm === "npm" ? "npm test" : `${pm} test`);
      }
      if (scripts.build) {
        commands.push(`${run} build`);
      }
      if (scripts.lint) {
        commands.push(`${run} lint`);
      }
      if (scripts.typecheck) {
        commands.push(`${run} typecheck`);
      } else if (scripts.tsc) {
        commands.push(`${run} tsc`);
      }
    }
  }
  if (detectedFiles.includes("Cargo.toml")) {
    commands.push("cargo test");
    commands.push("cargo clippy");
  }
  if (detectedFiles.includes("go.mod")) {
    commands.push("go test ./...");
    commands.push("go vet ./...");
  }
  if (detectedFiles.includes("pyproject.toml") || detectedFiles.includes("setup.py") || detectedFiles.includes("requirements.txt")) {
    commands.push("pytest");
  }
  if (detectedFiles.includes("Gemfile")) {
    if (existsSync(join(basePath, "spec"))) {
      commands.push("bundle exec rspec");
    } else {
      commands.push("bundle exec rake test");
    }
  }
  if (detectedFiles.includes("Makefile")) {
    const makeTargets = readMakefileTargets(basePath);
    if (makeTargets.includes("test")) {
      commands.push("make test");
    }
  }
  return commands;
}
function hasGlobalSetup() {
  return existsSync(join(gsdHome(), "PREFERENCES.md")) || existsSync(join(gsdHome(), "preferences.md"));
}
function isFirstEverLaunch() {
  if (!existsSync(gsdHome())) return true;
  if (existsSync(join(gsdHome(), "PREFERENCES.md")) || existsSync(join(gsdHome(), "preferences.md"))) {
    return false;
  }
  if (existsSync(join(gsdHome(), "agent", "auth.json"))) return false;
  const legacyPath = join(homedir(), ".pi", "agent", "gsd-preferences.md");
  if (existsSync(legacyPath)) return false;
  return true;
}
function packageJsonHasWorkspaces(basePath) {
  try {
    const raw = readFileSync(join(basePath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return Array.isArray(pkg.workspaces) || pkg.workspaces && typeof pkg.workspaces === "object";
  } catch {
    return false;
  }
}
function readPackageJsonScripts(basePath) {
  try {
    const raw = readFileSync(join(basePath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : null;
  } catch {
    return null;
  }
}
function readMakefileTargets(basePath) {
  try {
    const raw = readFileSync(join(basePath, "Makefile"), "utf-8");
    const targets = [];
    for (const line of raw.split("\n")) {
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/);
      if (match) targets.push(match[1]);
    }
    return targets;
  } catch {
    return [];
  }
}
function pushUnique(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}
function matchesProjectFileMarker(scannedFile, marker) {
  const normalized = scannedFile.replaceAll("\\", "/");
  return normalized === marker || normalized.endsWith(`/${marker}`);
}
function isPythonRequirementsFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename === "requirements.txt" || basename === "requirements.in" || /^requirements([-.].+)?\.(txt|in)$/i.test(basename) || /(^|\/)requirements\/.+\.(txt|in)$/i.test(normalized);
}
function containsFastapiDependency(basePath, relativePaths) {
  for (const relativePath of relativePaths) {
    try {
      const raw = readBounded(join(basePath, relativePath), 64 * 1024);
      const content = extractDependencyContent(relativePath, raw);
      if (isPythonRequirementsFile(relativePath)) {
        for (const line of content.split("\n")) {
          if (extractRequirementName(line) === "fastapi") return true;
        }
        continue;
      }
      if (relativePath.endsWith("pyproject.toml")) {
        if (containsFastapiInPyproject(content)) return true;
      }
    } catch {
    }
  }
  return false;
}
function containsSpringBootMarker(basePath, buildFiles, versionCatalogFiles, settingsFiles) {
  const usedPluginAliases = /* @__PURE__ */ new Set();
  const usedLibraryAliases = /* @__PURE__ */ new Set();
  const catalogAccessors = resolveVersionCatalogAccessors(basePath, versionCatalogFiles, settingsFiles);
  for (const relativePath of buildFiles) {
    try {
      const raw = readBounded(join(basePath, relativePath), 64 * 1024);
      const content = stripDependencyComments(relativePath, raw);
      if (containsDirectSpringBootReference(relativePath, content)) {
        return true;
      }
      const normalized = content.toLowerCase();
      let match;
      for (const accessor of catalogAccessors) {
        const aliasRe = new RegExp(`alias\\(\\s*${accessor}\\.plugins\\.([a-z0-9_.-]+)\\s*\\)`, "gi");
        while ((match = aliasRe.exec(normalized)) !== null) {
          usedPluginAliases.add(normalizePluginAlias(match[1]));
        }
        const libraryAliasRe = new RegExp(`\\b${accessor}\\.((?!plugins\\b)[a-z0-9_.-]+)`, "gi");
        while ((match = libraryAliasRe.exec(normalized)) !== null) {
          usedLibraryAliases.add(normalizePluginAlias(match[1]));
        }
      }
    } catch {
    }
  }
  if (usedPluginAliases.size === 0 && usedLibraryAliases.size === 0) {
    return false;
  }
  if (versionCatalogFiles.length === 0) {
    return false;
  }
  const springBootAliases = /* @__PURE__ */ new Set();
  const springBootLibraries = /* @__PURE__ */ new Set();
  const pendingSpringBootBundles = [];
  for (const relativePath of versionCatalogFiles) {
    try {
      const raw = readBounded(join(basePath, relativePath), 64 * 1024);
      const content = stripDependencyComments(relativePath, raw);
      const aliasRe = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^\n}]*\bid\s*=\s*["']org\.springframework\.boot["'][^\n}]*\}/gm;
      let match;
      while ((match = aliasRe.exec(content)) !== null) {
        springBootAliases.add(normalizePluginAlias(match[1]));
      }
      const libraryRe = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^\n}]*\b(module\s*=\s*["']org\.springframework\.boot:[^"']+["']|group\s*=\s*["']org\.springframework\.boot["'][^\n}]*\bname\s*=\s*["']spring-boot[^"']*["'])[^\n}]*\}/gm;
      while ((match = libraryRe.exec(content)) !== null) {
        springBootLibraries.add(normalizePluginAlias(match[1]));
      }
      const bundleRe = /^\s*([A-Za-z0-9_.-]+)\s*=\s*\[([\s\S]*?)\]/gm;
      while ((match = bundleRe.exec(content)) !== null) {
        pendingSpringBootBundles.push({
          bundleAlias: normalizePluginAlias(`bundles.${match[1]}`),
          referencedAliases: match[2].split(",").map((part) => normalizePluginAlias(part.replace(/["'\s]/g, ""))).filter(Boolean)
        });
      }
    } catch {
    }
  }
  const springBootBundles = /* @__PURE__ */ new Set();
  for (const pendingBundle of pendingSpringBootBundles) {
    if (pendingBundle.referencedAliases.some((alias) => springBootLibraries.has(alias))) {
      springBootBundles.add(pendingBundle.bundleAlias);
    }
  }
  for (const alias of usedPluginAliases) {
    if (springBootAliases.has(alias)) return true;
  }
  for (const alias of usedLibraryAliases) {
    if (springBootLibraries.has(alias) || springBootBundles.has(alias)) return true;
  }
  return false;
}
function stripDependencyComments(relativePath, content) {
  if (relativePath.endsWith("requirements.txt")) {
    return content.replace(/(^|\s)#.*$/gm, "");
  }
  if (relativePath.endsWith("pyproject.toml")) {
    return content.replace(/(^|\s)#.*$/gm, "");
  }
  if (relativePath.endsWith(".versions.toml")) {
    return content.replace(/(^|\s)#.*$/gm, "");
  }
  if (relativePath.endsWith("settings.gradle") || relativePath.endsWith("settings.gradle.kts")) {
    return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  if (relativePath.endsWith("pom.xml")) {
    return content.replace(/<!--[\s\S]*?-->/g, "");
  }
  if (relativePath.endsWith("build.gradle") || relativePath.endsWith("build.gradle.kts")) {
    return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  return content;
}
function extractDependencyContent(relativePath, content) {
  const stripped = stripDependencyComments(relativePath, content);
  if (relativePath.endsWith("pyproject.toml")) {
    return extractPyprojectDependencySections(stripped);
  }
  return stripped;
}
function extractRequirementName(spec) {
  const trimmed = spec.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;
  const match = trimmed.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?=\s*(?:@|[<>=!~;]|$))/);
  if (!match) return null;
  return normalizePackageName(match[1]);
}
function containsFastapiInPyproject(content) {
  for (const line of content.split("\n")) {
    const keyMatch = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (keyMatch) {
      const key = normalizePackageName(keyMatch[1]);
      if (key === "fastapi") {
        return true;
      }
      if (key !== "dependencies") {
        continue;
      }
    }
    const quotedSpecRe = /["']([^"']+)["']/g;
    let match;
    while ((match = quotedSpecRe.exec(line)) !== null) {
      if (extractRequirementName(match[1]) === "fastapi") {
        return true;
      }
    }
  }
  return false;
}
function containsDirectSpringBootReference(relativePath, content) {
  if (relativePath.endsWith("pom.xml")) {
    return /<groupId>\s*org\.springframework\.boot\s*<\/groupId>/i.test(content);
  }
  if (relativePath.endsWith("build.gradle") || relativePath.endsWith("build.gradle.kts")) {
    return /(id\s*\(?\s*["']org\.springframework\.boot["']|apply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']|(?:implementation|api|compileOnly|runtimeOnly|testImplementation|annotationProcessor|kapt)\s*\(?\s*["'][^"']*org\.springframework\.boot:[^"']*spring-boot[^"']*["'])/i.test(content);
  }
  return false;
}
function extractPyprojectDependencySections(content) {
  const lines = content.split("\n");
  const collected = [];
  let section = "";
  let collectingProjectDeps = false;
  let collectingOptionalDeps = false;
  let bracketDepth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (collectingProjectDeps) {
      collected.push(line);
      bracketDepth += countChar(line, "[") - countChar(line, "]");
      if (bracketDepth <= 0) {
        collectingProjectDeps = false;
      }
      continue;
    }
    if (collectingOptionalDeps) {
      collected.push(line);
      bracketDepth += countChar(line, "[") - countChar(line, "]");
      if (bracketDepth <= 0) {
        collectingOptionalDeps = false;
      }
      continue;
    }
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section === "project" && /^dependencies\s*=\s*\[/.test(trimmed)) {
      collected.push(line);
      bracketDepth = countChar(line, "[") - countChar(line, "]");
      collectingProjectDeps = bracketDepth > 0;
      continue;
    }
    if (section === "project.optional-dependencies" || section === "tool.poetry.dependencies") {
      if (section === "project.optional-dependencies") {
        const equalsIndex = line.indexOf("=");
        if (equalsIndex !== -1) {
          const value = line.slice(equalsIndex + 1);
          collected.push(value);
          bracketDepth = countChar(value, "[") - countChar(value, "]");
          collectingOptionalDeps = bracketDepth > 0;
        }
      } else {
        collected.push(line);
      }
    }
  }
  return collected.join("\n");
}
function countChar(text, char) {
  return [...text].filter((c) => c === char).length;
}
function normalizePackageName(name) {
  return name.toLowerCase().replace(/[_.]/g, "-");
}
function normalizePluginAlias(alias) {
  return alias.toLowerCase().replace(/[-_]/g, ".");
}
function versionCatalogAccessorName(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.versions\.toml$/i, "").toLowerCase();
}
function resolveVersionCatalogAccessors(basePath, versionCatalogFiles, settingsFiles) {
  const accessors = new Set(versionCatalogFiles.map(versionCatalogAccessorName).filter(Boolean));
  if (versionCatalogFiles.length === 0 || settingsFiles.length === 0) {
    return accessors;
  }
  for (const settingsFile of settingsFiles) {
    try {
      const raw = readBounded(join(basePath, settingsFile), 64 * 1024);
      const content = stripDependencyComments(settingsFile, raw);
      const createRe = /create\(\s*["']([A-Za-z0-9_]+)["']\s*\)\s*\{[\s\S]*?([A-Za-z0-9_.-]+\.versions\.toml)["']?\s*\)\s*\)/g;
      let match;
      while ((match = createRe.exec(content)) !== null) {
        const accessor = match[1].toLowerCase();
        const catalogBasename = match[2].replaceAll("\\", "/").split("/").pop();
        if (versionCatalogFiles.some((file) => {
          const normalized = file.replaceAll("\\", "/");
          return normalized === catalogBasename || normalized.endsWith(`/${catalogBasename}`);
        })) {
          accessors.add(accessor);
        }
      }
    } catch {
    }
  }
  return accessors;
}
function hasProjectFileInAncestor(startDir, existsFn = existsSync) {
  let checkDir = dirname(startDir);
  const { root } = parsePath(checkDir);
  while (checkDir !== root) {
    if (PROJECT_FILES.some((f) => existsFn(join(checkDir, f)))) {
      return true;
    }
    if (existsFn(join(checkDir, ".git"))) return false;
    checkDir = dirname(checkDir);
  }
  return false;
}
function hasGsdBootstrapArtifacts(gsdPath, existsFn = existsSync) {
  return existsFn(gsdPath) && (existsFn(join(gsdPath, "PREFERENCES.md")) || existsFn(join(gsdPath, "preferences.md")) || existsFn(join(gsdPath, "milestones")));
}
function scanProjectFiles(basePath) {
  const files = [];
  const queue = [{ path: basePath, depth: 0 }];
  while (queue.length > 0 && files.length < MAX_RECURSIVE_SCAN_FILES) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current.path, entry.name);
      const relativePath = entryPath.slice(basePath.length + 1);
      if (entry.isDirectory()) {
        if (current.depth < MAX_RECURSIVE_SCAN_DEPTH && !RECURSIVE_SCAN_IGNORED_DIRS.has(entry.name)) {
          queue.push({ path: entryPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(relativePath);
      if (files.length >= MAX_RECURSIVE_SCAN_FILES) break;
    }
  }
  return files;
}
export {
  PROJECT_FILES,
  classifyProject,
  detectProjectSignals,
  detectProjectState,
  detectV1Planning,
  hasGlobalSetup,
  hasGsdBootstrapArtifacts,
  hasProjectFileInAncestor,
  isFirstEverLaunch,
  scanProjectFiles
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kZXRlY3Rpb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIERldGVjdGlvbiBcdTIwMTQgUHJvamVjdCBzdGF0ZSBhbmQgZWNvc3lzdGVtIGRldGVjdGlvbi5cbiAqXG4gKiBQdXJlIGZ1bmN0aW9ucywgemVybyBVSSBkZXBlbmRlbmNpZXMsIHplcm8gc2lkZSBlZmZlY3RzLlxuICogVXNlZCBieSBpbml0LXdpemFyZC50cyBhbmQgZ3VpZGVkLWZsb3cudHMgdG8gZGV0ZXJtaW5lIHdoYXQgb25ib2FyZGluZ1xuICogZmxvdyB0byBzaG93IHdoZW4gZW50ZXJpbmcgYSBwcm9qZWN0IGRpcmVjdG9yeS5cbiAqL1xuXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBvcGVuU3luYywgcmVhZFN5bmMsIGNsb3NlU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiwgcGFyc2UgYXMgcGFyc2VQYXRoIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi9nc2QtaG9tZS5qc1wiO1xuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBQcm9qZWN0RGV0ZWN0aW9uIHtcbiAgLyoqIFdoYXQga2luZCBvZiBHU0Qgc3RhdGUgZXhpc3RzIGluIHRoaXMgZGlyZWN0b3J5ICovXG4gIHN0YXRlOiBcIm5vbmVcIiB8IFwidjEtcGxhbm5pbmdcIiB8IFwidjItZ3NkXCIgfCBcInYyLWdzZC1lbXB0eVwiO1xuXG4gIC8qKiBJcyB0aGlzIHRoZSBmaXJzdCB0aW1lIEdTRCBoYXMgYmVlbiB1c2VkIG9uIHRoaXMgbWFjaGluZT8gKi9cbiAgaXNGaXJzdEV2ZXJMYXVuY2g6IGJvb2xlYW47XG5cbiAgLyoqIERvZXMgfi8uZ3NkLyBleGlzdCB3aXRoIHByZWZlcmVuY2VzPyAqL1xuICBoYXNHbG9iYWxTZXR1cDogYm9vbGVhbjtcblxuICAvKiogdjEgZGV0YWlscyAob25seSB3aGVuIHN0YXRlID09PSAndjEtcGxhbm5pbmcnKSAqL1xuICB2MT86IFYxRGV0ZWN0aW9uO1xuXG4gIC8qKiB2MiBkZXRhaWxzIChvbmx5IHdoZW4gc3RhdGUgPT09ICd2Mi1nc2QnIG9yICd2Mi1nc2QtZW1wdHknKSAqL1xuICB2Mj86IFYyRGV0ZWN0aW9uO1xuXG4gIC8qKiBEZXRlY3RlZCBwcm9qZWN0IGVjb3N5c3RlbSBzaWduYWxzICovXG4gIHByb2plY3RTaWduYWxzOiBQcm9qZWN0U2lnbmFscztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBWMURldGVjdGlvbiB7XG4gIHBhdGg6IHN0cmluZztcbiAgaGFzUGhhc2VzRGlyOiBib29sZWFuO1xuICBoYXNSb2FkbWFwOiBib29sZWFuO1xuICBwaGFzZUNvdW50OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVjJEZXRlY3Rpb24ge1xuICBtaWxlc3RvbmVDb3VudDogbnVtYmVyO1xuICBoYXNQcmVmZXJlbmNlczogYm9vbGVhbjtcbiAgaGFzQ29udGV4dDogYm9vbGVhbjtcbn1cblxuLyoqIEFwcGxlIHBsYXRmb3JtIFNES1JPT1RzIGZvdW5kIGluIFhjb2RlIHByb2plY3QucGJ4cHJvaiBmaWxlcy4gKi9cbmV4cG9ydCB0eXBlIFhjb2RlUGxhdGZvcm0gPSBcImlwaG9uZW9zXCIgfCBcIm1hY29zeFwiIHwgXCJ3YXRjaG9zXCIgfCBcImFwcGxldHZvc1wiIHwgXCJ4cm9zXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvamVjdFNpZ25hbHMge1xuICAvKiogRGV0ZWN0ZWQgcHJvamVjdC9wYWNrYWdlIGZpbGVzICovXG4gIGRldGVjdGVkRmlsZXM6IHN0cmluZ1tdO1xuICAvKiogSXMgdGhpcyBhbHJlYWR5IGEgZ2l0IHJlcG8/ICovXG4gIGlzR2l0UmVwbzogYm9vbGVhbjtcbiAgLyoqIElzIHRoaXMgYSBtb25vcmVwbz8gKi9cbiAgaXNNb25vcmVwbzogYm9vbGVhbjtcbiAgLyoqIFByaW1hcnkgbGFuZ3VhZ2UgaGludCAqL1xuICBwcmltYXJ5TGFuZ3VhZ2U/OiBzdHJpbmc7XG4gIC8qKiBBcHBsZSBwbGF0Zm9ybSBTREtST09UcyBkZXRlY3RlZCBmcm9tICoueGNvZGVwcm9qL3Byb2plY3QucGJ4cHJvaiAqL1xuICB4Y29kZVBsYXRmb3JtczogWGNvZGVQbGF0Zm9ybVtdO1xuICAvKiogSGFzIGV4aXN0aW5nIENJIGNvbmZpZ3VyYXRpb24/ICovXG4gIGhhc0NJOiBib29sZWFuO1xuICAvKiogSGFzIGV4aXN0aW5nIHRlc3Qgc2V0dXA/ICovXG4gIGhhc1Rlc3RzOiBib29sZWFuO1xuICAvKiogRGV0ZWN0ZWQgcGFja2FnZSBtYW5hZ2VyICovXG4gIHBhY2thZ2VNYW5hZ2VyPzogc3RyaW5nO1xuICAvKiogQXV0by1kZXRlY3RlZCB2ZXJpZmljYXRpb24gY29tbWFuZHMgKi9cbiAgdmVyaWZpY2F0aW9uQ29tbWFuZHM6IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgdHlwZSBQcm9qZWN0Q2xhc3NpZmljYXRpb25LaW5kID1cbiAgfCBcImludmFsaWQtcmVwb1wiXG4gIHwgXCJncmVlbmZpZWxkXCJcbiAgfCBcInVudHlwZWQtZXhpc3RpbmdcIlxuICB8IFwidHlwZWQtZXhpc3RpbmdcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQcm9qZWN0Q2xhc3NpZmljYXRpb24ge1xuICBraW5kOiBQcm9qZWN0Q2xhc3NpZmljYXRpb25LaW5kO1xuICBzaWduYWxzOiBQcm9qZWN0U2lnbmFscztcbiAgdHJhY2tlZEZpbGVzOiBzdHJpbmdbXTtcbiAgdW50cmFja2VkRmlsZXM6IHN0cmluZ1tdO1xuICBjb250ZW50RmlsZXM6IHN0cmluZ1tdO1xuICBtYXJrZXJzOiBzdHJpbmdbXTtcbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9qZWN0IEZpbGUgTWFya2VycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGNvbnN0IFBST0pFQ1RfRklMRVMgPSBbXG4gIFwicGFja2FnZS5qc29uXCIsXG4gIFwiQ2FyZ28udG9tbFwiLFxuICBcImdvLm1vZFwiLFxuICBcInB5cHJvamVjdC50b21sXCIsXG4gIFwic2V0dXAucHlcIixcbiAgXCJHZW1maWxlXCIsXG4gIFwicG9tLnhtbFwiLFxuICBcImJ1aWxkLmdyYWRsZVwiLFxuICBcImJ1aWxkLmdyYWRsZS5rdHNcIixcbiAgXCJDTWFrZUxpc3RzLnR4dFwiLFxuICBcIk1ha2VmaWxlXCIsXG4gIFwiY29tcG9zZXIuanNvblwiLFxuICBcInB1YnNwZWMueWFtbFwiLFxuICBcIlBhY2thZ2Uuc3dpZnRcIixcbiAgXCJtaXguZXhzXCIsXG4gIFwiZGVuby5qc29uXCIsXG4gIFwiZGVuby5qc29uY1wiLFxuICAvLyAuTkVUXG4gIFwiLnNsblwiLFxuICBcIi5jc3Byb2pcIixcbiAgXCJEaXJlY3RvcnkuQnVpbGQucHJvcHNcIixcbiAgLy8gR2l0IHN1Ym1vZHVsZXNcbiAgXCIuZ2l0bW9kdWxlc1wiLFxuICAvLyBYY29kZVxuICBcInByb2plY3QueW1sXCIsXG4gIFwiLnhjb2RlcHJvalwiLFxuICBcIi54Y3dvcmtzcGFjZVwiLFxuICAvLyBDbG91ZCBwbGF0Zm9ybSBjb25maWcgZmlsZXNcbiAgXCJmaXJlYmFzZS5qc29uXCIsXG4gIFwiY2RrLmpzb25cIixcbiAgXCJzYW1jb25maWcudG9tbFwiLFxuICBcInNlcnZlcmxlc3MueW1sXCIsXG4gIFwic2VydmVybGVzcy55YW1sXCIsXG4gIFwiYXp1cmUtcGlwZWxpbmVzLnltbFwiLFxuICAvLyBEYXRhYmFzZSAvIE9STSBjb25maWcgZmlsZXNcbiAgXCJwcmlzbWEvc2NoZW1hLnByaXNtYVwiLFxuICBcInN1cGFiYXNlL2NvbmZpZy50b21sXCIsXG4gIFwiZHJpenpsZS5jb25maWcudHNcIixcbiAgXCJkcml6emxlLmNvbmZpZy5qc1wiLFxuICBcInJlZGlzLmNvbmZcIixcbiAgLy8gUmVhY3QgTmF0aXZlIG1hcmtlcnNcbiAgXCJtZXRyby5jb25maWcuanNcIixcbiAgXCJtZXRyby5jb25maWcudHNcIixcbiAgXCJyZWFjdC1uYXRpdmUuY29uZmlnLmpzXCIsXG4gIC8vIEZyb250ZW5kIGZyYW1ld29yayBjb25maWcgZmlsZXNcbiAgXCJhbmd1bGFyLmpzb25cIixcbiAgXCJuZXh0LmNvbmZpZy5qc1wiLFxuICBcIm5leHQuY29uZmlnLnRzXCIsXG4gIFwibmV4dC5jb25maWcubWpzXCIsXG4gIFwibnV4dC5jb25maWcudHNcIixcbiAgXCJudXh0LmNvbmZpZy5qc1wiLFxuICBcInN2ZWx0ZS5jb25maWcuanNcIixcbiAgXCJzdmVsdGUuY29uZmlnLnRzXCIsXG4gIC8vIFZ1ZSBDTEkgY29uZmlnIGZpbGVzXG4gIFwidnVlLmNvbmZpZy5qc1wiLFxuICBcInZ1ZS5jb25maWcudHNcIixcbiAgLy8gRnJvbnRlbmQgdG9vbGluZ1xuICBcInRhaWx3aW5kLmNvbmZpZy5qc1wiLFxuICBcInRhaWx3aW5kLmNvbmZpZy50c1wiLFxuICBcInRhaWx3aW5kLmNvbmZpZy5tanNcIixcbiAgXCJ0YWlsd2luZC5jb25maWcuY2pzXCIsXG4gIC8vIEFuZHJvaWQgcHJvamVjdCBtYXJrZXJzXG4gIFwiYXBwL2J1aWxkLmdyYWRsZVwiLFxuICBcImFwcC9idWlsZC5ncmFkbGUua3RzXCIsXG4gIC8vIENvbnRhaW5lciAvIERldk9wcyBjb25maWcgZmlsZXNcbiAgXCJEb2NrZXJmaWxlXCIsXG4gIFwiZG9ja2VyLWNvbXBvc2UueW1sXCIsXG4gIFwiZG9ja2VyLWNvbXBvc2UueWFtbFwiLFxuICAvLyBJbmZyYXN0cnVjdHVyZSBhcyBDb2RlXG4gIFwibWFpbi50ZlwiLFxuICAvLyBLdWJlcm5ldGVzIC8gSGVsbSBtYXJrZXJzXG4gIFwiQ2hhcnQueWFtbFwiLFxuICBcImt1c3RvbWl6YXRpb24ueWFtbFwiLFxuICAvLyBDSS9DRCBtYXJrZXJzXG4gIFwiLmdpdGh1Yi93b3JrZmxvd3NcIixcbiAgLy8gQmxvY2tjaGFpbiAvIFdlYjMgbWFya2Vyc1xuICBcImhhcmRoYXQuY29uZmlnLmpzXCIsXG4gIFwiaGFyZGhhdC5jb25maWcudHNcIixcbiAgXCJmb3VuZHJ5LnRvbWxcIixcbiAgLy8gRGF0YSBlbmdpbmVlcmluZyBtYXJrZXJzXG4gIFwiZGJ0X3Byb2plY3QueW1sXCIsXG4gIFwiYWlyZmxvdy5jZmdcIixcbiAgLy8gR2FtZSBlbmdpbmUgbWFya2Vyc1xuICBcIlByb2plY3RTZXR0aW5ncy9Qcm9qZWN0VmVyc2lvbi50eHRcIixcbiAgXCJwcm9qZWN0LmdvZG90XCIsXG4gIC8vIFB5dGhvbiBmcmFtZXdvcmsgbWFya2Vyc1xuICBcIm1hbmFnZS5weVwiLFxuICBcInJlcXVpcmVtZW50cy50eHRcIixcbl0gYXMgY29uc3Q7XG5cbi8qKiBGaWxlIGV4dGVuc2lvbnMgdGhhdCBpbmRpY2F0ZSBTUUxpdGUgZGF0YWJhc2VzIGluIHRoZSBwcm9qZWN0LiAqL1xuY29uc3QgU1FMSVRFX0VYVEVOU0lPTlMgPSBbXCIuc3FsaXRlXCIsIFwiLnNxbGl0ZTNcIiwgXCIuZGJcIl0gYXMgY29uc3Q7XG5cbi8qKiBGaWxlIGV4dGVuc2lvbnMgdGhhdCBpbmRpY2F0ZSBTUUwgdXNhZ2UgKG1pZ3JhdGlvbnMsIHNjaGVtYXMsIHNlZWRzKS4gKi9cbmNvbnN0IFNRTF9FWFRFTlNJT05TID0gW1wiLnNxbFwiXSBhcyBjb25zdDtcblxuLyoqIEZpbGUgZXh0ZW5zaW9ucyB0aGF0IGluZGljYXRlIC5ORVQgLyBDIyBwcm9qZWN0cy4gKi9cbmNvbnN0IERPVE5FVF9FWFRFTlNJT05TID0gW1wiLmNzcHJvalwiLCBcIi5zbG5cIiwgXCIuZnNwcm9qXCJdIGFzIGNvbnN0O1xuXG4vKiogRmlsZSBleHRlbnNpb25zIHRoYXQgaW5kaWNhdGUgVnVlLmpzIHNpbmdsZS1maWxlIGNvbXBvbmVudHMuICovXG5jb25zdCBWVUVfRVhURU5TSU9OUyA9IFtcIi52dWVcIl0gYXMgY29uc3Q7XG5cbmNvbnN0IExBTkdVQUdFX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCJwYWNrYWdlLmpzb25cIjogXCJqYXZhc2NyaXB0L3R5cGVzY3JpcHRcIixcbiAgXCJDYXJnby50b21sXCI6IFwicnVzdFwiLFxuICBcImdvLm1vZFwiOiBcImdvXCIsXG4gIFwicHlwcm9qZWN0LnRvbWxcIjogXCJweXRob25cIixcbiAgXCJzZXR1cC5weVwiOiBcInB5dGhvblwiLFxuICBcIkdlbWZpbGVcIjogXCJydWJ5XCIsXG4gIFwicG9tLnhtbFwiOiBcImphdmFcIixcbiAgXCJidWlsZC5ncmFkbGVcIjogXCJqYXZhL2tvdGxpblwiLFxuICBcImJ1aWxkLmdyYWRsZS5rdHNcIjogXCJrb3RsaW5cIixcbiAgXCJhcHAvYnVpbGQuZ3JhZGxlXCI6IFwiamF2YS9rb3RsaW5cIixcbiAgXCJhcHAvYnVpbGQuZ3JhZGxlLmt0c1wiOiBcImtvdGxpblwiLFxuICBcIkNNYWtlTGlzdHMudHh0XCI6IFwiYy9jKytcIixcbiAgXCJjb21wb3Nlci5qc29uXCI6IFwicGhwXCIsXG4gIFwicHVic3BlYy55YW1sXCI6IFwiZGFydC9mbHV0dGVyXCIsXG4gIFwiUGFja2FnZS5zd2lmdFwiOiBcInN3aWZ0XCIsXG4gIFwibWl4LmV4c1wiOiBcImVsaXhpclwiLFxuICBcImRlbm8uanNvblwiOiBcInR5cGVzY3JpcHQvZGVub1wiLFxuICBcImRlbm8uanNvbmNcIjogXCJ0eXBlc2NyaXB0L2Rlbm9cIixcbiAgXCIuc2xuXCI6IFwiZG90bmV0XCIsXG4gIFwiLmNzcHJvalwiOiBcImRvdG5ldFwiLFxuICBcIkRpcmVjdG9yeS5CdWlsZC5wcm9wc1wiOiBcImRvdG5ldFwiLFxuICBcInByb2plY3QueW1sXCI6IFwic3dpZnQveGNvZGVcIixcbiAgXCIueGNvZGVwcm9qXCI6IFwic3dpZnQveGNvZGVcIixcbiAgXCIueGN3b3Jrc3BhY2VcIjogXCJzd2lmdC94Y29kZVwiLFxuICBcIkRvY2tlcmZpbGVcIjogXCJkb2NrZXJcIixcbiAgXCJtYW5hZ2UucHlcIjogXCJweXRob25cIixcbiAgXCJyZXF1aXJlbWVudHMudHh0XCI6IFwicHl0aG9uXCIsXG59O1xuXG5jb25zdCBNT05PUkVQT19NQVJLRVJTID0gW1xuICBcImxlcm5hLmpzb25cIixcbiAgXCJueC5qc29uXCIsXG4gIFwidHVyYm8uanNvblwiLFxuICBcInBucG0td29ya3NwYWNlLnlhbWxcIixcbl0gYXMgY29uc3Q7XG5cbmNvbnN0IENJX01BUktFUlMgPSBbXG4gIFwiLmdpdGh1Yi93b3JrZmxvd3NcIixcbiAgXCIuZ2l0bGFiLWNpLnltbFwiLFxuICBcIkplbmtpbnNmaWxlXCIsXG4gIFwiLmNpcmNsZWNpXCIsXG4gIFwiLnRyYXZpcy55bWxcIixcbiAgXCJhenVyZS1waXBlbGluZXMueW1sXCIsXG4gIFwiYml0YnVja2V0LXBpcGVsaW5lcy55bWxcIixcbl0gYXMgY29uc3Q7XG5cbmNvbnN0IFRFU1RfTUFSS0VSUyA9IFtcbiAgXCJfX3Rlc3RzX19cIixcbiAgXCJ0ZXN0c1wiLFxuICBcInRlc3RcIixcbiAgXCJzcGVjXCIsXG4gIFwiamVzdC5jb25maWcuanNcIixcbiAgXCJqZXN0LmNvbmZpZy50c1wiLFxuICBcInZpdGVzdC5jb25maWcudHNcIixcbiAgXCJ2aXRlc3QuY29uZmlnLmpzXCIsXG4gIFwiLm1vY2hhcmMueW1sXCIsXG4gIFwicHl0ZXN0LmluaVwiLFxuICBcImNvbmZ0ZXN0LnB5XCIsXG4gIFwicGhwdW5pdC54bWxcIixcbl0gYXMgY29uc3Q7XG5cbi8qKiBEaXJlY3RvcmllcyBza2lwcGVkIGR1cmluZyBib3VuZGVkIHJlY3Vyc2l2ZSBwcm9qZWN0IHNjYW5zLiAqL1xuY29uc3QgUkVDVVJTSVZFX1NDQU5fSUdOT1JFRF9ESVJTID0gbmV3IFNldChbXG4gIFwiLmdpdFwiLFxuICBcIi5nc2RcIixcbiAgXCIuYmctc2hlbGxcIixcbiAgXCIucGxhbm5pbmdcIixcbiAgXCIucGxhbnNcIixcbiAgXCIuY2xhdWRlXCIsXG4gIFwiLmN1cnNvclwiLFxuICBcIi52c2NvZGVcIixcbiAgXCJub2RlX21vZHVsZXNcIixcbiAgXCIudmVudlwiLFxuICBcInZlbnZcIixcbiAgXCJkaXN0XCIsXG4gIFwiYnVpbGRcIixcbiAgXCJjb3ZlcmFnZVwiLFxuICBcIi5uZXh0XCIsXG4gIFwiLm51eHRcIixcbiAgXCJ0YXJnZXRcIixcbiAgXCJ2ZW5kb3JcIixcbiAgXCIudHVyYm9cIixcbiAgXCJQb2RzXCIsXG4gIFwiYmluXCIsXG4gIFwib2JqXCIsXG4gIFwiLmdyYWRsZVwiLFxuICBcIkRlcml2ZWREYXRhXCIsXG4gIFwib3V0XCIsXG5dKSBhcyBSZWFkb25seVNldDxzdHJpbmc+O1xuXG5jb25zdCBQUk9KRUNUX0NPTlRFTlRfRVhDTFVERV9ESVJTID0gUkVDVVJTSVZFX1NDQU5fSUdOT1JFRF9ESVJTO1xuXG4vKiogUHJvamVjdCBmaWxlIG1hcmtlcnMgc2FmZSB0byBkZXRlY3QgcmVjdXJzaXZlbHkgdmlhIHN1ZmZpeCBtYXRjaGluZy4gKi9cbmNvbnN0IFJPT1RfT05MWV9QUk9KRUNUX0ZJTEVTID0gbmV3IFNldDxzdHJpbmc+KFtcbiAgXCIuZ2l0aHViL3dvcmtmbG93c1wiLFxuICBcInBhY2thZ2UuanNvblwiLFxuICBcIkdlbWZpbGVcIixcbiAgXCJNYWtlZmlsZVwiLFxuICBcIkNNYWtlTGlzdHMudHh0XCIsXG4gIFwiYnVpbGQuZ3JhZGxlXCIsXG4gIFwiYnVpbGQuZ3JhZGxlLmt0c1wiLFxuICBcImRlbm8uanNvblwiLFxuICBcImRlbm8uanNvbmNcIixcbl0pO1xuXG5jb25zdCBNQVhfUkVDVVJTSVZFX1NDQU5fRklMRVMgPSAyMDAwO1xuY29uc3QgTUFYX1JFQ1VSU0lWRV9TQ0FOX0RFUFRIID0gNjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvcmUgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIERldGVjdCB0aGUgZnVsbCBwcm9qZWN0IHN0YXRlIGZvciBhIGdpdmVuIGRpcmVjdG9yeS5cbiAqIFRoaXMgaXMgdGhlIG1haW4gZW50cnkgcG9pbnQgXHUyMDE0IGNhbGxzIGFsbCBzdWItZGV0ZWN0b3JzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0UHJvamVjdFN0YXRlKGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9qZWN0RGV0ZWN0aW9uIHtcbiAgY29uc3QgdjEgPSBkZXRlY3RWMVBsYW5uaW5nKGJhc2VQYXRoKTtcbiAgY29uc3QgdjIgPSBkZXRlY3RWMkdzZChiYXNlUGF0aCk7XG4gIGNvbnN0IHByb2plY3RTaWduYWxzID0gZGV0ZWN0UHJvamVjdFNpZ25hbHMoYmFzZVBhdGgpO1xuICBjb25zdCBnbG9iYWxTZXR1cCA9IGhhc0dsb2JhbFNldHVwKCk7XG4gIGNvbnN0IGZpcnN0RXZlciA9IGlzRmlyc3RFdmVyTGF1bmNoKCk7XG5cbiAgbGV0IHN0YXRlOiBQcm9qZWN0RGV0ZWN0aW9uW1wic3RhdGVcIl07XG4gIGlmICh2MiAmJiB2Mi5taWxlc3RvbmVDb3VudCA+IDApIHtcbiAgICBzdGF0ZSA9IFwidjItZ3NkXCI7XG4gIH0gZWxzZSBpZiAodjIgJiYgdjIubWlsZXN0b25lQ291bnQgPT09IDApIHtcbiAgICBzdGF0ZSA9IFwidjItZ3NkLWVtcHR5XCI7XG4gIH0gZWxzZSBpZiAodjEpIHtcbiAgICBzdGF0ZSA9IFwidjEtcGxhbm5pbmdcIjtcbiAgfSBlbHNlIHtcbiAgICBzdGF0ZSA9IFwibm9uZVwiO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0ZSxcbiAgICBpc0ZpcnN0RXZlckxhdW5jaDogZmlyc3RFdmVyLFxuICAgIGhhc0dsb2JhbFNldHVwOiBnbG9iYWxTZXR1cCxcbiAgICB2MTogdjEgPz8gdW5kZWZpbmVkLFxuICAgIHYyOiB2MiA/PyB1bmRlZmluZWQsXG4gICAgcHJvamVjdFNpZ25hbHMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBWMSBQbGFubmluZyBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRGV0ZWN0IGEgdjEgLnBsYW5uaW5nLyBkaXJlY3Rvcnkgd2l0aCBHU0QgdjEgbWFya2Vycy5cbiAqIFJldHVybnMgbnVsbCBpZiBubyAucGxhbm5pbmcvIGRpcmVjdG9yeSBmb3VuZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFYxUGxhbm5pbmcoYmFzZVBhdGg6IHN0cmluZyk6IFYxRGV0ZWN0aW9uIHwgbnVsbCB7XG4gIGNvbnN0IHBsYW5uaW5nUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLnBsYW5uaW5nXCIpO1xuXG4gIGlmICghZXhpc3RzU3luYyhwbGFubmluZ1BhdGgpKSByZXR1cm4gbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBzdGF0U3luYyhwbGFubmluZ1BhdGgpO1xuICAgIGlmICghc3RhdC5pc0RpcmVjdG9yeSgpKSByZXR1cm4gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCBoYXNSb2FkbWFwID0gZXhpc3RzU3luYyhqb2luKHBsYW5uaW5nUGF0aCwgXCJST0FETUFQLm1kXCIpKTtcbiAgY29uc3QgcGhhc2VzUGF0aCA9IGpvaW4ocGxhbm5pbmdQYXRoLCBcInBoYXNlc1wiKTtcbiAgY29uc3QgaGFzUGhhc2VzRGlyID0gZXhpc3RzU3luYyhwaGFzZXNQYXRoKTtcblxuICBsZXQgcGhhc2VDb3VudCA9IDA7XG4gIGlmIChoYXNQaGFzZXNEaXIpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKHBoYXNlc1BhdGgsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICAgIHBoYXNlQ291bnQgPSBlbnRyaWVzLmZpbHRlcihlID0+IGUuaXNEaXJlY3RvcnkoKSkubGVuZ3RoO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gdW5yZWFkYWJsZSBcdTIwMTQgcmVwb3J0IDBcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHBhdGg6IHBsYW5uaW5nUGF0aCxcbiAgICBoYXNQaGFzZXNEaXIsXG4gICAgaGFzUm9hZG1hcCxcbiAgICBwaGFzZUNvdW50LFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVjIgR1NEIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZGV0ZWN0VjJHc2QoYmFzZVBhdGg6IHN0cmluZyk6IFYyRGV0ZWN0aW9uIHwgbnVsbCB7XG4gIGNvbnN0IGdzZFBhdGggPSBnc2RSb290KGJhc2VQYXRoKTtcblxuICBpZiAoIWV4aXN0c1N5bmMoZ3NkUGF0aCkpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGhhc1ByZWZlcmVuY2VzID1cbiAgICBleGlzdHNTeW5jKGpvaW4oZ3NkUGF0aCwgXCJQUkVGRVJFTkNFUy5tZFwiKSkgfHxcbiAgICBleGlzdHNTeW5jKGpvaW4oZ3NkUGF0aCwgXCJwcmVmZXJlbmNlcy5tZFwiKSk7XG5cbiAgY29uc3QgaGFzQ29udGV4dCA9IGV4aXN0c1N5bmMoam9pbihnc2RQYXRoLCBcIkNPTlRFWFQubWRcIikpO1xuXG4gIGxldCBtaWxlc3RvbmVDb3VudCA9IDA7XG4gIGNvbnN0IG1pbGVzdG9uZXNQYXRoID0gam9pbihnc2RQYXRoLCBcIm1pbGVzdG9uZXNcIik7XG4gIGlmIChleGlzdHNTeW5jKG1pbGVzdG9uZXNQYXRoKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMobWlsZXN0b25lc1BhdGgsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICAgIG1pbGVzdG9uZUNvdW50ID0gZW50cmllcy5maWx0ZXIoZSA9PiBlLmlzRGlyZWN0b3J5KCkpLmxlbmd0aDtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIHVucmVhZGFibGUgXHUyMDE0IHJlcG9ydCAwXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgbWlsZXN0b25lQ291bnQsIGhhc1ByZWZlcmVuY2VzLCBoYXNDb250ZXh0IH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcm9qZWN0IFNpZ25hbHMgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFF1aWNrIGZpbGVzeXN0ZW0gc2NhbiBmb3IgcHJvamVjdCBlY29zeXN0ZW0gbWFya2Vycy5cbiAqIFJlYWRzIG9ubHkgZmlsZSBleGlzdGVuY2UgKyBtaW5pbWFsIGNvbnRlbnQgKHBhY2thZ2UuanNvbiBmb3IgbW9ub3JlcG8vc2NyaXB0cykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXRlY3RQcm9qZWN0U2lnbmFscyhiYXNlUGF0aDogc3RyaW5nKTogUHJvamVjdFNpZ25hbHMge1xuICBjb25zdCBkZXRlY3RlZEZpbGVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgcHJpbWFyeUxhbmd1YWdlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgLy8gRGV0ZWN0IHByb2plY3QgZmlsZXNcbiAgZm9yIChjb25zdCBmaWxlIG9mIFBST0pFQ1RfRklMRVMpIHtcbiAgICBpZiAoZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBmaWxlKSkpIHtcbiAgICAgIGRldGVjdGVkRmlsZXMucHVzaChmaWxlKTtcbiAgICAgIGlmICghcHJpbWFyeUxhbmd1YWdlKSB7XG4gICAgICAgIHByaW1hcnlMYW5ndWFnZSA9IExBTkdVQUdFX01BUFtmaWxlXTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBCb3VuZGVkIHJlY3Vyc2l2ZSBzY2FuIGZvciBuZXN0ZWQgbWFya2VycyBhbmQgZGVwZW5kZW5jeSBmaWxlcy5cbiAgLy8gVGhpcyBjb3ZlcnMgY29tbW9uIGJyb3duZmllbGQgbGF5b3V0cyBsaWtlIHNyYy9BcHAvQXBwLmNzcHJvaixcbiAgLy8gZGIvbWlncmF0aW9ucy8qLnNxbCwgc3JjL2NvbXBvbmVudHMvKi52dWUsIGFuZCBzZXJ2aWNlcy9hcGkvcHlwcm9qZWN0LnRvbWxcbiAgLy8gd2l0aG91dCB3YWxraW5nIHRoZSBlbnRpcmUgcmVwbyBvciBkaXZpbmcgaW50byBoZWF2eXdlaWdodCBmb2xkZXJzLlxuICBjb25zdCBzY2FubmVkRmlsZXMgPSBzY2FuUHJvamVjdEZpbGVzKGJhc2VQYXRoKTtcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgUFJPSkVDVF9GSUxFUykge1xuICAgIGlmIChkZXRlY3RlZEZpbGVzLmluY2x1ZGVzKGZpbGUpIHx8IFJPT1RfT05MWV9QUk9KRUNUX0ZJTEVTLmhhcyhmaWxlKSkgY29udGludWU7XG4gICAgY29uc3QgaGFzTWF0Y2ggPSBmaWxlID09PSBcInJlcXVpcmVtZW50cy50eHRcIlxuICAgICAgPyBzY2FubmVkRmlsZXMuc29tZShpc1B5dGhvblJlcXVpcmVtZW50c0ZpbGUpXG4gICAgICA6IHNjYW5uZWRGaWxlcy5zb21lKChzY2FubmVkRmlsZSkgPT4gbWF0Y2hlc1Byb2plY3RGaWxlTWFya2VyKHNjYW5uZWRGaWxlLCBmaWxlKSk7XG4gICAgaWYgKGhhc01hdGNoKSB7XG4gICAgICBwdXNoVW5pcXVlKGRldGVjdGVkRmlsZXMsIGZpbGUpO1xuICAgICAgaWYgKCFwcmltYXJ5TGFuZ3VhZ2UgJiYgTEFOR1VBR0VfTUFQW2ZpbGVdKSB7XG4gICAgICAgIHByaW1hcnlMYW5ndWFnZSA9IExBTkdVQUdFX01BUFtmaWxlXTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAoc2Nhbm5lZEZpbGVzLnNvbWUoKGZpbGUpID0+IFNRTElURV9FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gZmlsZS5lbmRzV2l0aChleHQpKSkpIHtcbiAgICBwdXNoVW5pcXVlKGRldGVjdGVkRmlsZXMsIFwiKi5zcWxpdGVcIik7XG4gIH1cbiAgaWYgKHNjYW5uZWRGaWxlcy5zb21lKChmaWxlKSA9PiBTUUxfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGZpbGUuZW5kc1dpdGgoZXh0KSkpKSB7XG4gICAgcHVzaFVuaXF1ZShkZXRlY3RlZEZpbGVzLCBcIiouc3FsXCIpO1xuICB9XG5cbiAgY29uc3QgaGFzQ3Nwcm9qID0gc2Nhbm5lZEZpbGVzLnNvbWUoKGZpbGUpID0+IGZpbGUuZW5kc1dpdGgoXCIuY3Nwcm9qXCIpKTtcbiAgY29uc3QgaGFzRnNwcm9qID0gc2Nhbm5lZEZpbGVzLnNvbWUoKGZpbGUpID0+IGZpbGUuZW5kc1dpdGgoXCIuZnNwcm9qXCIpKTtcbiAgY29uc3QgaGFzU2xuID0gc2Nhbm5lZEZpbGVzLnNvbWUoKGZpbGUpID0+IGZpbGUuZW5kc1dpdGgoXCIuc2xuXCIpKTtcblxuICBpZiAoaGFzQ3Nwcm9qKSB7XG4gICAgcHVzaFVuaXF1ZShkZXRlY3RlZEZpbGVzLCBcIiouY3Nwcm9qXCIpO1xuICAgIGlmICghcHJpbWFyeUxhbmd1YWdlKSBwcmltYXJ5TGFuZ3VhZ2UgPSBcImNzaGFycFwiO1xuICB9XG4gIGlmIChoYXNGc3Byb2opIHtcbiAgICBwdXNoVW5pcXVlKGRldGVjdGVkRmlsZXMsIFwiKi5mc3Byb2pcIik7XG4gICAgaWYgKCFwcmltYXJ5TGFuZ3VhZ2UpIHByaW1hcnlMYW5ndWFnZSA9IFwiZnNoYXJwXCI7XG4gIH1cbiAgaWYgKGhhc1Nsbikge1xuICAgIHB1c2hVbmlxdWUoZGV0ZWN0ZWRGaWxlcywgXCIqLnNsblwiKTtcbiAgICBpZiAoIXByaW1hcnlMYW5ndWFnZSkgcHJpbWFyeUxhbmd1YWdlID0gXCJkb3RuZXRcIjtcbiAgfVxuXG4gIGlmIChzY2FubmVkRmlsZXMuc29tZSgoZmlsZSkgPT4gVlVFX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBmaWxlLmVuZHNXaXRoKGV4dCkpKSkge1xuICAgIHB1c2hVbmlxdWUoZGV0ZWN0ZWRGaWxlcywgXCIqLnZ1ZVwiKTtcbiAgfVxuXG4gIC8vIFB5dGhvbiBmcmFtZXdvcmsgZGV0ZWN0aW9uIFx1MjAxNCBzY2FuIGRlcGVuZGVuY3kgZmlsZXMgZm9yIGZyYW1ld29yay1zcGVjaWZpYyBwYWNrYWdlcy5cbiAgLy8gQWRkcyBzeW50aGV0aWMgbWFya2VycyAoZS5nLiBcImRlcDpmYXN0YXBpXCIpIHNvIHNraWxsIGNhdGFsb2cgbWF0Y2hGaWxlcyBjYW4gcmVmZXJlbmNlIHRoZW0uXG4gIGNvbnN0IGRlcGVuZGVuY3lGaWxlcyA9IHNjYW5uZWRGaWxlcy5maWx0ZXIoKGZpbGUpID0+XG4gICAgaXNQeXRob25SZXF1aXJlbWVudHNGaWxlKGZpbGUpIHx8IGZpbGUuZW5kc1dpdGgoXCJweXByb2plY3QudG9tbFwiKSxcbiAgKTtcbiAgaWYgKGNvbnRhaW5zRmFzdGFwaURlcGVuZGVuY3koYmFzZVBhdGgsIGRlcGVuZGVuY3lGaWxlcykpIHtcbiAgICBwdXNoVW5pcXVlKGRldGVjdGVkRmlsZXMsIFwiZGVwOmZhc3RhcGlcIik7XG4gIH1cblxuICBjb25zdCBzcHJpbmdCb290QnVpbGRGaWxlcyA9IHNjYW5uZWRGaWxlcy5maWx0ZXIoKGZpbGUpID0+XG4gICAgZmlsZS5lbmRzV2l0aChcInBvbS54bWxcIikgfHwgZmlsZS5lbmRzV2l0aChcImJ1aWxkLmdyYWRsZVwiKSB8fCBmaWxlLmVuZHNXaXRoKFwiYnVpbGQuZ3JhZGxlLmt0c1wiKSxcbiAgKTtcbiAgY29uc3Qgc3ByaW5nQm9vdFZlcnNpb25DYXRhbG9ncyA9IHNjYW5uZWRGaWxlcy5maWx0ZXIoKGZpbGUpID0+IGZpbGUuZW5kc1dpdGgoXCIudmVyc2lvbnMudG9tbFwiKSk7XG4gIGNvbnN0IHNwcmluZ0Jvb3RTZXR0aW5nc0ZpbGVzID0gc2Nhbm5lZEZpbGVzLmZpbHRlcigoZmlsZSkgPT5cbiAgICBmaWxlLmVuZHNXaXRoKFwic2V0dGluZ3MuZ3JhZGxlXCIpIHx8IGZpbGUuZW5kc1dpdGgoXCJzZXR0aW5ncy5ncmFkbGUua3RzXCIpLFxuICApO1xuICBpZiAoY29udGFpbnNTcHJpbmdCb290TWFya2VyKGJhc2VQYXRoLCBzcHJpbmdCb290QnVpbGRGaWxlcywgc3ByaW5nQm9vdFZlcnNpb25DYXRhbG9ncywgc3ByaW5nQm9vdFNldHRpbmdzRmlsZXMpKSB7XG4gICAgcHVzaFVuaXF1ZShkZXRlY3RlZEZpbGVzLCBcImRlcDpzcHJpbmctYm9vdFwiKTtcbiAgICBpZiAoIXByaW1hcnlMYW5ndWFnZSkge1xuICAgICAgcHJpbWFyeUxhbmd1YWdlID0gXCJqYXZhL2tvdGxpblwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIEdpdCByZXBvIGRldGVjdGlvblxuICBjb25zdCBpc0dpdFJlcG8gPSBleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwiLmdpdFwiKSk7XG5cbiAgLy8gWGNvZGUgcGxhdGZvcm0gZGV0ZWN0aW9uIFx1MjAxNCBwYXJzZSBTREtST09UIGZyb20gcHJvamVjdC5wYnhwcm9qXG4gIGNvbnN0IHhjb2RlUGxhdGZvcm1zID0gZGV0ZWN0WGNvZGVQbGF0Zm9ybXMoYmFzZVBhdGgpO1xuXG4gIC8vIFNldCBwcmltYXJ5TGFuZ3VhZ2UgdG8gc3dpZnQgd2hlbiBhbiBYY29kZSBwcm9qZWN0IGlzIGZvdW5kIGJ1dCBub1xuICAvLyBQYWNrYWdlLnN3aWZ0IHdhcyBkZXRlY3RlZCAoQ29jb2FQb2RzIG9yIFNQTS1sZXNzIHByb2plY3RzKS5cbiAgaWYgKCFwcmltYXJ5TGFuZ3VhZ2UgJiYgeGNvZGVQbGF0Zm9ybXMubGVuZ3RoID4gMCkge1xuICAgIHByaW1hcnlMYW5ndWFnZSA9IFwic3dpZnRcIjtcbiAgfVxuXG4gIC8vIE1vbm9yZXBvIGRldGVjdGlvblxuICBsZXQgaXNNb25vcmVwbyA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IG1hcmtlciBvZiBNT05PUkVQT19NQVJLRVJTKSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgbWFya2VyKSkpIHtcbiAgICAgIGlzTW9ub3JlcG8gPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIC8vIEFsc28gY2hlY2sgcGFja2FnZS5qc29uIHdvcmtzcGFjZXNcbiAgaWYgKCFpc01vbm9yZXBvICYmIGRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJwYWNrYWdlLmpzb25cIikpIHtcbiAgICBpc01vbm9yZXBvID0gcGFja2FnZUpzb25IYXNXb3Jrc3BhY2VzKGJhc2VQYXRoKTtcbiAgfVxuXG4gIC8vIENJIGRldGVjdGlvblxuICBsZXQgaGFzQ0kgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBtYXJrZXIgb2YgQ0lfTUFSS0VSUykge1xuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIG1hcmtlcikpKSB7XG4gICAgICBoYXNDSSA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICAvLyBUZXN0IGRldGVjdGlvblxuICBsZXQgaGFzVGVzdHMgPSBmYWxzZTtcbiAgZm9yIChjb25zdCBtYXJrZXIgb2YgVEVTVF9NQVJLRVJTKSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgbWFya2VyKSkpIHtcbiAgICAgIGhhc1Rlc3RzID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIC8vIFBhY2thZ2UgbWFuYWdlciBkZXRlY3Rpb25cbiAgY29uc3QgcGFja2FnZU1hbmFnZXIgPSBkZXRlY3RQYWNrYWdlTWFuYWdlcihiYXNlUGF0aCk7XG5cbiAgLy8gVmVyaWZpY2F0aW9uIGNvbW1hbmRzXG4gIGNvbnN0IHZlcmlmaWNhdGlvbkNvbW1hbmRzID0gZGV0ZWN0VmVyaWZpY2F0aW9uQ29tbWFuZHMoYmFzZVBhdGgsIGRldGVjdGVkRmlsZXMsIHBhY2thZ2VNYW5hZ2VyKTtcblxuICByZXR1cm4ge1xuICAgIGRldGVjdGVkRmlsZXMsXG4gICAgaXNHaXRSZXBvLFxuICAgIGlzTW9ub3JlcG8sXG4gICAgcHJpbWFyeUxhbmd1YWdlLFxuICAgIHhjb2RlUGxhdGZvcm1zLFxuICAgIGhhc0NJLFxuICAgIGhhc1Rlc3RzLFxuICAgIHBhY2thZ2VNYW5hZ2VyLFxuICAgIHZlcmlmaWNhdGlvbkNvbW1hbmRzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVHaXRQYXRoKGZpbGU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBmaWxlLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKS5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIik7XG59XG5cbmZ1bmN0aW9uIGlzUHJvamVjdENvbnRlbnRGaWxlKGZpbGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplR2l0UGF0aChmaWxlKTtcbiAgaWYgKCFub3JtYWxpemVkIHx8IG5vcm1hbGl6ZWQuZW5kc1dpdGgoXCIvXCIpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChub3JtYWxpemVkID09PSBcIi5naXRpZ25vcmVcIiB8fCBub3JtYWxpemVkID09PSBcIi5naXRhdHRyaWJ1dGVzXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgcGFydHMgPSBub3JtYWxpemVkLnNwbGl0KFwiL1wiKTtcbiAgaWYgKHBhcnRzLnNvbWUoKHBhcnQpID0+IFBST0pFQ1RfQ09OVEVOVF9FWENMVURFX0RJUlMuaGFzKHBhcnQpKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAobm9ybWFsaXplZC5lbmRzV2l0aChcIi5EU19TdG9yZVwiKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gcnVuR2l0TGluZXMoYmFzZVBhdGg6IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0cHV0ID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSkudHJpbSgpO1xuICAgIHJldHVybiBvdXRwdXQgPyBvdXRwdXQuc3BsaXQoXCJcXG5cIikubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pIDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG5mdW5jdGlvbiBsaXN0VHJhY2tlZFByb2plY3RGaWxlcyhiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gcnVuR2l0TGluZXMoYmFzZVBhdGgsIFtcImxzLWZpbGVzXCJdKVxuICAgIC5tYXAobm9ybWFsaXplR2l0UGF0aClcbiAgICAuZmlsdGVyKGlzUHJvamVjdENvbnRlbnRGaWxlKTtcbn1cblxuZnVuY3Rpb24gbGlzdFVudHJhY2tlZFByb2plY3RGaWxlcyhiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gcnVuR2l0TGluZXMoYmFzZVBhdGgsIFtcImxzLWZpbGVzXCIsIFwiLS1vdGhlcnNcIiwgXCItLWV4Y2x1ZGUtc3RhbmRhcmRcIl0pXG4gICAgLm1hcChub3JtYWxpemVHaXRQYXRoKVxuICAgIC5maWx0ZXIoaXNQcm9qZWN0Q29udGVudEZpbGUpO1xufVxuXG5mdW5jdGlvbiBoYXNLbm93blByb2plY3RNYXJrZXJzKGJhc2VQYXRoOiBzdHJpbmcsIHNpZ25hbHM6IFByb2plY3RTaWduYWxzKTogYm9vbGVhbiB7XG4gIGlmIChzaWduYWxzLmRldGVjdGVkRmlsZXMubGVuZ3RoID4gMCkgcmV0dXJuIHRydWU7XG4gIGlmIChzaWduYWxzLnhjb2RlUGxhdGZvcm1zLmxlbmd0aCA+IDApIHJldHVybiB0cnVlO1xuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgcmVwbyBwcmVzZW5jZSBzZXBhcmF0ZWx5IGZyb20gZWNvc3lzdGVtL3Rvb2xpbmcgbWFya2Vycy5cbiAqXG4gKiBLbm93biBwcm9qZWN0IGZpbGVzIGlkZW50aWZ5IHRvb2xpbmcuIEdpdC10cmFja2VkL25vbi1pZ25vcmVkIGNvbnRlbnRcbiAqIGlkZW50aWZpZXMgd2hldGhlciB0aGlzIGlzIGFuIGV4aXN0aW5nIHByb2plY3QgYXQgYWxsLiBUaGlzIGtlZXBzIHNtYWxsXG4gKiBzdGF0aWMgb3IgZG9jdW1lbnRhdGlvbiByZXBvcyBmcm9tIGJlaW5nIG1pc2xhYmVsZWQgYXMgZ3JlZW5maWVsZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5UHJvamVjdChiYXNlUGF0aDogc3RyaW5nKTogUHJvamVjdENsYXNzaWZpY2F0aW9uIHtcbiAgY29uc3Qgc2lnbmFscyA9IGRldGVjdFByb2plY3RTaWduYWxzKGJhc2VQYXRoKTtcbiAgY29uc3QgbWFya2VycyA9IFsuLi5zaWduYWxzLmRldGVjdGVkRmlsZXNdO1xuXG4gIGlmICghc2lnbmFscy5pc0dpdFJlcG8pIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJpbnZhbGlkLXJlcG9cIixcbiAgICAgIHNpZ25hbHMsXG4gICAgICB0cmFja2VkRmlsZXM6IFtdLFxuICAgICAgdW50cmFja2VkRmlsZXM6IFtdLFxuICAgICAgY29udGVudEZpbGVzOiBbXSxcbiAgICAgIG1hcmtlcnMsXG4gICAgICByZWFzb246IFwibWlzc2luZyAuZ2l0XCIsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHRyYWNrZWRGaWxlcyA9IGxpc3RUcmFja2VkUHJvamVjdEZpbGVzKGJhc2VQYXRoKTtcbiAgY29uc3QgdW50cmFja2VkRmlsZXMgPSBsaXN0VW50cmFja2VkUHJvamVjdEZpbGVzKGJhc2VQYXRoKTtcbiAgY29uc3QgY29udGVudEZpbGVzID0gWy4uLm5ldyBTZXQoWy4uLnRyYWNrZWRGaWxlcywgLi4udW50cmFja2VkRmlsZXNdKV07XG4gIGNvbnN0IGhhc01hcmtlcnMgPSBoYXNLbm93blByb2plY3RNYXJrZXJzKGJhc2VQYXRoLCBzaWduYWxzKTtcblxuICBpZiAoaGFzTWFya2Vycykge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcInR5cGVkLWV4aXN0aW5nXCIsXG4gICAgICBzaWduYWxzLFxuICAgICAgdHJhY2tlZEZpbGVzLFxuICAgICAgdW50cmFja2VkRmlsZXMsXG4gICAgICBjb250ZW50RmlsZXMsXG4gICAgICBtYXJrZXJzLFxuICAgICAgcmVhc29uOiBtYXJrZXJzLmxlbmd0aCA+IDAgPyBgZGV0ZWN0ZWQgbWFya2VyczogJHttYXJrZXJzLmpvaW4oXCIsIFwiKX1gIDogXCJkZXRlY3RlZCBwcm9qZWN0IHN0cnVjdHVyZVwiLFxuICAgIH07XG4gIH1cblxuICBpZiAoY29udGVudEZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAga2luZDogXCJ1bnR5cGVkLWV4aXN0aW5nXCIsXG4gICAgICBzaWduYWxzLFxuICAgICAgdHJhY2tlZEZpbGVzLFxuICAgICAgdW50cmFja2VkRmlsZXMsXG4gICAgICBjb250ZW50RmlsZXMsXG4gICAgICBtYXJrZXJzLFxuICAgICAgcmVhc29uOiBcInByb2plY3QgY29udGVudCBleGlzdHMgYnV0IG5vIHJlY29nbml6ZWQgdG9vbGluZyBtYXJrZXJzIHdlcmUgZm91bmRcIixcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcImdyZWVuZmllbGRcIixcbiAgICBzaWduYWxzLFxuICAgIHRyYWNrZWRGaWxlcyxcbiAgICB1bnRyYWNrZWRGaWxlcyxcbiAgICBjb250ZW50RmlsZXMsXG4gICAgbWFya2VycyxcbiAgICByZWFzb246IFwibm8gdHJhY2tlZCBvciBub24taWdub3JlZCBwcm9qZWN0IGNvbnRlbnRcIixcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFhjb2RlIFBsYXRmb3JtIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIEtub3duIFNES1JPT1QgdmFsdWVzIFx1MjE5MiBjYW5vbmljYWwgcGxhdGZvcm0gbmFtZXMuICovXG5jb25zdCBTREtST09UX01BUDogUmVjb3JkPHN0cmluZywgWGNvZGVQbGF0Zm9ybT4gPSB7XG4gIGlwaG9uZW9zOiBcImlwaG9uZW9zXCIsXG4gIGlwaG9uZXNpbXVsYXRvcjogXCJpcGhvbmVvc1wiLCAgICAgIC8vIHNpbXVsYXRvciBidWlsZHMgc3RpbGwgdGFyZ2V0IGlPU1xuICBtYWNvc3g6IFwibWFjb3N4XCIsXG4gIHdhdGNob3M6IFwid2F0Y2hvc1wiLFxuICB3YXRjaHNpbXVsYXRvcjogXCJ3YXRjaG9zXCIsXG4gIGFwcGxldHZvczogXCJhcHBsZXR2b3NcIixcbiAgYXBwbGV0dnNpbXVsYXRvcjogXCJhcHBsZXR2b3NcIixcbiAgeHJvczogXCJ4cm9zXCIsXG4gIHhyc2ltdWxhdG9yOiBcInhyb3NcIixcbn07XG5cbi8qKiBSZWdleCBmb3IgU1VQUE9SVEVEX1BMQVRGT1JNUyBcdTIwMTQgZmFsbGJhY2sgd2hlbiBTREtST09UID0gYXV0byAoWGNvZGUgMTUrKS4gKi9cbmNvbnN0IFNVUFBPUlRFRF9QTEFURk9STVNfUkUgPSAvU1VQUE9SVEVEX1BMQVRGT1JNU1xccyo9XFxzKlwiKFteXCJdKylcIi9naTtcblxuLyoqIFJlYWQgYXQgbW9zdCBgbWF4Qnl0ZXNgIGZyb20gYSBmaWxlIHdpdGhvdXQgbG9hZGluZyB0aGUgZnVsbCBmaWxlIGludG8gbWVtb3J5LiAqL1xuZnVuY3Rpb24gcmVhZEJvdW5kZWQoZmlsZVBhdGg6IHN0cmluZywgbWF4Qnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyhtYXhCeXRlcyk7XG4gIGNvbnN0IGZkID0gb3BlblN5bmMoZmlsZVBhdGgsIFwiclwiKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBieXRlc1JlYWQgPSByZWFkU3luYyhmZCwgYnVmLCAwLCBtYXhCeXRlcywgMCk7XG4gICAgcmV0dXJuIGJ1Zi50b1N0cmluZyhcInV0Zi04XCIsIDAsIGJ5dGVzUmVhZCk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VTeW5jKGZkKTtcbiAgfVxufVxuXG4vKiogQ29tbW9uIHN1YmRpcmVjdG9yaWVzIHdoZXJlIC54Y29kZXByb2ogbWF5IGxpdmUgaW4gbW9ub3JlcG9zIC8gc3RhbmRhcmQgbGF5b3V0cy4gKi9cbmNvbnN0IFhDT0RFX1NVQkRJUlMgPSBbXCJpb3NcIiwgXCJtYWNvc1wiLCBcImFwcFwiLCBcImFwcHNcIl0gYXMgY29uc3Q7XG5cbi8qKlxuICogU2NhbiAqLnhjb2RlcHJvaiBkaXJlY3RvcmllcyBmb3IgcHJvamVjdC5wYnhwcm9qIGFuZCBleHRyYWN0IFNES1JPT1QgdmFsdWVzLlxuICogUmV0dXJucyBkZWR1cGxpY2F0ZWQsIGNhbm9uaWNhbCBwbGF0Zm9ybSBsaXN0IChlLmcuIFtcImlwaG9uZW9zXCJdKS5cbiAqXG4gKiBSZWFkaW5nIHRoZSBwYnhwcm9qIGlzIGEgbGlnaHR3ZWlnaHQgcmVnZXggc2NhbiBcdTIwMTQgbm8gZnVsbCBwbGlzdCBwYXJzaW5nIG5lZWRlZC5cbiAqIFdlIHJlYWQgYXQgbW9zdCAxIE1CIHBlciBmaWxlIHRvIGtlZXAgZGV0ZWN0aW9uIGZhc3QuXG4gKiBTZWFyY2hlcyBib3RoIHRoZSBwcm9qZWN0IHJvb3QgYW5kIGNvbW1vbiBzdWJkaXJlY3RvcmllcyAoaW9zLywgbWFjb3MvLCBhcHAvKS5cbiAqL1xuZnVuY3Rpb24gZGV0ZWN0WGNvZGVQbGF0Zm9ybXMoYmFzZVBhdGg6IHN0cmluZyk6IFhjb2RlUGxhdGZvcm1bXSB7XG4gIGNvbnN0IHBsYXRmb3JtcyA9IG5ldyBTZXQ8WGNvZGVQbGF0Zm9ybT4oKTtcblxuICAvLyBEaXJlY3RvcmllcyB0byBzY2FuOiBwcm9qZWN0IHJvb3QgKyBjb21tb24gc3ViZGlyc1xuICBjb25zdCBkaXJzVG9TY2FuID0gW2Jhc2VQYXRoXTtcbiAgZm9yIChjb25zdCBzdWIgb2YgWENPREVfU1VCRElSUykge1xuICAgIGNvbnN0IHN1YlBhdGggPSBqb2luKGJhc2VQYXRoLCBzdWIpO1xuICAgIGlmIChleGlzdHNTeW5jKHN1YlBhdGgpKSBkaXJzVG9TY2FuLnB1c2goc3ViUGF0aCk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGRpciBvZiBkaXJzVG9TY2FuKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICBpZiAoIWVudHJ5LmlzRGlyZWN0b3J5KCkgfHwgIWVudHJ5Lm5hbWUuZW5kc1dpdGgoXCIueGNvZGVwcm9qXCIpKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgcGJ4cHJvalBhdGggPSBqb2luKGRpciwgZW50cnkubmFtZSwgXCJwcm9qZWN0LnBieHByb2pcIik7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgY29udGVudCA9IHJlYWRCb3VuZGVkKHBieHByb2pQYXRoLCAxMDI0ICogMTAyNCk7XG4gICAgICAgICAgLy8gTWF0Y2ggU0RLUk9PVCA9IDx2YWx1ZT47IFx1MjAxNCBib3RoIHF1b3RlZCBhbmQgdW5xdW90ZWQgZm9ybXNcbiAgICAgICAgICBjb25zdCBzZGtSZSA9IC9TREtST09UXFxzKj1cXHMqXCI/KFthLXpdKylcIj9cXHMqOy9naTtcbiAgICAgICAgICBsZXQgbTogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgICAgICAgICBsZXQgZm91bmRFeHBsaWNpdCA9IGZhbHNlO1xuICAgICAgICAgIHdoaWxlICgobSA9IHNka1JlLmV4ZWMoY29udGVudCkpICE9PSBudWxsKSB7XG4gICAgICAgICAgICBjb25zdCB2YWwgPSBtWzFdLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgICBpZiAodmFsID09PSBcImF1dG9cIikgY29udGludWU7IC8vIGhhbmRsZWQgYmVsb3cgdmlhIFNVUFBPUlRFRF9QTEFURk9STVNcbiAgICAgICAgICAgIGNvbnN0IGNhbm9uaWNhbCA9IFNES1JPT1RfTUFQW3ZhbF07XG4gICAgICAgICAgICBpZiAoY2Fub25pY2FsKSB7XG4gICAgICAgICAgICAgIHBsYXRmb3Jtcy5hZGQoY2Fub25pY2FsKTtcbiAgICAgICAgICAgICAgZm91bmRFeHBsaWNpdCA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFhjb2RlIDE1KyBkZWZhdWx0cyBTREtST09UIHRvIFwiYXV0b1wiOyBmYWxsIGJhY2sgdG8gU1VQUE9SVEVEX1BMQVRGT1JNU1xuICAgICAgICAgIGlmICghZm91bmRFeHBsaWNpdCkge1xuICAgICAgICAgICAgbGV0IHNwOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgICAgICAgICAgd2hpbGUgKChzcCA9IFNVUFBPUlRFRF9QTEFURk9STVNfUkUuZXhlYyhjb250ZW50KSkgIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB0b2sgb2Ygc3BbMV0uc3BsaXQoL1xccysvKSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGNhbm9uaWNhbCA9IFNES1JPT1RfTUFQW3Rvay50b0xvd2VyQ2FzZSgpXTtcbiAgICAgICAgICAgICAgICBpZiAoY2Fub25pY2FsKSBwbGF0Zm9ybXMuYWRkKGNhbm9uaWNhbCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFNVUFBPUlRFRF9QTEFURk9STVNfUkUubGFzdEluZGV4ID0gMDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIHVucmVhZGFibGUgcGJ4cHJvaiBcdTIwMTQgc2tpcFxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyB1bnJlYWRhYmxlIGRpcmVjdG9yeVxuICAgIH1cbiAgfVxuICByZXR1cm4gWy4uLnBsYXRmb3Jtc107XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYWNrYWdlIE1hbmFnZXIgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBkZXRlY3RQYWNrYWdlTWFuYWdlcihiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgXCJwbnBtLWxvY2sueWFtbFwiKSkpIHJldHVybiBcInBucG1cIjtcbiAgaWYgKGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgXCJ5YXJuLmxvY2tcIikpKSByZXR1cm4gXCJ5YXJuXCI7XG4gIGlmIChleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwiYnVuLmxvY2tiXCIpKSB8fCBleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwiYnVuLmxvY2tcIikpKSByZXR1cm4gXCJidW5cIjtcbiAgaWYgKGV4aXN0c1N5bmMoam9pbihiYXNlUGF0aCwgXCJwYWNrYWdlLWxvY2suanNvblwiKSkpIHJldHVybiBcIm5wbVwiO1xuICBpZiAoZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcInBhY2thZ2UuanNvblwiKSkpIHJldHVybiBcIm5wbVwiO1xuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVmVyaWZpY2F0aW9uIENvbW1hbmQgRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEF1dG8tZGV0ZWN0IHZlcmlmaWNhdGlvbiBjb21tYW5kcyBmcm9tIHByb2plY3QgZmlsZXMuXG4gKiBSZXR1cm5zIGNvbW1hbmRzIGluIHByaW9yaXR5IG9yZGVyICh0ZXN0IGZpcnN0LCB0aGVuIGJ1aWxkLCB0aGVuIGxpbnQpLlxuICovXG5mdW5jdGlvbiBkZXRlY3RWZXJpZmljYXRpb25Db21tYW5kcyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgZGV0ZWN0ZWRGaWxlczogc3RyaW5nW10sXG4gIHBhY2thZ2VNYW5hZ2VyPzogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCBjb21tYW5kczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcG0gPSBwYWNrYWdlTWFuYWdlciA/PyBcIm5wbVwiO1xuICBjb25zdCBydW4gPSBwbSA9PT0gXCJucG1cIiA/IFwibnBtIHJ1blwiIDogcG0gPT09IFwieWFyblwiID8gXCJ5YXJuXCIgOiBwbSA9PT0gXCJidW5cIiA/IFwiYnVuIHJ1blwiIDogYCR7cG19IHJ1bmA7XG5cbiAgaWYgKGRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJwYWNrYWdlLmpzb25cIikpIHtcbiAgICBjb25zdCBzY3JpcHRzID0gcmVhZFBhY2thZ2VKc29uU2NyaXB0cyhiYXNlUGF0aCk7XG4gICAgaWYgKHNjcmlwdHMpIHtcbiAgICAgIC8vIFRlc3QgY29tbWFuZHMgKGhpZ2hlc3QgcHJpb3JpdHkpXG4gICAgICBpZiAoc2NyaXB0cy50ZXN0ICYmIHNjcmlwdHMudGVzdCAhPT0gXCJlY2hvIFxcXCJFcnJvcjogbm8gdGVzdCBzcGVjaWZpZWRcXFwiICYmIGV4aXQgMVwiKSB7XG4gICAgICAgIGNvbW1hbmRzLnB1c2gocG0gPT09IFwibnBtXCIgPyBcIm5wbSB0ZXN0XCIgOiBgJHtwbX0gdGVzdGApO1xuICAgICAgfVxuICAgICAgLy8gQnVpbGQgY29tbWFuZHNcbiAgICAgIGlmIChzY3JpcHRzLmJ1aWxkKSB7XG4gICAgICAgIGNvbW1hbmRzLnB1c2goYCR7cnVufSBidWlsZGApO1xuICAgICAgfVxuICAgICAgLy8gTGludCBjb21tYW5kc1xuICAgICAgaWYgKHNjcmlwdHMubGludCkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKGAke3J1bn0gbGludGApO1xuICAgICAgfVxuICAgICAgLy8gVHlwZWNoZWNrIGNvbW1hbmRzXG4gICAgICBpZiAoc2NyaXB0cy50eXBlY2hlY2spIHtcbiAgICAgICAgY29tbWFuZHMucHVzaChgJHtydW59IHR5cGVjaGVja2ApO1xuICAgICAgfSBlbHNlIGlmIChzY3JpcHRzLnRzYykge1xuICAgICAgICBjb21tYW5kcy5wdXNoKGAke3J1bn0gdHNjYCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKGRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJDYXJnby50b21sXCIpKSB7XG4gICAgY29tbWFuZHMucHVzaChcImNhcmdvIHRlc3RcIik7XG4gICAgY29tbWFuZHMucHVzaChcImNhcmdvIGNsaXBweVwiKTtcbiAgfVxuXG4gIGlmIChkZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiZ28ubW9kXCIpKSB7XG4gICAgY29tbWFuZHMucHVzaChcImdvIHRlc3QgLi8uLi5cIik7XG4gICAgY29tbWFuZHMucHVzaChcImdvIHZldCAuLy4uLlwiKTtcbiAgfVxuXG4gIGlmIChkZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwicHlwcm9qZWN0LnRvbWxcIikgfHwgZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcInNldHVwLnB5XCIpIHx8IGRldGVjdGVkRmlsZXMuaW5jbHVkZXMoXCJyZXF1aXJlbWVudHMudHh0XCIpKSB7XG4gICAgY29tbWFuZHMucHVzaChcInB5dGVzdFwiKTtcbiAgfVxuXG4gIGlmIChkZXRlY3RlZEZpbGVzLmluY2x1ZGVzKFwiR2VtZmlsZVwiKSkge1xuICAgIC8vIENoZWNrIGZvciByc3BlYyB2cyBtaW5pdGVzdFxuICAgIGlmIChleGlzdHNTeW5jKGpvaW4oYmFzZVBhdGgsIFwic3BlY1wiKSkpIHtcbiAgICAgIGNvbW1hbmRzLnB1c2goXCJidW5kbGUgZXhlYyByc3BlY1wiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29tbWFuZHMucHVzaChcImJ1bmRsZSBleGVjIHJha2UgdGVzdFwiKTtcbiAgICB9XG4gIH1cblxuICBpZiAoZGV0ZWN0ZWRGaWxlcy5pbmNsdWRlcyhcIk1ha2VmaWxlXCIpKSB7XG4gICAgY29uc3QgbWFrZVRhcmdldHMgPSByZWFkTWFrZWZpbGVUYXJnZXRzKGJhc2VQYXRoKTtcbiAgICBpZiAobWFrZVRhcmdldHMuaW5jbHVkZXMoXCJ0ZXN0XCIpKSB7XG4gICAgICBjb21tYW5kcy5wdXNoKFwibWFrZSB0ZXN0XCIpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBjb21tYW5kcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdsb2JhbCBTZXR1cCBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2hlY2sgaWYgZ2xvYmFsIEdTRCBzZXR1cCBleGlzdHMgKGhhcyB+Ly5nc2QvIHdpdGggcHJlZmVyZW5jZXMpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFzR2xvYmFsU2V0dXAoKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgZXhpc3RzU3luYyhqb2luKGdzZEhvbWUoKSwgXCJQUkVGRVJFTkNFUy5tZFwiKSkgfHxcbiAgICBleGlzdHNTeW5jKGpvaW4oZ3NkSG9tZSgpLCBcInByZWZlcmVuY2VzLm1kXCIpKVxuICApO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoaXMgaXMgdGhlIHZlcnkgZmlyc3QgdGltZSBHU0QgaGFzIGJlZW4gdXNlZCBvbiB0aGlzIG1hY2hpbmUuXG4gKiBSZXR1cm5zIHRydWUgaWYgfi8uZ3NkLyBkb2Vzbid0IGV4aXN0IG9yIGhhcyBubyBwcmVmZXJlbmNlcyBvciBhdXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNGaXJzdEV2ZXJMYXVuY2goKTogYm9vbGVhbiB7XG4gIGlmICghZXhpc3RzU3luYyhnc2RIb21lKCkpKSByZXR1cm4gdHJ1ZTtcblxuICAvLyBJZiB3ZSBoYXZlIHByZWZlcmVuY2VzLCBub3QgZmlyc3QgbGF1bmNoXG4gIGlmIChcbiAgICBleGlzdHNTeW5jKGpvaW4oZ3NkSG9tZSgpLCBcIlBSRUZFUkVOQ0VTLm1kXCIpKSB8fFxuICAgIGV4aXN0c1N5bmMoam9pbihnc2RIb21lKCksIFwicHJlZmVyZW5jZXMubWRcIikpXG4gICkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIElmIHdlIGhhdmUgYXV0aC5qc29uLCBub3QgZmlyc3QgbGF1bmNoIChvbmJvYXJkaW5nLnRzIGFscmVhZHkgcmFuKVxuICBpZiAoZXhpc3RzU3luYyhqb2luKGdzZEhvbWUoKSwgXCJhZ2VudFwiLCBcImF1dGguanNvblwiKSkpIHJldHVybiBmYWxzZTtcblxuICAvLyBDaGVjayBsZWdhY3kgcGF0aCB0b29cbiAgY29uc3QgbGVnYWN5UGF0aCA9IGpvaW4oaG9tZWRpcigpLCBcIi5waVwiLCBcImFnZW50XCIsIFwiZ3NkLXByZWZlcmVuY2VzLm1kXCIpO1xuICBpZiAoZXhpc3RzU3luYyhsZWdhY3lQYXRoKSkgcmV0dXJuIGZhbHNlO1xuXG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcGFja2FnZUpzb25IYXNXb3Jrc3BhY2VzKGJhc2VQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlUGF0aCwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHBrZy53b3Jrc3BhY2VzKSB8fCAocGtnLndvcmtzcGFjZXMgJiYgdHlwZW9mIHBrZy53b3Jrc3BhY2VzID09PSBcIm9iamVjdFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRQYWNrYWdlSnNvblNjcmlwdHMoYmFzZVBhdGg6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlUGF0aCwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpO1xuICAgIHJldHVybiBwa2cuc2NyaXB0cyAmJiB0eXBlb2YgcGtnLnNjcmlwdHMgPT09IFwib2JqZWN0XCIgPyBwa2cuc2NyaXB0cyA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRNYWtlZmlsZVRhcmdldHMoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlUGF0aCwgXCJNYWtlZmlsZVwiKSwgXCJ1dGYtOFwiKTtcbiAgICBjb25zdCB0YXJnZXRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvXihbYS16QS1aX11bYS16QS1aMC05Xy1dKik6Lyk7XG4gICAgICBpZiAobWF0Y2gpIHRhcmdldHMucHVzaChtYXRjaFsxXSk7XG4gICAgfVxuICAgIHJldHVybiB0YXJnZXRzO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuZnVuY3Rpb24gcHVzaFVuaXF1ZShhcnI6IHN0cmluZ1tdLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghYXJyLmluY2x1ZGVzKHZhbHVlKSkgYXJyLnB1c2godmFsdWUpO1xufVxuXG5mdW5jdGlvbiBtYXRjaGVzUHJvamVjdEZpbGVNYXJrZXIoc2Nhbm5lZEZpbGU6IHN0cmluZywgbWFya2VyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHNjYW5uZWRGaWxlLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKTtcbiAgcmV0dXJuIChcbiAgICBub3JtYWxpemVkID09PSBtYXJrZXIgfHxcbiAgICBub3JtYWxpemVkLmVuZHNXaXRoKGAvJHttYXJrZXJ9YClcbiAgKTtcbn1cblxuZnVuY3Rpb24gaXNQeXRob25SZXF1aXJlbWVudHNGaWxlKHJlbGF0aXZlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSByZWxhdGl2ZVBhdGgucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuICBjb25zdCBiYXNlbmFtZSA9IG5vcm1hbGl6ZWQuc2xpY2Uobm9ybWFsaXplZC5sYXN0SW5kZXhPZihcIi9cIikgKyAxKTtcbiAgcmV0dXJuIChcbiAgICBiYXNlbmFtZSA9PT0gXCJyZXF1aXJlbWVudHMudHh0XCIgfHxcbiAgICBiYXNlbmFtZSA9PT0gXCJyZXF1aXJlbWVudHMuaW5cIiB8fFxuICAgIC9ecmVxdWlyZW1lbnRzKFstLl0uKyk/XFwuKHR4dHxpbikkL2kudGVzdChiYXNlbmFtZSkgfHxcbiAgICAvKF58XFwvKXJlcXVpcmVtZW50c1xcLy4rXFwuKHR4dHxpbikkL2kudGVzdChub3JtYWxpemVkKVxuICApO1xufVxuXG5mdW5jdGlvbiBjb250YWluc0Zhc3RhcGlEZXBlbmRlbmN5KGJhc2VQYXRoOiBzdHJpbmcsIHJlbGF0aXZlUGF0aHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGZvciAoY29uc3QgcmVsYXRpdmVQYXRoIG9mIHJlbGF0aXZlUGF0aHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEJvdW5kZWQoam9pbihiYXNlUGF0aCwgcmVsYXRpdmVQYXRoKSwgNjQgKiAxMDI0KTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSBleHRyYWN0RGVwZW5kZW5jeUNvbnRlbnQocmVsYXRpdmVQYXRoLCByYXcpO1xuICAgICAgaWYgKGlzUHl0aG9uUmVxdWlyZW1lbnRzRmlsZShyZWxhdGl2ZVBhdGgpKSB7XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBjb250ZW50LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKGV4dHJhY3RSZXF1aXJlbWVudE5hbWUobGluZSkgPT09IFwiZmFzdGFwaVwiKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKHJlbGF0aXZlUGF0aC5lbmRzV2l0aChcInB5cHJvamVjdC50b21sXCIpKSB7XG4gICAgICAgIGlmIChjb250YWluc0Zhc3RhcGlJblB5cHJvamVjdChjb250ZW50KSkgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyB1bnJlYWRhYmxlIGZpbGUgXHUyMDE0IGNvbnRpbnVlIHNjYW5uaW5nIG90aGVyIGNhbmRpZGF0ZSBmaWxlc1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gY29udGFpbnNTcHJpbmdCb290TWFya2VyKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBidWlsZEZpbGVzOiBzdHJpbmdbXSxcbiAgdmVyc2lvbkNhdGFsb2dGaWxlczogc3RyaW5nW10sXG4gIHNldHRpbmdzRmlsZXM6IHN0cmluZ1tdLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHVzZWRQbHVnaW5BbGlhc2VzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHVzZWRMaWJyYXJ5QWxpYXNlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBjYXRhbG9nQWNjZXNzb3JzID0gcmVzb2x2ZVZlcnNpb25DYXRhbG9nQWNjZXNzb3JzKGJhc2VQYXRoLCB2ZXJzaW9uQ2F0YWxvZ0ZpbGVzLCBzZXR0aW5nc0ZpbGVzKTtcblxuICBmb3IgKGNvbnN0IHJlbGF0aXZlUGF0aCBvZiBidWlsZEZpbGVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJhdyA9IHJlYWRCb3VuZGVkKGpvaW4oYmFzZVBhdGgsIHJlbGF0aXZlUGF0aCksIDY0ICogMTAyNCk7XG4gICAgICBjb25zdCBjb250ZW50ID0gc3RyaXBEZXBlbmRlbmN5Q29tbWVudHMocmVsYXRpdmVQYXRoLCByYXcpO1xuICAgICAgaWYgKGNvbnRhaW5zRGlyZWN0U3ByaW5nQm9vdFJlZmVyZW5jZShyZWxhdGl2ZVBhdGgsIGNvbnRlbnQpKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBub3JtYWxpemVkID0gY29udGVudC50b0xvd2VyQ2FzZSgpO1xuICAgICAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgICAgZm9yIChjb25zdCBhY2Nlc3NvciBvZiBjYXRhbG9nQWNjZXNzb3JzKSB7XG4gICAgICAgIGNvbnN0IGFsaWFzUmUgPSBuZXcgUmVnRXhwKGBhbGlhc1xcXFwoXFxcXHMqJHthY2Nlc3Nvcn1cXFxcLnBsdWdpbnNcXFxcLihbYS16MC05Xy4tXSspXFxcXHMqXFxcXClgLCBcImdpXCIpO1xuICAgICAgICB3aGlsZSAoKG1hdGNoID0gYWxpYXNSZS5leGVjKG5vcm1hbGl6ZWQpKSAhPT0gbnVsbCkge1xuICAgICAgICAgIHVzZWRQbHVnaW5BbGlhc2VzLmFkZChub3JtYWxpemVQbHVnaW5BbGlhcyhtYXRjaFsxXSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbGlicmFyeUFsaWFzUmUgPSBuZXcgUmVnRXhwKGBcXFxcYiR7YWNjZXNzb3J9XFxcXC4oKD8hcGx1Z2luc1xcXFxiKVthLXowLTlfLi1dKylgLCBcImdpXCIpO1xuICAgICAgICB3aGlsZSAoKG1hdGNoID0gbGlicmFyeUFsaWFzUmUuZXhlYyhub3JtYWxpemVkKSkgIT09IG51bGwpIHtcbiAgICAgICAgICB1c2VkTGlicmFyeUFsaWFzZXMuYWRkKG5vcm1hbGl6ZVBsdWdpbkFsaWFzKG1hdGNoWzFdKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIHVucmVhZGFibGUgYnVpbGQgZmlsZSBcdTIwMTQgY29udGludWUgc2Nhbm5pbmcgb3RoZXJzXG4gICAgfVxuICB9XG5cbiAgaWYgKHVzZWRQbHVnaW5BbGlhc2VzLnNpemUgPT09IDAgJiYgdXNlZExpYnJhcnlBbGlhc2VzLnNpemUgPT09IDApIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKHZlcnNpb25DYXRhbG9nRmlsZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3Qgc3ByaW5nQm9vdEFsaWFzZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qgc3ByaW5nQm9vdExpYnJhcmllcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBwZW5kaW5nU3ByaW5nQm9vdEJ1bmRsZXM6IEFycmF5PHsgYnVuZGxlQWxpYXM6IHN0cmluZzsgcmVmZXJlbmNlZEFsaWFzZXM6IHN0cmluZ1tdIH0+ID0gW107XG4gIGZvciAoY29uc3QgcmVsYXRpdmVQYXRoIG9mIHZlcnNpb25DYXRhbG9nRmlsZXMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEJvdW5kZWQoam9pbihiYXNlUGF0aCwgcmVsYXRpdmVQYXRoKSwgNjQgKiAxMDI0KTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSBzdHJpcERlcGVuZGVuY3lDb21tZW50cyhyZWxhdGl2ZVBhdGgsIHJhdyk7XG4gICAgICBjb25zdCBhbGlhc1JlID0gL15cXHMqKFtBLVphLXowLTlfLi1dKylcXHMqPVxccypcXHtbXlxcbn1dKlxcYmlkXFxzKj1cXHMqW1wiJ11vcmdcXC5zcHJpbmdmcmFtZXdvcmtcXC5ib290W1wiJ11bXlxcbn1dKlxcfS9nbTtcbiAgICAgIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgICAgIHdoaWxlICgobWF0Y2ggPSBhbGlhc1JlLmV4ZWMoY29udGVudCkpICE9PSBudWxsKSB7XG4gICAgICAgIHNwcmluZ0Jvb3RBbGlhc2VzLmFkZChub3JtYWxpemVQbHVnaW5BbGlhcyhtYXRjaFsxXSkpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaWJyYXJ5UmUgPSAvXlxccyooW0EtWmEtejAtOV8uLV0rKVxccyo9XFxzKlxce1teXFxufV0qXFxiKG1vZHVsZVxccyo9XFxzKltcIiddb3JnXFwuc3ByaW5nZnJhbWV3b3JrXFwuYm9vdDpbXlwiJ10rW1wiJ118Z3JvdXBcXHMqPVxccypbXCInXW9yZ1xcLnNwcmluZ2ZyYW1ld29ya1xcLmJvb3RbXCInXVteXFxufV0qXFxibmFtZVxccyo9XFxzKltcIiddc3ByaW5nLWJvb3RbXlwiJ10qW1wiJ10pW15cXG59XSpcXH0vZ207XG4gICAgICB3aGlsZSAoKG1hdGNoID0gbGlicmFyeVJlLmV4ZWMoY29udGVudCkpICE9PSBudWxsKSB7XG4gICAgICAgIHNwcmluZ0Jvb3RMaWJyYXJpZXMuYWRkKG5vcm1hbGl6ZVBsdWdpbkFsaWFzKG1hdGNoWzFdKSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGJ1bmRsZVJlID0gL15cXHMqKFtBLVphLXowLTlfLi1dKylcXHMqPVxccypcXFsoW1xcc1xcU10qPylcXF0vZ207XG4gICAgICB3aGlsZSAoKG1hdGNoID0gYnVuZGxlUmUuZXhlYyhjb250ZW50KSkgIT09IG51bGwpIHtcbiAgICAgICAgcGVuZGluZ1NwcmluZ0Jvb3RCdW5kbGVzLnB1c2goe1xuICAgICAgICAgIGJ1bmRsZUFsaWFzOiBub3JtYWxpemVQbHVnaW5BbGlhcyhgYnVuZGxlcy4ke21hdGNoWzFdfWApLFxuICAgICAgICAgIHJlZmVyZW5jZWRBbGlhc2VzOiBtYXRjaFsyXVxuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgocGFydCkgPT4gbm9ybWFsaXplUGx1Z2luQWxpYXMocGFydC5yZXBsYWNlKC9bXCInXFxzXS9nLCBcIlwiKSkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIHVucmVhZGFibGUgdmVyc2lvbiBjYXRhbG9nIFx1MjAxNCBjb250aW51ZSBzY2FubmluZyBvdGhlcnNcbiAgICB9XG4gIH1cblxuICBjb25zdCBzcHJpbmdCb290QnVuZGxlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHBlbmRpbmdCdW5kbGUgb2YgcGVuZGluZ1NwcmluZ0Jvb3RCdW5kbGVzKSB7XG4gICAgaWYgKHBlbmRpbmdCdW5kbGUucmVmZXJlbmNlZEFsaWFzZXMuc29tZSgoYWxpYXMpID0+IHNwcmluZ0Jvb3RMaWJyYXJpZXMuaGFzKGFsaWFzKSkpIHtcbiAgICAgIHNwcmluZ0Jvb3RCdW5kbGVzLmFkZChwZW5kaW5nQnVuZGxlLmJ1bmRsZUFsaWFzKTtcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IGFsaWFzIG9mIHVzZWRQbHVnaW5BbGlhc2VzKSB7XG4gICAgaWYgKHNwcmluZ0Jvb3RBbGlhc2VzLmhhcyhhbGlhcykpIHJldHVybiB0cnVlO1xuICB9XG4gIGZvciAoY29uc3QgYWxpYXMgb2YgdXNlZExpYnJhcnlBbGlhc2VzKSB7XG4gICAgaWYgKHNwcmluZ0Jvb3RMaWJyYXJpZXMuaGFzKGFsaWFzKSB8fCBzcHJpbmdCb290QnVuZGxlcy5oYXMoYWxpYXMpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gc3RyaXBEZXBlbmRlbmN5Q29tbWVudHMocmVsYXRpdmVQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChyZWxhdGl2ZVBhdGguZW5kc1dpdGgoXCJyZXF1aXJlbWVudHMudHh0XCIpKSB7XG4gICAgcmV0dXJuIGNvbnRlbnQucmVwbGFjZSgvKF58XFxzKSMuKiQvZ20sIFwiXCIpO1xuICB9XG4gIGlmIChyZWxhdGl2ZVBhdGguZW5kc1dpdGgoXCJweXByb2plY3QudG9tbFwiKSkge1xuICAgIHJldHVybiBjb250ZW50LnJlcGxhY2UoLyhefFxccykjLiokL2dtLCBcIlwiKTtcbiAgfVxuICBpZiAocmVsYXRpdmVQYXRoLmVuZHNXaXRoKFwiLnZlcnNpb25zLnRvbWxcIikpIHtcbiAgICByZXR1cm4gY29udGVudC5yZXBsYWNlKC8oXnxcXHMpIy4qJC9nbSwgXCJcIik7XG4gIH1cbiAgaWYgKHJlbGF0aXZlUGF0aC5lbmRzV2l0aChcInNldHRpbmdzLmdyYWRsZVwiKSB8fCByZWxhdGl2ZVBhdGguZW5kc1dpdGgoXCJzZXR0aW5ncy5ncmFkbGUua3RzXCIpKSB7XG4gICAgcmV0dXJuIGNvbnRlbnRcbiAgICAgIC5yZXBsYWNlKC9cXC9cXCpbXFxzXFxTXSo/XFwqXFwvL2csIFwiXCIpXG4gICAgICAucmVwbGFjZSgvXFwvXFwvLiokL2dtLCBcIlwiKTtcbiAgfVxuICBpZiAocmVsYXRpdmVQYXRoLmVuZHNXaXRoKFwicG9tLnhtbFwiKSkge1xuICAgIHJldHVybiBjb250ZW50LnJlcGxhY2UoLzwhLS1bXFxzXFxTXSo/LS0+L2csIFwiXCIpO1xuICB9XG4gIGlmIChyZWxhdGl2ZVBhdGguZW5kc1dpdGgoXCJidWlsZC5ncmFkbGVcIikgfHwgcmVsYXRpdmVQYXRoLmVuZHNXaXRoKFwiYnVpbGQuZ3JhZGxlLmt0c1wiKSkge1xuICAgIHJldHVybiBjb250ZW50XG4gICAgICAucmVwbGFjZSgvXFwvXFwqW1xcc1xcU10qP1xcKlxcLy9nLCBcIlwiKVxuICAgICAgLnJlcGxhY2UoL1xcL1xcLy4qJC9nbSwgXCJcIik7XG4gIH1cbiAgcmV0dXJuIGNvbnRlbnQ7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3REZXBlbmRlbmN5Q29udGVudChyZWxhdGl2ZVBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgc3RyaXBwZWQgPSBzdHJpcERlcGVuZGVuY3lDb21tZW50cyhyZWxhdGl2ZVBhdGgsIGNvbnRlbnQpO1xuICBpZiAocmVsYXRpdmVQYXRoLmVuZHNXaXRoKFwicHlwcm9qZWN0LnRvbWxcIikpIHtcbiAgICByZXR1cm4gZXh0cmFjdFB5cHJvamVjdERlcGVuZGVuY3lTZWN0aW9ucyhzdHJpcHBlZCk7XG4gIH1cbiAgcmV0dXJuIHN0cmlwcGVkO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0UmVxdWlyZW1lbnROYW1lKHNwZWM6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCB0cmltbWVkID0gc3BlYy50cmltKCkucmVwbGFjZSgvXltcIiddfFtcIiddJC9nLCBcIlwiKTtcbiAgaWYgKCF0cmltbWVkKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBtYXRjaCA9IHRyaW1tZWQubWF0Y2goL14oW0EtWmEtejAtOV8uLV0rKSg/OlxcW1teXFxdXStcXF0pPyg/PVxccyooPzpAfFs8Pj0hfjtdfCQpKS8pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG5vcm1hbGl6ZVBhY2thZ2VOYW1lKG1hdGNoWzFdKTtcbn1cblxuZnVuY3Rpb24gY29udGFpbnNGYXN0YXBpSW5QeXByb2plY3QoY29udGVudDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGZvciAoY29uc3QgbGluZSBvZiBjb250ZW50LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgY29uc3Qga2V5TWF0Y2ggPSBsaW5lLm1hdGNoKC9eXFxzKihbQS1aYS16MC05Xy4tXSspXFxzKj0vKTtcbiAgICBpZiAoa2V5TWF0Y2gpIHtcbiAgICAgIGNvbnN0IGtleSA9IG5vcm1hbGl6ZVBhY2thZ2VOYW1lKGtleU1hdGNoWzFdKTtcbiAgICAgIGlmIChrZXkgPT09IFwiZmFzdGFwaVwiKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKGtleSAhPT0gXCJkZXBlbmRlbmNpZXNcIikge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBxdW90ZWRTcGVjUmUgPSAvW1wiJ10oW15cIiddKylbXCInXS9nO1xuICAgIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgICB3aGlsZSAoKG1hdGNoID0gcXVvdGVkU3BlY1JlLmV4ZWMobGluZSkpICE9PSBudWxsKSB7XG4gICAgICBpZiAoZXh0cmFjdFJlcXVpcmVtZW50TmFtZShtYXRjaFsxXSkgPT09IFwiZmFzdGFwaVwiKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gY29udGFpbnNEaXJlY3RTcHJpbmdCb290UmVmZXJlbmNlKHJlbGF0aXZlUGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKHJlbGF0aXZlUGF0aC5lbmRzV2l0aChcInBvbS54bWxcIikpIHtcbiAgICByZXR1cm4gLzxncm91cElkPlxccypvcmdcXC5zcHJpbmdmcmFtZXdvcmtcXC5ib290XFxzKjxcXC9ncm91cElkPi9pLnRlc3QoY29udGVudCk7XG4gIH1cblxuICBpZiAocmVsYXRpdmVQYXRoLmVuZHNXaXRoKFwiYnVpbGQuZ3JhZGxlXCIpIHx8IHJlbGF0aXZlUGF0aC5lbmRzV2l0aChcImJ1aWxkLmdyYWRsZS5rdHNcIikpIHtcbiAgICByZXR1cm4gLyhpZFxccypcXCg/XFxzKltcIiddb3JnXFwuc3ByaW5nZnJhbWV3b3JrXFwuYm9vdFtcIiddfGFwcGx5XFxzKlxcKD9cXHMqcGx1Z2luXFxzKls6PV1cXHMqW1wiJ11vcmdcXC5zcHJpbmdmcmFtZXdvcmtcXC5ib290W1wiJ118KD86aW1wbGVtZW50YXRpb258YXBpfGNvbXBpbGVPbmx5fHJ1bnRpbWVPbmx5fHRlc3RJbXBsZW1lbnRhdGlvbnxhbm5vdGF0aW9uUHJvY2Vzc29yfGthcHQpXFxzKlxcKD9cXHMqW1wiJ11bXlwiJ10qb3JnXFwuc3ByaW5nZnJhbWV3b3JrXFwuYm9vdDpbXlwiJ10qc3ByaW5nLWJvb3RbXlwiJ10qW1wiJ10pL2kudGVzdChjb250ZW50KTtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFB5cHJvamVjdERlcGVuZGVuY3lTZWN0aW9ucyhjb250ZW50OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGNvbGxlY3RlZDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IHNlY3Rpb24gPSBcIlwiO1xuICBsZXQgY29sbGVjdGluZ1Byb2plY3REZXBzID0gZmFsc2U7XG4gIGxldCBjb2xsZWN0aW5nT3B0aW9uYWxEZXBzID0gZmFsc2U7XG4gIGxldCBicmFja2V0RGVwdGggPSAwO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcblxuICAgIGlmIChjb2xsZWN0aW5nUHJvamVjdERlcHMpIHtcbiAgICAgIGNvbGxlY3RlZC5wdXNoKGxpbmUpO1xuICAgICAgYnJhY2tldERlcHRoICs9IGNvdW50Q2hhcihsaW5lLCBcIltcIikgLSBjb3VudENoYXIobGluZSwgXCJdXCIpO1xuICAgICAgaWYgKGJyYWNrZXREZXB0aCA8PSAwKSB7XG4gICAgICAgIGNvbGxlY3RpbmdQcm9qZWN0RGVwcyA9IGZhbHNlO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKGNvbGxlY3RpbmdPcHRpb25hbERlcHMpIHtcbiAgICAgIGNvbGxlY3RlZC5wdXNoKGxpbmUpO1xuICAgICAgYnJhY2tldERlcHRoICs9IGNvdW50Q2hhcihsaW5lLCBcIltcIikgLSBjb3VudENoYXIobGluZSwgXCJdXCIpO1xuICAgICAgaWYgKGJyYWNrZXREZXB0aCA8PSAwKSB7XG4gICAgICAgIGNvbGxlY3RpbmdPcHRpb25hbERlcHMgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHNlY3Rpb25NYXRjaCA9IHRyaW1tZWQubWF0Y2goL15cXFsoW15cXF1dKylcXF0kLyk7XG4gICAgaWYgKHNlY3Rpb25NYXRjaCkge1xuICAgICAgc2VjdGlvbiA9IHNlY3Rpb25NYXRjaFsxXS50cmltKCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoc2VjdGlvbiA9PT0gXCJwcm9qZWN0XCIgJiYgL15kZXBlbmRlbmNpZXNcXHMqPVxccypcXFsvLnRlc3QodHJpbW1lZCkpIHtcbiAgICAgIGNvbGxlY3RlZC5wdXNoKGxpbmUpO1xuICAgICAgYnJhY2tldERlcHRoID0gY291bnRDaGFyKGxpbmUsIFwiW1wiKSAtIGNvdW50Q2hhcihsaW5lLCBcIl1cIik7XG4gICAgICBjb2xsZWN0aW5nUHJvamVjdERlcHMgPSBicmFja2V0RGVwdGggPiAwO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKFxuICAgICAgc2VjdGlvbiA9PT0gXCJwcm9qZWN0Lm9wdGlvbmFsLWRlcGVuZGVuY2llc1wiIHx8XG4gICAgICBzZWN0aW9uID09PSBcInRvb2wucG9ldHJ5LmRlcGVuZGVuY2llc1wiXG4gICAgKSB7XG4gICAgICBpZiAoc2VjdGlvbiA9PT0gXCJwcm9qZWN0Lm9wdGlvbmFsLWRlcGVuZGVuY2llc1wiKSB7XG4gICAgICAgIGNvbnN0IGVxdWFsc0luZGV4ID0gbGluZS5pbmRleE9mKFwiPVwiKTtcbiAgICAgICAgaWYgKGVxdWFsc0luZGV4ICE9PSAtMSkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gbGluZS5zbGljZShlcXVhbHNJbmRleCArIDEpO1xuICAgICAgICAgIGNvbGxlY3RlZC5wdXNoKHZhbHVlKTtcbiAgICAgICAgICBicmFja2V0RGVwdGggPSBjb3VudENoYXIodmFsdWUsIFwiW1wiKSAtIGNvdW50Q2hhcih2YWx1ZSwgXCJdXCIpO1xuICAgICAgICAgIGNvbGxlY3RpbmdPcHRpb25hbERlcHMgPSBicmFja2V0RGVwdGggPiAwO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb2xsZWN0ZWQucHVzaChsaW5lKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gY29sbGVjdGVkLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIGNvdW50Q2hhcih0ZXh0OiBzdHJpbmcsIGNoYXI6IHN0cmluZyk6IG51bWJlciB7XG4gIHJldHVybiBbLi4udGV4dF0uZmlsdGVyKChjKSA9PiBjID09PSBjaGFyKS5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhY2thZ2VOYW1lKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBuYW1lLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW18uXS9nLCBcIi1cIik7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBsdWdpbkFsaWFzKGFsaWFzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYWxpYXMudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bLV9dL2csIFwiLlwiKTtcbn1cblxuZnVuY3Rpb24gdmVyc2lvbkNhdGFsb2dBY2Nlc3Nvck5hbWUocmVsYXRpdmVQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gcmVsYXRpdmVQYXRoLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKTtcbiAgY29uc3QgYmFzZW5hbWUgPSBub3JtYWxpemVkLnNsaWNlKG5vcm1hbGl6ZWQubGFzdEluZGV4T2YoXCIvXCIpICsgMSk7XG4gIHJldHVybiBiYXNlbmFtZS5yZXBsYWNlKC9cXC52ZXJzaW9uc1xcLnRvbWwkL2ksIFwiXCIpLnRvTG93ZXJDYXNlKCk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVWZXJzaW9uQ2F0YWxvZ0FjY2Vzc29ycyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdmVyc2lvbkNhdGFsb2dGaWxlczogc3RyaW5nW10sXG4gIHNldHRpbmdzRmlsZXM6IHN0cmluZ1tdLFxuKTogU2V0PHN0cmluZz4ge1xuICBjb25zdCBhY2Nlc3NvcnMgPSBuZXcgU2V0KHZlcnNpb25DYXRhbG9nRmlsZXMubWFwKHZlcnNpb25DYXRhbG9nQWNjZXNzb3JOYW1lKS5maWx0ZXIoQm9vbGVhbikpO1xuICBpZiAodmVyc2lvbkNhdGFsb2dGaWxlcy5sZW5ndGggPT09IDAgfHwgc2V0dGluZ3NGaWxlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gYWNjZXNzb3JzO1xuICB9XG5cbiAgZm9yIChjb25zdCBzZXR0aW5nc0ZpbGUgb2Ygc2V0dGluZ3NGaWxlcykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByYXcgPSByZWFkQm91bmRlZChqb2luKGJhc2VQYXRoLCBzZXR0aW5nc0ZpbGUpLCA2NCAqIDEwMjQpO1xuICAgICAgY29uc3QgY29udGVudCA9IHN0cmlwRGVwZW5kZW5jeUNvbW1lbnRzKHNldHRpbmdzRmlsZSwgcmF3KTtcbiAgICAgIGNvbnN0IGNyZWF0ZVJlID0gL2NyZWF0ZVxcKFxccypbXCInXShbQS1aYS16MC05X10rKVtcIiddXFxzKlxcKVxccypcXHtbXFxzXFxTXSo/KFtBLVphLXowLTlfLi1dK1xcLnZlcnNpb25zXFwudG9tbClbXCInXT9cXHMqXFwpXFxzKlxcKS9nO1xuICAgICAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgICAgd2hpbGUgKChtYXRjaCA9IGNyZWF0ZVJlLmV4ZWMoY29udGVudCkpICE9PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IGFjY2Vzc29yID0gbWF0Y2hbMV0udG9Mb3dlckNhc2UoKTtcbiAgICAgICAgY29uc3QgY2F0YWxvZ0Jhc2VuYW1lID0gbWF0Y2hbMl0ucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpLnNwbGl0KFwiL1wiKS5wb3AoKSE7XG4gICAgICAgIGlmICh2ZXJzaW9uQ2F0YWxvZ0ZpbGVzLnNvbWUoKGZpbGUpID0+IHtcbiAgICAgICAgICBjb25zdCBub3JtYWxpemVkID0gZmlsZS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIik7XG4gICAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWQgPT09IGNhdGFsb2dCYXNlbmFtZSB8fCBub3JtYWxpemVkLmVuZHNXaXRoKGAvJHtjYXRhbG9nQmFzZW5hbWV9YCk7XG4gICAgICAgIH0pKSB7XG4gICAgICAgICAgYWNjZXNzb3JzLmFkZChhY2Nlc3Nvcik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIHVucmVhZGFibGUgc2V0dGluZ3MgZmlsZSBcdTIwMTQgaWdub3JlXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGFjY2Vzc29ycztcbn1cblxuLyoqXG4gKiBXYWxrIGFuY2VzdG9yIGRpcmVjdG9yaWVzIG9mIGBzdGFydERpcmAgbG9va2luZyBmb3IgYW55IGZpbGUgaW5cbiAqIGBQUk9KRUNUX0ZJTEVTYC4gU3RvcHMgYXQgdGhlIGZpbGVzeXN0ZW0gcm9vdCBvciBhdCBhIGAuZ2l0YCBib3VuZGFyeVxuICogKHNvIGFuY2VzdG9ycyBhYm92ZSBhIGdpdCByZXBvIHJvb3QgXHUyMDE0IGUuZy4gYCRIT01FYCBvciBgL3Vzci9sb2NhbGAgXHUyMDE0XG4gKiBjYW4ndCB0cmlnZ2VyIGZhbHNlIHBvc2l0aXZlcykuIFJldHVybnMgdHJ1ZSBpZiBhbiBhbmNlc3RvciBjb250YWluc1xuICogb25lIG9mIHRoZSBwcm9qZWN0IG1hcmtlcnMuXG4gKlxuICogVXNlZCBieSB0aGUgd29ya3RyZWUgaGVhbHRoIGNoZWNrICgjMjM0NykgdG8gYXZvaWQgd2FybmluZyBhYm91dFxuICogbW9ub3JlcG9zIHdoZXJlIHBhY2thZ2UuanNvbiAvIENhcmdvLnRvbWwgLyBldGMuIGxpdmUgaW4gYSBwYXJlbnRcbiAqIGRpcmVjdG9yeSByYXRoZXIgdGhhbiBpbiB0aGUgd29ya3RyZWUncyBvd24gY2hlY2tvdXQuXG4gKlxuICogYGV4aXN0c0ZuYCBpcyBpbmplY3RhYmxlIHNvIHRoaXMgcmVtYWlucyBkZXRlcm1pbmlzdGljYWxseSB0ZXN0YWJsZVxuICogd2l0aG91dCB0b3VjaGluZyB0aGUgcmVhbCBmaWxlc3lzdGVtOyBkZWZhdWx0cyB0byBgZnMuZXhpc3RzU3luY2AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNQcm9qZWN0RmlsZUluQW5jZXN0b3IoXG4gIHN0YXJ0RGlyOiBzdHJpbmcsXG4gIGV4aXN0c0ZuOiAocDogc3RyaW5nKSA9PiBib29sZWFuID0gZXhpc3RzU3luYyxcbik6IGJvb2xlYW4ge1xuICBsZXQgY2hlY2tEaXIgPSBkaXJuYW1lKHN0YXJ0RGlyKTtcbiAgY29uc3QgeyByb290IH0gPSBwYXJzZVBhdGgoY2hlY2tEaXIpO1xuICB3aGlsZSAoY2hlY2tEaXIgIT09IHJvb3QpIHtcbiAgICBpZiAoUFJPSkVDVF9GSUxFUy5zb21lKChmKSA9PiBleGlzdHNGbihqb2luKGNoZWNrRGlyLCBmKSkpKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgLy8gU3RvcCBhdCBnaXQgcmVwb3NpdG9yeSBib3VuZGFyeSBcdTIwMTQgYW5jZXN0b3JzIGFib3ZlIHRoZSByZXBvIHJvb3RcbiAgICAvLyBtYXkgY29udGFpbiB1bnJlbGF0ZWQgcHJvamVjdCBmaWxlcy4gQ2hlY2sgQUZURVIgcHJvamVjdC1maWxlIHNjYW5cbiAgICAvLyBzbyBhIHJlcG8gcm9vdCBjb250YWluaW5nIGJvdGggLmdpdCBhbmQgYSBtYXJrZXIgaXMgc3RpbGwgcmVjb2duaXplZC5cbiAgICBpZiAoZXhpc3RzRm4oam9pbihjaGVja0RpciwgXCIuZ2l0XCIpKSkgcmV0dXJuIGZhbHNlO1xuICAgIGNoZWNrRGlyID0gZGlybmFtZShjaGVja0Rpcik7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBwcm9qZWN0J3MgYC5nc2QvYCBkaXJlY3RvcnkgY29udGFpbnMgdGhlIGJvb3RzdHJhcCBhcnRpZmFjdHNcbiAqIChgUFJFRkVSRU5DRVMubWRgIG9yIGBtaWxlc3RvbmVzL2ApIHRoYXQgaW5kaWNhdGUgYSBjb21wbGV0ZWQgaW5pdCBydW4uXG4gKlxuICogQSB6b21iaWUgYC5nc2QvYCBzdGF0ZSBcdTIwMTQgc3ltbGluayBleGlzdHMgYnV0IG5laXRoZXIgYXJ0aWZhY3QgaXMgcHJlc2VudCBcdTIwMTRcbiAqIG11c3QgYmUgdHJlYXRlZCBhcyBcIm5lZWRzIGluaXQgd2l6YXJkXCIuIFRoZSBwcmV2aW91cyBndWFyZCBjaGVja2VkIG9ubHlcbiAqIGBleGlzdHNTeW5jKGdzZFJvb3QoYmFzZVBhdGgpKWAsIHdoaWNoIGFjY2VwdGVkIHpvbWJpZSBzdGF0ZXMgYW5kIHNraXBwZWRcbiAqIHRoZSB3aXphcmQgKCMyOTQyKS5cbiAqXG4gKiBgZXhpc3RzRm5gIGlzIGluamVjdGFibGUgc28gdGVzdHMgY2FuIHJ1biBkZXRlcm1pbmlzdGljYWxseTsgZGVmYXVsdHMgdG9cbiAqIGBmcy5leGlzdHNTeW5jYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc0dzZEJvb3RzdHJhcEFydGlmYWN0cyhcbiAgZ3NkUGF0aDogc3RyaW5nLFxuICBleGlzdHNGbjogKHA6IHN0cmluZykgPT4gYm9vbGVhbiA9IGV4aXN0c1N5bmMsXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBleGlzdHNGbihnc2RQYXRoKSAmJlxuICAgIChleGlzdHNGbihqb2luKGdzZFBhdGgsIFwiUFJFRkVSRU5DRVMubWRcIikpIHx8XG4gICAgICBleGlzdHNGbihqb2luKGdzZFBhdGgsIFwicHJlZmVyZW5jZXMubWRcIikpIHx8XG4gICAgICBleGlzdHNGbihqb2luKGdzZFBhdGgsIFwibWlsZXN0b25lc1wiKSkpXG4gICk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzY2FuUHJvamVjdEZpbGVzKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGZpbGVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBxdWV1ZTogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGRlcHRoOiBudW1iZXIgfT4gPSBbeyBwYXRoOiBiYXNlUGF0aCwgZGVwdGg6IDAgfV07XG5cbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDAgJiYgZmlsZXMubGVuZ3RoIDwgTUFYX1JFQ1VSU0lWRV9TQ0FOX0ZJTEVTKSB7XG4gICAgY29uc3QgY3VycmVudCA9IHF1ZXVlLnNoaWZ0KCkhO1xuICAgIGxldCBlbnRyaWVzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgaXNEaXJlY3RvcnkoKTogYm9vbGVhbjsgaXNGaWxlKCk6IGJvb2xlYW4gfT47XG4gICAgdHJ5IHtcbiAgICAgIGVudHJpZXMgPSByZWFkZGlyU3luYyhjdXJyZW50LnBhdGgsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSwgZW5jb2Rpbmc6IFwidXRmOFwiIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICBjb25zdCBlbnRyeVBhdGggPSBqb2luKGN1cnJlbnQucGF0aCwgZW50cnkubmFtZSk7XG4gICAgICBjb25zdCByZWxhdGl2ZVBhdGggPSBlbnRyeVBhdGguc2xpY2UoYmFzZVBhdGgubGVuZ3RoICsgMSk7XG5cbiAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChjdXJyZW50LmRlcHRoIDwgTUFYX1JFQ1VSU0lWRV9TQ0FOX0RFUFRIICYmICFSRUNVUlNJVkVfU0NBTl9JR05PUkVEX0RJUlMuaGFzKGVudHJ5Lm5hbWUpKSB7XG4gICAgICAgICAgcXVldWUucHVzaCh7IHBhdGg6IGVudHJ5UGF0aCwgZGVwdGg6IGN1cnJlbnQuZGVwdGggKyAxIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWVudHJ5LmlzRmlsZSgpKSBjb250aW51ZTtcbiAgICAgIGZpbGVzLnB1c2gocmVsYXRpdmVQYXRoKTtcbiAgICAgIGlmIChmaWxlcy5sZW5ndGggPj0gTUFYX1JFQ1VSU0lWRV9TQ0FOX0ZJTEVTKSBicmVhaztcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmlsZXM7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFlBQVksVUFBVSxVQUFVLFdBQVcsYUFBYSxjQUFjLGdCQUFnQjtBQUMvRixTQUFTLFNBQVMsTUFBTSxTQUFTLGlCQUFpQjtBQUNsRCxTQUFTLGVBQWU7QUFDeEIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsZUFBZTtBQWdGakIsTUFBTSxnQkFBZ0I7QUFBQSxFQUMzQjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQTtBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBO0FBQUEsRUFFQTtBQUFBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUE7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQTtBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUE7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQTtBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUE7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBO0FBQUEs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
