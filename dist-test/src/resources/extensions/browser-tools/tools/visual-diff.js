import { Type } from "@sinclair/typebox";
const BASELINE_DIR = ".gsd/browser-baselines";
function registerVisualDiffTools(pi, deps) {
  pi.registerTool({
    name: "browser_visual_diff",
    label: "Browser Visual Diff",
    description: "Compare current page screenshot against a stored baseline pixel-by-pixel. Returns similarity score (0\u20131), diff pixel count, and optionally generates a diff image highlighting changes. On first run with no baseline, saves the current screenshot as the baseline. Baselines are stored in .gsd/browser-baselines/ (gitignored, environment-specific).",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: "Baseline name (default: auto-generated from URL + viewport). Use consistent names to compare the same view across runs."
        })
      ),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to scope comparison to a specific element instead of full viewport."
        })
      ),
      threshold: Type.Optional(
        Type.Number({
          description: "Pixel matching threshold 0\u20131 (default: 0.1). Higher values are more tolerant of anti-aliasing and rendering differences."
        })
      ),
      updateBaseline: Type.Optional(
        Type.Boolean({
          description: "If true, overwrite the existing baseline with the current screenshot (default: false)."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const { mkdir, readFile, writeFile } = await import("node:fs/promises");
        const pathMod = await import("node:path");
        const baselineDir = pathMod.resolve(process.cwd(), BASELINE_DIR);
        await mkdir(baselineDir, { recursive: true });
        const gitignorePath = pathMod.join(baselineDir, ".gitignore");
        await writeFile(gitignorePath, "*\n!.gitignore\n").catch(() => {
        });
        const url = p.url();
        const viewport = p.viewportSize();
        const vpSuffix = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        const autoName = deps.sanitizeArtifactName(
          `${new URL(url).pathname.replace(/\//g, "-")}-${vpSuffix}`,
          `baseline-${vpSuffix}`
        );
        const name = deps.sanitizeArtifactName(params.name ?? autoName, autoName);
        const baselinePath = pathMod.join(baselineDir, `${name}.png`);
        const diffPath = pathMod.join(baselineDir, `${name}-diff.png`);
        let currentBuffer;
        if (params.selector) {
          const locator = p.locator(params.selector).first();
          currentBuffer = await locator.screenshot({ type: "png" });
        } else {
          currentBuffer = await p.screenshot({ type: "png", fullPage: false });
        }
        let baselineBuffer = null;
        try {
          baselineBuffer = await readFile(baselinePath);
        } catch {
        }
        if (!baselineBuffer || params.updateBaseline) {
          await writeFile(baselinePath, currentBuffer);
          return {
            content: [{
              type: "text",
              text: baselineBuffer ? `Baseline updated: ${baselinePath}
Size: ${(currentBuffer.length / 1024).toFixed(1)} KB` : `Baseline created (first run): ${baselinePath}
Size: ${(currentBuffer.length / 1024).toFixed(1)} KB
Re-run to compare against this baseline.`
            }],
            details: {
              baselinePath,
              baselineCreated: !baselineBuffer,
              baselineUpdated: !!baselineBuffer,
              sizeBytes: currentBuffer.length
            }
          };
        }
        const sharp = (await import("sharp")).default;
        const baselineMeta = await sharp(baselineBuffer).metadata();
        const currentMeta = await sharp(currentBuffer).metadata();
        const bWidth = baselineMeta.width ?? 0;
        const bHeight = baselineMeta.height ?? 0;
        const cWidth = currentMeta.width ?? 0;
        const cHeight = currentMeta.height ?? 0;
        if (bWidth !== cWidth || bHeight !== cHeight) {
          return {
            content: [{
              type: "text",
              text: `Dimension mismatch: baseline is ${bWidth}x${bHeight}, current is ${cWidth}x${cHeight}. Cannot compare.
Use updateBaseline: true to reset.`
            }],
            details: {
              match: false,
              dimensionMismatch: true,
              baselineDimensions: { width: bWidth, height: bHeight },
              currentDimensions: { width: cWidth, height: cHeight }
            }
          };
        }
        const baselineRaw = await sharp(baselineBuffer).ensureAlpha().raw().toBuffer();
        const currentRaw = await sharp(currentBuffer).ensureAlpha().raw().toBuffer();
        const width = bWidth;
        const height = bHeight;
        const totalPixels = width * height;
        const threshold = params.threshold ?? 0.1;
        const diffData = Buffer.alloc(width * height * 4);
        let diffPixels = 0;
        const thresholdSq = threshold * threshold * 255 * 255 * 3;
        for (let i = 0; i < totalPixels; i++) {
          const offset = i * 4;
          const dr = baselineRaw[offset] - currentRaw[offset];
          const dg = baselineRaw[offset + 1] - currentRaw[offset + 1];
          const db = baselineRaw[offset + 2] - currentRaw[offset + 2];
          const distSq = dr * dr + dg * dg + db * db;
          if (distSq > thresholdSq) {
            diffPixels++;
            diffData[offset] = 255;
            diffData[offset + 1] = 0;
            diffData[offset + 2] = 0;
            diffData[offset + 3] = 255;
          } else {
            diffData[offset] = currentRaw[offset] >> 1;
            diffData[offset + 1] = currentRaw[offset + 1] >> 1;
            diffData[offset + 2] = currentRaw[offset + 2] >> 1;
            diffData[offset + 3] = 255;
          }
        }
        const similarity = 1 - diffPixels / totalPixels;
        const match = diffPixels === 0;
        await sharp(diffData, { raw: { width, height, channels: 4 } }).png().toFile(diffPath);
        return {
          content: [{
            type: "text",
            text: match ? `Visual diff: MATCH (100% similar)
Baseline: ${baselinePath}` : `Visual diff: ${(similarity * 100).toFixed(2)}% similar
Diff pixels: ${diffPixels} of ${totalPixels} (${(diffPixels / totalPixels * 100).toFixed(2)}%)
Diff image: ${diffPath}
Baseline: ${baselinePath}`
          }],
          details: {
            match,
            similarity,
            diffPixels,
            totalPixels,
            diffPercentage: diffPixels / totalPixels * 100,
            dimensions: { width, height },
            baselinePath,
            diffImagePath: match ? void 0 : diffPath,
            threshold
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Visual diff failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerVisualDiffTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvdmlzdWFsLWRpZmYudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5cbi8qKlxuICogVmlzdWFsIHJlZ3Jlc3Npb24gZGlmZmluZyBcdTIwMTQgY29tcGFyZSBjdXJyZW50IHBhZ2Ugc2NyZWVuc2hvdCBhZ2FpbnN0IGEgc3RvcmVkIGJhc2VsaW5lLlxuICovXG5cbmNvbnN0IEJBU0VMSU5FX0RJUiA9IFwiLmdzZC9icm93c2VyLWJhc2VsaW5lc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJWaXN1YWxEaWZmVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfdmlzdWFsX2RpZmZcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIFZpc3VhbCBEaWZmXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkNvbXBhcmUgY3VycmVudCBwYWdlIHNjcmVlbnNob3QgYWdhaW5zdCBhIHN0b3JlZCBiYXNlbGluZSBwaXhlbC1ieS1waXhlbC4gXCIgK1xuXHRcdFx0XCJSZXR1cm5zIHNpbWlsYXJpdHkgc2NvcmUgKDBcdTIwMTMxKSwgZGlmZiBwaXhlbCBjb3VudCwgYW5kIG9wdGlvbmFsbHkgZ2VuZXJhdGVzIGEgZGlmZiBpbWFnZSBoaWdobGlnaHRpbmcgY2hhbmdlcy4gXCIgK1xuXHRcdFx0XCJPbiBmaXJzdCBydW4gd2l0aCBubyBiYXNlbGluZSwgc2F2ZXMgdGhlIGN1cnJlbnQgc2NyZWVuc2hvdCBhcyB0aGUgYmFzZWxpbmUuIFwiICtcblx0XHRcdFwiQmFzZWxpbmVzIGFyZSBzdG9yZWQgaW4gLmdzZC9icm93c2VyLWJhc2VsaW5lcy8gKGdpdGlnbm9yZWQsIGVudmlyb25tZW50LXNwZWNpZmljKS5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRuYW1lOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIkJhc2VsaW5lIG5hbWUgKGRlZmF1bHQ6IGF1dG8tZ2VuZXJhdGVkIGZyb20gVVJMICsgdmlld3BvcnQpLiBcIiArXG5cdFx0XHRcdFx0XHRcIlVzZSBjb25zaXN0ZW50IG5hbWVzIHRvIGNvbXBhcmUgdGhlIHNhbWUgdmlldyBhY3Jvc3MgcnVucy5cIixcblx0XHRcdFx0fSksXG5cdFx0XHQpLFxuXHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJDU1Mgc2VsZWN0b3IgdG8gc2NvcGUgY29tcGFyaXNvbiB0byBhIHNwZWNpZmljIGVsZW1lbnQgaW5zdGVhZCBvZiBmdWxsIHZpZXdwb3J0LlwiLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0XHR0aHJlc2hvbGQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiUGl4ZWwgbWF0Y2hpbmcgdGhyZXNob2xkIDBcdTIwMTMxIChkZWZhdWx0OiAwLjEpLiBcIiArXG5cdFx0XHRcdFx0XHRcIkhpZ2hlciB2YWx1ZXMgYXJlIG1vcmUgdG9sZXJhbnQgb2YgYW50aS1hbGlhc2luZyBhbmQgcmVuZGVyaW5nIGRpZmZlcmVuY2VzLlwiLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0XHR1cGRhdGVCYXNlbGluZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJJZiB0cnVlLCBvdmVyd3JpdGUgdGhlIGV4aXN0aW5nIGJhc2VsaW5lIHdpdGggdGhlIGN1cnJlbnQgc2NyZWVuc2hvdCAoZGVmYXVsdDogZmFsc2UpLlwiLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgeyBta2RpciwgcmVhZEZpbGUsIHdyaXRlRmlsZSB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmcy9wcm9taXNlc1wiKTtcblx0XHRcdFx0Y29uc3QgcGF0aE1vZCA9IGF3YWl0IGltcG9ydChcIm5vZGU6cGF0aFwiKTtcblxuXHRcdFx0XHRjb25zdCBiYXNlbGluZURpciA9IHBhdGhNb2QucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLCBCQVNFTElORV9ESVIpO1xuXHRcdFx0XHRhd2FpdCBta2RpcihiYXNlbGluZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cblx0XHRcdFx0Ly8gRW5zdXJlIC5naXRpZ25vcmVcblx0XHRcdFx0Y29uc3QgZ2l0aWdub3JlUGF0aCA9IHBhdGhNb2Quam9pbihiYXNlbGluZURpciwgXCIuZ2l0aWdub3JlXCIpO1xuXHRcdFx0XHRhd2FpdCB3cml0ZUZpbGUoZ2l0aWdub3JlUGF0aCwgXCIqXFxuIS5naXRpZ25vcmVcXG5cIikuY2F0Y2goKCkgPT4geyAvKiBiZXN0LWVmZm9ydCBcdTIwMTQgLmdpdGlnbm9yZSBtYXkgYWxyZWFkeSBleGlzdCBvciBkaXIgbWF5IGJlIHJlYWQtb25seSAqLyB9KTtcblxuXHRcdFx0XHQvLyBHZW5lcmF0ZSBiYXNlbGluZSBuYW1lXG5cdFx0XHRcdGNvbnN0IHVybCA9IHAudXJsKCk7XG5cdFx0XHRcdGNvbnN0IHZpZXdwb3J0ID0gcC52aWV3cG9ydFNpemUoKTtcblx0XHRcdFx0Y29uc3QgdnBTdWZmaXggPSB2aWV3cG9ydCA/IGAke3ZpZXdwb3J0LndpZHRofXgke3ZpZXdwb3J0LmhlaWdodH1gIDogXCJ1bmtub3duXCI7XG5cdFx0XHRcdGNvbnN0IGF1dG9OYW1lID0gZGVwcy5zYW5pdGl6ZUFydGlmYWN0TmFtZShcblx0XHRcdFx0XHRgJHtuZXcgVVJMKHVybCkucGF0aG5hbWUucmVwbGFjZSgvXFwvL2csIFwiLVwiKX0tJHt2cFN1ZmZpeH1gLFxuXHRcdFx0XHRcdGBiYXNlbGluZS0ke3ZwU3VmZml4fWAsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGNvbnN0IG5hbWUgPSBkZXBzLnNhbml0aXplQXJ0aWZhY3ROYW1lKHBhcmFtcy5uYW1lID8/IGF1dG9OYW1lLCBhdXRvTmFtZSk7XG5cblx0XHRcdFx0Y29uc3QgYmFzZWxpbmVQYXRoID0gcGF0aE1vZC5qb2luKGJhc2VsaW5lRGlyLCBgJHtuYW1lfS5wbmdgKTtcblx0XHRcdFx0Y29uc3QgZGlmZlBhdGggPSBwYXRoTW9kLmpvaW4oYmFzZWxpbmVEaXIsIGAke25hbWV9LWRpZmYucG5nYCk7XG5cblx0XHRcdFx0Ly8gQ2FwdHVyZSBjdXJyZW50IHNjcmVlbnNob3QgYXMgUE5HIChuZWVkZWQgZm9yIHBpeGVsIGNvbXBhcmlzb24pXG5cdFx0XHRcdGxldCBjdXJyZW50QnVmZmVyOiBCdWZmZXI7XG5cdFx0XHRcdGlmIChwYXJhbXMuc2VsZWN0b3IpIHtcblx0XHRcdFx0XHRjb25zdCBsb2NhdG9yID0gcC5sb2NhdG9yKHBhcmFtcy5zZWxlY3RvcikuZmlyc3QoKTtcblx0XHRcdFx0XHRjdXJyZW50QnVmZmVyID0gYXdhaXQgbG9jYXRvci5zY3JlZW5zaG90KHsgdHlwZTogXCJwbmdcIiB9KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRjdXJyZW50QnVmZmVyID0gYXdhaXQgcC5zY3JlZW5zaG90KHsgdHlwZTogXCJwbmdcIiwgZnVsbFBhZ2U6IGZhbHNlIH0pO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQ2hlY2sgaWYgYmFzZWxpbmUgZXhpc3RzXG5cdFx0XHRcdGxldCBiYXNlbGluZUJ1ZmZlcjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0YmFzZWxpbmVCdWZmZXIgPSBhd2FpdCByZWFkRmlsZShiYXNlbGluZVBhdGgpIGFzIEJ1ZmZlcjtcblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Ly8gTm8gYmFzZWxpbmUgeWV0XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoIWJhc2VsaW5lQnVmZmVyIHx8IHBhcmFtcy51cGRhdGVCYXNlbGluZSkge1xuXHRcdFx0XHRcdC8vIFNhdmUgYXMgbmV3IGJhc2VsaW5lXG5cdFx0XHRcdFx0YXdhaXQgd3JpdGVGaWxlKGJhc2VsaW5lUGF0aCwgY3VycmVudEJ1ZmZlcik7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBiYXNlbGluZUJ1ZmZlclxuXHRcdFx0XHRcdFx0XHRcdD8gYEJhc2VsaW5lIHVwZGF0ZWQ6ICR7YmFzZWxpbmVQYXRofVxcblNpemU6ICR7KGN1cnJlbnRCdWZmZXIubGVuZ3RoIC8gMTAyNCkudG9GaXhlZCgxKX0gS0JgXG5cdFx0XHRcdFx0XHRcdFx0OiBgQmFzZWxpbmUgY3JlYXRlZCAoZmlyc3QgcnVuKTogJHtiYXNlbGluZVBhdGh9XFxuU2l6ZTogJHsoY3VycmVudEJ1ZmZlci5sZW5ndGggLyAxMDI0KS50b0ZpeGVkKDEpfSBLQlxcblJlLXJ1biB0byBjb21wYXJlIGFnYWluc3QgdGhpcyBiYXNlbGluZS5gLFxuXHRcdFx0XHRcdFx0fV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRcdGJhc2VsaW5lUGF0aCxcblx0XHRcdFx0XHRcdFx0YmFzZWxpbmVDcmVhdGVkOiAhYmFzZWxpbmVCdWZmZXIsXG5cdFx0XHRcdFx0XHRcdGJhc2VsaW5lVXBkYXRlZDogISFiYXNlbGluZUJ1ZmZlcixcblx0XHRcdFx0XHRcdFx0c2l6ZUJ5dGVzOiBjdXJyZW50QnVmZmVyLmxlbmd0aCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFBlcmZvcm0gcGl4ZWwgY29tcGFyaXNvbiB1c2luZyBzaGFycCBmb3IgUE5HIGRlY29kaW5nXG5cdFx0XHRcdGNvbnN0IHNoYXJwID0gKGF3YWl0IGltcG9ydChcInNoYXJwXCIpKS5kZWZhdWx0O1xuXG5cdFx0XHRcdGNvbnN0IGJhc2VsaW5lTWV0YSA9IGF3YWl0IHNoYXJwKGJhc2VsaW5lQnVmZmVyKS5tZXRhZGF0YSgpO1xuXHRcdFx0XHRjb25zdCBjdXJyZW50TWV0YSA9IGF3YWl0IHNoYXJwKGN1cnJlbnRCdWZmZXIpLm1ldGFkYXRhKCk7XG5cblx0XHRcdFx0Y29uc3QgYldpZHRoID0gYmFzZWxpbmVNZXRhLndpZHRoID8/IDA7XG5cdFx0XHRcdGNvbnN0IGJIZWlnaHQgPSBiYXNlbGluZU1ldGEuaGVpZ2h0ID8/IDA7XG5cdFx0XHRcdGNvbnN0IGNXaWR0aCA9IGN1cnJlbnRNZXRhLndpZHRoID8/IDA7XG5cdFx0XHRcdGNvbnN0IGNIZWlnaHQgPSBjdXJyZW50TWV0YS5oZWlnaHQgPz8gMDtcblxuXHRcdFx0XHQvLyBJZiBkaW1lbnNpb25zIGRpZmZlciwgcmVwb3J0IG1pc21hdGNoXG5cdFx0XHRcdGlmIChiV2lkdGggIT09IGNXaWR0aCB8fCBiSGVpZ2h0ICE9PSBjSGVpZ2h0KSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgRGltZW5zaW9uIG1pc21hdGNoOiBiYXNlbGluZSBpcyAke2JXaWR0aH14JHtiSGVpZ2h0fSwgY3VycmVudCBpcyAke2NXaWR0aH14JHtjSGVpZ2h0fS4gQ2Fubm90IGNvbXBhcmUuXFxuVXNlIHVwZGF0ZUJhc2VsaW5lOiB0cnVlIHRvIHJlc2V0LmAsXG5cdFx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdFx0bWF0Y2g6IGZhbHNlLFxuXHRcdFx0XHRcdFx0XHRkaW1lbnNpb25NaXNtYXRjaDogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0YmFzZWxpbmVEaW1lbnNpb25zOiB7IHdpZHRoOiBiV2lkdGgsIGhlaWdodDogYkhlaWdodCB9LFxuXHRcdFx0XHRcdFx0XHRjdXJyZW50RGltZW5zaW9uczogeyB3aWR0aDogY1dpZHRoLCBoZWlnaHQ6IGNIZWlnaHQgfSxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIEV4dHJhY3QgcmF3IFJHQkEgcGl4ZWwgZGF0YVxuXHRcdFx0XHRjb25zdCBiYXNlbGluZVJhdyA9IGF3YWl0IHNoYXJwKGJhc2VsaW5lQnVmZmVyKS5lbnN1cmVBbHBoYSgpLnJhdygpLnRvQnVmZmVyKCk7XG5cdFx0XHRcdGNvbnN0IGN1cnJlbnRSYXcgPSBhd2FpdCBzaGFycChjdXJyZW50QnVmZmVyKS5lbnN1cmVBbHBoYSgpLnJhdygpLnRvQnVmZmVyKCk7XG5cblx0XHRcdFx0Y29uc3Qgd2lkdGggPSBiV2lkdGg7XG5cdFx0XHRcdGNvbnN0IGhlaWdodCA9IGJIZWlnaHQ7XG5cdFx0XHRcdGNvbnN0IHRvdGFsUGl4ZWxzID0gd2lkdGggKiBoZWlnaHQ7XG5cdFx0XHRcdGNvbnN0IHRocmVzaG9sZCA9IHBhcmFtcy50aHJlc2hvbGQgPz8gMC4xO1xuXG5cdFx0XHRcdC8vIFNpbXBsZSBwaXhlbC1ieS1waXhlbCBjb21wYXJpc29uIChhdm9pZGluZyBwaXhlbG1hdGNoIGRlcGVuZGVuY3kpXG5cdFx0XHRcdGNvbnN0IGRpZmZEYXRhID0gQnVmZmVyLmFsbG9jKHdpZHRoICogaGVpZ2h0ICogNCk7XG5cdFx0XHRcdGxldCBkaWZmUGl4ZWxzID0gMDtcblx0XHRcdFx0Y29uc3QgdGhyZXNob2xkU3EgPSB0aHJlc2hvbGQgKiB0aHJlc2hvbGQgKiAyNTUgKiAyNTUgKiAzO1xuXG5cdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgdG90YWxQaXhlbHM7IGkrKykge1xuXHRcdFx0XHRcdGNvbnN0IG9mZnNldCA9IGkgKiA0O1xuXHRcdFx0XHRcdGNvbnN0IGRyID0gYmFzZWxpbmVSYXdbb2Zmc2V0XSAtIGN1cnJlbnRSYXdbb2Zmc2V0XTtcblx0XHRcdFx0XHRjb25zdCBkZyA9IGJhc2VsaW5lUmF3W29mZnNldCArIDFdIC0gY3VycmVudFJhd1tvZmZzZXQgKyAxXTtcblx0XHRcdFx0XHRjb25zdCBkYiA9IGJhc2VsaW5lUmF3W29mZnNldCArIDJdIC0gY3VycmVudFJhd1tvZmZzZXQgKyAyXTtcblx0XHRcdFx0XHRjb25zdCBkaXN0U3EgPSBkciAqIGRyICsgZGcgKiBkZyArIGRiICogZGI7XG5cblx0XHRcdFx0XHRpZiAoZGlzdFNxID4gdGhyZXNob2xkU3EpIHtcblx0XHRcdFx0XHRcdGRpZmZQaXhlbHMrKztcblx0XHRcdFx0XHRcdC8vIE1hcmsgZGlmZiBwaXhlbHMgYXMgcmVkXG5cdFx0XHRcdFx0XHRkaWZmRGF0YVtvZmZzZXRdID0gMjU1OyAgICAgLy8gUlxuXHRcdFx0XHRcdFx0ZGlmZkRhdGFbb2Zmc2V0ICsgMV0gPSAwOyAgIC8vIEdcblx0XHRcdFx0XHRcdGRpZmZEYXRhW29mZnNldCArIDJdID0gMDsgICAvLyBCXG5cdFx0XHRcdFx0XHRkaWZmRGF0YVtvZmZzZXQgKyAzXSA9IDI1NTsgLy8gQVxuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHQvLyBEaW0gdW5jaGFuZ2VkIHBpeGVsc1xuXHRcdFx0XHRcdFx0ZGlmZkRhdGFbb2Zmc2V0XSA9IGN1cnJlbnRSYXdbb2Zmc2V0XSA+PiAxO1xuXHRcdFx0XHRcdFx0ZGlmZkRhdGFbb2Zmc2V0ICsgMV0gPSBjdXJyZW50UmF3W29mZnNldCArIDFdID4+IDE7XG5cdFx0XHRcdFx0XHRkaWZmRGF0YVtvZmZzZXQgKyAyXSA9IGN1cnJlbnRSYXdbb2Zmc2V0ICsgMl0gPj4gMTtcblx0XHRcdFx0XHRcdGRpZmZEYXRhW29mZnNldCArIDNdID0gMjU1O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHNpbWlsYXJpdHkgPSAxIC0gKGRpZmZQaXhlbHMgLyB0b3RhbFBpeGVscyk7XG5cdFx0XHRcdGNvbnN0IG1hdGNoID0gZGlmZlBpeGVscyA9PT0gMDtcblxuXHRcdFx0XHQvLyBTYXZlIGRpZmYgaW1hZ2Vcblx0XHRcdFx0YXdhaXQgc2hhcnAoZGlmZkRhdGEsIHsgcmF3OiB7IHdpZHRoLCBoZWlnaHQsIGNoYW5uZWxzOiA0IH0gfSlcblx0XHRcdFx0XHQucG5nKClcblx0XHRcdFx0XHQudG9GaWxlKGRpZmZQYXRoKTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IG1hdGNoXG5cdFx0XHRcdFx0XHRcdD8gYFZpc3VhbCBkaWZmOiBNQVRDSCAoMTAwJSBzaW1pbGFyKVxcbkJhc2VsaW5lOiAke2Jhc2VsaW5lUGF0aH1gXG5cdFx0XHRcdFx0XHRcdDogYFZpc3VhbCBkaWZmOiAkeyhzaW1pbGFyaXR5ICogMTAwKS50b0ZpeGVkKDIpfSUgc2ltaWxhclxcbkRpZmYgcGl4ZWxzOiAke2RpZmZQaXhlbHN9IG9mICR7dG90YWxQaXhlbHN9ICgkeygoZGlmZlBpeGVscyAvIHRvdGFsUGl4ZWxzKSAqIDEwMCkudG9GaXhlZCgyKX0lKVxcbkRpZmYgaW1hZ2U6ICR7ZGlmZlBhdGh9XFxuQmFzZWxpbmU6ICR7YmFzZWxpbmVQYXRofWAsXG5cdFx0XHRcdFx0fV0sXG5cdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0bWF0Y2gsXG5cdFx0XHRcdFx0XHRzaW1pbGFyaXR5LFxuXHRcdFx0XHRcdFx0ZGlmZlBpeGVscyxcblx0XHRcdFx0XHRcdHRvdGFsUGl4ZWxzLFxuXHRcdFx0XHRcdFx0ZGlmZlBlcmNlbnRhZ2U6IChkaWZmUGl4ZWxzIC8gdG90YWxQaXhlbHMpICogMTAwLFxuXHRcdFx0XHRcdFx0ZGltZW5zaW9uczogeyB3aWR0aCwgaGVpZ2h0IH0sXG5cdFx0XHRcdFx0XHRiYXNlbGluZVBhdGgsXG5cdFx0XHRcdFx0XHRkaWZmSW1hZ2VQYXRoOiBtYXRjaCA/IHVuZGVmaW5lZCA6IGRpZmZQYXRoLFxuXHRcdFx0XHRcdFx0dGhyZXNob2xkLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVmlzdWFsIGRpZmYgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBT3JCLE1BQU0sZUFBZTtBQUVkLFNBQVMsd0JBQXdCLElBQWtCLE1BQXNCO0FBQy9FLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBSUQsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixNQUFNLEtBQUs7QUFBQSxRQUNWLEtBQUssT0FBTztBQUFBLFVBQ1gsYUFDQztBQUFBLFFBRUYsQ0FBQztBQUFBLE1BQ0Y7QUFBQSxNQUNBLFVBQVUsS0FBSztBQUFBLFFBQ2QsS0FBSyxPQUFPO0FBQUEsVUFDWCxhQUFhO0FBQUEsUUFDZCxDQUFDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsV0FBVyxL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
