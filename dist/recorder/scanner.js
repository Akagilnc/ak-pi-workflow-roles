import { RecorderError } from "./errors.js";
const REPLACEMENT = "[REDACTED]";
// Bounded pattern scanner — not semantic DLP.
// Covers authority-mandated classes plus representative provider forms.
const RULES = [
    {
        // Composed Authorization headers are one credential boundary: the complete
        // credential field after Authorization:/ = is consumed atomically through
        // CR/LF. Separators are horizontal-only so empty/whitespace-only values cannot
        // swallow CR/LF or the following line; line-start is recognized without
        // consuming the terminator. Quote-shaped wrappers are not a closer — escaped
        // auth-parameter quotes inside a whole-quoted value must not terminate early.
        id: "authorization-header",
        pattern: /(?:^|(?<=[\r\n])|[ \t,;])Authorization[ \t]*[:=][ \t]*[^\r\n]*/gi,
    },
    {
        id: "bearer-credential",
        pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    },
    {
        id: "basic-credential",
        pattern: /\bBasic\s+[A-Za-z0-9+/]+=*/gi,
    },
    {
        id: "provider-package-token",
        pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|npm|sk-proj|sk-ant|sk|xox[baprs]|glpat)[_-][A-Za-z0-9\-_]{8,}\b/gi,
    },
    {
        id: "google-api-key",
        pattern: /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
    },
    {
        id: "aws-access-key",
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
        id: "aws-secret-key",
        pattern: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*['"]?[^'"\s]+/gi,
    },
    {
        id: "pem-private-key",
        pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    },
    {
        id: "cookie-header",
        pattern: /(?:^|[\s,;])Cookie\s*[:=]\s*[^;\r\n]+/gi,
    },
    {
        id: "session-credential",
        pattern: /\b(?:session|sess|sid|jsessionid|phpsessid)\b\s*[:=]\s*['"]?[A-Za-z0-9._\-]{8,}/gi,
    },
    {
        id: "credential-url",
        pattern: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi,
    },
    {
        // Quoted assignment values are one credential boundary: only an unescaped matching
        // delimiter closes the value; escaped quotes stay inside. Unmatched open quotes
        // fail closed through the line end (CR/LF-bounded) so no secret suffix survives.
        // JSON-escaped \"...\" alternatives cover the same law when assignments ride
        // serialized argv/stdout without decoding first.
        id: "token-assignment",
        pattern: /\b(?:api[_-]?key|token|secret|password|passwd|access[_-]?key)\b\s*[:=]\s*(?:'(?:\\[^\r\n]|[^'\\\r\n])*'|"(?:\\[^\r\n]|[^"\\\r\n])*"|\\"(?:[^"\\\r\n]|\\\\\\"|\\\\|\\[^"\\\r\n])*\\"|'(?:\\[^\r\n]|[^'\\\r\n])*|"(?:\\[^\r\n]|[^"\\\r\n])*|\\"(?:[^"\\\r\n]|\\\\\\"|\\\\|\\[^"\\\r\n])*|[^\s'\"\r\n]+)/gi,
    },
];
function mergeHits(into, hit) {
    const key = `${hit.ruleId}|${hit.location}`;
    const existing = into.get(key);
    if (existing) {
        existing.count += hit.count;
    }
    else {
        into.set(key, { ...hit });
    }
}
export function scanString(input, location) {
    let value = input;
    const hitMap = new Map();
    for (const rule of RULES) {
        const re = new RegExp(rule.pattern.source, rule.pattern.flags);
        let count = 0;
        value = value.replace(re, () => {
            count += 1;
            return REPLACEMENT;
        });
        if (count > 0) {
            mergeHits(hitMap, { ruleId: rule.id, location, count });
        }
    }
    const hits = [...hitMap.values()];
    return {
        value,
        report: { hits, redacted: hits.length > 0 },
    };
}
export function scanBytes(input, location) {
    // Fail closed on non-UTF8 opaque content that is not wholly replaced.
    const asText = input.toString("utf8");
    if (!Buffer.from(asText, "utf8").equals(input)) {
        return {
            value: Buffer.from(JSON.stringify({
                kind: "opaque-redaction",
                reason: "unsupported-opaque-bytes",
                byteLength: input.length,
            }), "utf8"),
            report: {
                hits: [{
                        ruleId: "opaque-bytes",
                        location,
                        count: 1,
                    }],
                redacted: true,
            },
        };
    }
    const scanned = scanString(asText, location);
    return {
        value: Buffer.from(scanned.value, "utf8"),
        report: scanned.report,
    };
}
export function combineReports(...reports) {
    const hitMap = new Map();
    for (const report of reports) {
        for (const hit of report.hits) {
            mergeHits(hitMap, hit);
        }
    }
    const hits = [...hitMap.values()];
    return { hits, redacted: hits.length > 0 };
}
export function scanJsonValue(value, location) {
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        return { value, report: { hits: [], redacted: false } };
    }
    if (typeof value === "string") {
        return scanString(value, location);
    }
    if (Array.isArray(value)) {
        const items = [];
        const reports = [];
        value.forEach((item, index) => {
            const scanned = scanJsonValue(item, `${location}[${index}]`);
            items.push(scanned.value);
            reports.push(scanned.report);
        });
        return { value: items, report: combineReports(...reports) };
    }
    if (typeof value === "object") {
        const out = {};
        const reports = [];
        const seenKeys = new Set();
        for (const [key, child] of Object.entries(value)) {
            const keyScan = scanString(key, `${location}.key`);
            reports.push(keyScan.report);
            // Detect redacted-key collisions before object construction.
            if (seenKeys.has(keyScan.value)) {
                throw new RecorderError("scan-failed", "redacted key collision would damage object shape");
            }
            seenKeys.add(keyScan.value);
            const childScan = scanJsonValue(child, `${location}.${keyScan.value}`);
            reports.push(childScan.report);
            out[keyScan.value] = childScan.value;
        }
        return { value: out, report: combineReports(...reports) };
    }
    // unsupported typeof (symbol/function/bigint)
    throw new RecorderError("opaque-content", "unsupported opaque content cannot be promoted");
}
export function publicRedactionReport(report) {
    return report.hits.map((hit) => ({
        ruleId: hit.ruleId,
        location: hit.location,
        count: hit.count,
    }));
}
/** Scan an entire public failure object; returns sanitized JSON line payload. */
export function scanPublicFailureObject(value) {
    return scanJsonValue(value, "failure");
}
