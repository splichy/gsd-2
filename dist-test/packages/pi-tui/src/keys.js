let _kittyProtocolActive = false;
function setKittyProtocolActive(active) {
  _kittyProtocolActive = active;
}
function isKittyProtocolActive() {
  return _kittyProtocolActive;
}
const Key = {
  // Special keys
  escape: "escape",
  esc: "esc",
  enter: "enter",
  return: "return",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  clear: "clear",
  home: "home",
  end: "end",
  pageUp: "pageUp",
  pageDown: "pageDown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  f1: "f1",
  f2: "f2",
  f3: "f3",
  f4: "f4",
  f5: "f5",
  f6: "f6",
  f7: "f7",
  f8: "f8",
  f9: "f9",
  f10: "f10",
  f11: "f11",
  f12: "f12",
  // Symbol keys
  backtick: "`",
  hyphen: "-",
  equals: "=",
  leftbracket: "[",
  rightbracket: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  comma: ",",
  period: ".",
  slash: "/",
  exclamation: "!",
  at: "@",
  hash: "#",
  dollar: "$",
  percent: "%",
  caret: "^",
  ampersand: "&",
  asterisk: "*",
  leftparen: "(",
  rightparen: ")",
  underscore: "_",
  plus: "+",
  pipe: "|",
  tilde: "~",
  leftbrace: "{",
  rightbrace: "}",
  colon: ":",
  lessthan: "<",
  greaterthan: ">",
  question: "?",
  // Single modifiers
  ctrl: (key) => `ctrl+${key}`,
  shift: (key) => `shift+${key}`,
  alt: (key) => `alt+${key}`,
  // Combined modifiers
  ctrlShift: (key) => `ctrl+shift+${key}`,
  shiftCtrl: (key) => `shift+ctrl+${key}`,
  ctrlAlt: (key) => `ctrl+alt+${key}`,
  altCtrl: (key) => `alt+ctrl+${key}`,
  shiftAlt: (key) => `shift+alt+${key}`,
  altShift: (key) => `alt+shift+${key}`,
  // Triple modifiers
  ctrlShiftAlt: (key) => `ctrl+shift+alt+${key}`
};
const SYMBOL_KEYS = /* @__PURE__ */ new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?"
]);
const MODIFIERS = {
  shift: 1,
  alt: 2,
  ctrl: 4
};
const LOCK_MASK = 64 + 128;
const CODEPOINTS = {
  escape: 27,
  tab: 9,
  enter: 13,
  space: 32,
  backspace: 127,
  kpEnter: 57414
  // Numpad Enter (Kitty protocol)
};
const KITTY_PRIVATE_USE_RANGE = { start: 57344, end: 63743 };
const KITTY_KEYPAD_PRINTABLES = /* @__PURE__ */ new Map([
  [57399, "0"],
  // KP_0
  [57400, "1"],
  // KP_1
  [57401, "2"],
  // KP_2
  [57402, "3"],
  // KP_3
  [57403, "4"],
  // KP_4
  [57404, "5"],
  // KP_5
  [57405, "6"],
  // KP_6
  [57406, "7"],
  // KP_7
  [57407, "8"],
  // KP_8
  [57408, "9"],
  // KP_9
  [57409, "."],
  // KP_DECIMAL
  [57410, "/"],
  // KP_DIVIDE
  [57411, "*"],
  // KP_MULTIPLY
  [57412, "-"],
  // KP_SUBTRACT
  [57413, "+"],
  // KP_ADD
  [57415, "="],
  // KP_EQUAL
  [57416, ","]
  // KP_SEPARATOR
]);
const ARROW_CODEPOINTS = {
  up: -1,
  down: -2,
  right: -3,
  left: -4
};
const FUNCTIONAL_CODEPOINTS = {
  delete: -10,
  insert: -11,
  pageUp: -12,
  pageDown: -13,
  home: -14,
  end: -15
};
const LEGACY_SEQUENCES = {
  up: { plain: ["\x1B[A", "\x1BOA"], shift: ["\x1B[a"], ctrl: ["\x1BOa"] },
  down: { plain: ["\x1B[B", "\x1BOB"], shift: ["\x1B[b"], ctrl: ["\x1BOb"] },
  right: { plain: ["\x1B[C", "\x1BOC"], shift: ["\x1B[c"], ctrl: ["\x1BOc"] },
  left: { plain: ["\x1B[D", "\x1BOD"], shift: ["\x1B[d"], ctrl: ["\x1BOd"] },
  home: { plain: ["\x1B[H", "\x1BOH", "\x1B[1~", "\x1B[7~"], shift: ["\x1B[7$"], ctrl: ["\x1B[7^"] },
  end: { plain: ["\x1B[F", "\x1BOF", "\x1B[4~", "\x1B[8~"], shift: ["\x1B[8$"], ctrl: ["\x1B[8^"] },
  insert: { plain: ["\x1B[2~"], shift: ["\x1B[2$"], ctrl: ["\x1B[2^"] },
  delete: { plain: ["\x1B[3~"], shift: ["\x1B[3$"], ctrl: ["\x1B[3^"] },
  pageUp: { plain: ["\x1B[5~", "\x1B[[5~"], shift: ["\x1B[5$"], ctrl: ["\x1B[5^"] },
  pageDown: { plain: ["\x1B[6~", "\x1B[[6~"], shift: ["\x1B[6$"], ctrl: ["\x1B[6^"] },
  clear: { plain: ["\x1B[E", "\x1BOE"], shift: ["\x1B[e"], ctrl: ["\x1BOe"] },
  f1: { plain: ["\x1BOP", "\x1B[11~", "\x1B[[A"] },
  f2: { plain: ["\x1BOQ", "\x1B[12~", "\x1B[[B"] },
  f3: { plain: ["\x1BOR", "\x1B[13~", "\x1B[[C"] },
  f4: { plain: ["\x1BOS", "\x1B[14~", "\x1B[[D"] },
  f5: { plain: ["\x1B[15~", "\x1B[[E"] },
  f6: { plain: ["\x1B[17~"] },
  f7: { plain: ["\x1B[18~"] },
  f8: { plain: ["\x1B[19~"] },
  f9: { plain: ["\x1B[20~"] },
  f10: { plain: ["\x1B[21~"] },
  f11: { plain: ["\x1B[23~"] },
  f12: { plain: ["\x1B[24~"] }
};
const LEGACY_SEQUENCE_KEY_IDS = (() => {
  const map = {};
  for (const [key, entry] of Object.entries(LEGACY_SEQUENCES)) {
    const keyId = key;
    if (entry.plain) {
      for (const seq of entry.plain) map[seq] = keyId;
    }
    if (entry.shift) {
      for (const seq of entry.shift) map[seq] = `shift+${keyId}`;
    }
    if (entry.ctrl) {
      for (const seq of entry.ctrl) map[seq] = `ctrl+${keyId}`;
    }
  }
  map["\x1Bb"] = "alt+left";
  map["\x1Bf"] = "alt+right";
  map["\x1Bp"] = "alt+up";
  map["\x1Bn"] = "alt+down";
  return map;
})();
const matchesLegacySequence = (data, sequences) => sequences.includes(data);
const matchesLegacyModifierSequence = (data, key, modifier) => {
  const entry = LEGACY_SEQUENCES[key];
  if (!entry) return false;
  if (modifier === MODIFIERS.shift && entry.shift) {
    return matchesLegacySequence(data, entry.shift);
  }
  if (modifier === MODIFIERS.ctrl && entry.ctrl) {
    return matchesLegacySequence(data, entry.ctrl);
  }
  return false;
};
let _lastEventType = "press";
function hasKittyEventType(data, eventType) {
  if (data.includes("\x1B[200~")) {
    return false;
  }
  const marker = `:${eventType}`;
  return data.includes(`${marker}u`) || data.includes(`${marker}~`) || data.includes(`${marker}A`) || data.includes(`${marker}B`) || data.includes(`${marker}C`) || data.includes(`${marker}D`) || data.includes(`${marker}H`) || data.includes(`${marker}F`);
}
function isKeyRelease(data) {
  return hasKittyEventType(data, 3);
}
function isKeyRepeat(data) {
  return hasKittyEventType(data, 2);
}
function parseEventType(eventTypeStr) {
  if (!eventTypeStr) return "press";
  const eventType = parseInt(eventTypeStr, 10);
  if (eventType === 2) return "repeat";
  if (eventType === 3) return "release";
  return "press";
}
function parseKittySequence(data) {
  const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
  if (csiUMatch) {
    const codepoint = parseInt(csiUMatch[1], 10);
    const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : void 0;
    const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : void 0;
    const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
    const eventType = parseEventType(csiUMatch[5]);
    _lastEventType = eventType;
    return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1, eventType };
  }
  const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
  if (arrowMatch) {
    const modValue = parseInt(arrowMatch[1], 10);
    const eventType = parseEventType(arrowMatch[2]);
    const arrowCodes = { A: -1, B: -2, C: -3, D: -4 };
    _lastEventType = eventType;
    return { codepoint: arrowCodes[arrowMatch[3]], modifier: modValue - 1, eventType };
  }
  const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
  if (funcMatch) {
    const keyNum = parseInt(funcMatch[1], 10);
    const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
    const eventType = parseEventType(funcMatch[3]);
    const funcCodes = {
      2: FUNCTIONAL_CODEPOINTS.insert,
      3: FUNCTIONAL_CODEPOINTS.delete,
      5: FUNCTIONAL_CODEPOINTS.pageUp,
      6: FUNCTIONAL_CODEPOINTS.pageDown,
      7: FUNCTIONAL_CODEPOINTS.home,
      8: FUNCTIONAL_CODEPOINTS.end
    };
    const codepoint = funcCodes[keyNum];
    if (codepoint !== void 0) {
      _lastEventType = eventType;
      return { codepoint, modifier: modValue - 1, eventType };
    }
  }
  const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
  if (homeEndMatch) {
    const modValue = parseInt(homeEndMatch[1], 10);
    const eventType = parseEventType(homeEndMatch[2]);
    const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
    _lastEventType = eventType;
    return { codepoint, modifier: modValue - 1, eventType };
  }
  return null;
}
function matchesKittySequence(data, expectedCodepoint, expectedModifier) {
  const parsed = parseKittySequence(data);
  if (!parsed) return false;
  const actualMod = parsed.modifier & ~LOCK_MASK;
  const expectedMod = expectedModifier & ~LOCK_MASK;
  if (actualMod !== expectedMod) return false;
  if (parsed.codepoint === expectedCodepoint) return true;
  if (parsed.baseLayoutKey !== void 0 && parsed.baseLayoutKey === expectedCodepoint) {
    const cp = parsed.codepoint;
    const isLatinLetter = cp >= 97 && cp <= 122;
    const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
    if (!isLatinLetter && !isKnownSymbol) return true;
  }
  return false;
}
function parseModifyOtherKeysSequence(data) {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return null;
  const modValue = parseInt(match[1], 10);
  const codepoint = parseInt(match[2], 10);
  return { codepoint, modifier: modValue - 1 };
}
function matchesModifyOtherKeys(data, expectedKeycode, expectedModifier) {
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed) return false;
  return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}
function rawCtrlChar(key) {
  const char = key.toLowerCase();
  const code = char.charCodeAt(0);
  if (code >= 97 && code <= 122 || char === "[" || char === "\\" || char === "]" || char === "_") {
    return String.fromCharCode(code & 31);
  }
  if (char === "-") {
    return String.fromCharCode(31);
  }
  return null;
}
function isDigitKey(key) {
  return key >= "0" && key <= "9";
}
function matchesPrintableModifyOtherKeys(data, expectedKeycode, expectedModifier) {
  if (expectedModifier === 0) return false;
  return matchesModifyOtherKeys(data, expectedKeycode, expectedModifier);
}
function formatKeyNameWithModifiers(keyName, modifier) {
  const mods = [];
  const effectiveMod = modifier & ~LOCK_MASK;
  const supportedModifierMask = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt;
  if ((effectiveMod & ~supportedModifierMask) !== 0) return void 0;
  if (effectiveMod & MODIFIERS.shift) mods.push("shift");
  if (effectiveMod & MODIFIERS.ctrl) mods.push("ctrl");
  if (effectiveMod & MODIFIERS.alt) mods.push("alt");
  return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}
