import * as core from '@actions/core';
import * as fs from "node:fs";
import path from "node:path";

// ── Types ─────────────────────────────────────────────────────
interface EslintMessage {
    ruleId: string | null;
    severity: 1 | 2;
    message: string;
    line: number;
    column: number;
}

interface EslintFileResult {
    filePath: string;
    messages: EslintMessage[];
}

type Severity = 'error' | 'warning';

interface NormalizedMessage {
    ruleId: string;
    severity: Severity;
    message: string;
    file: string;
    line: number;
    column: number;
}

// ── Constants ─────────────────────────────────────────────────
const SEVERITY_MAP: Record<1 | 2, Severity> = {1: 'warning', 2: 'error'};
const SEVERITY_ICON: Record<Severity, string> = {error: '🔴', warning: '🟡'};

const SERVER_URL = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const REPOSITORY = process.env.GITHUB_REPOSITORY ?? '';
const SHA = process.env.GITHUB_SHA ?? 'HEAD';
const summaryFile = process.env.GITHUB_STEP_SUMMARY;

// ── Inputs ────────────────────────────────────────────────────
const reportPath = core.getInput('report-path');
const failOnError = core.getInput('fail-on-error') !== 'false';
const failOnWarn = core.getInput('fail-on-warning') === 'true';
const title = core.getInput('title');

// ── Helpers ───────────────────────────────────────────────────
function appendSummary(md: string): void {
    if (summaryFile) {
        fs.appendFileSync(summaryFile, md);
    } else {
        process.stdout.write(md);
    }
}

function fileLink(file: string, line: number): string {
    return `${SERVER_URL}/${REPOSITORY}/blob/${SHA}/${file}#L${line}`;
}

// ── Load report ───────────────────────────────────────────────
if (!fs.existsSync(reportPath)) {
    appendSummary(`## 🔍 ${title}\n\n✅ **No lint issues found.**\n`);
    process.exit(0);
}

let results: EslintFileResult[];
try {
    results = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as EslintFileResult[];
} catch (err) {
    core.setFailed(`Failed to parse ${reportPath}: ${(err as Error).message}`);
    process.exit(1);
}

const cwd = process.cwd() + path.sep;

// ── Normalize messages ────────────────────────────────────────
const allMessages: NormalizedMessage[] = results.flatMap(fileResult =>
    fileResult.messages.map(msg => ({
        ruleId: msg.ruleId ?? 'unknown',
        severity: SEVERITY_MAP[msg.severity] ?? 'warning',
        message: msg.message,
        file: fileResult.filePath.replace(cwd, '').replace(/\\/g, '/'),
        line: msg.line,
        column: msg.column,
    }))
);

if (!allMessages.length) {
    appendSummary(`## 🔍 ${title}\n\n✅ **No lint issues found.**\n`);
    process.exit(0);
}

// ── Counts ────────────────────────────────────────────────────
const counts: Record<Severity, number> = {error: 0, warning: 0};
for (const m of allMessages) counts[m.severity]++;

// ── Group by ruleId ───────────────────────────────────────────
const grouped = allMessages.reduce<Record<string, NormalizedMessage[]>>((acc, m) => {
    (acc[m.ruleId] ??= []).push(m);
    return acc;
}, {});

const sorted = Object.entries(grouped).sort(([, a], [, b]) => {
    const sevA = a.some(x => x.severity === 'error') ? 0 : 1;
    const sevB = b.some(x => x.severity === 'error') ? 0 : 1;
    if (sevA !== sevB) return sevA - sevB;
    return b.length - a.length;
});

// ── Build Markdown ────────────────────────────────────────────
let md = `## 🔍 ${title}\n\n`;

md += '| Severity | Count |\n|----------|-------|\n';
if (counts.error) md += `| ${SEVERITY_ICON.error} error | **${counts.error}** |\n`;
if (counts.warning) md += `| ${SEVERITY_ICON.warning} warning | **${counts.warning}** |\n`;
md += `\n**${allMessages.length}** issue(s) across **${Object.keys(grouped).length}** rule(s)\n\n`;

for (const [ruleId, items] of sorted) {
    const hasError = items.some(x => x.severity === 'error');
    const icon = hasError ? SEVERITY_ICON.error : SEVERITY_ICON.warning;
    const severity: Severity = hasError ? 'error' : 'warning';

    md += `<details><summary>${icon} <strong>${ruleId}</strong>`;
    md += ` — ${items.length} occurrence(s) · ${severity}`;
    md += '</summary>\n\n';

    const byFile = items.reduce<Record<string, NormalizedMessage[]>>((acc, m) => {
        (acc[m.file] ??= []).push(m);
        return acc;
    }, {});

    md += '| File | Line | Message |\n';
    md += '|------|------|---------|\n';

    for (const [file, msgs] of Object.entries(byFile)) {
        for (const m of msgs.sort((a, b) => a.line - b.line)) {
            const link = fileLink(file, m.line);
            md += `| [\`${file}\`](${link}) | [${m.line}:${m.column}](${link}) | ${m.message} |\n`;
        }
    }

    md += '\n</details>\n\n';
}

appendSummary(md);

// ── Exit code ─────────────────────────────────────────────────
if (counts.error > 0 && failOnError) {
    core.setFailed(`❌ ${counts.error} lint error(s) found`);
    process.exit(1);
}

if (counts.warning > 0 && failOnWarn) {
    core.setFailed(`❌ ${counts.warning} lint warning(s) found`);
    process.exit(1);
}

console.log(`✅ No blocking lint issues (${counts.error} error(s), ${counts.warning} warning(s))`);
