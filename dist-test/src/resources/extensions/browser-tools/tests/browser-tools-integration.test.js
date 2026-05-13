import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const jiti = require2("jiti")(__dirname, { interopDefault: true, debug: false });
const { EVALUATE_HELPERS_SOURCE } = jiti("../evaluate-helpers.ts");
const { buildIntentScoringScript } = jiti("../tools/intent.ts");
const { buildFormAnalysisScript } = jiti("../tools/forms.ts");
let browser;
let page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page = await context.newPage();
});
after(async () => {
  if (browser) await browser.close();
});
async function injectHelpers() {
  await page.evaluate(EVALUATE_HELPERS_SOURCE);
}
describe("window.__pi utilities", () => {
  it("simpleHash \u2014 deterministic output for same input", async () => {
    await page.setContent("<p>test</p>");
    await injectHelpers();
    const h1 = await page.evaluate(() => window.__pi.simpleHash("hello world"));
    const h2 = await page.evaluate(() => window.__pi.simpleHash("hello world"));
    assert.equal(h1, h2);
    assert.equal(typeof h1, "string");
    assert.ok(h1.length > 0);
  });
  it("simpleHash \u2014 different output for different input", async () => {
    await page.setContent("<p>test</p>");
    await injectHelpers();
    const h1 = await page.evaluate(() => window.__pi.simpleHash("hello"));
    const h2 = await page.evaluate(() => window.__pi.simpleHash("world"));
    assert.notEqual(h1, h2);
  });
  it("isVisible \u2014 visible element returns true", async () => {
    await page.setContent('<div id="vis" style="width:100px;height:100px;">visible</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isVisible(document.getElementById("vis")));
    assert.equal(result, true);
  });
  it("isVisible \u2014 display:none returns false", async () => {
    await page.setContent('<div id="hidden" style="display:none;">hidden</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isVisible(document.getElementById("hidden")));
    assert.equal(result, false);
  });
  it("isVisible \u2014 visibility:hidden returns false", async () => {
    await page.setContent('<div id="inv" style="visibility:hidden;width:100px;height:100px;">inv</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isVisible(document.getElementById("inv")));
    assert.equal(result, false);
  });
  it("isEnabled \u2014 enabled input returns true", async () => {
    await page.setContent('<input id="en" type="text" />');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isEnabled(document.getElementById("en")));
    assert.equal(result, true);
  });
  it("isEnabled \u2014 disabled input returns false", async () => {
    await page.setContent('<input id="dis" type="text" disabled />');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isEnabled(document.getElementById("dis")));
    assert.equal(result, false);
  });
  it("isEnabled \u2014 aria-disabled returns false", async () => {
    await page.setContent('<button id="adis" aria-disabled="true">Click</button>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isEnabled(document.getElementById("adis")));
    assert.equal(result, false);
  });
  it("inferRole \u2014 button element \u2192 button", async () => {
    await page.setContent('<button id="btn">Go</button>');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("btn")));
    assert.equal(role, "button");
  });
  it("inferRole \u2014 anchor with href \u2192 link", async () => {
    await page.setContent('<a id="lnk" href="/page">Link</a>');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("lnk")));
    assert.equal(role, "link");
  });
  it("inferRole \u2014 input[type=text] \u2192 textbox", async () => {
    await page.setContent('<input id="txt" type="text" />');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("txt")));
    assert.equal(role, "textbox");
  });
  it("inferRole \u2014 input[type=search] \u2192 searchbox", async () => {
    await page.setContent('<input id="srch" type="search" />');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("srch")));
    assert.equal(role, "searchbox");
  });
  it("inferRole \u2014 explicit role attribute overrides tag", async () => {
    await page.setContent('<div id="d" role="button">Click me</div>');
    await injectHelpers();
    const role = await page.evaluate(() => window.__pi.inferRole(document.getElementById("d")));
    assert.equal(role, "button");
  });
  it("accessibleName \u2014 button with text content", async () => {
    await page.setContent('<button id="b">Submit Form</button>');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("b")));
    assert.equal(name, "Submit Form");
  });
  it("accessibleName \u2014 input with aria-label", async () => {
    await page.setContent('<input id="i" aria-label="Search query" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("i")));
    assert.equal(name, "Search query");
  });
  it("accessibleName \u2014 input with label[for]", async () => {
    await page.setContent('<label for="email">Email Address</label><input id="email" type="email" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("email")));
    assert.equal(typeof name, "string");
  });
  it("accessibleName \u2014 input with aria-labelledby", async () => {
    await page.setContent('<span id="lbl">Username</span><input id="u" aria-labelledby="lbl" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("u")));
    assert.equal(name, "Username");
  });
  it("accessibleName \u2014 input with placeholder as fallback", async () => {
    await page.setContent('<input id="p" placeholder="Enter name" />');
    await injectHelpers();
    const name = await page.evaluate(() => window.__pi.accessibleName(document.getElementById("p")));
    assert.equal(name, "Enter name");
  });
  it("isInteractiveEl \u2014 button \u2192 true", async () => {
    await page.setContent('<button id="b">Go</button>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("b")));
    assert.equal(result, true);
  });
  it("isInteractiveEl \u2014 div \u2192 false", async () => {
    await page.setContent('<div id="d">Just text</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("d")));
    assert.equal(result, false);
  });
  it("isInteractiveEl \u2014 input \u2192 true", async () => {
    await page.setContent('<input id="i" type="text" />');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("i")));
    assert.equal(result, true);
  });
  it("isInteractiveEl \u2014 anchor with href \u2192 true", async () => {
    await page.setContent('<a id="a" href="/page">Link</a>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("a")));
    assert.equal(result, true);
  });
  it("isInteractiveEl \u2014 div with tabindex \u2192 true", async () => {
    await page.setContent('<div id="t" tabindex="0">Focusable</div>');
    await injectHelpers();
    const result = await page.evaluate(() => window.__pi.isInteractiveEl(document.getElementById("t")));
    assert.equal(result, true);
  });
  it("cssPath \u2014 returns valid selector that resolves back to element", async () => {
    await page.setContent('<div><span><button id="target">Click</button></span></div>');
    await injectHelpers();
    const selector = await page.evaluate(() => window.__pi.cssPath(document.getElementById("target")));
    assert.equal(typeof selector, "string");
    assert.ok(selector.length > 0);
    const roundTrip = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.id : null;
    }, selector);
    assert.equal(roundTrip, "target");
  });
  it("cssPath \u2014 element with id uses #id shortcut", async () => {
    await page.setContent('<div id="myid">content</div>');
    await injectHelpers();
    const selector = await page.evaluate(() => window.__pi.cssPath(document.getElementById("myid")));
    assert.equal(selector, "#myid");
  });
  it("cssPath \u2014 nested element without id uses tag path", async () => {
    await page.setContent('<main><section><p class="test">hello</p></section></main>');
    await injectHelpers();
    const selector = await page.evaluate(() => {
      const el = document.querySelector("p.test");
      return window.__pi.cssPath(el);
    });
    assert.ok(selector.startsWith("body >"));
    const text = await page.evaluate((sel) => document.querySelector(sel)?.textContent, selector);
    assert.equal(text, "hello");
  });
});
describe("intent scoring", () => {
  it("submit_form \u2014 submit button inside form scores higher than outside", async () => {
    await page.setContent(`
      <form>
        <input type="text" name="q" />
        <button type="submit" id="inside">Submit</button>
      </form>
      <button id="outside">Random Button</button>
    `);
    await injectHelpers();
    const script = buildIntentScoringScript("submit_form");
    const result = await page.evaluate(script);
    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");
    const inside = result.candidates.find((c) => c.selector.includes("inside") || c.text.includes("submit"));
    const outside = result.candidates.find((c) => c.selector.includes("outside") || c.text.includes("random"));
    assert.ok(inside, "Should find the inside submit button");
    if (outside) {
      assert.ok(inside.score > outside.score, `Inside score (${inside.score}) should exceed outside (${outside.score})`);
    }
  });
  it("close_dialog \u2014 \xD7 button in dialog scores highest", async () => {
    await page.setContent(`
      <div role="dialog" aria-modal="true" style="width:400px;height:300px;position:relative;">
        <button id="close-x" aria-label="close" style="position:absolute;top:5px;right:5px;">\xD7</button>
        <p>Dialog content</p>
        <button id="cancel">Cancel</button>
      </div>
      <button id="other">Other</button>
    `);
    await injectHelpers();
    const script = buildIntentScoringScript("close_dialog");
    const result = await page.evaluate(script);
    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");
    const closeBtn = result.candidates[0];
    assert.ok(
      closeBtn.text.includes("\xD7") || closeBtn.name.toLowerCase().includes("close"),
      `Top candidate should be the \xD7 button, got: ${closeBtn.text} / ${closeBtn.name}`
    );
  });
  it("search_field \u2014 input[type=search] scores higher than input[type=text]", async () => {
    await page.setContent(`
      <header>
        <nav>
          <input id="search" type="search" placeholder="Search..." />
          <input id="text" type="text" placeholder="Username" />
        </nav>
      </header>
    `);
    await injectHelpers();
    const script = buildIntentScoringScript("search_field");
    const result = await page.evaluate(script);
    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");
    const searchInput = result.candidates.find((c) => c.tag === "input" && c.name.toLowerCase().includes("search"));
    assert.ok(searchInput, "Should find the search input");
    const textInput = result.candidates.find((c) => c.name.toLowerCase().includes("username"));
    if (textInput) {
      assert.ok(
        searchInput.score > textInput.score,
        `Search score (${searchInput.score}) should exceed text (${textInput.score})`
      );
    }
  });
  it("primary_cta \u2014 large button in main scores higher than small nav link", async () => {
    await page.setContent(`
      <nav>
        <a id="nav-link" href="/about" style="font-size:12px;padding:2px 4px;">About</a>
      </nav>
      <main>
        <button id="cta" style="font-size:24px;padding:20px 60px;width:300px;height:80px;">Get Started</button>
      </main>
    `);
    await injectHelpers();
    const script = buildIntentScoringScript("primary_cta");
    const result = await page.evaluate(script);
    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(result.candidates.length >= 1, "Expected at least 1 candidate");
    const cta = result.candidates.find((c) => c.text.includes("get started"));
    const navLink = result.candidates.find((c) => c.text.includes("about"));
    assert.ok(cta, "Should find the CTA button");
    if (navLink) {
      assert.ok(cta.score > navLink.score, `CTA score (${cta.score}) should exceed nav link (${navLink.score})`);
    }
  });
  it("submit_form \u2014 returns correct result structure", async () => {
    await page.setContent(`
      <form>
        <button type="submit">Save</button>
      </form>
    `);
    await injectHelpers();
    const script = buildIntentScoringScript("submit_form");
    const result = await page.evaluate(script);
    assert.equal(result.intent, "submit_form");
    assert.equal(result.normalized, "submitform");
    assert.equal(typeof result.count, "number");
    assert.ok(Array.isArray(result.candidates));
    const c = result.candidates[0];
    assert.equal(typeof c.score, "number");
    assert.equal(typeof c.selector, "string");
    assert.equal(typeof c.tag, "string");
    assert.equal(typeof c.role, "string");
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.text, "string");
    assert.equal(typeof c.reason, "string");
  });
  it("unknown intent returns error", async () => {
    await page.setContent("<p>test</p>");
    await injectHelpers();
    const script = buildIntentScoringScript("nonexistent_intent");
    const result = await page.evaluate(script);
    assert.ok(result.error, "Should return an error for unknown intent");
    assert.ok(result.error.includes("Unknown intent"));
  });
  it("missing window.__pi returns error", async () => {
    await page.setContent("<p>test</p>");
    await page.evaluate(() => {
      delete window.__pi;
    });
    const script = buildIntentScoringScript("submit_form");
    const result = await page.evaluate(script);
    assert.ok(result.error, "Should return an error when __pi not injected");
    assert.ok(result.error.includes("__pi"));
  });
});
describe("form analysis", () => {
  const COMPLEX_FORM = `
    <form id="testform" action="/submit">
      <!-- label[for] association -->
      <label for="fname">First Name</label>
      <input id="fname" name="first_name" type="text" required />

      <!-- wrapping label -->
      <label>Last Name <input id="lname" name="last_name" type="text" /></label>

      <!-- aria-label -->
      <input id="email" name="email" type="email" aria-label="Email Address" required />

      <!-- aria-labelledby -->
      <span id="phone-label">Phone Number</span>
      <input id="phone" name="phone" type="tel" aria-labelledby="phone-label" />

      <!-- placeholder as fallback -->
      <input id="city" name="city" type="text" placeholder="Enter your city" />

      <!-- hidden input -->
      <input id="token" name="csrf_token" type="hidden" value="abc123" />

      <!-- select with options -->
      <label for="country">Country</label>
      <select id="country" name="country">
        <option value="">Select...</option>
        <option value="us" selected>United States</option>
        <option value="uk">United Kingdom</option>
      </select>

      <!-- checkbox -->
      <label><input id="agree" name="agree" type="checkbox" /> I agree to terms</label>

      <!-- submit button -->
      <button type="submit" id="submit-btn">Register</button>
    </form>
  `;
  it("label via label[for] resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    const fname = result.fields.find((f) => f.name === "first_name");
    assert.ok(fname, "Should find first_name field");
    assert.equal(fname.label, "First Name");
  });
  it("label via wrapping label resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const lname = result.fields.find((f) => f.name === "last_name");
    assert.ok(lname, "Should find last_name field");
    assert.equal(lname.label, "Last Name");
  });
  it("label via aria-label resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const email = result.fields.find((f) => f.name === "email");
    assert.ok(email, "Should find email field");
    assert.equal(email.label, "Email Address");
  });
  it("label via aria-labelledby resolves correctly", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const phone = result.fields.find((f) => f.name === "phone");
    assert.ok(phone, "Should find phone field");
    assert.equal(phone.label, "Phone Number");
  });
  it("label via placeholder as fallback", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const city = result.fields.find((f) => f.name === "city");
    assert.ok(city, "Should find city field");
    assert.equal(city.label, "Enter your city");
  });
  it("hidden input is flagged as hidden", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const token = result.fields.find((f) => f.name === "csrf_token");
    assert.ok(token, "Should find csrf_token field");
    assert.equal(token.hidden, true);
    assert.equal(token.type, "hidden");
  });
  it("submit button is discovered", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    assert.ok(result.submitButtons.length >= 1, "Should find at least 1 submit button");
    const btn = result.submitButtons[0];
    assert.equal(btn.text, "Register");
    assert.equal(btn.type, "submit");
  });
  it("returns correct result structure", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    assert.equal(typeof result.formSelector, "string");
    assert.ok(Array.isArray(result.fields));
    assert.ok(Array.isArray(result.submitButtons));
    assert.equal(typeof result.fieldCount, "number");
    assert.equal(typeof result.visibleFieldCount, "number");
    assert.ok(result.fieldCount > 0);
  });
  it("required fields are correctly identified", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const fname = result.fields.find((f) => f.name === "first_name");
    assert.equal(fname.required, true, "first_name should be required");
    const lname = result.fields.find((f) => f.name === "last_name");
    assert.equal(lname.required, false, "last_name should not be required");
  });
  it("select options are included", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript("#testform");
    const result = await page.evaluate(script);
    const country = result.fields.find((f) => f.name === "country");
    assert.ok(country, "Should find country field");
    assert.equal(country.type, "select");
    assert.ok(Array.isArray(country.options));
    assert.ok(country.options.length >= 3);
    const selected = country.options.find((o) => o.selected);
    assert.equal(selected.value, "us");
  });
  it("auto-detects single form when no selector given", async () => {
    await page.setContent(COMPLEX_FORM);
    const script = buildFormAnalysisScript();
    const result = await page.evaluate(script);
    assert.ok(!result.error, "Should auto-detect the form");
    assert.ok(result.fields.length > 0, "Should find fields");
    assert.ok(result.formSelector.includes("testform") || result.formSelector.includes("form"));
  });
  it("returns error for non-existent selector", async () => {
    await page.setContent("<p>no form</p>");
    const script = buildFormAnalysisScript("#doesnotexist");
    const result = await page.evaluate(script);
    assert.ok(result.error, "Should return error for missing form");
    assert.ok(result.error.includes("not found"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdGVzdHMvYnJvd3Nlci10b29scy1pbnRlZ3JhdGlvbi50ZXN0Lm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBicm93c2VyLXRvb2xzIFx1MjAxNCBQbGF5d3JpZ2h0IGludGVncmF0aW9uIHRlc3RzXG4gKlxuICogRXhlcmNpc2VzIGJyb3dzZXItc2lkZSBldmFsdWF0ZSBzY3JpcHRzIGFnYWluc3QgcmVhbCBET006XG4gKiAtIEVWQUxVQVRFX0hFTFBFUlNfU09VUkNFICh3aW5kb3cuX19waSB1dGlsaXRpZXMpXG4gKiAtIEludGVudCBzY29yaW5nIHNjcmlwdHMgZnJvbSBpbnRlbnQudHNcbiAqIC0gRm9ybSBhbmFseXNpcyBzY3JpcHRzIGZyb20gZm9ybXMudHNcbiAqXG4gKiBVc2VzIFBsYXl3cmlnaHQgQ2hyb21pdW0gZm9yIHJlYWwgcGFnZS5ldmFsdWF0ZSgpIGFnYWluc3QgSFRNTCBmaXh0dXJlcy5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZSwgYWZ0ZXIgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNocm9taXVtIH0gZnJvbSBcInBsYXl3cmlnaHRcIjtcbmltcG9ydCB7IGRpcm5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5cbmNvbnN0IF9fZGlybmFtZSA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTb3VyY2UgbG9hZGluZyBcdTIwMTQgaW1wb3J0IHRoZSBJSUZFIGJ1aWxkZXJzIGRpcmVjdGx5IHZpYSBqaXRpLlxuLy8gVGhlIHRlc3Qtb25seSBuYW1lZCBleHBvcnRzIGluIHRvb2xzL2ludGVudC50cyBhbmQgdG9vbHMvZm9ybXMudHMgZXhpc3Rcbi8vIGV4YWN0bHkgc28gdGhpcyB0ZXN0IGNhbiBjYWxsIHRoZSByZWFsLCBpbi10cmVlIGJ1aWxkZXJzLiBObyBicmFjZVxuLy8gd2Fsa2luZywgbm8gcmVnZXggc3RyaXBwaW5nIFx1MjAxNCBhIHJlZmFjdG9yIG9mIHRoZSBzaWduYXR1cmVzIGp1c3QgdXBkYXRlc1xuLy8gdGhlIGltcG9ydCBzdXJmYWNlLCBub3QgdGhlIHRlc3QuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuY29uc3QgcmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUoaW1wb3J0Lm1ldGEudXJsKTtcbmNvbnN0IGppdGkgPSByZXF1aXJlKFwiaml0aVwiKShfX2Rpcm5hbWUsIHsgaW50ZXJvcERlZmF1bHQ6IHRydWUsIGRlYnVnOiBmYWxzZSB9KTtcbmNvbnN0IHsgRVZBTFVBVEVfSEVMUEVSU19TT1VSQ0UgfSA9IGppdGkoXCIuLi9ldmFsdWF0ZS1oZWxwZXJzLnRzXCIpO1xuY29uc3QgeyBidWlsZEludGVudFNjb3JpbmdTY3JpcHQgfSA9IGppdGkoXCIuLi90b29scy9pbnRlbnQudHNcIik7XG5jb25zdCB7IGJ1aWxkRm9ybUFuYWx5c2lzU2NyaXB0IH0gPSBqaXRpKFwiLi4vdG9vbHMvZm9ybXMudHNcIik7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQnJvd3NlciBsaWZlY3ljbGVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5sZXQgYnJvd3NlcjtcbmxldCBwYWdlO1xuXG5iZWZvcmUoYXN5bmMgKCkgPT4ge1xuICBicm93c2VyID0gYXdhaXQgY2hyb21pdW0ubGF1bmNoKHsgaGVhZGxlc3M6IHRydWUgfSk7XG4gIGNvbnN0IGNvbnRleHQgPSBhd2FpdCBicm93c2VyLm5ld0NvbnRleHQoeyB2aWV3cG9ydDogeyB3aWR0aDogMTI4MCwgaGVpZ2h0OiA4MDAgfSwgZGV2aWNlU2NhbGVGYWN0b3I6IDIgfSk7XG4gIHBhZ2UgPSBhd2FpdCBjb250ZXh0Lm5ld1BhZ2UoKTtcbn0pO1xuXG5hZnRlcihhc3luYyAoKSA9PiB7XG4gIGlmIChicm93c2VyKSBhd2FpdCBicm93c2VyLmNsb3NlKCk7XG59KTtcblxuLyoqIEluamVjdCB3aW5kb3cuX19waSBoZWxwZXJzIGludG8gdGhlIGN1cnJlbnQgcGFnZSAqL1xuYXN5bmMgZnVuY3Rpb24gaW5qZWN0SGVscGVycygpIHtcbiAgYXdhaXQgcGFnZS5ldmFsdWF0ZShFVkFMVUFURV9IRUxQRVJTX1NPVVJDRSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIDEuIHdpbmRvdy5fX3BpIHV0aWxpdHkgdGVzdHNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoXCJ3aW5kb3cuX19waSB1dGlsaXRpZXNcIiwgKCkgPT4ge1xuICBpdChcInNpbXBsZUhhc2ggXHUyMDE0IGRldGVybWluaXN0aWMgb3V0cHV0IGZvciBzYW1lIGlucHV0XCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoXCI8cD50ZXN0PC9wPlwiKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG4gICAgY29uc3QgaDEgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLnNpbXBsZUhhc2goXCJoZWxsbyB3b3JsZFwiKSk7XG4gICAgY29uc3QgaDIgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLnNpbXBsZUhhc2goXCJoZWxsbyB3b3JsZFwiKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGgxLCBoMik7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBoMSwgXCJzdHJpbmdcIik7XG4gICAgYXNzZXJ0Lm9rKGgxLmxlbmd0aCA+IDApO1xuICB9KTtcblxuICBpdChcInNpbXBsZUhhc2ggXHUyMDE0IGRpZmZlcmVudCBvdXRwdXQgZm9yIGRpZmZlcmVudCBpbnB1dFwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KFwiPHA+dGVzdDwvcD5cIik7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IGgxID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5zaW1wbGVIYXNoKFwiaGVsbG9cIikpO1xuICAgIGNvbnN0IGgyID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5zaW1wbGVIYXNoKFwid29ybGRcIikpO1xuICAgIGFzc2VydC5ub3RFcXVhbChoMSwgaDIpO1xuICB9KTtcblxuICBpdChcImlzVmlzaWJsZSBcdTIwMTQgdmlzaWJsZSBlbGVtZW50IHJldHVybnMgdHJ1ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8ZGl2IGlkPVwidmlzXCIgc3R5bGU9XCJ3aWR0aDoxMDBweDtoZWlnaHQ6MTAwcHg7XCI+dmlzaWJsZTwvZGl2PicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzVmlzaWJsZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInZpc1wiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUpO1xuICB9KTtcblxuICBpdChcImlzVmlzaWJsZSBcdTIwMTQgZGlzcGxheTpub25lIHJldHVybnMgZmFsc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGRpdiBpZD1cImhpZGRlblwiIHN0eWxlPVwiZGlzcGxheTpub25lO1wiPmhpZGRlbjwvZGl2PicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzVmlzaWJsZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImhpZGRlblwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoXCJpc1Zpc2libGUgXHUyMDE0IHZpc2liaWxpdHk6aGlkZGVuIHJldHVybnMgZmFsc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGRpdiBpZD1cImludlwiIHN0eWxlPVwidmlzaWJpbGl0eTpoaWRkZW47d2lkdGg6MTAwcHg7aGVpZ2h0OjEwMHB4O1wiPmludjwvZGl2PicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzVmlzaWJsZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImludlwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoXCJpc0VuYWJsZWQgXHUyMDE0IGVuYWJsZWQgaW5wdXQgcmV0dXJucyB0cnVlXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoJzxpbnB1dCBpZD1cImVuXCIgdHlwZT1cInRleHRcIiAvPicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzRW5hYmxlZChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImVuXCIpKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KFwiaXNFbmFibGVkIFx1MjAxNCBkaXNhYmxlZCBpbnB1dCByZXR1cm5zIGZhbHNlXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoJzxpbnB1dCBpZD1cImRpc1wiIHR5cGU9XCJ0ZXh0XCIgZGlzYWJsZWQgLz4nKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5pc0VuYWJsZWQoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJkaXNcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KFwiaXNFbmFibGVkIFx1MjAxNCBhcmlhLWRpc2FibGVkIHJldHVybnMgZmFsc2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGJ1dHRvbiBpZD1cImFkaXNcIiBhcmlhLWRpc2FibGVkPVwidHJ1ZVwiPkNsaWNrPC9idXR0b24+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fcGkuaXNFbmFibGVkKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYWRpc1wiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmZlclJvbGUgXHUyMDE0IGJ1dHRvbiBlbGVtZW50IFx1MjE5MiBidXR0b25cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGJ1dHRvbiBpZD1cImJ0blwiPkdvPC9idXR0b24+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHJvbGUgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmluZmVyUm9sZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImJ0blwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyb2xlLCBcImJ1dHRvblwiKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmZlclJvbGUgXHUyMDE0IGFuY2hvciB3aXRoIGhyZWYgXHUyMTkyIGxpbmtcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGEgaWQ9XCJsbmtcIiBocmVmPVwiL3BhZ2VcIj5MaW5rPC9hPicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByb2xlID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5pbmZlclJvbGUoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsbmtcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocm9sZSwgXCJsaW5rXCIpO1xuICB9KTtcblxuICBpdChcImluZmVyUm9sZSBcdTIwMTQgaW5wdXRbdHlwZT10ZXh0XSBcdTIxOTIgdGV4dGJveFwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8aW5wdXQgaWQ9XCJ0eHRcIiB0eXBlPVwidGV4dFwiIC8+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHJvbGUgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmluZmVyUm9sZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInR4dFwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyb2xlLCBcInRleHRib3hcIik7XG4gIH0pO1xuXG4gIGl0KFwiaW5mZXJSb2xlIFx1MjAxNCBpbnB1dFt0eXBlPXNlYXJjaF0gXHUyMTkyIHNlYXJjaGJveFwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8aW5wdXQgaWQ9XCJzcmNoXCIgdHlwZT1cInNlYXJjaFwiIC8+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHJvbGUgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmluZmVyUm9sZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNyY2hcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocm9sZSwgXCJzZWFyY2hib3hcIik7XG4gIH0pO1xuXG4gIGl0KFwiaW5mZXJSb2xlIFx1MjAxNCBleHBsaWNpdCByb2xlIGF0dHJpYnV0ZSBvdmVycmlkZXMgdGFnXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoJzxkaXYgaWQ9XCJkXCIgcm9sZT1cImJ1dHRvblwiPkNsaWNrIG1lPC9kaXY+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHJvbGUgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmluZmVyUm9sZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImRcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocm9sZSwgXCJidXR0b25cIik7XG4gIH0pO1xuXG4gIGl0KFwiYWNjZXNzaWJsZU5hbWUgXHUyMDE0IGJ1dHRvbiB3aXRoIHRleHQgY29udGVudFwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8YnV0dG9uIGlkPVwiYlwiPlN1Ym1pdCBGb3JtPC9idXR0b24+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IG5hbWUgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmFjY2Vzc2libGVOYW1lKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYlwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChuYW1lLCBcIlN1Ym1pdCBGb3JtXCIpO1xuICB9KTtcblxuICBpdChcImFjY2Vzc2libGVOYW1lIFx1MjAxNCBpbnB1dCB3aXRoIGFyaWEtbGFiZWxcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGlucHV0IGlkPVwiaVwiIGFyaWEtbGFiZWw9XCJTZWFyY2ggcXVlcnlcIiAvPicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCBuYW1lID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5hY2Nlc3NpYmxlTmFtZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImlcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwobmFtZSwgXCJTZWFyY2ggcXVlcnlcIik7XG4gIH0pO1xuXG4gIGl0KFwiYWNjZXNzaWJsZU5hbWUgXHUyMDE0IGlucHV0IHdpdGggbGFiZWxbZm9yXVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8bGFiZWwgZm9yPVwiZW1haWxcIj5FbWFpbCBBZGRyZXNzPC9sYWJlbD48aW5wdXQgaWQ9XCJlbWFpbFwiIHR5cGU9XCJlbWFpbFwiIC8+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIC8vIGFjY2Vzc2libGVOYW1lIGNoZWNrcyBhcmlhLWxhYmVsL2xhYmVsbGVkYnkvcGxhY2Vob2xkZXIvYWx0L3ZhbHVlL3RleHRDb250ZW50IFx1MjAxNFxuICAgIC8vIGJ1dCBOT1QgbGFiZWxbZm9yXS4gVGhhdCdzIGJ5IGRlc2lnbiBcdTIwMTQgaXQncyBhIGxpZ2h0d2VpZ2h0IGhldXJpc3RpYywgbm90IGZ1bGwgQVJJQS5cbiAgICAvLyBGb3IgbGFiZWxbZm9yXSwgdGhlIGFjY2Vzc2libGUgbmFtZSBmYWxscyBiYWNrIHRvIHRleHRDb250ZW50IChlbXB0eSBmb3IgaW5wdXQpLlxuICAgIC8vIFRlc3Qgd2hhdCBpdCBhY3R1YWxseSByZXR1cm5zLlxuICAgIGNvbnN0IG5hbWUgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmFjY2Vzc2libGVOYW1lKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiZW1haWxcIikpKTtcbiAgICAvLyBJbnB1dCBoYXMgbm8gYXJpYS1sYWJlbCwgbm8gbGFiZWxsZWRieSwgbm8gcGxhY2Vob2xkZXIsIG5vIGFsdCwgbm8gdmFsdWUsIG5vIHRleHRDb250ZW50XG4gICAgLy8gU28gaXQgcmV0dXJucyBlbXB0eSBzdHJpbmdcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIG5hbWUsIFwic3RyaW5nXCIpO1xuICB9KTtcblxuICBpdChcImFjY2Vzc2libGVOYW1lIFx1MjAxNCBpbnB1dCB3aXRoIGFyaWEtbGFiZWxsZWRieVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8c3BhbiBpZD1cImxibFwiPlVzZXJuYW1lPC9zcGFuPjxpbnB1dCBpZD1cInVcIiBhcmlhLWxhYmVsbGVkYnk9XCJsYmxcIiAvPicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCBuYW1lID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5hY2Nlc3NpYmxlTmFtZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInVcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwobmFtZSwgXCJVc2VybmFtZVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJhY2Nlc3NpYmxlTmFtZSBcdTIwMTQgaW5wdXQgd2l0aCBwbGFjZWhvbGRlciBhcyBmYWxsYmFja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8aW5wdXQgaWQ9XCJwXCIgcGxhY2Vob2xkZXI9XCJFbnRlciBuYW1lXCIgLz4nKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG4gICAgY29uc3QgbmFtZSA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fcGkuYWNjZXNzaWJsZU5hbWUoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwXCIpKSk7XG4gICAgYXNzZXJ0LmVxdWFsKG5hbWUsIFwiRW50ZXIgbmFtZVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJpc0ludGVyYWN0aXZlRWwgXHUyMDE0IGJ1dHRvbiBcdTIxOTIgdHJ1ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8YnV0dG9uIGlkPVwiYlwiPkdvPC9idXR0b24+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fcGkuaXNJbnRlcmFjdGl2ZUVsKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiYlwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUpO1xuICB9KTtcblxuICBpdChcImlzSW50ZXJhY3RpdmVFbCBcdTIwMTQgZGl2IFx1MjE5MiBmYWxzZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8ZGl2IGlkPVwiZFwiPkp1c3QgdGV4dDwvZGl2PicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzSW50ZXJhY3RpdmVFbChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImRcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KFwiaXNJbnRlcmFjdGl2ZUVsIFx1MjAxNCBpbnB1dCBcdTIxOTIgdHJ1ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8aW5wdXQgaWQ9XCJpXCIgdHlwZT1cInRleHRcIiAvPicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzSW50ZXJhY3RpdmVFbChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImlcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJpc0ludGVyYWN0aXZlRWwgXHUyMDE0IGFuY2hvciB3aXRoIGhyZWYgXHUyMTkyIHRydWVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGEgaWQ9XCJhXCIgaHJlZj1cIi9wYWdlXCI+TGluazwvYT4nKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5pc0ludGVyYWN0aXZlRWwoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhXCIpKSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KFwiaXNJbnRlcmFjdGl2ZUVsIFx1MjAxNCBkaXYgd2l0aCB0YWJpbmRleCBcdTIxOTIgdHJ1ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KCc8ZGl2IGlkPVwidFwiIHRhYmluZGV4PVwiMFwiPkZvY3VzYWJsZTwvZGl2PicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHdpbmRvdy5fX3BpLmlzSW50ZXJhY3RpdmVFbChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRcIikpKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJjc3NQYXRoIFx1MjAxNCByZXR1cm5zIHZhbGlkIHNlbGVjdG9yIHRoYXQgcmVzb2x2ZXMgYmFjayB0byBlbGVtZW50XCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoJzxkaXY+PHNwYW4+PGJ1dHRvbiBpZD1cInRhcmdldFwiPkNsaWNrPC9idXR0b24+PC9zcGFuPjwvZGl2PicpO1xuICAgIGF3YWl0IGluamVjdEhlbHBlcnMoKTtcbiAgICBjb25zdCBzZWxlY3RvciA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4gd2luZG93Ll9fcGkuY3NzUGF0aChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRhcmdldFwiKSkpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2Ygc2VsZWN0b3IsIFwic3RyaW5nXCIpO1xuICAgIGFzc2VydC5vayhzZWxlY3Rvci5sZW5ndGggPiAwKTtcbiAgICAvLyBWZXJpZnkgcm91bmQtdHJpcDogcXVlcnlTZWxlY3RvciB3aXRoIHRoYXQgc2VsZWN0b3IgZmluZHMgdGhlIGVsZW1lbnRcbiAgICBjb25zdCByb3VuZFRyaXAgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKChzZWwpID0+IHtcbiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgcmV0dXJuIGVsID8gZWwuaWQgOiBudWxsO1xuICAgIH0sIHNlbGVjdG9yKTtcbiAgICBhc3NlcnQuZXF1YWwocm91bmRUcmlwLCBcInRhcmdldFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJjc3NQYXRoIFx1MjAxNCBlbGVtZW50IHdpdGggaWQgdXNlcyAjaWQgc2hvcnRjdXRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPGRpdiBpZD1cIm15aWRcIj5jb250ZW50PC9kaXY+Jyk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuICAgIGNvbnN0IHNlbGVjdG9yID0gYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB3aW5kb3cuX19waS5jc3NQYXRoKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibXlpZFwiKSkpO1xuICAgIGFzc2VydC5lcXVhbChzZWxlY3RvciwgXCIjbXlpZFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJjc3NQYXRoIFx1MjAxNCBuZXN0ZWQgZWxlbWVudCB3aXRob3V0IGlkIHVzZXMgdGFnIHBhdGhcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudCgnPG1haW4+PHNlY3Rpb24+PHAgY2xhc3M9XCJ0ZXN0XCI+aGVsbG88L3A+PC9zZWN0aW9uPjwvbWFpbj4nKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG4gICAgY29uc3Qgc2VsZWN0b3IgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKCgpID0+IHtcbiAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcInAudGVzdFwiKTtcbiAgICAgIHJldHVybiB3aW5kb3cuX19waS5jc3NQYXRoKGVsKTtcbiAgICB9KTtcbiAgICBhc3NlcnQub2soc2VsZWN0b3Iuc3RhcnRzV2l0aChcImJvZHkgPlwiKSk7XG4gICAgLy8gVmVyaWZ5IGl0IHJlc29sdmVzXG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKHNlbCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpPy50ZXh0Q29udGVudCwgc2VsZWN0b3IpO1xuICAgIGFzc2VydC5lcXVhbCh0ZXh0LCBcImhlbGxvXCIpO1xuICB9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyAyLiBJbnRlbnQgc2NvcmluZyB0ZXN0c1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcImludGVudCBzY29yaW5nXCIsICgpID0+IHtcbiAgaXQoXCJzdWJtaXRfZm9ybSBcdTIwMTQgc3VibWl0IGJ1dHRvbiBpbnNpZGUgZm9ybSBzY29yZXMgaGlnaGVyIHRoYW4gb3V0c2lkZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KGBcbiAgICAgIDxmb3JtPlxuICAgICAgICA8aW5wdXQgdHlwZT1cInRleHRcIiBuYW1lPVwicVwiIC8+XG4gICAgICAgIDxidXR0b24gdHlwZT1cInN1Ym1pdFwiIGlkPVwiaW5zaWRlXCI+U3VibWl0PC9idXR0b24+XG4gICAgICA8L2Zvcm0+XG4gICAgICA8YnV0dG9uIGlkPVwib3V0c2lkZVwiPlJhbmRvbSBCdXR0b248L2J1dHRvbj5cbiAgICBgKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG5cbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEludGVudFNjb3JpbmdTY3JpcHQoXCJzdWJtaXRfZm9ybVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBhc3NlcnQub2soIXJlc3VsdC5lcnJvciwgYFVuZXhwZWN0ZWQgZXJyb3I6ICR7cmVzdWx0LmVycm9yfWApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2FuZGlkYXRlcy5sZW5ndGggPj0gMSwgXCJFeHBlY3RlZCBhdCBsZWFzdCAxIGNhbmRpZGF0ZVwiKTtcblxuICAgIC8vIFRoZSBzdWJtaXQgYnV0dG9uIGluc2lkZSB0aGUgZm9ybSBzaG91bGQgYmUgdG9wLXJhbmtlZFxuICAgIGNvbnN0IGluc2lkZSA9IHJlc3VsdC5jYW5kaWRhdGVzLmZpbmQoYyA9PiBjLnNlbGVjdG9yLmluY2x1ZGVzKFwiaW5zaWRlXCIpIHx8IGMudGV4dC5pbmNsdWRlcyhcInN1Ym1pdFwiKSk7XG4gICAgY29uc3Qgb3V0c2lkZSA9IHJlc3VsdC5jYW5kaWRhdGVzLmZpbmQoYyA9PiBjLnNlbGVjdG9yLmluY2x1ZGVzKFwib3V0c2lkZVwiKSB8fCBjLnRleHQuaW5jbHVkZXMoXCJyYW5kb21cIikpO1xuXG4gICAgYXNzZXJ0Lm9rKGluc2lkZSwgXCJTaG91bGQgZmluZCB0aGUgaW5zaWRlIHN1Ym1pdCBidXR0b25cIik7XG4gICAgaWYgKG91dHNpZGUpIHtcbiAgICAgIGFzc2VydC5vayhpbnNpZGUuc2NvcmUgPiBvdXRzaWRlLnNjb3JlLCBgSW5zaWRlIHNjb3JlICgke2luc2lkZS5zY29yZX0pIHNob3VsZCBleGNlZWQgb3V0c2lkZSAoJHtvdXRzaWRlLnNjb3JlfSlgKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwiY2xvc2VfZGlhbG9nIFx1MjAxNCBcdTAwRDcgYnV0dG9uIGluIGRpYWxvZyBzY29yZXMgaGlnaGVzdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KGBcbiAgICAgIDxkaXYgcm9sZT1cImRpYWxvZ1wiIGFyaWEtbW9kYWw9XCJ0cnVlXCIgc3R5bGU9XCJ3aWR0aDo0MDBweDtoZWlnaHQ6MzAwcHg7cG9zaXRpb246cmVsYXRpdmU7XCI+XG4gICAgICAgIDxidXR0b24gaWQ9XCJjbG9zZS14XCIgYXJpYS1sYWJlbD1cImNsb3NlXCIgc3R5bGU9XCJwb3NpdGlvbjphYnNvbHV0ZTt0b3A6NXB4O3JpZ2h0OjVweDtcIj5cdTAwRDc8L2J1dHRvbj5cbiAgICAgICAgPHA+RGlhbG9nIGNvbnRlbnQ8L3A+XG4gICAgICAgIDxidXR0b24gaWQ9XCJjYW5jZWxcIj5DYW5jZWw8L2J1dHRvbj5cbiAgICAgIDwvZGl2PlxuICAgICAgPGJ1dHRvbiBpZD1cIm90aGVyXCI+T3RoZXI8L2J1dHRvbj5cbiAgICBgKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG5cbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEludGVudFNjb3JpbmdTY3JpcHQoXCJjbG9zZV9kaWFsb2dcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuXG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuZXJyb3IsIGBVbmV4cGVjdGVkIGVycm9yOiAke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmNhbmRpZGF0ZXMubGVuZ3RoID49IDEsIFwiRXhwZWN0ZWQgYXQgbGVhc3QgMSBjYW5kaWRhdGVcIik7XG5cbiAgICAvLyBUaGUgXHUwMEQ3IGJ1dHRvbiBzaG91bGQgc2NvcmUgaGlnaCBkdWUgdG8gdGV4dCBtYXRjaCArIGFyaWEtbGFiZWwgKyBpbnNpZGUtZGlhbG9nICsgdG9wLXJpZ2h0XG4gICAgY29uc3QgY2xvc2VCdG4gPSByZXN1bHQuY2FuZGlkYXRlc1swXTtcbiAgICBhc3NlcnQub2soXG4gICAgICBjbG9zZUJ0bi50ZXh0LmluY2x1ZGVzKFwiXHUwMEQ3XCIpIHx8IGNsb3NlQnRuLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImNsb3NlXCIpLFxuICAgICAgYFRvcCBjYW5kaWRhdGUgc2hvdWxkIGJlIHRoZSBcdTAwRDcgYnV0dG9uLCBnb3Q6ICR7Y2xvc2VCdG4udGV4dH0gLyAke2Nsb3NlQnRuLm5hbWV9YFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwic2VhcmNoX2ZpZWxkIFx1MjAxNCBpbnB1dFt0eXBlPXNlYXJjaF0gc2NvcmVzIGhpZ2hlciB0aGFuIGlucHV0W3R5cGU9dGV4dF1cIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudChgXG4gICAgICA8aGVhZGVyPlxuICAgICAgICA8bmF2PlxuICAgICAgICAgIDxpbnB1dCBpZD1cInNlYXJjaFwiIHR5cGU9XCJzZWFyY2hcIiBwbGFjZWhvbGRlcj1cIlNlYXJjaC4uLlwiIC8+XG4gICAgICAgICAgPGlucHV0IGlkPVwidGV4dFwiIHR5cGU9XCJ0ZXh0XCIgcGxhY2Vob2xkZXI9XCJVc2VybmFtZVwiIC8+XG4gICAgICAgIDwvbmF2PlxuICAgICAgPC9oZWFkZXI+XG4gICAgYCk7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuXG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRJbnRlbnRTY29yaW5nU2NyaXB0KFwic2VhcmNoX2ZpZWxkXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoc2NyaXB0KTtcblxuICAgIGFzc2VydC5vayghcmVzdWx0LmVycm9yLCBgVW5leHBlY3RlZCBlcnJvcjogJHtyZXN1bHQuZXJyb3J9YCk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5jYW5kaWRhdGVzLmxlbmd0aCA+PSAxLCBcIkV4cGVjdGVkIGF0IGxlYXN0IDEgY2FuZGlkYXRlXCIpO1xuXG4gICAgY29uc3Qgc2VhcmNoSW5wdXQgPSByZXN1bHQuY2FuZGlkYXRlcy5maW5kKGMgPT4gYy50YWcgPT09IFwiaW5wdXRcIiAmJiBjLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcInNlYXJjaFwiKSk7XG4gICAgYXNzZXJ0Lm9rKHNlYXJjaElucHV0LCBcIlNob3VsZCBmaW5kIHRoZSBzZWFyY2ggaW5wdXRcIik7XG5cbiAgICAvLyBJdCBzaG91bGQgYmUgdGhlIHRvcCBjYW5kaWRhdGUgb3IgYXQgbGVhc3QgaGlnaGVyIHRoYW4gdGhlIHRleHQgaW5wdXRcbiAgICBjb25zdCB0ZXh0SW5wdXQgPSByZXN1bHQuY2FuZGlkYXRlcy5maW5kKGMgPT4gYy5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJ1c2VybmFtZVwiKSk7XG4gICAgaWYgKHRleHRJbnB1dCkge1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBzZWFyY2hJbnB1dC5zY29yZSA+IHRleHRJbnB1dC5zY29yZSxcbiAgICAgICAgYFNlYXJjaCBzY29yZSAoJHtzZWFyY2hJbnB1dC5zY29yZX0pIHNob3VsZCBleGNlZWQgdGV4dCAoJHt0ZXh0SW5wdXQuc2NvcmV9KWBcbiAgICAgICk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInByaW1hcnlfY3RhIFx1MjAxNCBsYXJnZSBidXR0b24gaW4gbWFpbiBzY29yZXMgaGlnaGVyIHRoYW4gc21hbGwgbmF2IGxpbmtcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudChgXG4gICAgICA8bmF2PlxuICAgICAgICA8YSBpZD1cIm5hdi1saW5rXCIgaHJlZj1cIi9hYm91dFwiIHN0eWxlPVwiZm9udC1zaXplOjEycHg7cGFkZGluZzoycHggNHB4O1wiPkFib3V0PC9hPlxuICAgICAgPC9uYXY+XG4gICAgICA8bWFpbj5cbiAgICAgICAgPGJ1dHRvbiBpZD1cImN0YVwiIHN0eWxlPVwiZm9udC1zaXplOjI0cHg7cGFkZGluZzoyMHB4IDYwcHg7d2lkdGg6MzAwcHg7aGVpZ2h0OjgwcHg7XCI+R2V0IFN0YXJ0ZWQ8L2J1dHRvbj5cbiAgICAgIDwvbWFpbj5cbiAgICBgKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG5cbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEludGVudFNjb3JpbmdTY3JpcHQoXCJwcmltYXJ5X2N0YVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBhc3NlcnQub2soIXJlc3VsdC5lcnJvciwgYFVuZXhwZWN0ZWQgZXJyb3I6ICR7cmVzdWx0LmVycm9yfWApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuY2FuZGlkYXRlcy5sZW5ndGggPj0gMSwgXCJFeHBlY3RlZCBhdCBsZWFzdCAxIGNhbmRpZGF0ZVwiKTtcblxuICAgIC8vIFRoZSBsYXJnZSBidXR0b24gaW4gbWFpbiBzaG91bGQgb3V0cmFuayB0aGUgc21hbGwgbmF2IGxpbmtcbiAgICBjb25zdCBjdGEgPSByZXN1bHQuY2FuZGlkYXRlcy5maW5kKGMgPT4gYy50ZXh0LmluY2x1ZGVzKFwiZ2V0IHN0YXJ0ZWRcIikpO1xuICAgIGNvbnN0IG5hdkxpbmsgPSByZXN1bHQuY2FuZGlkYXRlcy5maW5kKGMgPT4gYy50ZXh0LmluY2x1ZGVzKFwiYWJvdXRcIikpO1xuXG4gICAgYXNzZXJ0Lm9rKGN0YSwgXCJTaG91bGQgZmluZCB0aGUgQ1RBIGJ1dHRvblwiKTtcbiAgICBpZiAobmF2TGluaykge1xuICAgICAgYXNzZXJ0Lm9rKGN0YS5zY29yZSA+IG5hdkxpbmsuc2NvcmUsIGBDVEEgc2NvcmUgKCR7Y3RhLnNjb3JlfSkgc2hvdWxkIGV4Y2VlZCBuYXYgbGluayAoJHtuYXZMaW5rLnNjb3JlfSlgKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwic3VibWl0X2Zvcm0gXHUyMDE0IHJldHVybnMgY29ycmVjdCByZXN1bHQgc3RydWN0dXJlXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoYFxuICAgICAgPGZvcm0+XG4gICAgICAgIDxidXR0b24gdHlwZT1cInN1Ym1pdFwiPlNhdmU8L2J1dHRvbj5cbiAgICAgIDwvZm9ybT5cbiAgICBgKTtcbiAgICBhd2FpdCBpbmplY3RIZWxwZXJzKCk7XG5cbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEludGVudFNjb3JpbmdTY3JpcHQoXCJzdWJtaXRfZm9ybVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmludGVudCwgXCJzdWJtaXRfZm9ybVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm5vcm1hbGl6ZWQsIFwic3VibWl0Zm9ybVwiKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdC5jb3VudCwgXCJudW1iZXJcIik7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocmVzdWx0LmNhbmRpZGF0ZXMpKTtcblxuICAgIGNvbnN0IGMgPSByZXN1bHQuY2FuZGlkYXRlc1swXTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGMuc2NvcmUsIFwibnVtYmVyXCIpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgYy5zZWxlY3RvciwgXCJzdHJpbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBjLnRhZywgXCJzdHJpbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBjLnJvbGUsIFwic3RyaW5nXCIpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgYy5uYW1lLCBcInN0cmluZ1wiKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGMudGV4dCwgXCJzdHJpbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBjLnJlYXNvbiwgXCJzdHJpbmdcIik7XG4gIH0pO1xuXG4gIGl0KFwidW5rbm93biBpbnRlbnQgcmV0dXJucyBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KFwiPHA+dGVzdDwvcD5cIik7XG4gICAgYXdhaXQgaW5qZWN0SGVscGVycygpO1xuXG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRJbnRlbnRTY29yaW5nU2NyaXB0KFwibm9uZXhpc3RlbnRfaW50ZW50XCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoc2NyaXB0KTtcbiAgICBhc3NlcnQub2socmVzdWx0LmVycm9yLCBcIlNob3VsZCByZXR1cm4gYW4gZXJyb3IgZm9yIHVua25vd24gaW50ZW50XCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3IuaW5jbHVkZXMoXCJVbmtub3duIGludGVudFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwibWlzc2luZyB3aW5kb3cuX19waSByZXR1cm5zIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBOYXZpZ2F0ZSB0byBhYm91dDpibGFuayBhbmQgY2xlYXIgd2luZG93Ll9fcGkgdG8gc2ltdWxhdGUgbWlzc2luZyBoZWxwZXJzXG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KFwiPHA+dGVzdDwvcD5cIik7XG4gICAgYXdhaXQgcGFnZS5ldmFsdWF0ZSgoKSA9PiB7IGRlbGV0ZSB3aW5kb3cuX19waTsgfSk7XG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRJbnRlbnRTY29yaW5nU2NyaXB0KFwic3VibWl0X2Zvcm1cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3IsIFwiU2hvdWxkIHJldHVybiBhbiBlcnJvciB3aGVuIF9fcGkgbm90IGluamVjdGVkXCIpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3IuaW5jbHVkZXMoXCJfX3BpXCIpKTtcbiAgfSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gMy4gRm9ybSBhbmFseXNpcyB0ZXN0c1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZShcImZvcm0gYW5hbHlzaXNcIiwgKCkgPT4ge1xuICBjb25zdCBDT01QTEVYX0ZPUk0gPSBgXG4gICAgPGZvcm0gaWQ9XCJ0ZXN0Zm9ybVwiIGFjdGlvbj1cIi9zdWJtaXRcIj5cbiAgICAgIDwhLS0gbGFiZWxbZm9yXSBhc3NvY2lhdGlvbiAtLT5cbiAgICAgIDxsYWJlbCBmb3I9XCJmbmFtZVwiPkZpcnN0IE5hbWU8L2xhYmVsPlxuICAgICAgPGlucHV0IGlkPVwiZm5hbWVcIiBuYW1lPVwiZmlyc3RfbmFtZVwiIHR5cGU9XCJ0ZXh0XCIgcmVxdWlyZWQgLz5cblxuICAgICAgPCEtLSB3cmFwcGluZyBsYWJlbCAtLT5cbiAgICAgIDxsYWJlbD5MYXN0IE5hbWUgPGlucHV0IGlkPVwibG5hbWVcIiBuYW1lPVwibGFzdF9uYW1lXCIgdHlwZT1cInRleHRcIiAvPjwvbGFiZWw+XG5cbiAgICAgIDwhLS0gYXJpYS1sYWJlbCAtLT5cbiAgICAgIDxpbnB1dCBpZD1cImVtYWlsXCIgbmFtZT1cImVtYWlsXCIgdHlwZT1cImVtYWlsXCIgYXJpYS1sYWJlbD1cIkVtYWlsIEFkZHJlc3NcIiByZXF1aXJlZCAvPlxuXG4gICAgICA8IS0tIGFyaWEtbGFiZWxsZWRieSAtLT5cbiAgICAgIDxzcGFuIGlkPVwicGhvbmUtbGFiZWxcIj5QaG9uZSBOdW1iZXI8L3NwYW4+XG4gICAgICA8aW5wdXQgaWQ9XCJwaG9uZVwiIG5hbWU9XCJwaG9uZVwiIHR5cGU9XCJ0ZWxcIiBhcmlhLWxhYmVsbGVkYnk9XCJwaG9uZS1sYWJlbFwiIC8+XG5cbiAgICAgIDwhLS0gcGxhY2Vob2xkZXIgYXMgZmFsbGJhY2sgLS0+XG4gICAgICA8aW5wdXQgaWQ9XCJjaXR5XCIgbmFtZT1cImNpdHlcIiB0eXBlPVwidGV4dFwiIHBsYWNlaG9sZGVyPVwiRW50ZXIgeW91ciBjaXR5XCIgLz5cblxuICAgICAgPCEtLSBoaWRkZW4gaW5wdXQgLS0+XG4gICAgICA8aW5wdXQgaWQ9XCJ0b2tlblwiIG5hbWU9XCJjc3JmX3Rva2VuXCIgdHlwZT1cImhpZGRlblwiIHZhbHVlPVwiYWJjMTIzXCIgLz5cblxuICAgICAgPCEtLSBzZWxlY3Qgd2l0aCBvcHRpb25zIC0tPlxuICAgICAgPGxhYmVsIGZvcj1cImNvdW50cnlcIj5Db3VudHJ5PC9sYWJlbD5cbiAgICAgIDxzZWxlY3QgaWQ9XCJjb3VudHJ5XCIgbmFtZT1cImNvdW50cnlcIj5cbiAgICAgICAgPG9wdGlvbiB2YWx1ZT1cIlwiPlNlbGVjdC4uLjwvb3B0aW9uPlxuICAgICAgICA8b3B0aW9uIHZhbHVlPVwidXNcIiBzZWxlY3RlZD5Vbml0ZWQgU3RhdGVzPC9vcHRpb24+XG4gICAgICAgIDxvcHRpb24gdmFsdWU9XCJ1a1wiPlVuaXRlZCBLaW5nZG9tPC9vcHRpb24+XG4gICAgICA8L3NlbGVjdD5cblxuICAgICAgPCEtLSBjaGVja2JveCAtLT5cbiAgICAgIDxsYWJlbD48aW5wdXQgaWQ9XCJhZ3JlZVwiIG5hbWU9XCJhZ3JlZVwiIHR5cGU9XCJjaGVja2JveFwiIC8+IEkgYWdyZWUgdG8gdGVybXM8L2xhYmVsPlxuXG4gICAgICA8IS0tIHN1Ym1pdCBidXR0b24gLS0+XG4gICAgICA8YnV0dG9uIHR5cGU9XCJzdWJtaXRcIiBpZD1cInN1Ym1pdC1idG5cIj5SZWdpc3RlcjwvYnV0dG9uPlxuICAgIDwvZm9ybT5cbiAgYDtcblxuICBpdChcImxhYmVsIHZpYSBsYWJlbFtmb3JdIHJlc29sdmVzIGNvcnJlY3RseVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KENPTVBMRVhfRk9STSk7XG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRGb3JtQW5hbHlzaXNTY3JpcHQoXCIjdGVzdGZvcm1cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuXG4gICAgYXNzZXJ0Lm9rKCFyZXN1bHQuZXJyb3IsIGBVbmV4cGVjdGVkIGVycm9yOiAke3Jlc3VsdC5lcnJvcn1gKTtcbiAgICBjb25zdCBmbmFtZSA9IHJlc3VsdC5maWVsZHMuZmluZChmID0+IGYubmFtZSA9PT0gXCJmaXJzdF9uYW1lXCIpO1xuICAgIGFzc2VydC5vayhmbmFtZSwgXCJTaG91bGQgZmluZCBmaXJzdF9uYW1lIGZpZWxkXCIpO1xuICAgIGFzc2VydC5lcXVhbChmbmFtZS5sYWJlbCwgXCJGaXJzdCBOYW1lXCIpO1xuICB9KTtcblxuICBpdChcImxhYmVsIHZpYSB3cmFwcGluZyBsYWJlbCByZXNvbHZlcyBjb3JyZWN0bHlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudChDT01QTEVYX0ZPUk0pO1xuICAgIGNvbnN0IHNjcmlwdCA9IGJ1aWxkRm9ybUFuYWx5c2lzU2NyaXB0KFwiI3Rlc3Rmb3JtXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoc2NyaXB0KTtcblxuICAgIGNvbnN0IGxuYW1lID0gcmVzdWx0LmZpZWxkcy5maW5kKGYgPT4gZi5uYW1lID09PSBcImxhc3RfbmFtZVwiKTtcbiAgICBhc3NlcnQub2sobG5hbWUsIFwiU2hvdWxkIGZpbmQgbGFzdF9uYW1lIGZpZWxkXCIpO1xuICAgIGFzc2VydC5lcXVhbChsbmFtZS5sYWJlbCwgXCJMYXN0IE5hbWVcIik7XG4gIH0pO1xuXG4gIGl0KFwibGFiZWwgdmlhIGFyaWEtbGFiZWwgcmVzb2x2ZXMgY29ycmVjdGx5XCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoQ09NUExFWF9GT1JNKTtcbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEZvcm1BbmFseXNpc1NjcmlwdChcIiN0ZXN0Zm9ybVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBjb25zdCBlbWFpbCA9IHJlc3VsdC5maWVsZHMuZmluZChmID0+IGYubmFtZSA9PT0gXCJlbWFpbFwiKTtcbiAgICBhc3NlcnQub2soZW1haWwsIFwiU2hvdWxkIGZpbmQgZW1haWwgZmllbGRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGVtYWlsLmxhYmVsLCBcIkVtYWlsIEFkZHJlc3NcIik7XG4gIH0pO1xuXG4gIGl0KFwibGFiZWwgdmlhIGFyaWEtbGFiZWxsZWRieSByZXNvbHZlcyBjb3JyZWN0bHlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHBhZ2Uuc2V0Q29udGVudChDT01QTEVYX0ZPUk0pO1xuICAgIGNvbnN0IHNjcmlwdCA9IGJ1aWxkRm9ybUFuYWx5c2lzU2NyaXB0KFwiI3Rlc3Rmb3JtXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoc2NyaXB0KTtcblxuICAgIGNvbnN0IHBob25lID0gcmVzdWx0LmZpZWxkcy5maW5kKGYgPT4gZi5uYW1lID09PSBcInBob25lXCIpO1xuICAgIGFzc2VydC5vayhwaG9uZSwgXCJTaG91bGQgZmluZCBwaG9uZSBmaWVsZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGhvbmUubGFiZWwsIFwiUGhvbmUgTnVtYmVyXCIpO1xuICB9KTtcblxuICBpdChcImxhYmVsIHZpYSBwbGFjZWhvbGRlciBhcyBmYWxsYmFja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KENPTVBMRVhfRk9STSk7XG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRGb3JtQW5hbHlzaXNTY3JpcHQoXCIjdGVzdGZvcm1cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuXG4gICAgY29uc3QgY2l0eSA9IHJlc3VsdC5maWVsZHMuZmluZChmID0+IGYubmFtZSA9PT0gXCJjaXR5XCIpO1xuICAgIGFzc2VydC5vayhjaXR5LCBcIlNob3VsZCBmaW5kIGNpdHkgZmllbGRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNpdHkubGFiZWwsIFwiRW50ZXIgeW91ciBjaXR5XCIpO1xuICB9KTtcblxuICBpdChcImhpZGRlbiBpbnB1dCBpcyBmbGFnZ2VkIGFzIGhpZGRlblwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KENPTVBMRVhfRk9STSk7XG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRGb3JtQW5hbHlzaXNTY3JpcHQoXCIjdGVzdGZvcm1cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuXG4gICAgY29uc3QgdG9rZW4gPSByZXN1bHQuZmllbGRzLmZpbmQoZiA9PiBmLm5hbWUgPT09IFwiY3NyZl90b2tlblwiKTtcbiAgICBhc3NlcnQub2sodG9rZW4sIFwiU2hvdWxkIGZpbmQgY3NyZl90b2tlbiBmaWVsZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwodG9rZW4uaGlkZGVuLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwodG9rZW4udHlwZSwgXCJoaWRkZW5cIik7XG4gIH0pO1xuXG4gIGl0KFwic3VibWl0IGJ1dHRvbiBpcyBkaXNjb3ZlcmVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoQ09NUExFWF9GT1JNKTtcbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEZvcm1BbmFseXNpc1NjcmlwdChcIiN0ZXN0Zm9ybVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0LnN1Ym1pdEJ1dHRvbnMubGVuZ3RoID49IDEsIFwiU2hvdWxkIGZpbmQgYXQgbGVhc3QgMSBzdWJtaXQgYnV0dG9uXCIpO1xuICAgIGNvbnN0IGJ0biA9IHJlc3VsdC5zdWJtaXRCdXR0b25zWzBdO1xuICAgIGFzc2VydC5lcXVhbChidG4udGV4dCwgXCJSZWdpc3RlclwiKTtcbiAgICBhc3NlcnQuZXF1YWwoYnRuLnR5cGUsIFwic3VibWl0XCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgY29ycmVjdCByZXN1bHQgc3RydWN0dXJlXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoQ09NUExFWF9GT1JNKTtcbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEZvcm1BbmFseXNpc1NjcmlwdChcIiN0ZXN0Zm9ybVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdC5mb3JtU2VsZWN0b3IsIFwic3RyaW5nXCIpO1xuICAgIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlc3VsdC5maWVsZHMpKTtcbiAgICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShyZXN1bHQuc3VibWl0QnV0dG9ucykpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LmZpZWxkQ291bnQsIFwibnVtYmVyXCIpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LnZpc2libGVGaWVsZENvdW50LCBcIm51bWJlclwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LmZpZWxkQ291bnQgPiAwKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXF1aXJlZCBmaWVsZHMgYXJlIGNvcnJlY3RseSBpZGVudGlmaWVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoQ09NUExFWF9GT1JNKTtcbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEZvcm1BbmFseXNpc1NjcmlwdChcIiN0ZXN0Zm9ybVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBjb25zdCBmbmFtZSA9IHJlc3VsdC5maWVsZHMuZmluZChmID0+IGYubmFtZSA9PT0gXCJmaXJzdF9uYW1lXCIpO1xuICAgIGFzc2VydC5lcXVhbChmbmFtZS5yZXF1aXJlZCwgdHJ1ZSwgXCJmaXJzdF9uYW1lIHNob3VsZCBiZSByZXF1aXJlZFwiKTtcblxuICAgIGNvbnN0IGxuYW1lID0gcmVzdWx0LmZpZWxkcy5maW5kKGYgPT4gZi5uYW1lID09PSBcImxhc3RfbmFtZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwobG5hbWUucmVxdWlyZWQsIGZhbHNlLCBcImxhc3RfbmFtZSBzaG91bGQgbm90IGJlIHJlcXVpcmVkXCIpO1xuICB9KTtcblxuICBpdChcInNlbGVjdCBvcHRpb25zIGFyZSBpbmNsdWRlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KENPTVBMRVhfRk9STSk7XG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRGb3JtQW5hbHlzaXNTY3JpcHQoXCIjdGVzdGZvcm1cIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuXG4gICAgY29uc3QgY291bnRyeSA9IHJlc3VsdC5maWVsZHMuZmluZChmID0+IGYubmFtZSA9PT0gXCJjb3VudHJ5XCIpO1xuICAgIGFzc2VydC5vayhjb3VudHJ5LCBcIlNob3VsZCBmaW5kIGNvdW50cnkgZmllbGRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNvdW50cnkudHlwZSwgXCJzZWxlY3RcIik7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoY291bnRyeS5vcHRpb25zKSk7XG4gICAgYXNzZXJ0Lm9rKGNvdW50cnkub3B0aW9ucy5sZW5ndGggPj0gMyk7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBjb3VudHJ5Lm9wdGlvbnMuZmluZChvID0+IG8uc2VsZWN0ZWQpO1xuICAgIGFzc2VydC5lcXVhbChzZWxlY3RlZC52YWx1ZSwgXCJ1c1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJhdXRvLWRldGVjdHMgc2luZ2xlIGZvcm0gd2hlbiBubyBzZWxlY3RvciBnaXZlblwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgcGFnZS5zZXRDb250ZW50KENPTVBMRVhfRk9STSk7XG4gICAgY29uc3Qgc2NyaXB0ID0gYnVpbGRGb3JtQW5hbHlzaXNTY3JpcHQoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKHNjcmlwdCk7XG5cbiAgICBhc3NlcnQub2soIXJlc3VsdC5lcnJvciwgXCJTaG91bGQgYXV0by1kZXRlY3QgdGhlIGZvcm1cIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5maWVsZHMubGVuZ3RoID4gMCwgXCJTaG91bGQgZmluZCBmaWVsZHNcIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5mb3JtU2VsZWN0b3IuaW5jbHVkZXMoXCJ0ZXN0Zm9ybVwiKSB8fCByZXN1bHQuZm9ybVNlbGVjdG9yLmluY2x1ZGVzKFwiZm9ybVwiKSk7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBlcnJvciBmb3Igbm9uLWV4aXN0ZW50IHNlbGVjdG9yXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBwYWdlLnNldENvbnRlbnQoXCI8cD5ubyBmb3JtPC9wPlwiKTtcbiAgICBjb25zdCBzY3JpcHQgPSBidWlsZEZvcm1BbmFseXNpc1NjcmlwdChcIiNkb2Vzbm90ZXhpc3RcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcGFnZS5ldmFsdWF0ZShzY3JpcHQpO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvciwgXCJTaG91bGQgcmV0dXJuIGVycm9yIGZvciBtaXNzaW5nIGZvcm1cIik7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvci5pbmNsdWRlcyhcIm5vdCBmb3VuZFwiKSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxTQUFTLFVBQVUsSUFBSSxRQUFRLGFBQWE7QUFDNUMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMs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
