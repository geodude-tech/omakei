import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMerchant, ruleMatches } from "./fingerprint.ts";

test("ruleMatches ignores punctuation so WAL-MART hits walmart", () => {
  assert.equal(ruleMatches("walmart", "WAL-MART #1001 SEATTLE WA"), true);
  assert.equal(ruleMatches("walmart", "WALMART.COM 800-925-6278 AR"), true);
  assert.equal(ruleMatches("home depot", "THE HOME DEPOT 1866 PORTLAND OR"), true);
  assert.equal(ruleMatches("homedepot", "HOMEDEPOT.COM 800-430-3376 GA"), true);
  assert.equal(ruleMatches("at&t", "AT&T WIRELESS"), true);
  assert.equal(ruleMatches("mcdonald", "MCDONALD'S F19681 SEATTLE WA"), true);
  assert.equal(ruleMatches("safeway fuel", "SAFEWAY FUEL1234 SEATTLE WA"), true);
  assert.equal(ruleMatches("safeway fuel", "SAFEWAY #1234 SEATTLE WA"), false);
});

test("ruleMatches key identifier ignores town and store number", () => {
  assert.equal(ruleMatches("safeway", "SAFEWAY #1234 SEATTLE WA"), true);
  assert.equal(ruleMatches("safeway", "SAFEWAY #5678 PORTLAND OR"), true);
  assert.equal(ruleMatches("76", "76 - METRO MART SEATTLE WA"), true);
  assert.equal(ruleMatches("76", "76 - DALLAS RD 76 DALLAS TX"), true);
  assert.equal(ruleMatches("76", "76 - CON 2704410 0410 BOISE ID"), true);
  assert.equal(ruleMatches("chick-fil-a", "CHICK-FIL-A #05750 BOISE ID"), true);
  assert.equal(ruleMatches("check", "CHECK"), true);
  assert.equal(ruleMatches("check", "CHECKCARD 1234 SAFEWAY"), false);
  assert.equal(ruleMatches("blue sparrow", "CITY HOSPITAL BLUE SPARROWSEATTLE WA"), true);
  // omakei:allow-personal — a merchant's public support line, as it appears on a statement
  assert.equal(ruleMatches("steamgames", "STEAMGAMES.COM 425-889-9642 WA"), true);
});

test("ruleMatches accepts /regex/ literals", () => {
  assert.equal(ruleMatches("/safeway/i", "SAFEWAY #5678 PORTLAND OR"), true);
  assert.equal(ruleMatches("/76\\s*-/", "76 - METRO MART SEATTLE WA"), true);
  assert.equal(ruleMatches("/safeway\\s+fuel/", "SAFEWAY FUEL1234 SEATTLE WA"), true);
  assert.equal(ruleMatches("/^check$/", "CHECK"), true);
  assert.equal(ruleMatches("/^check$/", "CHECKCARD"), false);
});

test("ruleMatches uses whole tokens so a city prefix does not steal payroll", () => {
  assert.equal(ruleMatches("north grand", "NORTH GRAND CINEMA SEATTLE WA"), true);
  assert.equal(ruleMatches("acme", "ACME CORP PAYROLL       ACH"), true);
  assert.equal(ruleMatches("north grand", "ACME CORP PAYROLL       ACH"), false);
  assert.equal(ruleMatches("kroger", "ACME CORP PAYROLL       ACH"), false);
});

/**
 * `extractMerchant` is the grouping key the "Needs a category" list buckets by,
 * and the string `categorizeMerchant` turns into a rule pattern. This table
 * pins its current output against real-shape statement lines. Cases marked
 * `WRONG` produce a key that is too broad, too narrow, or split across two
 * spellings of one merchant — recorded here, tracked in `tasks/plan.md`, not
 * fixed in this pass.
 */
