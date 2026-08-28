import assert from "node:assert/strict";
import { test } from "node:test";
import { RULES, scanText } from "./check-no-personal-data.mjs";

const names = (text) => scanText(text, RULES).map((h) => h.rule).sort();

test("card numbers are caught, and lookalikes are not", () => {
  // Test numbers published by the card networks for exactly this purpose.
  assert.deepEqual(names("const card = '4111111111111111';"), ["payment card number"]);
  assert.deepEqual(names("4111 1111 1111 1111"), ["payment card number"]);
  assert.deepEqual(names("amex 378282246310005"), ["payment card number"]);

  // An OFX timestamp passes Luhn; it is not a card.
  assert.deepEqual(names('parseDate("20260804120000")'), []);
  // Right length, wrong check digit.
  assert.deepEqual(names("4111111111111112"), []);
  // Amex prefix at sixteen digits: Amex cards are fifteen, so this is not one.
  assert.deepEqual(names("3411111111111111"), []);
});

test("a Social Security number is caught", () => {
  assert.deepEqual(names("ssn 123-45-6789"), ["US Social Security number"]);
});

test("routing numbers need the checksum and nearby wording", () => {
  // Both rules fire here: the word "routing" next to digits is also an
  // account-number match. Two names on one real hit is correct.
  assert.deepEqual(names("routing 021000021"), ["account number", "bank routing number"]);
  // Valid ABA checksum, but nothing says it is a routing number.
  assert.deepEqual(names("const id = 021000021;"), []);
  // React's 0x7FFFFFF, which is why the wording has to be near the digits.
  assert.deepEqual(names("var s=r&134217727;return s===0?" + "x".repeat(200) + "wire"), []);
});

test("account numbers are caught when labelled", () => {
  assert.deepEqual(names("account number: 123456789012"), ["account number"]);
  assert.deepEqual(names("acct #98765432"), ["account number"]);
});

test("an IBAN is caught, a hash is not", () => {
  assert.deepEqual(names("GB82WEST12345698765432"), ["IBAN"]);
  assert.deepEqual(names("sha256-AB12cdEF34ghIJ56klMN78opQR90st"), []);
});

test("real email addresses are caught, documentation ones are not", () => {
  assert.deepEqual(names("contact a.person@gmail.com"), ["email address"]);
  assert.deepEqual(names("someone@example.com"), []);
  assert.deepEqual(names("you@your-domain.test"), []);
  assert.deepEqual(names("noreply@anthropic.com"), []);
});

test("personal phone numbers are caught, merchant support lines are not", () => {
  assert.deepEqual(names("call 206-555-0147"), ["phone number"]);
  assert.deepEqual(names("(206) 555-0147"), ["phone number"]);
  // Statement descriptions carry these by the dozen.
  assert.deepEqual(names("WALMART.COM 800-925-6278 AR"), []);
  assert.deepEqual(names("HOMEDEPOT.COM 866-430-3376 GA"), []);
});

test("a street address is caught", () => {
  assert.deepEqual(names("lives at 1600 Pennsylvania Avenue"), ["street address"]);
  assert.deepEqual(names("12 Elm St."), ["street address"]);
});

test("the pragma exempts its own line and the line below it", () => {
  assert.deepEqual(names("ssn 123-45-6789 // omakei:allow-personal"), []);
  assert.deepEqual(names("// omakei:allow-personal\nssn 123-45-6789"), []);
  // It does not exempt anything further down.
  assert.deepEqual(names("// omakei:allow-personal\nfiller\nssn 123-45-6789"), [
    "US Social Security number",
  ]);
});

test("clean text produces nothing", () => {
  assert.deepEqual(names("const total = 1234.56; // CHIPOTLE 1042"), []);
});

test("locally listed terms are reported without printing the term", () => {
  const rule = {
    name: "term from .githooks/personal-terms",
    re: /(?<![\w-])(?:Ashgrove)(?![\w-])/gi,
    redact: true,
  };
  const hits = scanText("the ashgrove account", [rule]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "[redacted]", "the block list must not leak into output");
  assert.deepEqual(scanText("Ashgroveshire", [rule]), [], "whole words only");
});
