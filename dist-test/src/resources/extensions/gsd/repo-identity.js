import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gsdHome } from "./gsd-home.js";
function isRepoMeta(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return typeof v.version === "number" && typeof v.hash === "string" && typeof v.gitRoot === "string" && typeof v.remoteUrl === "string" && typeof v.createdAt === "string";
}
function writeRepoMeta(externalPath, remoteUrl, gitRoot) {
  const metaPath = join(externalPath, "repo-meta.json");
  try {
    let createdAt = (/* @__PURE__ */ new Date()).toISOString();
    let existing = null;
    if (existsSync(metaPath)) {
      try {
        const parsed = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (isRepoMeta(parsed)) {
          existing = parsed;
          createdAt = parsed.createdAt;
          if (parsed.version === 1 && parsed.hash === basename(externalPath) && parsed.gitRoot === gitRoot && parsed.remoteUrl === remoteUrl) {
            return;
          }
        }
      } catch {
      }
    }
    const meta = {
      version: 1,
      hash: basename(externalPath),
      gitRoot,
      remoteUrl,
      createdAt
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  } catch {
  }
}
function readRepoMeta(externalPath) {
  const metaPath = join(externalPath, "repo-meta.json");
  try {
    if (!existsSync(metaPath)) return null;
    const raw = readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRepoMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function isInheritedRepo(basePath) {
  try {
    const root = resolveGitRoot(basePath);
    const normalizedBase = canonicalizeExistingPath(basePath);
    const normalizedRoot = canonicalizeExistingPath(root);
    if (normalizedBase === normalizedRoot) return false;
    if (isProjectGsd(join(root, ".gsd"))) return false;
    let dir = dirname(normalizedBase);
    while (dir !== normalizedRoot && dir !== dirname(dir)) {
      if (isProjectGsd(join(dir, ".gsd"))) return false;
      dir = dirname(dir);
    }
    return true;
  } catch {
    return false;
  }
}
function isProjectGsd(gsdPath) {
  if (!existsSync(gsdPath)) return false;
  try {
    const stat = lstatSync(gsdPath);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory()) {
      const currentGsdHome = gsdHome();
      const normalizedGsdPath = canonicalizeExistingPath(gsdPath);
      const normalizedGsdHome = canonicalizeExistingPath(currentGsdHome);
      if (normalizedGsdPath === normalizedGsdHome) return false;
      return true;
    }
  } catch {
  }
  return false;
}
function getRemoteUrl(basePath) {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
  } catch {
    return "";
  }
}
function canonicalizeExistingPath(path) {
  try {
    return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
  } catch {
    return resolve(path);
  }
}
function resolveGitCommonDir(basePath) {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
  } catch {
    const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
    return resolve(basePath, raw);
  }
}
function resolveGitRoot(basePath) {
  try {
    const commonDir = resolveGitCommonDir(basePath);
    const normalizedCommonDir = commonDir.replaceAll("\\", "/");
    if (normalizedCommonDir.endsWith("/.git")) {
      return canonicalizeExistingPath(resolve(commonDir, ".."));
    }
    const worktreeMarker = "/.git/worktrees/";
    if (normalizedCommonDir.includes(worktreeMarker)) {
      return canonicalizeExistingPath(resolve(commonDir, "..", ".."));
    }
    return canonicalizeExistingPath(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim());
  } catch {
    return resolve(basePath);
  }
}
function validateProjectId(id) {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}
function repoIdentity(basePath) {
  const projectId = process.env.GSD_PROJECT_ID;
  if (projectId) {
    return projectId;
  }
  const remoteUrl = getRemoteUrl(basePath);
  if (remoteUrl) {
    return createHash("sha256").update(remoteUrl).digest("hex").slice(0, 12);
  }
  const root = resolveGitRoot(basePath);
  const input = `
${root}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
function externalGsdRoot(basePath) {
  const base = process.env.GSD_STATE_DIR || gsdHome();
  return join(base, "projects", repoIdentity(basePath));
}
function externalProjectsRoot() {
  const base = process.env.GSD_STATE_DIR || gsdHome();
  return join(base, "projects");
}
const GSD_NUMBERED_VARIANT_RE = /^\.gsd \d+$/;
function cleanNumberedGsdVariants(projectPath) {
  const removed = [];
  try {
    const entries = readdirSync(projectPath);
    for (const entry of entries) {
      if (GSD_NUMBERED_VARIANT_RE.test(entry)) {
        const fullPath = join(projectPath, entry);
        try {
          rmSync(fullPath, { recursive: true, force: true });
          removed.push(entry);
        } catch {
        }
      }
    }
  } catch {
  }
  return removed;
}
function writeGsdIdMarker(projectPath, identity) {
  try {
    const markerPath = join(projectPath, ".gsd-id");
    if (existsSync(markerPath)) {
      try {
        if (readFileSync(markerPath, "utf-8").trim() === identity) return;
      } catch {
      }
    }
    writeFileSync(markerPath, identity + "\n", "utf-8");
  } catch {
  }
}
function readGsdIdMarker(projectPath) {
  try {
    const markerPath = join(projectPath, ".gsd-id");
    if (!existsSync(markerPath)) return null;
    const content = readFileSync(markerPath, "utf-8").trim();
    return /^[a-zA-Z0-9_-]+$/.test(content) ? content : null;
  } catch {
    return null;
  }
}
function hasProjectState(externalPath) {
  try {
    if (!existsSync(externalPath)) return false;
    const entries = readdirSync(externalPath);
    return entries.some((e) => e !== "repo-meta.json");
  } catch {
    return false;
  }
}
function resolveExternalPathWithRecovery(projectPath) {
  const computedPath = externalGsdRoot(projectPath);
  const computedId = repoIdentity(projectPath);
  if (hasProjectState(computedPath)) {
    return computedPath;
  }
  const markerId = readGsdIdMarker(projectPath);
  if (markerId && markerId !== computedId) {
    const base = process.env.GSD_STATE_DIR || gsdHome();
    const markerPath = join(base, "projects", markerId);
    if (hasProjectState(markerPath)) {
      try {
        mkdirSync(computedPath, { recursive: true });
        const entries = readdirSync(markerPath);
        for (const entry of entries) {
          try {
            const src = join(markerPath, entry);
            const dst = join(computedPath, entry);
            try {
              renameSync(src, dst);
            } catch {
              cpSync(src, dst, { recursive: true, force: true });
            }
          } catch {
          }
        }
        try {
          rmSync(markerPath, { recursive: true, force: true });
        } catch {
        }
      } catch {
        return markerPath;
      }
    }
  }
  return computedPath;
}
function ensureGsdSymlink(projectPath) {
  const result = ensureGsdSymlinkCore(projectPath);
  if (!isInsideWorktree(projectPath)) {
    writeGsdIdMarker(projectPath, repoIdentity(projectPath));
  }
  return result;
}
function ensureGsdSymlinkCore(projectPath) {
  const externalPath = resolveExternalPathWithRecovery(projectPath);
  const localGsd = join(projectPath, ".gsd");
  const inWorktree = isInsideWorktree(projectPath);
  const normalizeForGuard = (p) => {
    let resolved;
    try {
      resolved = realpathSync(p);
    } catch {
      resolved = resolve(p);
    }
    const s = resolved.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const localGsdNormalized = normalizeForGuard(localGsd);
  const gsdHomeNorm = normalizeForGuard(gsdHome());
  if (localGsdNormalized === gsdHomeNorm) {
    return localGsd;
  }
  if (!inWorktree) {
    try {
      const gitRoot = resolveGitRoot(projectPath);
      const normalizedProject = canonicalizeExistingPath(projectPath);
      const normalizedRoot = canonicalizeExistingPath(gitRoot);
      if (normalizedProject !== normalizedRoot) {
        const rootGsd = join(gitRoot, ".gsd");
        if (existsSync(rootGsd)) {
          try {
            const rootStat = lstatSync(rootGsd);
            if (rootStat.isSymbolicLink() || rootStat.isDirectory()) {
              return rootStat.isSymbolicLink() ? realpathSync(rootGsd) : rootGsd;
            }
          } catch {
          }
        }
      }
    } catch {
    }
  }
  cleanNumberedGsdVariants(projectPath);
  mkdirSync(externalPath, { recursive: true });
  writeRepoMeta(externalPath, getRemoteUrl(projectPath), resolveGitRoot(projectPath));
  const replaceWithSymlink = () => {
    rmSync(localGsd, { recursive: true, force: true });
    try {
      unlinkSync(localGsd);
    } catch {
    }
    symlinkSync(externalPath, localGsd, "junction");
    return externalPath;
  };
  if (!existsSync(localGsd)) {
    try {
      const stat = lstatSync(localGsd);
      if (stat.isSymbolicLink()) {
        return replaceWithSymlink();
      }
    } catch {
    }
    try {
      unlinkSync(localGsd);
    } catch {
    }
    symlinkSync(externalPath, localGsd, "junction");
    return externalPath;
  }
  try {
    const stat = lstatSync(localGsd);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(localGsd);
      if (target === externalPath) {
        return externalPath;
      }
      if (inWorktree) {
        return replaceWithSymlink();
      }
      if (!hasProjectState(externalPath) && hasProjectState(target)) {
        try {
          mkdirSync(externalPath, { recursive: true });
          const oldEntries = readdirSync(target);
          for (const entry of oldEntries) {
            try {
              const src = join(target, entry);
              const dst = join(externalPath, entry);
              try {
                renameSync(src, dst);
              } catch {
                cpSync(src, dst, { recursive: true, force: true });
              }
            } catch {
            }
          }
          try {
            rmSync(target, { recursive: true, force: true });
          } catch {
          }
          return replaceWithSymlink();
        } catch {
          return target;
        }
      }
      return target;
    }
    if (stat.isDirectory()) {
      return localGsd;
    }
  } catch {
  }
  return localGsd;
}
function isInsideWorktree(cwd) {
  const gitPath = join(cwd, ".git");
  try {
    const stat = lstatSync(gitPath);
    if (!stat.isFile()) return false;
    const content = readFileSync(gitPath, "utf-8").trim();
    return content.startsWith("gitdir:");
  } catch {
    return false;
  }
}
export {
  cleanNumberedGsdVariants,
  ensureGsdSymlink,
  externalGsdRoot,
  externalProjectsRoot,
  isInheritedRepo,
  isInsideWorktree,
  readRepoMeta,
  repoIdentity,
  validateProjectId
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9yZXBvLWlkZW50aXR5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBSZXBvIElkZW50aXR5IFx1MjAxNCBleHRlcm5hbCBzdGF0ZSBkaXJlY3RvcnkgcHJpbWl0aXZlcy5cbiAqXG4gKiBDb21wdXRlcyBhIHN0YWJsZSBwZXItcmVwbyBpZGVudGl0eSBoYXNoLCByZXNvbHZlcyB0aGUgZXh0ZXJuYWxcbiAqIGB+Ly5nc2QvcHJvamVjdHMvPGhhc2g+L2Agc3RhdGUgZGlyZWN0b3J5LCBhbmQgbWFuYWdlcyB0aGVcbiAqIGA8cHJvamVjdD4vLmdzZCBcdTIxOTIgZXh0ZXJuYWxgIHN5bWxpbmsuXG4gKi9cblxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgY3BTeW5jLCBleGlzdHNTeW5jLCBsc3RhdFN5bmMsIG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCByZW5hbWVTeW5jLCBybVN5bmMsIHN5bWxpbmtTeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuL2dzZC1ob21lLmpzXCI7XG5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlcG8gTWV0YWRhdGEgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVwb01ldGEge1xuICB2ZXJzaW9uOiBudW1iZXI7XG4gIGhhc2g6IHN0cmluZztcbiAgZ2l0Um9vdDogc3RyaW5nO1xuICByZW1vdGVVcmw6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIGlzUmVwb01ldGEodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZXBvTWV0YSB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHYgPSB2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgcmV0dXJuIHR5cGVvZiB2LnZlcnNpb24gPT09IFwibnVtYmVyXCJcbiAgICAmJiB0eXBlb2Ygdi5oYXNoID09PSBcInN0cmluZ1wiXG4gICAgJiYgdHlwZW9mIHYuZ2l0Um9vdCA9PT0gXCJzdHJpbmdcIlxuICAgICYmIHR5cGVvZiB2LnJlbW90ZVVybCA9PT0gXCJzdHJpbmdcIlxuICAgICYmIHR5cGVvZiB2LmNyZWF0ZWRBdCA9PT0gXCJzdHJpbmdcIjtcbn1cblxuLyoqXG4gKiBXcml0ZSAob3IgcmVmcmVzaCkgcmVwbyBtZXRhZGF0YSBpbnRvIHRoZSBleHRlcm5hbCBzdGF0ZSBkaXJlY3RvcnkuXG4gKiBDYWxsZWQgb24gb3BlbiBzbyBtZXRhZGF0YSB0cmFja3MgcmVwbyBwYXRoIG1vdmVzIHdoaWxlIGtlZXBpbmcgY3JlYXRlZEF0IHN0YWJsZS5cbiAqIE5vbi1mYXRhbDogYSBtZXRhZGF0YSB3cml0ZSBmYWlsdXJlIG11c3QgbmV2ZXIgYmxvY2sgcHJvamVjdCBzZXR1cC5cbiAqL1xuZnVuY3Rpb24gd3JpdGVSZXBvTWV0YShleHRlcm5hbFBhdGg6IHN0cmluZywgcmVtb3RlVXJsOiBzdHJpbmcsIGdpdFJvb3Q6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBtZXRhUGF0aCA9IGpvaW4oZXh0ZXJuYWxQYXRoLCBcInJlcG8tbWV0YS5qc29uXCIpO1xuICB0cnkge1xuICAgIGxldCBjcmVhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgbGV0IGV4aXN0aW5nOiBSZXBvTWV0YSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChleGlzdHNTeW5jKG1ldGFQYXRoKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobWV0YVBhdGgsIFwidXRmLThcIikpO1xuICAgICAgICBpZiAoaXNSZXBvTWV0YShwYXJzZWQpKSB7XG4gICAgICAgICAgZXhpc3RpbmcgPSBwYXJzZWQ7XG4gICAgICAgICAgY3JlYXRlZEF0ID0gcGFyc2VkLmNyZWF0ZWRBdDtcbiAgICAgICAgICAvLyBGYXN0IHBhdGg6IG5vdGhpbmcgY2hhbmdlZC5cbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBwYXJzZWQudmVyc2lvbiA9PT0gMVxuICAgICAgICAgICAgJiYgcGFyc2VkLmhhc2ggPT09IGJhc2VuYW1lKGV4dGVybmFsUGF0aClcbiAgICAgICAgICAgICYmIHBhcnNlZC5naXRSb290ID09PSBnaXRSb290XG4gICAgICAgICAgICAmJiBwYXJzZWQucmVtb3RlVXJsID09PSByZW1vdGVVcmxcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBGYWxsIHRocm91Z2ggYW5kIHJld3JpdGUgaW52YWxpZCBtZXRhZGF0YS5cbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBtZXRhOiBSZXBvTWV0YSA9IHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBoYXNoOiBiYXNlbmFtZShleHRlcm5hbFBhdGgpLFxuICAgICAgZ2l0Um9vdCxcbiAgICAgIHJlbW90ZVVybCxcbiAgICAgIGNyZWF0ZWRBdCxcbiAgICB9O1xuICAgIC8vIEtlZXAgZmlsZSBmb3JtYXQgc3RhYmxlIGV2ZW4gd2hlbiByZWZyZXNoaW5nLlxuICAgIHdyaXRlRmlsZVN5bmMobWV0YVBhdGgsIEpTT04uc3RyaW5naWZ5KG1ldGEsIG51bGwsIDIpICsgXCJcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBtZXRhZGF0YSB3cml0ZSBmYWlsdXJlIHNob3VsZCBub3QgYmxvY2sgcHJvamVjdCBzZXR1cFxuICB9XG59XG5cbi8qKlxuICogUmVhZCByZXBvIG1ldGFkYXRhIGZyb20gdGhlIGV4dGVybmFsIHN0YXRlIGRpcmVjdG9yeS5cbiAqIFJldHVybnMgbnVsbCBpZiB0aGUgZmlsZSBkb2Vzbid0IGV4aXN0IG9yIGNhbid0IGJlIHBhcnNlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRSZXBvTWV0YShleHRlcm5hbFBhdGg6IHN0cmluZyk6IFJlcG9NZXRhIHwgbnVsbCB7XG4gIGNvbnN0IG1ldGFQYXRoID0gam9pbihleHRlcm5hbFBhdGgsIFwicmVwby1tZXRhLmpzb25cIik7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKG1ldGFQYXRoKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKG1ldGFQYXRoLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KTtcbiAgICByZXR1cm4gaXNSZXBvTWV0YShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEluaGVyaXRlZC1SZXBvIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGBiYXNlUGF0aGAgaXMgaW5oZXJpdGluZyBhIHBhcmVudCBkaXJlY3RvcnkncyBnaXQgcmVwb1xuICogcmF0aGVyIHRoYW4gYmVpbmcgdGhlIGdpdCByb290IGl0c2VsZi5cbiAqXG4gKiBSZXR1cm5zIHRydWUgd2hlbiBBTEwgb2Y6XG4gKiAgIDEuIGJhc2VQYXRoIGlzIGluc2lkZSBhIGdpdCByZXBvIChnaXQgcmV2LXBhcnNlIHN1Y2NlZWRzKVxuICogICAyLiBUaGUgcmVzb2x2ZWQgZ2l0IHJvb3QgaXMgYSBwcm9wZXIgYW5jZXN0b3Igb2YgYmFzZVBhdGhcbiAqICAgMy4gVGhlcmUgaXMgbm8gKnByb2plY3QqIGAuZ3NkYCBkaXJlY3RvcnkgYXQgdGhlIGdpdCByb290IG9yIGFueVxuICogICAgICBpbnRlcm1lZGlhdGUgYW5jZXN0b3IgKHRoZSBwYXJlbnQgcHJvamVjdCBoYXMgbm90IGJlZW5cbiAqICAgICAgaW5pdGlhbGlzZWQgd2l0aCBHU0QpXG4gKlxuICogV2hlbiB0cnVlLCB0aGUgY2FsbGVyIHNob3VsZCBydW4gYGdpdCBpbml0YCBhdCBiYXNlUGF0aCBzbyB0aGF0XG4gKiBgcmVwb0lkZW50aXR5KClgIHByb2R1Y2VzIGEgaGFzaCB1bmlxdWUgdG8gdGhpcyBkaXJlY3RvcnksIHByZXZlbnRpbmdcbiAqIGNyb3NzLXByb2plY3Qgc3RhdGUgbGVha3MgKCMxNjM5KS5cbiAqXG4gKiBXaGVuIHRoZSBnaXQgcm9vdCBhbHJlYWR5IGhhcyBhIHByb2plY3QgYC5nc2RgLCB0aGUgZGlyZWN0b3J5IGlzIGFcbiAqIGxlZ2l0aW1hdGUgc3ViZGlyZWN0b3J5IG9mIGFuIGV4aXN0aW5nIEdTRCBwcm9qZWN0IFx1MjAxNCBgY2Qgc3JjLyAmJiAvZ3NkYFxuICogc2hvdWxkIHN0aWxsIGxvYWQgdGhlIHBhcmVudCBwcm9qZWN0J3MgbWlsZXN0b25lcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW5oZXJpdGVkUmVwbyhiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgcm9vdCA9IHJlc29sdmVHaXRSb290KGJhc2VQYXRoKTtcbiAgICBjb25zdCBub3JtYWxpemVkQmFzZSA9IGNhbm9uaWNhbGl6ZUV4aXN0aW5nUGF0aChiYXNlUGF0aCk7XG4gICAgY29uc3Qgbm9ybWFsaXplZFJvb3QgPSBjYW5vbmljYWxpemVFeGlzdGluZ1BhdGgocm9vdCk7XG4gICAgaWYgKG5vcm1hbGl6ZWRCYXNlID09PSBub3JtYWxpemVkUm9vdCkgcmV0dXJuIGZhbHNlOyAvLyBiYXNlUGF0aCBJUyB0aGUgcm9vdFxuXG4gICAgLy8gVGhlIGdpdCByb290IGlzIGEgcHJvcGVyIGFuY2VzdG9yLiBDaGVjayB3aGV0aGVyIGl0IGFscmVhZHkgaGFzIC5nc2RcbiAgICAvLyAoaS5lLiB0aGUgcGFyZW50IHByb2plY3Qgd2FzIGluaXRpYWxpc2VkIHdpdGggR1NEKS5cbiAgICBpZiAoaXNQcm9qZWN0R3NkKGpvaW4ocm9vdCwgXCIuZ3NkXCIpKSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8gV2FsayB1cCBmcm9tIGJhc2VQYXRoJ3MgcGFyZW50IHRvIHRoZSBnaXQgcm9vdCBjaGVja2luZyBmb3IgLmdzZC5cbiAgICAvLyBTdGFydCBhdCBkaXJuYW1lKG5vcm1hbGl6ZWRCYXNlKSwgTk9UIG5vcm1hbGl6ZWRCYXNlIGl0c2VsZiBcdTIwMTQgZmluZGluZ1xuICAgIC8vIC5nc2QgYXQgYmFzZVBhdGggbWVhbnMgR1NEIHN0YXRlIGlzIHNldCB1cCBmb3IgVEhJUyBwcm9qZWN0LCB3aGljaFxuICAgIC8vIHNheXMgbm90aGluZyBhYm91dCB3aGV0aGVyIHRoZSBnaXQgcmVwbyBpcyBpbmhlcml0ZWQgZnJvbSBhbiBhbmNlc3Rvci5cbiAgICBsZXQgZGlyID0gZGlybmFtZShub3JtYWxpemVkQmFzZSk7XG4gICAgd2hpbGUgKGRpciAhPT0gbm9ybWFsaXplZFJvb3QgJiYgZGlyICE9PSBkaXJuYW1lKGRpcikpIHtcbiAgICAgIGlmIChpc1Byb2plY3RHc2Qoam9pbihkaXIsIFwiLmdzZFwiKSkpIHJldHVybiBmYWxzZTtcbiAgICAgIGRpciA9IGRpcm5hbWUoZGlyKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogRGlzdGluZ3Vpc2ggYSAqcHJvamVjdCogYC5nc2RgIGZyb20gdGhlIGdsb2JhbCBgfi8uZ3NkYCBzdGF0ZSBkaXJlY3RvcnkuXG4gKlxuICogQSBwcm9qZWN0IGAuZ3NkYCBpcyBlaXRoZXI6XG4gKiAgIC0gQSBzeW1saW5rIHRvIGFuIGV4dGVybmFsIHN0YXRlIGRpcmVjdG9yeSAobm9ybWFsIHBvc3QtbWlncmF0aW9uIGxheW91dClcbiAqICAgLSBBIGxlZ2FjeSByZWFsIGRpcmVjdG9yeSB0aGF0IGlzIE5PVCB0aGUgZ2xvYmFsIEdTRCBob21lXG4gKlxuICogV2hlbiB0aGUgdXNlcidzIGhvbWUgZGlyZWN0b3J5IGlzIGl0c2VsZiBhIGdpdCByZXBvIChlLmcuIGRvdGZpbGUgbWFuYWdlcnMpLFxuICogYH4vLmdzZGAgZXhpc3RzIGJ1dCBpcyB0aGUgZ2xvYmFsIHN0YXRlIGRpcmVjdG9yeSBcdTIwMTQgbm90IGEgcHJvamVjdCBgLmdzZGAuXG4gKiBUcmVhdGluZyBpdCBhcyBhIHByb2plY3QgYC5nc2RgIHdvdWxkIGNhdXNlIGlzSW5oZXJpdGVkUmVwbygpIHRvIHdyb25nbHlcbiAqIGNvbmNsdWRlIHRoYXQgc3ViZGlyZWN0b3JpZXMgYXJlIHBhcnQgb2YgdGhlIGhvbWUgXCJwcm9qZWN0XCIgKCMyMzkzKS5cbiAqL1xuZnVuY3Rpb24gaXNQcm9qZWN0R3NkKGdzZFBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWV4aXN0c1N5bmMoZ3NkUGF0aCkpIHJldHVybiBmYWxzZTtcblxuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMoZ3NkUGF0aCk7XG5cbiAgICAvLyBTeW1saW5rcyBhcmUgYWx3YXlzIHByb2plY3QgLmdzZCAoY3JlYXRlZCBieSBlbnN1cmVHc2RTeW1saW5rKS5cbiAgICBpZiAoc3RhdC5pc1N5bWJvbGljTGluaygpKSByZXR1cm4gdHJ1ZTtcblxuICAgIC8vIEZvciByZWFsIGRpcmVjdG9yaWVzLCBjaGVjayB0aGF0IHRoaXMgaXNuJ3QgdGhlIGdsb2JhbCBHU0QgaG9tZS5cbiAgICAvLyBSZWNvbXB1dGUgZ3NkSG9tZSBkeW5hbWljYWxseSBzbyBlbnYgb3ZlcnJpZGVzIChHU0RfSE9NRSkgYXJlXG4gICAgLy8gcGlja2VkIHVwIGF0IGNhbGwgdGltZSwgbm90IGp1c3QgYXQgbW9kdWxlIGxvYWQgdGltZS5cbiAgICBpZiAoc3RhdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICBjb25zdCBjdXJyZW50R3NkSG9tZSA9IGdzZEhvbWUoKTtcbiAgICAgIGNvbnN0IG5vcm1hbGl6ZWRHc2RQYXRoID0gY2Fub25pY2FsaXplRXhpc3RpbmdQYXRoKGdzZFBhdGgpO1xuICAgICAgY29uc3Qgbm9ybWFsaXplZEdzZEhvbWUgPSBjYW5vbmljYWxpemVFeGlzdGluZ1BhdGgoY3VycmVudEdzZEhvbWUpO1xuICAgICAgaWYgKG5vcm1hbGl6ZWRHc2RQYXRoID09PSBub3JtYWxpemVkR3NkSG9tZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBsc3RhdCBmYWlsZWQgXHUyMDE0IHRyZWF0IGFzIG5vIC5nc2QgcHJlc2VudFxuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVwbyBJZGVudGl0eSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBHZXQgdGhlIGdpdCByZW1vdGUgVVJMIGZvciBcIm9yaWdpblwiLCBvciBcIlwiIGlmIG5vIHJlbW90ZSBpcyBjb25maWd1cmVkLlxuICogVXNlcyBgZ2l0IGNvbmZpZ2AgcmF0aGVyIHRoYW4gYGdpdCByZW1vdGUgZ2V0LXVybGAgZm9yIGJyb2FkZXIgY29tcGF0LlxuICovXG5mdW5jdGlvbiBnZXRSZW1vdGVVcmwoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb25maWdcIiwgXCItLWdldFwiLCBcInJlbW90ZS5vcmlnaW4udXJsXCJdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgICAgdGltZW91dDogNV8wMDAsXG4gICAgfSkudHJpbSgpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJcIjtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGdpdCB0b3BsZXZlbCAocmVhbCByb290KSBmb3IgdGhlIGdpdmVuIHBhdGguXG4gKiBGb3Igd29ya3RyZWVzIHRoaXMgcmV0dXJucyB0aGUgbWFpbiByZXBvIHJvb3QsIG5vdCB0aGUgd29ya3RyZWUgcGF0aC5cbiAqL1xuZnVuY3Rpb24gY2Fub25pY2FsaXplRXhpc3RpbmdQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgLy8gVXNlIG5hdGl2ZSByZWFscGF0aCBvbiBXaW5kb3dzIHRvIHJlc29sdmUgOC4zIHNob3J0IHBhdGhzIChlLmcuIFJVTk5FUn4xKVxuICAgIHJldHVybiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyByZWFscGF0aFN5bmMubmF0aXZlKHBhdGgpIDogcmVhbHBhdGhTeW5jKHBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gcmVzb2x2ZShwYXRoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlR2l0Q29tbW9uRGlyKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiLS1wYXRoLWZvcm1hdD1hYnNvbHV0ZVwiLCBcIi0tZ2l0LWNvbW1vbi1kaXJcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpZ25vcmVcIl0sXG4gICAgICB0aW1lb3V0OiA1XzAwMCxcbiAgICB9KS50cmltKCk7XG4gIH0gY2F0Y2gge1xuICAgIGNvbnN0IHJhdyA9IGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCItLWdpdC1jb21tb24tZGlyXCJdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgICAgdGltZW91dDogNV8wMDAsXG4gICAgfSkudHJpbSgpO1xuICAgIHJldHVybiByZXNvbHZlKGJhc2VQYXRoLCByYXcpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVHaXRSb290KGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbW1vbkRpciA9IHJlc29sdmVHaXRDb21tb25EaXIoYmFzZVBhdGgpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRDb21tb25EaXIgPSBjb21tb25EaXIucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuXG4gICAgLy8gTm9ybWFsIHJlcG8gb3Igd29ya3RyZWUgd2l0aCBzaGFyZWQgY29tbW9uIGRpciBwb2ludGluZyBhdCA8cmVwbz4vLmdpdC5cbiAgICBpZiAobm9ybWFsaXplZENvbW1vbkRpci5lbmRzV2l0aChcIi8uZ2l0XCIpKSB7XG4gICAgICByZXR1cm4gY2Fub25pY2FsaXplRXhpc3RpbmdQYXRoKHJlc29sdmUoY29tbW9uRGlyLCBcIi4uXCIpKTtcbiAgICB9XG5cbiAgICAvLyBTb21lIGdpdCBzZXR1cHMgbWF5IHN0aWxsIGV4cG9zZSA8cmVwbz4vLmdpdC93b3JrdHJlZXMvPG5hbWU+LlxuICAgIGNvbnN0IHdvcmt0cmVlTWFya2VyID0gXCIvLmdpdC93b3JrdHJlZXMvXCI7XG4gICAgaWYgKG5vcm1hbGl6ZWRDb21tb25EaXIuaW5jbHVkZXMod29ya3RyZWVNYXJrZXIpKSB7XG4gICAgICByZXR1cm4gY2Fub25pY2FsaXplRXhpc3RpbmdQYXRoKHJlc29sdmUoY29tbW9uRGlyLCBcIi4uXCIsIFwiLi5cIikpO1xuICAgIH1cblxuICAgIC8vIEZhbGxiYWNrIGZvciB1bnVzdWFsIGxheW91dHMuXG4gICAgcmV0dXJuIGNhbm9uaWNhbGl6ZUV4aXN0aW5nUGF0aChleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiLS1zaG93LXRvcGxldmVsXCJdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgICAgdGltZW91dDogNV8wMDAsXG4gICAgfSkudHJpbSgpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHJlc29sdmUoYmFzZVBhdGgpO1xuICB9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYSBHU0RfUFJPSkVDVF9JRCB2YWx1ZS5cbiAqXG4gKiBNdXN0IGNvbnRhaW4gb25seSBhbHBoYW51bWVyaWMgY2hhcmFjdGVycywgaHlwaGVucywgYW5kIHVuZGVyc2NvcmVzLlxuICogQ2FsbCB0aGlzIG9uY2UgYXQgc3RhcnR1cCBzbyB0aGUgdXNlciBnZXRzIGltbWVkaWF0ZSBmZWVkYmFjayBvbiBiYWQgdmFsdWVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVQcm9qZWN0SWQoaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL15bYS16QS1aMC05Xy1dKyQvLnRlc3QoaWQpO1xufVxuXG4vKipcbiAqIENvbXB1dGUgYSBzdGFibGUgaWRlbnRpdHkgZm9yIGEgcmVwb3NpdG9yeS5cbiAqXG4gKiBJZiBgR1NEX1BST0pFQ1RfSURgIGlzIHNldCwgcmV0dXJucyBpdCBkaXJlY3RseSAodmFsaWRhdGlvbiBpcyBleHBlY3RlZFxuICogdG8gaGF2ZSBhbHJlYWR5IGhhcHBlbmVkIGF0IHN0YXJ0dXAgdmlhIGB2YWxpZGF0ZVByb2plY3RJZGApLlxuICpcbiAqIEZvciByZXBvcyB3aXRoIGEgcmVtb3RlIFVSTCwgcmV0dXJucyBTSEEtMjU2IG9mIHRoZSByZW1vdGUgVVJMIG9ubHkgXHUyMDE0XG4gKiB0aGlzIG1ha2VzIHRoZSBpZGVudGl0eSBzdGFibGUgYWNyb3NzIGRpcmVjdG9yeSBtb3Zlcy9yZW5hbWVzICgjMjc1MCkuXG4gKlxuICogRm9yIGxvY2FsLW9ubHkgcmVwb3MgKG5vIHJlbW90ZSksIGluY2x1ZGVzIHRoZSBnaXQgcm9vdCBpbiB0aGUgaGFzaC5cbiAqIExvY2FsIHJlcG9zIHVzZSBhIGAuZ3NkLWlkYCBtYXJrZXIgZmlsZSBmb3IgcmVjb3ZlcnkgYWZ0ZXIgbW92ZXMuXG4gKlxuICogRGV0ZXJtaW5pc3RpYzogc2FtZSByZXBvIGFsd2F5cyBwcm9kdWNlcyB0aGUgc2FtZSBoYXNoIHJlZ2FyZGxlc3Mgb2ZcbiAqIHdoaWNoIHdvcmt0cmVlIHRoZSBjYWxsZXIgaXMgaW5zaWRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb0lkZW50aXR5KGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBwcm9qZWN0SWQgPSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9JRDtcbiAgaWYgKHByb2plY3RJZCkge1xuICAgIHJldHVybiBwcm9qZWN0SWQ7XG4gIH1cbiAgY29uc3QgcmVtb3RlVXJsID0gZ2V0UmVtb3RlVXJsKGJhc2VQYXRoKTtcbiAgaWYgKHJlbW90ZVVybCkge1xuICAgIC8vIFJlbW90ZSBVUkwgYWxvbmUgdW5pcXVlbHkgaWRlbnRpZmllcyB0aGUgcmVwbyBcdTIwMTQgcGF0aCBpcyByZWR1bmRhbnQuXG4gICAgLy8gVGhpcyBtYWtlcyBtb3ZlcyB0cmFuc3BhcmVudCBmb3IgcmVwb3Mgd2l0aCByZW1vdGVzICgjMjc1MCkuXG4gICAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHJlbW90ZVVybCkuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDEyKTtcbiAgfVxuICAvLyBMb2NhbC1vbmx5IHJlcG86IGluY2x1ZGUgZ2l0IHJvb3Qgc2luY2UgdGhlcmUncyBubyByZW1vdGUgdG8gYW5jaG9yIGlkZW50aXR5LlxuICBjb25zdCByb290ID0gcmVzb2x2ZUdpdFJvb3QoYmFzZVBhdGgpO1xuICBjb25zdCBpbnB1dCA9IGBcXG4ke3Jvb3R9YDtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKGlucHV0KS5kaWdlc3QoXCJoZXhcIikuc2xpY2UoMCwgMTIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXh0ZXJuYWwgU3RhdGUgRGlyZWN0b3J5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENvbXB1dGUgdGhlIGV4dGVybmFsIEdTRCBzdGF0ZSBkaXJlY3RvcnkgZm9yIGEgcmVwb3NpdG9yeS5cbiAqXG4gKiBSZXR1cm5zIGAkR1NEX1NUQVRFX0RJUi9wcm9qZWN0cy88aGFzaD5gIGlmIGBHU0RfU1RBVEVfRElSYCBpcyBzZXQsXG4gKiBvdGhlcndpc2UgYH4vLmdzZC9wcm9qZWN0cy88aGFzaD5gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0ZXJuYWxHc2RSb290KGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gcHJvY2Vzcy5lbnYuR1NEX1NUQVRFX0RJUiB8fCBnc2RIb21lKCk7XG4gIHJldHVybiBqb2luKGJhc2UsIFwicHJvamVjdHNcIiwgcmVwb0lkZW50aXR5KGJhc2VQYXRoKSk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcm9vdCBkaXJlY3RvcnkgdGhhdCBzdG9yZXMgcHJvamVjdC1zY29wZWQgZXh0ZXJuYWwgc3RhdGUuXG4gKiBIb25vcnMgR1NEX1NUQVRFX0RJUiBvdmVycmlkZSBiZWZvcmUgZmFsbGluZyBiYWNrIHRvIEdTRF9IT01FLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0ZXJuYWxQcm9qZWN0c1Jvb3QoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IHByb2Nlc3MuZW52LkdTRF9TVEFURV9ESVIgfHwgZ3NkSG9tZSgpO1xuICByZXR1cm4gam9pbihiYXNlLCBcInByb2plY3RzXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTnVtYmVyZWQgVmFyaWFudCBDbGVhbnVwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIG1hY09TIGNvbGxpc2lvbiBwYXR0ZXJuOiBgLmdzZCAyYCwgYC5nc2QgM2AsIGAuZ3NkIDRgLCBldGMuXG4gKlxuICogV2hlbiBgc3ltbGlua1N5bmNgIChvciBGaW5kZXIpIHRyaWVzIHRvIGNyZWF0ZSBgLmdzZGAgYnV0IGEgcmVhbCBkaXJlY3RvcnlcbiAqIGFscmVhZHkgZXhpc3RzIGF0IHRoYXQgcGF0aCwgbWFjT1MgQVBGUyBzaWxlbnRseSByZW5hbWVzIHRoZSBuZXcgZW50cnkgdG9cbiAqIGAuZ3NkIDJgLCB0aGVuIGAuZ3NkIDNgLCBhbmQgc28gb24uIFRoZXNlIG51bWJlcmVkIHZhcmlhbnRzIGNvbmZ1c2UgR1NEXG4gKiBiZWNhdXNlIHRoZSBjYW5vbmljYWwgYC5nc2RgIHBhdGggbm8gbG9uZ2VyIHJlc29sdmVzIHRvIHRoZSBleHRlcm5hbCBzdGF0ZVxuICogZGlyZWN0b3J5LCBtYWtpbmcgdHJhY2tlZCBwbGFubmluZyBmaWxlcyBhcHBlYXIgZGVsZXRlZC5cbiAqXG4gKiBUaGlzIGhlbHBlciBzY2FucyB0aGUgcHJvamVjdCByb290IGZvciBlbnRyaWVzIG1hdGNoaW5nIGAuZ3NkIDxkaWdpdHM+YCBhbmRcbiAqIHJlbW92ZXMgdGhlbS4gSXQgaXMgY2FsbGVkIGVhcmx5IGluIGBlbnN1cmVHc2RTeW1saW5rKClgIHNvIHRoYXQgdGhlXG4gKiBjYW5vbmljYWwgYC5nc2RgIHBhdGggaXMgYWx3YXlzIHRoZSBvbmUgaW4gdXNlLlxuICovXG5jb25zdCBHU0RfTlVNQkVSRURfVkFSSUFOVF9SRSA9IC9eXFwuZ3NkIFxcZCskLztcblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFuTnVtYmVyZWRHc2RWYXJpYW50cyhwcm9qZWN0UGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCByZW1vdmVkOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhwcm9qZWN0UGF0aCk7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICBpZiAoR1NEX05VTUJFUkVEX1ZBUklBTlRfUkUudGVzdChlbnRyeSkpIHtcbiAgICAgICAgY29uc3QgZnVsbFBhdGggPSBqb2luKHByb2plY3RQYXRoLCBlbnRyeSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcm1TeW5jKGZ1bGxQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgICAgcmVtb3ZlZC5wdXNoKGVudHJ5KTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gQmVzdC1lZmZvcnQ6IGlmIHJlbW92YWwgZmFpbHMgKGUuZy4gcGVybWlzc2lvbnMpLCBjb250aW51ZSB3aXRoIG5leHRcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsOiByZWFkZGlyIGZhaWx1cmUgc2hvdWxkIG5vdCBibG9jayBzeW1saW5rIGNyZWF0aW9uXG4gIH1cbiAgcmV0dXJuIHJlbW92ZWQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAuZ3NkLWlkIE1hcmtlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBXcml0ZSBhIGAuZ3NkLWlkYCBtYXJrZXIgZmlsZSBpbiB0aGUgcHJvamVjdCByb290LlxuICpcbiAqIFRoaXMgZmlsZSByZWNvcmRzIHRoZSBpZGVudGl0eSBoYXNoIHVzZWQgZm9yIHRoZSBleHRlcm5hbCBzdGF0ZSBkaXJlY3RvcnkuXG4gKiBGb3IgbG9jYWwtb25seSByZXBvcyAobm8gcmVtb3RlKSwgdGhpcyBtYXJrZXIgc3Vydml2ZXMgZGlyZWN0b3J5IG1vdmVzIGFuZFxuICogZW5hYmxlcyBhdXRvbWF0aWMgcmVjb3Zlcnkgb2Ygb3JwaGFuZWQgc3RhdGUgKCMyNzUwKS5cbiAqXG4gKiBUaGUgbWFya2VyIGlzIGdpdGlnbm9yZWQgYnkgZW5zdXJlR2l0aWdub3JlKCkuIE5vbi1mYXRhbDogZmFpbHVyZSB0byB3cml0ZVxuICogdGhlIG1hcmtlciBtdXN0IG5ldmVyIGJsb2NrIHByb2plY3Qgc2V0dXAuXG4gKi9cbmZ1bmN0aW9uIHdyaXRlR3NkSWRNYXJrZXIocHJvamVjdFBhdGg6IHN0cmluZywgaWRlbnRpdHk6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IG1hcmtlclBhdGggPSBqb2luKHByb2plY3RQYXRoLCBcIi5nc2QtaWRcIik7XG4gICAgLy8gT25seSB3cml0ZSBpZiBjb250ZW50IGRpZmZlcnMgdG8gYXZvaWQgdW5uZWNlc3NhcnkgZGlzayB3cml0ZXMuXG4gICAgaWYgKGV4aXN0c1N5bmMobWFya2VyUGF0aCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChyZWFkRmlsZVN5bmMobWFya2VyUGF0aCwgXCJ1dGYtOFwiKS50cmltKCkgPT09IGlkZW50aXR5KSByZXR1cm47XG4gICAgICB9IGNhdGNoIHsgLyogZmFsbCB0aHJvdWdoIGFuZCBvdmVyd3JpdGUgKi8gfVxuICAgIH1cbiAgICB3cml0ZUZpbGVTeW5jKG1hcmtlclBhdGgsIGlkZW50aXR5ICsgXCJcXG5cIiwgXCJ1dGYtOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBtYXJrZXIgd3JpdGUgZmFpbHVyZSBzaG91bGQgbm90IGJsb2NrIHByb2plY3Qgc2V0dXBcbiAgfVxufVxuXG4vKipcbiAqIFJlYWQgdGhlIGAuZ3NkLWlkYCBtYXJrZXIgZnJvbSB0aGUgcHJvamVjdCByb290LlxuICogUmV0dXJucyB0aGUgaWRlbnRpdHkgaGFzaCwgb3IgbnVsbCBpZiB0aGUgbWFya2VyIGRvZXNuJ3QgZXhpc3Qgb3IgaXMgdW5yZWFkYWJsZS5cbiAqL1xuZnVuY3Rpb24gcmVhZEdzZElkTWFya2VyKHByb2plY3RQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBtYXJrZXJQYXRoID0gam9pbihwcm9qZWN0UGF0aCwgXCIuZ3NkLWlkXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhtYXJrZXJQYXRoKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhtYXJrZXJQYXRoLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICByZXR1cm4gL15bYS16QS1aMC05Xy1dKyQvLnRlc3QoY29udGVudCkgPyBjb250ZW50IDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGFuIGV4dGVybmFsIHN0YXRlIGRpcmVjdG9yeSBoYXMgbWVhbmluZ2Z1bCBjb250ZW50LlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSBkaXJlY3RvcnkgY29udGFpbnMgYW55IGZpbGVzIG9yIHN1YmRpcmVjdG9yaWVzXG4gKiBiZXlvbmQganVzdCByZXBvLW1ldGEuanNvbi5cbiAqL1xuZnVuY3Rpb24gaGFzUHJvamVjdFN0YXRlKGV4dGVybmFsUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKGV4dGVybmFsUGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoZXh0ZXJuYWxQYXRoKTtcbiAgICByZXR1cm4gZW50cmllcy5zb21lKGUgPT4gZSAhPT0gXCJyZXBvLW1ldGEuanNvblwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZXh0ZXJuYWwgc3RhdGUgZGlyZWN0b3J5LCB3aXRoIHJlY292ZXJ5IGZvciByZWxvY2F0ZWQgcHJvamVjdHMuXG4gKlxuICogRm9yIGxvY2FsLW9ubHkgcmVwb3Mgd2hlcmUgdGhlIGNvbXB1dGVkIGlkZW50aXR5IHByb2R1Y2VzIGFuIGVtcHR5IHN0YXRlIGRpcixcbiAqIGNoZWNrcyB0aGUgYC5nc2QtaWRgIG1hcmtlciBmb3IgdGhlIG9yaWdpbmFsIGlkZW50aXR5IGhhc2ggYW5kIHJlY292ZXJzXG4gKiB0aGUgb2xkIHN0YXRlIGRpcmVjdG9yeSBpZiBpdCBzdGlsbCBleGlzdHMgYW5kIGNvbnRhaW5zIGRhdGEgKCMyNzUwKS5cbiAqXG4gKiBSZXR1cm5zIHRoZSByZXNvbHZlZCBleHRlcm5hbCBwYXRoIChtYXkgZGlmZmVyIGZyb20gdGhlIGNvbXB1dGVkIGlkZW50aXR5KS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUV4dGVybmFsUGF0aFdpdGhSZWNvdmVyeShwcm9qZWN0UGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgY29tcHV0ZWRQYXRoID0gZXh0ZXJuYWxHc2RSb290KHByb2plY3RQYXRoKTtcbiAgY29uc3QgY29tcHV0ZWRJZCA9IHJlcG9JZGVudGl0eShwcm9qZWN0UGF0aCk7XG5cbiAgLy8gQ2hlY2sgaWYgY29tcHV0ZWQgcGF0aCBhbHJlYWR5IGhhcyBzdGF0ZSBcdTIwMTQgZmFzdCBwYXRoLCBubyByZWNvdmVyeSBuZWVkZWQuXG4gIGlmIChoYXNQcm9qZWN0U3RhdGUoY29tcHV0ZWRQYXRoKSkge1xuICAgIHJldHVybiBjb21wdXRlZFBhdGg7XG4gIH1cblxuICAvLyBDaGVjayBmb3IgLmdzZC1pZCBtYXJrZXIgZnJvbSBhIHByZXZpb3VzIGxvY2F0aW9uLlxuICBjb25zdCBtYXJrZXJJZCA9IHJlYWRHc2RJZE1hcmtlcihwcm9qZWN0UGF0aCk7XG4gIGlmIChtYXJrZXJJZCAmJiBtYXJrZXJJZCAhPT0gY29tcHV0ZWRJZCkge1xuICAgIC8vIFRoZSBtYXJrZXIgcG9pbnRzIHRvIGEgZGlmZmVyZW50IGlkZW50aXR5IFx1MjAxNCB0aGUgcmVwbyB3YXMgbGlrZWx5IG1vdmVkLlxuICAgIGNvbnN0IGJhc2UgPSBwcm9jZXNzLmVudi5HU0RfU1RBVEVfRElSIHx8IGdzZEhvbWUoKTtcbiAgICBjb25zdCBtYXJrZXJQYXRoID0gam9pbihiYXNlLCBcInByb2plY3RzXCIsIG1hcmtlcklkKTtcbiAgICBpZiAoaGFzUHJvamVjdFN0YXRlKG1hcmtlclBhdGgpKSB7XG4gICAgICAvLyBSZWNvdmVyOiB1c2UgdGhlIG9sZCBzdGF0ZSBkaXJlY3RvcnkgYW5kIHVwZGF0ZSB0aGUgbWFya2VyIHRvIHRoZSBuZXcgaWRlbnRpdHkuXG4gICAgICAvLyBNb3ZlIHRoZSBzdGF0ZSBmcm9tIHRoZSBvbGQgaGFzaCBkaXIgdG8gdGhlIG5ldyBvbmUgc28gZnV0dXJlIGxvb2t1cHMgd29ya1xuICAgICAgLy8gd2l0aG91dCB0aGUgbWFya2VyLlxuICAgICAgdHJ5IHtcbiAgICAgICAgbWtkaXJTeW5jKGNvbXB1dGVkUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhtYXJrZXJQYXRoKTtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHNyYyA9IGpvaW4obWFya2VyUGF0aCwgZW50cnkpO1xuICAgICAgICAgICAgY29uc3QgZHN0ID0gam9pbihjb21wdXRlZFBhdGgsIGVudHJ5KTtcbiAgICAgICAgICAgIC8vIFVzZSByZW5hbWUgZm9yIHNhbWUtZmlsZXN5c3RlbSAoZmFzdCkgb3IgZmFsbCBiYWNrIHRvIGNvcHkuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICByZW5hbWVTeW5jKHNyYywgZHN0KTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICBjcFN5bmMoc3JjLCBkc3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIHsgLyogY29udGludWUgd2l0aCByZW1haW5pbmcgZW50cmllcyAqLyB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gQ2xlYW4gdXAgb2xkIGRpcmVjdG9yeSBhZnRlciBzdWNjZXNzZnVsIG1pZ3JhdGlvbi5cbiAgICAgICAgdHJ5IHsgcm1TeW5jKG1hcmtlclBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gSWYgbWlncmF0aW9uIGZhaWxzLCBqdXN0IHBvaW50IGF0IHRoZSBvbGQgZGlyZWN0b3J5LlxuICAgICAgICByZXR1cm4gbWFya2VyUGF0aDtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gY29tcHV0ZWRQYXRoO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3ltbGluayBNYW5hZ2VtZW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEVuc3VyZSB0aGUgYDxwcm9qZWN0Pi8uZ3NkYCBzeW1saW5rIHBvaW50cyB0byB0aGUgZXh0ZXJuYWwgc3RhdGUgZGlyZWN0b3J5LlxuICpcbiAqIDEuIENsZWFuIHVwIGFueSBtYWNPUyBudW1iZXJlZCBjb2xsaXNpb24gdmFyaWFudHMgKGAuZ3NkIDJgLCBgLmdzZCAzYCwgZXRjLilcbiAqIDIuIFJlc29sdmUgZXh0ZXJuYWwgZGlyICh3aXRoIHJlbG9jYXRpb24gcmVjb3ZlcnkgdmlhIGAuZ3NkLWlkYCBtYXJrZXIpXG4gKiAzLiBta2RpciAtcCB0aGUgZXh0ZXJuYWwgZGlyXG4gKiA0LiBJZiBgPHByb2plY3Q+Ly5nc2RgIGRvZXNuJ3QgZXhpc3QgXHUyMTkyIGNyZWF0ZSBzeW1saW5rXG4gKiA1LiBJZiBgPHByb2plY3Q+Ly5nc2RgIGlzIGFscmVhZHkgdGhlIGNvcnJlY3Qgc3ltbGluayBcdTIxOTIgbm8tb3BcbiAqIDYuIElmIGA8cHJvamVjdD4vLmdzZGAgaXMgYSByZWFsIGRpcmVjdG9yeSBcdTIxOTIgcmV0dXJuIGFzLWlzIChtaWdyYXRpb24gaGFuZGxlcyBsYXRlcilcbiAqIDcuIFdyaXRlIGAuZ3NkLWlkYCBtYXJrZXIgZm9yIGZ1dHVyZSByZWxvY2F0aW9uIHJlY292ZXJ5XG4gKlxuICogUmV0dXJucyB0aGUgcmVzb2x2ZWQgZXh0ZXJuYWwgcGF0aC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuc3VyZUdzZFN5bWxpbmsocHJvamVjdFBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlc3VsdCA9IGVuc3VyZUdzZFN5bWxpbmtDb3JlKHByb2plY3RQYXRoKTtcblxuICAvLyBXcml0ZSAuZ3NkLWlkIG1hcmtlciBzbyBmdXR1cmUgcmVsb2NhdGlvbnMgY2FuIHJlY292ZXIgdGhpcyBzdGF0ZSAoIzI3NTApLlxuICAvLyBPbmx5IHdyaXRlIGZvciB0aGUgcHJvamVjdCByb290IChub3Qgc3ViZGlyZWN0b3JpZXMgb3Igd29ya3RyZWVzIHRoYXRcbiAgLy8gZGVsZWdhdGUgdG8gYSBwYXJlbnQgLmdzZCkuXG4gIGlmICghaXNJbnNpZGVXb3JrdHJlZShwcm9qZWN0UGF0aCkpIHtcbiAgICB3cml0ZUdzZElkTWFya2VyKHByb2plY3RQYXRoLCByZXBvSWRlbnRpdHkocHJvamVjdFBhdGgpKTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUdzZFN5bWxpbmtDb3JlKHByb2plY3RQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBleHRlcm5hbFBhdGggPSByZXNvbHZlRXh0ZXJuYWxQYXRoV2l0aFJlY292ZXJ5KHByb2plY3RQYXRoKTtcbiAgY29uc3QgbG9jYWxHc2QgPSBqb2luKHByb2plY3RQYXRoLCBcIi5nc2RcIik7XG4gIGNvbnN0IGluV29ya3RyZWUgPSBpc0luc2lkZVdvcmt0cmVlKHByb2plY3RQYXRoKTtcblxuICAvLyBHdWFyZDogTmV2ZXIgY3JlYXRlIGEgc3ltbGluayBhdCB+Ly5nc2QgXHUyMDE0IHRoYXQncyB0aGUgdXNlci1sZXZlbCBHU0QgaG9tZSxcbiAgLy8gbm90IGEgcHJvamVjdCAuZ3NkLiBUaGlzIGNhbiBoYXBwZW4gaWYgcmVzb2x2ZVByb2plY3RSb290KCkgb3JcbiAgLy8gZXNjYXBlU3RhbGVXb3JrdHJlZSgpIHJldHVybmVkIH4gYXMgdGhlIHByb2plY3Qgcm9vdCAoIzE2NzYpLlxuICAvLyBDYW5vbmljYWwgbm9ybWFsaXphdGlvbjogcmVzb2x2ZSBzeW1saW5rcywgdHJpbSB0cmFpbGluZyBzbGFzaGVzLCBjYXNlLWZvbGQgb24gV2luZG93cy5cbiAgY29uc3Qgbm9ybWFsaXplRm9yR3VhcmQgPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBsZXQgcmVzb2x2ZWQ6IHN0cmluZztcbiAgICB0cnkgeyByZXNvbHZlZCA9IHJlYWxwYXRoU3luYyhwKTsgfSBjYXRjaCB7IHJlc29sdmVkID0gcmVzb2x2ZShwKTsgfVxuICAgIGNvbnN0IHMgPSByZXNvbHZlZC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgICByZXR1cm4gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gcy50b0xvd2VyQ2FzZSgpIDogcztcbiAgfTtcbiAgY29uc3QgbG9jYWxHc2ROb3JtYWxpemVkID0gbm9ybWFsaXplRm9yR3VhcmQobG9jYWxHc2QpO1xuICBjb25zdCBnc2RIb21lTm9ybSA9IG5vcm1hbGl6ZUZvckd1YXJkKGdzZEhvbWUoKSk7XG4gIGlmIChsb2NhbEdzZE5vcm1hbGl6ZWQgPT09IGdzZEhvbWVOb3JtKSB7XG4gICAgcmV0dXJuIGxvY2FsR3NkO1xuICB9XG5cbiAgLy8gR3VhcmQ6IElmIHByb2plY3RQYXRoIGlzIGEgcGxhaW4gc3ViZGlyZWN0b3J5IChub3QgYSB3b3JrdHJlZSkgb2YgYSBnaXRcbiAgLy8gcmVwbyB0aGF0IGFscmVhZHkgaGFzIGEgLmdzZCBhdCB0aGUgZ2l0IHJvb3QsIGRvIG5vdCBjcmVhdGUgYSBkdXBsaWNhdGVcbiAgLy8gc3ltbGluayBpbiB0aGUgc3ViZGlyZWN0b3J5IFx1MjAxNCB0aGF0IGNhdXNlcyBgLmdzZCAyYCBjb2xsaXNpb24gdmFyaWFudHMgb25cbiAgLy8gbWFjT1MgKCMyMzgwKS4gV29ya3RyZWVzIGFyZSBleGNsdWRlZCBiZWNhdXNlIHRoZXkgbGVnaXRpbWF0ZWx5IG5lZWQgdGhlaXJcbiAgLy8gb3duIC5nc2Qgc3ltbGluayBwb2ludGluZyBhdCB0aGUgc2hhcmVkIGV4dGVybmFsIHN0YXRlIGRpci5cbiAgaWYgKCFpbldvcmt0cmVlKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGdpdFJvb3QgPSByZXNvbHZlR2l0Um9vdChwcm9qZWN0UGF0aCk7XG4gICAgICBjb25zdCBub3JtYWxpemVkUHJvamVjdCA9IGNhbm9uaWNhbGl6ZUV4aXN0aW5nUGF0aChwcm9qZWN0UGF0aCk7XG4gICAgICBjb25zdCBub3JtYWxpemVkUm9vdCA9IGNhbm9uaWNhbGl6ZUV4aXN0aW5nUGF0aChnaXRSb290KTtcbiAgICAgIGlmIChub3JtYWxpemVkUHJvamVjdCAhPT0gbm9ybWFsaXplZFJvb3QpIHtcbiAgICAgICAgY29uc3Qgcm9vdEdzZCA9IGpvaW4oZ2l0Um9vdCwgXCIuZ3NkXCIpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhyb290R3NkKSkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByb290U3RhdCA9IGxzdGF0U3luYyhyb290R3NkKTtcbiAgICAgICAgICAgIGlmIChyb290U3RhdC5pc1N5bWJvbGljTGluaygpIHx8IHJvb3RTdGF0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJvb3RTdGF0LmlzU3ltYm9saWNMaW5rKCkgPyByZWFscGF0aFN5bmMocm9vdEdzZCkgOiByb290R3NkO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLy8gRmFsbCB0aHJvdWdoIHRvIG5vcm1hbCBsb2dpYyBpZiB3ZSBjYW4ndCBzdGF0IHJvb3QgLmdzZFxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gSWYgZ2l0IHJvb3QgZGV0ZWN0aW9uIGZhaWxzLCBmYWxsIHRocm91Z2ggdG8gbm9ybWFsIGxvZ2ljXG4gICAgfVxuICB9XG5cbiAgLy8gQ2xlYW4gdXAgbWFjT1MgbnVtYmVyZWQgY29sbGlzaW9uIHZhcmlhbnRzICguZ3NkIDIsIC5nc2QgMywgZXRjLikgYmVmb3JlXG4gIC8vIGFueSBleGlzdGVuY2UgY2hlY2tzIFx1MjAxNCBvdGhlcndpc2UgdGhleSBhY2N1bXVsYXRlIGFuZCBjb25mdXNlIHN0YXRlICgjMjIwNSkuXG4gIGNsZWFuTnVtYmVyZWRHc2RWYXJpYW50cyhwcm9qZWN0UGF0aCk7XG5cbiAgLy8gRW5zdXJlIGV4dGVybmFsIGRpcmVjdG9yeSBleGlzdHNcbiAgbWtkaXJTeW5jKGV4dGVybmFsUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgLy8gV3JpdGUgcmVwbyBtZXRhZGF0YSBvbmNlIHNvIGNsZWFudXAgY29tbWFuZHMgY2FuIGlkZW50aWZ5IHRoaXMgZGlyZWN0b3J5IGxhdGVyLlxuICB3cml0ZVJlcG9NZXRhKGV4dGVybmFsUGF0aCwgZ2V0UmVtb3RlVXJsKHByb2plY3RQYXRoKSwgcmVzb2x2ZUdpdFJvb3QocHJvamVjdFBhdGgpKTtcblxuICBjb25zdCByZXBsYWNlV2l0aFN5bWxpbmsgPSAoKTogc3RyaW5nID0+IHtcbiAgICBybVN5bmMobG9jYWxHc2QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAvLyBEZWZlbnNpdmU6IHJlbW92ZSBhbnkgcmVzaWR1YWwgZW50cnkgKGUuZy4gZGFuZ2xpbmcgc3ltbGluaykgYmVmb3JlIGNyZWF0aW5nLlxuICAgIHRyeSB7IHVubGlua1N5bmMobG9jYWxHc2QpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBnb25lICovIH1cbiAgICBzeW1saW5rU3luYyhleHRlcm5hbFBhdGgsIGxvY2FsR3NkLCBcImp1bmN0aW9uXCIpO1xuICAgIHJldHVybiBleHRlcm5hbFBhdGg7XG4gIH07XG5cbiAgLy8gQ2hlY2sgZm9yIGRhbmdsaW5nIHN5bWxpbmtzIChlLmcuIGFmdGVyIHJlbG9jYXRpb24gcmVjb3ZlcnkgcmVtb3ZlZCB0aGUgb2xkXG4gIC8vIHN0YXRlIGRpcikuIGV4aXN0c1N5bmMgZm9sbG93cyBzeW1saW5rcywgc28gaXQgcmV0dXJucyBmYWxzZSBmb3IgZGFuZ2xpbmcgb25lcy5cbiAgLy8gbHN0YXRTeW5jIGRvZXMgTk9UIGZvbGxvdywgc28gd2UgY2FuIGRldGVjdCB0aGUgZGFuZ2xpbmcgc3ltbGluayBhbmQgcmVwbGFjZSBpdC5cbiAgaWYgKCFleGlzdHNTeW5jKGxvY2FsR3NkKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGxvY2FsR3NkKTtcbiAgICAgIGlmIChzdGF0LmlzU3ltYm9saWNMaW5rKCkpIHtcbiAgICAgICAgLy8gRGFuZ2xpbmcgc3ltbGluayBcdTIwMTQgcmVwbGFjZSB3aXRoIGNvcnJlY3Qgb25lICgjMjc1MCkuXG4gICAgICAgIHJldHVybiByZXBsYWNlV2l0aFN5bWxpbmsoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGxzdGF0IGFsc28gZmFpbGVkIFx1MjAxNCBub3RoaW5nIGV4aXN0cyBhdCB0aGlzIHBhdGhcbiAgICB9XG4gICAgLy8gTm90aGluZyBleGlzdHMgeWV0IFx1MjAxNCBjcmVhdGUgc3ltbGluay5cbiAgICAvLyBEZWZlbnNpdmU6IHJlbW92ZSBhbnkgcmVzaWR1YWwgZW50cnkgdG8gYXZvaWQgRUVYSVNUIHJhY2UgKCMyNzUwKS5cbiAgICB0cnkgeyB1bmxpbmtTeW5jKGxvY2FsR3NkKTsgfSBjYXRjaCB7IC8qIG5vdGhpbmcgdG8gcmVtb3ZlICovIH1cbiAgICBzeW1saW5rU3luYyhleHRlcm5hbFBhdGgsIGxvY2FsR3NkLCBcImp1bmN0aW9uXCIpO1xuICAgIHJldHVybiBleHRlcm5hbFBhdGg7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMobG9jYWxHc2QpO1xuXG4gICAgaWYgKHN0YXQuaXNTeW1ib2xpY0xpbmsoKSkge1xuICAgICAgLy8gQWxyZWFkeSBhIHN5bWxpbmsgXHUyMDE0IHZlcmlmeSBpdCBwb2ludHMgdG8gdGhlIHJpZ2h0IHBsYWNlXG4gICAgICBjb25zdCB0YXJnZXQgPSByZWFscGF0aFN5bmMobG9jYWxHc2QpO1xuICAgICAgaWYgKHRhcmdldCA9PT0gZXh0ZXJuYWxQYXRoKSB7XG4gICAgICAgIHJldHVybiBleHRlcm5hbFBhdGg7IC8vIGNvcnJlY3Qgc3ltbGluaywgbm8tb3BcbiAgICAgIH1cbiAgICAgIC8vIEluIGEgd29ya3RyZWUsIG1pc21hdGNoZWQgc3ltbGlua3MgYXJlIGFsd2F5cyBzdGFsZS4gSGVhbCB0aGVtIHNvXG4gICAgICAvLyB0aGUgd29ya3RyZWUgcG9pbnRzIGF0IHRoZSBzYW1lIGV4dGVybmFsIHN0YXRlIGRpciBhcyB0aGUgbWFpbiByZXBvLlxuICAgICAgaWYgKGluV29ya3RyZWUpIHtcbiAgICAgICAgcmV0dXJuIHJlcGxhY2VXaXRoU3ltbGluaygpO1xuICAgICAgfVxuICAgICAgLy8gQWZ0ZXIgaWRlbnRpdHkgaGFzaCBjaGFuZ2UgKGUuZy4gdXBncmFkZSBmcm9tIHBhdGgtYmFzZWQgdG8gcmVtb3RlLW9ubHlcbiAgICAgIC8vIGhhc2gsIG9yIHJlbG9jYXRpb24gcmVjb3ZlcnkpLCBtaWdyYXRlIGRhdGEgZnJvbSBvbGQgdGFyZ2V0IHRvIG5ldyBwYXRoXG4gICAgICAvLyBhbmQgdXBkYXRlIHRoZSBzeW1saW5rICgjMjc1MCkuXG4gICAgICBpZiAoIWhhc1Byb2plY3RTdGF0ZShleHRlcm5hbFBhdGgpICYmIGhhc1Byb2plY3RTdGF0ZSh0YXJnZXQpKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbWtkaXJTeW5jKGV4dGVybmFsUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgY29uc3Qgb2xkRW50cmllcyA9IHJlYWRkaXJTeW5jKHRhcmdldCk7XG4gICAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBvbGRFbnRyaWVzKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBzcmMgPSBqb2luKHRhcmdldCwgZW50cnkpO1xuICAgICAgICAgICAgICBjb25zdCBkc3QgPSBqb2luKGV4dGVybmFsUGF0aCwgZW50cnkpO1xuICAgICAgICAgICAgICB0cnkgeyByZW5hbWVTeW5jKHNyYywgZHN0KTsgfSBjYXRjaCB7IGNwU3luYyhzcmMsIGRzdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogY29udGludWUgKi8gfVxuICAgICAgICAgIH1cbiAgICAgICAgICB0cnkgeyBybVN5bmModGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxuICAgICAgICAgIHJldHVybiByZXBsYWNlV2l0aFN5bWxpbmsoKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gTWlncmF0aW9uIGZhaWxlZCBcdTIwMTQgcHJlc2VydmUgb2xkIHN5bWxpbmtcbiAgICAgICAgICByZXR1cm4gdGFyZ2V0O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBPdXRzaWRlIHdvcmt0cmVlcywgcHJlc2VydmUgY3VzdG9tIG92ZXJyaWRlcyBvciBsZWdhY3kgc3ltbGlua3MuXG4gICAgICByZXR1cm4gdGFyZ2V0O1xuICAgIH1cblxuICAgIGlmIChzdGF0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgIC8vIFJlYWwgZGlyZWN0b3J5IGluIHRoZSBtYWluIHJlcG8gXHUyMDE0IG1pZ3JhdGlvbiB3aWxsIGhhbmRsZSB0aGlzIGxhdGVyLlxuICAgICAgLy8gSW4gd29ya3RyZWVzLCBrZWVwIHRoZSBkaXJlY3RvcnkgaW4gcGxhY2UgYW5kIGxldCBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlXG4gICAgICAvLyByZWZyZXNoIGl0cyBjb250ZW50cy4gUmVwbGFjaW5nIGEgZ2l0LXRyYWNrZWQgLmdzZCBkaXJlY3Rvcnkgd2l0aCBhXG4gICAgICAvLyBzeW1saW5rIG1ha2VzIGdpdCB0aGluayB0cmFja2VkIHBsYW5uaW5nIGZpbGVzIHdlcmUgZGVsZXRlZC5cbiAgICAgIHJldHVybiBsb2NhbEdzZDtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGxzdGF0IGZhaWxlZCBcdTIwMTQgcGF0aCBleGlzdHMgYnV0IHdlIGNhbid0IHN0YXQgaXRcbiAgfVxuXG4gIHJldHVybiBsb2NhbEdzZDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdvcmt0cmVlIERldGVjdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBDaGVjayBpZiB0aGUgZ2l2ZW4gZGlyZWN0b3J5IGlzIGEgZ2l0IHdvcmt0cmVlIChub3QgdGhlIG1haW4gcmVwbykuXG4gKlxuICogR2l0IHdvcmt0cmVlcyBoYXZlIGEgYC5naXRgICpmaWxlKiAobm90IGRpcmVjdG9yeSkgY29udGFpbmluZyBhXG4gKiBgZ2l0ZGlyOmAgcG9pbnRlci4gVGhpcyBpcyBnaXQncyBuYXRpdmUgd29ya3RyZWUgaW5kaWNhdG9yIFx1MjAxNCBub1xuICogc3RyaW5nIG1hcmtlciBwYXJzaW5nIG5lZWRlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW5zaWRlV29ya3RyZWUoY3dkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZ2l0UGF0aCA9IGpvaW4oY3dkLCBcIi5naXRcIik7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGxzdGF0U3luYyhnaXRQYXRoKTtcbiAgICBpZiAoIXN0YXQuaXNGaWxlKCkpIHJldHVybiBmYWxzZTtcbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGdpdFBhdGgsIFwidXRmLThcIikudHJpbSgpO1xuICAgIHJldHVybiBjb250ZW50LnN0YXJ0c1dpdGgoXCJnaXRkaXI6XCIpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsUUFBUSxZQUFZLFdBQVcsV0FBVyxhQUFhLGNBQWMsY0FBYyxZQUFZLFFBQVEsYUFBYSxZQUFZLHFCQUFxQjtBQUM5SixTQUFTLFVBQVUsU0FBUyxNQUFNLGVBQWU7QUFDakQsU0FBUyxlQUFlO0FBYXhCLFNBQVMsV0FBVyxPQUFtQztBQUNyRCxNQUFJLENBQUMsU0FBUyxPQUFPLFVBQVUsU0FBVSxRQUFPO0FBQ2hELFFBQU0sSUFBSTtBQUNWLFNBQU8sT0FBTyxFQUFFLFlBQVksWUFDdkIsT0FBTyxFQUFFLFNBQVMsWUFDbEIsT0FBTyxFQUFFLFlBQVksWUFDckIsT0FBTyxFQUFF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
