/**
 * #1071 — structured ticketNumber declaration shapes for post-admission bind.
 * Only the typed field is read; prose note/report is never consulted.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { readDeclaredTicketNumber } from "../../src/run-ticket-number.ts";

test("readDeclaredTicketNumber accepts safe positive integers", () => {
  assert.equal(readDeclaredTicketNumber(1843), 1843);
  assert.equal(readDeclaredTicketNumber(1), 1);
});

test("readDeclaredTicketNumber accepts digit strings and #N forms from the field", () => {
  assert.equal(readDeclaredTicketNumber("1843"), 1843);
  assert.equal(readDeclaredTicketNumber("#1843"), 1843);
  assert.equal(readDeclaredTicketNumber("#1843 / PR #1876"), 1843);
  assert.equal(readDeclaredTicketNumber("  #582  "), 582);
});

test("readDeclaredTicketNumber leaves unidentifiable shapes unbound", () => {
  assert.equal(readDeclaredTicketNumber(undefined), undefined);
  assert.equal(readDeclaredTicketNumber(null), undefined);
  assert.equal(readDeclaredTicketNumber(0), undefined);
  assert.equal(readDeclaredTicketNumber(-3), undefined);
  assert.equal(readDeclaredTicketNumber(1.5), undefined);
  assert.equal(readDeclaredTicketNumber(""), undefined);
  assert.equal(readDeclaredTicketNumber("not-a-ticket"), undefined);
  assert.equal(readDeclaredTicketNumber("ticket #1843"), undefined);
  assert.equal(readDeclaredTicketNumber({ ticketNumber: 1843 }), undefined);
  assert.equal(readDeclaredTicketNumber(["1843"]), undefined);
});
