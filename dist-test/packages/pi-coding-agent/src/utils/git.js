import hostedGitInfo from "hosted-git-info";
function splitRef(url) {
  const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    const pathWithMaybeRef2 = scpLikeMatch[2] ?? "";
    const refSeparator2 = pathWithMaybeRef2.indexOf("@");
    if (refSeparator2 < 0) return { repo: url };
    const repoPath2 = pathWithMaybeRef2.slice(0, refSeparator2);
    const ref2 = pathWithMaybeRef2.slice(refSeparator2 + 1);
    if (!repoPath2 || !ref2) return { repo: url };
    return {
      repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath2}`,
      ref: ref2
    };
  }
  if (url.includes("://")) {
    try {
      const parsed = new URL(url);
      const pathWithMaybeRef2 = parsed.pathname.replace(/^\/+/, "");
      const refSeparator2 = pathWithMaybeRef2.indexOf("@");
      if (refSeparator2 < 0) return { repo: url };
      const repoPath2 = pathWithMaybeRef2.slice(0, refSeparator2);
      const ref2 = pathWithMaybeRef2.slice(refSeparator2 + 1);
      if (!repoPath2 || !ref2) return { repo: url };
      parsed.pathname = `/${repoPath2}`;
      return {
        repo: parsed.toString().replace(/\/$/, ""),
        ref: ref2
      };
    } catch {
      return { repo: url };
    }
  }
  const slashIndex = url.indexOf("/");
  if (slashIndex < 0) {
    return { repo: url };
  }
  const host = url.slice(0, slashIndex);
  const pathWithMaybeRef = url.slice(slashIndex + 1);
  const refSeparator = pathWithMaybeRef.indexOf("@");
  if (refSeparator < 0) {
    return { repo: url };
  }
  const repoPath = pathWithMaybeRef.slice(0, refSeparator);
  const ref = pathWithMaybeRef.slice(refSeparator + 1);
  if (!repoPath || !ref) {
    return { repo: url };
  }
  return {
    repo: `${host}/${repoPath}`,
    ref
  };
}
function parseGenericGitUrl(url) {
  const { repo: repoWithoutRef, ref } = splitRef(url);
  let repo = repoWithoutRef;
  let host = "";
  let path = "";
  const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scpLikeMatch) {
    host = scpLikeMatch[1] ?? "";
    path = scpLikeMatch[2] ?? "";
  } else if (repoWithoutRef.startsWith("https://") || repoWithoutRef.startsWith("http://") || repoWithoutRef.startsWith("ssh://") || repoWithoutRef.startsWith("git://")) {
    try {
      const parsed = new URL(repoWithoutRef);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slashIndex = repoWithoutRef.indexOf("/");
    if (slashIndex < 0) {
      return null;
    }
    host = repoWithoutRef.slice(0, slashIndex);
    path = repoWithoutRef.slice(slashIndex + 1);
    if (!host.includes(".") && host !== "localhost") {
      return null;
    }
    repo = `https://${repoWithoutRef}`;
  }
  const normalizedPath = path.replace(/\.git$/, "").replace(/^\/+/, "");
  if (!host || !normalizedPath || normalizedPath.split("/").length < 2) {
    return null;
  }
  return {
    type: "git",
    repo,
    host,
    path: normalizedPath,
    ref,
    pinned: Boolean(ref)
  };
}
function parseGitUrl(source) {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
    return null;
  }
  const split = splitRef(url);
  const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : void 0, url].filter(
    (value) => Boolean(value)
  );
  for (const candidate of hostedCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) {
        continue;
      }
      const useHttpsPrefix = !split.repo.startsWith("http://") && !split.repo.startsWith("https://") && !split.repo.startsWith("ssh://") && !split.repo.startsWith("git://") && !split.repo.startsWith("git@");
      return {
        type: "git",
        repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
        host: info.domain || "",
        path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
        ref: info.committish || split.ref || void 0,
        pinned: Boolean(info.committish || split.ref)
      };
    }
  }
  const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : void 0, `https://${url}`].filter(
    (value) => Boolean(value)
  );
  for (const candidate of httpsCandidates) {
    const info = hostedGitInfo.fromUrl(candidate);
    if (info) {
      if (split.ref && info.project?.includes("@")) {
        continue;
      }
      return {
        type: "git",
        repo: `https://${split.repo}`,
        host: info.domain || "",
        path: `${info.user}/${info.project}`.replace(/\.git$/, ""),
        ref: info.committish || split.ref || void 0,
        pinned: Boolean(info.committish || split.ref)
      };
    }
  }
  return parseGenericGitUrl(url);
}
export {
  parseGitUrl
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy91dGlscy9naXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBob3N0ZWRHaXRJbmZvIGZyb20gXCJob3N0ZWQtZ2l0LWluZm9cIjtcblxuLyoqXG4gKiBQYXJzZWQgZ2l0IFVSTCBpbmZvcm1hdGlvbi5cbiAqL1xuZXhwb3J0IHR5cGUgR2l0U291cmNlID0ge1xuXHQvKiogQWx3YXlzIFwiZ2l0XCIgZm9yIGdpdCBzb3VyY2VzICovXG5cdHR5cGU6IFwiZ2l0XCI7XG5cdC8qKiBDbG9uZSBVUkwgKGFsd2F5cyB2YWxpZCBmb3IgZ2l0IGNsb25lLCB3aXRob3V0IHJlZiBzdWZmaXgpICovXG5cdHJlcG86IHN0cmluZztcblx0LyoqIEdpdCBob3N0IGRvbWFpbiAoZS5nLiwgXCJnaXRodWIuY29tXCIpICovXG5cdGhvc3Q6IHN0cmluZztcblx0LyoqIFJlcG9zaXRvcnkgcGF0aCAoZS5nLiwgXCJ1c2VyL3JlcG9cIikgKi9cblx0cGF0aDogc3RyaW5nO1xuXHQvKiogR2l0IHJlZiAoYnJhbmNoLCB0YWcsIGNvbW1pdCkgaWYgc3BlY2lmaWVkICovXG5cdHJlZj86IHN0cmluZztcblx0LyoqIFRydWUgaWYgcmVmIHdhcyBzcGVjaWZpZWQgKHBhY2thZ2Ugd29uJ3QgYmUgYXV0by11cGRhdGVkKSAqL1xuXHRwaW5uZWQ6IGJvb2xlYW47XG59O1xuXG5mdW5jdGlvbiBzcGxpdFJlZih1cmw6IHN0cmluZyk6IHsgcmVwbzogc3RyaW5nOyByZWY/OiBzdHJpbmcgfSB7XG5cdGNvbnN0IHNjcExpa2VNYXRjaCA9IHVybC5tYXRjaCgvXmdpdEAoW146XSspOiguKykkLyk7XG5cdGlmIChzY3BMaWtlTWF0Y2gpIHtcblx0XHRjb25zdCBwYXRoV2l0aE1heWJlUmVmID0gc2NwTGlrZU1hdGNoWzJdID8/IFwiXCI7XG5cdFx0Y29uc3QgcmVmU2VwYXJhdG9yID0gcGF0aFdpdGhNYXliZVJlZi5pbmRleE9mKFwiQFwiKTtcblx0XHRpZiAocmVmU2VwYXJhdG9yIDwgMCkgcmV0dXJuIHsgcmVwbzogdXJsIH07XG5cdFx0Y29uc3QgcmVwb1BhdGggPSBwYXRoV2l0aE1heWJlUmVmLnNsaWNlKDAsIHJlZlNlcGFyYXRvcik7XG5cdFx0Y29uc3QgcmVmID0gcGF0aFdpdGhNYXliZVJlZi5zbGljZShyZWZTZXBhcmF0b3IgKyAxKTtcblx0XHRpZiAoIXJlcG9QYXRoIHx8ICFyZWYpIHJldHVybiB7IHJlcG86IHVybCB9O1xuXHRcdHJldHVybiB7XG5cdFx0XHRyZXBvOiBgZ2l0QCR7c2NwTGlrZU1hdGNoWzFdID8/IFwiXCJ9OiR7cmVwb1BhdGh9YCxcblx0XHRcdHJlZixcblx0XHR9O1xuXHR9XG5cblx0aWYgKHVybC5pbmNsdWRlcyhcIjovL1wiKSkge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHVybCk7XG5cdFx0XHRjb25zdCBwYXRoV2l0aE1heWJlUmVmID0gcGFyc2VkLnBhdGhuYW1lLnJlcGxhY2UoL15cXC8rLywgXCJcIik7XG5cdFx0XHRjb25zdCByZWZTZXBhcmF0b3IgPSBwYXRoV2l0aE1heWJlUmVmLmluZGV4T2YoXCJAXCIpO1xuXHRcdFx0aWYgKHJlZlNlcGFyYXRvciA8IDApIHJldHVybiB7IHJlcG86IHVybCB9O1xuXHRcdFx0Y29uc3QgcmVwb1BhdGggPSBwYXRoV2l0aE1heWJlUmVmLnNsaWNlKDAsIHJlZlNlcGFyYXRvcik7XG5cdFx0XHRjb25zdCByZWYgPSBwYXRoV2l0aE1heWJlUmVmLnNsaWNlKHJlZlNlcGFyYXRvciArIDEpO1xuXHRcdFx0aWYgKCFyZXBvUGF0aCB8fCAhcmVmKSByZXR1cm4geyByZXBvOiB1cmwgfTtcblx0XHRcdHBhcnNlZC5wYXRobmFtZSA9IGAvJHtyZXBvUGF0aH1gO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0cmVwbzogcGFyc2VkLnRvU3RyaW5nKCkucmVwbGFjZSgvXFwvJC8sIFwiXCIpLFxuXHRcdFx0XHRyZWYsXG5cdFx0XHR9O1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIHsgcmVwbzogdXJsIH07XG5cdFx0fVxuXHR9XG5cblx0Y29uc3Qgc2xhc2hJbmRleCA9IHVybC5pbmRleE9mKFwiL1wiKTtcblx0aWYgKHNsYXNoSW5kZXggPCAwKSB7XG5cdFx0cmV0dXJuIHsgcmVwbzogdXJsIH07XG5cdH1cblx0Y29uc3QgaG9zdCA9IHVybC5zbGljZSgwLCBzbGFzaEluZGV4KTtcblx0Y29uc3QgcGF0aFdpdGhNYXliZVJlZiA9IHVybC5zbGljZShzbGFzaEluZGV4ICsgMSk7XG5cdGNvbnN0IHJlZlNlcGFyYXRvciA9IHBhdGhXaXRoTWF5YmVSZWYuaW5kZXhPZihcIkBcIik7XG5cdGlmIChyZWZTZXBhcmF0b3IgPCAwKSB7XG5cdFx0cmV0dXJuIHsgcmVwbzogdXJsIH07XG5cdH1cblx0Y29uc3QgcmVwb1BhdGggPSBwYXRoV2l0aE1heWJlUmVmLnNsaWNlKDAsIHJlZlNlcGFyYXRvcik7XG5cdGNvbnN0IHJlZiA9IHBhdGhXaXRoTWF5YmVSZWYuc2xpY2UocmVmU2VwYXJhdG9yICsgMSk7XG5cdGlmICghcmVwb1BhdGggfHwgIXJlZikge1xuXHRcdHJldHVybiB7IHJlcG86IHVybCB9O1xuXHR9XG5cdHJldHVybiB7XG5cdFx0cmVwbzogYCR7aG9zdH0vJHtyZXBvUGF0aH1gLFxuXHRcdHJlZixcblx0fTtcbn1cblxuZnVuY3Rpb24gcGFyc2VHZW5lcmljR2l0VXJsKHVybDogc3RyaW5nKTogR2l0U291cmNlIHwgbnVsbCB7XG5cdGNvbnN0IHsgcmVwbzogcmVwb1dpdGhvdXRSZWYsIHJlZiB9ID0gc3BsaXRSZWYodXJsKTtcblx0bGV0IHJlcG8gPSByZXBvV2l0aG91dFJlZjtcblx0bGV0IGhvc3QgPSBcIlwiO1xuXHRsZXQgcGF0aCA9IFwiXCI7XG5cblx0Y29uc3Qgc2NwTGlrZU1hdGNoID0gcmVwb1dpdGhvdXRSZWYubWF0Y2goL15naXRAKFteOl0rKTooLispJC8pO1xuXHRpZiAoc2NwTGlrZU1hdGNoKSB7XG5cdFx0aG9zdCA9IHNjcExpa2VNYXRjaFsxXSA/PyBcIlwiO1xuXHRcdHBhdGggPSBzY3BMaWtlTWF0Y2hbMl0gPz8gXCJcIjtcblx0fSBlbHNlIGlmIChcblx0XHRyZXBvV2l0aG91dFJlZi5zdGFydHNXaXRoKFwiaHR0cHM6Ly9cIikgfHxcblx0XHRyZXBvV2l0aG91dFJlZi5zdGFydHNXaXRoKFwiaHR0cDovL1wiKSB8fFxuXHRcdHJlcG9XaXRob3V0UmVmLnN0YXJ0c1dpdGgoXCJzc2g6Ly9cIikgfHxcblx0XHRyZXBvV2l0aG91dFJlZi5zdGFydHNXaXRoKFwiZ2l0Oi8vXCIpXG5cdCkge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHJlcG9XaXRob3V0UmVmKTtcblx0XHRcdGhvc3QgPSBwYXJzZWQuaG9zdG5hbWU7XG5cdFx0XHRwYXRoID0gcGFyc2VkLnBhdGhuYW1lLnJlcGxhY2UoL15cXC8rLywgXCJcIik7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cdH0gZWxzZSB7XG5cdFx0Y29uc3Qgc2xhc2hJbmRleCA9IHJlcG9XaXRob3V0UmVmLmluZGV4T2YoXCIvXCIpO1xuXHRcdGlmIChzbGFzaEluZGV4IDwgMCkge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHRcdGhvc3QgPSByZXBvV2l0aG91dFJlZi5zbGljZSgwLCBzbGFzaEluZGV4KTtcblx0XHRwYXRoID0gcmVwb1dpdGhvdXRSZWYuc2xpY2Uoc2xhc2hJbmRleCArIDEpO1xuXHRcdGlmICghaG9zdC5pbmNsdWRlcyhcIi5cIikgJiYgaG9zdCAhPT0gXCJsb2NhbGhvc3RcIikge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHRcdHJlcG8gPSBgaHR0cHM6Ly8ke3JlcG9XaXRob3V0UmVmfWA7XG5cdH1cblxuXHRjb25zdCBub3JtYWxpemVkUGF0aCA9IHBhdGgucmVwbGFjZSgvXFwuZ2l0JC8sIFwiXCIpLnJlcGxhY2UoL15cXC8rLywgXCJcIik7XG5cdGlmICghaG9zdCB8fCAhbm9ybWFsaXplZFBhdGggfHwgbm9ybWFsaXplZFBhdGguc3BsaXQoXCIvXCIpLmxlbmd0aCA8IDIpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0dHlwZTogXCJnaXRcIixcblx0XHRyZXBvLFxuXHRcdGhvc3QsXG5cdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXG5cdFx0cmVmLFxuXHRcdHBpbm5lZDogQm9vbGVhbihyZWYpLFxuXHR9O1xufVxuXG4vKipcbiAqIFBhcnNlIGdpdCBzb3VyY2UgaW50byBhIEdpdFNvdXJjZS5cbiAqXG4gKiBSdWxlczpcbiAqIC0gV2l0aCBnaXQ6IHByZWZpeCwgYWNjZXB0IGFsbCBoaXN0b3JpY2FsIHNob3J0aGFuZCBmb3Jtcy5cbiAqIC0gV2l0aG91dCBnaXQ6IHByZWZpeCwgb25seSBhY2NlcHQgZXhwbGljaXQgcHJvdG9jb2wgVVJMcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlR2l0VXJsKHNvdXJjZTogc3RyaW5nKTogR2l0U291cmNlIHwgbnVsbCB7XG5cdGNvbnN0IHRyaW1tZWQgPSBzb3VyY2UudHJpbSgpO1xuXHRjb25zdCBoYXNHaXRQcmVmaXggPSB0cmltbWVkLnN0YXJ0c1dpdGgoXCJnaXQ6XCIpO1xuXHRjb25zdCB1cmwgPSBoYXNHaXRQcmVmaXggPyB0cmltbWVkLnNsaWNlKDQpLnRyaW0oKSA6IHRyaW1tZWQ7XG5cblx0aWYgKCFoYXNHaXRQcmVmaXggJiYgIS9eKGh0dHBzP3xzc2h8Z2l0KTpcXC9cXC8vaS50ZXN0KHVybCkpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHNwbGl0ID0gc3BsaXRSZWYodXJsKTtcblxuXHRjb25zdCBob3N0ZWRDYW5kaWRhdGVzID0gW3NwbGl0LnJlZiA/IGAke3NwbGl0LnJlcG99IyR7c3BsaXQucmVmfWAgOiB1bmRlZmluZWQsIHVybF0uZmlsdGVyKFxuXHRcdCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiBCb29sZWFuKHZhbHVlKSxcblx0KTtcblx0Zm9yIChjb25zdCBjYW5kaWRhdGUgb2YgaG9zdGVkQ2FuZGlkYXRlcykge1xuXHRcdGNvbnN0IGluZm8gPSBob3N0ZWRHaXRJbmZvLmZyb21VcmwoY2FuZGlkYXRlKTtcblx0XHRpZiAoaW5mbykge1xuXHRcdFx0aWYgKHNwbGl0LnJlZiAmJiBpbmZvLnByb2plY3Q/LmluY2x1ZGVzKFwiQFwiKSkge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHVzZUh0dHBzUHJlZml4ID1cblx0XHRcdFx0IXNwbGl0LnJlcG8uc3RhcnRzV2l0aChcImh0dHA6Ly9cIikgJiZcblx0XHRcdFx0IXNwbGl0LnJlcG8uc3RhcnRzV2l0aChcImh0dHBzOi8vXCIpICYmXG5cdFx0XHRcdCFzcGxpdC5yZXBvLnN0YXJ0c1dpdGgoXCJzc2g6Ly9cIikgJiZcblx0XHRcdFx0IXNwbGl0LnJlcG8uc3RhcnRzV2l0aChcImdpdDovL1wiKSAmJlxuXHRcdFx0XHQhc3BsaXQucmVwby5zdGFydHNXaXRoKFwiZ2l0QFwiKTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6IFwiZ2l0XCIsXG5cdFx0XHRcdHJlcG86IHVzZUh0dHBzUHJlZml4ID8gYGh0dHBzOi8vJHtzcGxpdC5yZXBvfWAgOiBzcGxpdC5yZXBvLFxuXHRcdFx0XHRob3N0OiBpbmZvLmRvbWFpbiB8fCBcIlwiLFxuXHRcdFx0XHRwYXRoOiBgJHtpbmZvLnVzZXJ9LyR7aW5mby5wcm9qZWN0fWAucmVwbGFjZSgvXFwuZ2l0JC8sIFwiXCIpLFxuXHRcdFx0XHRyZWY6IGluZm8uY29tbWl0dGlzaCB8fCBzcGxpdC5yZWYgfHwgdW5kZWZpbmVkLFxuXHRcdFx0XHRwaW5uZWQ6IEJvb2xlYW4oaW5mby5jb21taXR0aXNoIHx8IHNwbGl0LnJlZiksXG5cdFx0XHR9O1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IGh0dHBzQ2FuZGlkYXRlcyA9IFtzcGxpdC5yZWYgPyBgaHR0cHM6Ly8ke3NwbGl0LnJlcG99IyR7c3BsaXQucmVmfWAgOiB1bmRlZmluZWQsIGBodHRwczovLyR7dXJsfWBdLmZpbHRlcihcblx0XHQodmFsdWUpOiB2YWx1ZSBpcyBzdHJpbmcgPT4gQm9vbGVhbih2YWx1ZSksXG5cdCk7XG5cdGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGh0dHBzQ2FuZGlkYXRlcykge1xuXHRcdGNvbnN0IGluZm8gPSBob3N0ZWRHaXRJbmZvLmZyb21VcmwoY2FuZGlkYXRlKTtcblx0XHRpZiAoaW5mbykge1xuXHRcdFx0aWYgKHNwbGl0LnJlZiAmJiBpbmZvLnByb2plY3Q/LmluY2x1ZGVzKFwiQFwiKSkge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6IFwiZ2l0XCIsXG5cdFx0XHRcdHJlcG86IGBodHRwczovLyR7c3BsaXQucmVwb31gLFxuXHRcdFx0XHRob3N0OiBpbmZvLmRvbWFpbiB8fCBcIlwiLFxuXHRcdFx0XHRwYXRoOiBgJHtpbmZvLnVzZXJ9LyR7aW5mby5wcm9qZWN0fWAucmVwbGFjZSgvXFwuZ2l0JC8sIFwiXCIpLFxuXHRcdFx0XHRyZWY6IGluZm8uY29tbWl0dGlzaCB8fCBzcGxpdC5yZWYgfHwgdW5kZWZpbmVkLFxuXHRcdFx0XHRwaW5uZWQ6IEJvb2xlYW4oaW5mby5jb21taXR0aXNoIHx8IHNwbGl0LnJlZiksXG5cdFx0XHR9O1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBwYXJzZUdlbmVyaWNHaXRVcmwodXJsKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sbUJBQW1CO0FBb0IxQixTQUFTLFNBQVMsS0FBNkM7QUFDOUQsUUFBTSxlQUFlLElBQUksTUFBTSxvQkFBb0I7QUFDbkQsTUFBSSxjQUFjO0FBQ2pCLFVBQU1BLG9CQUFtQixhQUFhLENBQUMsS0FBSztBQUM1QyxVQUFNQyxnQkFBZUQsa0JBQWlCLFFBQVEsR0FBRztBQUNqRCxRQUFJQyxnQkFBZSxFQUFH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
