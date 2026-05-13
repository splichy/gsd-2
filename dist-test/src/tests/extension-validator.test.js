import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkInstallDiscriminator,
  checkNamespaceReservation,
  checkDependencyPlacement,
  validateExtensionPackage
} from "../extension-validator.js";
describe("checkInstallDiscriminator", () => {
  test("returns null for valid gsd.extension === true", () => {
    const result = checkInstallDiscriminator({ gsd: { extension: true }, pi: { extensions: ["./index.ts"] } });
    assert.equal(result, null);
  });
  test("returns error when gsd section is missing", () => {
    const result = checkInstallDiscriminator({ pi: { extensions: ["./index.ts"] } });
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER");
    assert.equal(result.field, "gsd.extension");
  });
  test("returns error when gsd.extension is number 1 (not boolean true)", () => {
    const result = checkInstallDiscriminator({ gsd: { extension: 1 } });
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER", "strict === true check must reject numeric 1");
  });
  test("returns error when gsd.extension is string 'true'", () => {
    const result = checkInstallDiscriminator({ gsd: { extension: "true" } });
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER", "strict === true check must reject string 'true'");
  });
  test("returns error for null input", () => {
    const result = checkInstallDiscriminator(null);
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER");
  });
  test("returns error when gsd.extension is undefined", () => {
    const result = checkInstallDiscriminator({ gsd: {} });
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER");
    assert.equal(result.field, "gsd.extension");
  });
  test("returns error when gsd is an array (not object)", () => {
    const result = checkInstallDiscriminator({ gsd: ["extension"] });
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER");
  });
  test("returns error when input is a string (not object)", () => {
    const result = checkInstallDiscriminator('{"gsd":{"extension":true}}');
    assert.ok(result !== null);
    assert.equal(result.code, "MISSING_GSD_MARKER");
  });
});
describe("checkNamespaceReservation", () => {
  test("returns error for gsd. prefixed extension ID", () => {
    const result = checkNamespaceReservation("gsd.my-tool", {});
    assert.ok(result !== null);
    assert.equal(result.code, "RESERVED_NAMESPACE");
    assert.ok(result.message.includes("gsd.my-tool"), "error message should name the conflicting ID");
  });
  test("returns null when allowGsdNamespace is true", () => {
    const result = checkNamespaceReservation("gsd.my-tool", { allowGsdNamespace: true });
    assert.equal(result, null);
  });
  test("returns null for non-gsd namespace", () => {
    const result = checkNamespaceReservation("acme.my-tool", {});
    assert.equal(result, null);
  });
  test("returns null for bare extension ID", () => {
    const result = checkNamespaceReservation("my-tool", {});
    assert.equal(result, null);
  });
});
describe("checkDependencyPlacement", () => {
  test("returns error for @gsd/ package in dependencies", () => {
    const errors = checkDependencyPlacement({ dependencies: { "@gsd/pi-coding-agent": "^2.0.0" } });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "WRONG_DEP_FIELD");
    assert.ok(errors[0].message.includes("@gsd/pi-coding-agent"), "message must name exact package");
    assert.ok(errors[0].message.includes("dependencies"), "message must name exact field");
    assert.ok(errors[0].message.includes("peerDependencies"), "message must suggest the fix");
    assert.equal(errors[0].field, "dependencies");
  });
  test("returns error for @gsd/ package in devDependencies", () => {
    const errors = checkDependencyPlacement({ devDependencies: { "@gsd/pi-ai": "^1.0.0" } });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "WRONG_DEP_FIELD");
    assert.ok(errors[0].message.includes("@gsd/pi-ai"), "message must name exact package");
    assert.ok(errors[0].message.includes("devDependencies"), "message must name exact field");
    assert.equal(errors[0].field, "devDependencies");
  });
  test("does not flag @gsd/ in peerDependencies", () => {
    const errors = checkDependencyPlacement({ peerDependencies: { "@gsd/pi-coding-agent": ">=2.50.0" } });
    assert.equal(errors.length, 0, "peerDependencies is the correct placement \u2014 must not be flagged");
  });
  test("returns multiple errors for violations in both dependencies and devDependencies", () => {
    const errors = checkDependencyPlacement({
      dependencies: { "@gsd/pi-coding-agent": "^2.0.0" },
      devDependencies: { "@gsd/pi-ai": "^1.0.0" }
    });
    assert.equal(errors.length, 2);
    const fields = errors.map((e) => e.field);
    assert.ok(fields.includes("dependencies"));
    assert.ok(fields.includes("devDependencies"));
  });
  test("does not flag non-gsd packages", () => {
    const errors = checkDependencyPlacement({ dependencies: { "lodash": "^4.0.0" } });
    assert.equal(errors.length, 0);
  });
  test("handles missing dependency fields", () => {
    const errors = checkDependencyPlacement({});
    assert.equal(errors.length, 0);
  });
  test("returns empty errors when dependencies is a string instead of object", () => {
    const errors = checkDependencyPlacement({ dependencies: "@gsd/pi-coding-agent" });
    assert.equal(errors.length, 0, "string in dependencies field should be gracefully skipped");
  });
  test("returns empty errors when dependencies is null", () => {
    const errors = checkDependencyPlacement({ dependencies: null });
    assert.equal(errors.length, 0, "null dependencies should be gracefully skipped");
  });
  test("returns empty errors when dependencies is an array", () => {
    const errors = checkDependencyPlacement({ dependencies: ["@gsd/pi-coding-agent"] });
    assert.equal(errors.length, 0, "array in dependencies field should be gracefully skipped");
  });
});
describe("validateExtensionPackage", () => {
  test("returns valid for conforming package", () => {
    const result = validateExtensionPackage(
      { gsd: { extension: true }, peerDependencies: { "@gsd/pi-coding-agent": ">=2.50.0" } },
      { extensionId: "acme.browser" }
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });
  test("aggregates errors from multiple checks", () => {
    const result = validateExtensionPackage(
      { dependencies: { "@gsd/pi-ai": "^1.0.0" } },
      { extensionId: "gsd.bad" }
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 3, `expected >= 3 errors, got ${result.errors.length}: ${JSON.stringify(result.errors.map((e) => e.code))}`);
    const codes = result.errors.map((e) => e.code);
    assert.ok(codes.includes("MISSING_GSD_MARKER"));
    assert.ok(codes.includes("RESERVED_NAMESPACE"));
    assert.ok(codes.includes("WRONG_DEP_FIELD"));
  });
  test("valid is always errors.length === 0", () => {
    const validPkg = { gsd: { extension: true } };
    const validResult = validateExtensionPackage(validPkg, { extensionId: "acme.tool" });
    assert.equal(validResult.valid, true);
    assert.equal(validResult.errors.length, 0);
    const invalidPkg = { gsd: { extension: 1 } };
    const invalidResult = validateExtensionPackage(invalidPkg, { extensionId: "acme.tool" });
    assert.equal(invalidResult.valid, false);
    assert.ok(invalidResult.errors.length > 0);
  });
  test("adds warning when extensionId is not provided", () => {
    const result = validateExtensionPackage({ gsd: { extension: true } }, {});
    assert.equal(result.valid, true);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "NAMESPACE_CHECK_SKIPPED");
  });
});
describe("edge cases \u2014 field types", () => {
  test("does not flag @gsd/ package nested in sub-object of dependencies (only top-level keys matter)", () => {
    const errors = checkDependencyPlacement({
      dependencies: { nested: { "@gsd/foo": "1.0" } }
    });
    assert.equal(errors.length, 0, "nested @gsd/ in a sub-object value should not be flagged");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2V4dGVuc2lvbi12YWxpZGF0b3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IEV4dGVuc2lvbiBWYWxpZGF0b3IgVGVzdHNcbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG5pbXBvcnQgdGVzdCwgeyBkZXNjcmliZSB9IGZyb20gJ25vZGU6dGVzdCdcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0J1xuaW1wb3J0IHtcbiAgY2hlY2tJbnN0YWxsRGlzY3JpbWluYXRvcixcbiAgY2hlY2tOYW1lc3BhY2VSZXNlcnZhdGlvbixcbiAgY2hlY2tEZXBlbmRlbmN5UGxhY2VtZW50LFxuICB2YWxpZGF0ZUV4dGVuc2lvblBhY2thZ2UsXG59IGZyb20gJy4uL2V4dGVuc2lvbi12YWxpZGF0b3IudHMnXG5cbmRlc2NyaWJlKCdjaGVja0luc3RhbGxEaXNjcmltaW5hdG9yJywgKCkgPT4ge1xuICB0ZXN0KCdyZXR1cm5zIG51bGwgZm9yIHZhbGlkIGdzZC5leHRlbnNpb24gPT09IHRydWUnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gY2hlY2tJbnN0YWxsRGlzY3JpbWluYXRvcih7IGdzZDogeyBleHRlbnNpb246IHRydWUgfSwgcGk6IHsgZXh0ZW5zaW9uczogWycuL2luZGV4LnRzJ10gfSB9KVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpXG4gIH0pXG5cbiAgdGVzdCgncmV0dXJucyBlcnJvciB3aGVuIGdzZCBzZWN0aW9uIGlzIG1pc3NpbmcnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gY2hlY2tJbnN0YWxsRGlzY3JpbWluYXRvcih7IHBpOiB7IGV4dGVuc2lvbnM6IFsnLi9pbmRleC50cyddIH0gfSlcbiAgICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29kZSwgJ01JU1NJTkdfR1NEX01BUktFUicpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5maWVsZCwgJ2dzZC5leHRlbnNpb24nKVxuICB9KVxuXG4gIHRlc3QoJ3JldHVybnMgZXJyb3Igd2hlbiBnc2QuZXh0ZW5zaW9uIGlzIG51bWJlciAxIChub3QgYm9vbGVhbiB0cnVlKScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjaGVja0luc3RhbGxEaXNjcmltaW5hdG9yKHsgZ3NkOiB7IGV4dGVuc2lvbjogMSB9IH0pXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCAhPT0gbnVsbClcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvZGUsICdNSVNTSU5HX0dTRF9NQVJLRVInLCAnc3RyaWN0ID09PSB0cnVlIGNoZWNrIG11c3QgcmVqZWN0IG51bWVyaWMgMScpXG4gIH0pXG5cbiAgdGVzdChcInJldHVybnMgZXJyb3Igd2hlbiBnc2QuZXh0ZW5zaW9uIGlzIHN0cmluZyAndHJ1ZSdcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGNoZWNrSW5zdGFsbERpc2NyaW1pbmF0b3IoeyBnc2Q6IHsgZXh0ZW5zaW9uOiAndHJ1ZScgfSB9KVxuICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb2RlLCAnTUlTU0lOR19HU0RfTUFSS0VSJywgXCJzdHJpY3QgPT09IHRydWUgY2hlY2sgbXVzdCByZWplY3Qgc3RyaW5nICd0cnVlJ1wiKVxuICB9KVxuXG4gIHRlc3QoJ3JldHVybnMgZXJyb3IgZm9yIG51bGwgaW5wdXQnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gY2hlY2tJbnN0YWxsRGlzY3JpbWluYXRvcihudWxsKVxuICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb2RlLCAnTUlTU0lOR19HU0RfTUFSS0VSJylcbiAgfSlcblxuICB0ZXN0KCdyZXR1cm5zIGVycm9yIHdoZW4gZ3NkLmV4dGVuc2lvbiBpcyB1bmRlZmluZWQnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gY2hlY2tJbnN0YWxsRGlzY3JpbWluYXRvcih7IGdzZDoge30gfSlcbiAgICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29kZSwgJ01JU1NJTkdfR1NEX01BUktFUicpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5maWVsZCwgJ2dzZC5leHRlbnNpb24nKVxuICB9KVxuXG4gIHRlc3QoJ3JldHVybnMgZXJyb3Igd2hlbiBnc2QgaXMgYW4gYXJyYXkgKG5vdCBvYmplY3QpJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGNoZWNrSW5zdGFsbERpc2NyaW1pbmF0b3IoeyBnc2Q6IFsnZXh0ZW5zaW9uJ10gfSlcbiAgICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsKVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29kZSwgJ01JU1NJTkdfR1NEX01BUktFUicpXG4gIH0pXG5cbiAgdGVzdCgncmV0dXJucyBlcnJvciB3aGVuIGlucHV0IGlzIGEgc3RyaW5nIChub3Qgb2JqZWN0KScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjaGVja0luc3RhbGxEaXNjcmltaW5hdG9yKCd7XCJnc2RcIjp7XCJleHRlbnNpb25cIjp0cnVlfX0nKVxuICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb2RlLCAnTUlTU0lOR19HU0RfTUFSS0VSJylcbiAgfSlcbn0pXG5cbmRlc2NyaWJlKCdjaGVja05hbWVzcGFjZVJlc2VydmF0aW9uJywgKCkgPT4ge1xuICB0ZXN0KCdyZXR1cm5zIGVycm9yIGZvciBnc2QuIHByZWZpeGVkIGV4dGVuc2lvbiBJRCcsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjaGVja05hbWVzcGFjZVJlc2VydmF0aW9uKCdnc2QubXktdG9vbCcsIHt9KVxuICAgIGFzc2VydC5vayhyZXN1bHQgIT09IG51bGwpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb2RlLCAnUkVTRVJWRURfTkFNRVNQQUNFJylcbiAgICBhc3NlcnQub2socmVzdWx0Lm1lc3NhZ2UuaW5jbHVkZXMoJ2dzZC5teS10b29sJyksICdlcnJvciBtZXNzYWdlIHNob3VsZCBuYW1lIHRoZSBjb25mbGljdGluZyBJRCcpXG4gIH0pXG5cbiAgdGVzdCgncmV0dXJucyBudWxsIHdoZW4gYWxsb3dHc2ROYW1lc3BhY2UgaXMgdHJ1ZScsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjaGVja05hbWVzcGFjZVJlc2VydmF0aW9uKCdnc2QubXktdG9vbCcsIHsgYWxsb3dHc2ROYW1lc3BhY2U6IHRydWUgfSlcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKVxuICB9KVxuXG4gIHRlc3QoJ3JldHVybnMgbnVsbCBmb3Igbm9uLWdzZCBuYW1lc3BhY2UnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gY2hlY2tOYW1lc3BhY2VSZXNlcnZhdGlvbignYWNtZS5teS10b29sJywge30pXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbClcbiAgfSlcblxuICB0ZXN0KCdyZXR1cm5zIG51bGwgZm9yIGJhcmUgZXh0ZW5zaW9uIElEJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGNoZWNrTmFtZXNwYWNlUmVzZXJ2YXRpb24oJ215LXRvb2wnLCB7fSlcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ2NoZWNrRGVwZW5kZW5jeVBsYWNlbWVudCcsICgpID0+IHtcbiAgdGVzdCgncmV0dXJucyBlcnJvciBmb3IgQGdzZC8gcGFja2FnZSBpbiBkZXBlbmRlbmNpZXMnLCAoKSA9PiB7XG4gICAgY29uc3QgZXJyb3JzID0gY2hlY2tEZXBlbmRlbmN5UGxhY2VtZW50KHsgZGVwZW5kZW5jaWVzOiB7ICdAZ3NkL3BpLWNvZGluZy1hZ2VudCc6ICdeMi4wLjAnIH0gfSlcbiAgICBhc3NlcnQuZXF1YWwoZXJyb3JzLmxlbmd0aCwgMSlcbiAgICBhc3NlcnQuZXF1YWwoZXJyb3JzWzBdLmNvZGUsICdXUk9OR19ERVBfRklFTEQnKVxuICAgIGFzc2VydC5vayhlcnJvcnNbMF0ubWVzc2FnZS5pbmNsdWRlcygnQGdzZC9waS1jb2RpbmctYWdlbnQnKSwgJ21lc3NhZ2UgbXVzdCBuYW1lIGV4YWN0IHBhY2thZ2UnKVxuICAgIGFzc2VydC5vayhlcnJvcnNbMF0ubWVzc2FnZS5pbmNsdWRlcygnZGVwZW5kZW5jaWVzJyksICdtZXNzYWdlIG11c3QgbmFtZSBleGFjdCBmaWVsZCcpXG4gICAgYXNzZXJ0Lm9rKGVycm9yc1swXS5tZXNzYWdlLmluY2x1ZGVzKCdwZWVyRGVwZW5kZW5jaWVzJyksICdtZXNzYWdlIG11c3Qgc3VnZ2VzdCB0aGUgZml4JylcbiAgICBhc3NlcnQuZXF1YWwoZXJyb3JzWzBdLmZpZWxkLCAnZGVwZW5kZW5jaWVzJylcbiAgfSlcblxuICB0ZXN0KCdyZXR1cm5zIGVycm9yIGZvciBAZ3NkLyBwYWNrYWdlIGluIGRldkRlcGVuZGVuY2llcycsICgpID0+IHtcbiAgICBjb25zdCBlcnJvcnMgPSBjaGVja0RlcGVuZGVuY3lQbGFjZW1lbnQoeyBkZXZEZXBlbmRlbmNpZXM6IHsgJ0Bnc2QvcGktYWknOiAnXjEuMC4wJyB9IH0pXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDEpXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9yc1swXS5jb2RlLCAnV1JPTkdfREVQX0ZJRUxEJylcbiAgICBhc3NlcnQub2soZXJyb3JzWzBdLm1lc3NhZ2UuaW5jbHVkZXMoJ0Bnc2QvcGktYWknKSwgJ21lc3NhZ2UgbXVzdCBuYW1lIGV4YWN0IHBhY2thZ2UnKVxuICAgIGFzc2VydC5vayhlcnJvcnNbMF0ubWVzc2FnZS5pbmNsdWRlcygnZGV2RGVwZW5kZW5jaWVzJyksICdtZXNzYWdlIG11c3QgbmFtZSBleGFjdCBmaWVsZCcpXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9yc1swXS5maWVsZCwgJ2RldkRlcGVuZGVuY2llcycpXG4gIH0pXG5cbiAgdGVzdCgnZG9lcyBub3QgZmxhZyBAZ3NkLyBpbiBwZWVyRGVwZW5kZW5jaWVzJywgKCkgPT4ge1xuICAgIGNvbnN0IGVycm9ycyA9IGNoZWNrRGVwZW5kZW5jeVBsYWNlbWVudCh7IHBlZXJEZXBlbmRlbmNpZXM6IHsgJ0Bnc2QvcGktY29kaW5nLWFnZW50JzogJz49Mi41MC4wJyB9IH0pXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDAsICdwZWVyRGVwZW5kZW5jaWVzIGlzIHRoZSBjb3JyZWN0IHBsYWNlbWVudCBcdTIwMTQgbXVzdCBub3QgYmUgZmxhZ2dlZCcpXG4gIH0pXG5cbiAgdGVzdCgncmV0dXJucyBtdWx0aXBsZSBlcnJvcnMgZm9yIHZpb2xhdGlvbnMgaW4gYm90aCBkZXBlbmRlbmNpZXMgYW5kIGRldkRlcGVuZGVuY2llcycsICgpID0+IHtcbiAgICBjb25zdCBlcnJvcnMgPSBjaGVja0RlcGVuZGVuY3lQbGFjZW1lbnQoe1xuICAgICAgZGVwZW5kZW5jaWVzOiB7ICdAZ3NkL3BpLWNvZGluZy1hZ2VudCc6ICdeMi4wLjAnIH0sXG4gICAgICBkZXZEZXBlbmRlbmNpZXM6IHsgJ0Bnc2QvcGktYWknOiAnXjEuMC4wJyB9LFxuICAgIH0pXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDIpXG4gICAgY29uc3QgZmllbGRzID0gZXJyb3JzLm1hcChlID0+IGUuZmllbGQpXG4gICAgYXNzZXJ0Lm9rKGZpZWxkcy5pbmNsdWRlcygnZGVwZW5kZW5jaWVzJykpXG4gICAgYXNzZXJ0Lm9rKGZpZWxkcy5pbmNsdWRlcygnZGV2RGVwZW5kZW5jaWVzJykpXG4gIH0pXG5cbiAgdGVzdCgnZG9lcyBub3QgZmxhZyBub24tZ3NkIHBhY2thZ2VzJywgKCkgPT4ge1xuICAgIGNvbnN0IGVycm9ycyA9IGNoZWNrRGVwZW5kZW5jeVBsYWNlbWVudCh7IGRlcGVuZGVuY2llczogeyAnbG9kYXNoJzogJ140LjAuMCcgfSB9KVxuICAgIGFzc2VydC5lcXVhbChlcnJvcnMubGVuZ3RoLCAwKVxuICB9KVxuXG4gIHRlc3QoJ2hhbmRsZXMgbWlzc2luZyBkZXBlbmRlbmN5IGZpZWxkcycsICgpID0+IHtcbiAgICBjb25zdCBlcnJvcnMgPSBjaGVja0RlcGVuZGVuY3lQbGFjZW1lbnQoe30pXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDApXG4gIH0pXG5cbiAgdGVzdCgncmV0dXJucyBlbXB0eSBlcnJvcnMgd2hlbiBkZXBlbmRlbmNpZXMgaXMgYSBzdHJpbmcgaW5zdGVhZCBvZiBvYmplY3QnLCAoKSA9PiB7XG4gICAgY29uc3QgZXJyb3JzID0gY2hlY2tEZXBlbmRlbmN5UGxhY2VtZW50KHsgZGVwZW5kZW5jaWVzOiAnQGdzZC9waS1jb2RpbmctYWdlbnQnIH0pXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDAsICdzdHJpbmcgaW4gZGVwZW5kZW5jaWVzIGZpZWxkIHNob3VsZCBiZSBncmFjZWZ1bGx5IHNraXBwZWQnKVxuICB9KVxuXG4gIHRlc3QoJ3JldHVybnMgZW1wdHkgZXJyb3JzIHdoZW4gZGVwZW5kZW5jaWVzIGlzIG51bGwnLCAoKSA9PiB7XG4gICAgY29uc3QgZXJyb3JzID0gY2hlY2tEZXBlbmRlbmN5UGxhY2VtZW50KHsgZGVwZW5kZW5jaWVzOiBudWxsIH0pXG4gICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDAsICdudWxsIGRlcGVuZGVuY2llcyBzaG91bGQgYmUgZ3JhY2VmdWxseSBza2lwcGVkJylcbiAgfSlcblxuICB0ZXN0KCdyZXR1cm5zIGVtcHR5IGVycm9ycyB3aGVuIGRlcGVuZGVuY2llcyBpcyBhbiBhcnJheScsICgpID0+IHtcbiAgICBjb25zdCBlcnJvcnMgPSBjaGVja0RlcGVuZGVuY3lQbGFjZW1lbnQoeyBkZXBlbmRlbmNpZXM6IFsnQGdzZC9waS1jb2RpbmctYWdlbnQnXSB9KVxuICAgIGFzc2VydC5lcXVhbChlcnJvcnMubGVuZ3RoLCAwLCAnYXJyYXkgaW4gZGVwZW5kZW5jaWVzIGZpZWxkIHNob3VsZCBiZSBncmFjZWZ1bGx5IHNraXBwZWQnKVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ3ZhbGlkYXRlRXh0ZW5zaW9uUGFja2FnZScsICgpID0+IHtcbiAgdGVzdCgncmV0dXJucyB2YWxpZCBmb3IgY29uZm9ybWluZyBwYWNrYWdlJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRXh0ZW5zaW9uUGFja2FnZShcbiAgICAgIHsgZ3NkOiB7IGV4dGVuc2lvbjogdHJ1ZSB9LCBwZWVyRGVwZW5kZW5jaWVzOiB7ICdAZ3NkL3BpLWNvZGluZy1hZ2VudCc6ICc+PTIuNTAuMCcgfSB9LFxuICAgICAgeyBleHRlbnNpb25JZDogJ2FjbWUuYnJvd3NlcicgfVxuICAgIClcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnZhbGlkLCB0cnVlKVxuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmVycm9ycywgW10pXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQud2FybmluZ3MsIFtdKVxuICB9KVxuXG4gIHRlc3QoJ2FnZ3JlZ2F0ZXMgZXJyb3JzIGZyb20gbXVsdGlwbGUgY2hlY2tzJywgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlRXh0ZW5zaW9uUGFja2FnZShcbiAgICAgIHsgZGVwZW5kZW5jaWVzOiB7ICdAZ3NkL3BpLWFpJzogJ14xLjAuMCcgfSB9LFxuICAgICAgeyBleHRlbnNpb25JZDogJ2dzZC5iYWQnIH1cbiAgICApXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52YWxpZCwgZmFsc2UpXG4gICAgLy8gRXhwZWN0cyBhdCBsZWFzdDogTUlTU0lOR19HU0RfTUFSS0VSICsgUkVTRVJWRURfTkFNRVNQQUNFICsgV1JPTkdfREVQX0ZJRUxEXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMubGVuZ3RoID49IDMsIGBleHBlY3RlZCA+PSAzIGVycm9ycywgZ290ICR7cmVzdWx0LmVycm9ycy5sZW5ndGh9OiAke0pTT04uc3RyaW5naWZ5KHJlc3VsdC5lcnJvcnMubWFwKGUgPT4gZS5jb2RlKSl9YClcbiAgICBjb25zdCBjb2RlcyA9IHJlc3VsdC5lcnJvcnMubWFwKGUgPT4gZS5jb2RlKVxuICAgIGFzc2VydC5vayhjb2Rlcy5pbmNsdWRlcygnTUlTU0lOR19HU0RfTUFSS0VSJykpXG4gICAgYXNzZXJ0Lm9rKGNvZGVzLmluY2x1ZGVzKCdSRVNFUlZFRF9OQU1FU1BBQ0UnKSlcbiAgICBhc3NlcnQub2soY29kZXMuaW5jbHVkZXMoJ1dST05HX0RFUF9GSUVMRCcpKVxuICB9KVxuXG4gIHRlc3QoJ3ZhbGlkIGlzIGFsd2F5cyBlcnJvcnMubGVuZ3RoID09PSAwJywgKCkgPT4ge1xuICAgIGNvbnN0IHZhbGlkUGtnID0geyBnc2Q6IHsgZXh0ZW5zaW9uOiB0cnVlIH0gfVxuICAgIGNvbnN0IHZhbGlkUmVzdWx0ID0gdmFsaWRhdGVFeHRlbnNpb25QYWNrYWdlKHZhbGlkUGtnLCB7IGV4dGVuc2lvbklkOiAnYWNtZS50b29sJyB9KVxuICAgIGFzc2VydC5lcXVhbCh2YWxpZFJlc3VsdC52YWxpZCwgdHJ1ZSlcbiAgICBhc3NlcnQuZXF1YWwodmFsaWRSZXN1bHQuZXJyb3JzLmxlbmd0aCwgMClcblxuICAgIGNvbnN0IGludmFsaWRQa2cgPSB7IGdzZDogeyBleHRlbnNpb246IDEgfSB9XG4gICAgY29uc3QgaW52YWxpZFJlc3VsdCA9IHZhbGlkYXRlRXh0ZW5zaW9uUGFja2FnZShpbnZhbGlkUGtnLCB7IGV4dGVuc2lvbklkOiAnYWNtZS50b29sJyB9KVxuICAgIGFzc2VydC5lcXVhbChpbnZhbGlkUmVzdWx0LnZhbGlkLCBmYWxzZSlcbiAgICBhc3NlcnQub2soaW52YWxpZFJlc3VsdC5lcnJvcnMubGVuZ3RoID4gMClcbiAgfSlcblxuICB0ZXN0KCdhZGRzIHdhcm5pbmcgd2hlbiBleHRlbnNpb25JZCBpcyBub3QgcHJvdmlkZWQnLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVFeHRlbnNpb25QYWNrYWdlKHsgZ3NkOiB7IGV4dGVuc2lvbjogdHJ1ZSB9IH0sIHt9KVxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQudmFsaWQsIHRydWUpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5ncy5sZW5ndGgsIDEpXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC53YXJuaW5nc1swXS5jb2RlLCAnTkFNRVNQQUNFX0NIRUNLX1NLSVBQRUQnKVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ2VkZ2UgY2FzZXMgXHUyMDE0IGZpZWxkIHR5cGVzJywgKCkgPT4ge1xuICB0ZXN0KCdkb2VzIG5vdCBmbGFnIEBnc2QvIHBhY2thZ2UgbmVzdGVkIGluIHN1Yi1vYmplY3Qgb2YgZGVwZW5kZW5jaWVzIChvbmx5IHRvcC1sZXZlbCBrZXlzIG1hdHRlciknLCAoKSA9PiB7XG4gICAgLy8gVGhlIGNoZWNrZXIgaXRlcmF0ZXMgT2JqZWN0LmtleXMoZGVwcykgXHUyMDE0IGEgc3ViLW9iamVjdCB2YWx1ZSBpcyBhIHZhbHVlLCBub3QgYSBrZXkgbmFtZVxuICAgIGNvbnN0IGVycm9ycyA9IGNoZWNrRGVwZW5kZW5jeVBsYWNlbWVudCh7XG4gICAgICBkZXBlbmRlbmNpZXM6IHsgbmVzdGVkOiB7ICdAZ3NkL2Zvbyc6ICcxLjAnIH0gfSxcbiAgICB9KVxuICAgIGFzc2VydC5lcXVhbChlcnJvcnMubGVuZ3RoLCAwLCAnbmVzdGVkIEBnc2QvIGluIGEgc3ViLW9iamVjdCB2YWx1ZSBzaG91bGQgbm90IGJlIGZsYWdnZWQnKVxuICB9KVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sUUFBUSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLDZCQUE2QixNQUFNO0FBQzFDLE9BQUssaURBQWlELE1BQU07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