function parseKeyId(keyId) {
  const parts = keyId.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (!key) return null;
  return {
    key,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt")
  };
}
function matchesKey(data, keyId) {
  const parsed = parseKeyId(keyId);
  if (!parsed) return false;
  const { key, ctrl, shift, alt } = parsed;
  let modifier = 0;
  if (shift) modifier |= MODIFIERS.shift;
  if (alt) modifier |= MODIFIERS.alt;
  if (ctrl) modifier |= MODIFIERS.ctrl;
  switch (key) {
    case "escape":
    case "esc":
      if (modifier !== 0) return false;
      return data === "\x1B" || matchesKittySequence(data, CODEPOINTS.escape, 0);
    case "space":
      if (!_kittyProtocolActive) {
        if (ctrl && !alt && !shift && data === "\0") {
          return true;
        }
        if (alt && !ctrl && !shift && data === "\x1B ") {
          return true;
        }
      }
      if (modifier === 0) {
        return data === " " || matchesKittySequence(data, CODEPOINTS.space, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.space, modifier);
    case "tab":
      if (shift && !ctrl && !alt) {
        return data === "\x1B[Z" || matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift);
      }
      if (modifier === 0) {
        return data === "	" || matchesKittySequence(data, CODEPOINTS.tab, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.tab, modifier);
    case "enter":
    case "return":
      if (shift && !ctrl && !alt) {
        if (matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) || matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)) {
          return true;
        }
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
          return true;
        }
        if (_kittyProtocolActive) {
          return data === "\x1B\r" || data === "\n";
        }
        return false;
      }
      if (alt && !ctrl && !shift) {
        if (matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) || matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)) {
          return true;
        }
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
          return true;
        }
        if (!_kittyProtocolActive) {
          return data === "\x1B\r";
        }
        return false;
      }
      if (modifier === 0) {
        return data === "\r" || !_kittyProtocolActive && data === "\n" || data === "\x1BOM" || // SS3 M (numpad enter in some terminals)
        matchesKittySequence(data, CODEPOINTS.enter, 0) || matchesKittySequence(data, CODEPOINTS.kpEnter, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.enter, modifier) || matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier);
    case "backspace":
      if (alt && !ctrl && !shift) {
        if (data === "\x1B\x7F" || data === "\x1B\b") {
          return true;
        }
        return matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return data === "\x7F" || data === "\b" || matchesKittySequence(data, CODEPOINTS.backspace, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.backspace, modifier);
    case "insert":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.insert.plain) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0);
      }
      if (matchesLegacyModifierSequence(data, "insert", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);
    case "delete":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.delete.plain) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0);
      }
      if (matchesLegacyModifierSequence(data, "delete", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);
    case "clear":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.clear.plain);
      }
      return matchesLegacyModifierSequence(data, "clear", modifier);
    case "home":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.home.plain) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0);
      }
      if (matchesLegacyModifierSequence(data, "home", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);
    case "end":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.end.plain) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0);
      }
      if (matchesLegacyModifierSequence(data, "end", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);
    case "pageup":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.pageUp.plain) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0);
      }
      if (matchesLegacyModifierSequence(data, "pageUp", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);
    case "pagedown":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.pageDown.plain) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0);
      }
      if (matchesLegacyModifierSequence(data, "pageDown", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);
    case "up":
      if (alt && !ctrl && !shift) {
        return data === "\x1Bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.up.plain) || matchesKittySequence(data, ARROW_CODEPOINTS.up, 0);
      }
      if (matchesLegacyModifierSequence(data, "up", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);
    case "down":
      if (alt && !ctrl && !shift) {
        return data === "\x1Bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.down.plain) || matchesKittySequence(data, ARROW_CODEPOINTS.down, 0);
      }
      if (matchesLegacyModifierSequence(data, "down", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);
    case "left":
      if (alt && !ctrl && !shift) {
        return data === "\x1B[1;3D" || !_kittyProtocolActive && data === "\x1BB" || data === "\x1Bb" || matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt);
      }
      if (ctrl && !alt && !shift) {
        return data === "\x1B[1;5D" || matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) || matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.left.plain) || matchesKittySequence(data, ARROW_CODEPOINTS.left, 0);
      }
      if (matchesLegacyModifierSequence(data, "left", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);
    case "right":
      if (alt && !ctrl && !shift) {
        return data === "\x1B[1;3C" || !_kittyProtocolActive && data === "\x1BF" || data === "\x1Bf" || matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt);
      }
      if (ctrl && !alt && !shift) {
        return data === "\x1B[1;5C" || matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) || matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_SEQUENCES.right.plain) || matchesKittySequence(data, ARROW_CODEPOINTS.right, 0);
      }
      if (matchesLegacyModifierSequence(data, "right", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);
    case "f1":
    case "f2":
    case "f3":
    case "f4":
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "f9":
    case "f10":
    case "f11":
    case "f12": {
      if (modifier !== 0) {
        return false;
      }
      const functionKey = key;
      return matchesLegacySequence(data, LEGACY_SEQUENCES[functionKey].plain);
    }
  }
  if (key.length === 1 && (key >= "a" && key <= "z" || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
    const codepoint = key.charCodeAt(0);
    const rawCtrl = rawCtrlChar(key);
    const isLetter = key >= "a" && key <= "z";
    const isDigit = isDigitKey(key);
    if (ctrl && alt && !shift && !_kittyProtocolActive && rawCtrl) {
      return data === `\x1B${rawCtrl}`;
    }
    if (alt && !ctrl && !shift && !_kittyProtocolActive && (isLetter || isDigit)) {
      if (data === `\x1B${key}`) return true;
    }
    if (ctrl && !shift && !alt) {
      if (rawCtrl && data === rawCtrl) return true;
      return matchesKittySequence(data, codepoint, MODIFIERS.ctrl) || matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl);
    }
    if (ctrl && shift && !alt) {
      return matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) || matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl);
    }
    if (shift && !ctrl && !alt) {
      if (isLetter && data === key.toUpperCase()) return true;
      return matchesKittySequence(data, codepoint, MODIFIERS.shift) || matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift);
    }
    if (modifier !== 0) {
      return matchesKittySequence(data, codepoint, modifier) || matchesPrintableModifyOtherKeys(data, codepoint, modifier);
    }
    return data === key || matchesKittySequence(data, codepoint, 0);
  }
  return false;
}
function formatParsedKey(codepoint, modifier, baseLayoutKey) {
  const isLatinLetter = codepoint >= 97 && codepoint <= 122;
  const isDigit = codepoint >= 48 && codepoint <= 57;
  const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(codepoint));
  const effectiveCodepoint = isLatinLetter || isDigit || isKnownSymbol ? codepoint : baseLayoutKey ?? codepoint;
  let keyName;
  if (effectiveCodepoint === CODEPOINTS.escape) keyName = "escape";
  else if (effectiveCodepoint === CODEPOINTS.tab) keyName = "tab";
  else if (effectiveCodepoint === CODEPOINTS.enter || effectiveCodepoint === CODEPOINTS.kpEnter) keyName = "enter";
  else if (effectiveCodepoint === CODEPOINTS.space) keyName = "space";
  else if (effectiveCodepoint === CODEPOINTS.backspace) keyName = "backspace";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.delete) keyName = "delete";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.insert) keyName = "insert";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.home) keyName = "home";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.end) keyName = "end";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageUp) keyName = "pageUp";
  else if (effectiveCodepoint === FUNCTIONAL_CODEPOINTS.pageDown) keyName = "pageDown";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.up) keyName = "up";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.down) keyName = "down";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.left) keyName = "left";
  else if (effectiveCodepoint === ARROW_CODEPOINTS.right) keyName = "right";
  else if (effectiveCodepoint >= 48 && effectiveCodepoint <= 57) keyName = String.fromCharCode(effectiveCodepoint);
  else if (effectiveCodepoint >= 97 && effectiveCodepoint <= 122) keyName = String.fromCharCode(effectiveCodepoint);
  else if (SYMBOL_KEYS.has(String.fromCharCode(effectiveCodepoint))) keyName = String.fromCharCode(effectiveCodepoint);
  if (!keyName) return void 0;
  return formatKeyNameWithModifiers(keyName, modifier);
}
function parseKey(data) {
  const kitty = parseKittySequence(data);
  if (kitty) {
    return formatParsedKey(kitty.codepoint, kitty.modifier, kitty.baseLayoutKey);
  }
  const modifyOtherKeys = parseModifyOtherKeysSequence(data);
  if (modifyOtherKeys) {
    return formatParsedKey(modifyOtherKeys.codepoint, modifyOtherKeys.modifier);
  }
  if (_kittyProtocolActive) {
    if (data === "\x1B\r" || data === "\n") return "shift+enter";
  }
  const legacySequenceKeyId = LEGACY_SEQUENCE_KEY_IDS[data];
  if (legacySequenceKeyId) return legacySequenceKeyId;
  if (data === "\x1B") return "escape";
  if (data === "") return "ctrl+\\";
  if (data === "") return "ctrl+]";
  if (data === "") return "ctrl+-";
  if (data === "\x1B\x1B") return "ctrl+alt+[";
  if (data === "\x1B") return "ctrl+alt+\\";
  if (data === "\x1B") return "ctrl+alt+]";
  if (data === "\x1B") return "ctrl+alt+-";
  if (data === "	") return "tab";
  if (data === "\r" || !_kittyProtocolActive && data === "\n" || data === "\x1BOM") return "enter";
  if (data === "\0") return "ctrl+space";
  if (data === " ") return "space";
  if (data === "\x7F" || data === "\b") return "backspace";
  if (data === "\x1B[Z") return "shift+tab";
  if (!_kittyProtocolActive && data === "\x1B\r") return "alt+enter";
  if (!_kittyProtocolActive && data === "\x1B ") return "alt+space";
  if (data === "\x1B\x7F" || data === "\x1B\b") return "alt+backspace";
  if (!_kittyProtocolActive && data === "\x1BB") return "alt+left";
  if (!_kittyProtocolActive && data === "\x1BF") return "alt+right";
  if (!_kittyProtocolActive && data.length === 2 && data[0] === "\x1B") {
    const code = data.charCodeAt(1);
    if (code >= 1 && code <= 26) {
      return `ctrl+alt+${String.fromCharCode(code + 96)}`;
    }
    if (code >= 97 && code <= 122 || code >= 48 && code <= 57) {
      return `alt+${String.fromCharCode(code)}`;
    }
  }
  if (data === "\x1B[A") return "up";
  if (data === "\x1B[B") return "down";
  if (data === "\x1B[C") return "right";
  if (data === "\x1B[D") return "left";
  if (data === "\x1B[H" || data === "\x1BOH") return "home";
  if (data === "\x1B[F" || data === "\x1BOF") return "end";
  if (data === "\x1B[3~") return "delete";
  if (data === "\x1B[5~") return "pageUp";
  if (data === "\x1B[6~") return "pageDown";
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return `ctrl+${String.fromCharCode(code + 96)}`;
    }
    if (code >= 32 && code <= 126) {
      return data;
    }
  }
  return void 0;
}
const KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;
function decodeKittyPrintable(data) {
  const match = data.match(KITTY_CSI_U_REGEX);
  if (!match) return void 0;
  const codepoint = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(codepoint)) return void 0;
  const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : void 0;
  const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
  if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return void 0;
  if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return void 0;
  let effectiveCodepoint = codepoint;
  if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") {
    effectiveCodepoint = shiftedKey;
  }
  if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32) return void 0;
  const keypadPrintable = KITTY_KEYPAD_PRINTABLES.get(effectiveCodepoint);
  if (keypadPrintable !== void 0) return keypadPrintable;
  if (effectiveCodepoint >= KITTY_PRIVATE_USE_RANGE.start && effectiveCodepoint <= KITTY_PRIVATE_USE_RANGE.end) {
    return void 0;
  }
  try {
    return String.fromCodePoint(effectiveCodepoint);
  } catch {
    return void 0;
  }
}
export {
  Key,
  decodeKittyPrintable,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  matchesKey,
  parseKey,
  setKittyProtocolActive
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9rZXlzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEtleWJvYXJkIGlucHV0IGhhbmRsaW5nIGZvciB0ZXJtaW5hbCBhcHBsaWNhdGlvbnMuXG4gKlxuICogU3VwcG9ydHMgYm90aCBsZWdhY3kgdGVybWluYWwgc2VxdWVuY2VzIGFuZCBLaXR0eSBrZXlib2FyZCBwcm90b2NvbC5cbiAqIFNlZTogaHR0cHM6Ly9zdy5rb3ZpZGdveWFsLm5ldC9raXR0eS9rZXlib2FyZC1wcm90b2NvbC9cbiAqIFJlZmVyZW5jZTogaHR0cHM6Ly9naXRodWIuY29tL3NzdC9vcGVudHVpL2Jsb2IvN2RhOTJiNDA4OGFlYmZlMjdiOWY2OTFjMDQxNjNhNDg4MjFlNDlmZC9wYWNrYWdlcy9jb3JlL3NyYy9saWIvcGFyc2Uua2V5cHJlc3MudHNcbiAqXG4gKiBTeW1ib2wga2V5cyBhcmUgYWxzbyBzdXBwb3J0ZWQsIGhvd2V2ZXIgc29tZSBjdHJsK3N5bWJvbCBjb21ib3NcbiAqIG92ZXJsYXAgd2l0aCBBU0NJSSBjb2RlcywgZS5nLiBjdHJsK1sgPSBFU0MuXG4gKiBTZWU6IGh0dHBzOi8vc3cua292aWRnb3lhbC5uZXQva2l0dHkva2V5Ym9hcmQtcHJvdG9jb2wvI2xlZ2FjeS1jdHJsLW1hcHBpbmctb2YtYXNjaWkta2V5c1xuICogVGhvc2UgY2FuIHN0aWxsIGJlICogdXNlZCBmb3IgY3RybCtzaGlmdCBjb21ib3NcbiAqXG4gKiBBUEk6XG4gKiAtIG1hdGNoZXNLZXkoZGF0YSwga2V5SWQpIC0gQ2hlY2sgaWYgaW5wdXQgbWF0Y2hlcyBhIGtleSBpZGVudGlmaWVyXG4gKiAtIHBhcnNlS2V5KGRhdGEpIC0gUGFyc2UgaW5wdXQgYW5kIHJldHVybiB0aGUga2V5IGlkZW50aWZpZXJcbiAqIC0gS2V5IC0gSGVscGVyIG9iamVjdCBmb3IgY3JlYXRpbmcgdHlwZWQga2V5IGlkZW50aWZpZXJzXG4gKiAtIHNldEtpdHR5UHJvdG9jb2xBY3RpdmUoYWN0aXZlKSAtIFNldCBnbG9iYWwgS2l0dHkgcHJvdG9jb2wgc3RhdGVcbiAqIC0gaXNLaXR0eVByb3RvY29sQWN0aXZlKCkgLSBRdWVyeSBnbG9iYWwgS2l0dHkgcHJvdG9jb2wgc3RhdGVcbiAqL1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR2xvYmFsIEtpdHR5IFByb3RvY29sIFN0YXRlXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5sZXQgX2tpdHR5UHJvdG9jb2xBY3RpdmUgPSBmYWxzZTtcblxuLyoqXG4gKiBTZXQgdGhlIGdsb2JhbCBLaXR0eSBrZXlib2FyZCBwcm90b2NvbCBzdGF0ZS5cbiAqIENhbGxlZCBieSBQcm9jZXNzVGVybWluYWwgYWZ0ZXIgZGV0ZWN0aW5nIHByb3RvY29sIHN1cHBvcnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRLaXR0eVByb3RvY29sQWN0aXZlKGFjdGl2ZTogYm9vbGVhbik6IHZvaWQge1xuXHRfa2l0dHlQcm90b2NvbEFjdGl2ZSA9IGFjdGl2ZTtcbn1cblxuLyoqXG4gKiBRdWVyeSB3aGV0aGVyIEtpdHR5IGtleWJvYXJkIHByb3RvY29sIGlzIGN1cnJlbnRseSBhY3RpdmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0tpdHR5UHJvdG9jb2xBY3RpdmUoKTogYm9vbGVhbiB7XG5cdHJldHVybiBfa2l0dHlQcm90b2NvbEFjdGl2ZTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFR5cGUtU2FmZSBLZXkgSWRlbnRpZmllcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbnR5cGUgTGV0dGVyID1cblx0fCBcImFcIlxuXHR8IFwiYlwiXG5cdHwgXCJjXCJcblx0fCBcImRcIlxuXHR8IFwiZVwiXG5cdHwgXCJmXCJcblx0fCBcImdcIlxuXHR8IFwiaFwiXG5cdHwgXCJpXCJcblx0fCBcImpcIlxuXHR8IFwia1wiXG5cdHwgXCJsXCJcblx0fCBcIm1cIlxuXHR8IFwiblwiXG5cdHwgXCJvXCJcblx0fCBcInBcIlxuXHR8IFwicVwiXG5cdHwgXCJyXCJcblx0fCBcInNcIlxuXHR8IFwidFwiXG5cdHwgXCJ1XCJcblx0fCBcInZcIlxuXHR8IFwid1wiXG5cdHwgXCJ4XCJcblx0fCBcInlcIlxuXHR8IFwielwiO1xuXG50eXBlIERpZ2l0ID0gXCIwXCIgfCBcIjFcIiB8IFwiMlwiIHwgXCIzXCIgfCBcIjRcIiB8IFwiNVwiIHwgXCI2XCIgfCBcIjdcIiB8IFwiOFwiIHwgXCI5XCI7XG5cbnR5cGUgU3ltYm9sS2V5ID1cblx0fCBcImBcIlxuXHR8IFwiLVwiXG5cdHwgXCI9XCJcblx0fCBcIltcIlxuXHR8IFwiXVwiXG5cdHwgXCJcXFxcXCJcblx0fCBcIjtcIlxuXHR8IFwiJ1wiXG5cdHwgXCIsXCJcblx0fCBcIi5cIlxuXHR8IFwiL1wiXG5cdHwgXCIhXCJcblx0fCBcIkBcIlxuXHR8IFwiI1wiXG5cdHwgXCIkXCJcblx0fCBcIiVcIlxuXHR8IFwiXlwiXG5cdHwgXCImXCJcblx0fCBcIipcIlxuXHR8IFwiKFwiXG5cdHwgXCIpXCJcblx0fCBcIl9cIlxuXHR8IFwiK1wiXG5cdHwgXCJ8XCJcblx0fCBcIn5cIlxuXHR8IFwie1wiXG5cdHwgXCJ9XCJcblx0fCBcIjpcIlxuXHR8IFwiPFwiXG5cdHwgXCI+XCJcblx0fCBcIj9cIjtcblxudHlwZSBTcGVjaWFsS2V5ID1cblx0fCBcImVzY2FwZVwiXG5cdHwgXCJlc2NcIlxuXHR8IFwiZW50ZXJcIlxuXHR8IFwicmV0dXJuXCJcblx0fCBcInRhYlwiXG5cdHwgXCJzcGFjZVwiXG5cdHwgXCJiYWNrc3BhY2VcIlxuXHR8IFwiZGVsZXRlXCJcblx0fCBcImluc2VydFwiXG5cdHwgXCJjbGVhclwiXG5cdHwgXCJob21lXCJcblx0fCBcImVuZFwiXG5cdHwgXCJwYWdlVXBcIlxuXHR8IFwicGFnZURvd25cIlxuXHR8IFwidXBcIlxuXHR8IFwiZG93blwiXG5cdHwgXCJsZWZ0XCJcblx0fCBcInJpZ2h0XCJcblx0fCBcImYxXCJcblx0fCBcImYyXCJcblx0fCBcImYzXCJcblx0fCBcImY0XCJcblx0fCBcImY1XCJcblx0fCBcImY2XCJcblx0fCBcImY3XCJcblx0fCBcImY4XCJcblx0fCBcImY5XCJcblx0fCBcImYxMFwiXG5cdHwgXCJmMTFcIlxuXHR8IFwiZjEyXCI7XG5cbnR5cGUgQmFzZUtleSA9IExldHRlciB8IERpZ2l0IHwgU3ltYm9sS2V5IHwgU3BlY2lhbEtleTtcblxuLyoqXG4gKiBVbmlvbiB0eXBlIG9mIGFsbCB2YWxpZCBrZXkgaWRlbnRpZmllcnMuXG4gKiBQcm92aWRlcyBhdXRvY29tcGxldGUgYW5kIGNhdGNoZXMgdHlwb3MgYXQgY29tcGlsZSB0aW1lLlxuICovXG5leHBvcnQgdHlwZSBLZXlJZCA9XG5cdHwgQmFzZUtleVxuXHR8IGBjdHJsKyR7QmFzZUtleX1gXG5cdHwgYHNoaWZ0KyR7QmFzZUtleX1gXG5cdHwgYGFsdCske0Jhc2VLZXl9YFxuXHR8IGBjdHJsK3NoaWZ0KyR7QmFzZUtleX1gXG5cdHwgYHNoaWZ0K2N0cmwrJHtCYXNlS2V5fWBcblx0fCBgY3RybCthbHQrJHtCYXNlS2V5fWBcblx0fCBgYWx0K2N0cmwrJHtCYXNlS2V5fWBcblx0fCBgc2hpZnQrYWx0KyR7QmFzZUtleX1gXG5cdHwgYGFsdCtzaGlmdCske0Jhc2VLZXl9YFxuXHR8IGBjdHJsK3NoaWZ0K2FsdCske0Jhc2VLZXl9YFxuXHR8IGBjdHJsK2FsdCtzaGlmdCske0Jhc2VLZXl9YFxuXHR8IGBzaGlmdCtjdHJsK2FsdCske0Jhc2VLZXl9YFxuXHR8IGBzaGlmdCthbHQrY3RybCske0Jhc2VLZXl9YFxuXHR8IGBhbHQrY3RybCtzaGlmdCske0Jhc2VLZXl9YFxuXHR8IGBhbHQrc2hpZnQrY3RybCske0Jhc2VLZXl9YDtcblxuLyoqXG4gKiBIZWxwZXIgb2JqZWN0IGZvciBjcmVhdGluZyB0eXBlZCBrZXkgaWRlbnRpZmllcnMgd2l0aCBhdXRvY29tcGxldGUuXG4gKlxuICogVXNhZ2U6XG4gKiAtIEtleS5lc2NhcGUsIEtleS5lbnRlciwgS2V5LnRhYiwgZXRjLiBmb3Igc3BlY2lhbCBrZXlzXG4gKiAtIEtleS5iYWNrdGljaywgS2V5LmNvbW1hLCBLZXkucGVyaW9kLCBldGMuIGZvciBzeW1ib2wga2V5c1xuICogLSBLZXkuY3RybChcImNcIiksIEtleS5hbHQoXCJ4XCIpIGZvciBzaW5nbGUgbW9kaWZpZXJcbiAqIC0gS2V5LmN0cmxTaGlmdChcInBcIiksIEtleS5jdHJsQWx0KFwieFwiKSBmb3IgY29tYmluZWQgbW9kaWZpZXJzXG4gKi9cbmV4cG9ydCBjb25zdCBLZXkgPSB7XG5cdC8vIFNwZWNpYWwga2V5c1xuXHRlc2NhcGU6IFwiZXNjYXBlXCIgYXMgY29uc3QsXG5cdGVzYzogXCJlc2NcIiBhcyBjb25zdCxcblx0ZW50ZXI6IFwiZW50ZXJcIiBhcyBjb25zdCxcblx0cmV0dXJuOiBcInJldHVyblwiIGFzIGNvbnN0LFxuXHR0YWI6IFwidGFiXCIgYXMgY29uc3QsXG5cdHNwYWNlOiBcInNwYWNlXCIgYXMgY29uc3QsXG5cdGJhY2tzcGFjZTogXCJiYWNrc3BhY2VcIiBhcyBjb25zdCxcblx0ZGVsZXRlOiBcImRlbGV0ZVwiIGFzIGNvbnN0LFxuXHRpbnNlcnQ6IFwiaW5zZXJ0XCIgYXMgY29uc3QsXG5cdGNsZWFyOiBcImNsZWFyXCIgYXMgY29uc3QsXG5cdGhvbWU6IFwiaG9tZVwiIGFzIGNvbnN0LFxuXHRlbmQ6IFwiZW5kXCIgYXMgY29uc3QsXG5cdHBhZ2VVcDogXCJwYWdlVXBcIiBhcyBjb25zdCxcblx0cGFnZURvd246IFwicGFnZURvd25cIiBhcyBjb25zdCxcblx0dXA6IFwidXBcIiBhcyBjb25zdCxcblx0ZG93bjogXCJkb3duXCIgYXMgY29uc3QsXG5cdGxlZnQ6IFwibGVmdFwiIGFzIGNvbnN0LFxuXHRyaWdodDogXCJyaWdodFwiIGFzIGNvbnN0LFxuXHRmMTogXCJmMVwiIGFzIGNvbnN0LFxuXHRmMjogXCJmMlwiIGFzIGNvbnN0LFxuXHRmMzogXCJmM1wiIGFzIGNvbnN0LFxuXHRmNDogXCJmNFwiIGFzIGNvbnN0LFxuXHRmNTogXCJmNVwiIGFzIGNvbnN0LFxuXHRmNjogXCJmNlwiIGFzIGNvbnN0LFxuXHRmNzogXCJmN1wiIGFzIGNvbnN0LFxuXHRmODogXCJmOFwiIGFzIGNvbnN0LFxuXHRmOTogXCJmOVwiIGFzIGNvbnN0LFxuXHRmMTA6IFwiZjEwXCIgYXMgY29uc3QsXG5cdGYxMTogXCJmMTFcIiBhcyBjb25zdCxcblx0ZjEyOiBcImYxMlwiIGFzIGNvbnN0LFxuXG5cdC8vIFN5bWJvbCBrZXlzXG5cdGJhY2t0aWNrOiBcImBcIiBhcyBjb25zdCxcblx0aHlwaGVuOiBcIi1cIiBhcyBjb25zdCxcblx0ZXF1YWxzOiBcIj1cIiBhcyBjb25zdCxcblx0bGVmdGJyYWNrZXQ6IFwiW1wiIGFzIGNvbnN0LFxuXHRyaWdodGJyYWNrZXQ6IFwiXVwiIGFzIGNvbnN0LFxuXHRiYWNrc2xhc2g6IFwiXFxcXFwiIGFzIGNvbnN0LFxuXHRzZW1pY29sb246IFwiO1wiIGFzIGNvbnN0LFxuXHRxdW90ZTogXCInXCIgYXMgY29uc3QsXG5cdGNvbW1hOiBcIixcIiBhcyBjb25zdCxcblx0cGVyaW9kOiBcIi5cIiBhcyBjb25zdCxcblx0c2xhc2g6IFwiL1wiIGFzIGNvbnN0LFxuXHRleGNsYW1hdGlvbjogXCIhXCIgYXMgY29uc3QsXG5cdGF0OiBcIkBcIiBhcyBjb25zdCxcblx0aGFzaDogXCIjXCIgYXMgY29uc3QsXG5cdGRvbGxhcjogXCIkXCIgYXMgY29uc3QsXG5cdHBlcmNlbnQ6IFwiJVwiIGFzIGNvbnN0LFxuXHRjYXJldDogXCJeXCIgYXMgY29uc3QsXG5cdGFtcGVyc2FuZDogXCImXCIgYXMgY29uc3QsXG5cdGFzdGVyaXNrOiBcIipcIiBhcyBjb25zdCxcblx0bGVmdHBhcmVuOiBcIihcIiBhcyBjb25zdCxcblx0cmlnaHRwYXJlbjogXCIpXCIgYXMgY29uc3QsXG5cdHVuZGVyc2NvcmU6IFwiX1wiIGFzIGNvbnN0LFxuXHRwbHVzOiBcIitcIiBhcyBjb25zdCxcblx0cGlwZTogXCJ8XCIgYXMgY29uc3QsXG5cdHRpbGRlOiBcIn5cIiBhcyBjb25zdCxcblx0bGVmdGJyYWNlOiBcIntcIiBhcyBjb25zdCxcblx0cmlnaHRicmFjZTogXCJ9XCIgYXMgY29uc3QsXG5cdGNvbG9uOiBcIjpcIiBhcyBjb25zdCxcblx0bGVzc3RoYW46IFwiPFwiIGFzIGNvbnN0LFxuXHRncmVhdGVydGhhbjogXCI+XCIgYXMgY29uc3QsXG5cdHF1ZXN0aW9uOiBcIj9cIiBhcyBjb25zdCxcblxuXHQvLyBTaW5nbGUgbW9kaWZpZXJzXG5cdGN0cmw6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYGN0cmwrJHtLfWAgPT4gYGN0cmwrJHtrZXl9YCxcblx0c2hpZnQ6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYHNoaWZ0KyR7S31gID0+IGBzaGlmdCske2tleX1gLFxuXHRhbHQ6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYGFsdCske0t9YCA9PiBgYWx0KyR7a2V5fWAsXG5cblx0Ly8gQ29tYmluZWQgbW9kaWZpZXJzXG5cdGN0cmxTaGlmdDogPEsgZXh0ZW5kcyBCYXNlS2V5PihrZXk6IEspOiBgY3RybCtzaGlmdCske0t9YCA9PiBgY3RybCtzaGlmdCske2tleX1gLFxuXHRzaGlmdEN0cmw6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYHNoaWZ0K2N0cmwrJHtLfWAgPT4gYHNoaWZ0K2N0cmwrJHtrZXl9YCxcblx0Y3RybEFsdDogPEsgZXh0ZW5kcyBCYXNlS2V5PihrZXk6IEspOiBgY3RybCthbHQrJHtLfWAgPT4gYGN0cmwrYWx0KyR7a2V5fWAsXG5cdGFsdEN0cmw6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYGFsdCtjdHJsKyR7S31gID0+IGBhbHQrY3RybCske2tleX1gLFxuXHRzaGlmdEFsdDogPEsgZXh0ZW5kcyBCYXNlS2V5PihrZXk6IEspOiBgc2hpZnQrYWx0KyR7S31gID0+IGBzaGlmdCthbHQrJHtrZXl9YCxcblx0YWx0U2hpZnQ6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYGFsdCtzaGlmdCske0t9YCA9PiBgYWx0K3NoaWZ0KyR7a2V5fWAsXG5cblx0Ly8gVHJpcGxlIG1vZGlmaWVyc1xuXHRjdHJsU2hpZnRBbHQ6IDxLIGV4dGVuZHMgQmFzZUtleT4oa2V5OiBLKTogYGN0cmwrc2hpZnQrYWx0KyR7S31gID0+IGBjdHJsK3NoaWZ0K2FsdCske2tleX1gLFxufSBhcyBjb25zdDtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENvbnN0YW50c1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgU1lNQk9MX0tFWVMgPSBuZXcgU2V0KFtcblx0XCJgXCIsXG5cdFwiLVwiLFxuXHRcIj1cIixcblx0XCJbXCIsXG5cdFwiXVwiLFxuXHRcIlxcXFxcIixcblx0XCI7XCIsXG5cdFwiJ1wiLFxuXHRcIixcIixcblx0XCIuXCIsXG5cdFwiL1wiLFxuXHRcIiFcIixcblx0XCJAXCIsXG5cdFwiI1wiLFxuXHRcIiRcIixcblx0XCIlXCIsXG5cdFwiXlwiLFxuXHRcIiZcIixcblx0XCIqXCIsXG5cdFwiKFwiLFxuXHRcIilcIixcblx0XCJfXCIsXG5cdFwiK1wiLFxuXHRcInxcIixcblx0XCJ+XCIsXG5cdFwie1wiLFxuXHRcIn1cIixcblx0XCI6XCIsXG5cdFwiPFwiLFxuXHRcIj5cIixcblx0XCI/XCIsXG5dKTtcblxuY29uc3QgTU9ESUZJRVJTID0ge1xuXHRzaGlmdDogMSxcblx0YWx0OiAyLFxuXHRjdHJsOiA0LFxufSBhcyBjb25zdDtcblxuY29uc3QgTE9DS19NQVNLID0gNjQgKyAxMjg7IC8vIENhcHMgTG9jayArIE51bSBMb2NrXG5cbmNvbnN0IENPREVQT0lOVFMgPSB7XG5cdGVzY2FwZTogMjcsXG5cdHRhYjogOSxcblx0ZW50ZXI6IDEzLFxuXHRzcGFjZTogMzIsXG5cdGJhY2tzcGFjZTogMTI3LFxuXHRrcEVudGVyOiA1NzQxNCwgLy8gTnVtcGFkIEVudGVyIChLaXR0eSBwcm90b2NvbClcbn0gYXMgY29uc3Q7XG5cbmNvbnN0IEtJVFRZX1BSSVZBVEVfVVNFX1JBTkdFID0geyBzdGFydDogNTczNDQsIGVuZDogNjM3NDMgfSBhcyBjb25zdDtcblxuY29uc3QgS0lUVFlfS0VZUEFEX1BSSU5UQUJMRVMgPSBuZXcgTWFwPG51bWJlciwgc3RyaW5nPihbXG5cdFs1NzM5OSwgXCIwXCJdLCAvLyBLUF8wXG5cdFs1NzQwMCwgXCIxXCJdLCAvLyBLUF8xXG5cdFs1NzQwMSwgXCIyXCJdLCAvLyBLUF8yXG5cdFs1NzQwMiwgXCIzXCJdLCAvLyBLUF8zXG5cdFs1NzQwMywgXCI0XCJdLCAvLyBLUF80XG5cdFs1NzQwNCwgXCI1XCJdLCAvLyBLUF81XG5cdFs1NzQwNSwgXCI2XCJdLCAvLyBLUF82XG5cdFs1NzQwNiwgXCI3XCJdLCAvLyBLUF83XG5cdFs1NzQwNywgXCI4XCJdLCAvLyBLUF84XG5cdFs1NzQwOCwgXCI5XCJdLCAvLyBLUF85XG5cdFs1NzQwOSwgXCIuXCJdLCAvLyBLUF9ERUNJTUFMXG5cdFs1NzQxMCwgXCIvXCJdLCAvLyBLUF9ESVZJREVcblx0WzU3NDExLCBcIipcIl0sIC8vIEtQX01VTFRJUExZXG5cdFs1NzQxMiwgXCItXCJdLCAvLyBLUF9TVUJUUkFDVFxuXHRbNTc0MTMsIFwiK1wiXSwgLy8gS1BfQUREXG5cdFs1NzQxNSwgXCI9XCJdLCAvLyBLUF9FUVVBTFxuXHRbNTc0MTYsIFwiLFwiXSwgLy8gS1BfU0VQQVJBVE9SXG5dKTtcblxuY29uc3QgQVJST1dfQ09ERVBPSU5UUyA9IHtcblx0dXA6IC0xLFxuXHRkb3duOiAtMixcblx0cmlnaHQ6IC0zLFxuXHRsZWZ0OiAtNCxcbn0gYXMgY29uc3Q7XG5cbmNvbnN0IEZVTkNUSU9OQUxfQ09ERVBPSU5UUyA9IHtcblx0ZGVsZXRlOiAtMTAsXG5cdGluc2VydDogLTExLFxuXHRwYWdlVXA6IC0xMixcblx0cGFnZURvd246IC0xMyxcblx0aG9tZTogLTE0LFxuXHRlbmQ6IC0xNSxcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogQ29uc29saWRhdGVkIGxlZ2FjeSB0ZXJtaW5hbCBrZXkgc2VxdWVuY2VzLlxuICogRWFjaCBrZXkgbWFwcyB0byBpdHMgc2VxdWVuY2VzIGZvciB1bm1vZGlmaWVkLCBzaGlmdC1tb2RpZmllZCwgYW5kIGN0cmwtbW9kaWZpZWQgdmFyaWFudHMuXG4gKiBUaGlzIHNpbmdsZSBzdHJ1Y3R1cmUgcmVwbGFjZXMgdGhyZWUgc2VwYXJhdGUgbWFwcyAoTEVHQUNZX0tFWV9TRVFVRU5DRVMsXG4gKiBMRUdBQ1lfU0hJRlRfU0VRVUVOQ0VTLCBMRUdBQ1lfQ1RSTF9TRVFVRU5DRVMpIHRoYXQgc2hhcmVkIHRoZSBzYW1lIGtleSBzZXRzLlxuICovXG5jb25zdCBMRUdBQ1lfU0VRVUVOQ0VTOiBSZWNvcmQ8c3RyaW5nLCB7IHBsYWluPzogcmVhZG9ubHkgc3RyaW5nW107IHNoaWZ0PzogcmVhZG9ubHkgc3RyaW5nW107IGN0cmw/OiByZWFkb25seSBzdHJpbmdbXSB9PiA9IHtcblx0dXA6ICAgICAgIHsgcGxhaW46IFtcIlxceDFiW0FcIiwgXCJcXHgxYk9BXCJdLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaGlmdDogW1wiXFx4MWJbYVwiXSwgIGN0cmw6IFtcIlxceDFiT2FcIl0gIH0sXG5cdGRvd246ICAgICB7IHBsYWluOiBbXCJcXHgxYltCXCIsIFwiXFx4MWJPQlwiXSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hpZnQ6IFtcIlxceDFiW2JcIl0sICBjdHJsOiBbXCJcXHgxYk9iXCJdICB9LFxuXHRyaWdodDogICAgeyBwbGFpbjogW1wiXFx4MWJbQ1wiLCBcIlxceDFiT0NcIl0sICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNoaWZ0OiBbXCJcXHgxYltjXCJdLCAgY3RybDogW1wiXFx4MWJPY1wiXSAgfSxcblx0bGVmdDogICAgIHsgcGxhaW46IFtcIlxceDFiW0RcIiwgXCJcXHgxYk9EXCJdLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaGlmdDogW1wiXFx4MWJbZFwiXSwgIGN0cmw6IFtcIlxceDFiT2RcIl0gIH0sXG5cdGhvbWU6ICAgICB7IHBsYWluOiBbXCJcXHgxYltIXCIsIFwiXFx4MWJPSFwiLCBcIlxceDFiWzF+XCIsIFwiXFx4MWJbN35cIl0sICAgc2hpZnQ6IFtcIlxceDFiWzckXCJdLCBjdHJsOiBbXCJcXHgxYls3XlwiXSB9LFxuXHRlbmQ6ICAgICAgeyBwbGFpbjogW1wiXFx4MWJbRlwiLCBcIlxceDFiT0ZcIiwgXCJcXHgxYls0flwiLCBcIlxceDFiWzh+XCJdLCAgIHNoaWZ0OiBbXCJcXHgxYls4JFwiXSwgY3RybDogW1wiXFx4MWJbOF5cIl0gfSxcblx0aW5zZXJ0OiAgIHsgcGxhaW46IFtcIlxceDFiWzJ+XCJdLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hpZnQ6IFtcIlxceDFiWzIkXCJdLCBjdHJsOiBbXCJcXHgxYlsyXlwiXSB9LFxuXHRkZWxldGU6ICAgeyBwbGFpbjogW1wiXFx4MWJbM35cIl0sICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaGlmdDogW1wiXFx4MWJbMyRcIl0sIGN0cmw6IFtcIlxceDFiWzNeXCJdIH0sXG5cdHBhZ2VVcDogICB7IHBsYWluOiBbXCJcXHgxYls1flwiLCBcIlxceDFiW1s1flwiXSwgICAgICAgICAgICAgICAgICAgICAgICBzaGlmdDogW1wiXFx4MWJbNSRcIl0sIGN0cmw6IFtcIlxceDFiWzVeXCJdIH0sXG5cdHBhZ2VEb3duOiB7IHBsYWluOiBbXCJcXHgxYls2flwiLCBcIlxceDFiW1s2flwiXSwgICAgICAgICAgICAgICAgICAgICAgICBzaGlmdDogW1wiXFx4MWJbNiRcIl0sIGN0cmw6IFtcIlxceDFiWzZeXCJdIH0sXG5cdGNsZWFyOiAgICB7IHBsYWluOiBbXCJcXHgxYltFXCIsIFwiXFx4MWJPRVwiXSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hpZnQ6IFtcIlxceDFiW2VcIl0sICBjdHJsOiBbXCJcXHgxYk9lXCJdICB9LFxuXHRmMTogICAgICAgeyBwbGFpbjogW1wiXFx4MWJPUFwiLCBcIlxceDFiWzExflwiLCBcIlxceDFiW1tBXCJdIH0sXG5cdGYyOiAgICAgICB7IHBsYWluOiBbXCJcXHgxYk9RXCIsIFwiXFx4MWJbMTJ+XCIsIFwiXFx4MWJbW0JcIl0gfSxcblx0ZjM6ICAgICAgIHsgcGxhaW46IFtcIlxceDFiT1JcIiwgXCJcXHgxYlsxM35cIiwgXCJcXHgxYltbQ1wiXSB9LFxuXHRmNDogICAgICAgeyBwbGFpbjogW1wiXFx4MWJPU1wiLCBcIlxceDFiWzE0flwiLCBcIlxceDFiW1tEXCJdIH0sXG5cdGY1OiAgICAgICB7IHBsYWluOiBbXCJcXHgxYlsxNX5cIiwgXCJcXHgxYltbRVwiXSB9LFxuXHRmNjogICAgICAgeyBwbGFpbjogW1wiXFx4MWJbMTd+XCJdIH0sXG5cdGY3OiAgICAgICB7IHBsYWluOiBbXCJcXHgxYlsxOH5cIl0gfSxcblx0Zjg6ICAgICAgIHsgcGxhaW46IFtcIlxceDFiWzE5flwiXSB9LFxuXHRmOTogICAgICAgeyBwbGFpbjogW1wiXFx4MWJbMjB+XCJdIH0sXG5cdGYxMDogICAgICB7IHBsYWluOiBbXCJcXHgxYlsyMX5cIl0gfSxcblx0ZjExOiAgICAgIHsgcGxhaW46IFtcIlxceDFiWzIzflwiXSB9LFxuXHRmMTI6ICAgICAgeyBwbGFpbjogW1wiXFx4MWJbMjR+XCJdIH0sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIFJldmVyc2UgbG9va3VwIGZyb20gZXNjYXBlIHNlcXVlbmNlIHRvIGtleSBpZGVudGlmaWVyLCBhdXRvLWdlbmVyYXRlZCBmcm9tIExFR0FDWV9TRVFVRU5DRVMuXG4gKiBBZGRpdGlvbmFsIG5vbi1zdGFuZGFyZCBzZXF1ZW5jZXMgKGFsdCthcnJvdyBhbGlhc2VzKSBhcmUgYXBwZW5kZWQgYWZ0ZXIgZ2VuZXJhdGlvbi5cbiAqL1xuY29uc3QgTEVHQUNZX1NFUVVFTkNFX0tFWV9JRFM6IFJlY29yZDxzdHJpbmcsIEtleUlkPiA9ICgoKSA9PiB7XG5cdGNvbnN0IG1hcDogUmVjb3JkPHN0cmluZywgS2V5SWQ+ID0ge307XG5cdGZvciAoY29uc3QgW2tleSwgZW50cnldIG9mIE9iamVjdC5lbnRyaWVzKExFR0FDWV9TRVFVRU5DRVMpKSB7XG5cdFx0Y29uc3Qga2V5SWQgPSBrZXkgYXMgS2V5SWQ7XG5cdFx0aWYgKGVudHJ5LnBsYWluKSB7XG5cdFx0XHRmb3IgKGNvbnN0IHNlcSBvZiBlbnRyeS5wbGFpbikgbWFwW3NlcV0gPSBrZXlJZDtcblx0XHR9XG5cdFx0aWYgKGVudHJ5LnNoaWZ0KSB7XG5cdFx0XHRmb3IgKGNvbnN0IHNlcSBvZiBlbnRyeS5zaGlmdCkgbWFwW3NlcV0gPSBgc2hpZnQrJHtrZXlJZH1gIGFzIEtleUlkO1xuXHRcdH1cblx0XHRpZiAoZW50cnkuY3RybCkge1xuXHRcdFx0Zm9yIChjb25zdCBzZXEgb2YgZW50cnkuY3RybCkgbWFwW3NlcV0gPSBgY3RybCske2tleUlkfWAgYXMgS2V5SWQ7XG5cdFx0fVxuXHR9XG5cdC8vIE5vbi1zdGFuZGFyZCBhbHQrYXJyb3cgYWxpYXNlcyBub3QgZGVyaXZhYmxlIGZyb20gdGhlIHRhYmxlXG5cdG1hcFtcIlxceDFiYlwiXSA9IFwiYWx0K2xlZnRcIjtcblx0bWFwW1wiXFx4MWJmXCJdID0gXCJhbHQrcmlnaHRcIjtcblx0bWFwW1wiXFx4MWJwXCJdID0gXCJhbHQrdXBcIjtcblx0bWFwW1wiXFx4MWJuXCJdID0gXCJhbHQrZG93blwiO1xuXHRyZXR1cm4gbWFwO1xufSkoKTtcblxuY29uc3QgbWF0Y2hlc0xlZ2FjeVNlcXVlbmNlID0gKGRhdGE6IHN0cmluZywgc2VxdWVuY2VzOiByZWFkb25seSBzdHJpbmdbXSk6IGJvb2xlYW4gPT4gc2VxdWVuY2VzLmluY2x1ZGVzKGRhdGEpO1xuXG5jb25zdCBtYXRjaGVzTGVnYWN5TW9kaWZpZXJTZXF1ZW5jZSA9IChkYXRhOiBzdHJpbmcsIGtleTogc3RyaW5nLCBtb2RpZmllcjogbnVtYmVyKTogYm9vbGVhbiA9PiB7XG5cdGNvbnN0IGVudHJ5ID0gTEVHQUNZX1NFUVVFTkNFU1trZXldO1xuXHRpZiAoIWVudHJ5KSByZXR1cm4gZmFsc2U7XG5cdGlmIChtb2RpZmllciA9PT0gTU9ESUZJRVJTLnNoaWZ0ICYmIGVudHJ5LnNoaWZ0KSB7XG5cdFx0cmV0dXJuIG1hdGNoZXNMZWdhY3lTZXF1ZW5jZShkYXRhLCBlbnRyeS5zaGlmdCk7XG5cdH1cblx0aWYgKG1vZGlmaWVyID09PSBNT0RJRklFUlMuY3RybCAmJiBlbnRyeS5jdHJsKSB7XG5cdFx0cmV0dXJuIG1hdGNoZXNMZWdhY3lTZXF1ZW5jZShkYXRhLCBlbnRyeS5jdHJsKTtcblx0fVxuXHRyZXR1cm4gZmFsc2U7XG59O1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gS2l0dHkgUHJvdG9jb2wgUGFyc2luZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBFdmVudCB0eXBlcyBmcm9tIEtpdHR5IGtleWJvYXJkIHByb3RvY29sIChmbGFnIDIpXG4gKiAxID0ga2V5IHByZXNzLCAyID0ga2V5IHJlcGVhdCwgMyA9IGtleSByZWxlYXNlXG4gKi9cbmV4cG9ydCB0eXBlIEtleUV2ZW50VHlwZSA9IFwicHJlc3NcIiB8IFwicmVwZWF0XCIgfCBcInJlbGVhc2VcIjtcblxuaW50ZXJmYWNlIFBhcnNlZEtpdHR5U2VxdWVuY2Uge1xuXHRjb2RlcG9pbnQ6IG51bWJlcjtcblx0c2hpZnRlZEtleT86IG51bWJlcjsgLy8gU2hpZnRlZCB2ZXJzaW9uIG9mIHRoZSBrZXkgKHdoZW4gc2hpZnQgaXMgcHJlc3NlZClcblx0YmFzZUxheW91dEtleT86IG51bWJlcjsgLy8gS2V5IGluIHN0YW5kYXJkIFBDLTEwMSBsYXlvdXQgKGZvciBub24tTGF0aW4gbGF5b3V0cylcblx0bW9kaWZpZXI6IG51bWJlcjtcblx0ZXZlbnRUeXBlOiBLZXlFdmVudFR5cGU7XG59XG5cbmludGVyZmFjZSBQYXJzZWRNb2RpZnlPdGhlcktleXNTZXF1ZW5jZSB7XG5cdGNvZGVwb2ludDogbnVtYmVyO1xuXHRtb2RpZmllcjogbnVtYmVyO1xufVxuXG4vLyBTdG9yZSB0aGUgbGFzdCBwYXJzZWQgZXZlbnQgdHlwZSBmb3IgaXNLZXlSZWxlYXNlKCkgdG8gcXVlcnlcbmxldCBfbGFzdEV2ZW50VHlwZTogS2V5RXZlbnRUeXBlID0gXCJwcmVzc1wiO1xuXG4vKipcbiAqIENoZWNrIGlmIGlucHV0IGRhdGEgY29udGFpbnMgYSBLaXR0eSBldmVudCB0eXBlIG1hcmtlci5cbiAqIEV2ZW50IHR5cGUgbWFya2VycyBhcHBlYXIgYXMgXCI6PGV2ZW50VHlwZT5cIiBmb2xsb3dlZCBieSBhIHNlcXVlbmNlIHRlcm1pbmF0b3IgKHUsIH4sIEEtRCwgSCwgRikuXG4gKiBJZ25vcmVzIGJyYWNrZXRlZCBwYXN0ZSBjb250ZW50IHdoaWNoIG1heSBjb250YWluIHNpbWlsYXIgcGF0dGVybnMuXG4gKi9cbmZ1bmN0aW9uIGhhc0tpdHR5RXZlbnRUeXBlKGRhdGE6IHN0cmluZywgZXZlbnRUeXBlOiBudW1iZXIpOiBib29sZWFuIHtcblx0aWYgKGRhdGEuaW5jbHVkZXMoXCJcXHgxYlsyMDB+XCIpKSB7XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cdGNvbnN0IG1hcmtlciA9IGA6JHtldmVudFR5cGV9YDtcblx0cmV0dXJuIChcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn11YCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1+YCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1BYCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1CYCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1DYCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1EYCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1IYCkgfHxcblx0XHRkYXRhLmluY2x1ZGVzKGAke21hcmtlcn1GYClcblx0KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzS2V5UmVsZWFzZShkYXRhOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIGhhc0tpdHR5RXZlbnRUeXBlKGRhdGEsIDMpO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSBsYXN0IHBhcnNlZCBrZXkgZXZlbnQgd2FzIGEga2V5IHJlcGVhdC5cbiAqIE9ubHkgbWVhbmluZ2Z1bCB3aGVuIEtpdHR5IGtleWJvYXJkIHByb3RvY29sIHdpdGggZmxhZyAyIGlzIGFjdGl2ZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzS2V5UmVwZWF0KGRhdGE6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gaGFzS2l0dHlFdmVudFR5cGUoZGF0YSwgMik7XG59XG5cbmZ1bmN0aW9uIHBhcnNlRXZlbnRUeXBlKGV2ZW50VHlwZVN0cjogc3RyaW5nIHwgdW5kZWZpbmVkKTogS2V5RXZlbnRUeXBlIHtcblx0aWYgKCFldmVudFR5cGVTdHIpIHJldHVybiBcInByZXNzXCI7XG5cdGNvbnN0IGV2ZW50VHlwZSA9IHBhcnNlSW50KGV2ZW50VHlwZVN0ciwgMTApO1xuXHRpZiAoZXZlbnRUeXBlID09PSAyKSByZXR1cm4gXCJyZXBlYXRcIjtcblx0aWYgKGV2ZW50VHlwZSA9PT0gMykgcmV0dXJuIFwicmVsZWFzZVwiO1xuXHRyZXR1cm4gXCJwcmVzc1wiO1xufVxuXG5mdW5jdGlvbiBwYXJzZUtpdHR5U2VxdWVuY2UoZGF0YTogc3RyaW5nKTogUGFyc2VkS2l0dHlTZXF1ZW5jZSB8IG51bGwge1xuXHQvLyBDU0kgdSBmb3JtYXQgd2l0aCBhbHRlcm5hdGUga2V5cyAoZmxhZyA0KTpcblx0Ly8gXFx4MWJbPGNvZGVwb2ludD51XG5cdC8vIFxceDFiWzxjb2RlcG9pbnQ+Ozxtb2Q+dVxuXHQvLyBcXHgxYls8Y29kZXBvaW50Pjs8bW9kPjo8ZXZlbnQ+dVxuXHQvLyBcXHgxYls8Y29kZXBvaW50Pjo8c2hpZnRlZD47PG1vZD51XG5cdC8vIFxceDFiWzxjb2RlcG9pbnQ+OjxzaGlmdGVkPjo8YmFzZT47PG1vZD51XG5cdC8vIFxceDFiWzxjb2RlcG9pbnQ+Ojo8YmFzZT47PG1vZD51IChubyBzaGlmdGVkIGtleSwgb25seSBiYXNlKVxuXHQvL1xuXHQvLyBXaXRoIGZsYWcgMiwgZXZlbnQgdHlwZSBpcyBhcHBlbmRlZCBhZnRlciBtb2RpZmllciBjb2xvbjogMT1wcmVzcywgMj1yZXBlYXQsIDM9cmVsZWFzZVxuXHQvLyBXaXRoIGZsYWcgNCwgYWx0ZXJuYXRlIGtleXMgYXJlIGFwcGVuZGVkIGFmdGVyIGNvZGVwb2ludCB3aXRoIGNvbG9uc1xuXHRjb25zdCBjc2lVTWF0Y2ggPSBkYXRhLm1hdGNoKC9eXFx4MWJcXFsoXFxkKykoPzo6KFxcZCopKT8oPzo6KFxcZCspKT8oPzo7KFxcZCspKT8oPzo6KFxcZCspKT91JC8pO1xuXHRpZiAoY3NpVU1hdGNoKSB7XG5cdFx0Y29uc3QgY29kZXBvaW50ID0gcGFyc2VJbnQoY3NpVU1hdGNoWzFdISwgMTApO1xuXHRcdGNvbnN0IHNoaWZ0ZWRLZXkgPSBjc2lVTWF0Y2hbMl0gJiYgY3NpVU1hdGNoWzJdLmxlbmd0aCA+IDAgPyBwYXJzZUludChjc2lVTWF0Y2hbMl0sIDEwKSA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBiYXNlTGF5b3V0S2V5ID0gY3NpVU1hdGNoWzNdID8gcGFyc2VJbnQoY3NpVU1hdGNoWzNdLCAxMCkgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgbW9kVmFsdWUgPSBjc2lVTWF0Y2hbNF0gPyBwYXJzZUludChjc2lVTWF0Y2hbNF0sIDEwKSA6IDE7XG5cdFx0Y29uc3QgZXZlbnRUeXBlID0gcGFyc2VFdmVudFR5cGUoY3NpVU1hdGNoWzVdKTtcblx0XHRfbGFzdEV2ZW50VHlwZSA9IGV2ZW50VHlwZTtcblx0XHRyZXR1cm4geyBjb2RlcG9pbnQsIHNoaWZ0ZWRLZXksIGJhc2VMYXlvdXRLZXksIG1vZGlmaWVyOiBtb2RWYWx1ZSAtIDEsIGV2ZW50VHlwZSB9O1xuXHR9XG5cblx0Ly8gQXJyb3cga2V5cyB3aXRoIG1vZGlmaWVyOiBcXHgxYlsxOzxtb2Q+QS9CL0MvRCBvciBcXHgxYlsxOzxtb2Q+OjxldmVudD5BL0IvQy9EXG5cdGNvbnN0IGFycm93TWF0Y2ggPSBkYXRhLm1hdGNoKC9eXFx4MWJcXFsxOyhcXGQrKSg/OjooXFxkKykpPyhbQUJDRF0pJC8pO1xuXHRpZiAoYXJyb3dNYXRjaCkge1xuXHRcdGNvbnN0IG1vZFZhbHVlID0gcGFyc2VJbnQoYXJyb3dNYXRjaFsxXSEsIDEwKTtcblx0XHRjb25zdCBldmVudFR5cGUgPSBwYXJzZUV2ZW50VHlwZShhcnJvd01hdGNoWzJdKTtcblx0XHRjb25zdCBhcnJvd0NvZGVzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0geyBBOiAtMSwgQjogLTIsIEM6IC0zLCBEOiAtNCB9O1xuXHRcdF9sYXN0RXZlbnRUeXBlID0gZXZlbnRUeXBlO1xuXHRcdHJldHVybiB7IGNvZGVwb2ludDogYXJyb3dDb2Rlc1thcnJvd01hdGNoWzNdIV0hLCBtb2RpZmllcjogbW9kVmFsdWUgLSAxLCBldmVudFR5cGUgfTtcblx0fVxuXG5cdC8vIEZ1bmN0aW9uYWwga2V5czogXFx4MWJbPG51bT5+IG9yIFxceDFiWzxudW0+Ozxtb2Q+fiBvciBcXHgxYls8bnVtPjs8bW9kPjo8ZXZlbnQ+flxuXHRjb25zdCBmdW5jTWF0Y2ggPSBkYXRhLm1hdGNoKC9eXFx4MWJcXFsoXFxkKykoPzo7KFxcZCspKT8oPzo6KFxcZCspKT9+JC8pO1xuXHRpZiAoZnVuY01hdGNoKSB7XG5cdFx0Y29uc3Qga2V5TnVtID0gcGFyc2VJbnQoZnVuY01hdGNoWzFdISwgMTApO1xuXHRcdGNvbnN0IG1vZFZhbHVlID0gZnVuY01hdGNoWzJdID8gcGFyc2VJbnQoZnVuY01hdGNoWzJdLCAxMCkgOiAxO1xuXHRcdGNvbnN0IGV2ZW50VHlwZSA9IHBhcnNlRXZlbnRUeXBlKGZ1bmNNYXRjaFszXSk7XG5cdFx0Y29uc3QgZnVuY0NvZGVzOiBSZWNvcmQ8bnVtYmVyLCBudW1iZXI+ID0ge1xuXHRcdFx0MjogRlVOQ1RJT05BTF9DT0RFUE9JTlRTLmluc2VydCxcblx0XHRcdDM6IEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5kZWxldGUsXG5cdFx0XHQ1OiBGVU5DVElPTkFMX0NPREVQT0lOVFMucGFnZVVwLFxuXHRcdFx0NjogRlVOQ1RJT05BTF9DT0RFUE9JTlRTLnBhZ2VEb3duLFxuXHRcdFx0NzogRlVOQ1RJT05BTF9DT0RFUE9JTlRTLmhvbWUsXG5cdFx0XHQ4OiBGVU5DVElPTkFMX0NPREVQT0lOVFMuZW5kLFxuXHRcdH07XG5cdFx0Y29uc3QgY29kZXBvaW50ID0gZnVuY0NvZGVzW2tleU51bV07XG5cdFx0aWYgKGNvZGVwb2ludCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRfbGFzdEV2ZW50VHlwZSA9IGV2ZW50VHlwZTtcblx0XHRcdHJldHVybiB7IGNvZGVwb2ludCwgbW9kaWZpZXI6IG1vZFZhbHVlIC0gMSwgZXZlbnRUeXBlIH07XG5cdFx0fVxuXHR9XG5cblx0Ly8gSG9tZS9FbmQgd2l0aCBtb2RpZmllcjogXFx4MWJbMTs8bW9kPkgvRiBvciBcXHgxYlsxOzxtb2Q+OjxldmVudD5IL0Zcblx0Y29uc3QgaG9tZUVuZE1hdGNoID0gZGF0YS5tYXRjaCgvXlxceDFiXFxbMTsoXFxkKykoPzo6KFxcZCspKT8oW0hGXSkkLyk7XG5cdGlmIChob21lRW5kTWF0Y2gpIHtcblx0XHRjb25zdCBtb2RWYWx1ZSA9IHBhcnNlSW50KGhvbWVFbmRNYXRjaFsxXSEsIDEwKTtcblx0XHRjb25zdCBldmVudFR5cGUgPSBwYXJzZUV2ZW50VHlwZShob21lRW5kTWF0Y2hbMl0pO1xuXHRcdGNvbnN0IGNvZGVwb2ludCA9IGhvbWVFbmRNYXRjaFszXSA9PT0gXCJIXCIgPyBGVU5DVElPTkFMX0NPREVQT0lOVFMuaG9tZSA6IEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5lbmQ7XG5cdFx0X2xhc3RFdmVudFR5cGUgPSBldmVudFR5cGU7XG5cdFx0cmV0dXJuIHsgY29kZXBvaW50LCBtb2RpZmllcjogbW9kVmFsdWUgLSAxLCBldmVudFR5cGUgfTtcblx0fVxuXG5cdHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhOiBzdHJpbmcsIGV4cGVjdGVkQ29kZXBvaW50OiBudW1iZXIsIGV4cGVjdGVkTW9kaWZpZXI6IG51bWJlcik6IGJvb2xlYW4ge1xuXHRjb25zdCBwYXJzZWQgPSBwYXJzZUtpdHR5U2VxdWVuY2UoZGF0YSk7XG5cdGlmICghcGFyc2VkKSByZXR1cm4gZmFsc2U7XG5cdGNvbnN0IGFjdHVhbE1vZCA9IHBhcnNlZC5tb2RpZmllciAmIH5MT0NLX01BU0s7XG5cdGNvbnN0IGV4cGVjdGVkTW9kID0gZXhwZWN0ZWRNb2RpZmllciAmIH5MT0NLX01BU0s7XG5cblx0Ly8gQ2hlY2sgaWYgbW9kaWZpZXJzIG1hdGNoXG5cdGlmIChhY3R1YWxNb2QgIT09IGV4cGVjdGVkTW9kKSByZXR1cm4gZmFsc2U7XG5cblx0Ly8gUHJpbWFyeSBtYXRjaDogY29kZXBvaW50IG1hdGNoZXMgZGlyZWN0bHlcblx0aWYgKHBhcnNlZC5jb2RlcG9pbnQgPT09IGV4cGVjdGVkQ29kZXBvaW50KSByZXR1cm4gdHJ1ZTtcblxuXHQvLyBBbHRlcm5hdGUgbWF0Y2g6IHVzZSBiYXNlIGxheW91dCBrZXkgZm9yIG5vbi1MYXRpbiBrZXlib2FyZCBsYXlvdXRzLlxuXHQvLyBUaGlzIGFsbG93cyBDdHJsK1x1MDQyMSAoQ3lyaWxsaWMpIHRvIG1hdGNoIEN0cmwrYyAoTGF0aW4pIHdoZW4gdGVybWluYWwgcmVwb3J0c1xuXHQvLyB0aGUgYmFzZSBsYXlvdXQga2V5ICh0aGUga2V5IGluIHN0YW5kYXJkIFBDLTEwMSBsYXlvdXQpLlxuXHQvL1xuXHQvLyBPbmx5IGZhbGwgYmFjayB0byBiYXNlIGxheW91dCBrZXkgd2hlbiB0aGUgY29kZXBvaW50IGlzIE5PVCBhbHJlYWR5IGFcblx0Ly8gcmVjb2duaXplZCBMYXRpbiBsZXR0ZXIgKGEteikgb3Igc3ltYm9sIChlLmcuLCAvLCAtLCBbLCA7LCBldGMuKS5cblx0Ly8gV2hlbiB0aGUgY29kZXBvaW50IGlzIGEgcmVjb2duaXplZCBrZXksIGl0IGlzIGF1dGhvcml0YXRpdmUgcmVnYXJkbGVzc1xuXHQvLyBvZiBwaHlzaWNhbCBrZXkgcG9zaXRpb24uIFRoaXMgcHJldmVudHMgcmVtYXBwZWQgbGF5b3V0cyAoRHZvcmFrLCBDb2xlbWFrLFxuXHQvLyB4cmVtYXAsIGV0Yy4pIGZyb20gY2F1c2luZyBmYWxzZSBtYXRjaGVzOiBib3RoIGxldHRlcnMgYW5kIHN5bWJvbHMgbW92ZVxuXHQvLyB0byBkaWZmZXJlbnQgcGh5c2ljYWwgcG9zaXRpb25zLCBzbyBDdHJsK0sgY291bGQgZmFsc2VseSBtYXRjaCBDdHJsK1Zcblx0Ly8gKGxldHRlciByZW1hcHBpbmcpIGFuZCBDdHJsKy8gY291bGQgZmFsc2VseSBtYXRjaCBDdHJsK1sgKHN5bWJvbCByZW1hcHBpbmcpXG5cdC8vIGlmIHRoZSBiYXNlIGxheW91dCBrZXkgd2VyZSBhbHdheXMgY29uc2lkZXJlZC5cblx0aWYgKHBhcnNlZC5iYXNlTGF5b3V0S2V5ICE9PSB1bmRlZmluZWQgJiYgcGFyc2VkLmJhc2VMYXlvdXRLZXkgPT09IGV4cGVjdGVkQ29kZXBvaW50KSB7XG5cdFx0Y29uc3QgY3AgPSBwYXJzZWQuY29kZXBvaW50O1xuXHRcdGNvbnN0IGlzTGF0aW5MZXR0ZXIgPSBjcCA+PSA5NyAmJiBjcCA8PSAxMjI7IC8vIGEtelxuXHRcdGNvbnN0IGlzS25vd25TeW1ib2wgPSBTWU1CT0xfS0VZUy5oYXMoU3RyaW5nLmZyb21DaGFyQ29kZShjcCkpO1xuXHRcdGlmICghaXNMYXRpbkxldHRlciAmJiAhaXNLbm93blN5bWJvbCkgcmV0dXJuIHRydWU7XG5cdH1cblxuXHRyZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIHBhcnNlTW9kaWZ5T3RoZXJLZXlzU2VxdWVuY2UoZGF0YTogc3RyaW5nKTogUGFyc2VkTW9kaWZ5T3RoZXJLZXlzU2VxdWVuY2UgfCBudWxsIHtcblx0Y29uc3QgbWF0Y2ggPSBkYXRhLm1hdGNoKC9eXFx4MWJcXFsyNzsoXFxkKyk7KFxcZCspfiQvKTtcblx0aWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG5cdGNvbnN0IG1vZFZhbHVlID0gcGFyc2VJbnQobWF0Y2hbMV0hLCAxMCk7XG5cdGNvbnN0IGNvZGVwb2ludCA9IHBhcnNlSW50KG1hdGNoWzJdISwgMTApO1xuXHRyZXR1cm4geyBjb2RlcG9pbnQsIG1vZGlmaWVyOiBtb2RWYWx1ZSAtIDEgfTtcbn1cblxuLyoqXG4gKiBNYXRjaCB4dGVybSBtb2RpZnlPdGhlcktleXMgZm9ybWF0OiBDU0kgMjcgOyBtb2RpZmllcnMgOyBrZXljb2RlIH5cbiAqIFRoaXMgaXMgdXNlZCBieSB0ZXJtaW5hbHMgd2hlbiBLaXR0eSBwcm90b2NvbCBpcyBub3QgZW5hYmxlZC5cbiAqIE1vZGlmaWVyIHZhbHVlcyBhcmUgMS1pbmRleGVkOiAyPXNoaWZ0LCAzPWFsdCwgNT1jdHJsLCBldGMuXG4gKi9cbmZ1bmN0aW9uIG1hdGNoZXNNb2RpZnlPdGhlcktleXMoZGF0YTogc3RyaW5nLCBleHBlY3RlZEtleWNvZGU6IG51bWJlciwgZXhwZWN0ZWRNb2RpZmllcjogbnVtYmVyKTogYm9vbGVhbiB7XG5cdGNvbnN0IHBhcnNlZCA9IHBhcnNlTW9kaWZ5T3RoZXJLZXlzU2VxdWVuY2UoZGF0YSk7XG5cdGlmICghcGFyc2VkKSByZXR1cm4gZmFsc2U7XG5cdHJldHVybiBwYXJzZWQuY29kZXBvaW50ID09PSBleHBlY3RlZEtleWNvZGUgJiYgcGFyc2VkLm1vZGlmaWVyID09PSBleHBlY3RlZE1vZGlmaWVyO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR2VuZXJpYyBLZXkgTWF0Y2hpbmdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogR2V0IHRoZSBjb250cm9sIGNoYXJhY3RlciBmb3IgYSBrZXkuXG4gKiBVc2VzIHRoZSB1bml2ZXJzYWwgZm9ybXVsYTogY29kZSAmIDB4MWYgKG1hc2sgdG8gbG93ZXIgNSBiaXRzKVxuICpcbiAqIFdvcmtzIGZvcjpcbiAqIC0gTGV0dGVycyBhLXogXHUyMTkyIDEtMjZcbiAqIC0gU3ltYm9scyBbXFxdXyBcdTIxOTIgMjcsIDI4LCAyOSwgMzFcbiAqIC0gQWxzbyBtYXBzIC0gdG8gc2FtZSBhcyBfIChzYW1lIHBoeXNpY2FsIGtleSBvbiBVUyBrZXlib2FyZHMpXG4gKi9cbmZ1bmN0aW9uIHJhd0N0cmxDaGFyKGtleTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IGNoYXIgPSBrZXkudG9Mb3dlckNhc2UoKTtcblx0Y29uc3QgY29kZSA9IGNoYXIuY2hhckNvZGVBdCgwKTtcblx0aWYgKChjb2RlID49IDk3ICYmIGNvZGUgPD0gMTIyKSB8fCBjaGFyID09PSBcIltcIiB8fCBjaGFyID09PSBcIlxcXFxcIiB8fCBjaGFyID09PSBcIl1cIiB8fCBjaGFyID09PSBcIl9cIikge1xuXHRcdHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUgJiAweDFmKTtcblx0fVxuXHQvLyBIYW5kbGUgLSBhcyBfIChzYW1lIHBoeXNpY2FsIGtleSBvbiBVUyBrZXlib2FyZHMpXG5cdGlmIChjaGFyID09PSBcIi1cIikge1xuXHRcdHJldHVybiBTdHJpbmcuZnJvbUNoYXJDb2RlKDMxKTsgLy8gU2FtZSBhcyBDdHJsK19cblx0fVxuXHRyZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gaXNEaWdpdEtleShrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4ga2V5ID49IFwiMFwiICYmIGtleSA8PSBcIjlcIjtcbn1cblxuZnVuY3Rpb24gbWF0Y2hlc1ByaW50YWJsZU1vZGlmeU90aGVyS2V5cyhkYXRhOiBzdHJpbmcsIGV4cGVjdGVkS2V5Y29kZTogbnVtYmVyLCBleHBlY3RlZE1vZGlmaWVyOiBudW1iZXIpOiBib29sZWFuIHtcblx0aWYgKGV4cGVjdGVkTW9kaWZpZXIgPT09IDApIHJldHVybiBmYWxzZTtcblx0cmV0dXJuIG1hdGNoZXNNb2RpZnlPdGhlcktleXMoZGF0YSwgZXhwZWN0ZWRLZXljb2RlLCBleHBlY3RlZE1vZGlmaWVyKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0S2V5TmFtZVdpdGhNb2RpZmllcnMoa2V5TmFtZTogc3RyaW5nLCBtb2RpZmllcjogbnVtYmVyKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0Y29uc3QgbW9kczogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgZWZmZWN0aXZlTW9kID0gbW9kaWZpZXIgJiB+TE9DS19NQVNLO1xuXHRjb25zdCBzdXBwb3J0ZWRNb2RpZmllck1hc2sgPSBNT0RJRklFUlMuc2hpZnQgfCBNT0RJRklFUlMuY3RybCB8IE1PRElGSUVSUy5hbHQ7XG5cdGlmICgoZWZmZWN0aXZlTW9kICYgfnN1cHBvcnRlZE1vZGlmaWVyTWFzaykgIT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cdGlmIChlZmZlY3RpdmVNb2QgJiBNT0RJRklFUlMuc2hpZnQpIG1vZHMucHVzaChcInNoaWZ0XCIpO1xuXHRpZiAoZWZmZWN0aXZlTW9kICYgTU9ESUZJRVJTLmN0cmwpIG1vZHMucHVzaChcImN0cmxcIik7XG5cdGlmIChlZmZlY3RpdmVNb2QgJiBNT0RJRklFUlMuYWx0KSBtb2RzLnB1c2goXCJhbHRcIik7XG5cdHJldHVybiBtb2RzLmxlbmd0aCA+IDAgPyBgJHttb2RzLmpvaW4oXCIrXCIpfSske2tleU5hbWV9YCA6IGtleU5hbWU7XG59XG5cbmZ1bmN0aW9uIHBhcnNlS2V5SWQoa2V5SWQ6IHN0cmluZyk6IHsga2V5OiBzdHJpbmc7IGN0cmw6IGJvb2xlYW47IHNoaWZ0OiBib29sZWFuOyBhbHQ6IGJvb2xlYW4gfSB8IG51bGwge1xuXHRjb25zdCBwYXJ0cyA9IGtleUlkLnRvTG93ZXJDYXNlKCkuc3BsaXQoXCIrXCIpO1xuXHRjb25zdCBrZXkgPSBwYXJ0c1twYXJ0cy5sZW5ndGggLSAxXTtcblx0aWYgKCFrZXkpIHJldHVybiBudWxsO1xuXHRyZXR1cm4ge1xuXHRcdGtleSxcblx0XHRjdHJsOiBwYXJ0cy5pbmNsdWRlcyhcImN0cmxcIiksXG5cdFx0c2hpZnQ6IHBhcnRzLmluY2x1ZGVzKFwic2hpZnRcIiksXG5cdFx0YWx0OiBwYXJ0cy5pbmNsdWRlcyhcImFsdFwiKSxcblx0fTtcbn1cblxuLyoqXG4gKiBNYXRjaCBpbnB1dCBkYXRhIGFnYWluc3QgYSBrZXkgaWRlbnRpZmllciBzdHJpbmcuXG4gKlxuICogU3VwcG9ydGVkIGtleSBpZGVudGlmaWVyczpcbiAqIC0gU2luZ2xlIGtleXM6IFwiZXNjYXBlXCIsIFwidGFiXCIsIFwiZW50ZXJcIiwgXCJiYWNrc3BhY2VcIiwgXCJkZWxldGVcIiwgXCJob21lXCIsIFwiZW5kXCIsIFwic3BhY2VcIlxuICogLSBBcnJvdyBrZXlzOiBcInVwXCIsIFwiZG93blwiLCBcImxlZnRcIiwgXCJyaWdodFwiXG4gKiAtIEN0cmwgY29tYmluYXRpb25zOiBcImN0cmwrY1wiLCBcImN0cmwrelwiLCBldGMuXG4gKiAtIFNoaWZ0IGNvbWJpbmF0aW9uczogXCJzaGlmdCt0YWJcIiwgXCJzaGlmdCtlbnRlclwiXG4gKiAtIEFsdCBjb21iaW5hdGlvbnM6IFwiYWx0K2VudGVyXCIsIFwiYWx0K2JhY2tzcGFjZVwiXG4gKiAtIENvbWJpbmVkIG1vZGlmaWVyczogXCJzaGlmdCtjdHJsK3BcIiwgXCJjdHJsK2FsdCt4XCJcbiAqXG4gKiBVc2UgdGhlIEtleSBoZWxwZXIgZm9yIGF1dG9jb21wbGV0ZTogS2V5LmN0cmwoXCJjXCIpLCBLZXkuZXNjYXBlLCBLZXkuY3RybFNoaWZ0KFwicFwiKVxuICpcbiAqIEBwYXJhbSBkYXRhIC0gUmF3IGlucHV0IGRhdGEgZnJvbSB0ZXJtaW5hbFxuICogQHBhcmFtIGtleUlkIC0gS2V5IGlkZW50aWZpZXIgKGUuZy4sIFwiY3RybCtjXCIsIFwiZXNjYXBlXCIsIEtleS5jdHJsKFwiY1wiKSlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hdGNoZXNLZXkoZGF0YTogc3RyaW5nLCBrZXlJZDogS2V5SWQpOiBib29sZWFuIHtcblx0Y29uc3QgcGFyc2VkID0gcGFyc2VLZXlJZChrZXlJZCk7XG5cdGlmICghcGFyc2VkKSByZXR1cm4gZmFsc2U7XG5cblx0Y29uc3QgeyBrZXksIGN0cmwsIHNoaWZ0LCBhbHQgfSA9IHBhcnNlZDtcblx0bGV0IG1vZGlmaWVyID0gMDtcblx0aWYgKHNoaWZ0KSBtb2RpZmllciB8PSBNT0RJRklFUlMuc2hpZnQ7XG5cdGlmIChhbHQpIG1vZGlmaWVyIHw9IE1PRElGSUVSUy5hbHQ7XG5cdGlmIChjdHJsKSBtb2RpZmllciB8PSBNT0RJRklFUlMuY3RybDtcblxuXHRzd2l0Y2ggKGtleSkge1xuXHRcdGNhc2UgXCJlc2NhcGVcIjpcblx0XHRjYXNlIFwiZXNjXCI6XG5cdFx0XHRpZiAobW9kaWZpZXIgIT09IDApIHJldHVybiBmYWxzZTtcblx0XHRcdHJldHVybiBkYXRhID09PSBcIlxceDFiXCIgfHwgbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy5lc2NhcGUsIDApO1xuXG5cdFx0Y2FzZSBcInNwYWNlXCI6XG5cdFx0XHRpZiAoIV9raXR0eVByb3RvY29sQWN0aXZlKSB7XG5cdFx0XHRcdGlmIChjdHJsICYmICFhbHQgJiYgIXNoaWZ0ICYmIGRhdGEgPT09IFwiXFx4MDBcIikge1xuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChhbHQgJiYgIWN0cmwgJiYgIXNoaWZ0ICYmIGRhdGEgPT09IFwiXFx4MWIgXCIpIHtcblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0aWYgKG1vZGlmaWVyID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiBkYXRhID09PSBcIiBcIiB8fCBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBDT0RFUE9JTlRTLnNwYWNlLCAwKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBDT0RFUE9JTlRTLnNwYWNlLCBtb2RpZmllcik7XG5cblx0XHRjYXNlIFwidGFiXCI6XG5cdFx0XHRpZiAoc2hpZnQgJiYgIWN0cmwgJiYgIWFsdCkge1xuXHRcdFx0XHRyZXR1cm4gZGF0YSA9PT0gXCJcXHgxYltaXCIgfHwgbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy50YWIsIE1PRElGSUVSUy5zaGlmdCk7XG5cdFx0XHR9XG5cdFx0XHRpZiAobW9kaWZpZXIgPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIGRhdGEgPT09IFwiXFx0XCIgfHwgbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy50YWIsIDApO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIENPREVQT0lOVFMudGFiLCBtb2RpZmllcik7XG5cblx0XHRjYXNlIFwiZW50ZXJcIjpcblx0XHRjYXNlIFwicmV0dXJuXCI6XG5cdFx0XHRpZiAoc2hpZnQgJiYgIWN0cmwgJiYgIWFsdCkge1xuXHRcdFx0XHQvLyBDU0kgdSBzZXF1ZW5jZXMgKHN0YW5kYXJkIEtpdHR5IHByb3RvY29sKVxuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy5lbnRlciwgTU9ESUZJRVJTLnNoaWZ0KSB8fFxuXHRcdFx0XHRcdG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIENPREVQT0lOVFMua3BFbnRlciwgTU9ESUZJRVJTLnNoaWZ0KVxuXHRcdFx0XHQpIHtcblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyB4dGVybSBtb2RpZnlPdGhlcktleXMgZm9ybWF0IChmYWxsYmFjayB3aGVuIEtpdHR5IHByb3RvY29sIG5vdCBlbmFibGVkKVxuXHRcdFx0XHRpZiAobWF0Y2hlc01vZGlmeU90aGVyS2V5cyhkYXRhLCBDT0RFUE9JTlRTLmVudGVyLCBNT0RJRklFUlMuc2hpZnQpKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gV2hlbiBLaXR0eSBwcm90b2NvbCBpcyBhY3RpdmUsIGxlZ2FjeSBzZXF1ZW5jZXMgYXJlIGN1c3RvbSB0ZXJtaW5hbCBtYXBwaW5nc1xuXHRcdFx0XHQvLyBcXHgxYlxcciA9IEtpdHR5J3MgXCJtYXAgc2hpZnQrZW50ZXIgc2VuZF90ZXh0IGFsbCBcXGVcXHJcIlxuXHRcdFx0XHQvLyBcXG4gPSBHaG9zdHR5J3MgXCJrZXliaW5kID0gc2hpZnQrZW50ZXI9dGV4dDpcXG5cIlxuXHRcdFx0XHRpZiAoX2tpdHR5UHJvdG9jb2xBY3RpdmUpIHtcblx0XHRcdFx0XHRyZXR1cm4gZGF0YSA9PT0gXCJcXHgxYlxcclwiIHx8IGRhdGEgPT09IFwiXFxuXCI7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGFsdCAmJiAhY3RybCAmJiAhc2hpZnQpIHtcblx0XHRcdFx0Ly8gQ1NJIHUgc2VxdWVuY2VzIChzdGFuZGFyZCBLaXR0eSBwcm90b2NvbClcblx0XHRcdFx0aWYgKFxuXHRcdFx0XHRcdG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIENPREVQT0lOVFMuZW50ZXIsIE1PRElGSUVSUy5hbHQpIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy5rcEVudGVyLCBNT0RJRklFUlMuYWx0KVxuXHRcdFx0XHQpIHtcblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyB4dGVybSBtb2RpZnlPdGhlcktleXMgZm9ybWF0IChmYWxsYmFjayB3aGVuIEtpdHR5IHByb3RvY29sIG5vdCBlbmFibGVkKVxuXHRcdFx0XHRpZiAobWF0Y2hlc01vZGlmeU90aGVyS2V5cyhkYXRhLCBDT0RFUE9JTlRTLmVudGVyLCBNT0RJRklFUlMuYWx0KSkge1xuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIFxceDFiXFxyIGlzIGFsdCtlbnRlciBvbmx5IGluIGxlZ2FjeSBtb2RlIChubyBLaXR0eSBwcm90b2NvbClcblx0XHRcdFx0Ly8gV2hlbiBLaXR0eSBwcm90b2NvbCBpcyBhY3RpdmUsIGFsdCtlbnRlciBjb21lcyBhcyBDU0kgdSBzZXF1ZW5jZVxuXHRcdFx0XHRpZiAoIV9raXR0eVByb3RvY29sQWN0aXZlKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGRhdGEgPT09IFwiXFx4MWJcXHJcIjtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0XHRpZiAobW9kaWZpZXIgPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRkYXRhID09PSBcIlxcclwiIHx8XG5cdFx0XHRcdFx0KCFfa2l0dHlQcm90b2NvbEFjdGl2ZSAmJiBkYXRhID09PSBcIlxcblwiKSB8fFxuXHRcdFx0XHRcdGRhdGEgPT09IFwiXFx4MWJPTVwiIHx8IC8vIFNTMyBNIChudW1wYWQgZW50ZXIgaW4gc29tZSB0ZXJtaW5hbHMpXG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy5lbnRlciwgMCkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBDT0RFUE9JTlRTLmtwRW50ZXIsIDApXG5cdFx0XHRcdCk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBDT0RFUE9JTlRTLmVudGVyLCBtb2RpZmllcikgfHxcblx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy5rcEVudGVyLCBtb2RpZmllcikgfHxcblx0XHRcdFx0bWF0Y2hlc01vZGlmeU90aGVyS2V5cyhkYXRhLCBDT0RFUE9JTlRTLmVudGVyLCBtb2RpZmllcilcblx0XHRcdCk7XG5cblx0XHRjYXNlIFwiYmFja3NwYWNlXCI6XG5cdFx0XHRpZiAoYWx0ICYmICFjdHJsICYmICFzaGlmdCkge1xuXHRcdFx0XHRpZiAoZGF0YSA9PT0gXCJcXHgxYlxceDdmXCIgfHwgZGF0YSA9PT0gXCJcXHgxYlxcYlwiKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIENPREVQT0lOVFMuYmFja3NwYWNlLCBNT0RJRklFUlMuYWx0KTtcblx0XHRcdH1cblx0XHRcdGlmIChtb2RpZmllciA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gZGF0YSA9PT0gXCJcXHg3ZlwiIHx8IGRhdGEgPT09IFwiXFx4MDhcIiB8fCBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBDT0RFUE9JTlRTLmJhY2tzcGFjZSwgMCk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQ09ERVBPSU5UUy5iYWNrc3BhY2UsIG1vZGlmaWVyKTtcblxuXHRcdGNhc2UgXCJpbnNlcnRcIjpcblx0XHRcdGlmIChtb2RpZmllciA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdG1hdGNoZXNMZWdhY3lTZXF1ZW5jZShkYXRhLCBMRUdBQ1lfU0VRVUVOQ0VTLmluc2VydC5wbGFpbiEpIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgRlVOQ1RJT05BTF9DT0RFUE9JTlRTLmluc2VydCwgMClcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdGlmIChtYXRjaGVzTGVnYWN5TW9kaWZpZXJTZXF1ZW5jZShkYXRhLCBcImluc2VydFwiLCBtb2RpZmllcikpIHtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgRlVOQ1RJT05BTF9DT0RFUE9JTlRTLmluc2VydCwgbW9kaWZpZXIpO1xuXG5cdFx0Y2FzZSBcImRlbGV0ZVwiOlxuXHRcdFx0aWYgKG1vZGlmaWVyID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiAoXG5cdFx0XHRcdFx0bWF0Y2hlc0xlZ2FjeVNlcXVlbmNlKGRhdGEsIExFR0FDWV9TRVFVRU5DRVMuZGVsZXRlLnBsYWluISkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBGVU5DVElPTkFMX0NPREVQT0lOVFMuZGVsZXRlLCAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwiZGVsZXRlXCIsIG1vZGlmaWVyKSkge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBGVU5DVElPTkFMX0NPREVQT0lOVFMuZGVsZXRlLCBtb2RpZmllcik7XG5cblx0XHRjYXNlIFwiY2xlYXJcIjpcblx0XHRcdGlmIChtb2RpZmllciA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gbWF0Y2hlc0xlZ2FjeVNlcXVlbmNlKGRhdGEsIExFR0FDWV9TRVFVRU5DRVMuY2xlYXIucGxhaW4hKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBtYXRjaGVzTGVnYWN5TW9kaWZpZXJTZXF1ZW5jZShkYXRhLCBcImNsZWFyXCIsIG1vZGlmaWVyKTtcblxuXHRcdGNhc2UgXCJob21lXCI6XG5cdFx0XHRpZiAobW9kaWZpZXIgPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRtYXRjaGVzTGVnYWN5U2VxdWVuY2UoZGF0YSwgTEVHQUNZX1NFUVVFTkNFUy5ob21lLnBsYWluISkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBGVU5DVElPTkFMX0NPREVQT0lOVFMuaG9tZSwgMClcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdGlmIChtYXRjaGVzTGVnYWN5TW9kaWZpZXJTZXF1ZW5jZShkYXRhLCBcImhvbWVcIiwgbW9kaWZpZXIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5ob21lLCBtb2RpZmllcik7XG5cblx0XHRjYXNlIFwiZW5kXCI6XG5cdFx0XHRpZiAobW9kaWZpZXIgPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRtYXRjaGVzTGVnYWN5U2VxdWVuY2UoZGF0YSwgTEVHQUNZX1NFUVVFTkNFUy5lbmQucGxhaW4hKSB8fFxuXHRcdFx0XHRcdG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5lbmQsIDApXG5cdFx0XHRcdCk7XG5cdFx0XHR9XG5cdFx0XHRpZiAobWF0Y2hlc0xlZ2FjeU1vZGlmaWVyU2VxdWVuY2UoZGF0YSwgXCJlbmRcIiwgbW9kaWZpZXIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5lbmQsIG1vZGlmaWVyKTtcblxuXHRcdGNhc2UgXCJwYWdldXBcIjpcblx0XHRcdGlmIChtb2RpZmllciA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdG1hdGNoZXNMZWdhY3lTZXF1ZW5jZShkYXRhLCBMRUdBQ1lfU0VRVUVOQ0VTLnBhZ2VVcC5wbGFpbiEpIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgRlVOQ1RJT05BTF9DT0RFUE9JTlRTLnBhZ2VVcCwgMClcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdGlmIChtYXRjaGVzTGVnYWN5TW9kaWZpZXJTZXF1ZW5jZShkYXRhLCBcInBhZ2VVcFwiLCBtb2RpZmllcikpIHtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgRlVOQ1RJT05BTF9DT0RFUE9JTlRTLnBhZ2VVcCwgbW9kaWZpZXIpO1xuXG5cdFx0Y2FzZSBcInBhZ2Vkb3duXCI6XG5cdFx0XHRpZiAobW9kaWZpZXIgPT09IDApIHtcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRtYXRjaGVzTGVnYWN5U2VxdWVuY2UoZGF0YSwgTEVHQUNZX1NFUVVFTkNFUy5wYWdlRG93bi5wbGFpbiEpIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgRlVOQ1RJT05BTF9DT0RFUE9JTlRTLnBhZ2VEb3duLCAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwicGFnZURvd25cIiwgbW9kaWZpZXIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5wYWdlRG93biwgbW9kaWZpZXIpO1xuXG5cdFx0Y2FzZSBcInVwXCI6XG5cdFx0XHRpZiAoYWx0ICYmICFjdHJsICYmICFzaGlmdCkge1xuXHRcdFx0XHRyZXR1cm4gZGF0YSA9PT0gXCJcXHgxYnBcIiB8fCBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBBUlJPV19DT0RFUE9JTlRTLnVwLCBNT0RJRklFUlMuYWx0KTtcblx0XHRcdH1cblx0XHRcdGlmIChtb2RpZmllciA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdG1hdGNoZXNMZWdhY3lTZXF1ZW5jZShkYXRhLCBMRUdBQ1lfU0VRVUVOQ0VTLnVwLnBsYWluISkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBBUlJPV19DT0RFUE9JTlRTLnVwLCAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwidXBcIiwgbW9kaWZpZXIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEFSUk9XX0NPREVQT0lOVFMudXAsIG1vZGlmaWVyKTtcblxuXHRcdGNhc2UgXCJkb3duXCI6XG5cdFx0XHRpZiAoYWx0ICYmICFjdHJsICYmICFzaGlmdCkge1xuXHRcdFx0XHRyZXR1cm4gZGF0YSA9PT0gXCJcXHgxYm5cIiB8fCBtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBBUlJPV19DT0RFUE9JTlRTLmRvd24sIE1PRElGSUVSUy5hbHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1vZGlmaWVyID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiAoXG5cdFx0XHRcdFx0bWF0Y2hlc0xlZ2FjeVNlcXVlbmNlKGRhdGEsIExFR0FDWV9TRVFVRU5DRVMuZG93bi5wbGFpbiEpIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQVJST1dfQ09ERVBPSU5UUy5kb3duLCAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwiZG93blwiLCBtb2RpZmllcikpIHtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQVJST1dfQ09ERVBPSU5UUy5kb3duLCBtb2RpZmllcik7XG5cblx0XHRjYXNlIFwibGVmdFwiOlxuXHRcdFx0aWYgKGFsdCAmJiAhY3RybCAmJiAhc2hpZnQpIHtcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRkYXRhID09PSBcIlxceDFiWzE7M0RcIiB8fFxuXHRcdFx0XHRcdCghX2tpdHR5UHJvdG9jb2xBY3RpdmUgJiYgZGF0YSA9PT0gXCJcXHgxYkJcIikgfHxcblx0XHRcdFx0XHRkYXRhID09PSBcIlxceDFiYlwiIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQVJST1dfQ09ERVBPSU5UUy5sZWZ0LCBNT0RJRklFUlMuYWx0KVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGN0cmwgJiYgIWFsdCAmJiAhc2hpZnQpIHtcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRkYXRhID09PSBcIlxceDFiWzE7NURcIiB8fFxuXHRcdFx0XHRcdG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwibGVmdFwiLCBNT0RJRklFUlMuY3RybCkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBBUlJPV19DT0RFUE9JTlRTLmxlZnQsIE1PRElGSUVSUy5jdHJsKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1vZGlmaWVyID09PSAwKSB7XG5cdFx0XHRcdHJldHVybiAoXG5cdFx0XHRcdFx0bWF0Y2hlc0xlZ2FjeVNlcXVlbmNlKGRhdGEsIExFR0FDWV9TRVFVRU5DRVMubGVmdC5wbGFpbiEpIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQVJST1dfQ09ERVBPSU5UUy5sZWZ0LCAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwibGVmdFwiLCBtb2RpZmllcikpIHtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgQVJST1dfQ09ERVBPSU5UUy5sZWZ0LCBtb2RpZmllcik7XG5cblx0XHRjYXNlIFwicmlnaHRcIjpcblx0XHRcdGlmIChhbHQgJiYgIWN0cmwgJiYgIXNoaWZ0KSB7XG5cdFx0XHRcdHJldHVybiAoXG5cdFx0XHRcdFx0ZGF0YSA9PT0gXCJcXHgxYlsxOzNDXCIgfHxcblx0XHRcdFx0XHQoIV9raXR0eVByb3RvY29sQWN0aXZlICYmIGRhdGEgPT09IFwiXFx4MWJGXCIpIHx8XG5cdFx0XHRcdFx0ZGF0YSA9PT0gXCJcXHgxYmZcIiB8fFxuXHRcdFx0XHRcdG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEFSUk9XX0NPREVQT0lOVFMucmlnaHQsIE1PRElGSUVSUy5hbHQpXG5cdFx0XHRcdCk7XG5cdFx0XHR9XG5cdFx0XHRpZiAoY3RybCAmJiAhYWx0ICYmICFzaGlmdCkge1xuXHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdGRhdGEgPT09IFwiXFx4MWJbMTs1Q1wiIHx8XG5cdFx0XHRcdFx0bWF0Y2hlc0xlZ2FjeU1vZGlmaWVyU2VxdWVuY2UoZGF0YSwgXCJyaWdodFwiLCBNT0RJRklFUlMuY3RybCkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBBUlJPV19DT0RFUE9JTlRTLnJpZ2h0LCBNT0RJRklFUlMuY3RybClcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdGlmIChtb2RpZmllciA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdG1hdGNoZXNMZWdhY3lTZXF1ZW5jZShkYXRhLCBMRUdBQ1lfU0VRVUVOQ0VTLnJpZ2h0LnBsYWluISkgfHxcblx0XHRcdFx0XHRtYXRjaGVzS2l0dHlTZXF1ZW5jZShkYXRhLCBBUlJPV19DT0RFUE9JTlRTLnJpZ2h0LCAwKVxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNMZWdhY3lNb2RpZmllclNlcXVlbmNlKGRhdGEsIFwicmlnaHRcIiwgbW9kaWZpZXIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIEFSUk9XX0NPREVQT0lOVFMucmlnaHQsIG1vZGlmaWVyKTtcblxuXHRcdGNhc2UgXCJmMVwiOlxuXHRcdGNhc2UgXCJmMlwiOlxuXHRcdGNhc2UgXCJmM1wiOlxuXHRcdGNhc2UgXCJmNFwiOlxuXHRcdGNhc2UgXCJmNVwiOlxuXHRcdGNhc2UgXCJmNlwiOlxuXHRcdGNhc2UgXCJmN1wiOlxuXHRcdGNhc2UgXCJmOFwiOlxuXHRcdGNhc2UgXCJmOVwiOlxuXHRcdGNhc2UgXCJmMTBcIjpcblx0XHRjYXNlIFwiZjExXCI6XG5cdFx0Y2FzZSBcImYxMlwiOiB7XG5cdFx0XHRpZiAobW9kaWZpZXIgIT09IDApIHtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZnVuY3Rpb25LZXkgPSBrZXkgYXMga2V5b2YgdHlwZW9mIExFR0FDWV9TRVFVRU5DRVM7XG5cdFx0XHRyZXR1cm4gbWF0Y2hlc0xlZ2FjeVNlcXVlbmNlKGRhdGEsIExFR0FDWV9TRVFVRU5DRVNbZnVuY3Rpb25LZXldIS5wbGFpbiEpO1xuXHRcdH1cblx0fVxuXG5cdC8vIEhhbmRsZSBzaW5nbGUgbGV0dGVyL2RpZ2l0IGtleXMgYW5kIHN5bWJvbHNcblx0aWYgKGtleS5sZW5ndGggPT09IDEgJiYgKChrZXkgPj0gXCJhXCIgJiYga2V5IDw9IFwielwiKSB8fCBpc0RpZ2l0S2V5KGtleSkgfHwgU1lNQk9MX0tFWVMuaGFzKGtleSkpKSB7XG5cdFx0Y29uc3QgY29kZXBvaW50ID0ga2V5LmNoYXJDb2RlQXQoMCk7XG5cdFx0Y29uc3QgcmF3Q3RybCA9IHJhd0N0cmxDaGFyKGtleSk7XG5cdFx0Y29uc3QgaXNMZXR0ZXIgPSBrZXkgPj0gXCJhXCIgJiYga2V5IDw9IFwielwiO1xuXHRcdGNvbnN0IGlzRGlnaXQgPSBpc0RpZ2l0S2V5KGtleSk7XG5cblx0XHRpZiAoY3RybCAmJiBhbHQgJiYgIXNoaWZ0ICYmICFfa2l0dHlQcm90b2NvbEFjdGl2ZSAmJiByYXdDdHJsKSB7XG5cdFx0XHQvLyBMZWdhY3k6IGN0cmwrYWx0K2tleSBpcyBFU0MgZm9sbG93ZWQgYnkgdGhlIGNvbnRyb2wgY2hhcmFjdGVyXG5cdFx0XHRyZXR1cm4gZGF0YSA9PT0gYFxceDFiJHtyYXdDdHJsfWA7XG5cdFx0fVxuXG5cdFx0aWYgKGFsdCAmJiAhY3RybCAmJiAhc2hpZnQgJiYgIV9raXR0eVByb3RvY29sQWN0aXZlICYmIChpc0xldHRlciB8fCBpc0RpZ2l0KSkge1xuXHRcdFx0Ly8gTGVnYWN5OiBhbHQrbGV0dGVyL2RpZ2l0IGlzIEVTQyBmb2xsb3dlZCBieSB0aGUga2V5XG5cdFx0XHRpZiAoZGF0YSA9PT0gYFxceDFiJHtrZXl9YCkgcmV0dXJuIHRydWU7XG5cdFx0fVxuXG5cdFx0aWYgKGN0cmwgJiYgIXNoaWZ0ICYmICFhbHQpIHtcblx0XHRcdC8vIExlZ2FjeTogY3RybCtrZXkgc2VuZHMgdGhlIGNvbnRyb2wgY2hhcmFjdGVyXG5cdFx0XHRpZiAocmF3Q3RybCAmJiBkYXRhID09PSByYXdDdHJsKSByZXR1cm4gdHJ1ZTtcblx0XHRcdHJldHVybiAoXG5cdFx0XHRcdG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIGNvZGVwb2ludCwgTU9ESUZJRVJTLmN0cmwpIHx8XG5cdFx0XHRcdG1hdGNoZXNQcmludGFibGVNb2RpZnlPdGhlcktleXMoZGF0YSwgY29kZXBvaW50LCBNT0RJRklFUlMuY3RybClcblx0XHRcdCk7XG5cdFx0fVxuXG5cdFx0aWYgKGN0cmwgJiYgc2hpZnQgJiYgIWFsdCkge1xuXHRcdFx0cmV0dXJuIChcblx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgY29kZXBvaW50LCBNT0RJRklFUlMuc2hpZnQgKyBNT0RJRklFUlMuY3RybCkgfHxcblx0XHRcdFx0bWF0Y2hlc1ByaW50YWJsZU1vZGlmeU90aGVyS2V5cyhkYXRhLCBjb2RlcG9pbnQsIE1PRElGSUVSUy5zaGlmdCArIE1PRElGSUVSUy5jdHJsKVxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHRpZiAoc2hpZnQgJiYgIWN0cmwgJiYgIWFsdCkge1xuXHRcdFx0Ly8gTGVnYWN5OiBzaGlmdCtsZXR0ZXIgcHJvZHVjZXMgdXBwZXJjYXNlXG5cdFx0XHRpZiAoaXNMZXR0ZXIgJiYgZGF0YSA9PT0ga2V5LnRvVXBwZXJDYXNlKCkpIHJldHVybiB0cnVlO1xuXHRcdFx0cmV0dXJuIChcblx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgY29kZXBvaW50LCBNT0RJRklFUlMuc2hpZnQpIHx8XG5cdFx0XHRcdG1hdGNoZXNQcmludGFibGVNb2RpZnlPdGhlcktleXMoZGF0YSwgY29kZXBvaW50LCBNT0RJRklFUlMuc2hpZnQpXG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdGlmIChtb2RpZmllciAhPT0gMCkge1xuXHRcdFx0cmV0dXJuIChcblx0XHRcdFx0bWF0Y2hlc0tpdHR5U2VxdWVuY2UoZGF0YSwgY29kZXBvaW50LCBtb2RpZmllcikgfHxcblx0XHRcdFx0bWF0Y2hlc1ByaW50YWJsZU1vZGlmeU90aGVyS2V5cyhkYXRhLCBjb2RlcG9pbnQsIG1vZGlmaWVyKVxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHQvLyBDaGVjayBib3RoIHJhdyBjaGFyIGFuZCBLaXR0eSBzZXF1ZW5jZSAobmVlZGVkIGZvciByZWxlYXNlIGV2ZW50cylcblx0XHRyZXR1cm4gZGF0YSA9PT0ga2V5IHx8IG1hdGNoZXNLaXR0eVNlcXVlbmNlKGRhdGEsIGNvZGVwb2ludCwgMCk7XG5cdH1cblxuXHRyZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogUGFyc2UgaW5wdXQgZGF0YSBhbmQgcmV0dXJuIHRoZSBrZXkgaWRlbnRpZmllciBpZiByZWNvZ25pemVkLlxuICpcbiAqIEBwYXJhbSBkYXRhIC0gUmF3IGlucHV0IGRhdGEgZnJvbSB0ZXJtaW5hbFxuICogQHJldHVybnMgS2V5IGlkZW50aWZpZXIgc3RyaW5nIChlLmcuLCBcImN0cmwrY1wiKSBvciB1bmRlZmluZWRcbiAqL1xuZnVuY3Rpb24gZm9ybWF0UGFyc2VkS2V5KGNvZGVwb2ludDogbnVtYmVyLCBtb2RpZmllcjogbnVtYmVyLCBiYXNlTGF5b3V0S2V5PzogbnVtYmVyKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0Ly8gVXNlIGJhc2UgbGF5b3V0IGtleSBvbmx5IHdoZW4gY29kZXBvaW50IGlzIG5vdCBhIHJlY29nbml6ZWQgTGF0aW5cblx0Ly8gbGV0dGVyIChhLXopLCBkaWdpdCAoMC05KSwgb3Igc3ltYm9sICgvLCAtLCBbLCA7LCBldGMuKS4gRm9yIHRob3NlLFxuXHQvLyB0aGUgY29kZXBvaW50IGlzIGF1dGhvcml0YXRpdmUgcmVnYXJkbGVzcyBvZiBwaHlzaWNhbCBrZXkgcG9zaXRpb24uXG5cdC8vIFRoaXMgcHJldmVudHMgcmVtYXBwZWQgbGF5b3V0cyAoRHZvcmFrLCBDb2xlbWFrLCB4cmVtYXAsIGV0Yy4pIGZyb21cblx0Ly8gcmVwb3J0aW5nIHRoZSB3cm9uZyBrZXkgbmFtZSBiYXNlZCBvbiB0aGUgUVdFUlRZIHBoeXNpY2FsIHBvc2l0aW9uLlxuXHRjb25zdCBpc0xhdGluTGV0dGVyID0gY29kZXBvaW50ID49IDk3ICYmIGNvZGVwb2ludCA8PSAxMjI7IC8vIGEtelxuXHRjb25zdCBpc0RpZ2l0ID0gY29kZXBvaW50ID49IDQ4ICYmIGNvZGVwb2ludCA8PSA1NzsgLy8gMC05XG5cdGNvbnN0IGlzS25vd25TeW1ib2wgPSBTWU1CT0xfS0VZUy5oYXMoU3RyaW5nLmZyb21DaGFyQ29kZShjb2RlcG9pbnQpKTtcblx0Y29uc3QgZWZmZWN0aXZlQ29kZXBvaW50ID0gaXNMYXRpbkxldHRlciB8fCBpc0RpZ2l0IHx8IGlzS25vd25TeW1ib2wgPyBjb2RlcG9pbnQgOiAoYmFzZUxheW91dEtleSA/PyBjb2RlcG9pbnQpO1xuXG5cdGxldCBrZXlOYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IENPREVQT0lOVFMuZXNjYXBlKSBrZXlOYW1lID0gXCJlc2NhcGVcIjtcblx0ZWxzZSBpZiAoZWZmZWN0aXZlQ29kZXBvaW50ID09PSBDT0RFUE9JTlRTLnRhYikga2V5TmFtZSA9IFwidGFiXCI7XG5cdGVsc2UgaWYgKGVmZmVjdGl2ZUNvZGVwb2ludCA9PT0gQ09ERVBPSU5UUy5lbnRlciB8fCBlZmZlY3RpdmVDb2RlcG9pbnQgPT09IENPREVQT0lOVFMua3BFbnRlcikga2V5TmFtZSA9IFwiZW50ZXJcIjtcblx0ZWxzZSBpZiAoZWZmZWN0aXZlQ29kZXBvaW50ID09PSBDT0RFUE9JTlRTLnNwYWNlKSBrZXlOYW1lID0gXCJzcGFjZVwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IENPREVQT0lOVFMuYmFja3NwYWNlKSBrZXlOYW1lID0gXCJiYWNrc3BhY2VcIjtcblx0ZWxzZSBpZiAoZWZmZWN0aXZlQ29kZXBvaW50ID09PSBGVU5DVElPTkFMX0NPREVQT0lOVFMuZGVsZXRlKSBrZXlOYW1lID0gXCJkZWxldGVcIjtcblx0ZWxzZSBpZiAoZWZmZWN0aXZlQ29kZXBvaW50ID09PSBGVU5DVElPTkFMX0NPREVQT0lOVFMuaW5zZXJ0KSBrZXlOYW1lID0gXCJpbnNlcnRcIjtcblx0ZWxzZSBpZiAoZWZmZWN0aXZlQ29kZXBvaW50ID09PSBGVU5DVElPTkFMX0NPREVQT0lOVFMuaG9tZSkga2V5TmFtZSA9IFwiaG9tZVwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5lbmQpIGtleU5hbWUgPSBcImVuZFwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5wYWdlVXApIGtleU5hbWUgPSBcInBhZ2VVcFwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IEZVTkNUSU9OQUxfQ09ERVBPSU5UUy5wYWdlRG93bikga2V5TmFtZSA9IFwicGFnZURvd25cIjtcblx0ZWxzZSBpZiAoZWZmZWN0aXZlQ29kZXBvaW50ID09PSBBUlJPV19DT0RFUE9JTlRTLnVwKSBrZXlOYW1lID0gXCJ1cFwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IEFSUk9XX0NPREVQT0lOVFMuZG93bikga2V5TmFtZSA9IFwiZG93blwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IEFSUk9XX0NPREVQT0lOVFMubGVmdCkga2V5TmFtZSA9IFwibGVmdFwiO1xuXHRlbHNlIGlmIChlZmZlY3RpdmVDb2RlcG9pbnQgPT09IEFSUk9XX0NPREVQT0lOVFMucmlnaHQpIGtleU5hbWUgPSBcInJpZ2h0XCI7XG5cdGVsc2UgaWYgKGVmZmVjdGl2ZUNvZGVwb2ludCA+PSA0OCAmJiBlZmZlY3RpdmVDb2RlcG9pbnQgPD0gNTcpIGtleU5hbWUgPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGVmZmVjdGl2ZUNvZGVwb2ludCk7XG5cdGVsc2UgaWYgKGVmZmVjdGl2ZUNvZGVwb2ludCA+PSA5NyAmJiBlZmZlY3RpdmVDb2RlcG9pbnQgPD0gMTIyKSBrZXlOYW1lID0gU3RyaW5nLmZyb21DaGFyQ29kZShlZmZlY3RpdmVDb2RlcG9pbnQpO1xuXHRlbHNlIGlmIChTWU1CT0xfS0VZUy5oYXMoU3RyaW5nLmZyb21DaGFyQ29kZShlZmZlY3RpdmVDb2RlcG9pbnQpKSkga2V5TmFtZSA9IFN0cmluZy5mcm9tQ2hhckNvZGUoZWZmZWN0aXZlQ29kZXBvaW50KTtcblxuXHRpZiAoIWtleU5hbWUpIHJldHVybiB1bmRlZmluZWQ7XG5cdHJldHVybiBmb3JtYXRLZXlOYW1lV2l0aE1vZGlmaWVycyhrZXlOYW1lLCBtb2RpZmllcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUtleShkYXRhOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRjb25zdCBraXR0eSA9IHBhcnNlS2l0dHlTZXF1ZW5jZShkYXRhKTtcblx0aWYgKGtpdHR5KSB7XG5cdFx0cmV0dXJuIGZvcm1hdFBhcnNlZEtleShraXR0eS5jb2RlcG9pbnQsIGtpdHR5Lm1vZGlmaWVyLCBraXR0eS5iYXNlTGF5b3V0S2V5KTtcblx0fVxuXG5cdGNvbnN0IG1vZGlmeU90aGVyS2V5cyA9IHBhcnNlTW9kaWZ5T3RoZXJLZXlzU2VxdWVuY2UoZGF0YSk7XG5cdGlmIChtb2RpZnlPdGhlcktleXMpIHtcblx0XHRyZXR1cm4gZm9ybWF0UGFyc2VkS2V5KG1vZGlmeU90aGVyS2V5cy5jb2RlcG9pbnQsIG1vZGlmeU90aGVyS2V5cy5tb2RpZmllcik7XG5cdH1cblxuXHQvLyBNb2RlLWF3YXJlIGxlZ2FjeSBzZXF1ZW5jZXNcblx0Ly8gV2hlbiBLaXR0eSBwcm90b2NvbCBpcyBhY3RpdmUsIGFtYmlndW91cyBzZXF1ZW5jZXMgYXJlIGludGVycHJldGVkIGFzIGN1c3RvbSB0ZXJtaW5hbCBtYXBwaW5nczpcblx0Ly8gLSBcXHgxYlxcciA9IHNoaWZ0K2VudGVyIChLaXR0eSBtYXBwaW5nKSwgbm90IGFsdCtlbnRlclxuXHQvLyAtIFxcbiA9IHNoaWZ0K2VudGVyIChHaG9zdHR5IG1hcHBpbmcpXG5cdGlmIChfa2l0dHlQcm90b2NvbEFjdGl2ZSkge1xuXHRcdGlmIChkYXRhID09PSBcIlxceDFiXFxyXCIgfHwgZGF0YSA9PT0gXCJcXG5cIikgcmV0dXJuIFwic2hpZnQrZW50ZXJcIjtcblx0fVxuXG5cdGNvbnN0IGxlZ2FjeVNlcXVlbmNlS2V5SWQgPSBMRUdBQ1lfU0VRVUVOQ0VfS0VZX0lEU1tkYXRhXTtcblx0aWYgKGxlZ2FjeVNlcXVlbmNlS2V5SWQpIHJldHVybiBsZWdhY3lTZXF1ZW5jZUtleUlkO1xuXG5cdC8vIExlZ2FjeSBzZXF1ZW5jZXMgKHVzZWQgd2hlbiBLaXR0eSBwcm90b2NvbCBpcyBub3QgYWN0aXZlLCBvciBmb3IgdW5hbWJpZ3VvdXMgc2VxdWVuY2VzKVxuXHRpZiAoZGF0YSA9PT0gXCJcXHgxYlwiKSByZXR1cm4gXCJlc2NhcGVcIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWNcIikgcmV0dXJuIFwiY3RybCtcXFxcXCI7XG5cdGlmIChkYXRhID09PSBcIlxceDFkXCIpIHJldHVybiBcImN0cmwrXVwiO1xuXHRpZiAoZGF0YSA9PT0gXCJcXHgxZlwiKSByZXR1cm4gXCJjdHJsKy1cIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWJcXHgxYlwiKSByZXR1cm4gXCJjdHJsK2FsdCtbXCI7XG5cdGlmIChkYXRhID09PSBcIlxceDFiXFx4MWNcIikgcmV0dXJuIFwiY3RybCthbHQrXFxcXFwiO1xuXHRpZiAoZGF0YSA9PT0gXCJcXHgxYlxceDFkXCIpIHJldHVybiBcImN0cmwrYWx0K11cIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWJcXHgxZlwiKSByZXR1cm4gXCJjdHJsK2FsdCstXCI7XG5cdGlmIChkYXRhID09PSBcIlxcdFwiKSByZXR1cm4gXCJ0YWJcIjtcblx0aWYgKGRhdGEgPT09IFwiXFxyXCIgfHwgKCFfa2l0dHlQcm90b2NvbEFjdGl2ZSAmJiBkYXRhID09PSBcIlxcblwiKSB8fCBkYXRhID09PSBcIlxceDFiT01cIikgcmV0dXJuIFwiZW50ZXJcIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MDBcIikgcmV0dXJuIFwiY3RybCtzcGFjZVwiO1xuXHRpZiAoZGF0YSA9PT0gXCIgXCIpIHJldHVybiBcInNwYWNlXCI7XG5cdGlmIChkYXRhID09PSBcIlxceDdmXCIgfHwgZGF0YSA9PT0gXCJcXHgwOFwiKSByZXR1cm4gXCJiYWNrc3BhY2VcIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWJbWlwiKSByZXR1cm4gXCJzaGlmdCt0YWJcIjtcblx0aWYgKCFfa2l0dHlQcm90b2NvbEFjdGl2ZSAmJiBkYXRhID09PSBcIlxceDFiXFxyXCIpIHJldHVybiBcImFsdCtlbnRlclwiO1xuXHRpZiAoIV9raXR0eVByb3RvY29sQWN0aXZlICYmIGRhdGEgPT09IFwiXFx4MWIgXCIpIHJldHVybiBcImFsdCtzcGFjZVwiO1xuXHRpZiAoZGF0YSA9PT0gXCJcXHgxYlxceDdmXCIgfHwgZGF0YSA9PT0gXCJcXHgxYlxcYlwiKSByZXR1cm4gXCJhbHQrYmFja3NwYWNlXCI7XG5cdGlmICghX2tpdHR5UHJvdG9jb2xBY3RpdmUgJiYgZGF0YSA9PT0gXCJcXHgxYkJcIikgcmV0dXJuIFwiYWx0K2xlZnRcIjtcblx0aWYgKCFfa2l0dHlQcm90b2NvbEFjdGl2ZSAmJiBkYXRhID09PSBcIlxceDFiRlwiKSByZXR1cm4gXCJhbHQrcmlnaHRcIjtcblx0aWYgKCFfa2l0dHlQcm90b2NvbEFjdGl2ZSAmJiBkYXRhLmxlbmd0aCA9PT0gMiAmJiBkYXRhWzBdID09PSBcIlxceDFiXCIpIHtcblx0XHRjb25zdCBjb2RlID0gZGF0YS5jaGFyQ29kZUF0KDEpO1xuXHRcdGlmIChjb2RlID49IDEgJiYgY29kZSA8PSAyNikge1xuXHRcdFx0cmV0dXJuIGBjdHJsK2FsdCske1N0cmluZy5mcm9tQ2hhckNvZGUoY29kZSArIDk2KX1gO1xuXHRcdH1cblx0XHQvLyBMZWdhY3kgYWx0K2xldHRlci9kaWdpdCAoRVNDIGZvbGxvd2VkIGJ5IHRoZSBrZXkpXG5cdFx0aWYgKChjb2RlID49IDk3ICYmIGNvZGUgPD0gMTIyKSB8fCAoY29kZSA+PSA0OCAmJiBjb2RlIDw9IDU3KSkge1xuXHRcdFx0cmV0dXJuIGBhbHQrJHtTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUpfWA7XG5cdFx0fVxuXHR9XG5cdGlmIChkYXRhID09PSBcIlxceDFiW0FcIikgcmV0dXJuIFwidXBcIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWJbQlwiKSByZXR1cm4gXCJkb3duXCI7XG5cdGlmIChkYXRhID09PSBcIlxceDFiW0NcIikgcmV0dXJuIFwicmlnaHRcIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWJbRFwiKSByZXR1cm4gXCJsZWZ0XCI7XG5cdGlmIChkYXRhID09PSBcIlxceDFiW0hcIiB8fCBkYXRhID09PSBcIlxceDFiT0hcIikgcmV0dXJuIFwiaG9tZVwiO1xuXHRpZiAoZGF0YSA9PT0gXCJcXHgxYltGXCIgfHwgZGF0YSA9PT0gXCJcXHgxYk9GXCIpIHJldHVybiBcImVuZFwiO1xuXHRpZiAoZGF0YSA9PT0gXCJcXHgxYlszflwiKSByZXR1cm4gXCJkZWxldGVcIjtcblx0aWYgKGRhdGEgPT09IFwiXFx4MWJbNX5cIikgcmV0dXJuIFwicGFnZVVwXCI7XG5cdGlmIChkYXRhID09PSBcIlxceDFiWzZ+XCIpIHJldHVybiBcInBhZ2VEb3duXCI7XG5cblx0Ly8gUmF3IEN0cmwrbGV0dGVyXG5cdGlmIChkYXRhLmxlbmd0aCA9PT0gMSkge1xuXHRcdGNvbnN0IGNvZGUgPSBkYXRhLmNoYXJDb2RlQXQoMCk7XG5cdFx0aWYgKGNvZGUgPj0gMSAmJiBjb2RlIDw9IDI2KSB7XG5cdFx0XHRyZXR1cm4gYGN0cmwrJHtTdHJpbmcuZnJvbUNoYXJDb2RlKGNvZGUgKyA5Nil9YDtcblx0XHR9XG5cdFx0aWYgKGNvZGUgPj0gMzIgJiYgY29kZSA8PSAxMjYpIHtcblx0XHRcdHJldHVybiBkYXRhO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBLaXR0eSBDU0ktdSBQcmludGFibGUgRGVjb2Rpbmdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IEtJVFRZX0NTSV9VX1JFR0VYID0gL15cXHgxYlxcWyhcXGQrKSg/OjooXFxkKikpPyg/OjooXFxkKykpPyg/OjsoXFxkKykpPyg/OjooXFxkKykpP3UkLztcbmNvbnN0IEtJVFRZX1BSSU5UQUJMRV9BTExPV0VEX01PRElGSUVSUyA9IE1PRElGSUVSUy5zaGlmdCB8IExPQ0tfTUFTSztcblxuLyoqXG4gKiBEZWNvZGUgYSBLaXR0eSBDU0ktdSBzZXF1ZW5jZSBpbnRvIGEgcHJpbnRhYmxlIGNoYXJhY3RlciwgaWYgYXBwbGljYWJsZS5cbiAqXG4gKiBXaGVuIEtpdHR5IGtleWJvYXJkIHByb3RvY29sIGZsYWcgMSAoZGlzYW1iaWd1YXRlKSBpcyBhY3RpdmUsIHRlcm1pbmFscyBzZW5kXG4gKiBDU0ktdSBzZXF1ZW5jZXMgZm9yIGFsbCBrZXlzLCBpbmNsdWRpbmcgcGxhaW4gcHJpbnRhYmxlIGNoYXJhY3RlcnMuIFRoaXNcbiAqIGZ1bmN0aW9uIGV4dHJhY3RzIHRoZSBwcmludGFibGUgY2hhcmFjdGVyIGZyb20gc3VjaCBzZXF1ZW5jZXMuXG4gKlxuICogT25seSBhY2NlcHRzIHBsYWluIG9yIFNoaWZ0LW1vZGlmaWVkIGtleXMuIFJlamVjdHMgQ3RybCwgQWx0LCBhbmQgdW5zdXBwb3J0ZWRcbiAqIG1vZGlmaWVyIGNvbWJpbmF0aW9ucyAodGhvc2UgYXJlIGhhbmRsZWQgYnkga2V5YmluZGluZyBtYXRjaGluZyBpbnN0ZWFkKS5cbiAqIFByZWZlcnMgdGhlIHNoaWZ0ZWQga2V5Y29kZSB3aGVuIFNoaWZ0IGlzIGhlbGQgYW5kIGEgc2hpZnRlZCBrZXkgaXMgcmVwb3J0ZWQuXG4gKlxuICogQHBhcmFtIGRhdGEgLSBSYXcgaW5wdXQgZGF0YSBmcm9tIHRlcm1pbmFsXG4gKiBAcmV0dXJucyBUaGUgcHJpbnRhYmxlIGNoYXJhY3Rlciwgb3IgdW5kZWZpbmVkIGlmIG5vdCBhIHByaW50YWJsZSBDU0ktdSBzZXF1ZW5jZVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVjb2RlS2l0dHlQcmludGFibGUoZGF0YTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0Y29uc3QgbWF0Y2ggPSBkYXRhLm1hdGNoKEtJVFRZX0NTSV9VX1JFR0VYKTtcblx0aWYgKCFtYXRjaCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHQvLyBDU0ktdSBncm91cHM6IDxjb2RlcG9pbnQ+Wzo8c2hpZnRlZD5bOjxiYXNlPl1dOzxtb2Q+Wzo8ZXZlbnQ+XXVcblx0Y29uc3QgY29kZXBvaW50ID0gTnVtYmVyLnBhcnNlSW50KG1hdGNoWzFdID8/IFwiXCIsIDEwKTtcblx0aWYgKCFOdW1iZXIuaXNGaW5pdGUoY29kZXBvaW50KSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHRjb25zdCBzaGlmdGVkS2V5ID0gbWF0Y2hbMl0gJiYgbWF0Y2hbMl0ubGVuZ3RoID4gMCA/IE51bWJlci5wYXJzZUludChtYXRjaFsyXSwgMTApIDogdW5kZWZpbmVkO1xuXHRjb25zdCBtb2RWYWx1ZSA9IG1hdGNoWzRdID8gTnVtYmVyLnBhcnNlSW50KG1hdGNoWzRdLCAxMCkgOiAxO1xuXHQvLyBNb2RpZmllcnMgYXJlIDEtaW5kZXhlZCBpbiBDU0ktdTsgbm9ybWFsaXplIHRvIG91ciBiaXRtYXNrLlxuXHRjb25zdCBtb2RpZmllciA9IE51bWJlci5pc0Zpbml0ZShtb2RWYWx1ZSkgPyBtb2RWYWx1ZSAtIDEgOiAwO1xuXG5cdC8vIE9ubHkgYWNjZXB0IHByaW50YWJsZSBDU0ktdSBpbnB1dCBmb3IgcGxhaW4gb3IgU2hpZnQtbW9kaWZpZWQgdGV4dCBrZXlzLlxuXHQvLyBSZWplY3QgdW5zdXBwb3J0ZWQgbW9kaWZpZXIgYml0cyAoZS5nLiBTdXBlci9NZXRhKSB0byBhdm9pZCBpbnNlcnRpbmdcblx0Ly8gY2hhcmFjdGVycyBmcm9tIG1vZGlmaWVyLW9ubHkgdGVybWluYWwgZXZlbnRzLlxuXHRpZiAoKG1vZGlmaWVyICYgfktJVFRZX1BSSU5UQUJMRV9BTExPV0VEX01PRElGSUVSUykgIT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cdGlmIChtb2RpZmllciAmIChNT0RJRklFUlMuYWx0IHwgTU9ESUZJRVJTLmN0cmwpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdC8vIFByZWZlciB0aGUgc2hpZnRlZCBrZXljb2RlIHdoZW4gU2hpZnQgaXMgaGVsZC5cblx0bGV0IGVmZmVjdGl2ZUNvZGVwb2ludCA9IGNvZGVwb2ludDtcblx0aWYgKG1vZGlmaWVyICYgTU9ESUZJRVJTLnNoaWZ0ICYmIHR5cGVvZiBzaGlmdGVkS2V5ID09PSBcIm51bWJlclwiKSB7XG5cdFx0ZWZmZWN0aXZlQ29kZXBvaW50ID0gc2hpZnRlZEtleTtcblx0fVxuXHQvLyBEcm9wIGNvbnRyb2wgY2hhcmFjdGVycyBvciBpbnZhbGlkIGNvZGVwb2ludHMuXG5cdGlmICghTnVtYmVyLmlzRmluaXRlKGVmZmVjdGl2ZUNvZGVwb2ludCkgfHwgZWZmZWN0aXZlQ29kZXBvaW50IDwgMzIpIHJldHVybiB1bmRlZmluZWQ7XG5cblx0Y29uc3Qga2V5cGFkUHJpbnRhYmxlID0gS0lUVFlfS0VZUEFEX1BSSU5UQUJMRVMuZ2V0KGVmZmVjdGl2ZUNvZGVwb2ludCk7XG5cdGlmIChrZXlwYWRQcmludGFibGUgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGtleXBhZFByaW50YWJsZTtcblxuXHRpZiAoXG5cdFx0ZWZmZWN0aXZlQ29kZXBvaW50ID49IEtJVFRZX1BSSVZBVEVfVVNFX1JBTkdFLnN0YXJ0ICYmXG5cdFx0ZWZmZWN0aXZlQ29kZXBvaW50IDw9IEtJVFRZX1BSSVZBVEVfVVNFX1JBTkdFLmVuZFxuXHQpIHtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0dHJ5IHtcblx0XHRyZXR1cm4gU3RyaW5nLmZyb21Db2RlUG9pbnQoZWZmZWN0aXZlQ29kZXBvaW50KTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBd0JBLElBQUksdUJBQXVCO0FBTXBCLFNBQVMsdUJBQXVCLFFBQXVCO0FBQzdELHlCQUF1QjtBQUN4QjtBQUtPLFNBQVMsd0JBQWlDO0FBQ2hELFNBQU87QUFDUjtBQXNJTyxNQUFNLE1BQU07QUFBQTtBQUFBLEVBRWxCLFFBQVE7QUFBQSxFQUNSLEtBQUs7QUFBQSxFQUNMLE9BQU87QUFBQSxFQUNQLFFBQVE7QUFBQSxFQUNSLEtBQUs7QUFBQSxFQUNMLE9BQU87QUFBQSxFQUNQLFdBQVc7QUFBQSxFQUNYLFFBQVE7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUNSLE9BQU87QUFBQSxFQUNQLE1BQU07QUFBQSxFQUNOLEtBQUs7QUFBQSxFQUNMLFFBQVE7QUFBQSxFQUNSLFVBQVU7QUFBQSxFQUNWLElBQUk7QUFBQSxFQUNKLE1BQU07QUFBQSxFQUNOLE1BQU07QUFBQSxFQUNOLE9BQU87QUFBQSxFQUNQLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxFQUNKLEtBQUs7QUFBQSxFQUNMLEtBQUs7QUFBQSxFQUNMLEtBQUs7QUFBQTtBQUFBLEVBR0wsVUFBVTtBQUFBLEVBQ1YsUUFBUTtBQUFBLEVBQ1IsUUFBUTtBQUFBLEVBQ1IsYUFBYTtBQUFBLEVBQ2IsY0FBYztBQUFBLEVBQ2QsV0FBVztBQUFBLEVBQ1gsV0FBVztBQUFBLEVBQ1gsT0FBTztBQUFBLEVBQ1AsT0FBTztBQUFBLEVBQ1AsUUFBUTtBQUFBLEVBQ1IsT0FBTztBQUFBLEVBQ1AsYUFBYTtBQUFBLEVBQ2IsSUFBSTtBQUFBLEVBQ0osTUFBTTtBQUFBLEVBQ04sUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsT0FBTztBQUFBLEVBQ1AsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsWUFBWTtBQUFBLEVBQ1osWUFBWTtBQUFBLEVBQ1osTUFBTTtBQUFBLEVBQ04sTUFBTTtBQUFBLEVBQ04sT0FBTztBQUFBLEVBQ1AsV0FBVztBQUFBLEVBQ1gsWUFBWTtBQUFBLEVBQ1osT0FBTztBQUFBLEVBQ1AsVUFB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LElBQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxRQUFRLEdBQThCLE9BQU8sQ0FBQyxRQUFRLEdBQUksTUFBTSxDQUFDLFFBQVEsRUFBRztBQUFBLEVBQzFHLE1BQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxRQUFRLEdBQThCLE9BQU8sQ0FBQyxRQUFRLEdBQUksTUFBTSxDQUFDLFFBQVEsRUFBRztBQUFBLEVBQzFHLE9BQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxRQUFRLEdBQThCLE9BQU8sQ0FBQyxRQUFRLEdBQUksTUFBTSxDQUFDLFFBQVEsRUFBRztBQUFBLEVBQzFHLE1BQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxRQUFRLEdBQThCLE9BQU8sQ0FBQyxRQUFRLEdBQUksTUFBTSxDQUFDLFFBQVEsRUFBRztBQUFBLEVBQzFHLE1BQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxVQUFVLFdBQVcsU0FBUyxHQUFLLE9BQU8sQ0FBQyxTQUFTLEdBQUcsTUFBTSxDQUFDLFNBQVMsRUFBRTtBQUFBLEVBQ3ZHLEtBQVUsRUFBRSxPQUFPLENBQUMsVUFBVSxVQUFVLFdBQVcsU0FBUyxHQUFLLE9BQU8sQ0FBQyxTQUFTLEdBQUcsTUFBTSxDQUFDLFNBQVMsRUFBRTtBQUFBLEVBQ3ZHLFFBQVUsRUFBRSxPQUFPLENBQUMsU0FBUyxHQUF3QyxPQUFPLENBQUMsU0FBUyxHQUFHLE1BQU0sQ0FBQyxTQUFTLEVBQUU7QUFBQSxFQUMzRyxRQUFVLEVBQUUsT0FBTyxDQUFDLFNBQVMsR0FBd0MsT0FBTyxDQUFDLFNBQVMsR0FBRyxNQUFNLENBQUMsU0FBUyxFQUFFO0FBQUEsRUFDM0csUUFBVSxFQUFFLE9BQU8sQ0FBQyxXQUFXLFVBQVUsR0FBMEIsT0FBTyxDQUFDLFNBQVMsR0FBRyxNQUFNLENBQUMsU0FBUyxFQUFFO0FBQUEsRUFDekcsVUFBVSxFQUFFLE9BQU8sQ0FBQyxXQUFXLFVBQVUsR0FBMEIsT0FBTyxDQUFDLFNBQVMsR0FBRyxNQUFNLENBQUMsU0FBUyxFQUFFO0FBQUEsRUFDekcsT0FBVSxFQUFFLE9BQU8sQ0FBQyxV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