test("extractMerchant grouping key — corpus", () => {
  const corpus: Array<[string, string, string?]> = [
    ["WHOLE FDS MKT 10456 AUSTIN TX", "WHOLE FDS"],
    ["POS DEBIT WHOLE FOODS MKT 10456 AUSTIN TX", "WHOLE FOODS"],
    ["CHECKCARD 0412 SHELL OIL 57444 DENVER CO", "SHELL OIL"],
    ["SQ *SUNRISE BAKERY SEATTLE WA", "SUNRISE", "WRONG: drops BAKERY; rule 'sunrise' is too broad"],
    ["TST* THE LOCAL DINER PORTLAND OR", "THE LOCAL DINER"],
    ["PAYPAL *SPOTIFY USA 4029357733 CA", "SPOTIFY"],
    ["COSTCO WHSE #0421 SEATTLE WA", "COSTCO"],
    ["76 - CIRCLE K 2093 BOISE ID", "76"],
    ["NETFLIX.COM 866-579-7172 CA", "NETFLIX.COM"],
    ["STARBUCKS STORE 09876 SAN JOSE CA", "STARBUCKS"],
    ["CHEVRON 0092345 SACRAMENTO CA", "CHEVRON"],
    ["THE HOME DEPOT #6161 ATLANTA GA", "THE HOME DEPOT"],
    ["WM SUPERCENTER #1234 DALLAS TX", "WM SUPERCENTER"],
    ["PURCHASE AUTHORIZED ON 04/12 DUTCH BROS 888 BOISE ID", "DUTCH BROS"],
    [
      "TRADER JOE'S #123 PORTLAND OR",
      "TRADER",
      "WRONG: drops JOE'S; rule 'trader' is too broad",
    ],
    [
      "AMZN MKTP US*2A4XY SEATTLE WA",
      "AMZN MKTP",
      "WRONG: splits from AMAZON.COM below — two keys for one merchant",
    ],
    [
      "AMAZON.COM*RT4G12 AMZN.COM/BILL WA",
      "AMAZON.COM*RT4G12",
      "WRONG: keeps the per-transaction code; rule matches exactly one row",
    ],
    [
      "DEBIT CARD PURCHASE TARGET T-1234 CHICAGO IL",
      "PURCHASE",
      "WRONG: 'DEBIT CARD PURCHASE' prefix not stripped; rule 'purchase' matches everything",
    ],
  ];
  for (const [input, expected] of corpus) {
    assert.equal(extractMerchant(input), expected, input);
  }
});

test("extractMerchant strips card prefixes, cities, and groups chains", () => {
  assert.equal(extractMerchant("KROGER #70 SEATTLE WA"), "KROGER");
  assert.equal(extractMerchant("KROGER SUPERMARKE SEATTLE WA"), "KROGER");
  assert.equal(extractMerchant("0294 KROGER #70              FTM"), "KROGER");
  assert.equal(extractMerchant("SQ *BLUE SPARROW CAFE LLC Seattle WA"), "BLUE SPARROW");
  assert.equal(extractMerchant("SUMMIT POWER &            FTM"), "SUMMIT");
  assert.equal(extractMerchant("100 MAIN ST             ATM"), "ATM");
  assert.equal(extractMerchant("MCDONALD'S F19681 SEATTLE WA"), "MCDONALD'S");
  assert.equal(extractMerchant("ALDI SEATTLE WA"), "ALDI");
  assert.equal(extractMerchant("76 - METRO MART SEATTLE WA"), "76");
  assert.equal(extractMerchant("76 - DALLAS RD 76 DALLAS TX"), "76");
  assert.equal(extractMerchant("SAFEWAY #5678 PORTLAND OR"), "SAFEWAY");
  assert.equal(extractMerchant("MED*REGIONAL MEDICAL Seattle WA"), "REGIONAL");
  assert.notEqual(
    extractMerchant("MED*REGIONAL MEDICAL Seattle WA"),
    extractMerchant("ACME CORP PAYROLL       ACH"),
  );
});
