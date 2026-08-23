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
