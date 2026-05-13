async function* parseNDJsonStream(body, signal, strict = false) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed);
        } catch (err) {
          if (strict) {
            throw new Error(
              `Malformed NDJSON line from Ollama: ${trimmed.slice(0, 200)}`
            );
          }
        }
      }
    }
    if (buffer.trim() && !signal?.aborted) {
      try {
        yield JSON.parse(buffer.trim());
      } catch (err) {
        if (strict) {
          throw new Error(
            `Malformed NDJSON line from Ollama: ${buffer.trim().slice(0, 200)}`
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
export {
  parseNDJsonStream
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS9uZGpzb24tc3RyZWFtLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFx1MjAxNCBPbGxhbWEgRXh0ZW5zaW9uOiBOREpTT04gc3RyZWFtaW5nIHBhcnNlclxuXG4vKipcbiAqIFBhcnNlcyBhIHN0cmVhbWluZyBOREpTT04gKG5ld2xpbmUtZGVsaW1pdGVkIEpTT04pIHJlc3BvbnNlIGJvZHkgaW50b1xuICogdHlwZWQgb2JqZWN0cy4gVXNlZCBmb3IgT2xsYW1hJ3MgL2FwaS9jaGF0IGFuZCAvYXBpL3B1bGwgZW5kcG9pbnRzLlxuICpcbiAqIEBwYXJhbSBzdHJpY3QgV2hlbiB0cnVlLCBtYWxmb3JtZWQgSlNPTiBsaW5lcyB0aHJvdyBpbnN0ZWFkIG9mIGJlaW5nIHNraXBwZWQuXG4gKiAgIFVzZSBzdHJpY3QgbW9kZSBmb3IgaW5mZXJlbmNlIHN0cmVhbXMgd2hlcmUgc2lsZW50IGRhdGEgbG9zcyBpcyB1bmFjY2VwdGFibGUuXG4gKiAgIFVzZSBwZXJtaXNzaXZlIG1vZGUgKGRlZmF1bHQpIGZvciBwcm9ncmVzcyBlbmRwb2ludHMgbGlrZSAvYXBpL3B1bGwuXG4gKi9cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uKiBwYXJzZU5ESnNvblN0cmVhbTxUPihcblx0Ym9keTogUmVhZGFibGVTdHJlYW08VWludDhBcnJheT4sXG5cdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHRzdHJpY3QgPSBmYWxzZSxcbik6IEFzeW5jR2VuZXJhdG9yPFQ+IHtcblx0Y29uc3QgcmVhZGVyID0gYm9keS5nZXRSZWFkZXIoKTtcblx0Y29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuXHRsZXQgYnVmZmVyID0gXCJcIjtcblxuXHR0cnkge1xuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRpZiAoc2lnbmFsPy5hYm9ydGVkKSBicmVhaztcblxuXHRcdFx0Y29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcblx0XHRcdGlmIChkb25lKSBicmVhaztcblxuXHRcdFx0YnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblx0XHRcdGNvbnN0IGxpbmVzID0gYnVmZmVyLnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0YnVmZmVyID0gbGluZXMucG9wKCkgPz8gXCJcIjtcblxuXHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG5cdFx0XHRcdGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcblx0XHRcdFx0aWYgKCF0cmltbWVkKSBjb250aW51ZTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHR5aWVsZCBKU09OLnBhcnNlKHRyaW1tZWQpIGFzIFQ7XG5cdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdGlmIChzdHJpY3QpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdFx0YE1hbGZvcm1lZCBOREpTT04gbGluZSBmcm9tIE9sbGFtYTogJHt0cmltbWVkLnNsaWNlKDAsIDIwMCl9YCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdC8vIFBlcm1pc3NpdmUgbW9kZTogc2tpcCBtYWxmb3JtZWQgbGluZXNcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEZsdXNoIHJlbWFpbmluZyBidWZmZXIgKHNraXAgaWYgYWJvcnRlZClcblx0XHRpZiAoYnVmZmVyLnRyaW0oKSAmJiAhc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHR5aWVsZCBKU09OLnBhcnNlKGJ1ZmZlci50cmltKCkpIGFzIFQ7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aWYgKHN0cmljdCkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdGBNYWxmb3JtZWQgTkRKU09OIGxpbmUgZnJvbSBPbGxhbWE6ICR7YnVmZmVyLnRyaW0oKS5zbGljZSgwLCAyMDApfWAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fSBmaW5hbGx5IHtcblx0XHRyZWFkZXIucmVsZWFzZUxvY2soKTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0EsZ0JBQXVCLGtCQUN0QixNQUNBLFFBQ0EsU0FBUyxPQUNXO0FBQ3BCLFFBQU0sU0FBUyxLQUFLLFVBQVU7QUFDOUIsUUFBTSxVQUFVLElBQUksWUFBWTtBQUNoQyxNQUFJLFNBQVM7QUFFYixNQUFJO0FBQ0gsV0FBTyxNQUFNO0FBQ1osVUFBSSxRQUFRLFFBQVM7QUFFckIsWUFBTSxFQUFFLE1BQU0sTUFBTSxJQUFJLE1BQU0sT0FBTyxLQUFLO0FBQzFDLFVBQUksS0FBTTtBQUVWLGdCQUFVLFFBQVEsT0FBTyxPQUFPLEVBQUUsUUFBUSxLQUFLLENBQUM7QUFDaEQsWUFBTSxRQUFRLE9BQU8sTUFBTSxJQUFJO0FBQy9CLGVBQVMsTUFBTSxJQUFJLEtBQUs7QUFFeEIsaUJBQVcsUUFBUSxPQUFPO0FBQ3pCLGNBQU0sVUFBVSxLQUFLLEtBQUs7QUFDMUIsWUFBSSxDQUFDLFFBQVM7QUFDZCxZQUFJO0FBQ0gsZ0JBQU0sS0FBSyxNQUFNLE9BQU87QUFBQSxRQUN6QixTQUFTLEtBQUs7QUFDYixjQUFJLFFBQVE7QUFDWCxrQkFBTSxJQUFJO0FBQUEsY0FDVCxzQ0FBc0MsUUFBUSxNQUFNLEdBQUcsR0FBRyxDQUFDO0FBQUEsWUFDNUQ7QUFBQSxVQUNEO0FBQUEsUUFFRDtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBR0EsUUFBSSxPQUFPLEtBQUssS0FBSyxDQUFDLFFBQVEsU0FBUztBQUN0QyxVQUFJO0FBQ0gsY0FBTSxLQUFLLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUMvQixTQUFTLEtBQUs7QUFDYixZQUFJLFFBQVE7QUFDWCxnQkFBTSxJQUFJO0FBQUEsWUFDVCxzQ0FBc0MsT0FBTyxLQUFLLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQztBQUFBLFVBQ2xFO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxVQUFFO0FBQ0QsV0FBTyxZQUFZO0FBQUEsRUFDcEI7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
